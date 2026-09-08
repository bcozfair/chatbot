// ─────────────────────────────────────────────────────────────────────────────
//  ตัวตนของใบที่ออกจากหน้าเว็บแอดมิน — เฟส B ของ docs/plan-web-quote-request.md §2
//
//  แอดมินไม่ใช่ผู้ขาย จึงไม่ควรไปโผล่เป็นเจ้าของลูกค้าหรือมีรหัสพนักงานขายของตัวเอง
//  แต่ `quotations.user_id` มี FK ไป `salesperson` ⇒ ต้องมีแถวรองรับ
//  ทางออกคือ "แถวพร็อกซี" 1 แถวต่อคู่ (แอดมิน × เซลส์ที่ออกในนาม):
//
//    user_id = web:<admin_id>:<salesperson_user_id>
//      name / phone / salesperson_id  ← ก๊อปจากเซลส์  (→ ช่อง H + ชื่อและลายเซ็นบน PDF)
//      employee_quotation_id          ← ของแอดมิน     (→ ช่อง J ผู้จัดทำ)
//      branch                         ← ไม่ก๊อป ปล่อย NULL (เหตุผลเต็มใน §2.4 ของแผน)
//      status                         ← ตั้ง 'active' ตอนสร้าง แล้วห้ามแตะอีก
//
//  prefix `web:` เป็นสวิตช์ของทั้งแผน — LINE user id ขึ้นต้น 'U' + hex 32 ตัวเสมอ
//  จึงไม่มีทางชนกัน ⇒ ฟีเจอร์ของเฟสหลัง (โหมด advise · override · ผู้ติดต่อใหม่)
//  ปิดตายสำหรับใบที่มาจาก LINE โดยโครงสร้าง ไม่ต้องพึ่ง flag ใด ๆ
//
//  โปรไฟล์ของแอดมินเอง (ชื่อผู้จัดทำ + เบอร์ + กุญแจลายเซ็น) อยู่ที่ `admin_users` ทั้งชุด
//  **ไม่มีสักฟิลด์ที่บ้านอยู่ใน `salesperson`** — แถวพร็อกซีก๊อป `employee_quotation_id`
//  ไปช่องเดียวเพื่อให้ query ของช่อง J ที่ใช้ร่วมกับใบ LINE ไม่ต้องแก้ (§2.3c)
//
//  ⚠️ ยังไม่มีใครเรียก ensureWebProxy() — ตัวใช้งานจริงมาที่เฟส C
//     เฟส B ส่งมอบ migration + ตัวช่วย + route ตั้งชื่อผู้จัดทำ
//     เฟส B2 เพิ่มเบอร์ + ลายเซ็นแอดมิน + snapshot ตัวตนผู้เสนอราคา (§2.5b–2.7)
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../config/db.js';
import { invalidatePdfCache } from './pdfCache.js';

/** นามสกุลไฟล์ลายเซ็นที่ระบบรองรับ — ชุดเดียวกับที่ GET /api/admin/salespersons ใช้ */
const SIG_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

/** โฟลเดอร์ลายเซ็นของแอดมิน — มี volume `sig_admin` ผูกไว้ใน docker-compose อยู่แล้ว (§2.5) */
const ADMIN_SIG_DIR = () => path.join(process.cwd(), 'data', 'admin_sigs');

/** `web:<admin_id>:<salesperson_user_id>` — รูปแบบเดียวที่ทั้งแผนใช้ตรวจว่าใบมาจากเว็บ */
export function buildWebUserId(adminId: number, spUserId: string): string {
  return `web:${adminId}:${spUserId}`;
}

/** แยกส่วนกลับจาก user_id พร็อกซี — ไม่ใช่รูปแบบนี้คืน null (ใบจาก LINE จะได้ null เสมอ) */
export function parseWebUserId(userId: string | null | undefined): { adminId: number; spUserId: string } | null {
  const m = /^web:(\d+):(.+)$/.exec(String(userId ?? ''));
  if (!m) return null;
  return { adminId: Number(m[1]), spUserId: m[2] };
}

// ── รายชื่อผู้จัดทำจาก Odoo (อ่านหนัก → cache) ────────────────────────────────

/**
 * TTL cache เฉพาะของโมดูลนี้ — รูปแบบเดียวกับ services/rules/cache.ts (รวม inflight dedupe)
 * แต่ไม่ไปใช้ตัวนั้นเพราะ `RuleCacheKey` เป็น namespace ของ "ตารางกฎ" ไม่ใช่ที่ของรายชื่อคน
 *
 * ทำไมต้อง cache: query นี้เป็น Parallel Seq Scan บน sale_orders 317,732 แถว
 * (invoiced 170,292) — วัดจริงบน DB dev 2026-09-07 ได้ ~250ms ทั้งรอบแรกและรอบสอง
 * (ไม่มี index ครอบ invoice_status + employee_quotations และไม่คุ้มจะสร้างเพื่อ dropdown ตัวเดียว)
 * ⇒ ถ้าไม่ cache หน้าเว็บที่รีเฟรชถี่ ๆ จะลาก CPU ของ DB ไปจากเส้นทางออกใบ
 *
 * ตั้ง WEB_MAKERS_CACHE_TTL_MS=0 เพื่อปิด cache (kill switch เวลาสงสัยว่ารายชื่อไม่อัปเดต)
 */
const DEFAULT_MAKERS_TTL_MS = 300_000;   // 5 นาที — รายชื่อขยับตามรอบ sync:saleorders เท่านั้น

/**
 * ผู้จัดทำ 1 คน = ชื่อ + เบอร์ **1 เบอร์** ที่ระบบเลือกให้เอง (§2.5b)
 * `phone` = เบอร์ที่ปรากฏในใบ invoiced ล่าสุดของชื่อนั้น · `null` = ชื่อนั้นไม่มีเบอร์ในข้อมูลเลย
 */
export interface QuotationMaker {
  name: string;
  phone: string | null;
}

let makersCache: { makers: QuotationMaker[]; loadedAt: number; inflight: Promise<QuotationMaker[]> | null } | null = null;

function makersTtlMs(): number {
  const raw = process.env.WEB_MAKERS_CACHE_TTL_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAKERS_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAKERS_TTL_MS;
}

async function queryOdooQuotationMakers(): Promise<QuotationMaker[]> {
  const client = await pool.connect();
  try {
    // SET LOCAL = ผูกกับ transaction เท่านั้น ⇒ ค่านี้ไม่ติดค้างไปกับ connection ตอนคืนเข้า pool
    // (ถ้าใช้ SET เฉย ๆ query อื่นที่หยิบ connection เดียวกันไปจะได้ timeout นี้ติดไปด้วย)
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    // สแกน sale_orders รอบเดียวลง CTE แล้วค่อยแยกเป็น "รายชื่อ" กับ "เบอร์ที่เลือกให้"
    //
    // LEFT JOIN ไม่ใช่ INNER — ชื่อที่ไม่มีเบอร์เลย (วัดแล้วมี 2 จาก 70) ต้องยังอยู่ในรายชื่อ
    // ไม่งั้นแอดมินคนนั้นจะเลือกชื่อตัวเองไม่ได้เลยทั้งที่แผนบอกว่าบันทึกได้ (§2.5b)
    //
    // `n DESC, phone` เป็น tiebreak ที่ต้องมี ถึงวันนี้จะไม่มีเคสเสมอก็ตาม — ไม่มีมันแล้ว
    // วันหนึ่งมีสองเบอร์ลงวันเดียวกัน คำตอบจะสลับไปมาระหว่างการรันโดยไม่มีอะไรบอก
    // (Postgres ไม่รับประกันลำดับของแถวที่เท่ากัน)
    const { rows } = await client.query(`
      WITH src AS (
        SELECT regexp_replace(btrim(employee_quotations), '\\s*\\([^)]*\\)\\s*$', '') AS name,
               NULLIF(btrim(COALESCE(employee_quotations_phone, '')), '')             AS phone,
               order_date
          FROM sale_orders
         WHERE invoice_status = 'invoiced'
           AND employee_quotations IS NOT NULL
           AND btrim(employee_quotations) <> ''
      ),
      names AS (
        SELECT DISTINCT name FROM src WHERE name <> ''
      ),
      picked AS (
        SELECT DISTINCT ON (name) name, phone
          FROM (SELECT name, phone, max(order_date) AS last_used, count(*) AS n
                  FROM src
                 WHERE name <> '' AND phone IS NOT NULL
                 GROUP BY 1, 2) t
         ORDER BY name, last_used DESC NULLS LAST, n DESC, phone
      )
      SELECT n.name, p.phone
        FROM names n
        LEFT JOIN picked p ON p.name = n.name
       ORDER BY n.name
    `);
    await client.query('COMMIT');
    return rows
      .map((r: any) => ({
        name: String(r.name ?? '').trim(),
        // ⚠️ เบอร์ไม่ถูก trim/normalize ใด ๆ ตรงนี้ — btrim ทำใน SQL แล้วครั้งเดียว
        //    รูปแบบที่เหลือ (`-`, `(Auto lines)`, `Ext.137`) ต้องไปลงกระดาษเหมือนที่ Odoo เก็บ
        phone: r.phone === null || r.phone === undefined ? null : String(r.phone),
      }))
      .filter((m: QuotationMaker) => m.name !== '');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * รายชื่อผู้จัดทำที่ Odoo รู้จักจริง (เรียงตามตัวอักษร) — วัดจริง 2026-09-07 ได้ 70 ชื่อ
 * อยู่นอกเส้นทางออกใบและ export ทั้งหมด ⇒ ช้าตรงนี้ไม่กระทบงานหลัก
 */
export async function listOdooQuotationMakers(): Promise<QuotationMaker[]> {
  const ttl = makersTtlMs();
  if (ttl === 0) return await queryOdooQuotationMakers();

  const now = Date.now();
  if (makersCache) {
    if (makersCache.inflight) return await makersCache.inflight;
    if (now - makersCache.loadedAt < ttl) return makersCache.makers;
  }

  const inflight = queryOdooQuotationMakers()
    .then(makers => {
      makersCache = { makers, loadedAt: Date.now(), inflight: null };
      return makers;
    })
    .catch(err => {
      // โหลดพลาด → ทิ้ง entry ให้ครั้งหน้าลองใหม่ ไม่ค้าง promise ที่ reject ไว้
      makersCache = null;
      throw err;
    });

  makersCache = { makers: makersCache?.makers ?? [], loadedAt: makersCache?.loadedAt ?? 0, inflight };
  return await inflight;
}

/** ล้าง cache รายชื่อผู้จัดทำ — เรียกหลัง sync:saleorders ถ้าอยากเห็นชื่อใหม่ทันที */
export function invalidateOdooQuotationMakersCache(): void {
  makersCache = null;
}

/**
 * ชื่อนี้อยู่ในรายชื่อจริงไหม — ด่านของ `PUT /api/admin/webchat/me`
 *
 * เทียบ **ตรงตัว** กับรายชื่อ ตัดแค่ช่องว่างหัว/ท้ายเท่านั้น ไม่ normalize อะไรอีก
 * เพราะค่านี้ถูกส่งเข้าไฟล์ export ตรง ๆ (ช่อง J) — ยอมให้เพี้ยนตรงนี้ = ชื่อที่ Odoo ไม่รู้จัก
 *
 * ⚠️ จงใจ **ไม่** ตัดสังกัดในวงเล็บให้ก่อนเทียบ ถึงแม้ค่าในรายชื่อจะถูกตัดมาแล้วก็ตาม
 *    รายชื่อที่ส่งให้ UI ตัดสังกัดมาแล้วทั้งหมด ⇒ ไม่มีเคสที่ client ต้องส่งชื่อพร้อมสังกัดมา
 *    ถ้าตัดให้ `"Administrator (ปลอม)"` จะกลายเป็น `"Administrator"` แล้ว **ผ่าน** ทั้งที่
 *    ไม่ใช่ชื่อที่ผู้ใช้เลือก — เป็นการเขียนค่าทับเงียบ ๆ ที่แผน §2.3 ไม่ได้สั่งให้ทำ
 *    (เจอตอนตรวจ Manual ข้อ 9 ของเฟส B: ยิงชื่อมั่วแบบมีวงเล็บแล้วได้ 200)
 */
export async function isValidQuotationMaker(name: string): Promise<boolean> {
  const wanted = String(name ?? '').trim();
  if (wanted === '') return false;
  const makers = await listOdooQuotationMakers();
  return makers.some(m => m.name === wanted);
}

// ── โปรไฟล์ผู้เสนอราคาของแอดมินแต่ละคน ────────────────────────────────────────
//
// เฟส B2 ยุบ getAdminQuotationMaker() (อ่านชื่ออย่างเดียว) เข้ามาเป็น getAdminIssuerProfile()
// ⇒ มี **ทางอ่านทางเดียว** ของสามคอลัมน์นี้ ผู้เรียกจึงไม่มีทางเห็นชื่อโดยไม่เห็นเบอร์คู่กัน

/** โปรไฟล์ผู้เสนอราคาของแอดมิน 1 คน — ทุกฟิลด์อ่านจาก `admin_users` แถวเดียว */
export interface AdminIssuerProfile {
  employee_quotation_id: string | null;
  employee_quotation_phone: string | null;
  signature_key: string | null;
}

/** โปรไฟล์ทั้งชุดของแอดมินคนนี้ — ใช้ทั้งใน route `/me` และตอนประกอบ snapshot */
export async function getAdminIssuerProfile(adminId: number): Promise<AdminIssuerProfile | null> {
  const { rows } = await pool.query(
    `SELECT employee_quotation_id, employee_quotation_phone, signature_key
       FROM admin_users WHERE id = $1`,
    [adminId]
  );
  const r = rows[0];
  if (!r) return null;
  const clean = (v: any): string | null =>
    v === undefined || v === null || String(v).trim() === '' ? null : String(v);
  return {
    employee_quotation_id: clean(r.employee_quotation_id),
    // เบอร์ไม่ผ่าน trim — เก็บมาอย่างไรพิมพ์อย่างนั้น (§2.5b) · clean() ใช้ตัดเฉพาะค่าว่างเป็น null
    employee_quotation_phone: r.employee_quotation_phone === null || r.employee_quotation_phone === undefined
      || String(r.employee_quotation_phone).trim() === '' ? null : String(r.employee_quotation_phone),
    signature_key: clean(r.signature_key),
  };
}

/**
 * ตั้งชื่อผู้จัดทำของแอดมิน — ผู้เรียกต้องตรวจ isValidQuotationMaker() มาก่อนแล้ว
 * (แยกหน้าที่ไว้เพื่อให้ route ตอบ 400 พร้อมรายชื่อที่ถูกต้องได้ ไม่ใช่โยน error ออกมาเฉย ๆ)
 *
 * ⚠️ **นี่คือ path เดียวที่เขียน `employee_quotation_phone` ได้** — เบอร์ถูกหาจากชื่อที่ส่งมา
 * แล้วเขียนสองคอลัมน์ใน UPDATE เดียว ⇒ ไม่มีทางที่ชื่อกับเบอร์ในแถวจะเป็นของคนละคน
 * และ client ไม่มีทางกำหนดเบอร์ได้เลยเพราะ route รับแต่ชื่อ (§2.5b)
 */
export async function setAdminQuotationMaker(adminId: number, name: string): Promise<AdminIssuerProfile> {
  const value = String(name ?? '').trim();
  const makers = await listOdooQuotationMakers();
  // ไม่เจอชื่อ = เบอร์ null (ผู้เรียกควรตรวจ isValidQuotationMaker มาแล้ว จึงไม่ควรมาถึงจุดนี้)
  const phone = makers.find(m => m.name === value)?.phone ?? null;

  const { rows } = await pool.query(
    `UPDATE admin_users
        SET employee_quotation_id    = $2,
            employee_quotation_phone = $3,
            updated_at               = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING employee_quotation_id, employee_quotation_phone, signature_key`,
    [adminId, value, phone]
  );
  if (rows.length === 0) throw new Error(`ไม่พบแอดมิน id=${adminId}`);
  return {
    employee_quotation_id: rows[0].employee_quotation_id ?? null,
    employee_quotation_phone: rows[0].employee_quotation_phone ?? null,
    signature_key: rows[0].signature_key ?? null,
  };
}

// ── ลายเซ็นของแอดมิน (data/admin_sigs/<key>.<ext>) ────────────────────────────

/** URL ที่หน้าเว็บเอาไปใส่ `<img src>` ได้ตรง ๆ — เสิร์ฟโดย express.static('/data') เหมือน sale_sigs */
function adminSignatureUrl(key: string): string {
  return `/data/admin_sigs/${key}`;
}

/** path ของไฟล์ลายเซ็นที่มีอยู่จริงของ key นี้ — ไม่มีไฟล์ = null */
export function adminSignaturePath(key: string | null | undefined): string | null {
  const k = key ? String(key).trim() : '';
  if (k === '') return null;
  for (const ext of SIG_EXTENSIONS) {
    const p = path.join(ADMIN_SIG_DIR(), `${k}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface AdminSignatureInfo {
  key: string | null;
  /** URL เต็มพร้อมนามสกุลจริง — null เมื่อไม่มีไฟล์ (ยังไม่อัปโหลด หรือไฟล์หาย) */
  url: string | null;
  exists: boolean;
}

export async function getAdminSignature(adminId: number): Promise<AdminSignatureInfo> {
  const profile = await getAdminIssuerProfile(adminId);
  const key = profile?.signature_key ?? null;
  const filePath = adminSignaturePath(key);
  return {
    key,
    url: filePath ? `${adminSignatureUrl(key as string)}${path.extname(filePath)}` : null,
    exists: filePath !== null,
  };
}

/**
 * บันทึกลายเซ็นของแอดมินจาก data URL base64
 *
 * กติกาเดียวกับ `POST /api/admin/signatures/upload` ทุกข้อ: รับเฉพาะ png/jpg/jpeg ·
 * ลบไฟล์นามสกุลอื่นของ key เดิมก่อนเขียน (กันไฟล์ซ้ำสองนามสกุล) · เรียก invalidatePdfCache()
 *
 * **อัปโหลดทับใช้ key เดิม ไม่หมุน key ใหม่** (§2.5) ⇒ ใบเก่าที่พิมพ์ซ้ำได้ลายเซ็นอันใหม่
 * — ตรงกับพฤติกรรมของ sale_sigs วันนี้เป๊ะ ความสม่ำเสมอบนกระดาษใบเดียวกันสำคัญกว่า
 */
export async function saveAdminSignature(adminId: number, imageDataUrl: string): Promise<AdminSignatureInfo> {
  const matches = String(imageDataUrl ?? '').match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
  if (!matches) throw new Error('INVALID_IMAGE_FORMAT');

  let ext = matches[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (ext !== 'png' && ext !== 'jpg') throw new Error('UNSUPPORTED_IMAGE_TYPE');

  const profile = await getAdminIssuerProfile(adminId);
  if (!profile) throw new Error(`ไม่พบแอดมิน id=${adminId}`);
  // key เกิดครั้งเดียวตอนอัปโหลดครั้งแรก — hex 12 ตัวสุ่ม เดา URL ไม่ได้ (§2.5)
  const key = profile.signature_key ?? crypto.randomBytes(6).toString('hex');

  const dir = ADMIN_SIG_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const e of SIG_EXTENSIONS) {
    const old = path.join(dir, `${key}${e}`);
    if (fs.existsSync(old)) {
      try { fs.unlinkSync(old); } catch (err) { console.error(`ลบไฟล์ลายเซ็นเก่าไม่สำเร็จ: ${old}`, err); }
    }
  }
  fs.writeFileSync(path.join(dir, `${key}.${ext}`), Buffer.from(matches[2], 'base64'));

  await pool.query(
    `UPDATE admin_users SET signature_key = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [adminId, key]
  );
  // ไฟล์ลายเซ็นคือ input เดียวของ PDF ที่อยู่นอกแถว quotations ⇒ คีย์ cache ไม่ขยับเอง
  invalidatePdfCache(`อัปโหลดลายเซ็นแอดมิน ${key}`);

  return { key, url: `${adminSignatureUrl(key)}.${ext}`, exists: true };
}

/** ลบลายเซ็นของแอดมิน — ไม่มีไฟล์อยู่แล้วก็ไม่ถือว่าพลาด (คืน false ให้ route ตัดสินใจเอง) */
export async function deleteAdminSignature(adminId: number): Promise<boolean> {
  const profile = await getAdminIssuerProfile(adminId);
  const key = profile?.signature_key ?? null;
  let deleted = 0;
  if (key) {
    for (const e of SIG_EXTENSIONS) {
      const p = path.join(ADMIN_SIG_DIR(), `${key}${e}`);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); deleted++; } catch (err) { console.error(`ลบไฟล์ลายเซ็นไม่สำเร็จ: ${p}`, err); }
      }
    }
  }
  await pool.query(
    `UPDATE admin_users SET signature_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [adminId]
  );
  if (deleted > 0) invalidatePdfCache(`ลบลายเซ็นแอดมิน ${key}`);
  return deleted > 0;
}

// ── snapshot ตัวตนผู้เสนอราคา (ไปฝังใน quotations.employee_details) ───────────

/** 3 คีย์ที่ไปอยู่ใน `employee_details` ของใบที่ออกจากเว็บ — ใบ LINE ต้องไม่มีคีย์เหล่านี้เลย */
export interface IssuerSnapshot {
  issuer_name: string;
  issuer_phone: string | null;
  issuer_sig_key: string | null;
}

/**
 * คืน `null` ถ้าไม่ใช่ใบจากเว็บ — ผู้เรียกกระจายผลลัพธ์เข้า `employee_details` ได้ตรง ๆ ด้วย
 * `...(await getIssuerSnapshot(userId) ?? {})` ⇒ ใบ LINE จะไม่มีคีย์ `issuer_*` โผล่มาเลย
 * (ไม่ใช่มีแล้วเป็น null — คีย์เปล่า ๆ ทำให้ snapshot ของใบ LINE ก่อน/หลังเฟสนี้ไม่เหมือนกัน)
 *
 * ⚠️ ต้อง snapshot ไม่ใช่คำนวณสดตอนเจน PDF เพราะ `pdfCacheKey()` แฮชทั้งแถว `quotations`
 *    ค่าที่อยู่นอกแถวเปลี่ยนแล้วคีย์ไม่ขยับ = cache จ่ายใบผิดตลอดไป (§2.6)
 */
export async function getIssuerSnapshot(userId: string | null | undefined): Promise<IssuerSnapshot | null> {
  const parsed = parseWebUserId(userId);
  if (!parsed) return null;
  const profile = await getAdminIssuerProfile(parsed.adminId);
  if (!profile || profile.employee_quotation_id === null) return null;
  return {
    issuer_name: profile.employee_quotation_id,
    issuer_phone: profile.employee_quotation_phone,
    issuer_sig_key: profile.signature_key,
  };
}

// ── เซลส์ที่แอดมิน "ออกในนาม" ได้ ─────────────────────────────────────────────

/** มีไฟล์ลายเซ็นของรหัสพนักงานนี้ไหม — กติกาเดียวกับ GET /api/admin/salespersons */
export function hasSaleSignature(salespersonId: string | null | undefined): boolean {
  const spId = salespersonId ? String(salespersonId).trim() : '';
  if (spId === '') return false;
  const dir = path.join(process.cwd(), 'data', 'sale_sigs');
  return SIG_EXTENSIONS.some(ext => fs.existsSync(path.join(dir, `${spId}${ext}`)));
}

export interface ActingSalesperson {
  user_id: string;
  name: string;
  salesperson_id: string | null;
  phone: string | null;
  /** false = ใบที่ออกในนามคนนี้จะไม่มีลายเซ็น (เท่ากับตอนเขาออกใบเอง) — หน้าเว็บเตือนตั้งแต่ตอนเลือก */
  has_sale_sig: boolean;
}

/**
 * รายชื่อเซลส์ที่เลือกเป็น "ออกในนาม" ได้ — เฉพาะ status='active'
 *
 * กรอง `web:%` ออกด้วย ไม่งั้นแถวพร็อกซีที่ระบบสร้างเองจะกลายเป็นตัวเลือกซ้อนตัวเอง
 * (แถวพร็อกซีถูกตั้ง status='active' ตอนสร้าง จึงเข้าเงื่อนไขข้างบนได้เต็ม ๆ)
 */
export async function listActingSalespersons(): Promise<ActingSalesperson[]> {
  const { rows } = await pool.query(`
    SELECT user_id, name, salesperson_id, phone
      FROM salesperson
     WHERE status = 'active'
       AND user_id NOT LIKE 'web:%'
     ORDER BY name ASC
  `);
  return rows.map((r: any) => ({
    user_id: r.user_id,
    name: r.name,
    salesperson_id: r.salesperson_id ? String(r.salesperson_id) : null,
    phone: r.phone ?? null,
    has_sale_sig: hasSaleSignature(r.salesperson_id),
  }));
}

// ── แถวพร็อกซี ───────────────────────────────────────────────────────────────

export interface WebProxyAdmin {
  id: number;
  /** ชื่อผู้จัดทำของแอดมิน (ช่อง J) — ต้องตั้งค่าไว้แล้ว ไม่งั้นโยน error */
  employee_quotation_id: string | null;
}

/**
 * upsert แถวพร็อกซีของคู่ (แอดมิน × เซลส์) แล้วคืน `user_id` ที่ใช้คุยต่อ
 *
 * ⚠️ ตอน UPDATE **ห้ามแตะ `status`** — ช่องนั้นเป็น state machine ของบทสนทนา
 *    (`edit_*` / `custom_quote:*` / `pending_*`) ถ้าเขียนทับเป็น 'active' ทุกครั้งที่เปิดหน้า
 *    บทสนทนาที่ค้างกลางทางจะถูกรีเซ็ตเงียบ ๆ · ตั้งได้ครั้งเดียวคือตอน INSERT
 * ⚠️ **ห้ามก๊อป `employee_quotation_id` จากเซลส์** — ช่อง J ต้องเป็นชื่อแอดมิน
 *    ถ้าเผลอก๊อป Odoo จะบันทึกว่าเซลส์เป็นคนคีย์ใบเอง = ข้อมูลผู้จัดทำผิด
 * ⚠️ **ไม่ก๊อป `branch`** — ปล่อย NULL ตามที่ §2.4 ของแผนตรวจแล้วว่าไม่มีใครใช้ในเส้นทางนี้
 */
export async function ensureWebProxy(admin: WebProxyAdmin, spUserId: string): Promise<string> {
  const maker = admin.employee_quotation_id ? String(admin.employee_quotation_id).trim() : '';
  if (maker === '') {
    throw new Error('แอดมินคนนี้ยังไม่ได้ตั้งชื่อผู้จัดทำ (admin_users.employee_quotation_id)');
  }

  const { rows: spRows } = await pool.query(
    `SELECT user_id, name, phone, salesperson_id
       FROM salesperson
      WHERE user_id = $1 AND status = 'active' AND user_id NOT LIKE 'web:%'`,
    [spUserId]
  );
  const sp = spRows[0];
  if (!sp) throw new Error(`ไม่พบเซลส์ที่ใช้งานอยู่ user_id=${spUserId}`);

  const webUserId = buildWebUserId(admin.id, sp.user_id);

  await pool.query(
    `INSERT INTO salesperson (user_id, name, status, phone, salesperson_id, employee_quotation_id)
     VALUES ($1, $2, 'active', $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
        SET name                  = EXCLUDED.name,
            phone                 = EXCLUDED.phone,
            salesperson_id        = EXCLUDED.salesperson_id,
            employee_quotation_id = EXCLUDED.employee_quotation_id,
            updated_at            = CURRENT_TIMESTAMP`,
    [webUserId, sp.name, sp.phone, sp.salesperson_id, maker]
  );

  return webUserId;
}
