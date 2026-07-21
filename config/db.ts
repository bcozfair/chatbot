import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const dbConfig = {
  host: process.env.PG_HOST,
  port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : undefined,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  // webhook 12 + REST จาก LIFF ~15 + PDF ~3 + สำรอง ยังต่ำกว่า max_connections=100 ของ PostgreSQL
  max: 40,
  min: 4,
  idleTimeoutMillis: 30000,
  // ถ้า pool หมด ให้ throw เร็ว (5 วิ) แทนการค้างสะสมจน request ถล่มกันเอง
  connectionTimeoutMillis: 5000,
  // กัน query ค้างถือ connection ไว้ตลอดกาล
  statement_timeout: 15000,
  query_timeout: 15000,
  keepAlive: true,
};

export const pool = new Pool(dbConfig);

/**
 * ตัวรัน query ที่ใช้ได้ทั้ง pool (autocommit) และ client ที่อยู่ใน transaction
 * ฟังก์ชัน service ที่ต้องทำงานได้ทั้งสองแบบให้รับ executor เป็นพารามิเตอร์สุดท้าย โดย default เป็น pool
 */
export type DbExecutor = Pick<pg.Pool, 'query'>;

/**
 * รัน fn ภายใน transaction เดียว: BEGIN -> fn -> COMMIT ถ้า fn โยน error จะ ROLLBACK แล้วโยนต่อ
 *
 * ข้อห้ามภายใน fn:
 *  1. ห้ามเรียก pool.query — ทุก query ต้องผ่าน client ที่ได้รับ ไม่งั้นจะหลุดออกนอก transaction
 *     และแย่ง connection จาก pool จนอาจ deadlock ตัวเอง
 *  2. ห้ามเรียก res.json() — ให้ return ค่าออกไปตอบข้างนอกหลัง COMMIT
 *  3. ห้ามเรียก network (OpenAI / LINE / puppeteer) เพราะจะเปิด transaction ค้างไว้
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[withTransaction] ROLLBACK ล้มเหลว:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}
