/*
 * check_integration.js
 *
 * "Dumb" module for checking integration status.
 * Exports a function that receives 'sendCommand' from the main integration index.
 * Retains its standalone functionality for debugging.
 */

import net from 'net';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Checks the status of all three integrations by calling their
 * respective status commands sequentially.
 * @param {Function} sendCommand - The 'sendCommand' function from the core module.
 * @param {boolean} verbose - Whether to print status messages to console.
 * @returns {Promise<object>} - Resolves with all integration statuses.
 */
export async function checkAllIntegrations(sendCommand, verbose = true) {
  try {
    if (verbose) console.log('--- 🛡️  Checking Blender Integrations ---');

    let polyhaven = false, hyper3d = false, sketchfab = false;
    let polyStatus, hyperStatus, sketchStatus;

    // Check PolyHaven
    try {
      polyStatus = await sendCommand('get_polyhaven_status', {});
      polyhaven = polyStatus?.enabled === true;
      if (verbose) console.log('✅ PolyHaven Status:', polyStatus);
    } catch (e) {
      if (verbose) console.error('❌ PolyHaven Check Failed:', e.message);
    }

    // Check Hyper3D
    try {
      hyperStatus = await sendCommand('get_hyper3d_status', {});
      hyper3d = hyperStatus?.enabled === true;
      if (verbose) console.log('✅ Hyper3D Status:', hyperStatus);
    } catch (e) {
      if (verbose) console.error('❌ Hyper3D Check Failed:', e.message);
    }
    
    // Check Sketchfab
    try {
      sketchStatus = await sendCommand('get_sketchfab_status', {});
      sketchfab = sketchStatus?.enabled === true;
      if (verbose) console.log('✅ Sketchfab Status:', sketchStatus);
    } catch (e) {
      if (verbose) console.error('❌ Sketchfab Check Failed:', e.message);
    }

    if (verbose) console.log('\n--- All checks complete ---');

    // Return combined status object
    return {
      polyhaven,
      hyper3d,
      sketchfab,
      detail: {
        polyhaven: polyStatus || { enabled: false, message: "Check failed" },
        hyper3d: hyperStatus || { enabled: false, message: "Check failed" },
        sketchfab: sketchStatus || { enabled: false, message: "Check failed" }
      }
    };
  } catch (err) {
    if (verbose) console.error('\n❌ Check Run Failed:', err.message);
    throw err;
  }
}


// --- STANDALONE SCRIPT LOGIC ---
// The following code only runs if this file is executed directly
// (e.g., `node integrations/check_integration.js`)
// It is a copy of the connection logic needed *only* for standalone debugging.

const PORT = parseInt(process.env.BLENDER_TCP_PORT || "9876", 10);
const HOST = process.env.BLENDER_TCP_HOST || "127.0.0.1";

let client = null;
let buffer = '';
let pendingRequest = null;
let blenderConnected = false;

function parseBuffer() {
    if (!pendingRequest) {
        if (buffer.length > 2048) buffer = "";
        return;
    }
    try {
        let braceCount = 0, jsonStart = -1, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = 0; i < buffer.length; i++) {
            const char = buffer[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === "\\") { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (char === "{") { if (jsonStart === -1) jsonStart = i; braceCount++; }
            else if (char === "}") { braceCount--; if (braceCount === 0 && jsonStart !== -1) { jsonEnd = i + 1; break; } }
        }
        if (jsonEnd === -1) return;
        const jsonStr = buffer.slice(jsonStart, jsonEnd);
        const parsed = JSON.parse(jsonStr);
        buffer = buffer.slice(jsonEnd).trim();
        if (pendingRequest) {
            clearTimeout(pendingRequest.timeout);
            if (parsed.status === 'error') pendingRequest.reject(new Error(parsed.message || 'Unknown Blender error'));
            else pendingRequest.resolve(parsed.result || parsed);
            pendingRequest = null;
        }
        if (buffer.length > 0) process.nextTick(parseBuffer);
    } catch (err) {
        console.error("❌ Parse Error:", err.message);
        buffer = "";
        if (pendingRequest) {
            pendingRequest.reject(err);
            pendingRequest = null;
        }
    }
}

function sendCommandStandalone(commandType, params = {}) {
    return new Promise((resolve, reject) => {
        if (pendingRequest) return reject(new Error('Another request is already pending.'));
        const timeoutMs = 30000; // 30s timeout for status checks
        const timeout = setTimeout(() => {
            pendingRequest = null;
            reject(new Error(`Timeout: No response for ${commandType} after ${timeoutMs / 1000}s.`));
        }, timeoutMs);
        pendingRequest = { resolve, reject, timeout };
        const json = JSON.stringify({ type: commandType, params });
        console.log(`\n📤 Sending: ${json}`);
        client.write(json);
    });
}

function connectToBlender() {
  return new Promise((resolve, reject) => {
    console.log(`Connecting to Blender at ${HOST}:${PORT}...`);
    client = new net.Socket();
    client.connect(PORT, HOST, () => {
      blenderConnected = true;
      console.log("✅ Blender connected.");
      resolve();
    });
    client.on('data', parseBuffer);
    client.on('error', (err) => {
      if (!blenderConnected) reject(err);
      else console.error('❌ Connection Error:', err.message);
    });
    client.on('close', () => {
      console.log('🔌 Connection closed.');
      blenderConnected = false;
    });
  });
}

async function runChecksStandalone() {
    try {
        await connectToBlender();
        await checkAllIntegrations(sendCommandStandalone, true);
    } catch (err) {
        console.error(`\n❌ Fatal Error: ${err.message}`);
        if (err.code === 'ECONNREFUSED') {
            console.error('💡 Is Blender running? Is the addon enabled and "Connected to MCP server"?');
        }
    } finally {
        if (client) client.end();
        process.exit(0);
    }
}

// Check if the script is being run directly
if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
    runChecksStandalone();
}