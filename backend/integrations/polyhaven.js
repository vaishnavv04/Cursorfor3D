/*
 * polyhaven.js
 *
 * "Dumb" module for PolyHaven integration logic.
 * Exports a function that receives 'sendCommand' from the main integration index.
 * Does not contain any TCP connection, client, or standalone logic.
 */

/**
 * Orchestrates the full PolyHaven search and import flow.
 * @param {Function} sendCommand - The 'sendCommand' function from the core module.
 * @param {string} query - The user's search query.
 * @param {string} assetType - The type of asset ("models", "textures", "hdris").
 * @returns {Promise<object>} - Resolves with { name, type, assetType }.
 */
export async function searchAndImportAsset(sendCommand, query, assetType = "models") {
  try {
    // 1. Process keywords for better search results
    const stopWords = ["a", "an", "the", "of", "for", "with", "and"];
    const keywords = (query || "").split(" ")
      .map(w => w.toLowerCase())
      .filter(w => !stopWords.includes(w) && w.length > 1);
    const categoryString = keywords.join(",");

    if (!categoryString) {
        throw new Error(`No valid keywords to search for in query: "${query}"`);
    }
    
    // 2. Search for assets
    const searchResult = await sendCommand("search_polyhaven_assets", { 
      asset_type: assetType, 
      categories: categoryString 
    });
    
    if (!searchResult.assets || Object.keys(searchResult.assets).length === 0) {
      throw new Error(`No PolyHaven assets found for categories: ${categoryString}`);
    }
    
    // 3. Download and import the asset
    const assetId = Object.keys(searchResult.assets)[0]; // Get the first asset
    const importResult = await sendCommand("download_polyhaven_asset", { 
      asset_id: assetId, 
      asset_type: assetType, 
      resolution: "1k", // 1k is fastest for previews
      file_format: assetType === "hdris" ? "hdr" : "gltf" 
    });
    
    if (!importResult.success) {
      throw new Error(`Failed to import PolyHaven asset: ${importResult.error || JSON.stringify(importResult)}`);
    }
    
    // Get the name of the imported asset
    const objectName = importResult.imported_objects?.[0] || 
                      importResult.material_name || 
                      importResult.image_name || 
                      "PolyHaven_Asset";
                      
    return { name: objectName, type: "PolyHaven", assetType };
  } catch (error) {
    console.error(`PolyHaven import error: ${error.message}`);
    throw error;
  }
}