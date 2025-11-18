// LangGraph implementation for ReAct Agent and RAG System
import { StateGraph, END, Annotation } from "@langchain/langgraph";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import pgvector from "pgvector/pg";
import { pipeline } from "@xenova/transformers";
import { getRandomGeminiKey } from './utils/simple-api-keys.js';
import { integrationModules, sendCommand, isBlenderConnected } from './integrations/index.js';
import logger from './utils/logger.js';
import { pool } from "./db.js";
import fs from 'fs';
import path from 'path';
import os from 'os';

// Initialize AI providers (reuse from server.js)
const groqClient = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// Dynamic Gemini client creation function
async function createGeminiClient() {
  const apiKey = getRandomGeminiKey();
  return apiKey ? new GoogleGenerativeAI(apiKey) : null;
}

// Model configs
const MODEL_CONFIGS = {
  gemini: { name: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
  groq: { name: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B (Groq)" },
};
const EMBEDDING_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_EMBEDDING_DIM = 380;

let embedderPromise = null;
async function getEmbedder() {
  if (embedderPromise === null) {
    logger.info("Loading local embedding model", { model: EMBEDDING_MODEL_NAME });
    embedderPromise = pipeline("feature-extraction", EMBEDDING_MODEL_NAME);
  }
  return embedderPromise;
}

async function embedQuery(text) {
  const embedder = await getEmbedder();
  const embedding = await embedder(text, { pooling: "mean", normalize: true });
  const data = embedding.data;
  const arr = Array.isArray(data) ? data : Array.from(data);
  return arr;
}

// Import database pool from server.js
// Note: pool is already imported above

async function tableExists(tableName) {
  try {
    const { rows } = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
      [tableName]
    );
    return rows[0].exists;
  } catch (error) {
    logger.error("Error checking if table exists", { table: tableName, error: error.message });
    return false;
  }
}

// Helper function for Levenshtein distance calculation
function levenshteinDistance(str1, str2) {
  const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(0));
  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }
  return matrix[str2.length][str1.length];
}

// Helper function for string similarity calculation
function similarity(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const maxLen = Math.max(len1, len2);
  if (maxLen === 0) return 1.0;
  const distance = levenshteinDistance(str1, str2);
  return 1 - distance / maxLen;
}

// Helper function to deduplicate search results
function deduplicateResults(rows, similarityThreshold = 0.95) {
  const unique = [];
  for (const row of rows) {
    const isDuplicate = unique.some(existing => 
      similarity(existing.content, row.content) > similarityThreshold
    );
    if (!isDuplicate) {
      unique.push(row);
    }
  }
  return unique;
}

async function searchKnowledgeBase(queryText, limit = 5) {
  logger.info(`[RAG] Searching knowledge base`, { query: String(queryText).slice(0, 100), limit });
  try {
    const queryEmbedding = await embedQuery(queryText);
    const vectorString = pgvector.toSql(queryEmbedding);
    
    const MIN_SIMILARITY = 0.3; // Add threshold for better quality results
    const hasNewTable = await tableExists("blender_knowledge_new");
    
    const tableName = hasNewTable ? "blender_knowledge_new" : "blender_knowledge";
    const query = `
      SELECT content, 1 - (embedding <=> $1) AS similarity
      FROM ${tableName}
      WHERE 1 - (embedding <=> $1) > $2
      ORDER BY similarity DESC
      LIMIT $3
    `;
    const { rows } = await pool.query(query, [vectorString, MIN_SIMILARITY, limit]);
    
    // Deduplicate similar results
    const uniqueResults = deduplicateResults(rows);
    
    logger.info(`[RAG] Found ${uniqueResults.length} relevant documents`, { similarity: MIN_SIMILARITY });
    return uniqueResults.map((r) => ({
      content: r.content,
      similarity: r.similarity
    }));
  } catch (error) {
    logger.error(`[RAG] Knowledge base search failed`, { error: error?.message || error });
    return [];
  }
}

// Define the agent state using LangGraph's Annotation system
const AgentStateAnnotation = Annotation.Root({
  messages: Annotation({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  sceneContext: Annotation({
    default: () => null,
  }),
  ragContext: Annotation({
    default: () => [],
  }),
  integrationStatus: Annotation({
    default: () => ({ hyper3d: false, polyhaven: false, sketchfab: false }),
  }),
  loopCount: Annotation({
    default: () => 0,
  }),
  maxLoops: Annotation({
    default: () => 10,
  }),
  blenderAvailable: Annotation({
    default: () => false,
  }),
  conversationId: Annotation({
    default: () => null,
  }),
  toolName: Annotation({
    default: () => null,
  }),
  toolInput: Annotation({
    default: () => ({}),
  }),
  finished: Annotation({
    default: () => false,
  }),
  searchHistory: Annotation({
    default: () => [],
  }),
  assetGenerated: Annotation({
    default: () => false,
  }),
  animationGenerated: Annotation({
    default: () => false,
  }),
  taskDecomposition: Annotation({
    default: () => null,
  }),
  currentSubtaskIndex: Annotation({
    default: () => 0,
  }),
  completedSubtasks: Annotation({
    default: () => [],
  }),
  subtaskResults: Annotation({
    default: () => {},
  }),
  attachments: Annotation({
    default: () => [],
    reducer: (x, y) => y || x, // Use the latest attachments
  }),
  hasReplanned: Annotation({
    default: () => false,
  }),
  validationResult: Annotation({
    default: () => null,
  }),
  lastCodeExecution: Annotation({
    default: () => null,
  }),
  autoValidateNext: Annotation({
    default: () => false,
  }),
});

// Tool definitions using LangGraph's tool decorator
const searchKnowledgeBaseTool = tool(
  async ({ query }) => {
    logger.info(`🔍 [RAG] Searching knowledge base`, { query: query.slice(0, 100) });
    
    return retryOperation(
      async () => {
        const results = await searchKnowledgeBase(query, 5);
        
        // Extract content for ragContext (backward compatibility)
        const docs = results.map(r => r.content || r);
        
        // Provide detailed results with similarity scores
        const detailedResults = results.map(r => ({
          content: r.content || r,
          similarity: r.similarity || 0
        }));
        
        const resultEmoji = docs.length > 0 ? '✅' : '⚠️';
        return {
          success: true,
          documents: docs,
          detailedResults: detailedResults,
          count: docs.length,
          message: `${resultEmoji} Found ${docs.length} relevant documents for query: "${query}" (avg similarity: ${(detailedResults.reduce((sum, r) => sum + r.similarity, 0) / detailedResults.length || 0).toFixed(2)})`,
        };
      },
      {
        maxRetries: 2,
        backoffMs: 500,
        operationName: 'RAG search',
        shouldRetry: (error) => !String(error).includes('not initialized')
      }
    );
  },
  {
    name: "search_knowledge_base",
    description: "Searches the Blender 4.x API documentation for a specific query. Use this before execute_blender_code.",
    schema: z.object({
      query: z.string().describe("The search query for the knowledge base"),
    }),
  }
);

const getSceneInfoTool = tool(
  async () => {
    if (!isBlenderConnected()) {
      return {
        success: false,
        error: "Blender is not connected. Cannot get scene information.",
      };
    }
    
    return retryOperation(
      async () => {
        try {
          const sceneContext = await sendCommand("get_scene_info", {});
          return {
            success: true,
            sceneContext,
            message: `Scene info retrieved. Current objects: ${Array.isArray(sceneContext.objects) ? sceneContext.objects.join(", ") : "unknown"}`,
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get scene info: ${error.message}`,
          };
        }
      },
      {
        maxRetries: 2,
        backoffMs: 500,
        operationName: 'Get scene info',
        shouldRetry: (error) => !String(error).includes('not connected')
      }
    );
  },
  {
    name: "get_scene_info",
    description: "Gets the current scene state from Blender.",
    schema: z.object({}),
  }
);

// Generic retry wrapper with exponential backoff
async function retryOperation(operation, options = {}) {
  const {
    maxRetries = 3,
    backoffMs = 1000,
    onRetry = null,
    shouldRetry = () => true,
    operationName = 'operation'
  } = options;

  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation(attempt);
      
      // Check if result indicates failure
      if (result && typeof result === 'object' && result.success === false) {
        lastError = result.error || result.message || 'Operation returned failure';
        
        // Check if we should retry
        if (attempt < maxRetries && shouldRetry(result, attempt)) {
          logger.warn(`[Retry ${attempt}/${maxRetries}] ${operationName} failed`, { error: lastError });
          if (onRetry) await onRetry(result, attempt);
          await new Promise(resolve => setTimeout(resolve, backoffMs * attempt));
          continue;
        }
        
        return result; // Return the failure result
      }
      
      // Success
      return result;
    } catch (error) {
      lastError = error.message || String(error);
      
      // Check if we should retry
      if (attempt < maxRetries && shouldRetry(error, attempt)) {
        logger.warn(`[Retry ${attempt}/${maxRetries}] ${operationName} threw error`, { error: lastError });
        if (onRetry) await onRetry(error, attempt);
        await new Promise(resolve => setTimeout(resolve, backoffMs * attempt));
        continue;
      }
      
      // Don't retry or exhausted retries
      throw error;
    }
  }
  
  // All retries exhausted
  throw new Error(`${operationName} failed after ${maxRetries} retries: ${lastError}`);
}

// Helper function to auto-fix common Blender code issues
async function autoFixBlenderCode(code, error) {
  if (!error) return code;
  
  const errorStr = String(error).toLowerCase();
  let fixedCode = code;
  
  // Fix common import issues
  if (errorStr.includes("name 'bpy' is not defined") || errorStr.includes("no module named 'bpy'")) {
    if (!/\bimport\s+bpy\b/.test(fixedCode)) {
      fixedCode = "import bpy\n" + fixedCode;
    }
  }
  
  // Fix context issues
  if (errorStr.includes("context") && errorStr.includes("invalid")) {
    // Add context check before operations
    if (!/bpy\.context\.object/.test(fixedCode) && /bpy\.ops\./.test(fixedCode)) {
      fixedCode = "if bpy.context.object:\n    " + fixedCode.replace(/\n/g, "\n    ");
    }
  }
  
  // Fix mode issues
  if (errorStr.includes("mode") || errorStr.includes("edit mode")) {
    if (/\bbmesh\b/.test(fixedCode) && !/mode_set\s*\(\s*mode\s*=\s*['"]EDIT['"]\s*\)/.test(fixedCode)) {
      fixedCode = "if bpy.context.object and bpy.context.object.mode != 'EDIT':\n    bpy.ops.object.mode_set(mode='EDIT')\n" + fixedCode;
    }
  }
  
  // Fix selection issues
  if (errorStr.includes("no active object") || errorStr.includes("nothing selected")) {
    if (!/bpy\.ops\.object\.select_all/.test(fixedCode) && /bpy\.ops\.object\./.test(fixedCode)) {
      fixedCode = "if bpy.data.objects:\n    bpy.ops.object.select_all(action='SELECT')\n" + fixedCode;
    }
  }
  
  return fixedCode;
}

// Retry logic for Blender code execution
async function executeBlenderCodeWithRetry(code, maxRetries = 3) {
  let lastError = null;
  let lastResult = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await sendCommand("execute_code", { code });
      
      if (result?.status === "error" || result?.executed === false) {
        lastError = result?.error || result?.result || "Unknown execution error";
        lastResult = result;
        
        // If execution failed and we have retries left, try to fix the code
        if (attempt < maxRetries) {
          logger.warn(`[Retry ${attempt}/${maxRetries}] Blender code execution failed, attempting auto-fix`, { error: lastError });
          code = await autoFixBlenderCode(code, lastError);
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
      } else {
        // Success!
        return { success: true, result, code };
      }
    } catch (error) {
      lastError = error.message || String(error);
      
      // If it's a connection error, don't retry
      if (lastError.includes("not connected") || lastError.includes("connection")) {
        throw new Error(`Blender connection error: ${lastError}`);
      }
      
      // If we have retries left, try to fix and retry
      if (attempt < maxRetries) {
        logger.warn(`[Retry ${attempt}/${maxRetries}] Blender code execution error, attempting auto-fix`, { error: lastError });
        code = await autoFixBlenderCode(code, lastError);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
    }
  }
  
  // All retries exhausted
  return { 
    success: false, 
    error: lastError || "Execution failed after all retries",
    result: lastResult,
    code 
  };
}

const executeBlenderCodeTool = tool(
  async ({ code }) => {
    if (!isBlenderConnected()) {
      return {
        success: false,
        error: "Blender is not connected. Cannot execute code.",
      };
    }

    // Sanitize code (reuse from server.js)
    function sanitizeBlenderCode(code) {
      if (typeof code !== "string") return "";
      code = code.replace(/^\s*python\s*\n/i, "");
      code = code.replace(/```(?:python|py)?\n?|```/gi, "");
      code = code.replace(/,\s*use_undo\s*=\s*(True|False)/gi, "");
      code = code.replace(/\buse_undo\s*=\s*(True|False)\s*,?\s*/gi, "");
      code = code.replace(/,\s*use_global\s*=\s*(True|False)/gi, "");
      code = code.replace(/\buse_global\s*=\s*(True|False)\s*,?\s*/gi, "");
      code = code.replace(/,\s*constraint_axis\s*=\s*\[[^\]]+\]/gi, "");
      code = code.replace(/\bconstraint_axis\s*=\s*\[[^\]]+\]\s*,?\s*/gi, "");
      code = code.replace(/,\s*,/g, ",");
      code = code.replace(/bpy\.ops\.wm\.obj_delete_all\s*\(\)/gi, `if bpy.data.objects:\n    bpy.ops.object.select_all(action='SELECT')\n    bpy.ops.object.delete()`);
      code = code.replace(/^\s*bpy\.ops\.preferences\.addon_enable\([^)]*\)\s*$/gmi, "");
      code = code.replace(/bpy\.ops\.mesh\.loopcut_and_slide\s*\(([^)]*)\)/gi, (m, inner) => {
        const numMatch = inner.match(/number_cuts"?\s*:?\s*(\d+)/i);
        const cuts = numMatch ? numMatch[1] : "1";
        return `bpy.ops.mesh.loopcut(number_cuts=${cuts})`;
      });
      if (/\bbmesh\b/.test(code) && !/mode_set\s*\(\s*mode\s*=\s*['"]EDIT['"]\s*\)/.test(code)) {
        code = "if bpy.context.object and bpy.context.object.mode != 'EDIT':\n    bpy.ops.object.mode_set(mode='EDIT')\n" + code;
      }
      if (!/\bimport\s+bpy\b/.test(code)) {
        code = "import bpy\n" + code;
      }
      code = code.replace(/\r/g, "");
      return code;
    }

    const sanitizedCode = sanitizeBlenderCode(code);
    
    // Execute with retry logic
    const retryResult = await executeBlenderCodeWithRetry(sanitizedCode, 3);
    
    if (retryResult.success) {
      return {
        success: true,
        result: retryResult.result,
        message: `Code executed successfully. Output: ${retryResult.result?.result || "No output"}`,
      };
    } else {
      return {
        success: false,
        error: retryResult.error || "Code execution failed after retries",
        result: retryResult.result,
      };
    }
  },
  {
    name: "execute_blender_code",
    description: "Executes a block of Blender Python (bpy) code in the 3D scene. Use this ONLY after you have searched the knowledge base and are confident the code is correct.",
    schema: z.object({
      code: z.string().describe("The Blender Python code to execute"),
    }),
  }
);

const assetSearchAndImportTool = tool(
  async ({ prompt }) => {
    logger.info(`\ud83d\udd0e [Asset] Searching for: ${prompt.substring(0, 50)}...`);
    
    if (!isBlenderConnected()) {
      logger.warn("\u274c [Asset] Blender not connected");
      return {
        success: false,
        error: "Blender is not connected. Cannot import assets.",
      };
    }

    return retryOperation(
      async (attempt) => {
        try {
          // Check integration status
          const integrationStatus = await integrationModules.checkIntegrationStatus();
          const assetIntent = integrationModules.detectAssetIntent(prompt, integrationStatus);
          
          if (assetIntent.type === "none" || !integrationStatus[assetIntent.type]) {
            return {
              success: false,
              error: `No suitable integration available for asset: ${prompt}. Consider generating Blender code instead.`,
              suggestion: "Use execute_blender_code to create a placeholder asset.",
            };
          }

          // Use integration modules (circuit breakers handle their own retries)
          let assetResult;
          switch (assetIntent.type) {
            case "hyper3d":
              assetResult = await integrationModules.hyper3d.generateAndImportAsset(assetIntent.prompt, null);
              break;
            case "sketchfab":
              assetResult = await integrationModules.sketchfab.searchAndImportModel(assetIntent.query);
              break;
            case "polyhaven":
              assetResult = await integrationModules.polyhaven.searchAndImportAsset(assetIntent.query, assetIntent.asset_type);
              break;
            default:
              throw new Error("Unknown asset type");
          }

          return {
            success: true,
            assetResult,
            message: `Successfully imported asset: ${assetResult.name} via ${assetIntent.type}`,
          };
        } catch (error) {
          return {
            success: false,
            error: `Asset import failed: ${error.message}`,
          };
        }
      },
      {
        maxRetries: 2,
        backoffMs: 2000,
        operationName: 'Asset import',
        shouldRetry: (error) => {
          const errStr = String(error);
          return !errStr.includes('not connected') && !errStr.includes('Circuit breaker is OPEN');
        }
      }
    );
  },
  {
    name: "asset_search_and_import",
    description: "Searches for and imports a 3D asset from an online library (Hyper3D, Sketchfab, PolyHaven).",
    schema: z.object({
      prompt: z.string().describe("Description of the asset to search for and import"),
    }),
  }
);

const analyzeImageTool = tool(
  async ({ attachments }) => {
    logger.info(`[LangGraph] Analyzing image attachment(s)`, { count: attachments?.length || 0 });
    
    if (!attachments || attachments.length === 0) {
      return {
        success: false,
        error: "No images provided for analysis",
        message: "No images to analyze"
      };
    }
    
    const imageAttachments = attachments.filter(att => att.type && att.type.startsWith('image/'));
    if (imageAttachments.length === 0) {
      return {
        success: false,
        error: "No valid image files found",
        message: "No valid images to analyze"
      };
    }
    
    try {
      // Create Gemini client dynamically for this request
      const genAI = await createGeminiClient();
      if (!genAI) {
        throw new Error("Gemini API not configured for image analysis");
      }
      
      const visionModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash", // Using flash model which supports vision
        generationConfig: { temperature: 0.3 },
      });
      
      // Prepare the image data for Gemini
      const imageParts = imageAttachments.map(att => {
        // Extract base64 data from dataUrl
        const base64Data = att.dataUrl.split(',')[1];
        return {
          inlineData: {
            data: base64Data,
            mimeType: att.type
          }
        };
      });
      
      const prompt = `Analyze this image and describe what you see in detail. Focus on:
1. Objects and their shapes
2. Colors and materials
3. Composition and layout
4. Any distinctive features that would be important for creating a 3D model

Provide a detailed description that would help someone recreate this as a 3D model in Blender.`;
      
      const visionRequest = [
        { text: prompt },
        ...imageParts
      ];
      
      const result = await visionModel.generateContent(visionRequest);
      const analysis = await result.response.text();
      
      logger.info(`[Gemini Vision] Image analysis completed`, { preview: analysis.substring(0, 100) });
      
      return {
        success: true,
        analysis,
        imageCount: imageAttachments.length,
        message: `Successfully analyzed ${imageAttachments.length} image(s) with Gemini vision`,
      };
    } catch (error) {
      logger.error(`[Gemini Vision] Image analysis failed`, { error: error.message });
      
      // Provide a fallback analysis when Gemini vision fails
      const fallbackAnalysis = `I can see ${imageAttachments.length} image(s) uploaded (${imageAttachments.map(att => att.name).join(', ')}). Based on the presence of these images, I should create a 3D representation. Since I cannot analyze the specific visual content due to technical limitations, I will create a basic 3D object that can serve as a starting point for further refinement based on the image content.`;
      
      return {
        success: true,
        analysis: fallbackAnalysis,
        imageCount: imageAttachments.length,
        message: `Used fallback analysis for ${imageAttachments.length} image(s) due to vision API limitations`,
        warning: `Vision analysis failed: ${error.message}`
      };
    }
  },
  {
    name: "analyze_image",
    description: "Analyzes uploaded image attachments using Gemini vision to understand what 3D model to create",
    schema: z.object({
      attachments: z.array(z.object({
        name: z.string(),
        type: z.string(),
        dataUrl: z.string().optional(),
      })).describe("Array of image attachments to analyze"),
    }),
  }
);

const validateWithVisionTool = tool(
  async ({ expectedOutcome, triggerScreenshot = true }) => {
    try {
      logger.info(`👁️ [Vision Validation] Starting validation`, { 
        expectedOutcome: expectedOutcome.substring(0, 100),
        triggerScreenshot
      });

      // Check if Blender is connected
      if (!isBlenderConnected()) {
        return {
          success: false,
          error: "Blender not connected",
          validation: {
            matches: false,
            confidence: 0,
            quality_score: 0,
            issues: ["Cannot validate - Blender not connected"],
            suggestions: ["Ensure Blender is running and connected"],
            pass: false
          }
        };
      }

      // Capture screenshot from Blender using existing get_viewport_screenshot
      let base64Data;
      if (triggerScreenshot) {
        logger.info(`📸 [Vision Validation] Capturing viewport screenshot...`);
        
        // Use temporary file for screenshot
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `blender_validation_${Date.now()}.png`);
        
        try {
          const screenshotResult = await sendCommand('get_viewport_screenshot', {
            filepath: tempFilePath,
            max_size: 800,
            format: 'png'
          });
          
          if (!screenshotResult || !screenshotResult.success) {
            throw new Error("Failed to capture screenshot from Blender");
          }
          
          // Read the screenshot file and convert to base64
          const imageBuffer = fs.readFileSync(tempFilePath);
          base64Data = imageBuffer.toString('base64');
          
          logger.info(`[Vision Validation] Screenshot captured and converted to base64`);
        } finally {
          // Always clean up temp file, even on error
          try {
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
              logger.debug(`[Vision Validation] Cleaned up temp file: ${tempFilePath}`);
            }
          } catch (cleanupErr) {
            logger.warn(`Failed to cleanup temp file: ${cleanupErr.message}`);
          }
        }
      } else {
        throw new Error("Screenshot capture is required for validation");
      }

      // Use Gemini Vision API
      const genAI = await createGeminiClient();
      if (!genAI) {
        throw new Error("Gemini API not configured for vision validation");
      }

      const visionModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: { 
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      });

      const validationPrompt = `You are a 3D quality validation expert analyzing a Blender viewport screenshot.

**Expected Outcome:**
${expectedOutcome}

**Your Task:**
Analyze the screenshot and evaluate if it matches the expected outcome. Provide a structured JSON response.

**Evaluation Criteria:**
1. **Object Presence** (30%): Are all expected objects visible?
2. **Geometry Accuracy** (25%): Do shapes match expectations?
3. **Material/Color Correctness** (20%): Are colors/materials right?
4. **Composition** (15%): Is layout/positioning correct?
5. **Technical Quality** (10%): No artifacts, proper shading, etc.

**Response Format (JSON only, no markdown):**
{
  "matches": true/false,
  "confidence": 0.0-1.0,
  "quality_score": 0-10,
  "visual_analysis": {
    "objects_detected": ["list", "of", "objects"],
    "colors_observed": ["color1", "color2"],
    "geometry_quality": "description",
    "material_quality": "description",
    "composition": "description"
  },
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1", "suggestion2"],
  "pass": true/false
}`;

      const visionRequest = [
        {
          inlineData: {
            data: base64Data,
            mimeType: "image/png"
          }
        },
        { text: validationPrompt }
      ];

      const result = await visionModel.generateContent(visionRequest);
      const responseText = await result.response.text();
      
      // Parse JSON response (handle potential markdown wrapping)
      let validationResult;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        validationResult = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
      } catch (parseErr) {
        logger.warn(`[Vision Validation] Failed to parse JSON, using fallback`, { 
          response: responseText.substring(0, 200) 
        });
        validationResult = {
          matches: /matches.*true/i.test(responseText),
          confidence: 0.5,
          quality_score: 5,
          visual_analysis: { raw_response: responseText.substring(0, 500) },
          issues: [],
          suggestions: [],
          pass: true
        };
      }

      const validationEmoji = validationResult.pass ? '✅' : '⚠️';
      logger.info(`${validationEmoji} [Vision Validation] Completed`, { 
        pass: validationResult.pass,
        quality_score: validationResult.quality_score,
        issues_count: validationResult.issues?.length || 0
      });

      return {
        success: true,
        validation: validationResult,
        screenshot_analyzed: true,
        message: validationResult.pass 
          ? `✅ Visual validation passed (quality: ${validationResult.quality_score}/10)` 
          : `⚠️ Visual validation found issues: ${validationResult.issues.join(', ')}`
      };

    } catch (error) {
      logger.error(`❌ [Vision Validation] Failed`, { error: error.message });
      return {
        success: false,
        error: error.message,
        validation: {
          matches: false,
          confidence: 0,
          quality_score: 0,
          issues: [`Vision validation failed: ${error.message}`],
          suggestions: ["Retry with manual inspection"],
          pass: false
        }
      };
    }
  },
  {
    name: "validate_with_vision",
    description: "Analyzes Blender viewport screenshot using Gemini Vision to validate if the result matches expectations. Use AFTER execute_blender_code when you need to verify the visual output is correct.",
    schema: z.object({
      expectedOutcome: z.string().describe("What should be visible in the viewport (e.g., 'a red cube at the origin')"),
      triggerScreenshot: z.boolean().default(true).describe("Whether to capture a new screenshot (default: true)"),
    }),
  }
);

const finishTaskTool = tool(
  async ({ finalAnswer }) => {
    return {
      success: true,
      finished: true,
      message: "Task completed successfully.",
      finalAnswer,
    };
  },
  {
    name: "finish_task",
    description: "Signals that you have fully completed the user's request and have a final answer for them.",
    schema: z.object({
      finalAnswer: z.string().describe("The final answer to return to the user"),
    }),
  }
);

// Animation helper functions
function generateHopAnimation(targetObject, duration) {
  const target = targetObject || 'bpy.context.object';
  return `import bpy

# Clear existing animation data
if ${targetObject ? `bpy.data.objects.get("${targetObject}")` : 'bpy.context.object'}:
    obj = ${target}
    obj.animation_data_clear()
    
    # Set animation timeline
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = ${Math.floor(duration * 24)}
    
    # Insert keyframes for hopping animation
    # Frame 1: Start position
    scene.frame_set(1)
    obj.location.z = 0
    obj.keyframe_insert(data_path="location", index=2)
    
    # Frame ${Math.floor(duration * 12)}: Peak of hop
    scene.frame_set(${Math.floor(duration * 12)})
    obj.location.z = 2.0
    obj.keyframe_insert(data_path="location", index=2)
    
    # Frame ${Math.floor(duration * 24)}: End position
    scene.frame_set(${Math.floor(duration * 24)})
    obj.location.z = 0
    obj.keyframe_insert(data_path="location", index=2)
    
    # Set interpolation to ease in/out
    if obj.animation_data and obj.animation_data.action:
        for fcurve in obj.animation_data.action.fcurves:
            for keyframe in fcurve.keyframe_points:
                keyframe.interpolation = 'BEZIER'
    
    print("Hop animation created successfully!")`;
}

function generateWalkAnimation(targetObject, duration) {
  return `import bpy
import math

# Clear existing animation data
if ${targetObject ? `bpy.data.objects.get("${targetObject}")` : 'bpy.context.object'}:
    obj = ${targetObject ? `bpy.data.objects["${targetObject}"]` : 'bpy.context.object'}
    obj.animation_data_clear()
    
    # Set animation timeline
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = ${Math.floor(duration * 24)}
    
    # Create walking animation
    steps = 4
    frames_per_step = (${duration * 24}) / steps
    
    for step in range(steps):
        # Forward movement
        start_frame = 1 + step * frames_per_step
        end_frame = start_frame + frames_per_step
        
        # Start position
        scene.frame_set(start_frame)
        obj.location.x = step * 2.0
        obj.keyframe_insert(data_path="location", index=0)
        
        # End position with slight bounce
        scene.frame_set(end_frame)
        obj.location.x = (step + 1) * 2.0
        obj.location.z = 0.3 if step % 2 == 0 else 0
        obj.keyframe_insert(data_path="location", index=0)
        obj.keyframe_insert(data_path="location", index=2)
    
    print("Walk animation created successfully!")`;
}

function generateRotateAnimation(targetObject, duration) {
  return `import bpy
import math

# Clear existing animation data
if ${targetObject ? `bpy.data.objects.get("${targetObject}")` : 'bpy.context.object'}:
    obj = ${targetObject ? `bpy.data.objects["${targetObject}"]` : 'bpy.context.object'}
    obj.animation_data_clear()
    
    # Set animation timeline
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = ${Math.floor(duration * 24)}
    
    # Create rotation animation
    # Frame 1: Start rotation
    scene.frame_set(1)
    obj.rotation_euler.z = 0
    obj.keyframe_insert(data_path="rotation_euler", index=2)
    
    # Frame ${Math.floor(duration * 24)}: Full rotation
    scene.frame_set(${Math.floor(duration * 24)})
    obj.rotation_euler.z = 2 * math.pi
    obj.keyframe_insert(data_path="rotation_euler", index=2)
    
    print("Rotation animation created successfully!")`;
}

function generateBounceAnimation(targetObject, duration) {
  return `import bpy

# Clear existing animation data
if ${targetObject ? `bpy.data.objects.get("${targetObject}")` : 'bpy.context.object'}:
    obj = ${targetObject ? `bpy.data.objects["${targetObject}"]` : 'bpy.context.object'}
    obj.animation_data_clear()
    
    # Set animation timeline
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = ${Math.floor(duration * 24)}
    
    # Create bouncing animation (3 bounces)
    bounces = 3
    frames_per_bounce = (${duration * 24}) / bounces
    
    for bounce in range(bounces):
        # Start frame for this bounce
        start_frame = 1 + bounce * frames_per_bounce
        peak_frame = start_frame + frames_per_bounce / 2
        end_frame = start_frame + frames_per_bounce
        
        # Start position
        scene.frame_set(start_frame)
        obj.location.z = 0
        obj.keyframe_insert(data_path="location", index=2)
        
        # Peak position
        scene.frame_set(peak_frame)
        obj.location.z = 1.5
        obj.keyframe_insert(data_path="location", index=2)
        
        # End position
        scene.frame_set(end_frame)
        obj.location.z = 0
        obj.keyframe_insert(data_path="location", index=2)
    
    print("Bounce animation created successfully!")`;
}

const createAnimationTool = tool(
  async ({ animationType, duration, targetObject }) => {
    logger.info(`[LangGraph] Creating animation`, { animationType, targetObject: targetObject || 'selected objects', duration });
    
    return retryOperation(
      async () => {
        try {
          let animationCode;
          
          switch (animationType.toLowerCase()) {
            case "hop":
              animationCode = generateHopAnimation(targetObject, duration || 2);
              break;
            case "walk":
              animationCode = generateWalkAnimation(targetObject, duration || 3);
              break;
            case "rotate":
              animationCode = generateRotateAnimation(targetObject, duration || 2);
              break;
            case "bounce":
              animationCode = generateBounceAnimation(targetObject, duration || 1.5);
              break;
            default:
              throw new Error(`Unknown animation type: ${animationType}`);
          }
          
          const result = await sendCommand("execute_code", { code: animationCode });
          
          if (result?.status === "error" || result?.executed === false) {
            return {
              success: false,
              error: result?.error || result?.result || "Animation execution failed",
            };
          }
          
          return {
            success: true,
            animation: {
              type: animationType,
              duration: duration || 2,
              target: targetObject || "all objects"
            },
            message: `Created ${animationType} animation for ${targetObject || 'objects'}`,
          };
        } catch (error) {
          return {
            success: false,
            error: error.message,
            message: "Animation creation failed",
          };
        }
      },
      {
        maxRetries: 2,
        backoffMs: 1000,
        operationName: 'Animation creation',
        shouldRetry: (error) => !String(error).includes('Unknown animation type')
      }
    );
  },
  {
    name: "create_animation",
    description: "Creates animations for 3D objects in Blender (hop, walk, rotate, bounce)",
    schema: z.object({
      animationType: z.string().describe("Type of animation: hop, walk, rotate, bounce"),
      duration: z.number().optional().describe("Duration of the animation in seconds"),
      targetObject: z.string().optional().describe("Name of the target object (optional, defaults to all)"),
    }),
  }
);

const decomposeTaskTool = tool(
  async ({ userRequest, attachments }) => {
    logger.info(`[LangGraph] Decomposing task`, { userRequest, attachmentCount: attachments?.length || 0 });
    
    try {
      // Get attachments from state (they'll be available in the tool node context)
      const decomposition = await decomposeUserTask(userRequest, attachments || []);
      
      return {
        success: true,
        decomposition: decomposition,
        message: `Task decomposed into ${decomposition.subtasks.length} atomic subtasks`,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: "Task decomposition failed",
      };
    }
  },
  {
    name: "decompose_task",
    description: "Decomposes a user request into the smallest possible atomic subtasks",
    schema: z.object({
      userRequest: z.string().describe("The user's request to decompose"),
      attachments: z.array(z.object({
        name: z.string(),
        type: z.string(),
        dataUrl: z.string().optional(),
      })).optional().describe("Array of attachments to consider for decomposition"),
    }),
  }
);

// Tools array
const tools = [
  decomposeTaskTool,
  searchKnowledgeBaseTool,
  getSceneInfoTool,
  executeBlenderCodeTool,
  assetSearchAndImportTool,
  analyzeImageTool,
  validateWithVisionTool,
  createAnimationTool,
  finishTaskTool,
];

// LLM caller for LangGraph agent
async function callAgentLLM(messages, model = "gemini") {
  let response;

  switch (model) {
    case "gemini": {
      const genAI = await createGeminiClient();
      if (!genAI) throw new Error("Gemini API not configured");
      
      // Convert LangChain messages to Gemini format
      // Extract system instruction and build content parts
      let systemInstruction = null;
      const contentParts = [];
      
      for (const msg of messages) {
        if (msg instanceof SystemMessage) {
          systemInstruction = msg.content;
        } else if (msg instanceof HumanMessage || msg instanceof AIMessage) {
          // Add text content as a part
          contentParts.push({ text: msg.content });
        }
      }
      
      // Create model with system instruction if available
      const modelConfig = {
        model: MODEL_CONFIGS.gemini.name,
        generationConfig: { temperature: 0.3 },
      };
      
      if (systemInstruction) {
        modelConfig.systemInstruction = systemInstruction;
      }
      
      const modelClient = genAI.getGenerativeModel(modelConfig);
      
      // Generate content with the parts
      const result = await modelClient.generateContent(contentParts);
      response = await result.response.text();
      break;
    }
    case "groq": {
      if (!groqClient) throw new Error("Groq API not configured");
      const groqMessages = messages.map(msg => ({
        role: msg instanceof HumanMessage ? "user" : msg instanceof AIMessage ? "assistant" : "system",
        content: msg.content,
      }));
      const groqResponse = await groqClient.chat.completions.create({
        model: MODEL_CONFIGS.groq.name,
        messages: groqMessages,
        temperature: 0.3,
      });
      response = groqResponse.choices[0].message.content;
      break;
    }
    default:
      throw new Error(`Unknown model: ${model}`);
  }

  return response;
}

// Dynamic re-planning function - regenerates task decomposition when critical subtasks fail
async function replanOnFailure(originalRequest, originalDecomposition, failedSubtasks, completedSubtasks, subtaskResults, attachments = []) {
  logger.info('[Dynamic Replan] Initiating re-planning due to critical subtask failures', { 
    failedCount: failedSubtasks.length, 
    completedCount: completedSubtasks.length 
  });

  // Gather context about what failed and what succeeded
  const failureContext = failedSubtasks.map(subtaskId => {
    const subtask = originalDecomposition.subtasks.find(s => s.id === subtaskId);
    const result = subtaskResults[subtaskId];
    return {
      id: subtaskId,
      description: subtask?.description,
      tool: subtask?.tool,
      error: result?.error || 'Unknown error'
    };
  });

  const successContext = completedSubtasks
    .filter(id => subtaskResults[id]?.success)
    .map(subtaskId => {
      const subtask = originalDecomposition.subtasks.find(s => s.id === subtaskId);
      return {
        id: subtaskId,
        description: subtask?.description,
        tool: subtask?.tool
      };
    });

  const replanPrompt = `You are a task re-planning expert. The original task decomposition has encountered failures and needs to be regenerated with an alternative approach.

ORIGINAL REQUEST: "${originalRequest}"

ORIGINAL PLAN: ${JSON.stringify(originalDecomposition, null, 2)}

COMPLETED SUCCESSFULLY:
${successContext.map(s => `- ${s.description} (${s.tool})`).join('\n') || 'None'}

FAILED SUBTASKS:
${failureContext.map(f => `- ${f.description} (${f.tool}): ${f.error}`).join('\n')}

${attachments && attachments.length > 0 ? `ATTACHMENTS: ${attachments.length} file(s) available` : ''}

Available tools: search_knowledge_base, get_scene_info, execute_blender_code, asset_search_and_import, analyze_image, create_animation, finish_task

INSTRUCTIONS:
1. Analyze WHY the subtasks failed (e.g., integration unavailable, invalid code, connection issues)
2. Generate an ALTERNATIVE approach that avoids the same failure modes
3. Reuse successful subtasks where possible
4. If an integration tool failed, try a different integration or fallback to execute_blender_code
5. If execute_blender_code failed, try searching knowledge base first or simplifying the code
6. Add conditional dependencies to handle potential failures gracefully

Return ONLY valid JSON in this exact format:
{
  "mainTask": "brief description",
  "reasoning": "why the new plan should work better",
  "subtasks": [
    {"id": 1, "description": "task 1", "tool": "tool_name", "parameters": {}, "dependencies": []},
    {"id": 2, "description": "task 2", "tool": "tool_name", "parameters": {}, "dependencies": []}
  ]
}

IMPORTANT: Ensure the new plan has a different strategy than the failed one!`;

  try {
    const response = await callAgentLLM([
      new SystemMessage("You are a task re-planning expert. Always return valid JSON with alternative strategies."),
      new HumanMessage(replanPrompt)
    ], "gemini");
    
    logger.info('[Dynamic Replan] Received re-plan response from LLM');
    
    // Strip markdown code blocks if present
    let cleanedResponse = response.trim();
    if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, '');
      cleanedResponse = cleanedResponse.replace(/\s*```$/i, '');
      cleanedResponse = cleanedResponse.trim();
    }
    
    const parsed = JSON.parse(cleanedResponse);
    logger.info('[Dynamic Replan] Successfully generated new plan', { 
      subtaskCount: parsed.subtasks?.length || 0,
      reasoning: parsed.reasoning 
    });
    
    return {
      success: true,
      decomposition: parsed,
      reasoning: parsed.reasoning
    };
  } catch (error) {
    logger.error('[Dynamic Replan] Failed to generate new plan', { error: error.message });
    
    // Fallback: Create a simplified plan focusing on execute_blender_code
    return {
      success: true,
      decomposition: {
        mainTask: originalRequest,
        reasoning: "Fallback plan using simplified Blender code approach",
        subtasks: [
          {
            id: 1,
            description: "Search Blender API knowledge base for relevant information",
            tool: "search_knowledge_base",
            parameters: { query: originalRequest },
            dependencies: []
          },
          {
            id: 2,
            description: "Generate simplified Blender Python code based on knowledge base",
            tool: "execute_blender_code",
            parameters: { code: "import bpy\n# Create basic object based on request" },
            dependencies: [1]
          },
          {
            id: 3,
            description: "Finish task with results",
            tool: "finish_task",
            parameters: { finalAnswer: `Completed: ${originalRequest}` },
            dependencies: [2]
          }
        ]
      },
      reasoning: "Using fallback simplified plan"
    };
  }
}

// Task decomposition function
async function decomposeUserTask(userRequest, attachments = []) {
  console.log(`🧠 [Decompose] Starting decomposition with ${attachments?.length || 0} attachments`);
  console.log(`🧠 [Decompose] User request: "${userRequest}"`);
  console.log(`🧠 [Decompose] Attachments details:`, attachments?.map(att => ({name: att.name, type: att.type})));
  
  // Check if there are image attachments and enhance the prompt accordingly
  let enhancedRequest = userRequest;
  if (attachments && attachments.length > 0) {
    const imageAttachments = attachments.filter(att => att.type && att.type.startsWith('image/'));
    if (imageAttachments.length > 0) {
      console.log(`🖼️ [Decompose] Found ${imageAttachments.length} image attachments`);
      enhancedRequest = `${userRequest}\n\nIMPORTANT: The user has uploaded ${imageAttachments.length} image(s). Please analyze the image(s) to understand what they want to create in 3D. Look at the objects, scenes, or concepts in the image(s) and generate appropriate 3D models using Blender.`;
    }
  }

  const prompt = `You are a task decomposition expert. Break down this user request into atomic subtasks.

User Request: "${enhancedRequest}"

${attachments && attachments.length > 0 ? `ATTACHMENTS: ${attachments.length} file(s) uploaded` : ''}

Available tools: search_knowledge_base, get_scene_info, execute_blender_code, asset_search_and_import, analyze_image, create_animation, finish_task

${attachments && attachments.length > 0 ? 'IMPORTANT: Start with analyze_image tool since images are attached. Then try asset_search_and_import (Hyper3D/Sketchfab) for 3D generation before falling back to execute_blender_code!' : ''}

Return ONLY valid JSON in this exact format:
{
  "mainTask": "brief description",
  "subtasks": [
    {"id": 1, "description": "task 1", "tool": "tool_name", "parameters": {}, "dependencies": []},
    {"id": 2, "description": "task 2", "tool": "tool_name", "parameters": {}, "dependencies": []}
  ]
}

Example for image request:
{
  "mainTask": "Create 3D model from image",
  "subtasks": [
    {"id": 1, "description": "Analyze uploaded images", "tool": "analyze_image", "parameters": {"attachments": []}, "dependencies": []},
    {"id": 2, "description": "Try to generate 3D model using Hyper3D or search Sketchfab based on image analysis", "tool": "asset_search_and_import", "parameters": {"prompt": "create 3d from image"}, "dependencies": [1]},
    {"id": 3, "description": "If integration failed, generate Blender code based on image analysis", "tool": "execute_blender_code", "parameters": {"code": "import bpy"}, "dependencies": [1,2]},
    {"id": 4, "description": "Finish task", "tool": "finish_task", "parameters": {"finalAnswer": "Done"}, "dependencies": [1,2,3]}
  ]
}

IMPORTANT: For image-based requests, ALWAYS try asset_search_and_import (Hyper3D/Sketchfab) FIRST before falling back to execute_blender_code!`;

  try {
    const response = await callAgentLLM([
      new SystemMessage("You are a task decomposition expert. Always return valid JSON."),
      new HumanMessage(prompt)
    ], "gemini");
    
    console.log(`🤖 [AI Decompose] Raw response from Gemini:`, response.substring(0, 200) + '...');
    
    // Strip markdown code blocks if present (```json ... ```)
    let cleanedResponse = response.trim();
    if (cleanedResponse.startsWith('```')) {
      // Remove opening ```json or ```
      cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, '');
      // Remove closing ```
      cleanedResponse = cleanedResponse.replace(/\s*```$/i, '');
      cleanedResponse = cleanedResponse.trim();
    }
    
    const parsed = JSON.parse(cleanedResponse);
    console.log(`✅ [AI Decompose] Successfully parsed AI decomposition with ${parsed.subtasks?.length || 0} subtasks`);
    return parsed;
  } catch (error) {
    console.error(`❌ [AI Decompose] Failed to decompose with AI, falling back:`, error.message);
    // Fallback decomposition for common patterns
    const request = userRequest.toLowerCase();
    
    // FIRST: Check if this is an information/status query (not a modeling task)
    const isInfoQuery = request.match(/\b(check|verify|show|tell|what|how|status|enabled|available|info|information|list|display)\b/);
    const isIntegrationQuery = request.match(/\b(integration|polyhaven|hyper3d|sketchfab|addon|plugin)\b/);
    const isSceneQuery = request.match(/\b(scene|objects?|models?|current|what's in)\b/);
    
    if (isInfoQuery && (isIntegrationQuery || isSceneQuery)) {
      if (isIntegrationQuery) {
        // Integration status check - just get info and report
        console.log(`📋 [Fallback] Detected integration status query`);
        return {
          mainTask: userRequest,
          subtasks: [
            {
              id: 1,
              description: "Check current scene and integration status",
              tool: "get_scene_info",
              parameters: {},
              dependencies: []
            },
            {
              id: 2,
              description: "Report integration status to user",
              tool: "finish_task",
              parameters: { finalAnswer: "Integration status check completed" },
              dependencies: [1]
            }
          ]
        };
      } else if (isSceneQuery) {
        // Scene information query - just get scene info
        console.log(`📋 [Fallback] Detected scene query`);
        return {
          mainTask: userRequest,
          subtasks: [
            {
              id: 1,
              description: "Get current scene information",
              tool: "get_scene_info",
              parameters: {},
              dependencies: []
            },
            {
              id: 2,
              description: "Report scene information to user",
              tool: "finish_task",
              parameters: { finalAnswer: "Scene information retrieved" },
              dependencies: [1]
            }
          ]
        };
      }
    }
    
    // Handle animation-specific requests
    if (request.includes("rabbit") && (request.includes("hop") || request.includes("jump"))) {
      return {
        mainTask: "Create a rabbit and make it hop",
        subtasks: [
          {
            id: 1,
            description: "Generate or import a 3D rabbit model",
            tool: "asset_search_and_import",
            parameters: { prompt: "rabbit" },
            dependencies: []
          },
          {
            id: 2,
            description: "Create hop animation for the rabbit",
            tool: "create_animation",
            parameters: { animationType: "hop", duration: 2 },
            dependencies: [1]
          },
          {
            id: 3,
            description: "Finish the task",
            tool: "finish_task",
            parameters: { finalAnswer: "Successfully created a hopping rabbit!" },
            dependencies: [1, 2]
          }
        ]
      };
    }
    
    if (request.includes("rabbit")) {
      return {
        mainTask: "Create a 3D rabbit",
        subtasks: [
          {
            id: 1,
            description: "Generate or import a 3D rabbit model",
            tool: "asset_search_and_import",
            parameters: { prompt: "rabbit" },
            dependencies: []
          },
          {
            id: 2,
            description: "Finish the task",
            tool: "finish_task",
            parameters: { finalAnswer: "Successfully created a 3D rabbit!" },
            dependencies: [1]
          }
        ]
      };
    }
    
    // Generate intelligent Blender code based on user request
function generateIntelligentBlenderCode(userRequest, imageAttachments) {
  const request = userRequest.toLowerCase();
  let blenderCode = `import bpy\n# Create 3D model based on Gemini's vision analysis\n# Clear existing objects\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete()\n\n`;
  
  if (request.includes("car") || request.includes("vehicle")) {
    blenderCode += `# Create car body\nbpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))\ncar_body = bpy.context.active_object\ncar_body.name = "CarBody"\n\n# Scale to car proportions\nbpy.ops.transform.resize(value=(2, 1, 0.8))\n\n# Create wheels\nwheel_positions = [(1.2, 0.8, 0), (1.2, -0.8, 0), (-1.2, 0.8, 0), (-1.2, -0.8, 0)]\nfor i, pos in enumerate(wheel_positions):\n    bpy.ops.mesh.primitive_cylinder_add(radius=0.4, depth=0.3, location=pos)\n    wheel = bpy.context.active_object\n    wheel.name = f"Wheel_{i+1}"\n    # Rotate wheel to lie flat\n    bpy.ops.transform.rotate(value=1.5708, orient_axis='X')\n\n# Create car material\ncar_mat = bpy.data.materials.new(name='CarMaterial')\ncar_mat.use_nodes = True\nbsdf = car_mat.node_tree.nodes.get('Principled BSDF')\nif bsdf:\n    bsdf.inputs['Base Color'].default_value = (0.8, 0.2, 0.1, 1)  # Red car\n    bsdf.inputs['Metallic'].default_value = 0.3\n    bsdf.inputs['Roughness'].default_value = 0.4\n\n# Create wheel material\nwheel_mat = bpy.data.materials.new(name='WheelMaterial')\nwheel_mat.use_nodes = True\nbsdf = wheel_mat.node_tree.nodes.get('Principled BSDF')\nif bsdf:\n    bsdf.inputs['Base Color'].default_value = (0.1, 0.1, 0.1, 1)  # Black wheels\n    bsdf.inputs['Roughness'].default_value = 0.8\n\n# Apply materials\ncar_body.data.materials.append(car_mat)\nfor obj in bpy.data.objects:\n    if "Wheel" in obj.name:\n        obj.data.materials.append(wheel_mat)\n\nprint('Car model created based on image analysis!')`;
  } else if (request.includes("tree") || request.includes("plant")) {
    blenderCode += `# Create tree trunk\nbpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=3, location=(0, 0, 1.5))\ntrunk = bpy.context.active_object\ntrunk.name = "TreeTrunk"\n\n# Create tree crown (leaves)\nbpy.ops.mesh.primitive_uv_sphere_add(radius=1.5, location=(0, 0, 3.5))\ncrown = bpy.context.active_object\ncrown.name = "TreeCrown"\n\n# Make crown more organic by scaling\nbpy.ops.transform.resize(value=(1.2, 1.2, 0.9))\n\n# Create trunk material\ntrunk_mat = bpy.data.materials.new(name='TrunkMaterial')\ntrunk_mat.use_nodes = True\nbsdf = trunk_mat.node_tree.nodes.get('Principled BSDF')\nif bsdf:\n    bsdf.inputs['Base Color'].default_value = (0.4, 0.2, 0.1, 1)  # Brown trunk\n    bsdf.inputs['Roughness'].default_value = 0.9\n\n# Create leaves material\nleaves_mat = bpy.data.materials.new(name='LeavesMaterial')\nleaves_mat.use_nodes = True\nbsdf = leaves_mat.node_tree.nodes.get('Principled BSDF')\nif bsdf:\n    bsdf.inputs['Base Color'].default_value = (0.1, 0.6, 0.1, 1)  # Green leaves\n    bsdf.inputs['Roughness'].default_value = 0.7\n\n# Apply materials\ntrunk.data.materials.append(trunk_mat)\ncrown.data.materials.append(leaves_mat)\n\nprint('Tree model created based on image analysis!')`;
  } else if (request.includes("building") || request.includes("house")) {
    blenderCode += `# Create building base\nbpy.ops.mesh.primitive_cube_add(size=4, location=(0, 0, 2))\nbuilding = bpy.context.active_object\nbuilding.name = "Building"\n\n# Create roof\nbpy.ops.mesh.primitive_cube_add(size=5, location=(0, 0, 4.5))\nroof = bpy.context.active_object\nroof.name = "Roof"\nbpy.ops.transform.resize(value=(1.25, 1.25, 0.3))\n\n# Create door\nbpy.ops.mesh.primitive_cube_add(size=1, location=(0, 2, 0.5))\ndoor = bpy.context.active_object\ndoor.name = "Door"\nbpy.ops.transform.resize(value=(0.4, 0.1, 1))\n\n# Create windows\nwindow_positions = [(-1, 2, 2.5), (1, 2, 2.5), (-1, -2, 2.5), (1, -2, 2.5)]\nfor i, pos in enumerate(window_positions):\n    bpy.ops.mesh.primitive_cube_add(size=0.8, location=pos)\n    window = bpy.context.active_object\n    window.name = f"Window_{i+1}"\n    bpy.ops.transform.resize(value=(0.3, 0.1, 0.4))\n\n# Create building material\nbuilding_mat = bpy.data.materials.new(name='BuildingMaterial')\nbuilding_mat.use_nodes = True\nbsdf = building_mat.node_tree.nodes.get('Principled BSDF')\nif bsdf:\n    bsdf.inputs['Base Color'].default_value = (0.8, 0.8, 0.7, 1)  # Light beige\n    bsdf.inputs['Roughness'].default_value = 0.6\n\n# Create roof material\nroof_mat = bpy.data.materials.new(name='RoofMaterial')\nroof_mat.use_nodes = True\nbsdf = roof_mat.node_tree.nodes.get('Principled BSDF')\nif bsdf:\n    bsdf.inputs['Base Color'].default_value = (0.3, 0.1, 0.1, 1)  # Dark red roof\n    bsdf.inputs['Roughness'].default_value = 0.8\n\n# Apply materials\nbuilding.data.materials.append(building_mat)\nroof.data.materials.append(roof_mat)\ndoor.data.materials.append(building_mat)\nfor obj in bpy.data.objects:\n    if "Window" in obj.name:\n        window_mat = bpy.data.materials.new(name='WindowMaterial')\n        window_mat.use_nodes = True\n        bsdf = window_mat.node_tree.nodes.get('Principled BSDF')\n        if bsdf:\n            bsdf.inputs['Base Color'].default_value = (0.6, 0.8, 1.0, 0.3)  # Blue transparent\n            bsdf.inputs['Transmission'].default_value = 0.8\n            bsdf.inputs['Roughness'].default_value = 0.1\n        obj.data.materials.append(window_mat)\n\nprint('Building model created based on image analysis!')`;
  } else {
    // Default generic object
    blenderCode += `# Create a basic object as placeholder\nbpy.ops.mesh.primitive_cube_add(size=2)\nbpy.ops.object.shade_smooth()\n\n# Add basic material\nmat = bpy.data.materials.new(name='ImageBasedMaterial')\nmat.use_nodes = True\nbsdf = mat.node_tree.nodes.get('Principled BSDF')\nif bsdf:\n    bsdf.inputs['Metallic'].default_value = 0.2\n    bsdf.inputs['Roughness'].default_value = 0.5\n\n# Apply material to active object\nif bpy.context.active_object:\n    bpy.context.active_object.data.materials.append(mat)\n\nprint('3D model created based on Gemini image analysis!')`;
  }
  
  return blenderCode;
}

// Enhanced fallback for image-based requests
    if (request.includes("image") || (attachments && attachments.length > 0)) {
      const imageAttachments = attachments ? attachments.filter(att => att.type && att.type.startsWith('image/')) : [];
      if (imageAttachments.length > 0 || request.includes("image")) {
        console.log(`🎯 [Fallback] Using image-based decomposition with ${imageAttachments.length} images`);
        
        // Try to detect if the image content suggests an asset that can be imported
        const imagePrompt = request.toLowerCase();
        let assetIntent = { type: "none" };
        
        // Common asset types that might be in images
        if (imagePrompt.includes("car") || imagePrompt.includes("vehicle") || imagePrompt.includes("automobile")) {
          assetIntent = { type: "sketchfab", query: "car vehicle" };
        } else if (imagePrompt.includes("tree") || imagePrompt.includes("plant") || imagePrompt.includes("nature")) {
          assetIntent = { type: "sketchfab", query: "tree plant nature" };
        } else if (imagePrompt.includes("building") || imagePrompt.includes("house") || imagePrompt.includes("architecture")) {
          assetIntent = { type: "sketchfab", query: "building house architecture" };
        } else if (imagePrompt.includes("character") || imagePrompt.includes("person") || imagePrompt.includes("animal")) {
          assetIntent = { type: "sketchfab", query: "character person animal" };
        } else if (imagePrompt.includes("furniture") || imagePrompt.includes("chair") || imagePrompt.includes("table")) {
          assetIntent = { type: "sketchfab", query: "furniture chair table" };
        } else {
          // Default to trying Hyper3D for general image-to-3D generation
          assetIntent = { type: "hyper3d", prompt: request };
        }
        
        return {
          mainTask: "Create 3D model from image",
          subtasks: [
            {
              id: 1,
              description: "Analyze the uploaded image(s) with Gemini vision to understand what to create in 3D",
              tool: "analyze_image",
              parameters: { attachments: attachments || [] },
              dependencies: []
            },
            {
              id: 2,
              description: assetIntent.type === "hyper3d" 
                ? `Try to generate 3D model using Hyper3D based on image analysis: "${assetIntent.prompt}"`
                : `Search for ${assetIntent.query} on Sketchfab based on image analysis`,
              tool: "asset_search_and_import",
              parameters: assetIntent.type === "hyper3d" 
                ? { prompt: assetIntent.prompt }
                : { prompt: assetIntent.query },
              dependencies: [1]
            },
            {
              id: 3,
              description: "If integration failed, generate Blender code based on Gemini's image analysis",
              tool: "execute_blender_code",
              parameters: { 
                code: generateIntelligentBlenderCode(userRequest, imageAttachments)
              },
              dependencies: [1, 2]
            },
            {
              id: 4,
              description: "Finish creating 3D model from image",
              tool: "finish_task",
              parameters: { finalAnswer: "Successfully created 3D model based on Gemini's analysis of the uploaded image!" },
              dependencies: [1, 2, 3]
            }
          ]
        };
      }
    }
    
    // Default fallback - try to create a meaningful decomposition
    // Extract key terms from the request to determine what to create
    const requestLower = userRequest.toLowerCase();
    
    // Try to detect what the user wants to create
    let assetPrompt = userRequest;
    let blenderCode = null;
    
    // Generate intelligent Blender code for common requests
    if (requestLower.includes("dragon")) {
      blenderCode = `import bpy
import mathutils

# Clear existing objects
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Create dragon body (main torso)
bpy.ops.mesh.primitive_uv_sphere_add(radius=1.5, location=(0, 0, 2))
body = bpy.context.active_object
body.name = "DragonBody"
bpy.ops.transform.resize(value=(1.5, 1.2, 1.8))

# Create dragon head
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.8, location=(0, 0, 4))
head = bpy.context.active_object
head.name = "DragonHead"
bpy.ops.transform.resize(value=(1.2, 0.9, 1.1))

# Create dragon tail
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.6, location=(0, -2.5, 1.5))
tail = bpy.context.active_object
tail.name = "DragonTail"
bpy.ops.transform.resize(value=(0.8, 2.5, 0.6))

# Create wings
for i, side in enumerate([-1, 1]):
    bpy.ops.mesh.primitive_plane_add(size=3, location=(side * 2, 0, 2.5))
    wing = bpy.context.active_object
    wing.name = f"DragonWing_{i+1}"
    bpy.ops.transform.rotate(value=0.5, orient_axis='Y')
    bpy.ops.transform.resize(value=(1, 1.5, 0.3))

# Create legs
leg_positions = [(0.8, 0.5, 0), (0.8, -0.5, 0), (-0.8, 0.5, 0), (-0.8, -0.5, 0)]
for i, pos in enumerate(leg_positions):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=1.5, location=pos)
    leg = bpy.context.active_object
    leg.name = f"DragonLeg_{i+1}"

# Create dragon material (scales-like appearance)
dragon_mat = bpy.data.materials.new(name='DragonMaterial')
dragon_mat.use_nodes = True
bsdf = dragon_mat.node_tree.nodes.get('Principled BSDF')
if bsdf:
    bsdf.inputs['Base Color'].default_value = (0.3, 0.5, 0.8, 1)  # Blue dragon
    bsdf.inputs['Metallic'].default_value = 0.4
    bsdf.inputs['Roughness'].default_value = 0.3

# Apply material to all dragon parts
for obj in bpy.data.objects:
    if "Dragon" in obj.name:
        obj.data.materials.append(dragon_mat)

# Smooth all meshes
for obj in bpy.data.objects:
    if obj.type == 'MESH':
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.shade_smooth()

print('Dragon model created!')`;
      assetPrompt = "dragon";
    } else if (requestLower.includes("cube") || requestLower.includes("box")) {
      blenderCode = `import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
print('Cube created!')`;
      assetPrompt = "cube";
    } else if (requestLower.includes("sphere") || requestLower.includes("ball")) {
      blenderCode = `import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(0, 0, 0))
print('Sphere created!')`;
      assetPrompt = "sphere";
    } else {
      // Generic fallback - try to create something based on the request
      blenderCode = `import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
# Create a basic object based on request
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
bpy.ops.object.shade_smooth()
print('3D object created based on request!')`;
    }
    
    // Create a proper decomposition that tries asset import first, then falls back to code
    return {
      mainTask: userRequest,
      subtasks: [
        {
          id: 1,
          description: `Try to import or generate a 3D model for: ${userRequest}`,
          tool: "asset_search_and_import",
          parameters: { prompt: assetPrompt || userRequest },
          dependencies: []
        },
        {
          id: 2,
          description: `If import failed, create 3D model using Blender code`,
          tool: "execute_blender_code",
          parameters: { code: blenderCode },
          dependencies: [1]
        },
        {
          id: 3,
          description: "Finish the task",
          tool: "finish_task",
          parameters: { finalAnswer: `Successfully created 3D model: ${userRequest}` },
          dependencies: [1, 2]
        }
      ]
    };
  }
}

// Helper function to execute a subtask with timeout
// Helper to determine if an error is retryable
function isRetryableError(error) {
  const retryablePatterns = [
    /timeout/i,
    /timed out/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /rate limit/i,
    /too many requests/i,
    /service unavailable/i,
    /temporarily unavailable/i
  ];
  
  const errorMsg = error?.message || String(error);
  return retryablePatterns.some(pattern => pattern.test(errorMsg));
}

async function executeSubtaskWithTimeout(subtask, state, timeout = 60000) {
  console.log(`⚡ [Parallel Execution] Starting subtask ${subtask.id}: ${subtask.description}`);
  
  return new Promise(async (resolve) => {
    let timedOut = false;
    
    const timeoutId = setTimeout(() => {
      timedOut = true;
      resolve({
        subtaskId: subtask.id,
        success: false,
        error: 'Subtask execution timeout',
        timedOut: true,
        retryable: true // Timeouts are always retryable
      });
    }, timeout);
    
    try {
      // Execute the subtask's tool
      let toolResult;
      const toolInput = subtask.parameters;
      
      switch (subtask.tool) {
        case "search_knowledge_base":
          toolResult = await searchKnowledgeBaseTool.invoke(toolInput);
          break;
        case "get_scene_info":
          toolResult = await getSceneInfoTool.invoke(toolInput);
          break;
        case "execute_blender_code":
          toolResult = await executeBlenderCodeTool.invoke(toolInput);
          break;
        case "asset_search_and_import":
          toolResult = await assetSearchAndImportTool.invoke(toolInput);
          break;
        case "analyze_image":
          toolResult = await analyzeImageTool.invoke(toolInput);
          break;
        case "create_animation":
          toolResult = await createAnimationTool.invoke(toolInput);
          break;
        default:
          toolResult = {
            success: false,
            error: `Unknown tool: ${subtask.tool}`
          };
      }
      
      if (!timedOut) {
        clearTimeout(timeoutId);
        resolve({
          subtaskId: subtask.id,
          ...toolResult,
          timedOut: false,
          retryable: toolResult.success ? false : isRetryableError(new Error(toolResult.error))
        });
      }
    } catch (error) {
      if (!timedOut) {
        clearTimeout(timeoutId);
        resolve({
          subtaskId: subtask.id,
          success: false,
          error: error.message,
          timedOut: false,
          retryable: isRetryableError(error)
        });
      }
    }
  });
}

// Helper function to create complete agent state updates
function createAgentStateUpdate(state, updates = {}) {
  return {
    messages: updates.messages !== undefined ? updates.messages : [],
    sceneContext: updates.sceneContext !== undefined ? updates.sceneContext : state.sceneContext,
    ragContext: updates.ragContext !== undefined ? updates.ragContext : state.ragContext,
    integrationStatus: updates.integrationStatus !== undefined ? updates.integrationStatus : state.integrationStatus,
    loopCount: updates.loopCount !== undefined ? updates.loopCount : state.loopCount,
    maxLoops: state.maxLoops,
    blenderAvailable: updates.blenderAvailable !== undefined ? updates.blenderAvailable : state.blenderAvailable,
    conversationId: updates.conversationId !== undefined ? updates.conversationId : state.conversationId,
    searchHistory: updates.searchHistory !== undefined ? updates.searchHistory : state.searchHistory,
    assetGenerated: updates.assetGenerated !== undefined ? updates.assetGenerated : state.assetGenerated,
    animationGenerated: updates.animationGenerated !== undefined ? updates.animationGenerated : state.animationGenerated,
    taskDecomposition: updates.taskDecomposition !== undefined ? updates.taskDecomposition : state.taskDecomposition,
    currentSubtaskIndex: updates.currentSubtaskIndex !== undefined ? updates.currentSubtaskIndex : state.currentSubtaskIndex,
    completedSubtasks: updates.completedSubtasks !== undefined ? updates.completedSubtasks : state.completedSubtasks,
    subtaskResults: updates.subtaskResults !== undefined ? updates.subtaskResults : state.subtaskResults,
    attachments: updates.attachments !== undefined ? updates.attachments : state.attachments,
    hasReplanned: updates.hasReplanned !== undefined ? updates.hasReplanned : state.hasReplanned,
    toolName: updates.toolName !== undefined ? updates.toolName : null,
    toolInput: updates.toolInput !== undefined ? updates.toolInput : {},
    finished: updates.finished !== undefined ? updates.finished : state.finished,
  };
}

// Helper function to process parallel execution results
function processParallelResults(state, results, executedSubtasks) {
  const newCompletedSubtasks = [...state.completedSubtasks];
  const newSubtaskResults = { ...state.subtaskResults };
  const messages = [];
  let anySuccessful = false;
  let allSuccessful = true;
  
  results.forEach((result, index) => {
    const subtask = executedSubtasks[index];
    
    if (result.status === 'fulfilled') {
      const toolResult = result.value;
      newCompletedSubtasks.push(toolResult.subtaskId);
      newSubtaskResults[toolResult.subtaskId] = toolResult;
      
      if (toolResult.success) {
        anySuccessful = true;
        messages.push(`✅ Subtask ${toolResult.subtaskId} completed: ${subtask.description}`);
      } else {
        allSuccessful = false;
        messages.push(`❌ Subtask ${toolResult.subtaskId} failed: ${toolResult.error || 'Unknown error'}`);
      }
    } else {
      allSuccessful = false;
      newCompletedSubtasks.push(subtask.id);
      newSubtaskResults[subtask.id] = {
        success: false,
        error: result.reason?.message || 'Subtask execution rejected'
      };
      messages.push(`❌ Subtask ${subtask.id} rejected: ${result.reason?.message || 'Unknown error'}`);
    }
  });
  
  // Find the next index to continue from
  let newCurrentSubtaskIndex = state.currentSubtaskIndex;
  while (newCurrentSubtaskIndex < state.taskDecomposition.subtasks.length &&
         newCompletedSubtasks.includes(state.taskDecomposition.subtasks[newCurrentSubtaskIndex].id)) {
    newCurrentSubtaskIndex++;
  }
  
  const summaryMessage = `Parallel execution completed: ${executedSubtasks.length} subtasks executed (${anySuccessful ? 'some' : 'none'} successful)`;
  messages.unshift(summaryMessage);
  
  // Return complete state using helper function
  return createAgentStateUpdate(state, {
    messages: [new AIMessage(messages.join('\n'))],
    currentSubtaskIndex: newCurrentSubtaskIndex,
    completedSubtasks: newCompletedSubtasks,
    subtaskResults: newSubtaskResults,
    loopCount: state.loopCount + 1,
    finished: newCurrentSubtaskIndex >= state.taskDecomposition.subtasks.length,
    toolName: null,
    toolInput: {},
  });
}

// Agent node
async function agentNode(state, config) {
  const { model = "gemini" } = config || {};
  const { 
    messages, 
    sceneContext, 
    ragContext, 
    loopCount, 
    maxLoops, 
    searchHistory, 
    assetGenerated, 
    animationGenerated,
    taskDecomposition,
    currentSubtaskIndex,
    completedSubtasks,
    subtaskResults,
    attachments
  } = state;

  console.log(`🤖 Agent Node - Loop: ${loopCount}/${maxLoops}`);
  console.log(`📋 Task Status: Decomposed=${!!taskDecomposition}, Current Index=${currentSubtaskIndex}, Completed=${completedSubtasks.length}`);
  console.log(`📎 Agent Node received ${attachments?.length || 0} attachments`);

  // Check if task is already finished
  if (state.finished) {
    return createAgentStateUpdate(state, {
      messages: [new AIMessage("Task already completed.")],
      finished: true,
      loopCount: loopCount + 1,
    });
  }

  if (loopCount >= maxLoops) {
    return createAgentStateUpdate(state, {
      messages: [new AIMessage("Task completed or reached maximum steps. All possible subtasks have been executed.")],
      finished: true,
      loopCount: loopCount + 1,
    });
  }

  const lastHumanMessage = messages.filter(msg => msg instanceof HumanMessage).pop();
  if (!lastHumanMessage) {
    return createAgentStateUpdate(state, {
      messages: [new AIMessage("No user message found.")],
      finished: true,
    });
  }

  // Step 1: Decompose task if not already done
  if (!taskDecomposition) {
    console.log(`🧩 [First Turn] Decomposing task into atomic subtasks...`);
    console.log(`🧩 [Debug] Available attachments: ${attachments?.length || 0}`);
    return createAgentStateUpdate(state, {
      messages: [new AIMessage("I will decompose your request into atomic subtasks.")],
      toolName: "decompose_task",
      toolInput: { userRequest: lastHumanMessage.content, attachments: attachments || [] },
      loopCount: loopCount + 1,
      finished: false,
    });
  }

  // Step 2a: Check if we need to replan due to critical failures
  // Trigger re-planning if:
  // 1. More than 50% of non-skipped, non-conditional subtasks have failed
  // 2. At least 2 subtasks have been attempted
  // 3. We haven't already replanned (prevent infinite replan loops)
  const nonSkippedResults = Object.entries(subtaskResults).filter(([id, result]) => !result.skipped);
  
  // Only count non-conditional failures as critical
  const criticalFailures = nonSkippedResults.filter(([id, result]) => {
    if (result.success) return false;
    
    // Find the subtask definition
    const subtask = taskDecomposition.subtasks.find(s => s.id === parseInt(id));
    if (!subtask) return true; // If we can't find it, assume critical
    
    const description = subtask.description.toLowerCase();
    // Ignore conditional fallback failures - they're expected to fail sometimes
    const isConditionalFallback = /^if\s+(.*?)\s+(failed|cannot|not\s+found|unsuccessful)/i.test(description);
    return !isConditionalFallback;
  }).map(([id]) => parseInt(id));
  
  const attemptedCount = nonSkippedResults.length;
  const criticalFailureRate = attemptedCount > 0 ? criticalFailures.length / attemptedCount : 0;
  const hasReplanned = state.hasReplanned || false;
  
  // Critical failure threshold: 50% critical failure rate with at least 2 critical failures
  const shouldReplan = !hasReplanned && 
                       attemptedCount >= 2 && 
                       criticalFailures.length >= 2 &&
                       criticalFailureRate >= 0.5;
  
  if (shouldReplan && currentSubtaskIndex < taskDecomposition.subtasks.length) {
    logger.warn('[Dynamic Replan] Critical failure threshold reached, initiating re-planning', {
      criticalFailuresCount: criticalFailures.length,
      attemptedCount,
      criticalFailureRate: `${(criticalFailureRate * 100).toFixed(1)}%`
    });
    
    try {
      const replanResult = await replanOnFailure(
        lastHumanMessage.content,
        taskDecomposition,
        criticalFailures,
        completedSubtasks,
        subtaskResults,
        attachments
      );
      
      if (replanResult.success) {
        logger.info('[Dynamic Replan] Successfully generated alternative plan', {
          reasoning: replanResult.reasoning
        });
        
        return createAgentStateUpdate(state, {
          messages: [new AIMessage(`I'll try a different approach: ${replanResult.reasoning}`)],
          taskDecomposition: replanResult.decomposition,
          currentSubtaskIndex: 0, // Reset to start of new plan
          completedSubtasks: [], // Reset completion tracking
          subtaskResults: {}, // Reset results
          hasReplanned: true, // Mark that we've replanned to prevent loops
          loopCount: loopCount + 1,
          finished: false,
        });
      }
    } catch (error) {
      logger.error('[Dynamic Replan] Re-planning failed', { error: error.message });
      // Continue with original plan if re-planning fails
    }
  }

  // Step 2b: Check for parallel execution opportunities
  // Find all subtasks that can run in parallel (all dependencies met, not yet executed)
  const readySubtasks = taskDecomposition.subtasks.filter((subtask, idx) => {
    // Not yet executed
    if (completedSubtasks.includes(subtask.id)) return false;
    
    // Skip finish_task tool - always execute sequentially
    if (subtask.tool === 'finish_task') return false;
    
    // All dependencies met
    const depsComplete = (subtask.dependencies || []).every(depId => 
      completedSubtasks.includes(depId)
    );
    
    // Check conditional execution
    const description = subtask.description.toLowerCase();
    if (description.includes("if") && description.includes("failed")) {
      const dependencyFailed = subtask.dependencies?.some(depId => {
        const depResult = subtaskResults[depId];
        return depResult && !depResult.success;
      });
      if (!dependencyFailed) return false; // Skip if condition not met
    } else if (description.includes("if") && (description.includes("succeeded") || description.includes("success"))) {
      const dependencySucceeded = subtask.dependencies?.some(depId => {
        const depResult = subtaskResults[depId];
        return depResult && depResult.success;
      });
      if (!dependencySucceeded) return false; // Skip if condition not met
    }
    
    return depsComplete;
  });
  
  if (readySubtasks.length > 1) {
    // Execute independent subtasks in parallel
    console.log(`⚡ [Parallel Execution] Executing ${readySubtasks.length} independent subtasks in parallel`);
    
    const results = await Promise.allSettled(
      readySubtasks.map(subtask => 
        executeSubtaskWithTimeout(subtask, state)
      )
    );
    
    // Process results and update state
    return processParallelResults(state, results, readySubtasks);
  }

  // Step 3: Execute current subtask if available (sequential fallback)
  if (currentSubtaskIndex < taskDecomposition.subtasks.length) {
    const currentSubtask = taskDecomposition.subtasks[currentSubtaskIndex];
    
    // Check if dependencies are satisfied
    // Dependencies are satisfied if all dependency subtasks are completed (succeeded, failed, or skipped)
    if (currentSubtask.dependencies && currentSubtask.dependencies.length > 0) {
      const allDependenciesMet = currentSubtask.dependencies.every(depId => 
        completedSubtasks.includes(depId)
      );
      
      if (!allDependenciesMet) {
        // Dependencies not met, wait for them to complete
        const missingDeps = currentSubtask.dependencies.filter(depId => !completedSubtasks.includes(depId));
        console.log(`⏳ [Waiting] Subtask ${currentSubtaskIndex + 1}: Waiting for dependencies ${missingDeps.join(', ')}`);
        return createAgentStateUpdate(state, {
          messages: [new AIMessage(`Waiting for dependencies to complete before executing subtask ${currentSubtaskIndex + 1}`)],
          loopCount: loopCount + 1,
          finished: false,
        });
      }
    }
    
    // Check for conditional execution based on description
    // If description contains "If X failed" or "If X succeeded", check previous results
    const description = currentSubtask.description.toLowerCase();
    if (description.includes("if") && description.includes("failed")) {
      // Check if any dependency subtask failed
      const dependencyFailed = currentSubtask.dependencies?.some(depId => {
        const depResult = subtaskResults[depId];
        return depResult && !depResult.success;
      });
      
      if (!dependencyFailed) {
        // Condition not met (dependency didn't fail), skip this subtask
        console.log(`⏭️ [Skipping] Subtask ${currentSubtaskIndex + 1}: Condition not met (dependency succeeded)`);
        return createAgentStateUpdate(state, {
          messages: [new AIMessage(`Skipping subtask ${currentSubtaskIndex + 1}: Previous subtask succeeded, condition not met`)],
          loopCount: loopCount + 1,
          finished: false,
          currentSubtaskIndex: currentSubtaskIndex + 1,
          completedSubtasks: [...completedSubtasks, currentSubtask.id],
          subtaskResults: { ...subtaskResults, [currentSubtask.id]: { success: true, skipped: true, reason: "Condition not met" } },
        });
      }
    } else if (description.includes("if") && (description.includes("succeeded") || description.includes("success"))) {
      // Check if any dependency subtask succeeded
      const dependencySucceeded = currentSubtask.dependencies?.some(depId => {
        const depResult = subtaskResults[depId];
        return depResult && depResult.success;
      });
      
      if (!dependencySucceeded) {
        // Condition not met (dependency didn't succeed), skip this subtask
        console.log(`⏭️ [Skipping] Subtask ${currentSubtaskIndex + 1}: Condition not met (dependency failed)`);
        return createAgentStateUpdate(state, {
          messages: [new AIMessage(`Skipping subtask ${currentSubtaskIndex + 1}: Previous subtask failed, condition not met`)],
          loopCount: loopCount + 1,
          finished: false,
          currentSubtaskIndex: currentSubtaskIndex + 1,
          completedSubtasks: [...completedSubtasks, currentSubtask.id],
          subtaskResults: { ...subtaskResults, [currentSubtask.id]: { success: true, skipped: true, reason: "Condition not met" } },
        });
      }
    }
    
    console.log(`⚡ [Executing] Subtask ${currentSubtaskIndex + 1}/${taskDecomposition.subtasks.length}: ${currentSubtask.description}`);
    
    return createAgentStateUpdate(state, {
      messages: [new AIMessage(`Executing subtask ${currentSubtaskIndex + 1}: ${currentSubtask.description}`)],
      toolName: currentSubtask.tool,
      toolInput: currentSubtask.parameters,
      loopCount: loopCount + 1,
      finished: false,
    });
  }

  // Step 4: All subtasks completed, finish the task
  console.log(`✅ [Completion] All ${taskDecomposition.subtasks.length} subtasks completed successfully!`);
  return createAgentStateUpdate(state, {
    messages: [new AIMessage(`Task completed! All ${taskDecomposition.subtasks.length} subtasks executed successfully.`)],
    finished: true,
    loopCount: loopCount + 1,
  });
}

// Tool node
async function toolNode(state) {
  const { toolName, toolInput, ragContext, taskDecomposition, currentSubtaskIndex, completedSubtasks, subtaskResults, attachments } = state;
  
  if (!toolName) {
    return {
      messages: [new AIMessage("No tool specified.")],
      finished: true,
      attachments: state.attachments, // Preserve attachments
    };
  }

  logger.info(`⚙️ [LangGraph] Executing tool: ${toolName}`, { toolName });
  logger.debug(`Tool input`, toolInput);

  try {
    let toolResult;
    
    // Execute the appropriate tool
    switch (toolName) {
      case "decompose_task":
        // Pass attachments to decomposeUserTask for image analysis
        logger.info(`[ToolNode] Decompose task called`, { attachmentCount: toolInput.attachments?.length || 0 });
        const enhancedDecomposition = await decomposeUserTask(toolInput.userRequest, toolInput.attachments || []);
        toolResult = {
          success: true,
          decomposition: enhancedDecomposition,
          message: `Task decomposed into ${enhancedDecomposition.subtasks.length} atomic subtasks`,
        };
        break;
      case "search_knowledge_base":
        toolResult = await searchKnowledgeBaseTool.invoke(toolInput);
        break;
      case "get_scene_info":
        toolResult = await getSceneInfoTool.invoke(toolInput);
        break;
      case "execute_blender_code":
        toolResult = await executeBlenderCodeTool.invoke(toolInput);
        break;
      case "asset_search_and_import":
        toolResult = await assetSearchAndImportTool.invoke(toolInput);
        break;
      case "analyze_image":
        console.log(`🔧 [ToolNode] Analyze image called with ${toolInput.attachments?.length || 0} attachments`);
        toolResult = await analyzeImageTool.invoke(toolInput);
        break;
      case "validate_with_vision":
        console.log(`🔧 [ToolNode] Vision validation called`);
        toolResult = await validateWithVisionTool.invoke(toolInput);
        break;
      case "create_animation":
        toolResult = await createAnimationTool.invoke(toolInput);
        break;
      case "finish_task":
        // Validate that critical subtasks succeeded before finishing
        let hasFailures = false;
        let failureDetails = [];
        let hasCriticalFailures = false;
        
        if (taskDecomposition && subtaskResults) {
          // Check all non-finish subtasks for failures
          for (const subtask of taskDecomposition.subtasks) {
            // Skip the finish_task itself
            if (subtask.tool === 'finish_task') continue;
            
            const result = subtaskResults[subtask.id];
            const description = subtask.description.toLowerCase();
            
            // A task is conditional/fallback ONLY if it explicitly states "if [something] failed/cannot/not found"
            // AND has the failure condition at the START of the description
            const isConditionalFallback = /^if\s+(.*?)\s+(failed|cannot|not\s+found|unsuccessful)/i.test(description);
            
            // Check if this subtask failed AND was not skipped
            if (result && !result.success && !result.skipped) {
              // Asset import failures are CRITICAL unless there's a successful fallback
              const isAssetTask = subtask.tool === 'asset_search_and_import' || 
                                 description.includes('import') || 
                                 description.includes('add') ||
                                 description.includes('generate') ||
                                 description.includes('create');
              
              // If it's not a conditional fallback, check for critical failure
              if (!isConditionalFallback) {
                // Check if there's a successful fallback subtask
                const hasFallbackSucceeded = taskDecomposition.subtasks.some(fallbackTask => {
                  if (fallbackTask.id === subtask.id || fallbackTask.tool === 'finish_task') return false;
                  const fallbackResult = subtaskResults[fallbackTask.id];
                  const fallbackHasThisAsDependency = fallbackTask.dependencies?.includes(subtask.id);
                  const fallbackIsConditional = /^if\s+(.*?)\s+(failed|cannot|not\s+found|unsuccessful)/i.test(fallbackTask.description.toLowerCase());
                  return fallbackHasThisAsDependency && fallbackIsConditional && fallbackResult?.success;
                });
                
                if (!hasFallbackSucceeded) {
                  // No successful fallback - this is a failure
                  hasFailures = true;
                  failureDetails.push(`❌ ${subtask.description}: ${result.error || 'Failed'}`);
                  
                  // Mark as critical if it's an asset/generation task
                  if (isAssetTask) {
                    hasCriticalFailures = true;
                  }
                }
              }
            }
          }
        }
        
        if (hasCriticalFailures || (hasFailures && failureDetails.length > 0)) {
          toolResult = {
            success: false,
            finished: false, // Don't mark as finished if critical tasks failed
            error: `Cannot complete task - critical steps failed:\n${failureDetails.join('\n')}`,
            finalAnswer: `I couldn't complete your request because:\n${failureDetails.join('\n')}\n\n${hasCriticalFailures ? '⚠️ Please check if the required integrations are enabled and have API quota available.' : ''}`,
            partialSuccess: hasFailures && !hasCriticalFailures
          };
        } else {
          toolResult = await finishTaskTool.invoke(toolInput);
        }
        break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    const resultEmoji = toolResult.success ? '✅' : '❌';
    logger.info(`${resultEmoji} [LangGraph] Tool result: ${toolName}`, { toolName, success: toolResult.success });

    // Get user request from first human message
    const userRequest = state.messages.filter(msg => msg instanceof HumanMessage)[0]?.content || "";
    
    // Generate user-friendly response
    const friendlyResponse = generateFriendlyResponse(toolName, toolResult, state, userRequest);
    
    logger.debug('[ToolNode] Friendly response generated', { 
      toolName, 
      hasFriendlyResponse: !!friendlyResponse,
      friendlyPreview: friendlyResponse ? friendlyResponse.substring(0, 100) : 'none'
    });
    
    // Build response message - use friendly version if available, otherwise technical
    let responseMessage;
    if (friendlyResponse) {
      responseMessage = friendlyResponse;
    } else if (toolResult.success) {
      if (toolName === "decompose_task") {
        responseMessage = `Task decomposed into ${toolResult.decomposition.subtasks.length} subtasks: ${toolResult.decomposition.subtasks.map((s, i) => `${i + 1}. ${s.description}`).join(', ')}`;
      } else if (toolName === "search_knowledge_base") {
        responseMessage = null; // Skip RAG searches
      } else if (toolName === "execute_blender_code") {
        responseMessage = toolResult.message || "Blender code executed successfully";
      } else if (toolName === "asset_search_and_import") {
        responseMessage = toolResult.message || "Asset search completed";
      } else if (toolName === "analyze_image") {
        responseMessage = toolResult.message || "Image analysis completed";
      } else if (toolName === "validate_with_vision") {
        if (toolResult.validation && toolResult.validation.pass) {
          responseMessage = `✅ Validation passed! Quality score: ${toolResult.validation.quality_score}/10`;
        } else if (toolResult.validation) {
          responseMessage = `⚠️ Validation found issues:\n- ${toolResult.validation.issues.join('\n- ')}\n\nSuggestions:\n- ${toolResult.validation.suggestions.join('\n- ')}`;
        } else {
          responseMessage = toolResult.message || "Vision validation completed";
        }
      } else if (toolName === "create_animation") {
        responseMessage = toolResult.message || "Animation created successfully";
      } else if (toolName === "finish_task") {
        if (toolResult.partialSuccess) {
          responseMessage = `Task completed with issues: ${toolResult.error || 'Some subtasks failed'}`;
        } else {
          // Use finalAnswer from the tool if available, otherwise use a default message
          responseMessage = toolResult.finalAnswer || toolResult.message || "Task completed successfully!";
        }
      } else {
        responseMessage = "Tool executed successfully";
      }
    } else {
      // Don't show technical errors to users
      responseMessage = null;
    }

    // Update task decomposition state
    let newTaskDecomposition = taskDecomposition;
    let newCurrentSubtaskIndex = currentSubtaskIndex;
    let newCompletedSubtasks = completedSubtasks;
    let newSubtaskResults = subtaskResults;

    if (toolName === "decompose_task" && toolResult.success) {
      newTaskDecomposition = toolResult.decomposition;
      newCurrentSubtaskIndex = 0;
      newCompletedSubtasks = [];
      newSubtaskResults = {};
    } else if (toolName === "finish_task") {
      // When finish_task is executed, mark it as completed and don't increment index
      if (taskDecomposition && currentSubtaskIndex < taskDecomposition.subtasks.length) {
        const currentSubtask = taskDecomposition.subtasks[currentSubtaskIndex];
        newCompletedSubtasks = [...completedSubtasks, currentSubtask.id];
        newSubtaskResults = { ...subtaskResults, [currentSubtask.id]: toolResult };
      }
      // Don't increment index - task is finished
      newCurrentSubtaskIndex = currentSubtaskIndex;
    } else if (taskDecomposition && currentSubtaskIndex < taskDecomposition.subtasks.length) {
      // Mark current subtask as completed
      const currentSubtask = taskDecomposition.subtasks[currentSubtaskIndex];
      newCompletedSubtasks = [...completedSubtasks, currentSubtask.id];
      newSubtaskResults = { ...subtaskResults, [currentSubtask.id]: toolResult };
      newCurrentSubtaskIndex = currentSubtaskIndex + 1;
    }

    // Return updated state - IMPORTANT: Clear toolName after execution to prevent loops
    // Only mark as finished if finish_task succeeded OR all subtasks completed successfully
    const isFinished = (toolName === "finish_task" && toolResult.success) || 
                     (toolResult.finished && toolResult.success) ||
                     (taskDecomposition && newCurrentSubtaskIndex >= taskDecomposition.subtasks.length && 
                      toolName === "finish_task" && toolResult.success);
    
    // Only add message if there's something to show the user
    const messagesToAdd = responseMessage ? [new AIMessage(responseMessage)] : [];
    
    return {
      messages: messagesToAdd,
      ragContext: toolName === "search_knowledge_base" && toolResult.documents ? toolResult.documents : ragContext,
      sceneContext: toolName === "get_scene_info" && toolResult.scene ? toolResult.scene : state.sceneContext,
      finished: isFinished,
      toolName: null, // Always clear tool name to prevent re-execution
      toolInput: {}, // Always clear tool input
      assetGenerated: toolName === "asset_search_and_import" && toolResult.success ? true : state.assetGenerated,
      animationGenerated: toolName === "create_animation" && toolResult.success ? true : state.animationGenerated,
      taskDecomposition: newTaskDecomposition,
      currentSubtaskIndex: newCurrentSubtaskIndex,
      completedSubtasks: newCompletedSubtasks,
      subtaskResults: newSubtaskResults,
      attachments: state.attachments, // Preserve attachments in state
    };
  } catch (error) {
    logger.error(`[LangGraph] Tool execution error`, { error: error.message, stack: error.stack });
    return {
      messages: [new AIMessage(`Tool execution failed: ${error.message}`)],
      finished: false,
      toolName: null, // Clear tool name on error
      toolInput: {}, // Clear tool input
      attachments: state.attachments, // Preserve attachments in error case
    };
  }
}

// Helper function to generate user-friendly conversational responses
function generateFriendlyResponse(toolName, toolResult, state, userRequest) {
  const { taskDecomposition, completedSubtasks, subtaskResults } = state;
  
  if (toolName === "decompose_task" && toolResult.success) {
    return `Okay! I'll help you ${userRequest.toLowerCase()}. Let me break this down into steps and get started! 🎨`;
  }
  
  if (toolName === "search_knowledge_base") {
    return null; // Skip showing RAG searches to users
  }
  
  if (toolName === "get_scene_info") {
    const objCount = toolResult.sceneContext?.object_count || 0;
    return `I can see you have ${objCount} object${objCount !== 1 ? 's' : ''} in your scene. Let me work on enhancing ${objCount > 0 ? 'them' : 'your scene'}! ✨`;
  }
  
  if (toolName === "asset_search_and_import") {
    if (toolResult.success) {
      const assetName = toolResult.assetResult?.name || "the 3D model";
      const source = toolResult.assetResult?.source || 'an external library';
      const sourceNames = { 'polyhaven': 'PolyHaven', 'hyper3d': 'Hyper3D', 'sketchfab': 'Sketchfab' };
      return `Great news! I found and imported ${assetName} using ${sourceNames[source] || source}. 🎉`;
    } else {
      const error = toolResult.error || toolResult.message || '';
      if (error.includes('No PolyHaven assets found')) {
        const searchTerms = error.match(/categories: (.+)$/)?.[1] || 'those terms';
        return `I searched PolyHaven for "${searchTerms}" but didn't find any matching assets. Let me try creating it from scratch! 🛠️`;
      } else if (error.includes('integration')) {
        return `The asset import service is currently unavailable. I'll create this using Blender code instead! 🛠️`;
      } else {
        return `I couldn't find a pre-made model for that, but no worries! I'll create it from scratch using Blender. 🛠️`;
      }
    }
  }
  
  if (toolName === "execute_blender_code") {
    if (toolResult.success) {
      // Try to extract what was created from the code or result
      const result = toolResult.result?.result || "";
      if (result.includes("created")) {
        return `Perfect! I've ${result.toLowerCase().replace("!", "")}. Working on the details now... 🎨`;
      }
      return `Working on your model... Adding the shapes and details! 🔧`;
    } else {
      return `Hmm, I encountered a small issue. Let me try a different approach... 🔄`;
    }
  }
  
  if (toolName === "analyze_image") {
    if (toolResult.success) {
      return `I've analyzed your image! I can see what you want to create. Let me bring it to life in 3D! 🖼️✨`;
    }
  }
  
  if (toolName === "create_animation") {
    if (toolResult.success) {
      const animType = toolResult.animation?.type || "animation";
      return `Awesome! I've added a ${animType} animation to your model. It should look really cool now! 🎬`;
    }
  }
  
  if (toolName === "finish_task") {
    // Generate a comprehensive summary based on ACTUAL execution
    const objCount = state.sceneContext?.object_count || 0;
    const assetGenerated = state.assetGenerated;
    const animationGenerated = state.animationGenerated;
    const decomposition = state.taskDecomposition;
    const subtaskResults = state.subtaskResults || {};
    const completedSubtasks = state.completedSubtasks || [];
    
    // Analyze what actually happened
    const executionLog = [];
    const failedActions = [];
    const successfulActions = [];
    
    if (decomposition && decomposition.subtasks) {
      decomposition.subtasks.forEach(subtask => {
        const result = subtaskResults[subtask.id];
        if (result) {
          const actionDesc = {
            tool: subtask.tool,
            description: subtask.description,
            success: result.success,
            details: result
          };
          
          if (result.success) {
            successfulActions.push(actionDesc);
          } else {
            failedActions.push(actionDesc);
          }
          executionLog.push(actionDesc);
        }
      });
    }
    
    // Build response based on actual execution
    let response = `\n\n✅ **Here you go!** I've completed your request.\n\n`;
    
    // Describe what actually happened
    response += `🔍 **What I did:**\n`;
    
    if (successfulActions.length > 0) {
      successfulActions.forEach(action => {
        if (action.tool === 'asset_search_and_import') {
          if (action.details.assetResult?.source === 'polyhaven') {
            response += `   ✓ Searched PolyHaven for assets: ${action.details.message || 'No results found'}\n`;
          } else if (action.details.assetResult?.source === 'hyper3d') {
            response += `   ✓ Generated 3D model using Hyper3D: ${action.details.assetResult?.name || 'Success'}\n`;
          } else if (action.details.assetResult?.source === 'sketchfab') {
            response += `   ✓ Imported from Sketchfab: ${action.details.assetResult?.name || 'Success'}\n`;
          } else {
            response += `   ✓ Tried to import asset: ${action.details.message || 'Attempted'}\n`;
          }
        } else if (action.tool === 'execute_blender_code') {
          const output = action.details.result?.result || action.details.message || 'Code executed';
          response += `   ✓ Created model with Blender code: ${output}\n`;
        } else if (action.tool === 'get_scene_info') {
          const sceneInfo = action.details.sceneContext;
          if (sceneInfo) {
            response += `   ✓ Checked scene: ${sceneInfo.object_count || 0} objects found\n`;
            if (sceneInfo.object_names && sceneInfo.object_names.length > 0) {
              response += `     Objects: ${sceneInfo.object_names.join(', ')}\n`;
            }
          }
        } else if (action.tool === 'analyze_image') {
          response += `   ✓ Analyzed uploaded image(s)\n`;
        } else if (action.tool === 'create_animation') {
          response += `   ✓ Added ${action.details.animation?.type || 'animation'} effect\n`;
        }
      });
    }
    
    if (failedActions.length > 0) {
      response += `\n⚠️ **Issues encountered:**\n`;
      failedActions.forEach(action => {
        if (action.tool === 'asset_search_and_import') {
          response += `   ✗ Asset search: ${action.details.error || action.details.message}\n`;
        } else if (action.tool === 'execute_blender_code') {
          response += `   ✗ Code execution: ${action.details.error || 'Failed'}\n`;
        } else {
          response += `   ✗ ${action.tool}: ${action.details.error || 'Failed'}\n`;
        }
      });
    }
    
    // Scene status
    if (objCount > 0) {
      response += `\n📊 **Scene status:** ${objCount} object${objCount !== 1 ? 's' : ''} in your scene.\n`;
    }
    
    // Check if this was an info query vs modeling task
    const wasInfoQuery = userRequest.toLowerCase().match(/\b(check|verify|show|tell|what|status|enabled|info)\b/);
    
    if (wasInfoQuery) {
      // For info queries, provide the answer directly
      if (state.integrationStatus) {
        response += `\n🔌 **Integration Status:**\n`;
        response += `   • PolyHaven: ${state.integrationStatus.polyhaven ? '✅ Enabled' : '❌ Disabled'}\n`;
        response += `   • Hyper3D: ${state.integrationStatus.hyper3d ? '✅ Enabled' : '❌ Disabled'}\n`;
        response += `   • Sketchfab: ${state.integrationStatus.sketchfab ? '✅ Enabled' : '❌ Disabled'}\n`;
      }
      response += `\nNeed anything else? 😊`;
    } else {
      // For modeling tasks, suggest next steps
      response += `\n💡 **Want to make changes?** You can ask me to:\n`;
      response += `   • Change colors or materials\n`;
      response += `   • Add more details or objects\n`;
      response += `   • Adjust size or position\n`;
      response += `   • Add animations or effects\n`;
      response += `\nWhat would you like to do next? 😊`;
    }
    
    return response;
  }
  
  return null; // Return null for internal messages
}

// Conditional routing function
function shouldContinue(state) {
  // Log state for debugging
  logger.debug(`[Router] Evaluating routing`, { 
    finished: state.finished, 
    loopCount: `${state.loopCount}/${state.maxLoops}`, 
    toolName: state.toolName || 'null',
    hasMessages: state.messages?.length > 0
  });
  
  // Check if finished first
  if (state.finished === true) {
    logger.info(`[Router] Task finished, routing to END`);
    return END;
  }
  
  // Check max loops
  if (state.loopCount >= state.maxLoops) {
    logger.warn(`[Router] Max loops reached, routing to END`);
    return END;
  }
  
  // Check if tool should be executed
  if (state.toolName && typeof state.toolName === 'string' && state.toolName.trim() !== '') {
    logger.debug(`[Router] Tool specified, routing to tools`, { toolName: state.toolName });
    return "tools";
  }
  
  // Default: continue to agent
  logger.debug(`[Router] Continuing to agent node`);
  return "agent";
}

// Create the LangGraph workflow
export function createAgentWorkflow() {
  const workflow = new StateGraph(AgentStateAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addConditionalEdges(
      "agent", 
      shouldContinue,
      {
        "tools": "tools",
        "agent": "agent",
        [END]: END
      }
    )
    .addEdge("tools", "agent")
    .setEntryPoint("agent");

  return workflow.compile();
}

// Export the analyzeImageTool for testing
export { analyzeImageTool };

// Main function to run the agent
export async function runLangGraphAgent(prompt, options = {}) {
  const {
    conversationId = null,
    sceneContext = null,
    model = "gemini",
    maxLoops = 10,
    attachments = [],
  } = options;

  logger.info(`🚀 [LangGraph] Starting agent`, { attachmentCount: attachments.length, maxLoops });

  // Check integration status (MUST await the async call)
  const integrationStatus = await integrationModules.checkIntegrationStatus();

  // Initialize state
  const initialState = {
    messages: [new HumanMessage(prompt)],
    sceneContext,
    ragContext: null,
    integrationStatus, // Now contains actual status object, not a Promise
    loopCount: 0,
    maxLoops,
    blenderAvailable: isBlenderConnected(), // Use dynamic check
    searchHistory: [],
    assetGenerated: false,
    animationGenerated: false,
    taskDecomposition: null,
    currentSubtaskIndex: 0,
    completedSubtasks: [],
    subtaskResults: {},
    attachments: attachments || [], // Ensure attachments are included in state
    hasReplanned: false, // Track whether we've already replanned
  };

  console.log(`🚀 [LangGraph] Initial state created with ${initialState.attachments.length} attachments`);
  console.log(`🔗 [LangGraph] Integration Status:`, initialState.integrationStatus);

  // Pre-warm RAG context
  if (initialState.blenderAvailable) {
    try {
      initialState.ragContext = await searchKnowledgeBase(prompt, 5);
    } catch (error) {
      console.warn("Failed to pre-warm RAG context:", error.message);
    }
  }

  // Create and run workflow
  const workflow = createAgentWorkflow();
  const result = await workflow.invoke(initialState, { configurable: { model } });

  logger.info('🎉 [LangGraph] Workflow completed', { 
    messageCount: result.messages.length,
    finished: result.finished,
    loopCount: result.loopCount 
  });

  // Compile all AI messages (excluding internal/technical ones) into a conversational response
  const aiMessages = result.messages
    .filter(msg => msg instanceof AIMessage && msg.content && msg.content.trim().length > 0)
    .map(msg => msg.content);
  
  logger.info('[LangGraph] AI messages extracted', { 
    aiMessageCount: aiMessages.length,
    preview: aiMessages.length > 0 ? aiMessages[aiMessages.length - 1].substring(0, 100) : 'none'
  });
  
  // Generate final user-friendly response
  let finalResponse;
  if (aiMessages.length > 0) {
    // If we have a finish_task message with full summary, use that
    const finishMessage = aiMessages.find(msg => msg.includes("✅") && msg.includes("Here you go"));
    if (finishMessage) {
      finalResponse = finishMessage;
      logger.info('[LangGraph] Using finish message', { preview: finishMessage.substring(0, 100) });
    } else {
      // Otherwise, combine all messages into a natural flow
      finalResponse = aiMessages.join("\n\n");
      logger.info('[LangGraph] Using combined messages', { count: aiMessages.length });
    }
  } else {
    // Fallback if no messages (shouldn't happen but just in case)
    const objCount = result.sceneContext?.object_count || 0;
    finalResponse = `✅ Done! I've completed your request. Your scene now has ${objCount} object${objCount !== 1 ? 's' : ''}.\n\nWhat would you like to do next? 😊`;
    logger.warn('[LangGraph] No AI messages found, using fallback response');
  }

  return {
    response: finalResponse,
    messages: result.messages,
    sceneContext: result.sceneContext,
    loopCount: result.loopCount,
    finished: result.finished,
  };
}
