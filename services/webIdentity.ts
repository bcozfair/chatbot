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
//  ⚠️ เฟส B ยังไม่มีใครเรียก ensureWebProxy() — ตัวใช้งานจริงมาที่เฟส C
//     เฟสนี้ส่งมอบแค่ migration + ตัวช่วย + route ตั้งชื่อผู้จัดทำ (makers / me)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { pool } from '../config/db.js';

/** นามสกุลไฟล์ลายเซ็นที่ระบบรองรับ — ชุดเดียวกับที่ GET /api/admin/salespersons ใช้ */
const SIG_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

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
let makersCache: { names: string[]; loadedAt: number; inflight: Promise<string[]> | null } | null = null;

function makersTtlMs(): number {
  const raw = process.env.WEB_MAKERS_CACHE_TTL_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAKERS_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAKERS_TTL_MS;
}

async function queryOdooQuotationMakers(): Promise<string[]> {
  const client = await pool.connect();
  try {
    // SET LOCAL = ผูกกับ transaction เท่านั้น ⇒ ค่านี้ไม่ติดค้างไปกับ connection ตอนคืนเข้า pool
    // (ถ้าใช้ SET เฉย ๆ query อื่นที่หยิบ connection เดียวกันไปจะได้ timeout นี้ติดไปด้วย)
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    const { rows } = await client.query(`
      SELECT DISTINCT regexp_replace(btrim(employee_quotations), '\\s*\\([^)]*\\)\\s*$', '') AS name
        FROM sale_orders
       WHERE invoice_status = 'invoiced'
         AND employee_quotations IS NOT NULL
         AND btrim(employee_quotations) <> ''
       ORDER BY 1
    `);
    await client.query('COMMIT');
    return rows
      .map((r: any) => String(r.name ?? '').trim())
      .filter((n: string) => n !== '');
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
export async function listOdooQuotationMakers(): Promise<string[]> {
  const ttl = makersTtlMs();
  if (ttl === 0) return await queryOdooQuotationMakers();

  const now = Date.now();
  if (makersCache) {
    if (makersCache.inflight) return await makersCache.inflight;
    if (now - makersCache.loadedAt < ttl) return makersCache.names;
  }

  const inflight = queryOdooQuotationMakers()
    .then(names => {
      makersCache = { names, loadedAt: Date.now(), inflight: null };
      return names;
    })
    .catch(err => {
      // โหลดพลาด → ทิ้ง entry ให้ครั้งหน้าลองใหม่ ไม่ค้าง promise ที่ reject ไว้
      makersCache = null;
      throw err;
    });

  makersCache = { names: makersCache?.names ?? [], loadedAt: makersCache?.loadedAt ?? 0, inflight };
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
  return makers.includes(wanted);
}

// ── ชื่อผู้จัดทำของแอดมินแต่ละคน ──────────────────────────────────────────────

/** ค่าที่แอดมินคนนี้ตั้งไว้ — NULL/ยังไม่ตั้ง = หน้าเว็บต้องบล็อกไม่ให้เริ่มแชท */
export async function getAdminQuotationMaker(adminId: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT employee_quotation_id FROM admin_users WHERE id = $1`,
    [adminId]
  );
  const v = rows[0]?.employee_quotation_id;
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v);
}

/**
 * ตั้งชื่อผู้จัดทำของแอดมิน — ผู้เรียกต้องตรวจ isValidQuotationMaker() มาก่อนแล้ว
 * (แยกหน้าที่ไว้เพื่อให้ route ตอบ 400 พร้อมรายชื่อที่ถูกต้องได้ ไม่ใช่โยน error ออกมาเฉย ๆ)
 */
export async function setAdminQuotationMaker(adminId: number, name: string): Promise<string> {
  const value = String(name ?? '').trim();
  const { rows } = await pool.query(
    `UPDATE admin_users
        SET employee_quotation_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING employee_quotation_id`,
    [adminId, value]
  );
  if (rows.length === 0) throw new Error(`ไม่พบแอดมิน id=${adminId}`);
  return rows[0].employee_quotation_id;
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
