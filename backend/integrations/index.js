/*
 * Integrations module - Central entry point for all Blender integrations
 *
 * This file is the "smart core" of the integration system.
 * 1. It creates and manages the SINGLE TCP connection to Blender.
 * 2. It handles the sendCommand queue.
 * 3. It imports logic from the "dumb" module files (hyper3d, sketchfab, polyhaven).
 * 4. It passes its own 'sendCommand' function to those modules.
 */

import net from 'net';
import * as hyper3d from './hyper3d.js';
import * as sketchfab from './sketchfab.js';
import * as polyhaven from './polyhaven.js';
import { createCircuitBreaker } from './circuit-breaker.js';
import logger from '../utils/logger.js';

// Default TCP connection settings
const PORT = parseInt(process.env.BLENDER_TCP_PORT || "9876", 10);
const HOST = process.env.BLENDER_TCP_HOST || "127.0.0.1";

// Connection tracking
let client = null;
let buffer = '';
let isConnected = false;

// Queue for managing multiple TCP commands
let commandQueue = [];
let isProcessingQueue = false;
let pendingRequest = null;

// Circuit breakers for each integration type
const hyper3dCircuitBreaker = createCircuitBreaker({ threshold: 3, timeout: 30000 });
const sketchfabCircuitBreaker = createCircuitBreaker({ threshold: 3, timeout: 30000 });
const polyhavenCircuitBreaker = createCircuitBreaker({ threshold: 3, timeout: 30000 }); 

/**
 * Initialize the TCP connection to Blender
 * @returns {Promise<void>}
 */
export function initBlenderConnection() {
  return new Promise((resolve, reject) => {
    if (client && isConnected) {
        logger.info("Blender connection already active");
        return resolve();
    }
    
    let resolved = false;
    
    try {
      client = new net.Socket();
      
      // Setup event handlers
      client.on('data', handleData);
      client.on('error', (err) => {
        handleError(err);
        // Reject only once
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      client.on('close', () => {
        handleClose();
        // Only reject if not already resolved/rejected
        if (!resolved) {
          resolved = true;
          reject(new Error("Connection closed before establishing"));
        }
      });
      client.on('connect', () => {
        isConnected = true;
        logger.info(`Connected to Blender TCP server`, { host: HOST, port: PORT });
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
      
      // Initiate connection
      client.connect(PORT, HOST, () => {
        // Connection listener above will handle resolve
      });

    } catch (err) {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    }
  });
}

// Connection handler functions
function handleData(chunk) {
  buffer += chunk.toString('utf8');
  parseBuffer();
}

function handleError(err) {
  logger.error('Blender Connection Error', { error: err.message });
  isConnected = false;
  if (pendingRequest) {
    try { pendingRequest.reject(err); } catch(e) {}
    pendingRequest = null;
  }
  // Reject all pending commands in the queue
  commandQueue.forEach(cmd => cmd.reject(new Error("Blender Connection Error")));
  commandQueue = [];
  isProcessingQueue = false;
}

function handleClose() {
  logger.info('Blender Connection closed');
  isConnected = false;
  handleError(new Error("Connection closed"));
}

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
    
    if (buffer.length > 0) process.nextTick(parseBuffer);
    process.nextTick(processCommandQueue); // Try to process next command

  } catch (err) {
    console.error("❌ Parse Error:", err.message, "Buffer:", buffer);
    buffer = ""; // Clear a bad buffer
    if (pendingRequest) {
      pendingRequest.reject(err);
      pendingRequest = null;
    }
    process.nextTick(processCommandQueue);
  }
}

/**
 * Send a command to the Blender TCP server with queue management
 * @param {string} commandType - The command type 
 * @param {object} params - The command parameters
 * @returns {Promise<object>} - The command result
 */
export function sendCommand(commandType, params = {}) {
  return new Promise((resolve, reject) => {
    if (!client || !isConnected) {
      // Try to reconnect if connection is lost
      console.warn("Not connected. Attempting to reconnect...");
      initBlenderConnection().then(() => {
         enqueueCommand(commandType, params, resolve, reject);
      }).catch(err => {
         reject(new Error(`Not connected to Blender TCP server: ${err.message}`));
      });
    } else {
       enqueueCommand(commandType, params, resolve, reject);
    }
  });
}

function enqueueCommand(commandType, params, resolve, reject) {
    // Determine timeout based on command type
    let timeoutMs = 15000; // Default 15s
    if (commandType === 'download_sketchfab_model') {
      timeoutMs = 120000; // 120s (2 minutes) for Sketchfab downloads (can be large files)
    } else if (commandType.startsWith('download_') || commandType.includes('download')) {
      timeoutMs = 60000; // 60s for other downloads
    } else if (commandType.startsWith('create_rodin_job')) {
      timeoutMs = 30000; // 30s for job creation
    } else if (commandType.startsWith('search_')) {
      timeoutMs = 30000; // 30s for searches
    }

    // Add command to queue
    commandQueue.push({
      commandType,
      params,
      resolve,
      reject,
      timeoutMs
    });
    
    // Process queue if not already processing
    if (!isProcessingQueue) {
      process.nextTick(processCommandQueue);
    }
}

/**
 * Process the command queue one at a time
 */
async function processCommandQueue() {
  // Single atomic check and lock - prevents race condition
  if (isProcessingQueue || commandQueue.length === 0 || pendingRequest) {
    return;
  }
  
  isProcessingQueue = true;
  const command = commandQueue.shift();
  
  if (!command) {
    isProcessingQueue = false;
    return;
  }
  
  try {
    const timeout = setTimeout(() => {
      pendingRequest = null;
      command.reject(new Error(`Timeout: No response for ${command.commandType} after ${command.timeoutMs / 1000}s.`));
      isProcessingQueue = false;
      process.nextTick(processCommandQueue); // Continue processing queue
    }, command.timeoutMs);

    pendingRequest = { 
      resolve: (result) => {
        command.resolve(result);
        clearTimeout(timeout);
        pendingRequest = null;
        isProcessingQueue = false;
        process.nextTick(processCommandQueue); // Continue processing queue
      },
      reject: (error) => {
        command.reject(error);
        clearTimeout(timeout);
        pendingRequest = null;
        isProcessingQueue = false;
        process.nextTick(processCommandQueue); // Continue processing queue
      }, 
      timeout 
    };

    console.log(`[TCP] Sending command: ${command.commandType}`);
    const json = JSON.stringify({ type: command.commandType, params: command.params });
    client.write(json);
  } catch (err) {
    command.reject(err);
    pendingRequest = null;
    isProcessingQueue = false;
    process.nextTick(processCommandQueue); // Continue processing queue
  }
}

/**
 * Check if the connection to Blender is active
 * @returns {boolean} - True if connected
 */
export function isBlenderConnected() {
  return isConnected;
}

/**
 * Close the connection to Blender
 */
export function closeConnection() {
  if (client) {
    client.end();
    client = null;
    isConnected = false;
    commandQueue = [];
    pendingRequest = null;
  }
}

// Re-export key functions from integration modules
export const integrationModules = {
  // Make core TCP command sender available
  sendCommand,
  
  // Integration status checking
  checkIntegrationStatus: async () => {
    try {
      console.log('Checking integration status...');
      
      const polyStatus = await sendCommand('get_polyhaven_status', {});
      const hyperStatus = await sendCommand('get_hyper3d_status', {});
      const sketchStatus = await sendCommand('get_sketchfab_status', {});
      
      const result = { 
        polyhaven: polyStatus?.enabled === true, 
        hyper3d: hyperStatus?.enabled === true, 
        sketchfab: sketchStatus?.enabled === true 
      };
      console.log('Final integration status:', result);
      return result;
    } catch (err) {
      console.warn("Integration status check failed:", err?.message || err);
      return { hyper3d: false, polyhaven: false, sketchfab: false };
    }
  },
  
  // Asset intent detection
  detectAssetIntent: (promptText, integrationStatus) => {
    const p = (promptText || "").toLowerCase().trim();
    const hyper3dKeywords = ["realistic", "photorealistic", "hyper3d", "rodin", "dragon", "creature", "monster", "sculpture", "animal", "high detail"];
    const sketchfabKeywords = ["sketchfab", "specific model", "brand name", "realistic car", "eames chair", "starship"];
    const polyhavenKeywords = ["polyhaven", "texture", "hdri", "material", "generic", "simple chair", "basic furniture", "wooden chair", "table"];

    // Check Hyper3D first (most specific)
    if (integrationStatus?.hyper3d && hyper3dKeywords.some(k => p.includes(k))) 
      return { type: "hyper3d", prompt: promptText };

    // Check PolyHaven (textures, HDRIs, generic models)
    if (integrationStatus?.polyhaven) {
      if (p.includes("hdri") || p.includes("sky texture")) {
        const query = p.replace("hdri", "").replace("sky texture", "").trim();
        return { type: "polyhaven", asset_type: "hdris", query: query || "sky" };
      }
      if (p.includes("texture") || p.includes("material")) {
        const query = p.replace("texture", "").replace("material", "").trim();
        return { type: "polyhaven", asset_type: "textures", query: query || "wood" };
      }
      if (polyhavenKeywords.some(k => p.includes(k))) {
        const query = p.replace("polyhaven", "").trim();
        return { type: "polyhaven", asset_type: "models", query: query || p };
      }
    }

    // Check Sketchfab (explicit keywords or fallback if it's the only available integration)
    if (integrationStatus?.sketchfab) {
      if (sketchfabKeywords.some(k => p.includes(k))) {
        const query = p.replace("sketchfab", "").replace("add", "").trim();
        return { type: "sketchfab", query: query || "realistic model" };
      }
      
      // Fallback: If Sketchfab is the only enabled integration and no other keywords match, use Sketchfab
      const enabledIntegrations = [
        integrationStatus?.hyper3d,
        integrationStatus?.polyhaven,
        integrationStatus?.sketchfab
      ].filter(Boolean).length;
      
      if (enabledIntegrations === 1 && integrationStatus?.sketchfab) {
        // Only Sketchfab is enabled, default to it
        return { type: "sketchfab", query: promptText };
      }
    }
    
    return { type: "none" };
  },
  
  // Integration-specific modules
  // We call the imported functions and pass them our 'sendCommand'
  // Each is wrapped with circuit breaker protection
  hyper3d: {
    generateAndImportAsset: async (prompt, progress) => {
      return hyper3dCircuitBreaker.execute(() => {
        return hyper3d.generateAndImportAsset(sendCommand, prompt, progress);
      });
    },
    getCircuitBreakerState: () => hyper3dCircuitBreaker.getState(),
  },

  sketchfab: {
    searchAndImportModel: async (query) => {
      return sketchfabCircuitBreaker.execute(() => {
        return sketchfab.searchAndImportModel(sendCommand, query);
      });
    },
    getCircuitBreakerState: () => sketchfabCircuitBreaker.getState(),
  },

  polyhaven: {
    searchAndImportAsset: async (query, assetType = "models") => {
      return polyhavenCircuitBreaker.execute(() => {
        return polyhaven.searchAndImportAsset(sendCommand, query, assetType);
      });
    },
    getCircuitBreakerState: () => polyhavenCircuitBreaker.getState(),
  }
};