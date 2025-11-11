/*
 * check_integrations.js
 *
 * A standalone utility script to check the status of Blender addon integrations.
 *
 * This script will:
 * 1. Read your .env file for BLENDER_TCP_PORT and BLENDER_TCP_HOST.
 * 2. Connect to the Blender TCP server.
 * 3. Send commands:
 * - get_polyhaven_status
 * - get_hyper3d_status
 * - get_sketchfab_status
 * 4. Print the JSON response for each command.
 * 5. Disconnect and exit.
 *
 * To run:
 * 1. Make sure Blender is running with the addon enabled and connected.
 * 2. Run from your terminal: `node check_integrations.js`
 *
 * Dependencies:
 * - "dotenv": "npm install dotenv"
 * (Uses built-in 'net' module)
 */

import net from 'net';
import dotenv from 'dotenv';

dotenv.config();

const PORT = parseInt(process.env.BLENDER_TCP_PORT || "9876", 10);
const HOST = process.env.BLENDER_TCP_HOST || "127.0.0.1";

const client = new net.Socket();
let buffer = '';
let pendingRequest = null; // { resolve, reject, timeout }

/**
 * Simplified JSON message parser.
 * This re-uses the brace-counting logic from server.js to find a
 * complete JSON object in the TCP stream.
 */
function parseBuffer() {
    if (!pendingRequest) {
        // If we aren't waiting for a response, don't bother parsing.
        // This can happen if a late/stray message arrives.
        // For this simple script, we'll just clear the buffer.
        if (buffer.length > 1000) { // Safety clear
            buffer = "";
        }
        return;
    }
    
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
            // Not a full message yet, wait for more data
            return;
        }

        const jsonStr = buffer.slice(jsonStart, jsonEnd);
        const parsed = JSON.parse(jsonStr);
        
        // Message is processed, clear it from the buffer
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
        
        // Check if there's another full message in the buffer
        if (buffer.length > 0) {
            parseBuffer();
        }

    } catch (err) {
        if (err instanceof SyntaxError) {
            // Incomplete JSON, just wait for more data
            return;
        }
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
    if (pendingRequest) {
        pendingRequest.reject(err);
    }
    process.exit(1);
});

client.on('close', () => {
    console.log('🔌 Connection closed.');
});

/**
 * Sends a single command and waits for a single response.
 * @param {string} commandType - The 'type' of command for the addon
 * @param {object} params - The 'params' object for the command
 * @returns {Promise<object>} - Resolves with the 'result' from Blender
 */
function sendCommand(commandType, params = {}) {
    return new Promise((resolve, reject) => {
        if (pendingRequest) {
            return reject(new Error('Another request is already pending.'));
        }

        const timeout = setTimeout(() => {
            pendingRequest = null;
            reject(new Error(`Timeout: No response for ${commandType} after 5 seconds.`));
        }, 5000);

        pendingRequest = { resolve, reject, timeout };

        const json = JSON.stringify({ type: commandType, params });
        console.log(`\n📤 Sending: ${json}`);
        client.write(json);
    });
}

/**
 * Main function to run all checks in sequence.
 */
async function runChecks() {
    try {
        console.log('--- 🛡️  Checking Blender Integrations ---');

        const polyStatus = await sendCommand('get_polyhaven_status');
        console.log('✅ PolyHaven Status:', polyStatus);

        const hyperStatus = await sendCommand('get_hyper3d_status');
        console.log('✅ Hyper3D Status:', hyperStatus);

        const sketchfabStatus = await sendCommand('get_sketchfab_status');
        console.log('✅ Sketchfab Status:', sketchfabStatus);

        console.log('\n--- All checks complete ---');

    } catch (err) {
        console.error('\n❌ Check Failed:', err.message);
    } finally {
        client.end(); // Close the connection
        process.exit(0);
    }
}

// --- Start the script ---
client.connect(PORT, HOST, () => {
    console.log(`🚀 Connected to Blender on ${HOST}:${PORT}`);
    runChecks();
});