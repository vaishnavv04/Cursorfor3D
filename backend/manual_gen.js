/*
 * manual_gen.js
 *
 * A standalone script to demonstrate the "manual" procedural generation flow:
 * 1. Connect to Blender TCP server.
 * 2. Get the current scene info from Blender.
 * 3. Call Gemini to get 'bpy' code for *creating* a model from a prompt.
 * 4. Execute the creation code in Blender.
 *
 * To Run:
 * 1. Ensure .env file is set with GEMINI_API_KEY, BLENDER_TCP_PORT, BLENDER_TCP_HOST.
 * 2. Run: `npm install dotenv @google/generative-ai`
 * 3. Run: `node manual_gen.js`
 */

import net from 'net';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

// --- Configuration ---
// This is the prompt the AI will use to procedurally generate the object
const USER_PROMPT = "a short flight of 5 stairs";
const PORT = parseInt(process.env.BLENDER_TCP_PORT || "9876", 10);
const HOST = process.env.BLENDER_TCP_HOST || "127.0.0.1";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";

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
        
        // Give 'execute_code' a longer timeout
        const timeoutMs = commandType === 'execute_code' ? 30000 : 5000;

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

API WARNINGS:
- PRINCIPLED BSDF: The 'Specular' (0-1 float) input is DEPRECATED.
- To set material color, use: bsdf.inputs["Base Color"].default_value = (R, G, B, A)
- To set roughness, use: bsdf.inputs["Roughness"].default_value = (value)
- Do NOT try to set bsdf.inputs["Specular"].default_value as a 0-1 float.
- Do NOT use any \`bpy.ops.view3d.*\` operators (like \`view_selected\`). They fail in scripts.

CURRENT SCENE CONTEXT:
- Existing objects: ${sceneContext.objects.map(o => o.name).join(", ") || 'None'}
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
        console.log(`\n--- 🚀 Starting Manual Generation ---`);
        console.log(`Prompt: "${USER_PROMPT}"`);
        
        // 1. Get Scene Context
        console.log('\n[Step 1/3] Getting scene context from Blender...');
        const sceneContext = await sendCommand('get_scene_info');
        console.log(`   -> Scene has ${sceneContext.object_count} objects.`);

        // 2. Call Gemini for Creation Code
        console.log('\n[Step 2/3] Generating creation code with Gemini...');
        
        // Construct the full prompt for *creation*
        const systemPrompt = getSystemPrompt(sceneContext);
        const fullPrompt = `${systemPrompt}\n\nUser request:\n${USER_PROMPT}`;

        let { code } = await callLLMForCode(fullPrompt);
        code = sanitizeBlenderCode(code);

        if (!code || code.trim().length === 0) {
            throw new Error("Gemini returned empty code.");
        }

        console.log('   -> Gemini Code (Sanitized):\n', code);

        // 3. Execute Creation Code
        console.log('\n[Step 3/3] Executing creation code in Blender...');
        const execResult = await sendCommand('execute_code', { code });
        console.log('   -> Execution successful.');

        console.log('\n--- ✅ Generation Complete! ---');
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