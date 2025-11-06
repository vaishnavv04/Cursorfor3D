import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import net from "net";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

import { pool, initSchema, mapConversation, mapMessage } from "./db.js";

dotenv.config();

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

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
const groqClient = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama3-70b-8192";

// Simple LRU cache for code generation results (prompt -> code)
const crypto = await import('node:crypto');
const CODE_CACHE_MAX = Number(process.env.CODE_CACHE_MAX || 100);
const CODE_CACHE_TTL_MS = Number(process.env.CODE_CACHE_TTL_MS || 5 * 60 * 1000);
const codeGenCache = new Map(); // key -> { code, provider, at }

function cacheKeyFromPrompt(fullPrompt) {
  const h = crypto.createHash('sha256').update(fullPrompt || '').digest('hex');
  return h;
}

function cacheGet(key) {
  const v = codeGenCache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > CODE_CACHE_TTL_MS) {
    codeGenCache.delete(key);
    return null;
  }
  // LRU touch
  codeGenCache.delete(key);
  codeGenCache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  if (codeGenCache.has(key)) codeGenCache.delete(key);
  codeGenCache.set(key, { ...value, at: Date.now() });
  // Trim LRU
  while (codeGenCache.size > CODE_CACHE_MAX) {
    const firstKey = codeGenCache.keys().next().value;
    codeGenCache.delete(firstKey);
  }
}

// Simple per-user rate limiter (in-memory)
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const rateState = new Map(); // userId -> { count, resetAt }

function checkRateLimit(userId) {
  const now = Date.now();
  const st = rateState.get(userId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > st.resetAt) {
    st.count = 0; st.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  if (st.count >= RATE_LIMIT_MAX) {
    const retry = Math.max(0, st.resetAt - now);
    return { ok: false, retryAfterMs: retry };
  }
  st.count += 1;
  rateState.set(userId, st);
  return { ok: true };
}

// Basic analytics (in-memory since boot)
const analytics = {
  totalGenerations: 0,
  success: 0,
  errors: 0,
  totalAttempts: 0,
  totalDurationMs: 0,
};

// Simple in-memory background job queue
const jobs = new Map(); // id -> { id, userId, status, createdAt, updatedAt, payload, result, error }
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
  job.status = 'running'; job.updatedAt = Date.now();
  try {
    const user = { id: job.userId };
    const res = await runGenerationCore(job.payload, user);
    job.result = res; job.status = 'succeeded'; job.updatedAt = Date.now();
  } catch (err) {
    job.error = err?.message || String(err); job.status = 'failed'; job.updatedAt = Date.now();
  } finally {
    jobRunning = false;
    process.nextTick(processJobQueue);
  }
}

// Core generation logic used by queue; mirrors /api/generate with minimal fields
async function runGenerationCore(body, user) {
  const {
    prompt,
    conversationId,
    enhancePrompt: shouldEnhance,
    attachments = [],
    model,
    dryRun = false,
    captureScreenshot = false,
    debug = false,
    abTest = false,
    visualRefine = false,
    agentType
  } = body || {};

  if (!prompt || !String(prompt).trim()) throw new Error('Prompt required');

  let conversation;
  if (conversationId) {
    conversation = await getConversationForUser(user.id, conversationId);
    if (!conversation) throw new Error('Conversation not found');
  } else {
    conversation = await createConversation(user.id, deriveTitleFromPrompt(String(prompt)));
  }

  const history = await getMessagesForHistory(conversation.id, 10);
  let sceneContext = conversation.lastSceneContext || null;
  if (blenderClient && blenderConnected) {
    try { sceneContext = await sendCommandToBlender('get_scene_info', {}); } catch {}
  }

  const nonSystemHistory = history.filter((msg) => msg.role !== 'system');
  let finalPrompt = String(prompt);
  if (shouldEnhance) finalPrompt = await enhancePrompt(String(prompt), nonSystemHistory);

  const sanitizedAttachments = (attachments || []).map(({ id, name, type, size }) => ({ id, name, type, size }));
  await saveMessage(conversation.id, { role: 'user', content: finalPrompt, metadata: { originalPrompt: prompt, enhancedPrompt: shouldEnhance ? finalPrompt : null, attachments: sanitizedAttachments } });

  const historyWithCurrent = [...nonSystemHistory, { role: 'user', content: finalPrompt }];
  let systemPrompt = getSystemPrompt(historyWithCurrent.length > 1, sceneContext);
  if (agentType && AGENT_TIPS[String(agentType).toLowerCase()]) {
    systemPrompt = `${systemPrompt}\n\n${AGENT_TIPS[String(agentType).toLowerCase()]}`;
  }
  const conversationContext = historyWithCurrent.slice(-6).map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n\n');
  const docSnippets = getRelevantDocs(finalPrompt);
  const fullPromptBase = historyWithCurrent.length > 1 ? `${systemPrompt}\n\nConversation history:\n${conversationContext}\n\nCurrent user request: ${finalPrompt}` : `${systemPrompt}\n\nUser request: ${finalPrompt}`;
  const fullPrompt = docSnippets.length ? `${fullPromptBase}\n\nHelpful API snippets:\n${docSnippets.map((t,i)=>`${i+1}. ${t}`).join('\n')}` : fullPromptBase;

  // A/B mode returns quickly (no exec)
  if (abTest) {
    const attemptOrder = [];
    const requestedModel = typeof model === 'string' ? model.toLowerCase() : '';
    const preferGroq = requestedModel.includes('llama') || requestedModel.includes('groq');
    if (preferGroq && groqClient) attemptOrder.push('groq');
    if (genAI) attemptOrder.push('gemini');
    if (groqClient && !preferGroq) attemptOrder.push('groq');
    let code = '', providerUsed = '';
    for (const p of attemptOrder) {
      try {
        if (p==='gemini' && genAI) { const m=genAI.getGenerativeModel({ model: GEMINI_MODEL }); const r=await m.generateContent(fullPrompt); code=(r?.response?.text?.()||'').trim(); if (code) { providerUsed='gemini'; break; } }
        if (p==='groq' && groqClient) { const r=await groqClient.chat.completions.create({ model: GROQ_MODEL, messages:[{role:'user', content: fullPrompt}], temperature:0.2 }); code=(r?.choices?.[0]?.message?.content||'').trim(); if (code) { providerUsed='groq'; break; } }
      } catch {}
    }
    const v1 = extractCodeFromText(code);
    return { mode:'ab', variants:[ { provider: providerUsed, code: sanitizeBlenderCode(v1), preflightIssues: preflightValidateCode(sanitizeBlenderCode(v1)) } ], docSnippets, conversationId: conversation.id };
  }

  // Code-gen with cache
  let providerUsed = '';
  let code = '';
  const cacheKey = !dryRun ? cacheKeyFromPrompt(fullPrompt) : null;
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached?.code) { code = cached.code; providerUsed = cached.provider || providerUsed; }
  }
  if (!code) {
    const attemptOrder = [];
    const requestedModel = typeof model === 'string' ? model.toLowerCase() : '';
    const preferGroq = requestedModel.includes('llama') || requestedModel.includes('groq');
    if (preferGroq && groqClient) attemptOrder.push('groq');
    if (genAI) attemptOrder.push('gemini');
    if (groqClient && !preferGroq) attemptOrder.push('groq');
    for (const p of attemptOrder) {
      try {
        if (p==='gemini' && genAI) { const m=genAI.getGenerativeModel({ model: GEMINI_MODEL }); const r=await m.generateContent(fullPrompt); code=(r?.response?.text?.()||'').trim(); if (code) { providerUsed='gemini'; break; } }
        if (p==='groq' && groqClient) { const r=await groqClient.chat.completions.create({ model: GROQ_MODEL, messages:[{role:'user', content: fullPrompt}], temperature:0.2 }); code=(r?.choices?.[0]?.message?.content||'').trim(); if (code) { providerUsed='groq'; break; } }
      } catch {}
    }
    if (cacheKey && code) cacheSet(cacheKey, { code, provider: providerUsed });
  }
  if (!code) throw new Error('No model output');

  code = extractCodeFromText(code);
  if (!code.includes('import bpy')) code = `import bpy\n${code}`;
  code = sanitizeBlenderCode(code);
  const preflightIssues = preflightValidateCode(code);
  if (dryRun) return { mode:'dry_run', preflightIssues, sanitizedCode: code, provider: providerUsed, conversationId: conversation.id };

  const startedAt = Date.now();
  const recovery = await tryExecuteWithRecovery({ initialCode: code, maxAttempts: Number(process.env.LLM_REPAIR_ATTEMPTS||2), preferGroq: providerUsed==='groq', sceneContext });
  analytics.totalGenerations += 1; const ok = recovery.ok; if (ok) analytics.success += 1; else analytics.errors += 1; analytics.totalAttempts += (recovery.attempts||[]).length; analytics.totalDurationMs += (Date.now()-startedAt);
  let screenshot = null;
  if (ok && captureScreenshot && blenderClient && blenderConnected) { try { const img = await sendCommandToBlender('get_viewport_screenshot', { max_size: 800 }); screenshot = img?.data || img?.image || img || null; } catch {} }
  await saveMessage(conversation.id, { role:'assistant', content: recovery.code || code, provider: providerUsed, blenderResult: recovery.result || null, sceneContext, metadata:{ attempts: recovery.attempts || [], preflightIssues } });
  return { response: recovery.code || code, blenderResult: recovery.result || null, provider: providerUsed, conversationId: conversation.id, preflightIssues, screenshot };
}


let blenderClient = null;
let blenderConnected = false;
let buffer = "";
let nextRequestId = 1;
const pendingRequests = new Map();
let requestQueue = [];
let isProcessingQueue = false;
let expectedResponseId = null;
const timedOutRequests = new Set();

function resetBlenderState() {
  buffer = "";
  for (const [, { reject, timeout }] of pendingRequests.entries()) {
    if (timeout) clearTimeout(timeout);
    reject(new Error("Blender connection reset"));
  }
  pendingRequests.clear();

  for (const { reject } of requestQueue) {
    reject(new Error("Blender connection reset"));
  }
  requestQueue = [];
  isProcessingQueue = false;
  expectedResponseId = null;
  timedOutRequests.clear();
}

function initializeBlenderConnection() {
  buffer = "";
  for (const [, { timeout }] of pendingRequests.entries()) {
    if (timeout) clearTimeout(timeout);
  }
  pendingRequests.clear();
  isProcessingQueue = false;
  expectedResponseId = null;
  timedOutRequests.clear();

  if (requestQueue.length > 0) {
    console.log(`📋 Processing ${requestQueue.length} queued request(s) after connection established`);
    processRequestQueue();
  }
}

function parseIncomingMessages(chunk) {
  buffer += chunk.toString("utf8");

  let previousBufferLength = -1;
  while (buffer.length > 0) {
    const currentBufferLength = buffer.length;
    if (currentBufferLength === previousBufferLength) {
      console.warn("⚠️ Detected potential infinite loop, skipping first character");
      buffer = buffer.slice(1);
      previousBufferLength = -1;
      continue;
    }
    previousBufferLength = currentBufferLength;

    try {
      let braceCount = 0;
      let jsonStart = -1;
      let jsonEnd = -1;
      let inString = false;
      let escapeNext = false;

      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i];

        if (escapeNext) {
          escapeNext = false;
      continue;
    }

        if (char === "\\") {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === "{") {
            if (jsonStart === -1) jsonStart = i;
            braceCount++;
          } else if (char === "}") {
            braceCount--;
            if (braceCount === 0 && jsonStart !== -1) {
              jsonEnd = i + 1;
              break;
            }
          }
        }
      }

      if (jsonEnd === -1) {
      return;
    }

      const jsonStr = buffer.slice(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonStr);

      console.log("📥 Response from Blender:", JSON.stringify(parsed));

      buffer = buffer.slice(jsonEnd).trim();
      previousBufferLength = -1;

      const firstRequestId = Array.from(pendingRequests.keys())[0];

      if (firstRequestId === undefined) {
        if (expectedResponseId !== null && timedOutRequests.has(expectedResponseId)) {
          console.warn(`⚠️ Discarding late response for timed-out request ${expectedResponseId}`);
          expectedResponseId = null;
        } else {
          console.warn("⚠️ Received response from Blender but no pending request found");
        }
        return;
      }

      if (expectedResponseId !== null && firstRequestId !== expectedResponseId) {
        if (timedOutRequests.has(expectedResponseId)) {
          console.warn(
            `⚠️ Discarding late response for timed-out request ${expectedResponseId}, processing response for request ${firstRequestId}`
          );
          expectedResponseId = firstRequestId;
        } else {
          console.warn(`⚠️ Response mismatch: expected ${expectedResponseId}, got ${firstRequestId}`);
          expectedResponseId = firstRequestId;
        }
      } else {
        expectedResponseId = firstRequestId;
      }

      if (timedOutRequests.has(expectedResponseId)) {
        console.warn(`⚠️ Discarding response for timed-out request ${expectedResponseId}`);
        timedOutRequests.delete(expectedResponseId);
        expectedResponseId = null;
        const nextId = Array.from(pendingRequests.keys())[0];
        if (nextId !== undefined) {
          expectedResponseId = nextId;
        }
        return;
      }

      const pending = pendingRequests.get(expectedResponseId);
      if (pending) {
        pendingRequests.delete(expectedResponseId);
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }

        timedOutRequests.delete(expectedResponseId);

        if (parsed.status === "error") {
          pending.reject(new Error(parsed.message || "Unknown error from Blender"));
    } else {
          pending.resolve(parsed.result || parsed);
        }

        const nextId = Array.from(pendingRequests.keys())[0];
        expectedResponseId = nextId !== undefined ? nextId : null;

        if (pending.onComplete) {
          pending.onComplete();
        }
      } else {
        console.warn(`⚠️ Expected request ${expectedResponseId} not found in pendingRequests`);
        expectedResponseId = null;
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        const firstBrace = buffer.indexOf("{");
        if (firstBrace === -1) {
          buffer = "";
    return;
  }

        if (firstBrace === 0) {
          const nextBrace = buffer.indexOf("{", 1);
          buffer = nextBrace !== -1 ? buffer.slice(nextBrace) : buffer.slice(1);
        } else {
          buffer = buffer.slice(firstBrace);
        }
        continue;
      }

      console.error("❌ Failed to parse Blender response:", err.message);
      buffer = "";

      const firstRequestId = Array.from(pendingRequests.keys())[0];
      if (firstRequestId !== undefined) {
        const pending = pendingRequests.get(firstRequestId);
        if (pending) {
          pendingRequests.delete(firstRequestId);
          if (pending.timeout) {
            clearTimeout(pending.timeout);
          }
          pending.reject(new Error(`Failed to parse response: ${err.message}`));
          if (pending.onComplete) {
            pending.onComplete();
          }
        }
      }
      return;
    }
  }
}

function processRequestQueue() {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  const { requestId, commandType, params, resolve, reject } = requestQueue.shift();

  if (!blenderClient || blenderClient.destroyed || !blenderConnected) {
    isProcessingQueue = false;
    reject(new Error("Blender socket not connected"));
    processRequestQueue();
    return;
  }

  const json = JSON.stringify({ type: commandType, params });
  console.log(`📤 [Request ${requestId}] Sending command to Blender:`, json);

  const timeout = setTimeout(() => {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      timedOutRequests.add(requestId);
      pendingRequests.delete(requestId);
      pending.reject(new Error("Timeout waiting for Blender response"));

      if (expectedResponseId === requestId) {
        const nextId = Array.from(pendingRequests.keys())[0];
        expectedResponseId = nextId !== undefined ? nextId : null;
      }

      if (pending.onComplete) {
        pending.onComplete();
      }
    }
  }, 15000);

  pendingRequests.set(requestId, {
    resolve,
    reject,
    timeout,
    onComplete: () => {
      isProcessingQueue = false;
      processRequestQueue();
    },
  });

  if (expectedResponseId === null) {
    expectedResponseId = requestId;
  }

  try {
    blenderClient.write(json);
    } catch (err) {
    pendingRequests.delete(requestId);
    if (timeout) {
      clearTimeout(timeout);
    }
    isProcessingQueue = false;
      reject(err);
    processRequestQueue();
  }
}

function sendCommandToBlender(commandType, params = {}) {
  const requestId = nextRequestId++;

  return new Promise((resolve, reject) => {
    requestQueue.push({ requestId, commandType, params, resolve, reject });

    if (!isProcessingQueue) {
      processRequestQueue();
    }
  });
}

function sanitizeBlenderCode(code) {
  code = code.replace(/bpy\.ops\.object\.delete\([^)]*use_undo\s*=\s*(True|False)[^)]*\)/g, (match) => {
    let cleaned = match.replace(/,\s*use_undo\s*=\s*(True|False)/g, "");
    cleaned = cleaned.replace(/use_undo\s*=\s*(True|False)\s*,?\s*/g, "");
    cleaned = cleaned.replace(/,\s*,/g, ",");
    cleaned = cleaned.replace(/\(\s*,/g, "(");
    cleaned = cleaned.replace(/,\s*\)/g, ")");
    return cleaned;
  });

  code = code.replace(/,\s*use_undo\s*=\s*(True|False)/g, "");
  code = code.replace(/use_undo\s*=\s*(True|False)\s*,?\s*/g, "");
  code = code.replace(/,\s*use_global\s*=\s*(True|False)/g, "");
  code = code.replace(/use_global\s*=\s*(True|False)\s*,?\s*/g, "");
  code = code.replace(/,\s*constraint_axis\s*=\s*\[[^\]]+\]/g, "");
  code = code.replace(/constraint_axis\s*=\s*\[[^\]]+\]\s*,?\s*/g, "");
  code = code.replace(/,\s*,/g, ",");
  code = code.replace(/\(\s*,/g, "(");
  code = code.replace(/,\s*\)/g, ")");

  // Fix Blender 4.5 node API: ShaderNodeTexVoronoi no longer has nested voronoi_texture.*
  // Replace `.voronoi_texture.feature` -> `.feature`, and `.voronoi_texture.distance` -> `.distance`
  code = code.replace(/(\w+)\.voronoi_texture\.feature\b/g, "$1.feature");
  code = code.replace(/(\w+)\.voronoi_texture\.distance\b/g, "$1.distance");

  // Some models also emit `.voronoi.feature` or `.voronoi.distance` (incorrect); normalize those too
  code = code.replace(/(\w+)\.voronoi\.(feature|distance)\b/g, "$1.$2");

  // Musgrave node: remove deprecated nested access like `.musgrave_texture.type = 'FBM'`
  code = code.replace(/^.*\.musgrave_texture\.type\s*=\s*['"][^'"\n]+['"].*$/gm, "");

  // Replace invalid delete-all operator with valid clearing logic
  // bpy.ops.wm.obj_delete_all() is not a real operator; use select_all + object.delete
  code = code.replace(/bpy\.ops\.wm\.obj_delete_all\(\)/g,
    "bpy.ops.object.select_all(action='SELECT')\nif bpy.data.objects:\n    bpy.ops.object.delete()");

  // Remove attempts to enable addons at runtime (often unavailable in headless/vanilla installs)
  code = code.replace(/^\s*bpy\.ops\.preferences\.addon_enable\([^)]*\)\s*$/gm, "");

  // Replace non-existent operator loopcut_and_slide with safer alternative
  // Prefer simple mesh.loopcut (works in edit mode with edge selection)
  code = code.replace(/bpy\.ops\.mesh\.loopcut_and_slide\s*\(([^)]*)\)/g, (m, inner) => {
    // Extract number_cuts if present
    const numMatch = inner.match(/number_cuts\"?\s*:?\s*(\d+)/i);
    const cuts = numMatch ? numMatch[1] : '1';
    return `bpy.ops.mesh.loopcut(number_cuts=${cuts})`;
  });

  // If code references bmesh operations, ensure we enter edit mode (best-effort)
  if (/\bbmesh\b/.test(code) && !/mode_set\(mode='EDIT'\)/.test(code)) {
    code = `# ensure edit mode for bmesh\nif bpy.context.object and bpy.context.object.mode != 'EDIT':\n    bpy.ops.object.mode_set(mode='EDIT')\n` + code;
  }

  return code;
}

async function executeBlenderCode(code) {
  return sendCommandToBlender("execute_code", { code });
}

function preflightValidateCode(code) {
  const issues = [];
  if (!/\bimport\s+bpy\b/.test(code)) {
    issues.push("Missing 'import bpy' at top of file");
  }
  if (/bpy\.ops\.preferences\.addon_enable\(/.test(code)) {
    issues.push("Avoid enabling addons at runtime; remove bpy.ops.preferences.addon_enable(..)");
  }
  if (/bpy\.ops\.wm\.obj_delete_all\(\)/.test(code)) {
    issues.push("Operator bpy.ops.wm.obj_delete_all() does not exist; use select_all + object.delete()");
  }
  if (/loopcut_and_slide\s*\(/i.test(code)) {
    issues.push("Use bpy.ops.mesh.loopcut(...) in EDIT mode or bmesh subdivide (no loopcut_and_slide)");
  }
  if (/\buse_undo\s*=/.test(code)) {
    issues.push("Deprecated flag use_undo detected; remove it for Blender 4.5");
  }
  if (/\buse_global\s*=/.test(code)) {
    issues.push("Deprecated flag use_global detected; remove it for Blender 4.5");
  }
  if (/constraint_axis\s*=\s*\[/.test(code)) {
    issues.push("Deprecated constraint_axis detected; remove it for Blender 4.5");
  }
  const pairs = [['\\(', '\\)'], ['\\[', '\\]']];
  for (const [o, c] of pairs) {
    const open = (code.match(new RegExp(o, 'g')) || []).length;
    const close = (code.match(new RegExp(c, 'g')) || []).length;
    if (open !== close) issues.push(`Unbalanced ${o} ${c}`);
  }
  return issues;
}

// Extract python code from possible markdown fences
function extractCodeFromText(text) {
  if (!text) return "";
  const match = text.match(/```(?:python|py)?\s*([\s\S]*?)```/);
  return (match ? match[1] : text.replace(/```/g, "")).trim();
}

async function callLLMForCode(promptText, preferGroqFirst = false) {
  const order = [];
  if (preferGroqFirst && groqClient) order.push("groq");
  if (genAI) order.push("gemini");
  if (groqClient && !preferGroqFirst) order.push("groq");

  for (const p of order) {
    try {
      if (p === "gemini" && genAI) {
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
        const result = await model.generateContent(promptText);
        const text = extractCodeFromText(result?.response?.text?.() || "");
        if (text) return { code: text, provider: "gemini" };
      }
      if (p === "groq" && groqClient) {
        const resp = await groqClient.chat.completions.create({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: promptText }],
          temperature: 0.2,
        });
        const text = extractCodeFromText(resp?.choices?.[0]?.message?.content || "");
        if (text) return { code: text, provider: "groq" };
      }
    } catch (err) {
      console.error(`❌ LLM (${p}) call failed:`, err.message);
    }
  }
  return { code: "", provider: "" };
}

async function tryExecuteWithRecovery({
  initialCode,
  maxAttempts = Number(process.env.LLM_REPAIR_ATTEMPTS || 2),
  preferGroq = false,
  sceneContext,
  onAttempt,
}) {
  const attempts = [];
  let code = initialCode;
  let lastHints = [];

  for (let i = 0; i <= maxAttempts; i++) {
    const sanitized = sanitizeBlenderCode(code);
    try {
      const result = await executeBlenderCode(sanitized);
      const entry = { index: i, ok: true, hints: lastHints };
      attempts.push(entry);
      try { if (onAttempt) await onAttempt(entry); } catch {}
      return { ok: true, result, code: sanitized, attempts, hints: lastHints };
    } catch (err) {
      const errorMessage = err?.message || String(err);
      // Provide targeted hints for frequent issues
      lastHints = [];
      if (/obj_delete_all/i.test(errorMessage)) {
        lastHints.push("Use bpy.ops.object.select_all(action='SELECT'); then bpy.ops.object.delete().");
      }
      if (/loopcut/i.test(errorMessage)) {
        lastHints.push("Use bpy.ops.mesh.loopcut (or bmesh edge subdivide) in EDIT mode with edges selected.");
      }
      if (/addon|add-on/i.test(errorMessage)) {
        lastHints.push("Avoid enabling addons at runtime; rely on built-in primitives only.");
      }
      if (/context.*incorrect/i.test(errorMessage)) {
        lastHints.push("Ensure an object is active, select it, and switch to correct mode before operators.");
      }

      const entry = { index: i, ok: false, error: errorMessage, hints: lastHints };
      attempts.push(entry);
      try { if (onAttempt) await onAttempt(entry); } catch {}
      if (i === maxAttempts) {
        return { ok: false, error: errorMessage, code: sanitized, attempts, hints: lastHints };
      }
      // Ask LLM to repair using error context and last code
      const repairPrompt = `You are fixing Blender 4.5 Python code. Strict rules:
1) Output ONLY runnable Blender Python (no markdown)
2) Start with: import bpy (and import bmesh only if used)
3) Use Blender 4.5 API only. NEVER use: use_undo, use_global, constraint_axis, or non-existent ops.
4) Do NOT enable addons at runtime. Use built-in primitives and nodes only.
5) Always ensure correct context for operators: active object, selection, and mode (OBJECT vs EDIT).
6) For deletion: select objects then bpy.ops.object.delete().
7) Voronoi node uses node.feature / node.distance (no node.voronoi_texture.*).
8) Loop cuts: use bpy.ops.mesh.loopcut in EDIT mode with edges selected (or bmesh subdivide edges).

ERROR:
${errorMessage}

${sceneContext ? `SCENE CONTEXT (truncated):\n${JSON.stringify(sceneContext).slice(0, 1500)}` : ""}

CURRENT CODE:
${code}

Return ONLY the fully corrected Blender Python code, ready to run now.`;

      const { code: repaired } = await callLLMForCode(repairPrompt, preferGroq);
      if (!repaired) {
        // If LLM couldn't repair, stop early
        return { ok: false, error: errorMessage, code: sanitized, attempts, hints: lastHints };
      }
      code = repaired;
    }
  }
  return { ok: false, error: "Unknown", code, attempts };
}
function connectToBlenderTCP() {
  blenderClient = new net.Socket();
  blenderConnected = false;

  blenderClient.connect(BLENDER_TCP_PORT, BLENDER_TCP_HOST, () => {
    blenderConnected = true;
    console.log("✅ Connected to Blender addon socket server");
    initializeBlenderConnection();
  });

  blenderClient.on("data", parseIncomingMessages);

  blenderClient.on("error", (err) => {
    console.error("❌ Blender TCP error:", err.message);
    blenderConnected = false;
    resetBlenderState();
    setTimeout(connectToBlenderTCP, 3000);
  });

  blenderClient.on("close", () => {
    console.log("⚠️ Blender TCP connection closed — retrying in 3s...");
    blenderConnected = false;
    resetBlenderState();
    setTimeout(connectToBlenderTCP, 3000);
  });
}

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
  const { rows } = await pool.query(
    "SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1",
    [email]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query(
    "SELECT id, email, display_name, created_at FROM users WHERE id = $1",
    [id]
  );
  return rows[0] || null;
}

async function createUser({ email, password, displayName }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at",
    [email, passwordHash, displayName || null]
  );
  return rows[0];
}

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid authorization header" });
    }

    const token = authHeader.slice(7).trim();
    const payload = jwt.verify(token, JWT_SECRET);
    const userRow = await getUserById(payload.sub);
    if (!userRow) {
      return res.status(401).json({ error: "User not found" });
    }

    req.user = toPublicUser(userRow);
    req.token = token;
    next();
  } catch (err) {
    console.error("❌ Auth error:", err.message);
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
    `INSERT INTO conversations (user_id, title)
     VALUES ($1, $2)
     RETURNING id, user_id, title, created_at, updated_at, last_scene_context`,
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

  const { rows } = await pool.query(
    `UPDATE conversations
     SET ${setters.join(", ")}
     WHERE id = $1
     RETURNING id, user_id, title, created_at, updated_at, last_scene_context`,
    params
  );

  return rows[0] ? mapConversation(rows[0]) : null;
}

async function deleteConversation(userId, conversationId) {
  const { rowCount } = await pool.query(
    "DELETE FROM conversations WHERE id = $1 AND user_id = $2",
    [conversationId, userId]
  );
  return rowCount > 0;
}

async function saveMessage(conversationId, { role, content, provider, blenderResult, sceneContext, metadata }) {
  const { rows } = await pool.query(
    `INSERT INTO messages (conversation_id, role, content, provider, blender_result, scene_context, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, conversation_id, role, content, provider, blender_result, scene_context, metadata, created_at`,
    [
      conversationId,
      role,
      content ?? null,
      provider || null,
      blenderResult || null,
      sceneContext || null,
      metadata || {},
    ]
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
    `SELECT role, content
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId]
  );
  return rows.slice(-limit);
}

function deriveTitleFromPrompt(prompt) {
  if (!prompt) return "New Scene";
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return "New Scene";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

const getSystemPrompt = (hasHistory, sceneContext) => {
  let basePrompt = `
You are an expert Blender Python script generator with deep knowledge of Blender 4.5 API and 3D modeling best practices.
Your goal is to generate accurate, production-quality Blender Python code that creates precise 3D models based on user descriptions.

CRITICAL RULES:
1. Output ONLY valid bpy Python code compatible with Blender 4.5 - NO explanations, NO markdown, NO backticks
2. Code must be executable in Blender 4.5 as-is
3. Start ALL code with: import bpy
4. Do NOT use file I/O or imports other than bpy
5. Use precise measurements, proportions, and realistic geometry
6. For complex objects, break them into logical parts (e.g., body, head, limbs for animals)
7. Use appropriate modifiers (Subdivision Surface, Array, etc.) for better results
8. Apply proper materials and colors when specified
9. Use proper naming conventions (e.g., "Object_Name" not "object1")

DEPRECATED API - NEVER USE (removed in Blender 4.0+):
- Do NOT use "use_undo" parameter in bpy.ops.object.delete() or any operator
- Do NOT use "use_global" parameter in bpy.ops.transform operations
- Do NOT use "constraint_axis" parameter in bpy.ops.transform operations
- Use modern Blender 4.5 API only

ACCURACY GUIDELINES:
- For animals/creatures: Create anatomically correct proportions, use proper body part segmentation
- For objects: Use realistic dimensions and proportions
- For scenes: Create proper spatial relationships and scale
- Always clear the scene before creating new objects (unless modifying existing ones)
- Use appropriate mesh primitives and modifiers for realistic results
- Apply smooth shading for organic objects
- Use proper rotation and positioning for objects
`;

  // Few-shot examples (small, focused, high-signal)
  const FEW_SHOT = `
EXAMPLES (Blender 4.5 canonical patterns):

# Delete all selectable objects safely
import bpy
if bpy.data.objects:
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()

# Create a UV sphere and apply material
import bpy
bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=(0,0,1))
obj = bpy.context.object
mat = bpy.data.materials.new(name="Mat_Red")
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (1,0,0,1)
if obj.data.materials:
    obj.data.materials[0] = mat
else:
    obj.data.materials.append(mat)

# Edit mode operation with loop cut
import bpy
obj = bpy.context.object
if obj and obj.type == 'MESH':
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='EDGE')
    bpy.ops.mesh.loopcut(number_cuts=1)
    bpy.ops.object.mode_set(mode='OBJECT')
`;

  if (hasHistory) {
    basePrompt += `
CONTEXT AWARENESS:
- You are continuing a conversation about a 3D scene
- Previous modifications may have been made to the scene
- When the user asks to refine or modify, update existing objects rather than recreating everything
- Maintain consistency with previous iterations
- If the user asks to change specific aspects, modify only those aspects while preserving the rest
`;
  }

  if (sceneContext && sceneContext.objects && sceneContext.objects.length > 0) {
    basePrompt += `
CURRENT SCENE CONTEXT:
- Existing objects in scene: ${sceneContext.objects.join(", ")}
- Object count: ${sceneContext.object_count}
- When modifying, preserve objects not mentioned in the request
`;
  }

  return `${basePrompt}\n\n${FEW_SHOT}`.trim();
};

// Minimal API/doc snippets to help LLM ground Blender 4.5 usage (expandable)
const API_SNIPPETS = [
  {
    key: "delete_all",
    text: "Delete all: if bpy.data.objects: bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()",
  },
  {
    key: "sphere_add",
    text: "Create UV sphere: bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=(0,0,0))",
  },
  {
    key: "material_assign",
    text: "Assign material: mat=bpy.data.materials.new(name); mat.use_nodes=True; bsdf=mat.node_tree.nodes['Principled BSDF']; if obj.data.materials: obj.data.materials[0]=mat; else: obj.data.materials.append(mat)",
  },
  {
    key: "edit_mode",
    text: "Switch modes: bpy.ops.object.mode_set(mode='OBJECT'|'EDIT')",
  },
  {
    key: "loopcut",
    text: "Loopcut in EDIT mode: bpy.ops.mesh.select_mode(type='EDGE'); bpy.ops.mesh.loopcut(number_cuts=1)",
  },
  {
    key: "camera_set",
    text: "Set camera: cam=bpy.data.cameras.new('Cam'); obj=bpy.data.objects.new('CamObj', cam); bpy.context.scene.collection.objects.link(obj); bpy.context.scene.camera = obj",
  },
];

function getRelevantDocs(promptText) {
  const lower = (promptText || "").toLowerCase();
  const picks = [];
  for (const s of API_SNIPPETS) {
    if (
      (s.key === 'delete_all' && /delete|clear|remove all/.test(lower)) ||
      (s.key === 'sphere_add' && /sphere|planet|ball/.test(lower)) ||
      (s.key === 'material_assign' && /material|shader|color/.test(lower)) ||
      (s.key === 'edit_mode' && /edit mode|bmesh|loopcut|subdivide|extrude/.test(lower)) ||
      (s.key === 'loopcut' && /loopcut|edge cut/.test(lower)) ||
      (s.key === 'camera_set' && /camera|render view|shot/.test(lower))
    ) {
      picks.push(s.text);
    }
  }
  return picks.slice(0, 5);
}

// Simple agent specialization prompt fragments
const AGENT_TIPS = {
  modeling: (
    "MODELIG AGENT:\n- Prioritize geometry creation, modifiers, proportions, clean topology\n- Keep materials minimal placeholders; focus on correct forms\n- Use edit mode operations carefully (enter/exit mode as needed)"
  ),
  materials: (
    "MATERIALS AGENT:\n- Create/assign materials, configure Principled BSDF and nodes\n- Avoid changing object transforms; only material graphs\n- Prefer node-based pipelines; keep naming consistent"
  ),
  lighting: (
    "LIGHTING AGENT:\n- Configure world, HDRIs, area/point/sun lights, exposure\n- Do not modify geometry; only lighting and render settings"
  ),
  animation: (
    "ANIMATION AGENT:\n- Add keyframes, timelines, curves, ensure linear/Bezier as required\n- Avoid editing materials unless necessary for the animation"
  ),
};

async function enhancePrompt(userPrompt, conversationHistory = []) {
  const enhancementPrompt = `
You are a prompt enhancement assistant for 3D Blender scene generation.
Your task is to refine and expand user prompts to be more specific, detailed, and actionable for generating accurate 3D models.

IMPORTANT: Return ONLY the enhanced prompt, no explanations, no markdown, no code blocks.

User's original prompt: "${userPrompt}"

${conversationHistory.length > 0 ? `
Conversation context:
${conversationHistory
  .slice(-3)
  .map((msg, i) => `${i + 1}. ${msg.role}: ${msg.content}`)
  .join("\n")}
` : ""}

Enhancement guidelines:
1. Add specific details about proportions, scale, and dimensions
2. Specify material properties (shiny, matte, metallic, etc.) when relevant
3. Add anatomical details for living creatures (realistic proportions, proper body part segmentation)
4. Specify positioning and spatial relationships for scenes
5. Add color and texture details when mentioned or implied
6. Specify level of detail (simple/low-poly vs detailed/high-poly)
7. Maintain the user's intent while adding technical precision

Enhanced prompt:`;

  try {
    if (genAI) {
      const geminiModel = genAI.getGenerativeModel({ model: GEMINI_MODEL });
      const result = await geminiModel.generateContent(enhancementPrompt);
      const enhanced = (result?.response?.text?.() || "").trim();
      return enhanced || userPrompt;
    }

    if (groqClient) {
      const groqResponse = await groqClient.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: enhancementPrompt }],
        temperature: 0.3,
      });
      const enhanced = (groqResponse?.choices?.[0]?.message?.content || "").trim();
      return enhanced || userPrompt;
    }
  } catch (error) {
    console.error("❌ Prompt enhancement failed:", error.message);
  }

  return userPrompt;
}

app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password, displayName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const normalizedEmail = normalizeEmail(email);
    const existing = await findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const userRow = await createUser({
      email: normalizedEmail,
      password,
      displayName: displayName ? displayName.trim() : null,
    });

    const token = signToken(userRow);
    res.json({ token, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("❌ Signup error:", err.message);
    res.status(500).json({ error: "Failed to create account" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const normalizedEmail = normalizeEmail(email);
    const userRow = await findUserByEmail(normalizedEmail);
    if (!userRow) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordMatches = await bcrypt.compare(password, userRow.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(userRow);
    res.json({ token, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("❌ Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/auth/me", authenticate, async (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/conversations", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const conversations = await listUserConversations(req.user.id);
    res.json({ conversations });
  } catch (err) {
    console.error("❌ Fetch conversations error:", err.message);
    res.status(500).json({ error: "Failed to load conversations" });
  }
});

app.post("/api/conversation/new", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { title } = req.body || {};
    const conversation = await createConversation(req.user.id, title);
    res.json({ conversation });
  } catch (err) {
    console.error("❌ Create conversation error:", err.message);
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

app.get("/api/conversation/:conversationId", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { conversationId } = req.params;
    const conversation = await getConversationForUser(req.user.id, conversationId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const messages = await getConversationMessages(conversationId);
    res.json({ conversation, messages });
  } catch (err) {
    console.error("❌ Get conversation error:", err.message);
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

app.delete("/api/conversation/:conversationId", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { conversationId } = req.params;
    const deleted = await deleteConversation(req.user.id, conversationId);
    if (!deleted) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Delete conversation error:", err.message);
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

app.post("/api/enhance-prompt", authenticate, async (req, res) => {
  try {
    const { prompt, conversationId } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: "Prompt required" });
    }

    let history = [];
    if (conversationId) {
      const conversation = await getConversationForUser(req.user.id, conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      history = await getMessagesForHistory(conversationId, 6);
    }

    const enhanced = await enhancePrompt(prompt, history);
    res.json({ enhanced, original: prompt });
  } catch (err) {
    console.error("❌ Enhance prompt error:", err.message);
    res.status(500).json({ error: "Prompt enhancement failed" });
  }
});

// Record user feedback on a specific assistant message (thumbs up/down)
app.post("/api/feedback", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { conversationId, messageId, rating } = req.body || {};
    if (!conversationId || !messageId || !['up','down'].includes((rating||'').toLowerCase())) {
      return res.status(400).json({ error: "conversationId, messageId and rating ('up'|'down') required" });
    }
    // Append feedback to message metadata
    const messages = await getConversationMessages(conversationId);
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return res.status(404).json({ error: "Message not found" });
    const meta = msg.metadata || {};
    const fb = Array.isArray(meta.feedback) ? meta.feedback : [];
    fb.push({ userId: req.user.id, rating: rating.toLowerCase(), at: Date.now() });
    await pool.query(
      `UPDATE messages SET metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{feedback}', $1::jsonb, true) WHERE id=$2`,
      [JSON.stringify(fb), messageId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Feedback error:", err.message);
    res.status(500).json({ error: "Failed to record feedback" });
  }
});

app.post("/api/scene-info", authenticate, async (req, res) => {
  // Rate limit
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const { conversationId } = req.body || {};

    if (!blenderClient || !blenderConnected) {
      return res.status(503).json({ error: "Blender not connected" });
    }

    const sceneInfo = await sendCommandToBlender("get_scene_info", {});

    if (conversationId) {
      const conversation = await getConversationForUser(req.user.id, conversationId);
      if (conversation) {
        await touchConversation(conversation.id, { sceneContext: sceneInfo });
      }
    }

    res.json(sceneInfo);
  } catch (err) {
    console.error("❌ Scene info error:", err.message);
    res.status(500).json({ error: "Failed to get scene info" });
  }
});

// Analytics summary (since server start)
app.get("/api/analytics/summary", authenticate, async (req, res) => {
  const avgAttempts = analytics.totalGenerations ? analytics.totalAttempts / analytics.totalGenerations : 0;
  const avgDurationMs = analytics.totalGenerations ? analytics.totalDurationMs / analytics.totalGenerations : 0;
  res.json({
    windowMs: RATE_LIMIT_WINDOW_MS,
    totalGenerations: analytics.totalGenerations,
    success: analytics.success,
    errors: analytics.errors,
    avgAttempts,
    avgDurationMs,
  });
});

// Suggest prompt autocompletions
app.get("/api/suggest", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const prefix = String(req.query.prefix || '').toLowerCase();
    const suggestions = [];
    // API snippets by keyword
    for (const s of API_SNIPPETS) {
      if (s.text.toLowerCase().includes(prefix)) suggestions.push(s.text);
    }
    // Recent conversation prompts tail
    const convs = await listUserConversations(req.user.id);
    for (const c of convs.slice(0, 5)) {
      const msgs = await getConversationMessages(c.id);
      for (const m of msgs.slice(-5)) {
        if (m.role === 'user' && m.content && m.content.toLowerCase().includes(prefix)) {
          suggestions.push(m.content);
        }
      }
    }
    // Deduplicate and cap
    const uniq = Array.from(new Set(suggestions)).slice(0, 10);
    res.json({ suggestions: uniq });
  } catch (err) {
    res.status(500).json({ error: 'Suggest failed', details: err.message });
  }
});

// Streaming generation via Server-Sent Events (SSE)
app.get("/api/generate/stream", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  function send(type, data) {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  (async () => {
    try {
      const q = req.query || {};
      const prompt = String(q.prompt || "");
      const conversationId = q.conversationId ? String(q.conversationId) : undefined;
      const shouldEnhance = String(q.enhancePrompt || "false").toLowerCase() === 'true';
      const model = q.model ? String(q.model) : undefined;
      const captureScreenshot = String(q.captureScreenshot || "false").toLowerCase() === 'true';

      if (!prompt.trim()) { send('error', { error: 'Prompt required' }); return res.end(); }
      send('status', { stage: 'init' });

      let conversation;
      if (conversationId) {
        conversation = await getConversationForUser(req.user.id, conversationId);
        if (!conversation) { send('error', { error: 'Conversation not found' }); return res.end(); }
      } else {
        conversation = await createConversation(req.user.id, deriveTitleFromPrompt(prompt));
      }

      const history = await getMessagesForHistory(conversation.id, 10);
      let sceneContext = conversation.lastSceneContext || null;
      if (blenderClient && blenderConnected) {
        try { sceneContext = await sendCommandToBlender('get_scene_info', {}); } catch {}
      }

      const nonSystemHistory = history.filter((m)=> m.role !== 'system');
      const finalPrompt = shouldEnhance ? (await enhancePrompt(prompt, nonSystemHistory)) : prompt;
      await saveMessage(conversation.id, { role: 'user', content: finalPrompt });

      const historyWithCurrent = [...nonSystemHistory, { role:'user', content: finalPrompt }];
      const systemPrompt = getSystemPrompt(historyWithCurrent.length > 1, sceneContext);
      const conversationContext = historyWithCurrent.slice(-6).map((m)=> `${m.role==='user'?'User':'Assistant'}: ${m.content}`).join('\n\n');
      const docSnippets = getRelevantDocs(finalPrompt);
      const base = historyWithCurrent.length>1 ? `${systemPrompt}\n\nConversation history:\n${conversationContext}\n\nCurrent user request: ${finalPrompt}` : `${systemPrompt}\n\nUser request: ${finalPrompt}`;
      const fullPrompt = docSnippets.length ? `${base}\n\nHelpful API snippets:\n${docSnippets.map((t,i)=>`${i+1}. ${t}`).join('\n')}` : base;
      send('status', { stage:'prompt_ready' });

      let providerUsed = '';
      let code = '';
      const cacheKey = cacheKeyFromPrompt(fullPrompt);
      const cached = cacheGet(cacheKey);
      if (cached?.code) { code = cached.code; providerUsed = cached.provider || ''; send('cache', { hit:true, provider: providerUsed }); }
      else {
        send('cache', { hit:false });
        const order = [];
        const rm = typeof model === 'string' ? model.toLowerCase() : '';
        const preferGroq = rm.includes('llama') || rm.includes('groq');
        if (preferGroq && groqClient) order.push('groq');
        if (genAI) order.push('gemini');
        if (groqClient && !preferGroq) order.push('groq');
        for (const p of order) {
          try {
            if (p==='gemini' && genAI) {
              const m = genAI.getGenerativeModel({ model: GEMINI_MODEL });
              const r = await m.generateContent(fullPrompt);
              code = (r?.response?.text?.() || '').trim();
              if (code) { providerUsed='gemini'; break; }
            }
            if (p==='groq' && groqClient) {
              const r = await groqClient.chat.completions.create({ model: GROQ_MODEL, messages:[{ role:'user', content: fullPrompt }], temperature: 0.2 });
              code = (r?.choices?.[0]?.message?.content || '').trim();
              if (code) { providerUsed='groq'; break; }
            }
          } catch (e) { send('model_error', { provider: p, message: e.message }); }
        }
        cacheSet(cacheKey, { code, provider: providerUsed });
      }

      if (!code) { send('error', { error:'No model output' }); return res.end(); }
      code = extractCodeFromText(code);
      if (!code.includes('import bpy')) code = `import bpy\n${code}`;
      code = sanitizeBlenderCode(code);
      send('preflight', { issues: preflightValidateCode(code) });

      const onAttempt = async (a)=> send('attempt', a);
      send('status', { stage:'executing' });
      const recovery = await tryExecuteWithRecovery({ initialCode: code, maxAttempts: Number(process.env.LLM_REPAIR_ATTEMPTS||2), preferGroq: providerUsed==='groq', sceneContext, onAttempt });
      if (!recovery.ok) { send('final', { ok:false, error: recovery.error, attempts: recovery.attempts||[] }); return res.end(); }

      let screenshot = null;
      if (captureScreenshot && blenderClient && blenderConnected) {
        try { const img = await sendCommandToBlender('get_viewport_screenshot', { max_size: 800 }); screenshot = img?.data || img?.image || img || null; } catch {}
      }

      await saveMessage(conversation.id, { role:'assistant', content: recovery.code, provider: providerUsed, blenderResult: recovery.result, sceneContext, metadata:{ attempts: recovery.attempts||[] } });
      send('final', { ok:true, provider: providerUsed, attempts: recovery.attempts||[], screenshot });
      return res.end();
    } catch (err) {
      send('error', { error: err.message });
      return res.end();
    }
  })();
});

// Checkpoint current scene to a temporary .blend file (safe save)
app.post("/api/checkpoint", authenticate, async (req, res) => {
  // Rate limit
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    if (!blenderClient || !blenderConnected) {
      return res.status(503).json({ error: "Blender not connected" });
    }
    const ts = Date.now();
    const tmpPath = require('path').join(require('os').tmpdir(), `cursor4d_${ts}.blend`);
    const code = `import bpy\n\n# Save current scene to temporary file\ntry:\n    bpy.ops.wm.save_mainfile(filepath=r"${tmpPath}")\n    print('Saved to ${tmpPath}')\nexcept Exception as e:\n    raise Exception(f"Checkpoint failed: {str(e)}")`;
    const result = await executeBlenderCode(code);
    res.json({ status: "ok", path: tmpPath, result });
  } catch (err) {
    res.status(500).json({ error: "Checkpoint failed", details: err.message });
  }
});

// Submit background generation job
app.post("/api/jobs/submit", authenticate, async (req, res) => {
  const rl = checkRateLimit(req.user.id);
  if (!rl.ok) {
    res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
  }
  try {
    const payload = req.body || {};
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const job = { id, userId: req.user.id, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), payload };
    enqueueJob(job);
    res.json({ jobId: id, status: job.status });
  } catch (err) {
    res.status(500).json({ error: 'Job submit failed', details: err.message });
  }
});

// Get job status/result
app.get("/api/jobs/:id/status", authenticate, async (req, res) => {
  try {
    const id = String(req.params.id);
    const job = jobs.get(id);
    if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Job not found' });
    res.json({ id: job.id, status: job.status, result: job.result, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt });
  } catch (err) {
    res.status(500).json({ error: 'Job status failed', details: err.message });
  }
});

app.post("/api/generate", authenticate, async (req, res) => {
  try {
    // Rate limit per user
    const rl = checkRateLimit(req.user.id);
    if (!rl.ok) {
      res.set('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: rl.retryAfterMs });
    }

    const startedAt = Date.now();
    const { prompt, conversationId, enhancePrompt: shouldEnhance, attachments = [], model, dryRun = false, captureScreenshot = false, debug = false, abTest = false, visualRefine = false, agentType } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Prompt required" });
    }

    let conversation;
    if (conversationId) {
      conversation = await getConversationForUser(req.user.id, conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
    } else {
      conversation = await createConversation(req.user.id, deriveTitleFromPrompt(prompt));
    }

    const history = await getMessagesForHistory(conversation.id, 10);

    let sceneContext = conversation.lastSceneContext || null;
    if (blenderClient && blenderConnected) {
      try {
        sceneContext = await sendCommandToBlender("get_scene_info", {});
      } catch (err) {
        console.warn("⚠️ Could not get scene info:", err.message);
      }
    }

    const nonSystemHistory = history.filter((msg) => msg.role !== "system");
    let finalPrompt = prompt;
    if (shouldEnhance) {
      finalPrompt = await enhancePrompt(prompt, nonSystemHistory);
    }

    const sanitizedAttachments = (attachments || []).map(({ id, name, type, size }) => ({
      id,
      name,
      type,
      size,
    }));

    await saveMessage(conversation.id, {
      role: "user",
      content: finalPrompt,
      metadata: {
        originalPrompt: prompt,
        enhancedPrompt: shouldEnhance ? finalPrompt : null,
        attachments: sanitizedAttachments,
      },
    });

    const historyWithCurrent = [...nonSystemHistory, { role: "user", content: finalPrompt }];
    let systemPrompt = getSystemPrompt(historyWithCurrent.length > 1, sceneContext);
    if (agentType && AGENT_TIPS[String(agentType).toLowerCase()]) {
      systemPrompt = `${systemPrompt}\n\n${AGENT_TIPS[String(agentType).toLowerCase()]}`;
    }
    const docSnippets = getRelevantDocs(finalPrompt);
    const conversationContext = historyWithCurrent
      .slice(-6)
      .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
      .join("\n\n");

    const fullPromptBase = historyWithCurrent.length > 1
      ? `${systemPrompt}\n\nConversation history:\n${conversationContext}\n\nCurrent user request: ${finalPrompt}`
      : `${systemPrompt}\n\nUser request: ${finalPrompt}`;
    const fullPrompt = docSnippets.length
      ? `${fullPromptBase}\n\nHelpful API snippets:\n${docSnippets.map((t,i)=>`${i+1}. ${t}`).join('\n')}`
      : fullPromptBase;

    // Code-gen cache (skip cache for dryRun and abTest)
    let cacheHit = false;
    let cacheKey = !dryRun && !abTest ? cacheKeyFromPrompt(fullPrompt) : null;
    if (cacheKey) {
      const cached = cacheGet(cacheKey);
      if (cached?.code) {
        code = cached.code;
        providerUsed = cached.provider || providerUsed;
        cacheHit = true;
      }
    }

    const requestedModel = typeof model === "string" ? model.toLowerCase() : "";
    const preferGroq = requestedModel.includes("llama") || requestedModel.includes("groq");

    const attemptOrder = [];
    if (preferGroq && groqClient) attemptOrder.push("groq");
    if (genAI) attemptOrder.push("gemini");
    if (groqClient && !preferGroq) attemptOrder.push("groq");

    let code = "";
    let providerUsed = "";

    for (const provider of attemptOrder) {
      if (cacheHit) break;
      if (provider === "gemini" && genAI) {
      try {
        const geminiModel = genAI.getGenerativeModel({ model: GEMINI_MODEL });
          const result = await geminiModel.generateContent(fullPrompt);
  code = (result?.response?.text?.() || "").trim();
          if (code) {
        providerUsed = "gemini";
            break;
          }
        } catch (err) {
          console.error("❌ Gemini generation failed:", err.message);
        }
      }

      if (provider === "groq" && groqClient) {
        try {
          const groqResponse = await groqClient.chat.completions.create({
          model: GROQ_MODEL,
            messages: [{ role: "user", content: fullPrompt }],
            temperature: 0.2,
          });
          const groqText = (groqResponse?.choices?.[0]?.message?.content || "").trim();
          if (groqText) {
  code = groqText;
            providerUsed = "groq";
            break;
          }
        } catch (err) {
          console.error("❌ Groq generation failed:", err.message);
        }
      }
    }

    if (!cacheHit && cacheKey && code) {
      cacheSet(cacheKey, { code, provider: providerUsed });
    }

    // Optional A/B testing: produce two variants without executing; caller evaluates
    if (abTest) {
      const altOrder = [...attemptOrder].reverse();
      let altCode = ""; let altProvider = "";
      for (const provider of altOrder) {
        try {
          if (provider === 'gemini' && genAI) {
            const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
            const result = await model.generateContent(fullPrompt);
            altCode = (result?.response?.text?.() || '').trim();
            if (altCode) { altProvider = 'gemini'; break; }
          }
          if (provider === 'groq' && groqClient) {
            const resp = await groqClient.chat.completions.create({ model: GROQ_MODEL, messages: [{ role:'user', content: fullPrompt }], temperature: 0.2 });
            altCode = (resp?.choices?.[0]?.message?.content || '').trim();
            if (altCode) { altProvider = 'groq'; break; }
          }
        } catch {}
      }
      const v1 = extractCodeFromText(code);
      const v2 = extractCodeFromText(altCode);
      analytics.totalGenerations += 1;
      return res.json({ mode: 'ab', variants: [
        { provider: providerUsed, code: sanitizeBlenderCode(v1), preflightIssues: preflightValidateCode(sanitizeBlenderCode(v1)) },
        { provider: altProvider, code: sanitizeBlenderCode(v2), preflightIssues: preflightValidateCode(sanitizeBlenderCode(v2)) },
      ], docSnippets, conversationId: conversation.id });
    }

    if (!code) {
      return res.status(503).json({
        error: "No model output",
        details: "Neither Gemini nor Groq returned Blender code.",
      });
    }

    const codeBlockMatch = code.match(/```(?:python|py)?\s*([\s\S]*?)```/);
    code = codeBlockMatch ? codeBlockMatch[1].trim() : code.replace(/```/g, "").trim();

    if (!code.includes("import bpy")) {
      console.warn("⚠️ Code missing 'import bpy' — adding it");
      code = `import bpy\n${code}`;
    }

    code = sanitizeBlenderCode(code);

    const preflightIssues = preflightValidateCode(code);
    if (dryRun) {
      const critiquePrompt = `You are reviewing Blender 4.5 Python code. Briefly list issues and propose concrete fixes. Return a short bullet list of suggestions, no code fences.\n\nCODE:\n${code}`;
      let critique = "";
      try {
        const { code: reviewText } = await callLLMForCode(critiquePrompt, false);
        critique = reviewText;
      } catch {}
      return res.json({
        mode: "dry_run",
        preflightIssues,
        critique,
        sanitizedCode: code,
        provider: providerUsed || (genAI ? "gemini" : groqClient ? "groq" : "unknown"),
        conversationId: conversation.id,
      });
    }

    let blenderResult = null;
    let attempts = [];
    if (blenderClient && blenderConnected) {
      try {
        console.log("🚀 Executing code in Blender (with auto-repair)...");
        const preferGroq = providerUsed === "groq";
        const recovery = await tryExecuteWithRecovery({
          initialCode: code,
          maxAttempts: Number(process.env.LLM_REPAIR_ATTEMPTS || 2),
          preferGroq,
          sceneContext,
        });
        attempts = recovery.attempts || [];
        if (recovery.ok) {
          blenderResult = recovery.result;
          code = recovery.code; // final executed code (possibly repaired)
          console.log("✅ Code executed successfully in Blender after attempts:", attempts.length);
        } else {
          throw new Error(recovery.error || "Execution failed");
        }
      } catch (toolError) {
        console.error("❌ Blender execution error:", toolError.message || toolError);
        blenderResult = {
          error: toolError.message || toolError.toString(),
          status: "error",
        };
      }
    } else {
      console.warn("⚠️ Blender not connected — code will not be executed");
      blenderResult = {
        error: "Blender addon is not connected. Please make sure Blender is running with the addon enabled.",
        status: "error",
      };
    }

    await saveMessage(conversation.id, {
      role: "assistant",
      content: code,
      provider: providerUsed || (genAI ? "gemini" : groqClient ? "groq" : "unknown"),
      blenderResult,
      sceneContext,
      metadata: {
        enhancedPrompt: shouldEnhance ? finalPrompt : null,
        attachments: sanitizedAttachments,
        model: providerUsed || null,
        attempts,
        preflightIssues,
      },
    });

    const updatedConversation = await touchConversation(conversation.id, {
      sceneContext,
      title:
        conversation.title === "New Scene" || !conversation.title
          ? deriveTitleFromPrompt(prompt)
          : undefined,
    });

    const messages = await getConversationMessages(conversation.id);

    // Optional viewport screenshot on success
    let screenshot = null;
    if (captureScreenshot && blenderResult && !blenderResult.error && blenderClient && blenderConnected) {
      try {
        const img = await sendCommandToBlender("get_viewport_screenshot", { max_size: 800 });
        screenshot = img?.data || img?.image || img || null;
      } catch (err) {
        console.warn("⚠️ Screenshot failed:", err.message);
      }
    }

    // Optional visual refinement pass using screenshot (Gemini only). Limited to 1 refinement attempt.
    let visualRefinement = undefined;
    if (visualRefine && blenderResult && !blenderResult.error && blenderClient && blenderConnected && genAI) {
      try {
        // Ensure we have a screenshot to review
        if (!screenshot) {
          try {
            const img = await sendCommandToBlender("get_viewport_screenshot", { max_size: 800 });
            screenshot = img?.data || img?.image || img || null;
          } catch (err) {
            console.warn("⚠️ Screenshot for visual refinement failed:", err.message);
          }
        }

        if (screenshot) {
          const base64 = typeof screenshot === 'string' ? screenshot : Buffer.from(screenshot).toString('base64');
          const critiqueText = `You are reviewing the Blender viewport image against the user request. 1) Briefly state if the image matches the request. 2) If not perfect, output ONLY Blender Python code to refine the scene (no markdown).`;
          const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
          const visionResp = await model.generateContent([
            { text: `USER REQUEST: ${finalPrompt}\n${shouldEnhance ? `(enhanced) ${finalPrompt}` : ''}` },
            { text: critiqueText },
            { inlineData: { data: base64, mimeType: 'image/png' } },
          ]);
          const visionOut = (visionResp?.response?.text?.() || '').trim();
          const refinedCode = extractCodeFromText(visionOut);
          visualRefinement = { critique: visionOut.slice(0, 1200), applied: false };
          if (refinedCode && /import\s+bpy/.test(refinedCode)) {
            const recovery = await tryExecuteWithRecovery({
              initialCode: refinedCode,
              maxAttempts: 1,
              preferGroq: providerUsed === 'groq',
              sceneContext,
            });
            attempts = attempts.concat(recovery.attempts || []);
            if (recovery.ok) {
              code = `${code}\n\n# --- Visual refinement applied ---\n${recovery.code}`;
              visualRefinement.applied = true;
            }
          }
        }
      } catch (err) {
        console.warn("⚠️ Visual refinement skipped:", err.message);
      }
    }

    analytics.totalGenerations += 1;
    const ok = blenderResult && !blenderResult.error;
    if (ok) analytics.success += 1; else analytics.errors += 1;
    analytics.totalAttempts += (attempts?.length || 0);
    analytics.totalDurationMs += (Date.now() - startedAt);

    res.json({
      response: code,
      blenderResult,
      provider: providerUsed || (genAI ? "gemini" : groqClient ? "groq" : "unknown"),
      conversationId: conversation.id,
      conversationTitle: updatedConversation?.title || conversation.title,
      enhancedPrompt: shouldEnhance ? finalPrompt : null,
      sceneContext,
      messages,
      attempts,
      preflightIssues,
      screenshot,
      visualRefinement,
      debugArtifacts: debug ? { fullPrompt, systemPrompt, docSnippets } : undefined,
    });
  } catch (err) {
    analytics.totalGenerations += 1; analytics.errors += 1;
    console.error("❌ GENERATION ERROR:", err);
    res.status(500).json({ error: "Model generation failed", details: err.message });
  }
});

async function startServer() {
  try {
    await initSchema();
    connectToBlenderTCP();
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
  } catch (err) {
    console.error("❌ Failed to start backend:", err.message);
    process.exit(1);
  }
}

startServer();

