import { pool } from '../config/db.js';
import fs from 'fs';
import path from 'path';

async function runMigration() {
  const client = await pool.connect();
  try {
    const sqlFile = process.argv[2];
    if (!sqlFile) {
      throw new Error(
        'ต้องระบุไฟล์ SQL: tsx scripts/runMigration.ts <path/to/file.sql>\n' +
        'ตั้ง DB ใหม่ตั้งแต่ศูนย์: tsx scripts/runMigration.ts migrations/schema.sql'
      );
    }
    const sqlPath = path.resolve(process.cwd(), sqlFile);

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
