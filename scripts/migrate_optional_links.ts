import { pool } from '../config/db.js';

async function migrate() {
  console.log("Starting migration for product_optional_links table...");
  try {
    // 1. Drop existing table
    await pool.query(`DROP TABLE IF EXISTS product_optional_links CASCADE;`);
    console.log("Dropped table product_optional_links successfully.");

    // 2. Create table with trigger_product_id and optional_product_id as TEXT
    await pool.query(`
      CREATE TABLE product_optional_links (
        id                  SERIAL PRIMARY KEY,
        trigger_product_id  TEXT NOT NULL,
        optional_product_id TEXT NOT NULL,
        is_active           BOOLEAN DEFAULT true,
        note                TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(trigger_product_id, optional_product_id)
      );
    `);
    console.log("Created table product_optional_links with TEXT reference columns.");

    // 3. Create Index
    await pool.query(`
      CREATE INDEX idx_optional_links_trigger 
        ON product_optional_links(trigger_product_id);
    `);
    console.log("Created index idx_optional_links_trigger.");

    console.log("Migration completed successfully!");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await pool.end();
  }
}

migrate();
