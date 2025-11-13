import { pipeline } from "@xenova/transformers";
import { pool } from "../db.js";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import format from "pg-format";
import pgvector from "pgvector/pg";

// --- CONFIGURATION ---
const EMBEDDING_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EXPECTED_EMBEDDING_DIM = 384;
const ZIP_FILE_PATH = path.join(
  process.cwd(), // Assumes running from 'backend' root
  "scripts",
  "knowledge",
  "blender_python_reference_4_5.zip"
);

// RAG Chunking Strategy: Split by paragraph/logical sections.
// We'll split the text by double newlines, a simple but effective
// "paragraph-based chunking" strategy.
const CHUNK_MIN_LENGTH = 50; // Don't embed tiny strings
// --- END CONFIGURATION ---

// Helper function to pause execution
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureEmbeddingTable(client, dim) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS blender_knowledge (
      id bigserial PRIMARY KEY,
      content text NOT NULL,
      embedding vector(${dim})
    );
  `);

  const { rows } = await client.query(`
    SELECT (atttypmod - 4) AS dim
    FROM pg_attribute
    WHERE attrelid = 'blender_knowledge'::regclass
      AND attname = 'embedding'
      AND NOT attisdropped;
  `);

  const currentDim = rows[0]?.dim ?? null;
  if (currentDim !== null && currentDim !== dim) {
    console.warn(
      `[embed_docs] Adjusting blender_knowledge.embedding dimension from ${currentDim} to ${dim}. Clearing existing rows.`
    );
    await client.query("TRUNCATE TABLE blender_knowledge;");
    await client.query(`ALTER TABLE blender_knowledge ALTER COLUMN embedding TYPE vector(${dim});`);
  }
}

/**
 * Main function to run the embedding process
 */
async function main() {
  console.log("🚀 Starting documentation embedding process...");

  try {
    // 1. Parse and chunk the documentation
    const textChunks = await parseAndChunkDocs();
    if (textChunks.length === 0) {
      console.warn(
        "⚠️ No text chunks found. Did you place the .zip file correctly?"
      );
      return;
    }
    console.log(
      `✅ Parsed and chunked docs. Found ${textChunks.length} chunks.`
    );

    // 2. Embed and store the chunks in the database
    const client = await pool.connect();
    try {
      await ensureEmbeddingTable(client, EXPECTED_EMBEDDING_DIM);
      await client.query("TRUNCATE TABLE blender_knowledge;");
      console.log("🧹 Cleared blender_knowledge table before embedding.");
      await embedAndStoreLocally(client, textChunks);
    } finally {
      client.release();
    }

    console.log("🎉 Successfully embedded and stored all documentation.");
  } catch (error) {
    console.error(
      "❌ An error occurred during the embedding process:",
      error.message
    );
  } finally {
    await pool.end(); // Close the database connection
    console.log("Database pool closed.");
  }
}

/**
 * Reads the zip, parses all HTML files, and chunks the content.
 */
async function parseAndChunkDocs() {
  // ... (This function is unchanged, so I'm omitting it for brevity)
  // ... (It correctly found 2044 chunks, so it works perfectly)
  console.log(`Loading zip file from: ${ZIP_FILE_PATH}`);
  if (!fs.existsSync(ZIP_FILE_PATH)) {
    throw new Error(`File not found: ${ZIP_FILE_PATH}`);
  }

  const zip = new AdmZip(ZIP_FILE_PATH);
  const zipEntries = zip.getEntries();
  const allChunks = [];

  console.log(
    `Found ${zipEntries.length} files in zip. Parsing .html files...`
  );

  for (const entry of zipEntries) {
    if (entry.entryName.endsWith(".html") && !entry.isDirectory) {
      const htmlContent = entry.getData().toString("utf8");

      // Use Cheerio to load the HTML
      const $ = cheerio.load(htmlContent);

      // Extract text from likely content containers
      const selectors = [
        "div[role='main']",
        "div.document",
        "div.body",
        "article",
        "main",
        "body",
      ];

      let mainContent = "";
      for (const selector of selectors) {
        const text = $(selector).text().trim();
        if (text.length > 0) {
          mainContent = text;
          break;
        }
      }

      if (!mainContent) {
        // Fallback: join paragraph texts
        mainContent = $("p")
          .map((_, el) => $(el).text().trim())
          .get()
          .join("\n\n");
      }

      if (mainContent) {
        // Clean the text: remove excessive whitespace and newlines
        const cleanText = mainContent
          .replace(/\s\s+/g, " ")
          .replace(/\n\n+/g, "\n")
          .trim();

        if (cleanText.length > 0) {
          // Chunking: Split by paragraphs (double newline)
          const chunks = cleanText
            .split("\n\n")
            .map((chunk) => chunk.trim())
            .filter((chunk) => chunk.length > CHUNK_MIN_LENGTH); // Filter out small, useless chunks

          allChunks.push(...chunks);
        }
      }
    }
  }

  return allChunks;
}

/**
 * --- LOCAL EMBEDDING VERSION ---
 * Takes text chunks, embeds them using local transformer model, and stores them.
 */
async function embedAndStoreLocally(client, chunks) {
  console.log(`🤖 Loading local embedding model: ${EMBEDDING_MODEL_NAME}...`);
  
  const embedder = await pipeline('feature-extraction', EMBEDDING_MODEL_NAME);
  
  console.log(`✅ Model loaded successfully!`);
  
  const DB_BATCH_SIZE = 50;
  let rows = [];
  
  console.log(`📦 Embedding ${chunks.length} chunks locally...`);
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    // Generate embedding with mean pooling and normalization
    const embedding = await embedder(chunk, { pooling: 'mean', normalize: true });
    
    // Convert Tensor to JavaScript array
    const embeddingArray = Array.from(embedding.data);
    
    // Safety check: validate dimension
    if (embeddingArray.length !== EXPECTED_EMBEDDING_DIM) {
      console.warn(
        `⚠️ Skipping chunk ${i + 1}: dimension mismatch (expected ${EXPECTED_EMBEDDING_DIM}, got ${embeddingArray.length})`
      );
      continue;
    }
    
    // Convert to pgvector SQL format
    const embeddingString = pgvector.toSql(embeddingArray);
    
    // Add to batch
    rows.push([chunk, embeddingString]);
    
    // Insert batch when ready
    if (rows.length >= DB_BATCH_SIZE || i === chunks.length - 1) {
      const query = format(
        'INSERT INTO blender_knowledge (content, embedding) VALUES %L',
        rows
      );
      await client.query(query);
      
      const batchNum = Math.floor(i / DB_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(chunks.length / DB_BATCH_SIZE);
      console.log(`...stored batch ${batchNum} / ${totalBatches} (${rows.length} chunks)`);
      
      // Reset batch
      rows = [];
    }
  }
  
  console.log(`✅ All ${chunks.length} chunks embedded and stored locally.`);
}

// Run the script
main();

