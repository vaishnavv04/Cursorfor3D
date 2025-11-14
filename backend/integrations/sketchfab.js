/*
 * sketchfab.js
 *
 * "Dumb" module for Sketchfab integration logic.
 * Exports a function that receives 'sendCommand' from the main integration index.
 * Does not contain any TCP connection, client, or standalone logic.
 */

/**
 * Orchestrates the full Sketchfab search and import flow.
 * @param {Function} sendCommand - The 'sendCommand' function from the core module.
 * @param {string} query - The user's search query.
 * @returns {Promise<object>} - Resolves with { name, type, assetType }.
 */
export async function searchAndImportModel(sendCommand, query) {
  try {
    // 1. Search for models matching query.
    // The 'search_sketchfab_models' command in addon.py already filters
    // for "downloadable=True" by default.
    const searchResult = await sendCommand('search_sketchfab_models', { query });

    const firstHit = searchResult.results?.[0];
    if (!firstHit || !firstHit.uid) {
        throw new Error(`No downloadable models found on Sketchfab for query: "${query}"`);
    }
    
    const modelUid = firstHit.uid;
    
    // 2. Download and import model
    const importResult = await sendCommand('download_sketchfab_model', { 
        uid: modelUid 
    });

    if (!importResult.success || !importResult.imported_objects || importResult.imported_objects.length === 0) {
        throw new Error(`Failed to import Sketchfab model: ${importResult.error || 'Unknown error'}`);
    }
    
    // Get the primary imported object (often the first one)
    const objectName = importResult.imported_objects[0];
    
    return { 
        name: objectName, 
        type: "Sketchfab", 
        assetType: "models" 
    };
  } catch (error) {
    console.error(`Sketchfab import error: ${error.message}`);
    throw error;
  }
}