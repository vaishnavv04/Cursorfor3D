/*
 * generate_from_sketchfab.js
 *
 * A standalone script to demonstrate the full orchestration flow for Sketchfab:
 * 1. Connect to Blender TCP server.
 * 2. Check Sketchfab status.
 * 3. Search for a model by query.
 * 4. Download and import the first available model by its UID.
 * 5. Call Gemini to get 'bpy' code for *refining* the new asset.
 * 6. Execute the refinement code in Blender.
 *
 * To Run:
 * 1. Ensure .env file is set with GEMINI_API_KEY, BLENDER_TCP_PORT, BLENDER_TCP_HOST.
 * 2. Run: `npm install dotenv @google/generative-ai`
 * 3. Run: `node generate_from_sketchfab.js`
 */

import net from 'net';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

// --- Configuration ---
const USER_PROMPT = "a realistic dragon"; // The search query for Sketchfab
const PORT = parseInt(process.env.BLENDER_TCP_PORT || "9876", 10);
const HOST = process.env.BLENDER_TCP_HOST || "127.0.0.1";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash"; // Switched to gemini-pro as requested

if (!GEMINI_API_KEY) {
    console.error("❌ ERROR: GEMINI_API_KEY not found in .env file.");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// --- Blender TCP Connection Logic ---
const client = new net.Socket();
let buffer = '';
let pendingRequest = null; // { resolve, reject, timeout }

/**
 * Simplified JSON message parser
 */
function parseBuffer() {
    if (!pendingRequest) {
        if (buffer.length > 2048) buffer = ""; // Safety clear
        return;
    }
    
    try {
        let braceCount = 0;
        let jsonStart = -1, jsonEnd = -1, inString = false, escapeNext = false;

        for (let i = 0; i < buffer.length; i++) {
            const char = buffer[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === "\\") { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (inString) continue;

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

        if (jsonEnd === -1) return; // Not a full message yet

        const jsonStr = buffer.slice(jsonStart, jsonEnd);
        const parsed = JSON.parse(jsonStr);
        buffer = buffer.slice(jsonEnd).trim();

        if (pendingRequest) {
            clearTimeout(pendingRequest.timeout);
            if (parsed.status === 'error') {
                pendingRequest.reject(new Error(parsed.message || 'Unknown Blender error'));
            } else {
                pendingRequest.resolve(parsed.result || parsed);
            }
            pendingRequest = null;
        }
        
        if (buffer.length > 0) parseBuffer(); // Check for another message

    } catch (err) {
        console.error("❌ Parse Error:", err.message);
        buffer = ""; // Clear a bad buffer
        if (pendingRequest) {
            pendingRequest.reject(err);
            pendingRequest = null;
        }
    }
}

client.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    parseBuffer();
});

client.on('error', (err) => {
    console.error('❌ Connection Error:', err.message);
    if (err.code === 'ECONNREFUSED') {
        console.error('💡 Is Blender running? Is the addon enabled and connected?');
    }
    if (pendingRequest) pendingRequest.reject(err);
    process.exit(1);
});

client.on('close', () => {
    console.log('🔌 Connection closed.');
});

/**
 * Sends a single command and waits for a single response.
 */
function sendCommand(commandType, params = {}) {
    return new Promise((resolve, reject) => {
        if (pendingRequest) {
            return reject(new Error('Another request is already pending.'));
        }
        
        // Give download commands a longer timeout
        const timeoutMs = commandType.startsWith('download_') ? 60000 : 15000; // 60s for download, 15s for others

        const timeout = setTimeout(() => {
            pendingRequest = null;
            reject(new Error(`Timeout: No response for ${commandType} after ${timeoutMs / 1000}s.`));
        }, timeoutMs);

        pendingRequest = { resolve, reject, timeout };

        const json = JSON.stringify({ type: commandType, params });
        console.log(`📤 Sending: ${JSON.stringify({ type: commandType, params })}`);
        client.write(json);
    });
}

// --- Helper Functions from server.js ---

/**
 * Extracts Python code from LLM response
 */
function extractCodeFromText(text) {
    if (!text) return "";
    const match = text.match(/```(?:python|py)?\s*([\sS]*?)```/);
    return (match ? match[1] : text.replace(/```/g, "")).trim();
}

/**
 * Calls Gemini for code generation
 */
async function callLLMForCode(promptText) {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(promptText);
    const text = extractCodeFromText(result?.response?.text?.() || "");
    return { code: text, provider: "gemini" };
}

/**
 * Gets a simplified system prompt
 */
const getSystemPrompt = (sceneContext) => {
  let basePrompt = `
You are an expert Blender Python script generator (Blender 4.5 API).
Your goal is to generate accurate, production-quality Blender Python code.
CRITICAL RULES:
1. Output ONLY valid bpy Python code. NO explanations, NO markdown.
2. Start ALL code with: import bpy
3. Do NOT use deprecated APIs: use_undo, use_global, constraint_axis.
4. Do NOT try to enable addons.
5. For deleting: if bpy.data.objects: bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()

CURRENT SCENE CONTEXT:
- Existing objects: ${sceneContext.objects.join(", ") || 'None'}
- Object count: ${sceneContext.object_count}`;
  return basePrompt.trim();
};

/**
 * Sanitizes generated code (simplified from server.js)
 */
function sanitizeBlenderCode(code) {
    if (!/\bimport\s+bpy\b/.test(code)) {
        code = "import bpy\n" + code;
    }
    code = code.replace(/,\s*use_undo\s*=\s*(True|False)/g, "");
    code = code.replace(/use_undo\s*=\s*(True|False)\s*,?\s*/g, "");
    code = code.replace(/,\s*use_global\s*=\s*(True|False)/g, "");
    code = code.replace(/use_global\s*=\s*(True|False)\s*,?\s*/g, "");
    code = code.replace(/bpy\.ops\.wm\.obj_delete_all\(\)/g,
        "if bpy.data.objects:\n    bpy.ops.object.select_all(action='SELECT')\n    bpy.ops.object.delete()");
    code = code.replace(/^\s*bpy\.ops\.preferences\.addon_enable\([^)]*\)\s*$/gm, "");
    return code;
}

// --- Main Orchestration Function ---

async function runGeneration() {
    try {
        console.log(`\n--- 🚀 Starting Sketchfab Generation ---`);
        console.log(`Prompt: "${USER_PROMPT}"`);
        
        // 1. Check Sketchfab Status
        console.log('\n[Step 1/5] Checking Sketchfab status...');
        const status = await sendCommand('get_sketchfab_status');
        if (!status.enabled) {
            throw new Error('Sketchfab integration is not enabled or API key is invalid.');
        }
        console.log(`   -> Sketchfab is ENABLED. (${status.message})`);

        // 2. Search for Model
        console.log('\n[Step 2/5] Searching Sketchfab for models...');
        const searchResult = await sendCommand('search_sketchfab_models', { query: USER_PROMPT });

        const firstHit = searchResult.results?.[0];
        if (!firstHit || !firstHit.uid) {
            throw new Error(`No downloadable models found on Sketchfab for query: "${USER_PROMPT}"`);
        }
        const modelUid = firstHit.uid;
        console.log(`   -> Found model: "${firstHit.name}" (UID: ${modelUid})`);

        // 3. Download and Import Model
        console.log('\n[Step 3/5] Downloading and importing model from Sketchfab...');
        const importResult = await sendCommand('download_sketchfab_model', { uid: modelUid });

        if (!importResult.success || !importResult.imported_objects || importResult.imported_objects.length === 0) {
            throw new Error(`Failed to import Sketchfab model: ${importResult.error || 'No objects were imported'}`);
        }
        
        // Get the primary imported object (often the first one)
        const newObjectName = importResult.imported_objects[0];
        console.log(`   -> Successfully imported as: "${newObjectName}"`);

        // 4. Call Gemini for Refinement Code
        console.log('\n[Step 4/5] Generating refinement code with Gemini...');
        const sceneContext = await sendCommand('get_scene_info');
        
        const refinementPrompt = `A new object named "${newObjectName}" was just imported.
Generate Python code to:
1. Clear any existing object selection.
2. Select the object named "${newObjectName}" by name.
3. Make it the active object.
4. Scale the object uniformly so its largest dimension is 2.0 meters.
5. Move the object so its center is at (0, 0, 1.0), placing it 1m above the grid floor.`;

        const systemPrompt = getSystemPrompt(sceneContext);
        const fullPrompt = `${systemPrompt}\n\nUser request:\n${refinementPrompt}`;

        let { code } = await callLLMForCode(fullPrompt);
        code = sanitizeBlenderCode(code);
        console.log('   -> Gemini Code (Sanitized):\n', code);

        // 5. Execute Refinement Code
        console.log('\n[Step 5/5] Executing refinement code in Blender...');
        const execResult = await sendCommand('execute_code', { code });
        console.log('   -> Execution successful.');

        console.log('\n--- ✅ Generation Complete! ---');
        console.log(`   Model: "${newObjectName}"`);
        console.log('   Blender Result:', execResult);

    } catch (err) {
        console.error('\n--- ❌ Generation Failed ---');
        console.error('Error:', err.message);
    } finally {
        client.end(); // Close the connection
    }
}

// --- Start the script ---
client.connect(PORT, HOST, () => {
    console.log(`🚀 Connected to Blender MCP on ${HOST}:${PORT}`);
    runGeneration();
});