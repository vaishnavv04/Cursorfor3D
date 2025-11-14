// Simple test script to check if our embedding tables are working properly
import { pool } from './db.js';
import dotenv from 'dotenv';
import pgvector from 'pgvector/pg';
import { pipeline } from '@xenova/transformers';

dotenv.config();

// Check both tables for content
async function testEmbeddings() {
  console.log('Testing embedding tables...');
  
  try {
    // Check if tables exist
    const client = await pool.connect();
    
    try {
      // Check original table
      const { rows: originalRows } = await client.query(
        "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
        ["blender_knowledge"]
      );
      
      const originalTableExists = originalRows[0].exists;
      console.log('Original table (blender_knowledge) exists:', originalTableExists);
      
      let originalCountRows = [{ count: '0' }];
      let originalDim = [{ dim: 0 }];
      
      if (originalTableExists) {
        const { rows: countRows } = await client.query('SELECT COUNT(*) FROM blender_knowledge');
        originalCountRows = countRows;
        console.log(`Original table has ${originalCountRows[0].count} rows`);
        
        const { rows: dimRows } = await client.query(`
          SELECT (atttypmod - 4) AS dim
          FROM pg_attribute
          WHERE attrelid = 'blender_knowledge'::regclass
            AND attname = 'embedding'
            AND NOT attisdropped;
        `);
        originalDim = dimRows;
        console.log(`Original table dimension: ${originalDim[0]?.dim || 'unknown'}`);
      }
      
      // Check new table
      const { rows: newRows } = await client.query(
        "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
        ["blender_knowledge_new"]
      );
      
      const newTableExists = newRows[0].exists;
      console.log('New table (blender_knowledge_new) exists:', newTableExists);
      
      let newCountRows = [{ count: '0' }];
      let newDim = [{ dim: 0 }];
      
      if (newTableExists) {
        const { rows: countRows } = await client.query('SELECT COUNT(*) FROM blender_knowledge_new');
        newCountRows = countRows;
        console.log(`New table has ${newCountRows[0].count} rows`);
        
        const { rows: dimRows } = await client.query(`
          SELECT (atttypmod - 4) AS dim
          FROM pg_attribute
          WHERE attrelid = 'blender_knowledge_new'::regclass
            AND attname = 'embedding'
            AND NOT attisdropped;
        `);
        newDim = dimRows;
        console.log(`New table dimension: ${newDim[0]?.dim || 'unknown'}`);
      }
      
      // Test a simple query if either table has data
      if ((originalTableExists && parseInt(originalCountRows[0].count) > 0) || 
          (newTableExists && parseInt(newCountRows[0].count) > 0)) {
        
        console.log('\nTesting search functionality...');
        
        // Load the embedding model
        console.log('Loading embedding model...');
        const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('Model loaded successfully!');
        
        // Create a test embedding
        const testQuery = "How to create a cube in Blender";
        console.log(`Creating embedding for query: "${testQuery}"`);
        const embedding = await embedder(testQuery, { pooling: 'mean', normalize: true });
        const embeddingArray = Array.from(embedding.data);
        const vectorString = pgvector.toSql(embeddingArray);
        
        // Try search in new table first if it exists and has data
        if (newTableExists && parseInt(newCountRows[0].count) > 0) {
          console.log('\nSearching in new table (blender_knowledge_new)...');
          const { rows: newSearchRows } = await client.query(`
            SELECT content, 1 - (embedding <=> $1) AS similarity
            FROM blender_knowledge_new
            WHERE 1 - (embedding <=> $1) > 0.2
            ORDER BY similarity DESC
            LIMIT 3
          `, [vectorString]);
          
          console.log(`Found ${newSearchRows.length} results in new table:`);
          newSearchRows.forEach((row, i) => {
            console.log(`\nResult ${i + 1} (similarity: ${row.similarity.toFixed(4)}):`);
            console.log(row.content.substring(0, 200) + '...');
          });
        }
        
        // Try search in original table if it exists and has data
        if (originalTableExists && parseInt(originalCountRows[0].count) > 0) {
          console.log('\nSearching in original table (blender_knowledge)...');
          const { rows: originalSearchRows } = await client.query(`
            SELECT content, 1 - (embedding <=> $1) AS similarity
            FROM blender_knowledge
            WHERE 1 - (embedding <=> $1) > 0.2
            ORDER BY similarity DESC
            LIMIT 3
          `, [vectorString]);
          
          console.log(`Found ${originalSearchRows.length} results in original table:`);
          originalSearchRows.forEach((row, i) => {
            console.log(`\nResult ${i + 1} (similarity: ${row.similarity.toFixed(4)}):`);
            console.log(row.content.substring(0, 200) + '...');
          });
        }
      }
      
    } finally {
      client.release();
    }
    
  } catch (err) {
    console.error('Error testing embeddings:', err);
  } finally {
    await pool.end();
  }
}

// Run the test
testEmbeddings();
