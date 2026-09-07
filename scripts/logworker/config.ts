import pg from 'pg';
import dotenv from 'dotenv';

// อ่าน .env จาก "โฟลเดอร์โปรเจกต์" ไม่ใช่ CWD — systemd ตั้ง WorkingDirectory ไว้ที่
// deploy/logworker (ที่อยู่ของ node_modules ขั้นต่ำ) ซึ่งไม่มี .env
// ค่าที่ตั้งมาจาก environment ของ systemd ชนะเสมอ (dotenv ไม่ override ของที่มีอยู่แล้ว)
dotenv.config({ path: new URL('../../.env', import.meta.url) });

/**
 * ค่าตั้งและ connection pool ของ logworker
 *
 * ⚠️ ไฟล์นี้ตั้งใจ "ไม่" import config/db.ts ของแอป — เป็นเรื่องความปลอดภัยของระบบหลัก ไม่ใช่สไตล์
 *   1. pool ของแอปตั้ง max 40 · ถ้า worker ใช้ตัวเดียวกันแล้ว query ไหนค้าง จะกิน connection
 *      ของเส้นทางที่ผู้ใช้รออยู่ · pool ของ worker จึงแยกและตั้งเพดานไว้ที่ 5
 *   2. แอปรันในคอนเทนเนอร์ (PG_HOST=db) ส่วน worker รันบน host ⇒ ต้องต่อผ่านพอร์ตที่ publish
 *      ออกมา ค่า PG_HOST ใน .env จึงใช้ไม่ได้ตรง ๆ
 *
 * ทำไม worker ต้องอยู่บน host ไม่ใช่ในคอนเทนเนอร์: ถ้าอยู่ในคอนเทนเนอร์ต้อง mount docker socket
 * ซึ่งเท่ากับให้สิทธิ์เทียบเท่า root กับโปรเซสนั้น
 */

/** ระดับความรุนแรงเรียงจากหนักไปเบา — index ต่ำ = หนักกว่า (RFC 5424 ย่อเหลือเท่าที่ใช้จริง) */
export const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug'] as const;
export type Level = (typeof LEVELS)[number];

export function levelRank(level: string): number {
  const i = (LEVELS as readonly string[]).indexOf(level);
  return i === -1 ? LEVELS.length : i;
}

/**
 * แปลงค่า env เป็นระดับที่ใช้ได้ — ฟังก์ชันบริสุทธิ์ แยกออกมาให้ diag เทสได้โดยไม่ต้องตั้ง env จริง
 * (เลียนแบบ parseRetentionDays ใน services/apiLogService.ts)
 *
 * อ่านไม่ออกต้องตกกลับเป็น 'warn' ไม่ใช่ 'debug' — ค่าที่พิมพ์ผิดต้องไม่ทำให้ตารางโตวันละ 3.5 MB เงียบ ๆ
 */
export function parseLevel(raw: string | undefined, fallback: Level = 'warn'): Level {
  const v = (raw ?? '').trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(v) ? (v as Level) : fallback;
}

/** อ่านจำนวนวันจาก env — ต่ำกว่า 1 หรืออ่านไม่ออกตกกลับเป็นค่าตั้งต้น (0 = "ลบทุกแถวทันที" ห้ามเกิดจากพิมพ์ผิด) */
export function parseDays(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 3650);
}

export const cfg = {
  /** คอนเทนเนอร์ที่ให้อ่าน docker logs (คั่นด้วย comma) */
  containers: (process.env.SYSTEM_LOG_CONTAINERS ?? 'primus-chatbot-app-1')
    .split(',').map(s => s.trim()).filter(Boolean),

  /** ระดับต่ำสุดที่เขียนลง DB — ต่ำกว่านี้ยังอยู่ใน docker logs ตามเดิม ไม่ได้หายไปไหน */
  dbLevel: parseLevel(process.env.SYSTEM_LOG_DB_LEVEL),

  systemRetentionDays:     parseDays(process.env.SYSTEM_LOG_RETENTION_DAYS, 90),
  systemInfoRetentionDays: parseDays(process.env.SYSTEM_LOG_INFO_RETENTION_DAYS, 14),
  auditRetentionDays:      parseDays(process.env.AUDIT_LOG_RETENTION_DAYS, 730),
} as const;

/**
 * pool ของ worker — เพดาน 5 จาก max_connections 100 (แอปใช้อยู่ ~15)
 *
 * statement_timeout 30 วิ เป็นข้อบังคับของโปรเจกต์นี้ ไม่ใช่ทางเลือก:
 * query วิเคราะห์ที่ค้างตัวเดียวบล็อก REFRESH MATERIALIZED VIEW ของ customers_data_view
 * ซึ่งทำให้ระบบค้นหาลูกค้าทั้งระบบหยุดตาม
 */
export const pool = new pg.Pool({
  host:     process.env.LOGWORKER_PG_HOST ?? '127.0.0.1',
  port:     Number(process.env.LOGWORKER_PG_PORT ?? 5432),
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max: 5,
  min: 1,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
  keepAlive: true,
});

// pool ของ worker ต้องไม่ทำให้โปรเซสตายเมื่อ DB restart — 'error' ที่ไม่มีคนฟังทำให้ Node ตาย
pool.on('error', err => {
  console.error('[logworker] pool error (ไม่ตาย รอบหน้าต่อเอง):', err?.message ?? err);
});

/** log ของ worker เอง — ไปที่ stdout/stderr ของ systemd (journalctl) ไม่เขียนกลับลงตารางตัวเอง */
export function log(...args: unknown[]): void {
  console.log(`[logworker] ${new Date().toISOString()}`, ...args);
}
export function logErr(...args: unknown[]): void {
  console.error(`[logworker] ${new Date().toISOString()}`, ...args);
}
