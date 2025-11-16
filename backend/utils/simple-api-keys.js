/**
 * Simple Random Gemini API Key Selection
 * Generates random number between 1-9 and selects corresponding API key
 */

/**
 * Get a random Gemini API key from environment variables
 * @returns {string|null} Selected API key or null if none found
 */
function getRandomGeminiKey() {
  // Generate random number between 1 and 9
  const randomNum = Math.floor(Math.random() * 9) + 1;
  const keyName = `GEMINI_API_KEY_${randomNum}`;
  const apiKey = process.env[keyName];
  
  if (apiKey) {
    console.log(`🔑 Using Gemini API key: ${keyName}`);
    return apiKey;
  }
  
  // Fallback to single key if numbered keys not found
  const fallbackKey = process.env.GEMINI_API_KEY;
  if (fallbackKey) {
    console.log(`🔑 Using fallback Gemini API key: GEMINI_API_KEY`);
    return fallbackKey;
  }
  
  console.warn(`⚠️ No Gemini API key found at ${keyName} or GEMINI_API_KEY`);
  return null;
}

/**
 * Simple function to create Gemini client with random key selection
 * @returns {GoogleGenerativeAI|null} Gemini client or null
 */
async function createGeminiClient() {
  const apiKey = getRandomGeminiKey();
  if (!apiKey) {
    return null;
  }
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  return new GoogleGenerativeAI(apiKey);
}

export {
  getRandomGeminiKey,
  createGeminiClient
};
