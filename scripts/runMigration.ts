import { pool } from '../config/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  const client = await pool.connect();
  try {
    const sqlFile = process.argv[2];
    let sqlPath: string;
    
    if (sqlFile) {
      sqlPath = path.resolve(process.cwd(), sqlFile);
    } else {
      sqlPath = path.join(__dirname, '../migrations/add_warranty_unit_to_quotation_rules.sql');
    }
    
    console.log(`Reading SQL migration from: ${sqlPath}`);
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`Migration file not found at: ${sqlPath}`);
    }
    
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log(`Running migration from ${path.basename(sqlPath)} on PostgreSQL...`);
    await client.query(sql);
    console.log('Migration completed successfully.');
  } catch (error) {
    console.error('Error running migration:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(err => {
  console.error('Fatal migration execution error:', err);
  process.exit(1);
});
