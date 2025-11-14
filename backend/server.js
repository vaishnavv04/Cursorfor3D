// sev.js (cleaned & consolidated)
// ESM file - run with Node >= 18 (or adjust imports if using CommonJS)
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import net from "net";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { CohereClient } from "cohere-ai";
import { pipeline } from "@xenova/transformers";
import pgvector from "pgvector/pg";

import { pool, initSchema, mapConversation, mapMessage } from "./db.js";
import { createProgressTracker } from "./utils/progress.js";
import { integrationModules, initBlenderConnection, sendCommand, isBlenderConnected } from './integrations/index.js';
import path from "node:path";
import os from "node:os";

dotenv.config();

// Top-level dynamic import (works in modern Node ESM)
const cryptoModule = await import("node:crypto");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

const PORT = process.env.PORT || 5000;
const BLENDER_TCP_PORT = parseInt(process.env.BLENDER_TCP_PORT || "9876", 10);
const BLENDER_TCP_HOST = process.env.BLENDER_TCP_HOST || "127.0.0.1";
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("JWT_SECRET environment variable is required for authentication.");
  process.exit(1);
}

// Initialize AI providers (may be null if key missing)
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const groqClient = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const cohereClient = process.env.COHERE_API_KEY ? new CohereClient({ token: process.env.COHERE_API_KEY }) : null;

// Model configs
const MODEL_CONFIGS = {
  gemini: { name: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
  groq: { name: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B (Groq)" },
  cohere: { name: "command-r-plus", displayName: "Command R+ (Cohere)" },
};
const PROMPT_ENHANCER_MODEL = "llama-3.1-8b-instant";

// RAG / embeddings
const EMBEDDING_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_EMBEDDING_DIM = 380; // Match the existing table dimension

let embedderPromise = null;
async function getEmbedder() {
  if (embedderPromise === null) {
    console.log("🤖 Loading local embedding model...");
    embedderPromise = pipeline("feature-extraction", EMBEDDING_MODEL_NAME);
  }
  return embedderPromise;
}

async function embedQuery(text) {
  const embedder = await getEmbedder();
  const embedding = await embedder(text, { pooling: "mean", normalize: true });
  // embedding.data may be a typed array; convert to plain numbers
  const data = embedding.data;
  const arr = Array.isArray(data) ? data : Array.from(data);
  return arr;
}

async function tableExists(tableName) {
  try {
    const { rows } = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
      [tableName]
    );
    return rows[0].exists;
  } catch (error) {
    console.error(`Error checking if table exists: ${error.message}`);
    return false;
  }
}

async function searchKnowledgeBase(queryText, limit = 5) {
  console.log(`🔍 [RAG] Searching knowledge base for: "${String(queryText).slice(0, 100)}..."`);
  try {
    const queryEmbedding = await embedQuery(queryText);
    const vectorString = pgvector.toSql(queryEmbedding);
    
    // Check if we have the new table available
    const hasNewTable = await tableExists("blender_knowledge_new");
    
    // Try the new table first if it exists
    if (hasNewTable) {
      try {
        const newTableQuery = `
          SELECT content, 1 - (embedding <=> $1) AS similarity
          FROM blender_knowledge_new
          WHERE 1 - (embedding <=> $1) > 0.2
          ORDER BY similarity DESC
          LIMIT $2
        `;
        const { rows: newRows } = await pool.query(newTableQuery, [vectorString, limit]);
        if (newRows && newRows.length > 0) {
          console.log(`✅ [RAG] Found ${newRows.length} relevant documents in new table`);
          return newRows.map((r) => r.content);
        }
      } catch (newTableError) {
        console.warn(`[RAG] Error searching new table: ${newTableError.message}`);
      }
    }
    
    // Fall back to original table
    const query = `
      SELECT content, 1 - (embedding <=> $1) AS similarity
      FROM blender_knowledge
      WHERE 1 - (embedding <=> $1) > 0.2
      ORDER BY similarity DESC
      LIMIT $2
    `;
    const { rows } = await pool.query(query, [vectorString, limit]);
    console.log(`✅ [RAG] Found ${rows.length} relevant documents in original table`);
    return rows.map((r) => r.content);
  } catch (error) {
    console.error(`❌ [RAG] Knowledge base search failed:`, error?.message || error);
    return [];
  }
}

// AGENT TOOL DEFINITIONS
const AGENT_TOOLS = [
  { name: "search_knowledge_base", description: "Searches the Blender 4.x API documentation for a specific query. Use this before execute_blender_code." },
  { name: "execute_blender_code", description: "Executes a block of Blender Python (`bpy`) code in the 3D scene. Use this ONLY after you have searched the knowledge base and are confident the code is correct." },
  { name: "get_scene_info", description: "Gets the current scene state." },
  { name: "asset_search_and_import", description: "Searches for and imports a 3D asset from an online library." },
  { name: "finish_task", description: "Signals that you have fully completed the user's request and have a final answer for them." },
];

function getAgentSystemPrompt(sceneContext, ragContext) {
  let prompt = `
You are an expert Blender Python assistant. Your goal is to help the user by taking a series of steps.
You operate on a "Reason-Act-Observe" loop.

At each step, you must:
1. Reason (Thought): Analyze the user's request, the conversation history, and the previous observation. Formulate a plan.
2. Act (Action): Choose one tool to execute. Output a JSON object with "thought" and "action" keys only.

Response must be a single, valid JSON object, no other text.
Example:
{
  "thought": "I should search the API for creating a red cube",
  "action": { "name": "search_knowledge_base", "query": "how to make a red cube with Principled BSDF" }
}

## AVAILABLE TOOLS:
`;
  for (const tool of AGENT_TOOLS) {
    prompt += `- ${tool.name}: ${tool.description}\n`;
  }

  prompt += `
## CRITICAL RULES:
1. Always search_knowledge_base first before writing bpy code.
2. Check the scene with get_scene_info if unsure what exists.
3. One step at a time.
4. Final step must be {"name":"finish_task"} and thought will be final user-visible answer.
`;

  if (sceneContext) {
    prompt += `\n## CURRENT SCENE STATE:\n${JSON.stringify(sceneContext, null, 2)}\n`;
  }
  if (ragContext && ragContext.length) {
    prompt += `\n## RELEVANT DOCUMENTATION (from RAG):\n${ragContext.map((d) => `- ${d}`).join("\n")}\n`;
  }
  prompt += "\nNow: output only the JSON object with thought and action.";
  return prompt;
}

// LLM caller for agent (supports gemini/groq/cohere)
async function callAgentLLM(systemPrompt, agentHistory, model = "gemini") {
  let rawResponseText = "";

  // Build history depending on target provider
  // Gemini v1beta supports roles "user" and "model" only.
  const convertedHistory = agentHistory.map((h) => {
    if (h.role === "assistant") return { ...h, role: "model" };
    if (h.role === "system") return { role: "user", parts: [{ text: h.observation || h.parts?.[0]?.text || "" }] };
    return h;
  });
  const llmHistory = [{ role: "user", parts: [{ text: systemPrompt }] }, ...convertedHistory];

  switch (model) {
    case "gemini": {
      if (!genAI) throw new Error("Gemini API not configured");
      const modelClient = genAI.getGenerativeModel({
        model: MODEL_CONFIGS.gemini.name,
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      });
      const result = await modelClient.generateContent({ contents: llmHistory });
      rawResponseText = await result.response.text();
      break;
    }
    case "groq": {
      if (!groqClient) throw new Error("Groq API not configured");
      const groqHistory = [{ role: "system", content: systemPrompt }, ...agentHistory.map(h => ({ role: h.role, content: h.parts[0].text }))];
      const response = await groqClient.chat.completions.create({
        model: MODEL_CONFIGS.groq.name,
        messages: groqHistory,
        response_format: { type: "json_object" },
        temperature: 0.3,
      });
      rawResponseText = response.choices[0].message.content;
      break;
    }
    case "cohere": {
      if (!cohereClient) throw new Error("Cohere API not configured");
      const cohereHistory = agentHistory.map(h => ({ role: h.role === "assistant" ? "CHATBOT" : "USER", message: h.parts[0].text }));
      const lastMessage = cohereHistory.pop();
      const response = await cohereClient.chat({
        model: MODEL_CONFIGS.cohere.name,
        system: systemPrompt,
        chatHistory: cohereHistory,
        message: lastMessage.message,
        temperature: 0.3,
      });
      rawResponseText = response.text;
      break;
    }
    default:
      throw new Error(`Unknown model: ${model}`);
  }

  try {
    const jsonMatch = rawResponseText.match(/{[\s\S]*}/);
    if (!jsonMatch) throw new Error("No JSON object found in LLM response.");
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Agent LLM returned invalid JSON:", rawResponseText);
    throw new Error("Agent LLM returned invalid JSON.");
  }
}

// Decide whether to call integration import or generate bpy code
function shouldUseIntegrationForPrompt(prompt, integrationStatus) {
  const asset = integrationModules.detectAssetIntent(prompt, integrationStatus);
  
  if (asset.type === "none") return { useIntegration: false, assetIntent: asset };
  
  // If integration is available for detected asset type, prefer integration.
  switch (asset.type) {
    case "hyper3d":
      return { useIntegration: Boolean(integrationStatus.hyper3d), assetIntent: asset };
    case "sketchfab":
      return { useIntegration: Boolean(integrationStatus.sketchfab), assetIntent: asset };
    case "polyhaven":
      return { useIntegration: Boolean(integrationStatus.polyhaven), assetIntent: asset };
    default:
      return { useIntegration: false, assetIntent: asset };
  }
}

async function ensureRagForPrompt(prompt, maxDocs = 5) {
  try {
    const docs = await searchKnowledgeBase(prompt, maxDocs);
    return docs && docs.length ? docs : [];
  } catch (err) {
    console.warn("RAG search failed:", err?.message || err);
    return [];
  }
}

// Asset import tool wrapper
async function generateAndImportAssetFromIntegration(userPrompt, integrationStatus) {
  if (!isBlenderConnected()) throw new Error("Blender is not connected.");
  
  const progress = createProgressTracker();
  const assetIntent = integrationModules.detectAssetIntent(userPrompt, integrationStatus);

  switch (assetIntent.type) {
    case "hyper3d": {
      // Use hyper3d module
      return await integrationModules.hyper3d.generateAndImportAsset(assetIntent.prompt, progress);
    }
    
    case "sketchfab": {
      // Use sketchfab module
      return await integrationModules.sketchfab.searchAndImportModel(assetIntent.query);
    }
    
    case "polyhaven": {
      // Use polyhaven module
      return await integrationModules.polyhaven.searchAndImportAsset(
        assetIntent.query, 
        assetIntent.asset_type
      );
    }
    
    default:
      throw new Error("No asset intent detected. This tool should not have been called.");
  }
}

// Function used by the agent to import assets
async function runAssetImportTool(prompt, integrationStatus) {
  // This function delegates to generateAndImportAssetFromIntegration
  // which now uses our integration modules
  return await generateAndImportAssetFromIntegration(prompt, integrationStatus);
}

// CACHE / ANALYTICS / JOBS
const crypto = cryptoModule;
const CODE_CACHE_MAX = Number(process.env.CODE_CACHE_MAX || 100);
const CODE_CACHE_TTL_MS = Number(process.env.CODE_CACHE_TTL_MS || 5 * 60 * 1000);
const codeGenCache = new Map();
function cacheKeyFromPrompt(fullPrompt) {
  const h = crypto.createHash("sha256").update(fullPrompt || "").digest("hex");
  return h;
}
function cacheGet(key) {
  const v = codeGenCache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > CODE_CACHE_TTL_MS) {
    codeGenCache.delete(key);
    return null;
  }
  // LRU-ish: refresh insertion order
  codeGenCache.delete(key);
  codeGenCache.set(key, v);
  return v;
}
function cacheSet(key, value) {
  if (codeGenCache.has(key)) codeGenCache.delete(key);
  codeGenCache.set(key, { ...value, at: Date.now() });
  while (codeGenCache.size > CODE_CACHE_MAX) {
    const firstKey = codeGenCache.keys().next().value;
    codeGenCache.delete(firstKey);
  }
}

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const rateState = new Map();
function checkRateLimit(userId) {
  // placeholder: always ok
  return { ok: true, retryAfterMs: 0 };
}

const analytics = { totalGenerations: 0, success: 0, errors: 0, totalAttempts: 0, totalDurationMs: 0 };

const jobs = new Map();
const jobQueue = [];
let jobRunning = false;
function enqueueJob(job) {
  jobs.set(job.id, job);
  jobQueue.push(job.id);
  process.nextTick(processJobQueue);
}
async function processJobQueue() {
  if (jobRunning) return;
  const nextId = jobQueue.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job) return process.nextTick(processJobQueue);
  jobRunning = true;
  job.status = "running";
  job.updatedAt = Date.now();
  try {
    const user = { id: job.userId };
    const res = await runGenerationCore(job.payload, user);
    job.result = res;
    job.status = "succeeded";
    job.updatedAt = Date.now();
  } catch (err) {
    job.error = err?.message || String(err);
    job.status = "failed";
    job.updatedAt = Date.now();
  } finally {
    jobRunning = false;
    process.nextTick(processJobQueue);
  }
}

// Polling for Hyper3D - now uses the integration module
async function pollHyper3DJob(subscriptionKey, progress) {
  // Use the integration module's polling function
  return await integrationModules.hyper3d.pollHyper3DJob(subscriptionKey, progress);
}

// Now imported from the integrations module
const detectAssetIntent = integrationModules.detectAssetIntent;

function summarizeText(text, maxLength = 400) {
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength - 3);
  return truncated + "...";
}

/* =========================
   BLENDER CONNECTION - Uses centralized integration system
   ========================= */

// Connection state now managed by integrations/index.js
// We just need to track connection status for server logic
let blenderConnected = false;

async function initializeBlenderConnection() {
  try {
    console.log(`Attempting to connect to Blender at ${BLENDER_TCP_HOST}:${BLENDER_TCP_PORT}`);
    
    // Initialize the connection using our integration module
    await initBlenderConnection();
    
    // Set our connection flag using the centralized connection status
    blenderConnected = isBlenderConnected();
    
    // Check integrations status
    try {
      const status = await fetchIntegrationStatusFromBlender(true);
      console.log(`Integration status: Hyper3D: ${status.hyper3d ? '✅' : '❌'}, PolyHaven: ${status.polyhaven ? '✅' : '❌'}, Sketchfab: ${status.sketchfab ? '✅' : '❌'}`);
    } catch (err) {
      console.warn(`Failed to check integration status: ${err.message}`);
    }
    
    console.log("✅ Connected to Blender TCP server");
  } catch (err) {
    console.error(`❌ Failed to connect to Blender: ${err.message}`);
    blenderConnected = false;
    
    // Retry after 5 seconds
    console.log("Will retry connection in 5 seconds...");
    setTimeout(() => initializeBlenderConnection(), 5000);
  }
}

// Use the centralized sendCommand from integration modules
function sendCommandToBlender(commandType, params = {}) {
  return sendCommand(commandType, params);
}

async function executeBlenderCode(code) {
  return sendCommandToBlender("execute_code", { code });
}

// sanitize blender code helper
function sanitizeBlenderCode(code) {
  if (typeof code !== "string") return "";
  code = code.replace(/^\s*python\s*\n/i, "");
  code = code.replace(/```(?:python|py)?\n?|```/gi, "");
  code = code.replace(/,\s*use_undo\s*=\s*(True|False)/gi, "");
  code = code.replace(/\buse_undo\s*=\s*(True|False)\s*,?\s*/gi, "");
  code = code.replace(/,\s*use_global\s*=\s*(True|False)/gi, "");
  code = code.replace(/\buse_global\s*=\s*(True|False)\s*,?\s*/gi, "");
  code = code.replace(/,\s*constraint_axis\s*=\s*\[[^\]]+\]/gi, "");
  code = code.replace(/\bconstraint_axis\s*=\s*\[[^\]]+\]\s*,?\s*/gi, "");
  code = code.replace(/,\s*,/g, ",");
  code = code.replace(/bpy\.ops\.wm\.obj_delete_all\s*\(\)/gi, `if bpy.data.objects:\n    bpy.ops.object.select_all(action='SELECT')\n    bpy.ops.object.delete()`);
  code = code.replace(/^\s*bpy\.ops\.preferences\.addon_enable\([^)]*\)\s*$/gmi, "");
  code = code.replace(/bpy\.ops\.mesh\.loopcut_and_slide\s*\(([^)]*)\)/gi, (m, inner) => {
    const numMatch = inner.match(/number_cuts"?\s*:?\s*(\d+)/i);
    const cuts = numMatch ? numMatch[1] : "1";
    return `bpy.ops.mesh.loopcut(number_cuts=${cuts})`;
  });
  if (/\bbmesh\b/.test(code) && !/mode_set\s*\(\s*mode\s*=\s*['"]EDIT['"]\s*\)/.test(code)) {
    code = "if bpy.context.object and bpy.context.object.mode != 'EDIT':\n    bpy.ops.object.mode_set(mode='EDIT')\n" + code;
  }
  if (!/\bimport\s+bpy\b/.test(code)) {
    code = "import bpy\n" + code;
  }
  code = code.replace(/\r/g, "");
  return code;
}

function preflightValidateCode(code) {
  const issues = [];
  if (!/\bimport\s+bpy\b/.test(code)) issues.push("Missing 'import bpy' at top of file");
  if (/bpy\.ops\.preferences\.addon_enable\(/.test(code)) issues.push("Avoid enabling addons at runtime; remove bpy.ops.preferences.addon_enable(..)");
  if (/bpy\.ops\.wm\.obj_delete_all\(\)/.test(code)) issues.push("Operator bpy.ops.wm.obj_delete_all() does not exist; use select_all + object.delete()");
  if (/\buse_undo\s*=/.test(code)) issues.push("Deprecated flag use_undo detected; remove it for Blender 4.5");
  if (/\buse_global\s*=/.test(code)) issues.push("Deprecated flag use_global detected; remove it for Blender 4.5");
  if (/constraint_axis\s*=\s*\[/.test(code)) issues.push("Deprecated constraint_axis detected; remove it for Blender 4.5");
  const pairs = [["\\(", "\\)"], ["\\[", "\\]"], ["\\{", "\\}"]];
  for (const [o, c] of pairs) {
    const open = (code.match(new RegExp(o, "g")) || []).length;
    const close = (code.match(new RegExp(c, "g")) || []).length;
    if (open !== close) issues.push(`Unbalanced ${o} ${c}`);
  }
  return issues;
}

function extractCodeFromText(text) {
  if (!text) return "";
  const match = text.match(/```(?:python|py)?\n([\s\S]*?)```/);
  return (match ? match[1] : text.replace(/```/g, "")).trim();
}

// ---- Integration availability cache + checker ----
let integrationStatusCache = { value: { hyper3d: false, polyhaven: false, sketchfab: false }, at: 0 };
const INTEGRATION_TTL_MS = 30_000; // refresh every 30s

async function fetchIntegrationStatusFromBlender(force = false) {
  const now = Date.now();
  if (!force && integrationStatusCache.at && (now - integrationStatusCache.at) < INTEGRATION_TTL_MS) {
    return integrationStatusCache.value;
  }
  
  if (!isBlenderConnected()) {
    integrationStatusCache = { value: { hyper3d: false, polyhaven: false, sketchfab: false }, at: now };
    return integrationStatusCache.value;
  }
  
  try {
    // Use the integrations module to check status
    const status = await integrationModules.checkIntegrationStatus();
    
    // Update cache
    integrationStatusCache = { value: status, at: now };
    return status;
  } catch (err) {
    // if Blender call fails, mark integrations as false but keep prior cache briefly
    console.warn("Integration status check failed:", err?.message || err);
    integrationStatusCache.at = now; // avoid hammering
    integrationStatusCache.value = integrationStatusCache.value || { hyper3d: false, polyhaven: false, sketchfab: false };
    return integrationStatusCache.value;
  }
}

/* =========================
   AUTH & DB HELPERS
   ========================= */

const TOKEN_EXPIRY = "7d";
const normalizeEmail = (email = "") => email.trim().toLowerCase();

function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || row.displayName || null,
    createdAt: row.created_at || row.createdAt,
  };
}

function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1", [email]);
  return rows[0] || null;
}
async function getUserById(id) {
  const { rows } = await pool.query("SELECT id, email, display_name, created_at FROM users WHERE id = $1", [id]);
  return rows[0] || null;
}
async function createUser({ email, password, displayName }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at", [email, passwordHash, displayName || null]);
  return rows[0];
}

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid authorization header" });
    const token = authHeader.slice(7).trim();
    const payload = jwt.verify(token, JWT_SECRET);
    const userRow = await getUserById(payload.sub);
    if (!userRow) return res.status(401).json({ error: "User not found" });
    req.user = toPublicUser(userRow);
    req.token = token;
    next();
  } catch (err) {
    console.error("❌ Auth error:", err?.message || err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

async function listUserConversations(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, title, created_at, updated_at, last_scene_context
     FROM conversations
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );
  return rows.map(mapConversation);
}

async function getConversationForUser(userId, conversationId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, title, created_at, updated_at, last_scene_context
     FROM conversations
     WHERE id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return rows[0] ? mapConversation(rows[0]) : null;
}

async function createConversation(userId, title) {
  const trimmedTitle = (title || "").trim();
  const safeTitle = trimmedTitle.length > 0 ? trimmedTitle : "New Scene";
  const { rows } = await pool.query(
    `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id, user_id, title, created_at, updated_at, last_scene_context`,
    [userId, safeTitle]
  );
  return mapConversation(rows[0]);
}

async function touchConversation(conversationId, { sceneContext, title } = {}) {
  const params = [conversationId];
  const setters = ["updated_at = now()"];
  if (sceneContext !== undefined) {
    params.push(sceneContext);
    setters.push(`last_scene_context = $${params.length}`);
  }
  if (title !== undefined) {
    params.push(title);
    setters.push(`title = $${params.length}`);
  }
  const { rows } = await pool.query(`UPDATE conversations SET ${setters.join(", ")} WHERE id = $1 RETURNING id, user_id, title, created_at, updated_at, last_scene_context`, params);
  return rows[0] ? mapConversation(rows[0]) : null;
}

async function deleteConversation(userId, conversationId) {
  const { rowCount } = await pool.query("DELETE FROM conversations WHERE id = $1 AND user_id = $2", [conversationId, userId]);
  return rowCount > 0;
}

async function saveMessage(conversationId, { role, content, provider, blenderResult, sceneContext, metadata }) {
  const { rows } = await pool.query(
    `INSERT INTO messages (conversation_id, role, content, provider, blender_result, scene_context, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, conversation_id, role, content, provider, blender_result, scene_context, metadata, created_at`,
    [conversationId, role, content ?? null, provider || null, blenderResult || null, sceneContext || null, metadata || {}]
  );
  return mapMessage(rows[0]);
}

async function getConversationMessages(conversationId) {
  const { rows } = await pool.query(
    `SELECT id, conversation_id, role, content, provider, blender_result, scene_context, metadata, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId]
  );
  return rows.map(mapMessage);
}

async function getMessagesForHistory(conversationId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId]
  );
  return rows.map(msg => ({ role: msg.role, parts: [{ text: msg.content || "" }] })).slice(-limit);
}

function deriveTitleFromPrompt(prompt) {
  if (!prompt) return "New Scene";
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return "New Scene";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

/* =========================
   PROMPT ENHANCER (unchanged logic)
   ========================= */
async function enhancePrompt(userPrompt, conversationHistory = []) {
  const enhancementPrompt = `
You are a prompt enhancement assistant for 3D Blender scene generation.
Return ONLY the enhanced prompt.

User's original prompt: "${userPrompt}"
${conversationHistory.length > 0 ? `Conversation context:\n${conversationHistory.slice(-3).map((msg, i) => `${i + 1}. ${msg.role}: ${msg.content}`).join("\n")}\n` : ""}
Enhanced prompt:
`;
  try {
    if (groqClient) {
      const groqResponse = await groqClient.chat.completions.create({
        model: PROMPT_ENHANCER_MODEL,
        messages: [{ role: "user", content: enhancementPrompt }],
        temperature: 0.3,
      });
      const enhanced = (groqResponse?.choices?.[0]?.message?.content || "").trim();
      return enhanced || userPrompt;
    }
  } catch (error) {
    console.error("❌ Prompt enhancement failed:", error?.message || error);
  }
  return userPrompt;
}

/* =========================
   AGENT ReAct core - runGenerationCore
   ========================= */

async function runGenerationCore(body, user) {
  const { prompt, conversationId, attachments = [], captureScreenshot = false, debug = false, model = "gemini" } = body || {};
  console.log(`[Agent] Starting new generation task. Model: ${model}, User: ${user.id}`);
  const startedAt = Date.now();
  const progress = createProgressTracker();
  let analyticsRecorded = false;

  const attachProgress = (error) => {
    if (error && typeof error === 'object' && !error.progress) error.progress = progress.steps;
    return error;
  };

  try {
    progress.add("init", "Starting ReAct agent workflow");
    const rawPrompt = typeof prompt === "string" ? prompt.trim() : "";
    if (!rawPrompt) throw attachProgress(new Error("Prompt required"));

    // Conversation fetch / create
    let conversation;
    if (conversationId) {
      progress.add("conversation_lookup", "Loading existing conversation");
      conversation = await getConversationForUser(user.id, conversationId);
      if (!conversation) throw attachProgress(new Error("Conversation not found"));
      progress.merge("conversation_lookup", { message: "Conversation loaded" });
    } else {
      progress.add("conversation_create", "Creating new conversation");
      conversation = await createConversation(user.id, deriveTitleFromPrompt(rawPrompt));
      progress.merge("conversation_create", { message: "Conversation created", data: { conversationId: conversation.id } });
    }

    const dbHistory = (await getMessagesForHistory(conversation.id, 10)).map(msg => ({ role: msg.role, parts: [{ text: msg.parts[0].text }] }));

    let sceneContext = conversation.lastSceneContext || null;
    const blenderAvailable = isBlenderConnected();

    // fetch current integration status (cached)
    let integrationStatus = { hyper3d: false, polyhaven: false, sketchfab: false };
    if (blenderAvailable) {
      progress.add("integration_fetch", "Checking addon integration availability");
      try {
        integrationStatus = await fetchIntegrationStatusFromBlender().catch(e => integrationStatus);
        progress.merge("integration_fetch", { message: "Integration status fetched", data: integrationStatus });
      } catch (e) {
        progress.addError("integration_fetch", "Failed to fetch integrations", e?.message || String(e));
      }
    }

    if (blenderAvailable) {
      progress.add("context_fetch", "Fetching context from Blender...");
      try {
        sceneContext = await sendCommandToBlender("get_scene_info", {}).catch(err => {
          progress.addError("scene_context", "Failed to fetch scene context", err?.message || String(err));
          return sceneContext;
        });
        progress.merge("context_fetch", { message: "Blender context updated" });
      } catch (err) {
        progress.addError("context_fetch", "Failed to fetch Blender context", err?.message || String(err));
      }
    } else {
      progress.add("context_skipped", "Blender not connected, using cached context");
    }

    // Pre-warm RAG context for the user prompt (agent will use it on search_knowledge_base or before code generation)
    let ragContext = await ensureRagForPrompt(rawPrompt, 5);

    await saveMessage(conversation.id, { role: "user", content: rawPrompt });

    const maxLoops = 10;
    let loopCount = 0;
    let isFinished = false;
    let finalAnswer = "I was not able to complete the task.";
    let lastBlenderResult = null;
    // let ragContext = []; // This is now defined above the loop
    let agentHistory = [{ role: "user", parts: [{ text: rawPrompt }] }];

    while (!isFinished && loopCount < maxLoops) {
      loopCount++;
      progress.add(`agent_loop_${loopCount}`, `Agent reasoning loop ${loopCount} / ${maxLoops}`);

      const systemPrompt = getAgentSystemPrompt(sceneContext, ragContext);
      const llmHistory = [...dbHistory, ...agentHistory];

      console.log(`🤖 [Agent] Loop ${loopCount}: Thinking...`);
      let agentResponse;
      try {
        agentResponse = await callAgentLLM(systemPrompt, llmHistory, model);
      } catch (err) {
        progress.addError(`agent_reason_${loopCount}`, "Agent reasoning failed (LLM call)", err?.message || String(err));
        throw attachProgress(new Error(`Agent reasoning failed: ${err?.message || String(err)}`));
      }

      const { thought, action } = agentResponse;
      if (!thought || !action || !action.name) {
        progress.addError(`agent_reason_${loopCount}`, "Agent returned malformed JSON");
        throw attachProgress(new Error(`Agent returned malformed JSON: ${JSON.stringify(agentResponse)}`));
      }

      progress.merge(`agent_reason_${loopCount}`, { message: `Thought: ${summarizeText(thought, 100)}` });
      console.log(`🤖 [Agent] Thought: ${thought}`);
      console.log(`🤖 [Agent] Action: ${action.name}`, action.args || "");
      agentHistory.push({ role: "assistant", parts: [{ text: JSON.stringify(agentResponse) }] });

      // ACT
      progress.add(`agent_act_${loopCount}`, `Executing tool: ${action.name}`);
      let observation = "";
      try {
        switch (action.name) {
          case "finish_task": {
            isFinished = true;
            finalAnswer = thought;
            observation = "Task finished.";
            progress.merge(`agent_act_${loopCount}`, { message: "Task finished" });
            break;
          }
          case "get_scene_info": {
            if (!blenderAvailable) {
              observation = "Error: Blender is not connected. I cannot see the scene.";
            } else {
              sceneContext = await sendCommandToBlender("get_scene_info", {});
              observation = `Scene info updated. Current objects: ${Array.isArray(sceneContext.objects) ? sceneContext.objects.join(", ") : "unknown"}`;
              progress.merge(`agent_act_${loopCount}`, { message: "Scene info retrieved" });
            }
            break;
          }
          case "search_knowledge_base": {
            const query = action.query || "";
            if (!query) {
              observation = "Error: No query provided for knowledge base search.";
            } else {
              ragContext = await searchKnowledgeBase(query);
              observation = `Knowledge base search for "${query}" returned ${Array.isArray(ragContext) ? ragContext.length : 0} documents. I will use this to write my code.`;
              progress.merge(`agent_act_${loopCount}`, { message: "Knowledge base searched" });
            }
            break;
          }
          case "asset_search_and_import": {
            const assetPrompt = action.prompt || rawPrompt;
            if (!blenderAvailable) {
              observation = "Error: Blender is not connected. Cannot import assets.";
            } else {
              // Refresh integration status quickly in case it changed
              integrationStatus = await fetchIntegrationStatusFromBlender(true).catch(() => integrationStatus);
              const decision = shouldUseIntegrationForPrompt(assetPrompt, integrationStatus);
              if (decision.useIntegration) {
                // Use integration flow (existing tool)
                const assetResult = await runAssetImportTool(assetPrompt, integrationStatus);
                sceneContext = await sendCommandToBlender("get_scene_info", {});
                observation = `Successfully imported asset: A new asset named '${assetResult.name}' was imported via integration.`;
                progress.merge(`agent_act_${loopCount}`, { message: "Asset imported via integration" });
              } else {
                // Integration not available or not suitable; generate bpy code instead
                // Use RAG docs to improve code accuracy
                const localRag = ragContext.length ? ragContext : await ensureRagForPrompt(assetPrompt, 5);
                const systemPrompt = getAgentSystemPrompt(sceneContext, localRag);
                // Ask LLM to output only bpy code to import/construct a substitute placeholder object
                const codeRequest = {
                  role: "user",
                  parts: [{ text: `Generate Blender Python code to create or import a placeholder model for: ${assetPrompt}. Output only valid bpy code.` }],
                };
                const codeLLMResp = await callAgentLLM(systemPrompt, [...dbHistory, ...agentHistory, codeRequest], model);
                // extract code if returned inside JSON or string
                const codeText = (codeLLMResp.action && codeLLMResp.action.code) ? codeLLMResp.action.code : (codeLLMResp.thought || "");
                const extracted = extractCodeFromText(codeText) || codeText;
                const sanitized = sanitizeBlenderCode(extracted);
                lastBlenderResult = await sendCommandToBlender("execute_code", { code: sanitized });
                sceneContext = await sendCommandToBlender("get_scene_info", {});
                observation = `Generated and executed bpy code to create/import placeholder asset. Result: ${lastBlenderResult?.result || "ok"}`;
                progress.merge(`agent_act_${loopCount}`, { message: "Asset created via generated bpy code" });
              }
            }
            break;
          }
          case "execute_blender_code": {
            const code = action.code || "";
            if (!code) {
              observation = "Error: No code provided for execution.";
            } else if (!blenderAvailable) {
              observation = "Error: Blender is not connected. Cannot execute code.";
            } else {
              const sanitizedCode = sanitizeBlenderCode(code);
              lastBlenderResult = await sendCommandToBlender("execute_code", { code: sanitizedCode });
              sceneContext = await sendCommandToBlender("get_scene_info", {});
              if (lastBlenderResult?.status === "error" || lastBlenderResult?.executed === false) {
                const errorMsg = lastBlenderResult?.error || lastBlenderResult?.result || "Unknown execution error";
                observation = `Code execution FAILED: ${errorMsg}. I must analyze this error and try again.`;
                progress.addError(`agent_act_${loopCount}`, "Code execution failed", errorMsg);
              } else {
                const resultText = lastBlenderResult?.result || "No output";
                observation = `Code executed successfully. Output: ${resultText}. Scene now has ${sceneContext?.object_count ?? "unknown"} objects.`;
                progress.merge(`agent_act_${loopCount}`, { message: "Code executed successfully" });
              }
            }
            break;
          }
          default: {
            observation = `Error: Unknown action '${action.name}'. I must choose from the provided tool list.`;
            progress.addError(`agent_act_${loopCount}`, "Unknown action", action.name);
          }
        }
      } catch (err) {
        observation = `Tool execution error: ${err?.message || String(err)}. I will try to recover.`;
        progress.addError(`agent_act_${loopCount}`, "Tool execution error", err?.message || String(err));
      }

      console.log(`🤖 [Agent] Observation: ${summarizeText(observation, 200)}...`);
      agentHistory.push({ role: "user", parts: [{ text: "Observation: " + observation }] });
      progress.merge(`agent_loop_${loopCount}`, { message: `Loop ${loopCount} completed` });
    }

    if (!isFinished) {
      progress.addError("agent_max_loops", "Agent reached maximum loops without finishing");
      finalAnswer = "I reached my maximum reasoning steps (10) without completing the task. Please try breaking down your request into smaller steps.";
    }

    analytics.totalGenerations += 1;
    analytics.totalDurationMs += Date.now() - startedAt;
    analytics.success += isFinished ? 1 : 0;
    analytics.errors += isFinished ? 0 : 1;
    analyticsRecorded = true;

    let screenshot = null;
    if (captureScreenshot && blenderAvailable) {
      // optional screenshot logic
    }

    await saveMessage(conversation.id, {
      role: "assistant",
      content: finalAnswer,
      provider: model,
      blenderResult: lastBlenderResult,
      sceneContext,
      metadata: { agentHistory, loopCount, progress: progress.steps },
    });

    const updatedConversation = await touchConversation(conversation.id, {
      sceneContext,
      title: (conversation.title === "New Scene" || !conversation.title) ? deriveTitleFromPrompt(rawPrompt) : undefined,
    });

    const messages = await getConversationMessages(conversation.id);

    return {
      response: finalAnswer,
      blenderResult: lastBlenderResult,
      provider: model,
      conversationId: conversation.id,
      conversationTitle: updatedConversation?.title || conversation.title,
      sceneContext,
      messages,
      screenshot,
      agentHistory,
      loopCount,
      progress: progress.steps,
      debugArtifacts: debug ? { agentHistory, sceneContext } : undefined,
    };
  } catch (err) {
    console.error("❌ [Agent] FATAL ERROR in runGenerationCore:", err);
    if (!analyticsRecorded) {
      analytics.totalGenerations += 1;
      analytics.errors += 1;
      analytics.totalDurationMs += Date.now() - startedAt;
    }
    throw attachProgress(err instanceof Error ? err : new Error(String(err)));
  }
}

/* =========================
   API endpoints (unchanged semantics)
   ========================= */

// Auth endpoints
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password, displayName } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    const normalizedEmail = normalizeEmail(email);
    const existing = await findUserByEmail(normalizedEmail);
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });
    const userRow = await createUser({ email: normalizedEmail, password, displayName: displayName ? displayName.trim() : null });
    const token = signToken(userRow);
    res.json({ token, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("❌ Signup error:", err?.message || err);
    res.status(500).json({ error: "Failed to create account" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    const normalizedEmail = normalizeEmail(email);
    const userRow = await findUserByEmail(normalizedEmail);
    if (!userRow) return res.status(401).json({ error: "Invalid email or password" });
    const passwordMatches = await bcrypt.compare(password, userRow.password_hash);
    if (!passwordMatches) return res.status(401).json({ error: "Invalid email or password" });
    const token = signToken(userRow);
    res.json({ token, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("❌ Login error:", err?.message || err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/auth/me", authenticate, async (req, res) => {
  res.json({ user: req.user });
});

// Conversations endpoints
app.get("/api/conversations", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const conversations = await listUserConversations(req.user.id);
    res.json({ conversations });
  } catch (err) {
    console.error("❌ Fetch conversations error:", err?.message || err);
    res.status(500).json({ error: "Failed to load conversations" });
  }
});

app.post("/api/conversation/new", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { title } = req.body || {};
    const conversation = await createConversation(req.user.id, title);
    res.json({ conversation });
  } catch (err) {
    console.error("❌ Create conversation error:", err?.message || err);
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

app.get("/api/conversation/:conversationId", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { conversationId } = req.params;
    const conversation = await getConversationForUser(req.user.id, conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const messages = await getConversationMessages(conversationId);
    res.json({ conversation, messages });
  } catch (err) {
    console.error("❌ Get conversation error:", err?.message || err);
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

app.delete("/api/conversation/:conversationId", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { conversationId } = req.params;
    const deleted = await deleteConversation(req.user.id, conversationId);
    if (!deleted) return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Delete conversation error:", err?.message || err);
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

// Enhance prompt
app.post("/api/enhance-prompt", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { prompt, conversationId } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "Prompt is required" });
    let conversationHistory = [];
    if (conversationId) {
      const conversation = await getConversationForUser(req.user.id, conversationId);
      if (conversation) {
        const messages = await getMessagesForHistory(conversation.id, 5);
        conversationHistory = messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.parts[0].text }));
      }
    }
    const enhanced = await enhancePrompt(prompt.trim(), conversationHistory);
    res.json({ enhancedPrompt: enhanced });
  } catch (err) {
    console.error("❌ Enhance prompt error:", err?.message || err);
    res.status(500).json({ error: "Failed to enhance prompt", details: err?.message || null });
  }
});

// Feedback
app.post("/api/feedback", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { conversationId, messageId, rating } = req.body || {};
    if (!conversationId || !messageId || !["up", "down"].includes((rating || "").toLowerCase())) {
      return res.status(400).json({ error: "conversationId, messageId and rating ('up'|'down') required" });
    }
    const messages = await getConversationMessages(conversationId);
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return res.status(404).json({ error: "Message not found" });
    const meta = msg.metadata || {};
    const fb = Array.isArray(meta.feedback) ? meta.feedback : [];
    fb.push({ userId: req.user.id, rating: rating.toLowerCase(), at: Date.now() });
    await pool.query(`UPDATE messages SET metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{feedback}', $1::jsonb, true) WHERE id=$2`, [JSON.stringify(fb), messageId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Feedback error:", err?.message || err);
    res.status(500).json({ error: "Failed to record feedback" });
  }
});

// Scene info
app.post("/api/scene-info", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { conversationId } = req.body || {};
    if (!isBlenderConnected()) return res.status(503).json({ error: "Blender not connected" });
    const sceneInfo = await sendCommandToBlender("get_scene_info", {});
    if (conversationId) {
      const conversation = await getConversationForUser(req.user.id, conversationId);
      if (conversation) await touchConversation(conversation.id, { sceneContext: sceneInfo });
    }
    res.json(sceneInfo);
  } catch (err) {
    console.error("❌ Scene info error:", err?.message || err);
    res.status(500).json({ error: "Failed to get scene info" });
  }
});

// Analytics summary
app.get("/api/analytics/summary", authenticate, async (req, res) => {
  const avgAttempts = analytics.totalGenerations ? analytics.totalAttempts / analytics.totalGenerations : 0;
  const avgDurationMs = analytics.totalGenerations ? analytics.totalDurationMs / analytics.totalGenerations : 0;
  res.json({ windowMs: RATE_LIMIT_WINDOW_MS, totalGenerations: analytics.totalGenerations, success: analytics.success, errors: analytics.errors, avgAttempts, avgDurationMs });
});

// Suggest
app.get("/api/suggest", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const prefix = String(req.query.prefix || "").toLowerCase();
    const suggestions = [];
    const convs = await listUserConversations(req.user.id);
    for (const c of convs.slice(0, 5)) {
      const msgs = await getConversationMessages(c.id);
      for (const m of msgs.slice(-5)) {
        if (m.role === "user" && m.content && m.content.toLowerCase().includes(prefix)) suggestions.push(m.content);
      }
    }
    const uniq = Array.from(new Set(suggestions)).slice(0, 10);
    res.json({ suggestions: uniq });
  } catch (err) {
    res.status(500).json({ error: "Suggest failed", details: err?.message || String(err) });
  }
});

// Checkpoint (safe save)
app.post("/api/checkpoint", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    if (!isBlenderConnected()) return res.status(503).json({ error: "Blender not connected" });
    const ts = Date.now();
    const tmpPath = path.join(os.tmpdir(), `cursor4d_${ts}.blend`);
    const code = `import bpy\n\n# Save current scene to temporary file\ntry:\n    bpy.ops.wm.save_mainfile(filepath=r"${tmpPath}")\n    print('Saved to ${tmpPath}')\nexcept Exception as e:\n    raise Exception(f"Checkpoint failed: {str(e)}")`;
    const result = await executeBlenderCode(code);
    res.json({ status: "ok", path: tmpPath, result });
  } catch (err) {
    res.status(500).json({ error: "Checkpoint failed", details: err?.message || String(err) });
  }
});

// Jobs
app.post("/api/jobs/submit", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const payload = req.body || {};
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const job = { id, userId: req.user.id, status: "queued", createdAt: Date.now(), updatedAt: Date.now(), payload };
    enqueueJob(job);
    res.json({ jobId: id, status: job.status });
  } catch (err) {
    res.status(500).json({ error: "Job submit failed", details: err?.message || String(err) });
  }
});

app.get("/api/jobs/:id/status", authenticate, async (req, res) => {
  try {
    const id = String(req.params.id);
    const job = jobs.get(id);
    if (!job || job.userId !== req.user.id) return res.status(404).json({ error: "Job not found" });
    res.json({ id: job.id, status: job.status, result: job.result, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt });
  } catch (err) {
    res.status(500).json({ error: "Job status failed", details: err?.message || String(err) });
  }
});

// Generate endpoint (agent)
app.post("/api/generate", authenticate, async (req, res) => {
  try {
    const rl = checkRateLimit(req.user.id);
    if (!rl.ok) {
      res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
      return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
    }
    const result = await runGenerationCore(req.body || {}, req.user);
    res.json(result);
  } catch (err) {
    const status = err?.message === "Prompt required" ? 400 : err?.message === "Conversation not found" ? 404 : 500;
    console.error("❌ GENERATION ERROR:", err?.message || err);
    res.status(status).json({ error: err?.message || "Model generation failed", details: err?.details || null, progress: err?.progress || [] });
  }
});

// Models endpoint
app.get("/api/models", authenticate, async (req, res) => {
  try {
    res.json({
      models: [
        genAI ? { id: "gemini", name: MODEL_CONFIGS.gemini.displayName } : null,
        groqClient ? { id: "groq", name: MODEL_CONFIGS.groq.displayName } : null,
        cohereClient ? { id: "cohere", name: MODEL_CONFIGS.cohere.displayName } : null,
      ].filter(Boolean),
      defaults: { agent: "gemini" },
      promptEnhancer: groqClient ? PROMPT_ENHANCER_MODEL : null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load models", details: err?.message || String(err) });
  }
});

/* =========================
   START SERVER
   ========================= */

(async () => {
  try {
    // Initialize database schema
    console.log("📊 Initializing database schema...");
    await initSchema();
    console.log("✅ Database schema initialized");
    
    // Pre-load the embedding model for RAG
    getEmbedder().then(() => {
      console.log("✅ Local embedding model loaded and ready.");
    }).catch(err => {
      console.error("⚠️ Failed to pre-load local embedding model:", err?.message || err);
    });
    
    // Initialize Blender connection using our integration module
    await initializeBlenderConnection();
    
    // Start the Express server
    app.listen(PORT, () => {
      console.log(`🚀 Backend running at http://localhost:${PORT}`);
      
      // Log API configuration
      if (genAI) console.log(`🤖 Gemini API: ✅ Configured`);
      else console.log(`🤖 Gemini API: ❌ Not configured. Set GEMINI_API_KEY in .env to enable.`);
      
      if (groqClient) console.log(`🚀 Groq API: ✅ Configured`);
      else console.log(`🚀 Groq API: ❌ Not configured. Set GROQ_API_KEY in .env to enable.`);
      
      if (cohereClient) console.log(`🕊️ Cohere API: ✅ Configured`);
      else console.log(`🕊️ Cohere API: ❌ Not configured. Set COHERE_API_KEY in .env to enable.`);
      
      console.log(`📚 RAG Model: ${EMBEDDING_MODEL_NAME}`);
    });
  } catch (err) {
    console.error("💥 Startup Error:", err?.message || err);
    if ((err?.message || "").includes("ENOTFOUND") || (err?.message || "").includes("getaddrinfo")) {
      console.error("💡 DNS/network error. Check DATABASE_URL, connectivity and database host.");
    }
    console.error("❌ Backend cannot start without database connection (required for authentication)");
    process.exit(1);
  }
})();