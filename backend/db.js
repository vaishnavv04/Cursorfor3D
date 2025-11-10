import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const connectionString = process.env.DATABASE_URL || process.env.DATABASE_URI;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL (or DATABASE_URI) environment variable is required for authentication and chat persistence."
  );
}

const isSupabase = /supabase/i.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: isSupabase
    ? {
        rejectUnauthorized: false,
      }
    : undefined,
  connectionTimeoutMillis: 10000, // 10 second timeout
  idleTimeoutMillis: 30000,
  max: 20,
});

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

async function initSchema() {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    throw new Error(`Database connection failed: ${err.message}. Please check your DATABASE_URL and network connectivity.`);
  }
  
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

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

export { pool, initSchema, mapConversation, mapMessage };
