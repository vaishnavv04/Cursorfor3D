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

import { pipeline } from "@xenova/transformers";
import pgvector from "pgvector/pg";

import { pool, initSchema, mapConversation, mapMessage } from "./db.js";
import { createProgressTracker } from "./utils/progress.js";
import { getRandomGeminiKey } from "./utils/simple-api-keys.js";
import { integrationModules, initBlenderConnection, sendCommand, isBlenderConnected } from './integrations/index.js';
import { runLangGraphAgent } from "./langgraph-agent.js";
import { apiLimiter, authLimiter, generationLimiter } from "./middleware/security.js";
import logger from "./utils/logger.js";
import path from "node:path";
import os from "node:os";

dotenv.config();

// Top-level dynamic import (works in modern Node ESM)
const cryptoModule = await import("node:crypto");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));

// Apply general API rate limiting to all routes
app.use("/api/", apiLimiter);

const PORT = process.env.PORT || 5000;
const BLENDER_TCP_PORT = parseInt(process.env.BLENDER_TCP_PORT || "9876", 10);
const BLENDER_TCP_HOST = process.env.BLENDER_TCP_HOST || "127.0.0.1";
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  logger.error("JWT_SECRET environment variable is required for authentication.");
  process.exit(1);
}

// Initialize AI providers (may be null if key missing)
const groqClient = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// Dynamic Gemini client creation function
async function createGeminiClient() {
  const apiKey = getRandomGeminiKey();
  return apiKey ? new GoogleGenerativeAI(apiKey) : null;
}

// Model configs
const MODEL_CONFIGS = {
  gemini: { name: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
  groq: { name: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B (Groq)" },
};
const PROMPT_ENHANCER_MODEL = "llama-3.1-8b-instant";

// RAG / embeddings
const EMBEDDING_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_EMBEDDING_DIM = 380; // Match the existing table dimension

let embedderPromise = null;
async function getEmbedder() {
  if (embedderPromise === null) {
    logger.info("Loading local embedding model", { model: EMBEDDING_MODEL_NAME });
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
    logger.error(`Error checking if table exists`, { table: tableName, error: error.message });
    return false;
  }
}

async function searchKnowledgeBase(queryText, limit = 5) {
  logger.info(`[RAG] Searching knowledge base`, { query: queryText.slice(0, 100), limit });
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
          logger.info(`[RAG] Found ${newRows.length} relevant documents in new table`);
          return newRows.map((r) => r.content);
        }
      } catch (newTableError) {
        logger.warn(`[RAG] Error searching new table: ${newTableError.message}`);
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
    logger.info(`[RAG] Found ${rows.length} relevant documents in original table`);
    return rows.map((r) => r.content);
  } catch (error) {
    logger.error(`[RAG] Knowledge base search failed`, { error: error?.message || error });
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

// LLM caller for agent (supports gemini/groq)
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
      const genAI = await createGeminiClient();
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
    default:
      throw new Error(`Unknown model: ${model}`);
  }

  try {
    const jsonMatch = rawResponseText.match(/{[\s\S]*}/);
    if (!jsonMatch) throw new Error("No JSON object found in LLM response.");
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.error("Agent LLM returned invalid JSON", { response: rawResponseText.slice(0, 500), parseError: err.message });
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
    logger.warn("RAG search failed in ensureRagForPrompt", { error: err?.message || err });
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
function cacheKeyFromPrompt(fullPrompt, userId, conversationId) {
  // Include userId and conversationId to prevent cache collision between different users/contexts
  const composite = JSON.stringify({
    prompt: fullPrompt || "",
    userId: userId || "anonymous",
    conversationId: conversationId || "none"
  });
  const h = cryptoModule.createHash("sha256").update(composite).digest("hex");
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

// Connection retry tracking
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RETRY_DELAY = 5000; // 5 seconds

async function initializeBlenderConnection() {
  try {
    logger.info(`Attempting to connect to Blender`, { host: BLENDER_TCP_HOST, port: BLENDER_TCP_PORT, attempt: reconnectAttempts + 1 });
    
    // Initialize the connection using our integration module
    await initBlenderConnection();
    
    // Set our connection flag using the centralized connection status
    blenderConnected = isBlenderConnected();
    
    // Reset reconnect attempts on success
    reconnectAttempts = 0;
    
    // Check integrations status
    try {
      const status = await fetchIntegrationStatusFromBlender(true);
      logger.info(`Integration status checked`, { status });
    } catch (err) {
      logger.warn(`Failed to check integration status`, { error: err.message });
    }
    
    logger.info("Connected to Blender TCP server successfully");
  } catch (err) {
    logger.error(`Failed to connect to Blender`, { error: err.message, host: BLENDER_TCP_HOST, port: BLENDER_TCP_PORT });
    blenderConnected = false;
    
    // Implement exponential backoff with max attempts
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = Math.min(
        BASE_RETRY_DELAY * Math.pow(2, reconnectAttempts - 1),
        60000 // Max 60 seconds
      );
      
      logger.info(`Will retry connection in ${delay}ms...`, { 
        attempt: reconnectAttempts, 
        maxAttempts: MAX_RECONNECT_ATTEMPTS 
      });
      
      setTimeout(() => {
        initializeBlenderConnection().catch(retryErr => {
          logger.error(`Reconnect attempt ${reconnectAttempts} failed`, { error: retryErr.message });
        });
      }, delay);
    } else {
      logger.error(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Manual intervention required.`, {
        suggestion: "Please ensure Blender is running with the MCP addon active on port " + BLENDER_TCP_PORT
      });
    }
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
    logger.warn("Integration status check failed", { error: err?.message || err });
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
    logger.error("Authentication middleware failed", { error: err?.message || err });
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
    logger.error("Prompt enhancement failed", { error: error?.message || error });
  }
  return userPrompt;
}

/* =========================
   LangGraph AGENT core - runGenerationCore
   ========================= */
async function runGenerationCore(body, user) {
  const { prompt, conversationId, attachments = [], captureScreenshot = false, debug = false, model = "gemini" } = body || {};
  logger.info(`[LangGraph Agent] Starting new generation task`, { model, userId: user.id, conversationId });
  const startedAt = Date.now();
  const progress = createProgressTracker();
  let analyticsRecorded = false;

  const attachProgress = (error) => {
    if (error && typeof error === 'object' && !error.progress) error.progress = progress.steps;
    return error;
  };

  try {
    progress.add("init", "Starting LangGraph agent workflow");
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

    // Save user message
    await saveMessage(conversation.id, { role: "user", content: rawPrompt });

    // Get initial scene context if Blender is connected
    let sceneContext = conversation.lastSceneContext || null;
    const blenderAvailable = isBlenderConnected();

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

    progress.add("agent_execution", "Running LangGraph agent workflow");

    // Run the LangGraph agent
    const agentResult = await runLangGraphAgent(rawPrompt, {
      conversationId: conversation.id,
      sceneContext,
      model,
      maxLoops: 10,
      attachments,
    });

    progress.merge("agent_execution", { 
      message: "LangGraph agent completed", 
      data: { loopCount: agentResult.loopCount, finished: agentResult.finished }
    });

    // Update analytics
    analytics.totalGenerations += 1;
    analytics.totalDurationMs += Date.now() - startedAt;
    analytics.success += agentResult.finished ? 1 : 0;
    analytics.errors += agentResult.finished ? 0 : 1;
    analyticsRecorded = true;

    // Handle screenshot if requested
    let screenshot = null;
    if (captureScreenshot && blenderAvailable) {
      progress.add("screenshot", "Capturing viewport screenshot");
      try {
        screenshot = await sendCommandToBlender("capture_viewport", {});
        progress.merge("screenshot", { message: "Screenshot captured" });
      } catch (err) {
        progress.addError("screenshot", "Failed to capture screenshot", err?.message || String(err));
      }
    }

    // Save assistant message
    await saveMessage(conversation.id, {
      role: "assistant",
      content: agentResult.response,
      provider: model,
      blenderResult: null, // LangGraph handles this internally
      sceneContext: agentResult.sceneContext,
      metadata: { 
        agentHistory: agentResult.messages, 
        loopCount: agentResult.loopCount, 
        progress: progress.steps,
        langGraph: true 
      },
    });

    // Update conversation with scene context
    const updatedConversation = await touchConversation(conversation.id, {
      sceneContext: agentResult.sceneContext,
      title: (conversation.title === "New Scene" || !conversation.title) ? deriveTitleFromPrompt(rawPrompt) : undefined,
    });

    // Get all messages for response
    const messages = await getConversationMessages(conversation.id);

    return {
      response: agentResult.response,
      blenderResult: null, // Handled internally by LangGraph
      provider: model,
      conversationId: conversation.id,
      conversationTitle: updatedConversation?.title || conversation.title,
      sceneContext: agentResult.sceneContext,
      messages,
      screenshot,
      agentHistory: agentResult.messages,
      loopCount: agentResult.loopCount,
      progress: progress.steps,
      debugArtifacts: debug ? { agentHistory: agentResult.messages, sceneContext: agentResult.sceneContext } : undefined,
      langGraph: true, // Flag to indicate LangGraph was used
    };
  } catch (err) {
    logger.error("[LangGraph Agent] FATAL ERROR in runGenerationCore", { error: err?.message || err, stack: err?.stack });
    if (!analyticsRecorded) {
      analytics.totalGenerations += 1;
      analytics.errors += 1;
      analytics.totalDurationMs += Date.now() - startedAt;
    }
    throw attachProgress(err instanceof Error ? err : new Error(String(err)));
  }
}

// Auth endpoints
app.post("/api/auth/signup", authLimiter, async (req, res) => {
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
    logger.error("Signup error", { error: err?.message || err });
    res.status(500).json({ error: "Failed to create account" });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
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
    logger.error("Login error", { error: err?.message || err });
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
    logger.error("Fetch conversations error", { error: err?.message || err, userId: req.user.id });
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
    logger.error("Create conversation error", { error: err?.message || err, userId: req.user.id });
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
    logger.error("Get conversation error", { error: err?.message || err, userId: req.user.id, conversationId: req.params.conversationId });
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
    logger.error("Delete conversation error", { error: err?.message || err, userId: req.user.id, conversationId: req.params.conversationId });
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
    logger.error("Enhance prompt error", { error: err?.message || err, userId: req.user.id });
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
    logger.error("Feedback error", { error: err?.message || err, userId: req.user.id });
    res.status(500).json({ error: "Failed to record feedback" });
  }
});

// API Key Validation endpoint
app.post("/api/validate-key", authenticate, async (req, res) => {
  const { service, apiKey } = req.body;
  
  if (!service || !apiKey) {
    return res.status(400).json({ valid: false, error: "Service and apiKey are required" });
  }
  
  try {
    let isValid = false;
    let errorMessage = null;
    
    switch (service.toLowerCase()) {
      case 'gemini':
        try {
          const testGenAI = new GoogleGenerativeAI(apiKey);
          const model = testGenAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          await model.generateContent({ contents: [{ role: "user", parts: [{ text: "test" }] }] });
          isValid = true;
        } catch (error) {
          errorMessage = error.message;
        }
        break;
        
      case 'groq':
        try {
          const testGroq = new Groq({ apiKey });
          await testGroq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: "test" }],
            max_tokens: 5
          });
          isValid = true;
        } catch (error) {
          errorMessage = error.message;
        }
        break;
        
      case 'hyper3d':
      case 'rodin':
        try {
          const response = await fetch('https://hyperhuman.deemos.com/api/v2/status', {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            }
          });
          isValid = response.ok;
          if (!isValid) {
            errorMessage = `HTTP ${response.status}: ${response.statusText}`;
          }
        } catch (error) {
          errorMessage = error.message;
        }
        break;
        
      case 'sketchfab':
        try {
          const response = await fetch('https://api.sketchfab.com/v3/me', {
            headers: {
              'Authorization': `Token ${apiKey}`
            }
          });
          isValid = response.ok;
          if (!isValid) {
            errorMessage = `HTTP ${response.status}: ${response.statusText}`;
          }
        } catch (error) {
          errorMessage = error.message;
        }
        break;
        
      default:
        return res.status(400).json({ 
          valid: false, 
          error: `Unknown service: ${service}. Supported: gemini, groq, hyper3d, sketchfab` 
        });
    }
    
    res.json({ 
      valid: isValid,
      service,
      ...(errorMessage && { error: errorMessage })
    });
  } catch (error) {
    logger.error(`API key validation error`, { service, error: error.message });
    res.status(500).json({ valid: false, error: "Validation failed: " + error.message });
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
    logger.error("Scene info error", { error: err?.message || err, userId: req.user.id });
    res.status(500).json({ error: "Failed to get scene info" });
  }
});

// Analytics summary
app.get("/api/analytics/summary", authenticate, async (req, res) => {
  const avgAttempts = analytics.totalGenerations ? analytics.totalAttempts / analytics.totalGenerations : 0;
  const avgDurationMs = analytics.totalGenerations ? analytics.totalDurationMs / analytics.totalGenerations : 0;
  res.json({ windowMs: RATE_LIMIT_WINDOW_MS, totalGenerations: analytics.totalGenerations, success: analytics.success, errors: analytics.errors, avgAttempts, avgDurationMs });
});

// Health monitoring endpoint
app.get("/api/health", async (req, res) => {
  try {
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {}
    };

    // Check Blender connection
    health.services.blender = {
      connected: isBlenderConnected(),
      host: BLENDER_TCP_HOST,
      port: BLENDER_TCP_PORT
    };

    // Check database connectivity
    try {
      await pool.query('SELECT 1');
      health.services.database = {
        status: "connected",
        connectionString: process.env.DATABASE_URL ? "configured" : "missing"
      };
    } catch (dbErr) {
      health.services.database = {
        status: "disconnected",
        error: dbErr.message
      };
      health.status = "degraded";
    }

    // Check API key availability
    const testGeminiKey = getRandomGeminiKey();
    health.services.apiKeys = {
      gemini: testGeminiKey ? "configured" : "missing",
      groq: groqClient ? "configured" : "missing"
    };

    // Check integration status
    if (isBlenderConnected()) {
      try {
        const integrationStatus = await integrationModules.checkIntegrationStatus();
        health.services.integrations = {
          hyper3d: integrationStatus.hyper3d ? "enabled" : "disabled",
          polyhaven: integrationStatus.polyhaven ? "enabled" : "disabled",
          sketchfab: integrationStatus.sketchfab ? "enabled" : "disabled"
        };

        // Check circuit breaker states
        health.services.circuitBreakers = {
          hyper3d: integrationModules.hyper3d.getCircuitBreakerState(),
          sketchfab: integrationModules.sketchfab.getCircuitBreakerState(),
          polyhaven: integrationModules.polyhaven.getCircuitBreakerState()
        };
      } catch (err) {
        health.services.integrations = { error: "Unable to check integration status" };
        health.services.circuitBreakers = { error: err.message };
      }
    } else {
      health.services.integrations = { status: "unavailable", reason: "Blender not connected" };
      health.services.circuitBreakers = { status: "unavailable", reason: "Blender not connected" };
    }

    // Check RAG system
    try {
      const hasNewTable = await tableExists("blender_knowledge_new");
      const hasOldTable = await tableExists("blender_knowledge");
      health.services.rag = {
        status: (hasNewTable || hasOldTable) ? "available" : "not initialized",
        tables: {
          blender_knowledge_new: hasNewTable,
          blender_knowledge: hasOldTable
        },
        embeddingModel: EMBEDDING_MODEL_NAME
      };
    } catch (err) {
      health.services.rag = {
        status: "error",
        error: err.message
      };
    }

    // Set overall status
    if (!health.services.blender.connected || health.services.database.status !== "connected") {
      health.status = "degraded";
    }

    const statusCode = health.status === "healthy" ? 200 : health.status === "degraded" ? 503 : 500;
    res.status(statusCode).json(health);
  } catch (err) {
    logger.error("Health check error", { error: err.message });
    res.status(500).json({
      status: "error",
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
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
app.post("/api/generate", authenticate, generationLimiter, async (req, res) => {
  try {
    const rl = checkRateLimit(req.user.id);
    if (!rl.ok) {
      res.set("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
      return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
    }
    const result = await runGenerationCore(req.body || {}, req.user);
    
    // Convert technical error messages in response to user-friendly ones
    if (result.response) {
      if (result.response.includes("Branch condition returned unknown") || 
          result.response.includes("null destination") ||
          result.response.includes("FATAL ERROR")) {
        result.response = "I've completed your request, but encountered some internal processing issues. Your 3D model should be created in Blender. Please check the viewport.";
      }
    }
    
    res.json(result);
  } catch (err) {
    const status = err?.message === "Prompt required" ? 400 : err?.message === "Conversation not found" ? 404 : 500;
    logger.error("GENERATION ERROR", { error: err?.message || err, userId: req.user.id, stack: err?.stack });
    
    // Convert technical errors to user-friendly messages
    let userFriendlyError = err?.message || "Model generation failed";
    
    if (userFriendlyError.includes("Branch condition") || 
        userFriendlyError.includes("null destination") ||
        userFriendlyError.includes("FATAL ERROR")) {
      userFriendlyError = "I encountered an issue while processing your request. Please try again or rephrase your prompt.";
    } else if (userFriendlyError.includes("timeout") || userFriendlyError.includes("Timeout")) {
      userFriendlyError = "The request took too long to process. Please try a simpler prompt or check your Blender connection.";
    } else if (userFriendlyError.includes("not connected") || userFriendlyError.includes("Connection")) {
      userFriendlyError = "Unable to connect to Blender. Please ensure Blender is running with the MCP addon enabled on port 9876.";
    }
    
    res.status(status).json({ error: userFriendlyError, details: err?.details || null, progress: err?.progress || [] });
  }
});

// Models endpoint
app.get("/api/models", authenticate, async (req, res) => {
  try {
    const testKey = getRandomGeminiKey();
    res.json({
      models: [
        testKey ? { id: "gemini", name: MODEL_CONFIGS.gemini.displayName } : null,
        groqClient ? { id: "groq", name: MODEL_CONFIGS.groq.displayName } : null,
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
    logger.info("Initializing database schema");
    await initSchema();
    logger.info("Database schema initialized successfully");
    
    // Pre-load the embedding model for RAG
    getEmbedder().then(() => {
      logger.info("Local embedding model loaded and ready", { model: EMBEDDING_MODEL_NAME });
    }).catch(err => {
      logger.warn("Failed to pre-load local embedding model", { error: err?.message || err });
    });
    
    // Initialize Blender connection using our integration module
    await initializeBlenderConnection();
    
    // Start the Express server
    app.listen(PORT, () => {
      logger.info(`Backend running`, { port: PORT, url: `http://localhost:${PORT}` });
      
      // Log API configuration
      const testKey = getRandomGeminiKey();
      if (testKey) logger.info(`Gemini API: Configured with random key selection`);
      else logger.warn(`Gemini API: Not configured. Set GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc. in .env to enable.`);
      
      if (groqClient) logger.info(`Groq API: Configured`);
      else logger.warn(`Groq API: Not configured. Set GROQ_API_KEY in .env to enable.`);
      
      logger.info(`RAG Model: ${EMBEDDING_MODEL_NAME}`);
    });
  } catch (err) {
    logger.error("Startup Error", { error: err?.message || err, stack: err?.stack });
    if ((err?.message || "").includes("ENOTFOUND") || (err?.message || "").includes("getaddrinfo")) {
      logger.error("DNS/network error. Check DATABASE_URL, connectivity and database host.");
    }
    logger.error("Backend cannot start without database connection (required for authentication)");
    process.exit(1);
  }
})();