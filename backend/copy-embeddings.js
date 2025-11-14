// Script to copy embeddings from the original table to the new table
import { pool } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

async function copyEmbeddings() {
  console.log('Copying embeddings from blender_knowledge to blender_knowledge_new...');
  
  const client = await pool.connect();
  try {
    // Check if tables exist
    const originalExists = await checkTableExists(client, 'blender_knowledge');
    const newExists = await checkTableExists(client, 'blender_knowledge_new');
    
    if (!originalExists) {
      console.error('Original table blender_knowledge does not exist!');
      return;
    }
    
    if (!newExists) {
      console.log('Creating new table blender_knowledge_new...');
      await client.query(`
        CREATE TABLE IF NOT EXISTS blender_knowledge_new (
          id bigserial PRIMARY KEY,
          content text NOT NULL,
          embedding vector(380)
        );
      `);
      
      // Create index on the new table
      await client.query(`CREATE INDEX IF NOT EXISTS idx_blender_knowledge_new_embedding ON blender_knowledge_new USING ivfflat (embedding vector_cosine_ops);`);
    } else {
      console.log('Truncating existing blender_knowledge_new table...');
      await client.query('TRUNCATE TABLE blender_knowledge_new');
    }
    
    // Count rows in original table
    const { rows: countRows } = await client.query('SELECT COUNT(*) FROM blender_knowledge');
    const rowCount = parseInt(countRows[0].count);
    console.log(`Original table has ${rowCount} rows to copy`);
    
    // Copy data in batches
    const BATCH_SIZE = 500;
    const batches = Math.ceil(rowCount / BATCH_SIZE);
    
    for (let i = 0; i < batches; i++) {
      const offset = i * BATCH_SIZE;
      const limit = BATCH_SIZE;
      
      console.log(`Copying batch ${i + 1}/${batches} (offset ${offset}, limit ${limit})...`);
      
      await client.query(`
        INSERT INTO blender_knowledge_new (content, embedding)
        SELECT content, embedding FROM blender_knowledge
        ORDER BY id
        OFFSET ${offset} LIMIT ${limit}
      `);
    }
    
    // Verify copy
    const { rows: newCountRows } = await client.query('SELECT COUNT(*) FROM blender_knowledge_new');
    console.log(`New table now has ${newCountRows[0].count} rows`);
    
    console.log('Copy completed successfully!');
    
  } catch (err) {
    console.error('Error copying embeddings:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

async function checkTableExists(client, tableName) {
  const { rows } = await client.query(
    "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
    [tableName]
  );
  return rows[0].exists;
}

// Run the copy
copyEmbeddings();
