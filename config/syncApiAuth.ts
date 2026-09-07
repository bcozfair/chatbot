// ─────────────────────────────────────────────────────────────────────────────
//  ด่านตรวจกุญแจของ /api/sync/v1/* — ใช้กับเครื่องภายนอกที่มาดึงข้อมูลไป sync
//
//  ทำไมไม่ใช้ adminAuthMiddleware ซ้ำ: JWT แอดมินอายุ 24 ชม. เพิกถอนไม่ได้ และเป็นตัวตนของ "คน"
//  ที่เขียนข้อมูลได้ · การเอาไปฝังไว้ใน cron ของเครื่องที่เราไม่ได้ดูแล = ยกสิทธิ์แอดมินให้เครื่องนั้น
//  กุญแจในไฟล์นี้ทำได้อย่างเดียวคืออ่านผ่าน endpoint ชุดนี้ ปิดรายตัวได้ทันที และจำกัดตารางได้
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { pool } from './db.js';

export interface SyncKeyIdentity {
  id: number;
  name: string;
  keyPrefix: string;
  /** null = เข้าถึงได้ทุกตารางที่ registry เปิดไว้ */
  allowedTables: string[] | null;
}

export interface SyncApiRequest extends Request {
  syncKey?: SyncKeyIdentity;
}

export const SYNC_KEY_PREFIX_LEN = 8;

export function hashSyncKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * เพดาน request ที่วิ่งพร้อมกันของ endpoint ชุดนี้
 *
 * ตัวเลขนี้ไม่ได้กัน DDoS — มันกัน "ปลายทางตั้ง cron ผิดจนยิงทับกัน" ซึ่งเป็นเคสที่เกิดจริงบ่อยกว่ามาก
 * pool มี 40 connection ที่บอท/LIFF/แอดมินใช้ร่วมกันอยู่ ถ้าปล่อยให้ตัวดึงข้อมูลยิงพร้อมกัน 20 เส้น
 * แล้วแต่ละเส้นสแกน sale_orders ทีละ 2,000 แถว คนที่เจ็บคือลูกค้าที่รอบอทตอบ ไม่ใช่ตัวดึงข้อมูล
 * ตอบ 429 + Retry-After ไปเลยดีกว่า — ตัวดึงรอแล้วมาใหม่ได้ ลูกค้าที่รอบอทตอบรอไม่ได้
 */
const MAX_CONCURRENT = 4;
let inFlight = 0;

export function syncConcurrencyGuard(_req: Request, res: Response, next: NextFunction) {
  if (inFlight >= MAX_CONCURRENT) {
    res.setHeader('Retry-After', '5');
    return res.status(429).json({ error: 'sync API กำลังทำงานเต็มจำนวนที่อนุญาต — ลองใหม่อีกครั้ง' });
  }
  inFlight++;
  res.on('finish', () => { inFlight--; });
  res.on('close', () => { /* finish ยิงแล้วในเคสปกติ — close ที่มาก่อน finish คือ client ตัดสาย */ });
  next();
}

/** มีไว้ให้ diag ตรวจว่าตัวนับไม่รั่ว (ตัวนับที่รั่วจะทำให้ endpoint ตาย 429 ถาวรจนกว่าจะ restart) */
export function getSyncInFlight(): number {
  return inFlight;
}

function extractKey(req: Request): string | null {
  const header = req.headers.authorization;
  if (header) {
    const parts = header.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1]) return parts[1];
    return null;
  }
  const alt = req.headers['x-sync-key'];
  if (typeof alt === 'string' && alt.trim()) return alt.trim();
  return null;
}

// เขียน last_used_at ทุก request = เขียน DB ทุกครั้งที่ปลายทางถาม (หน้าละครั้ง, ทุก 10 นาที)
// ซึ่งไม่คุ้มเลยเพราะสิ่งที่เราอยากรู้คือ "กุญแจนี้ยังมีชีวิตอยู่ไหม" ไม่ใช่วินาทีที่แม่นยำ
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const lastUsedWrittenAt = new Map<number, number>();

export async function syncApiAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const rawKey = extractKey(req);
  if (!rawKey) {
    return res.status(401).json({ error: 'ต้องส่งกุญแจมาที่ header Authorization: Bearer <key>' });
  }

  try {
    const hash = hashSyncKey(rawKey);
    const { rows } = await pool.query(
      `SELECT id, name, key_prefix, key_hash, allowed_tables
         FROM public.sync_api_keys
        WHERE key_hash = $1 AND is_active = true AND revoked_at IS NULL`,
      [hash]
    );

    const row = rows[0];
    // เทียบ hash ซ้ำแบบ constant-time — ตัว WHERE ข้างบนใช้ index (เร็วและเทียบไม่ constant-time)
    // ชั้นนี้ทำให้เวลาตอบไม่ผูกกับ "กุญแจถูกกี่ตัวอักษรแรก" ซึ่งเป็นข้อมูลที่ไม่ควรรั่วออกไป
    const expected = Buffer.from(row?.key_hash ?? '0'.repeat(64), 'utf8');
    const actual = Buffer.from(hash, 'utf8');
    const matched = !!row && expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!matched) {
      return res.status(401).json({ error: 'กุญแจไม่ถูกต้องหรือถูกเพิกถอนแล้ว' });
    }

    (req as SyncApiRequest).syncKey = {
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      allowedTables: row.allowed_tables ?? null,
    };

    const now = Date.now();
    if (now - (lastUsedWrittenAt.get(row.id) ?? 0) > LAST_USED_WRITE_INTERVAL_MS) {
      lastUsedWrittenAt.set(row.id, now);
      // ไม่ await — การบันทึกว่า "ใช้ล่าสุดเมื่อไหร่" ต้องไม่ทำให้ผู้เรียกรอ และล้มเหลวได้โดยไม่มีผล
      pool
        .query('UPDATE public.sync_api_keys SET last_used_at = NOW() WHERE id = $1', [row.id])
        .catch((err) => console.error('[syncApiAuth] อัปเดต last_used_at ไม่สำเร็จ:', err.message));
    }

    next();
  } catch (err: any) {
    console.error('[syncApiAuth] ตรวจกุญแจล้มเหลว:', err);
    res.status(500).json({ error: 'ตรวจสอบสิทธิ์ไม่สำเร็จ' });
  }
}

/** กุญแจนี้เห็นตารางนี้ได้ไหม — allowedTables = null แปลว่าเห็นได้ทุกตารางใน registry */
export function keyCanRead(key: SyncKeyIdentity | undefined, table: string): boolean {
  if (!key) return false;
  if (!key.allowedTables) return true;
  return key.allowedTables.includes(table);
}
