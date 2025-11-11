/*
 * generate_from_hyper3d.js
 *
 * A standalone script to demonstrate the full orchestration flow:
 * 1. Connect to Blender TCP server.
 * 2. Trigger Hyper3D generation via a TCP command.
 * 3. Poll for the job to complete.
 * 4. Import the asset via a TCP command.
 * 5. Call Gemini to get 'bpy' code for *refining* the new asset.
 * 6. Execute the refinement code in Blender.
 *
 * To Run:
 * 1. Ensure .env file is set with GEMINI_API_KEY, BLENDER_TCP_PORT, BLENDER_TCP_HOST.
 * 2. Run: `npm install dotenv @google/generative-ai`
 * 3. Run: `node generate_from_hyper3d.js`
 */

import net from 'net';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

// --- Configuration ---
const USER_PROMPT = "a realistic dragon"; // The hardcoded prompt
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
        
        const timeoutMs = commandType.startsWith('create_rodin_job') ? 30000 : 5000;

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
 * Polls for Hyper3D job completion
 * FIXED: Now uses 'subscriptionKey' and parses 'status_list'
 */
async function pollHyper3DJob(subscriptionKey) {
    const POLL_INTERVAL_MS = 5000;
    const JOB_TIMEOUT_MS = 180000; // 3 minutes
    const startTime = Date.now();

    console.log(`   -> Polling job (sub key: ${subscriptionKey}) every ${POLL_INTERVAL_MS / 1000}s...`);

    while (Date.now() - startTime < JOB_TIMEOUT_MS) {
        const statusRes = await sendCommand("poll_rodin_job_status", { subscription_key: subscriptionKey });
        
        if (statusRes.status_list) {
            // ******************************************************
            // THE FIX IS HERE:
            // The status is 'Done', not 'succeeded'.
            // ******************************************************
            if (statusRes.status_list.every(s => s === 'Done')) { 
                console.log("   -> Job succeeded.");
                return; // Success, just return
            }
            
            if (statusRes.status_list.some(s => s === 'failed')) {
                throw new Error("Hyper3D job failed (one or more tasks failed)");
            }
            
            console.log(`   -> Job status: [${statusRes.status_list.join(', ')}]...`);
        } else {
             // Fallback for fal.ai or other modes
            if (statusRes.status === 'succeeded') {
                console.log("   -> Job succeeded.");
                return; // Success
            }
            if (statusRes.status === 'failed') {
                 throw new Error(statusRes.error || "Hyper3D job failed");
            }
            console.log(`   -> Job status: ${statusRes.status}...`);
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error("Hyper3D job timed out after 3 minutes");
}

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
        console.log(`\n--- 🚀 Starting Hyper3D Generation ---`);
        console.log(`Prompt: "${USER_PROMPT}"`);
        
        // 1. Check Hyper3D Status
        console.log('\n[Step 1/6] Checking Hyper3D status...');
        const status = await sendCommand('get_hyper3d_status');
        if (!status.enabled) {
            throw new Error('Hyper3D integration is not enabled in the Blender addon.');
        }
        console.log(`   -> Hyper3D is ENABLED. (${status.message})`);

        // 2. Trigger Hyper3D Generation
        console.log('\n[Step 2/6] Requesting model from Hyper3D...');
        
        const job = await sendCommand('create_rodin_job', { text_prompt: USER_PROMPT });
        
        // Get 'subscription_key' from inside 'jobs'
        const subscriptionKey = job.jobs?.subscription_key;
        // Get 'task_uuid' from the top-level 'uuid'
        const taskUuid = job.uuid;

        // Check the new variables
        if (!subscriptionKey || !taskUuid) {
            throw new Error(`Addon did not return 'jobs.subscription_key' or 'uuid'. Response: ${JSON.stringify(job)}`);
        }
        console.log(`   -> Job submitted: (Task UUID: ${taskUuid}, Sub Key: ${subscriptionKey})`);

        // 3. Poll for Job Completion
        console.log('\n[Step 3/6] Polling for Hyper3D job completion...');
        
        await pollHyper3DJob(subscriptionKey); // Pass the correct variable
        // pollHyper3DJob will throw an error if it fails or times out

        // 4. Import Asset
        console.log('\n[Step 4/6] Importing asset into Blender...');
        
        const importResult = await sendCommand('import_generated_asset', { 
            task_uuid: taskUuid, 
            name: USER_PROMPT 
        });

        if (!importResult.succeed || !importResult.name) {
            throw new Error(`Failed to import asset: ${importResult.error || JSON.stringify(importResult)}`);
        }

        const newObjectName = importResult.name;
        console.log(`   -> Successfully imported as: "${newObjectName}"`);

        // 5. Call Gemini for Refinement Code
        console.log('\n[Step 5/6] Generating refinement code with Gemini...');
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

        // 6. Execute Refinement Code
        console.log('\n[Step 6/6] Executing refinement code in Blender...');
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