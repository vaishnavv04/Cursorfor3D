import dotenv from "dotenv";
import pg from "pg";
const { Pool } = pg;

dotenv.config();

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URI;

// Note: Our model outputs 384 dims but current table is 380, so we're adapting to the existing data
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 380);

if (!connectionString) {
  throw new Error(
    "DATABASE_URL (or DATABASE_URI) environment variable is required for authentication and chat persistence."
  );
}

const isSupabase = /supabase/i.test(connectionString);
const pool = new Pool({
  connectionString,
  max: 20, // maximum pool size
  idleTimeoutMillis: 30000, // close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // return an error after 2 seconds if connection could not be established
  // Add SSL for production
  ssl: process.env.NODE_ENV === 'production' || isSupabase 
    ? { rejectUnauthorized: false } 
    : false,
});

// --- FIX: Prevents unhandled errors on idle clients from crashing the app ---
// This will catch background errors from the pool (like server shutdowns)
// and log them instead of letting them become a fatal unhandled event.
pool.on("error", (err) => {
  console.error("[pg-pool] Unhandled error on idle client", err);
});
// -------------------------------------------------------------------------

function mapConversation(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSceneContext: row.last_scene_context || null,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    provider: row.provider || null,
    blenderResult: row.blender_result || null,
    sceneContext: row.scene_context || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

async function handleEmbeddingMismatch(client, currentDim, totalRows) {
  // If there's a mismatch in dimensions and we have data
  if (currentDim !== null && currentDim !== EMBEDDING_DIM && totalRows > 0) {
    console.warn(`[db] Embedding dimension mismatch: table=${currentDim}, expected=${EMBEDDING_DIM}`);
    console.warn(`[db] Creating a new table with the correct dimension and will use that instead`);
    
    try {
      // Create a new table with the correct dimensions
      await client.query(`
        CREATE TABLE IF NOT EXISTS blender_knowledge_new (
          id bigserial PRIMARY KEY,
          content text NOT NULL,
          embedding vector(${EMBEDDING_DIM})
        );
      `);
      
      // Create index on the new table
      await client.query(`CREATE INDEX IF NOT EXISTS idx_blender_knowledge_new_embedding ON blender_knowledge_new USING ivfflat (embedding vector_cosine_ops);`);
      
      console.log(`[db] Created blender_knowledge_new table with correct embedding dimension ${EMBEDDING_DIM}`);
      console.log(`[db] ⚠️ NOTE: You will need to re-embed content into this new table`);
      console.log(`[db] ⚠️ Original data in blender_knowledge remains untouched`);
      
      return "new_table";
    } catch (err) {
      console.error(`[db] Failed to create new knowledge table: ${err.message}`);
      return "use_existing";
    }
  }
  return "ok";
}

async function initSchema() {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new Error(
      `Database connection failed: ${err.message}. Please check your DATABASE_URL and network connectivity.`
    );
  }
  try {
    console.log("📊 Initializing database schema...");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
    // Also ensure pgvector is enabled, as we created the table for it.
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");

    await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          display_name TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT 'New Scene',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_scene_context JSONB
        );
      `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
          content TEXT,
          provider TEXT,
          blender_result JSONB,
          scene_context JSONB,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

    // Create the knowledge table with the current embedding dimension
    await client.query(`
      CREATE TABLE IF NOT EXISTS blender_knowledge (
        id bigserial PRIMARY KEY,
        content text NOT NULL,
        embedding vector(${EMBEDDING_DIM})
      );
    `);

    // Check the current dimension of the embedding column
    const { rows: embeddingColumn } = await client.query(`
      SELECT (atttypmod - 4) AS dim
      FROM pg_attribute
      WHERE attrelid = 'blender_knowledge'::regclass
        AND attname = 'embedding'
        AND NOT attisdropped;
    `);

    const currentDim = embeddingColumn[0]?.dim ?? null;
    let totalRows = 0;
    
    try {
      const { rows: cntRows } = await client.query("SELECT COUNT(1) AS c FROM blender_knowledge;");
      totalRows = Number(cntRows[0]?.c || 0);
      console.log(`[db] Embeddings info: env_dim=${EMBEDDING_DIM}, table_dim=${currentDim ?? 'n/a'}, rows=${totalRows}`);
    } catch (e) {
      console.log(`[db] Embeddings info: env_dim=${EMBEDDING_DIM}, table_dim=${currentDim ?? 'n/a'}, rows=?`);
    }
    
    if (currentDim !== null && currentDim !== EMBEDDING_DIM) {
      console.warn(
        `[db] Detected blender_knowledge.embedding dimension ${currentDim} != ${EMBEDDING_DIM}. Skipping auto-migration to avoid data loss.`
      );
      
      // Handle the dimension mismatch
      const result = await handleEmbeddingMismatch(client, currentDim, totalRows);
      
      if (result === "use_existing") {
        console.log("[db] Will use existing table with mismatched dimensions");
      }
      
      // If table is empty, we can alter the column
      if (totalRows === 0) {
        try {
          await client.query(`ALTER TABLE blender_knowledge ALTER COLUMN embedding TYPE vector(${EMBEDDING_DIM});`);
          console.log(`[db] Column embedding dimension set to ${EMBEDDING_DIM} (table was empty).`);
        } catch (e) {
          console.warn("[db] Dimension check/alter skipped:", e?.message || e);
        }
      }
    }

    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at DESC);"
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at ASC);"
    );
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Database health check function
 * @returns {Promise<boolean>} True if database is healthy, false otherwise
 */
async function checkDatabaseHealth() {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    return true;
  } catch (err) {
    console.error('Database health check failed:', err);
    return false;
  }
}

export { pool, initSchema, mapConversation, mapMessage, checkDatabaseHealth };
