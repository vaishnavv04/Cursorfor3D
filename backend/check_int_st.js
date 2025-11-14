/*
 * check_integrations.js
 *
 * A complete standalone utility script to check the status of all Blender addon integrations.
 * This script connects directly to the Blender TCP server and calls each
 * status command individually.
 *
 * To Run:
 * 1. Make sure Blender is running with the addon enabled and connected.
 * 2. Run from your terminal: `node check_integrations.js`
 *
 * Dependencies:
 * - "dotenv": (npm install dotenv)
 * (Uses built-in 'net' module)
 */

import net from 'net';
import dotenv from 'dotenv';

dotenv.config();

// --- Configuration ---
const PORT = parseInt(process.env.BLENDER_TCP_PORT || "9876", 10);
const HOST = process.env.BLENDER_TCP_HOST || "127.0.0.1";

// --- Blender TCP Connection Logic ---
const client = new net.Socket();
let buffer = '';
let pendingRequest = null; // { resolve, reject, timeout }
let blenderConnected = false;

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
    if (pendingRequest) {
        pendingRequest.reject(err);
    }
    process.exit(1);
});

client.on('close', () => {
    console.log('🔌 Connection closed.');
    blenderConnected = false;
});

/**
 * Sends a single command and waits for a single response.
 */
function sendCommand(commandType, params = {}) {
    return new Promise((resolve, reject) => {
        if (pendingRequest) {
            return reject(new Error('Another request is already pending.'));
        }
        
        // Give status checks a 30s timeout, as Sketchfab auth can be slow
        const timeoutMs = 30000; 

        const timeout = setTimeout(() => {
            pendingRequest = null;
            reject(new Error(`Timeout: No response for ${commandType} after ${timeoutMs / 1000}s.`));
        }, timeoutMs);

        pendingRequest = { resolve, reject, timeout };

        const json = JSON.stringify({ type: commandType, params });
        console.log(`\n📤 Sending: ${JSON.stringify({ type: commandType, params })}`);
        client.write(json);
    });
}

/**
 * Promise-based connection function
 */
function connectToBlender() {
  return new Promise((resolve, reject) => {
    console.log(`Connecting to Blender at ${HOST}:${PORT}...`);
    client.connect(PORT, HOST, () => {
      blenderConnected = true;
      console.log("✅ Blender connected.");
      resolve();
    });

    // Handle connection errors
    client.once('error', (err) => {
      if (!blenderConnected) {
        reject(err);
      }
    });
  });
}

/**
 * Main function to run all checks in sequence.
 */
async function runChecks() {
    try {
        console.log('--- 🛡️  Checking Blender Integrations ---');

        // 1. Check PolyHaven
        try {
            const polyStatus = await sendCommand('get_polyhaven_status', {});
            console.log('✅ PolyHaven Status:', polyStatus);
        } catch (e) {
            console.error('❌ PolyHaven Check Failed:', e.message);
        }

        // 2. Check Hyper3D
        try {
            const hyperStatus = await sendCommand('get_hyper3d_status', {});
            console.log('✅ Hyper3D Status:', hyperStatus);
        } catch (e) {
            console.error('❌ Hyper3D Check Failed:', e.message);
        }
        
        // 3. Check Sketchfab
        try {
            const sketchfabStatus = await sendCommand('get_sketchfab_status', {});
            console.log('✅ Sketchfab Status:', sketchfabStatus);
        } catch (e) {
            console.error('❌ Sketchfab Check Failed:', e.message);
        }

        console.log('\n--- All checks complete ---');

    } catch (err) {
        console.error('\n❌ Check Run Failed:', err.message);
    } finally {
        client.end(); // Close the connection
    }
}

/**
 * Main bootstrap function
 */
async function main() {
  try {
    await connectToBlender();
    await runChecks();
  } catch (err) {
    console.error(`\n❌ Fatal Error: ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
        console.error('💡 Is Blender running? Is the addon enabled and "Connected to MCP server"?');
    }
    process.exit(1);
  }
}

// --- Start the script ---
main();