// Simple test script to check database tables
import { pool } from './db.js';

async function test() {
  console.log('Testing database tables...');
  
  const client = await pool.connect();
  try {
    // Get embedding dimensions from environment
    console.log('EMBEDDING_DIM from env:', process.env.EMBEDDING_DIM || '(not set)');
    
    // Check both tables
    const tables = ['blender_knowledge', 'blender_knowledge_new'];
    for (const tableName of tables) {
      try {
        // Check if table exists
        const { rows: existRows } = await client.query(
          "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
          [tableName]
        );
        
        if (!existRows[0].exists) {
          console.log(`Table ${tableName} does not exist`);
          continue;
        }
        
        // Check row count
        const { rows: countRows } = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
        console.log(`Table ${tableName} rows: ${countRows[0].count}`);
        
        // Check dimension
        const { rows: dimRows } = await client.query(`
          SELECT (atttypmod - 4) AS dim
          FROM pg_attribute
          WHERE attrelid = '${tableName}'::regclass
            AND attname = 'embedding'
            AND NOT attisdropped;
        `);
        console.log(`Table ${tableName} dimension: ${dimRows[0]?.dim || 'unknown'}`);
      } catch (err) {
        console.error(`Error checking table ${tableName}:`, err.message);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

test().catch(console.error);
