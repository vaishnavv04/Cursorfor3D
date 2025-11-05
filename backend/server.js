import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import net from "net";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); // Increase limit for image data

const PORT = 5000;
const BLENDER_TCP_PORT = 9876;
const BLENDER_TCP_HOST = "127.0.0.1";

// ✅ Conversation history storage (in-memory for now, could be moved to DB)
const conversations = new Map(); // Map<conversationId, {messages: [], sceneContext: {}}>

// ✅ Gemini setup with Groq fallback
const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;
const groqClient = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const GEMINI_MODEL = "gemini-2.5-flash";
const GROQ_MODEL = "llama3-70b-8192";

// ✅ TCP client to connect to Blender addon socket server
let blenderClient = null;
let blenderConnected = false;
let buffer = "";
let nextRequestId = 1;
const pendingRequests = new Map(); // Map<requestId, {resolve, reject, timeout, onComplete}>
let requestQueue = []; // Queue to serialize requests if needed
let isProcessingQueue = false;
let expectedResponseId = null; // Track which request ID we're expecting a response for (FIFO order)
const timedOutRequests = new Set(); // Track request IDs that have timed out to discard late responses

function resetBlenderState() {
  buffer = "";
  // Reject all pending requests that are already sent
  for (const [id, { reject, timeout }] of pendingRequests.entries()) {
    if (timeout) clearTimeout(timeout);
    reject(new Error("Blender connection reset"));
  }
  pendingRequests.clear();
  
  // Reject all queued requests that haven't been sent yet
  for (const { reject } of requestQueue) {
    reject(new Error("Blender connection reset"));
  }
  requestQueue = [];
  isProcessingQueue = false;
  expectedResponseId = null;
  timedOutRequests.clear();
}

function initializeBlenderConnection() {
  // Clear buffer and reset state, but DON'T reject queued requests
  // This is called when connection is established, and we want to process queued requests
  buffer = "";
  // Clear any pending requests from previous connection attempts
  for (const [id, { timeout }] of pendingRequests.entries()) {
    if (timeout) clearTimeout(timeout);
  }
  pendingRequests.clear();
  isProcessingQueue = false;
  expectedResponseId = null;
  timedOutRequests.clear();
  
  // Process any queued requests now that connection is established
  if (requestQueue.length > 0) {
    console.log(`📋 Processing ${requestQueue.length} queued request(s) after connection established`);
    processRequestQueue();
  }
}

function parseIncomingMessages(chunk) {
  buffer += chunk.toString("utf8");

  // Try to parse complete JSON responses
  // The Blender addon sends simple JSON responses
  let previousBufferLength = -1;
  while (buffer.length > 0) {
    // Track buffer length to detect infinite loops
    const currentBufferLength = buffer.length;
    if (currentBufferLength === previousBufferLength) {
      // Buffer hasn't changed - we're stuck in a loop
      // Skip the first character to make progress
      console.warn("⚠️ Detected potential infinite loop, skipping first character");
      buffer = buffer.slice(1);
      previousBufferLength = -1; // Reset to allow new attempts
      continue;
    }
    previousBufferLength = currentBufferLength;

    try {
      // Try to find a complete JSON object by counting braces
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
        
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (char === '"') {
          inString = !inString;
          continue;
        }
        
        if (!inString) {
          if (char === '{') {
            if (jsonStart === -1) jsonStart = i;
            braceCount++;
          } else if (char === '}') {
            braceCount--;
            if (braceCount === 0 && jsonStart !== -1) {
              jsonEnd = i + 1;
              break;
            }
          }
        }
      }

      if (jsonEnd === -1) {
        // Incomplete JSON, wait for more data
        return;
      }

      const jsonStr = buffer.slice(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonStr);
      
      console.log("📥 Response from Blender:", JSON.stringify(parsed));
      
      // Remove parsed JSON from buffer
      buffer = buffer.slice(jsonEnd).trim();
      previousBufferLength = -1; // Reset after successful parse
      
      // Blender responses don't include request IDs, so we use FIFO matching
      // Match response to the expected request ID (first in pendingRequests)
      // But check if it's for a timed-out request and discard if so
      const firstRequestId = Array.from(pendingRequests.keys())[0];
      
      if (firstRequestId === undefined) {
        // No pending requests - this might be a late response for a timed-out request
        if (expectedResponseId !== null && timedOutRequests.has(expectedResponseId)) {
          console.warn(`⚠️ Discarding late response for timed-out request ${expectedResponseId}`);
          expectedResponseId = null;
    } else {
          console.warn("⚠️ Received response from Blender but no pending request found");
    }
    return;
  }

      // Check if this response is for the expected request
      if (expectedResponseId !== null && firstRequestId !== expectedResponseId) {
        // Response doesn't match expected ID - might be a late response
        // Check if expectedResponseId timed out
        if (timedOutRequests.has(expectedResponseId)) {
          console.warn(`⚠️ Discarding late response for timed-out request ${expectedResponseId}, processing response for request ${firstRequestId}`);
          // Update expectedResponseId to current first request
          expectedResponseId = firstRequestId;
        } else {
          // This shouldn't happen in normal FIFO flow, but handle it
          console.warn(`⚠️ Response mismatch: expected ${expectedResponseId}, got ${firstRequestId}`);
          expectedResponseId = firstRequestId;
        }
      } else {
        // Normal case: response matches expected
        expectedResponseId = firstRequestId;
      }
      
      // If this response is for a timed-out request, discard it
      if (timedOutRequests.has(expectedResponseId)) {
        console.warn(`⚠️ Discarding response for timed-out request ${expectedResponseId}`);
        // Remove from timed-out set and update expectedResponseId
        timedOutRequests.delete(expectedResponseId);
        expectedResponseId = null;
        // Process next request if available
        const nextRequestId = Array.from(pendingRequests.keys())[0];
        if (nextRequestId !== undefined) {
          expectedResponseId = nextRequestId;
        }
        return;
      }
      
      const pending = pendingRequests.get(expectedResponseId);
      if (pending) {
        pendingRequests.delete(expectedResponseId);
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        
        // Remove from timed-out set if it was there (shouldn't be, but safety check)
        timedOutRequests.delete(expectedResponseId);
        
        if (parsed.status === "error") {
          pending.reject(new Error(parsed.message || "Unknown error from Blender"));
        } else {
          pending.resolve(parsed.result || parsed);
        }
        
        // Update expectedResponseId to next pending request
        const nextRequestId = Array.from(pendingRequests.keys())[0];
        expectedResponseId = nextRequestId !== undefined ? nextRequestId : null;
        
        // Process next item in queue (if callback exists)
        if (pending.onComplete) {
          pending.onComplete();
        }
      } else {
        console.warn(`⚠️ Expected request ${expectedResponseId} not found in pendingRequests`);
        expectedResponseId = null;
      }
    } catch (err) {
      // If we can't parse JSON, it might be incomplete or invalid
      if (err instanceof SyntaxError) {
        // Check if we have at least one opening brace
        const firstBrace = buffer.indexOf('{');
        if (firstBrace === -1) {
          // No JSON object found, clear buffer
          buffer = "";
          return;
        }
        
        // Try skipping to the first brace
        // But if firstBrace is 0, we need to skip at least 1 character to make progress
        if (firstBrace === 0) {
          // Already at the brace, but JSON is invalid - skip past it
          const nextBrace = buffer.indexOf('{', 1);
          if (nextBrace !== -1) {
            buffer = buffer.slice(nextBrace);
          } else {
            // No more braces, skip the first character to make progress
            buffer = buffer.slice(1);
          }
        } else {
          buffer = buffer.slice(firstBrace);
        }
        continue;
      }
      console.error("❌ Failed to parse Blender response:", err.message);
      // Clear buffer on error
      buffer = "";
      
      // Reject the first pending request if any
      const firstRequestId = Array.from(pendingRequests.keys())[0];
      if (firstRequestId !== undefined) {
        const pending = pendingRequests.get(firstRequestId);
        if (pending) {
          pendingRequests.delete(firstRequestId);
          if (pending.timeout) {
            clearTimeout(pending.timeout);
          }
          pending.reject(new Error(`Failed to parse response: ${err.message}`));
          
          // Process next item in queue (if callback exists)
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
    processRequestQueue(); // Process next item
    return;
  }

  const command = {
    type: commandType,
    params: params
  };

  const json = JSON.stringify(command);
  console.log(`📤 [Request ${requestId}] Sending command to Blender:`, json);

  // Set timeout for response (15 seconds like the MCP server)
  const timeout = setTimeout(() => {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      // Mark this request as timed out to discard late responses
      timedOutRequests.add(requestId);
      pendingRequests.delete(requestId);
      pending.reject(new Error("Timeout waiting for Blender response"));
      
      // If this was the expected response, update to next pending request
      if (expectedResponseId === requestId) {
        const nextRequestId = Array.from(pendingRequests.keys())[0];
        expectedResponseId = nextRequestId !== undefined ? nextRequestId : null;
      }
      
      // Process next item in queue (if callback exists)
      if (pending.onComplete) {
        pending.onComplete();
      }
    }
  }, 15000);

  // Store the pending request with a callback to process next item
  pendingRequests.set(requestId, { 
    resolve, 
    reject, 
    timeout,
    onComplete: () => {
      // Response handler will call processRequestQueue() after resolving
      isProcessingQueue = false;
      processRequestQueue();
    }
  });
  
  // Set expectedResponseId if this is the first pending request
  if (expectedResponseId === null) {
    expectedResponseId = requestId;
  }

  try {
    blenderClient.write(json);
    // Keep isProcessingQueue = true until response arrives
    // The response handler will set it to false and process next item
  } catch (err) {
    // Clean up on send error
    pendingRequests.delete(requestId);
    if (timeout) {
      clearTimeout(timeout);
    }
    isProcessingQueue = false;
    reject(err);
    processRequestQueue(); // Process next item
  }
}

function sendCommandToBlender(commandType, params = {}) {
  const requestId = nextRequestId++;
  
  return new Promise((resolve, reject) => {
    // Add to queue
    requestQueue.push({ requestId, commandType, params, resolve, reject });
    
    // Process queue if not already processing
    if (!isProcessingQueue) {
      processRequestQueue();
    }
  });
}

function sanitizeBlenderCode(code) {
  // Remove deprecated use_undo parameter (removed in Blender 4.0+)
  // Handle cases like: bpy.ops.object.delete(use_undo=True) or bpy.ops.object.delete(use_undo=False)
  // Also handle: bpy.ops.object.delete(use_undo=True, confirm=False)
  code = code.replace(/bpy\.ops\.object\.delete\([^)]*use_undo\s*=\s*(True|False)[^)]*\)/g, (match) => {
    // Remove use_undo parameter
    let cleaned = match.replace(/,\s*use_undo\s*=\s*(True|False)/g, '');
    cleaned = cleaned.replace(/use_undo\s*=\s*(True|False)\s*,?\s*/g, '');
    // Clean up any double commas or trailing commas
    cleaned = cleaned.replace(/,\s*,/g, ',');
    cleaned = cleaned.replace(/\(\s*,/g, '(');
    cleaned = cleaned.replace(/,\s*\)/g, ')');
    return cleaned;
  });

  // Remove use_undo from any other operator call (more general pattern)
  code = code.replace(/,\s*use_undo\s*=\s*(True|False)/g, '');
  code = code.replace(/use_undo\s*=\s*(True|False)\s*,?\s*/g, '');

  // Remove other deprecated parameters
  code = code.replace(/,\s*use_global\s*=\s*(True|False)/g, '');
  code = code.replace(/use_global\s*=\s*(True|False)\s*,?\s*/g, '');
  code = code.replace(/,\s*constraint_axis\s*=\s*\[[^\]]+\]/g, '');
  code = code.replace(/constraint_axis\s*=\s*\[[^\]]+\]\s*,?\s*/g, '');

  // Clean up any double commas or malformed parentheses
  code = code.replace(/,\s*,/g, ',');
  code = code.replace(/\(\s*,/g, '(');
  code = code.replace(/,\s*\)/g, ')');

  return code;
}

async function executeBlenderCode(code) {
  return sendCommandToBlender("execute_code", { code });
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
    setTimeout(connectToBlenderTCP, 3000); // auto retry
  });

  blenderClient.on("close", () => {
    console.log("⚠️ Blender TCP connection closed — retrying in 3s...");
    blenderConnected = false;
    resetBlenderState();
    setTimeout(connectToBlenderTCP, 3000);
  });
}

connectToBlenderTCP();

// ✅ Enhanced system prompt for better accuracy
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

  if (hasHistory) {
    basePrompt += `
CONTEXT AWARENESS:
- You are continuing a conversation about a 3D scene
- Previous modifications may have been made to the scene
- When user asks to refine or modify, update existing objects rather than recreating everything
- Maintain consistency with previous iterations
- If user asks to change specific aspects, modify only those aspects while preserving the rest
`;
  }

  if (sceneContext && sceneContext.objects && sceneContext.objects.length > 0) {
    basePrompt += `
CURRENT SCENE CONTEXT:
- Existing objects in scene: ${sceneContext.objects.join(', ')}
- Object count: ${sceneContext.object_count}
- When modifying, preserve objects not mentioned in the request
`;
  }

  return basePrompt.trim();
};

// ✅ Prompt enhancement function
async function enhancePrompt(userPrompt, conversationHistory = []) {
  const enhancementPrompt = `
You are a prompt enhancement assistant for 3D Blender scene generation.
Your task is to refine and expand user prompts to be more specific, detailed, and actionable for generating accurate 3D models.

IMPORTANT: Return ONLY the enhanced prompt, no explanations, no markdown, no code blocks.

User's original prompt: "${userPrompt}"

${conversationHistory.length > 0 ? `
Conversation context:
${conversationHistory.slice(-3).map((msg, i) => `${i + 1}. ${msg.role}: ${msg.content}`).join('\n')}
` : ''}

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
    } else if (groqClient) {
      const groqResponse = await groqClient.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "user",
            content: enhancementPrompt
          }
        ],
        temperature: 0.3
      });
      const enhanced = (groqResponse?.choices?.[0]?.message?.content || "").trim();
      return enhanced || userPrompt;
    }
  } catch (error) {
    console.error("❌ Prompt enhancement failed:", error.message);
  }
  
  return userPrompt; // Fallback to original if enhancement fails
}

// ✅ Route to enhance prompt
app.post("/api/enhance-prompt", async (req, res) => {
  const { prompt, conversationId } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  try {
    const conversation = conversationId ? conversations.get(conversationId) : null;
    const history = conversation ? conversation.messages.filter(m => m.role !== 'system') : [];
    const enhanced = await enhancePrompt(prompt, history);
    res.json({ enhanced, original: prompt });
  } catch (error) {
    console.error("❌ Enhancement error:", error);
    res.status(500).json({ error: "Prompt enhancement failed", details: error.message });
  }
});

// ✅ Route to get scene info
app.post("/api/scene-info", async (req, res) => {
  const { conversationId } = req.body;
  
  try {
    if (!blenderClient || !blenderConnected) {
      return res.status(503).json({ error: "Blender not connected" });
    }

    const sceneInfo = await sendCommandToBlender("get_scene_info", {});
    res.json(sceneInfo);
  } catch (error) {
    console.error("❌ Scene info error:", error);
    res.status(500).json({ error: "Failed to get scene info", details: error.message });
  }
});

// ✅ Route to generate Blender script via Gemini (with conversation support)
app.post("/api/generate", async (req, res) => {
  const { prompt, conversationId, image, enhancePrompt: shouldEnhance } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  // Initialize or get conversation
  const convId = conversationId || `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  if (!conversations.has(convId)) {
    conversations.set(convId, {
      messages: [],
      sceneContext: null,
      createdAt: new Date()
    });
  }
  const conversation = conversations.get(convId);

  try {
    // Get current scene info for context
    let sceneContext = null;
    if (blenderClient && blenderConnected) {
      try {
        sceneContext = await sendCommandToBlender("get_scene_info", {});
        conversation.sceneContext = sceneContext;
      } catch (err) {
        console.warn("⚠️ Could not get scene info:", err.message);
      }
    }

    // Enhance prompt if requested
    let finalPrompt = prompt;
    if (shouldEnhance) {
      finalPrompt = await enhancePrompt(prompt, conversation.messages);
    }

    // Add user message to history
    conversation.messages.push({
      role: 'user',
      content: finalPrompt,
      timestamp: new Date()
    });

    // Build conversation context for LLM
    const systemPrompt = getSystemPrompt(conversation.messages.length > 1, conversation.sceneContext);
    const conversationContext = conversation.messages
      .slice(-5) // Last 5 messages for context
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');

    const fullPrompt = conversation.messages.length > 1
      ? `${systemPrompt}\n\nConversation history:\n${conversationContext}\n\nCurrent user request: ${finalPrompt}`
      : `${systemPrompt}\n\nUser request: ${finalPrompt}`;

    // Generate code with conversation context
    let code = "";
    let providerUsed = "";

    if (genAI) {
      try {
        const geminiModel = genAI.getGenerativeModel({ model: GEMINI_MODEL });
        const result = await geminiModel.generateContent(fullPrompt);
        code = (result?.response?.text?.() || "").trim();
        providerUsed = "gemini";
      } catch (geminiError) {
        console.error("❌ Gemini primary call failed, attempting Groq fallback:", geminiError.message);
      }
    }

    if ((!code || code.length === 0) && groqClient) {
      try {
        const groqResponse = await groqClient.chat.completions.create({
          model: GROQ_MODEL,
          messages: [
            {
              role: "user",
              content: fullPrompt
            }
          ],
          temperature: 0.2
        });

        const groqText = (groqResponse?.choices?.[0]?.message?.content || "").trim();
        code = groqText;
        providerUsed = groqText ? "groq" : providerUsed;
      } catch (groqError) {
        console.error("❌ Groq fallback failed:", groqError.message);
      }
    }

    if (!code) {
      return res.status(503).json({
        error: "No model output",
        details: "Neither Gemini nor Groq returned Blender code."
      });
    }

    // ✅ Extract code from markdown code fences if present
    const codeBlockMatch = code.match(/```(?:python|py)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      code = codeBlockMatch[1].trim();
    } else {
      // Remove any remaining code fences as fallback
      code = code.replace(/```/g, "").trim();
    }

    if (!providerUsed) {
      providerUsed = genAI ? "gemini" : groqClient ? "groq" : "unknown";
    }

    // Ensure code starts with import bpy if it doesn't already
    if (!code.includes("import bpy")) {
      console.warn("⚠️ Code missing 'import bpy' — adding it");
      code = "import bpy\n" + code;
    }

    // Sanitize code: Remove deprecated Blender 4.0+ API calls
    code = sanitizeBlenderCode(code);

    let blenderResult = null;
    if (blenderClient && blenderConnected) {
      try {
        console.log("🚀 Executing code in Blender...");
        blenderResult = await executeBlenderCode(code);
        console.log("✅ Code executed successfully in Blender");
      } catch (toolError) {
        console.error("❌ Blender execution error:", toolError);
        blenderResult = { 
          error: toolError.message || toolError.toString(),
          status: "error"
        };
      }
    } else {
      console.warn("⚠️ Blender not connected — code will not be executed");
      blenderResult = { 
        error: "Blender addon is not connected. Please make sure Blender is running with the addon enabled.",
        status: "error"
      };
    }

    // Add assistant response to conversation history
    conversation.messages.push({
      role: 'assistant',
      content: code,
      timestamp: new Date(),
      blenderResult
    });

    // Return to frontend with conversation ID
    res.json({
      response: code,
      blenderResult,
      provider: providerUsed,
      conversationId: convId,
      enhancedPrompt: shouldEnhance ? finalPrompt : null,
      sceneContext
    });

  } catch (error) {
    console.error("❌ GENERATION ERROR:", {
      message: error.message,
      code: error.code,
      response: error?.response,
      stack: error.stack
    });

    res.status(500).json({ error: "Model generation failed", details: error.message });
  }
});

// ✅ Route to get conversation history
app.get("/api/conversation/:conversationId", (req, res) => {
  const { conversationId } = req.params;
  const conversation = conversations.get(conversationId);
  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  res.json(conversation);
});

// ✅ Route to create new conversation
app.post("/api/conversation/new", (req, res) => {
  const convId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  conversations.set(convId, {
    messages: [],
    sceneContext: null,
    createdAt: new Date()
  });
  res.json({ conversationId: convId });
});

// ✅ Route to delete conversation
app.delete("/api/conversation/:conversationId", (req, res) => {
  const { conversationId } = req.params;
  if (conversations.delete(conversationId)) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Conversation not found" });
  }
});

// ✅ Start backend server
app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});

