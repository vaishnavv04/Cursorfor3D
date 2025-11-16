// LangGraph implementation for ReAct Agent and RAG System
import { StateGraph, END, Annotation } from "@langchain/langgraph";
import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { CohereClient } from "cohere-ai";
import pgvector from "pgvector/pg";
import { pipeline } from "@xenova/transformers";
import { getRandomGeminiKey } from './utils/simple-api-keys.js';
import { integrationModules, sendCommand, isBlenderConnected } from './integrations/index.js';
import { pool } from "./db.js";

// Initialize AI providers (reuse from server.js)
const groqClient = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const cohereClient = process.env.COHERE_API_KEY ? new CohereClient({ token: process.env.COHERE_API_KEY }) : null;

// Dynamic Gemini client creation function
async function createGeminiClient() {
  const apiKey = getRandomGeminiKey();
  return apiKey ? new GoogleGenerativeAI(apiKey) : null;
}

// Model configs
const MODEL_CONFIGS = {
  gemini: { name: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
  groq: { name: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B (Groq)" },
  cohere: { name: "command-r-plus", displayName: "Command R+ (Cohere)" },
};

// RAG / embeddings (reuse from server.js)
const EMBEDDING_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_EMBEDDING_DIM = 380;

let embedderPromise = null;
async function getEmbedder() {
  if (embedderPromise === null) {
    console.log("🤖 Loading local embedding model...");
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
    console.error(`Error checking if table exists: ${error.message}`);
    return false;
  }
}

async function searchKnowledgeBase(queryText, limit = 5) {
  console.log(`🔍 [RAG] Searching knowledge base for: "${String(queryText).slice(0, 100)}..."`);
  try {
    const queryEmbedding = await embedQuery(queryText);
    const vectorString = pgvector.toSql(queryEmbedding);
    
    // Check if we have the new table available
    const hasNewTable = await tableExists("blender_knowledge_new");
    
    // Try the new table first if it exists
    if (hasNewTable) {
      try {
        const newTableQuery = `
          SELECT content, 1 - (embedding <=> $1) AS similarity
          FROM blender_knowledge_new
          WHERE 1 - (embedding <=> $1) > 0.2
          ORDER BY similarity DESC
          LIMIT $2
        `;
        const { rows: newRows } = await pool.query(newTableQuery, [vectorString, limit]);
        if (newRows && newRows.length > 0) {
          console.log(`✅ [RAG] Found ${newRows.length} relevant documents in new table`);
          return newRows.map((r) => r.content);
        }
      } catch (newTableError) {
        console.warn(`[RAG] Error searching new table: ${newTableError.message}`);
      }
    }
    
    // Fall back to original table
    const query = `
      SELECT content, 1 - (embedding <=> $1) AS similarity
      FROM blender_knowledge
      WHERE 1 - (embedding <=> $1) > 0.2
      ORDER BY similarity DESC
      LIMIT $2
    `;
    const { rows } = await pool.query(query, [vectorString, limit]);
    console.log(`✅ [RAG] Found ${rows.length} relevant documents in original table`);
    return rows.map((r) => r.content);
  } catch (error) {
    console.error(`❌ [RAG] Knowledge base search failed:`, error?.message || error);
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
});

// Tool definitions using LangGraph's tool decorator
const searchKnowledgeBaseTool = tool(
  async ({ query }) => {
    console.log(`🔍 [LangGraph] Searching knowledge base for: "${query}"`);
    const docs = await searchKnowledgeBase(query, 5);
    return {
      success: true,
      documents: docs,
      count: docs.length,
      message: `Found ${docs.length} relevant documents for query: "${query}"`,
    };
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
    name: "get_scene_info",
    description: "Gets the current scene state from Blender.",
    schema: z.object({}),
  }
);

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
    
    try {
      const result = await sendCommand("execute_code", { code: sanitizedCode });
      if (result?.status === "error" || result?.executed === false) {
        return {
          success: false,
          error: result?.error || result?.result || "Unknown execution error",
          result: result,
        };
      }
      return {
        success: true,
        result: result,
        message: `Code executed successfully. Output: ${result?.result || "No output"}`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Code execution failed: ${error.message}`,
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
    if (!isBlenderConnected()) {
      return {
        success: false,
        error: "Blender is not connected. Cannot import assets.",
      };
    }

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

      // Use integration modules
      let assetResult;
      switch (assetIntent.type) {
        case "hyper3d":
          // Pass null for progress - Hyper3D code handles it gracefully with console.log
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
    name: "asset_search_and_import",
    description: "Searches for and imports a 3D asset from an online library (Hyper3D, Sketchfab, PolyHaven).",
    schema: z.object({
      prompt: z.string().describe("Description of the asset to search for and import"),
    }),
  }
);

const analyzeImageTool = tool(
  async ({ attachments }) => {
    console.log(`🖼️ [LangGraph] Analyzing ${attachments?.length || 0} image attachment(s) with Gemini vision`);
    
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
      // Use Gemini's vision capabilities to analyze the images
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
      
      console.log(`🧠 [Gemini Vision] Image analysis completed: ${analysis.substring(0, 100)}...`);
      
      return {
        success: true,
        analysis,
        imageCount: imageAttachments.length,
        message: `Successfully analyzed ${imageAttachments.length} image(s) with Gemini vision`,
      };
    } catch (error) {
      console.error(`❌ [Gemini Vision] Image analysis failed:`, error.message);
      
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
    console.log(`🎬 [LangGraph] Creating ${animationType} animation for: ${targetObject || 'selected objects'}`);
    
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
    console.log(`🧩 [LangGraph] Decomposing task: "${userRequest}" with ${attachments?.length || 0} attachments`);
    
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
    case "cohere": {
      if (!cohereClient) throw new Error("Cohere API not configured");
      const cohereMessages = messages.map(msg => ({
        role: msg instanceof HumanMessage ? "USER" : "CHATBOT",
        message: msg.content,
      }));
      const lastMessage = cohereMessages.pop();
      const cohereResponse = await cohereClient.chat({
        model: MODEL_CONFIGS.cohere.name,
        chatHistory: cohereMessages,
        message: lastMessage.message,
        temperature: 0.3,
      });
      response = cohereResponse.text;
      break;
    }
    default:
      throw new Error(`Unknown model: ${model}`);
  }

  return response;
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
    return {
      messages: [new AIMessage("Task already completed.")],
      finished: true,
      loopCount: loopCount + 1,
      attachments: attachments,
    };
  }

  if (loopCount >= maxLoops) {
    return {
      messages: [new AIMessage("Task completed or reached maximum steps. All possible subtasks have been executed.")],
      finished: true,
      loopCount: loopCount + 1,
      attachments: attachments, // Preserve attachments
    };
  }

  const lastHumanMessage = messages.filter(msg => msg instanceof HumanMessage).pop();
  if (!lastHumanMessage) {
    return {
      messages: [new AIMessage("No user message found.")],
      finished: true,
      attachments: attachments, // Preserve attachments
    };
  }

  // Step 1: Decompose task if not already done
  if (!taskDecomposition) {
    console.log(`🧩 [First Turn] Decomposing task into atomic subtasks...`);
    console.log(`🧩 [Debug] Available attachments: ${attachments?.length || 0}`);
    return {
      messages: [new AIMessage("I will decompose your request into atomic subtasks.")],
      toolName: "decompose_task",
      toolInput: { userRequest: lastHumanMessage.content, attachments: attachments || [] },
      loopCount: loopCount + 1,
      finished: false,
      attachments: attachments, // Preserve attachments
    };
  }

  // Step 2: Execute current subtask if available
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
        return {
          messages: [new AIMessage(`Waiting for dependencies to complete before executing subtask ${currentSubtaskIndex + 1}`)],
          loopCount: loopCount + 1,
          finished: false,
          attachments: attachments,
        };
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
        return {
          messages: [new AIMessage(`Skipping subtask ${currentSubtaskIndex + 1}: Previous subtask succeeded, condition not met`)],
          loopCount: loopCount + 1,
          finished: false,
          currentSubtaskIndex: currentSubtaskIndex + 1,
          completedSubtasks: [...completedSubtasks, currentSubtask.id], // Mark as skipped
          subtaskResults: { ...subtaskResults, [currentSubtask.id]: { success: true, skipped: true, reason: "Condition not met" } },
          attachments: attachments,
        };
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
        return {
          messages: [new AIMessage(`Skipping subtask ${currentSubtaskIndex + 1}: Previous subtask failed, condition not met`)],
          loopCount: loopCount + 1,
          finished: false,
          currentSubtaskIndex: currentSubtaskIndex + 1,
          completedSubtasks: [...completedSubtasks, currentSubtask.id], // Mark as skipped
          subtaskResults: { ...subtaskResults, [currentSubtask.id]: { success: true, skipped: true, reason: "Condition not met" } },
          attachments: attachments,
        };
      }
    }
    
    console.log(`⚡ [Executing] Subtask ${currentSubtaskIndex + 1}/${taskDecomposition.subtasks.length}: ${currentSubtask.description}`);
    
    return {
      messages: [new AIMessage(`Executing subtask ${currentSubtaskIndex + 1}: ${currentSubtask.description}`)],
      toolName: currentSubtask.tool,
      toolInput: currentSubtask.parameters,
      loopCount: loopCount + 1,
      finished: false,
      attachments: attachments, // Preserve attachments
    };
  }

  // Step 3: All subtasks completed, finish the task
  console.log(`✅ [Completion] All ${taskDecomposition.subtasks.length} subtasks completed successfully!`);
  return {
    messages: [new AIMessage(`Task completed! All ${taskDecomposition.subtasks.length} subtasks executed successfully.`)],
    finished: true,
    loopCount: loopCount + 1,
    attachments: attachments, // Preserve attachments
  };
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

  console.log(`🔧 [LangGraph] Executing tool: ${toolName}`);
  console.log(`🔍 [Debug] Tool input:`, toolInput);

  try {
    let toolResult;
    
    // Execute the appropriate tool
    switch (toolName) {
      case "decompose_task":
        // Pass attachments to decomposeUserTask for image analysis
        console.log(`🔧 [ToolNode] Decompose task called with ${toolInput.attachments?.length || 0} attachments`);
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
      case "create_animation":
        toolResult = await createAnimationTool.invoke(toolInput);
        break;
      case "finish_task":
        toolResult = await finishTaskTool.invoke(toolInput);
        break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    console.log(`✅ [LangGraph] Tool result:`, toolResult);

    // Build response message based on tool result
    let responseMessage;
    if (toolResult.success) {
      if (toolName === "decompose_task") {
        responseMessage = `Task decomposed into ${toolResult.decomposition.subtasks.length} subtasks: ${toolResult.decomposition.subtasks.map((s, i) => `${i + 1}. ${s.description}`).join(', ')}`;
      } else if (toolName === "search_knowledge_base") {
        responseMessage = `Found ${toolResult.documents?.length || 0} relevant documents`;
      } else if (toolName === "execute_blender_code") {
        responseMessage = toolResult.message || "Blender code executed successfully";
      } else if (toolName === "asset_search_and_import") {
        responseMessage = toolResult.message || "Asset search completed";
      } else if (toolName === "analyze_image") {
        responseMessage = toolResult.message || "Image analysis completed";
      } else if (toolName === "create_animation") {
        responseMessage = toolResult.message || "Animation created successfully";
      } else if (toolName === "finish_task") {
        responseMessage = toolResult.message || "Task completed";
      } else {
        responseMessage = "Tool executed successfully";
      }
    } else {
      responseMessage = `Tool execution failed: ${toolResult.error || toolResult.message || "Unknown error"}`;
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
    const isFinished = toolName === "finish_task" || toolResult.finished || 
                     (taskDecomposition && newCurrentSubtaskIndex >= taskDecomposition.subtasks.length && toolResult.success);
    
    return {
      messages: [new AIMessage(responseMessage)],
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
    console.error(`❌ [LangGraph] Tool execution error:`, error.message);
    return {
      messages: [new AIMessage(`Tool execution failed: ${error.message}`)],
      finished: false,
      toolName: null, // Clear tool name on error
      toolInput: {}, // Clear tool input
      attachments: state.attachments, // Preserve attachments in error case
    };
  }
}

// Conditional routing function
function shouldContinue(state) {
  if (state.finished) {
    return END;
  }
  if (state.loopCount >= state.maxLoops) {
    return END;
  }
  if (state.toolName) {
    return "tools";
  }
  return "agent";
}

// Create the LangGraph workflow
export function createAgentWorkflow() {
  const workflow = new StateGraph(AgentStateAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addConditionalEdges("agent", shouldContinue, ["tools", END])
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

  console.log(`🚀 [LangGraph] Starting agent with ${attachments.length} attachments`);

  // Initialize state
  const initialState = {
    messages: [new HumanMessage(prompt)],
    sceneContext,
    ragContext: null,
    integrationStatus: integrationModules.checkIntegrationStatus(), // Use dynamic check
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

  return {
    response: result.messages[result.messages.length - 1]?.content || "No response generated.",
    messages: result.messages,
    sceneContext: result.sceneContext,
    loopCount: result.loopCount,
    finished: result.finished,
  };
}
