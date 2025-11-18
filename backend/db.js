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

    // API usage / cost tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id bigserial PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        provider TEXT,
        model TEXT,
        usage JSONB,
        cost_usd NUMERIC,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage (user_id, created_at DESC);");
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

/**
 * Insert API usage record
 * @param {Object} params - Usage parameters
 * @param {string|null} params.userId - User ID (optional)
 * @param {string|null} params.provider - Provider name (e.g., 'openai', 'google')
 * @param {string|null} params.model - Model name
 * @param {Object} params.usage - Token usage data
 * @param {number|null} params.costUsd - Cost in USD (auto-calculated if not provided)
 * @returns {Promise<Object|null>} Inserted record with id and created_at
 */
async function insertApiUsage({ userId = null, provider = null, model = null, usage = {}, costUsd = null }) {
  const client = await pool.connect();
  try {
    // If costUsd wasn't provided, compute it using token counts and configured rates
    let finalCost = costUsd;
    if (finalCost == null) {
      try {
        // Determine token count from usage object
        const u = usage || {};
        const totalTokens = Number(u.total_tokens ?? ((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) ?? 0) || 0;

        // Load rate map from env if provided, otherwise use built-in defaults (USD per 1000 tokens)
        // Expected env format: JSON string, e.g. { "openai": { "gpt-4o": 0.06, "default": 0.03 }, "default": 0.02 }
        const rawRates = process.env.API_USAGE_RATES || null;
        let rates = {
          // USD per 1000 tokens sensible defaults (very small estimates)
          default: Number(process.env.RATE_PER_1K_USD ?? 0.02),
          openai: { default: Number(process.env.RATE_OPENAI_PER_1K_USD ?? 0.03) },
          google: { default: Number(process.env.RATE_GOOGLE_PER_1K_USD ?? 0.015) },
        };

        if (rawRates) {
          try {
            const parsed = JSON.parse(rawRates);
            rates = Object.assign(rates, parsed);
          } catch (e) {
            console.warn('[db] Failed to parse API_USAGE_RATES env, using defaults:', e?.message || e);
          }
        }

        // Helper to resolve rate for a provider+model
        function resolveRate(providerName, modelName) {
          if (!providerName) return rates.default || 0;
          const p = rates[providerName.toLowerCase()] || rates[providerName] || null;
          if (!p) return rates.default || 0;
          if (modelName && typeof p === 'object' && (p[modelName] || p[modelName.toLowerCase()])) {
            return p[modelName] ?? p[modelName.toLowerCase()] ?? p.default ?? rates.default ?? 0;
          }
          if (typeof p === 'number') return p;
          return p.default ?? rates.default ?? 0;
        }

        const per1k = resolveRate(provider ? provider.toString() : null, model ? model.toString() : null);
        finalCost = Number(((totalTokens / 1000) * per1k).toFixed(6));
      } catch (e) {
        console.warn('[db] Failed to compute cost from usage:', e?.message || e);
        finalCost = null;
      }
    }

    const { rows } = await client.query(
      `INSERT INTO api_usage (user_id, provider, model, usage, cost_usd) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [userId, provider, model, usage ? usage : {}, finalCost]
    );
    return rows[0];
  } catch (err) {
    console.error('Failed to insert API usage:', err.message || err);
    return null;
  } finally {
    client.release();
  }
}

/**
 * Get usage summary for a user
 * @param {Object} params - Query parameters
 * @param {string|null} params.userId - User ID to filter by (optional)
 * @param {number} params.sinceDays - Number of days to look back (default: 30)
 * @returns {Promise<Array>} Usage summary grouped by provider and model
 */
async function getUsageSummary({ userId = null, sinceDays = 30 } = {}) {
  const client = await pool.connect();
  try {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const params = [];
    let whereClauses = [];
    if (userId) {
      params.push(userId);
      whereClauses.push(`user_id = $${params.length}`);
    }
    // created_at will be last param
    params.push(since);
    whereClauses.push(`created_at >= $${params.length}`);

    const where = `WHERE ${whereClauses.join(' AND ')}`;
    const query = `SELECT provider, model, SUM((usage->>'total_tokens')::bigint) AS total_tokens, SUM(cost_usd::numeric) AS total_cost, COUNT(1) AS calls FROM api_usage ${where} GROUP BY provider, model`;
    const { rows } = await client.query(query, params);
    return rows;
  } catch (err) {
    console.error('Failed to get usage summary:', err.message || err);
    return [];
  } finally {
    client.release();
  }
}

export { pool, initSchema, mapConversation, mapMessage, checkDatabaseHealth, insertApiUsage, getUsageSummary };
