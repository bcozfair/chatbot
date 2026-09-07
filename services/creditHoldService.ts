// ─────────────────────────────────────────────────────────────────────────────
//  ระงับการเสนอราคาบริษัทที่ไม่มีคำสั่งซื้อมานาน (credit hold)
//
//  ไฟล์นี้ถือ "ความรู้เรื่องเกณฑ์" อย่างเดียว ไม่มีถ้อยคำที่แสดงให้เซลล์เห็น และไม่ตัดสินว่า
//  จะบล็อกตรงไหน — การบล็อกจริงเป็นเงื่อนไข CUSTOMER_CREDIT_HOLD ใน validateQuotationItems()
//  ของ services/quotationService.ts (แบบเดียวกับ blacklistService.ts)
//
//  ── ข้อมูลมาจากไหน ──
//  customers_data_view.last_order_at คำนวณไว้แล้วตอน build ตาราง (นิยามอยู่ใน view
//  customers_data_build — ดู migrations/schema.sql) ไฟล์นี้แค่อ่านค่ามาเทียบกับเกณฑ์
//  ไม่ไปไล่ sale_orders เอง และไม่รู้เรื่องเงื่อนไขการชำระเงินเลยแม้แต่นิดเดียว
//
//  ⚠️⚠️ ชื่อคอลัมน์หลอก — last_order_at ไม่ใช่ "วันสั่งซื้อล่าสุด" ตามชื่อ ⚠️⚠️
//    ค่าที่ได้ = วันล่าสุดของใบที่ออกบิลแล้ว/รอออกบิล (invoice_status = 'invoiced'/'to invoice')
//               ของ "นิติบุคคล" ที่บริษัทนี้สังกัด และเฉพาะเมื่อนิติบุคคลนั้นเป็นลูกค้า
//               เครดิต/เช็คล่วงหน้าเท่านั้น
//    NULL     = ไม่เข้าข่ายตรวจ ได้จาก 3 สาเหตุ ซึ่งด่านปฏิบัติเหมือนกันหมด (ผ่าน):
//                 1. ไม่ใช่ลูกค้าเครดิต (Cash / Immediate Payment / Odoo ไม่ได้ตั้งค่า)
//                 2. เป็นเครดิต แต่ไม่มีใบสั่งซื้อเลยสักใบ ← ลูกค้าใหม่ ต้องเสนอราคาได้
//                 3. เป็นเครดิต มีใบ แต่ไม่เคยมีใบที่ออกบิลเลย
//
//  ⇒ เงื่อนไข "ตรวจเฉพาะลูกค้าเครดิต" ถูกฝังไว้ที่นิยาม view ที่เดียว ไม่กระจายมาที่นี่
//    ถ้าจะเปลี่ยนว่าใครอยู่ในขอบเขตตรวจ ให้ไปแก้ view อย่าเติมเงื่อนไขใน query ของไฟล์นี้
//  ⇒ และห้ามเอาคอลัมน์นี้ไปแสดงเป็น "ลูกค้ารายนี้ซื้อครั้งสุดท้ายเมื่อไหร่" ที่อื่น —
//    ลูกค้า Cash ทุกรายจะได้ NULL ทั้งที่ซื้อเป็นประจำ
//
//  ทำไมไม่คำนวณสด: ถามทีละบริษัทตอนใช้งานราคา ~190ms และติดป้ายในผลค้นหา 30 รายพร้อมกัน
//  ราคา 2.2 วิ (วัด 2026-08-20) — ย้ายไปคำนวณทั้งตารางรอบเดียวตอน build (+1.5 วิ/รอบ sync)
//  แล้วตอนใช้งานเหลือ index-only scan 0.21ms
//
//  ⚠️ ทุกฟังก์ชันปล่อยให้ error ลอยขึ้นไปหา caller โดยตั้งใจ ห้ามกลืนเป็น "ไม่โดนบล็อก"
//     เพราะด่านตรวจกฎเป็น fail-closed — DB ล่มต้องกลายเป็น "ตรวจไม่สำเร็จ ห้ามออกใบ"
// ─────────────────────────────────────────────────────────────────────────────

import { pool } from '../config/db.js';
import { loadCached } from './rules/cache.js';

/**
 * off = ไม่ตรวจเลย · block = ห้ามออกใบ — ตรงกับสวิตช์ เปิด/ปิด ในหน้าแอดมิน
 *
 * เคยมีค่าที่ 3 คือ 'warn' (ตรวจ + เขียน log ว่าจะโดนใครบ้าง แต่ยังออกใบได้) ไว้ใช้เฝ้าดู
 * ก่อนเปิดจริง · ปลดออกทั้งหน้าจอ โค้ด และ CHECK ของตารางแล้วเมื่อ 2026-08-25
 * (migrations/changes/2026-08-25_02_credit_policy_drop_warn_mode.sql ไล่ค่าที่ค้าง warn → off)
 * ⇒ DB เขียนค่านี้ไม่ได้อีกแล้ว โค้ดข้างล่างจึงไม่ต้องมีสาขารับ warn
 */
export type CreditPolicyMode = 'off' | 'block';

export interface CreditPolicy {
  mode: CreditPolicyMode;
  dormant_months: number;
}

/**
 * ค่าที่ใช้เมื่ออ่านแถวเกณฑ์ไม่เจอ — ต้องเป็น 'off' เสมอ
 *
 * "แถวหาย" ต่างจาก "query พัง": query พังจะ throw ขึ้นไปให้ caller fail-closed อยู่แล้ว
 * ส่วนแถวหายแปลว่ายังไม่ได้ตั้งค่า (หรือมีคนลบทิ้ง) ⇒ ระบบต้องทำงานเหมือนก่อนมีฟีเจอร์นี้
 * ไม่ใช่บล็อกทุกคนเพราะไม่รู้เกณฑ์
 */
const DEFAULT_POLICY: CreditPolicy = { mode: 'off', dormant_months: 12 };

/** รหัสบริษัทที่ใช้ได้จริง — ใบที่ยังไม่ผูกบริษัทส่ง 0/null/undefined เข้ามาได้ */
function normalizeCompanyId(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** เกณฑ์ปัจจุบัน (cache 60 วิ ผ่าน services/rules/cache.ts — หน้าแอดมินล้างเองตอนบันทึก) */
export async function loadCreditPolicy(): Promise<CreditPolicy> {
  const rows = await loadCached<CreditPolicy>('quotation_credit_policy', async () => {
    const { rows } = await pool.query(
      'SELECT mode, dormant_months FROM public.quotation_credit_policy WHERE id = 1'
    );
    return rows as CreditPolicy[];
  });

  const row = rows[0];
  if (!row) return DEFAULT_POLICY;

  const months = Number(row.dormant_months);
  return {
    // อ่านค่าที่ไม่รู้จักเป็น 'off' เสมอ (เช่น dump เก่าที่ยังมี warn) — ไม่ใช่ 'block'
    // เดาผิดทาง off คือ "ไม่ตรวจ" ซึ่งเท่ากับก่อนมีฟีเจอร์ · เดาผิดทาง block คือบล็อกทั้งระบบ
    mode: row.mode === 'block' ? 'block' : 'off',
    dormant_months: Number.isInteger(months) && months > 0 ? months : DEFAULT_POLICY.dormant_months,
  };
}

export interface CreditHoldResult {
  /** เข้าเกณฑ์ "เงียบเกินกำหนด" หรือไม่ (ไม่สนใจ mode) */
  dormant: boolean;
  /** ต้องบล็อกจริงหรือไม่ — เป็น true เฉพาะ mode = 'block' */
  held: boolean;
  /** วันบิลล่าสุดของนิติบุคคลนี้ · null = ไม่เข้าข่ายตรวจ (ดู 3 สาเหตุที่หัวไฟล์) */
  last_order_at: Date | null;
  /** เกณฑ์ที่ใช้ตัดสินรอบนี้ (เอาไปประกอบข้อความให้เซลล์) */
  dormant_months: number;
}

/**
 * บริษัทรายนี้ต้องถูกระงับเพราะไม่มีคำสั่งซื้อมานานเกินเกณฑ์หรือไม่
 *
 * กติกา (ตกลงกันไว้ 2026-08-20 · เพิ่มเงื่อนไขเครดิต + นับเฉพาะใบที่ออกบิล 2026-08-25):
 *   ไม่ใช่ลูกค้าเครดิต/เช็คล่วงหน้า → ผ่าน  ← Cash จ่ายหน้างาน ไม่มีความเสี่ยงเครดิต
 *   ไม่เคยมีใบที่ออกบิลเลย        → ผ่าน  ← ลูกค้าใหม่/prospect ต้องเสนอราคาได้ตามปกติ
 *   บิลล่าสุด ≥ เกณฑ์             → ผ่าน
 *   บิลล่าสุด < เกณฑ์              → บล็อก
 *
 * สองข้อบนไม่มีโค้ดในไฟล์นี้ — view คืน last_order_at = NULL ให้เองทั้งคู่ (ดูหัวไฟล์)
 *
 * `max(last_order_at) < now() - ...` คืน NULL เมื่อไม่มีค่า ซึ่งไม่ใช่ true
 * ⇒ ทั้งเคส "ไม่ใช่เครดิต" และ "ไม่เคยมีบิล" ผ่านด่านไปเองโดยไม่ต้องเขียนเงื่อนไขแยก
 *
 * บริษัทที่หาไม่เจอใน customers_data_view ก็คืน dormant=false ด้วยเหตุผลเดียวกัน —
 * ไม่มีข้อมูลให้ตัดสิน และใบพวกนั้นติดด่าน isCustomerInfoIncomplete อยู่แล้ว
 */
export async function checkCreditHold(companyId: unknown): Promise<CreditHoldResult> {
  const policy = await loadCreditPolicy();
  const miss: CreditHoldResult = {
    dormant: false,
    held: false,
    last_order_at: null,
    dormant_months: policy.dormant_months,
  };

  if (policy.mode === 'off') return miss;

  const company = normalizeCompanyId(companyId);
  if (company === null) return miss;

  const { rows } = await pool.query(
    `SELECT max(last_order_at)                                              AS last_order_at,
            max(last_order_at) < now() - make_interval(months => $2::int)   AS dormant
       FROM public.customers_data_view
      WHERE company_id = $1`,
    [company, policy.dormant_months]
  );

  const dormant = rows[0]?.dormant === true;
  const lastOrderAt: Date | null = rows[0]?.last_order_at ?? null;

  return {
    dormant,
    held: dormant && policy.mode === 'block',
    last_order_at: lastOrderAt,
    dormant_months: policy.dormant_months,
  };
}

/**
 * ใช้ติดป้ายเตือนในผลค้นหา — คืน Set ของ company_id ที่ถูกระงับ
 *
 * query เดียวจบทั้งชุดผลลัพธ์ ไม่ยิงทีละแถว เพราะผลค้นหามีได้ถึง 30 รายการต่อครั้ง
 * (แบบเดียวกับ findBlockedCompanyIds ของ blacklist)
 *
 * เช็ค mode ซ้ำที่นี่ด้วย ไม่ใช่พึ่งว่า caller จะเรียกเฉพาะตอนเปิด — ป้าย "ห้ามคลิก"
 * ฝั่ง UI มีผลเท่ากับบล็อกจริง ถ้าหลุดออกไปตอน mode = off จะกลายเป็นบล็อกทั้งที่เกณฑ์ปิดอยู่
 */
export async function findCreditHeldCompanyIds(companyIds: unknown[]): Promise<Set<number>> {
  const policy = await loadCreditPolicy();
  if (policy.mode !== 'block') return new Set();

  const ids = [
    ...new Set(companyIds.map(normalizeCompanyId).filter((n): n is number => n !== null)),
  ];
  if (ids.length === 0) return new Set();

  const { rows } = await pool.query(
    `SELECT company_id
       FROM public.customers_data_view
      WHERE company_id = ANY($1::int[])
      GROUP BY company_id
     HAVING max(last_order_at) < now() - make_interval(months => $2::int)`,
    [ids, policy.dormant_months]
  );

  return new Set(rows.map((r: { company_id: number }) => Number(r.company_id)));
}

// ═══════════════════════════ หน้าจัดการฝั่งแอดมิน ═══════════════════════════

/** อ่านเกณฑ์แบบข้ามcache — หน้าแอดมินต้องเห็นค่าที่เพิ่งบันทึกทันที ไม่ใช่ค่าค้างใน cache */
export async function getCreditPolicyFresh(): Promise<CreditPolicy> {
  const { rows } = await pool.query(
    'SELECT mode, dormant_months FROM public.quotation_credit_policy WHERE id = 1'
  );
  const row = rows[0];
  return row
    ? { mode: row.mode, dormant_months: Number(row.dormant_months) }
    : DEFAULT_POLICY;
}

/**
 * บันทึกเกณฑ์ใหม่ — คืน null เมื่อค่าที่ส่งมาใช้ไม่ได้ (ให้ caller ตอบ 400)
 *
 * ตรวจค่าที่นี่ด้วยแทนที่จะพึ่ง CHECK constraint อย่างเดียว เพราะ error ของ constraint
 * เป็นข้อความอังกฤษของ Postgres ซึ่งเอาไปโชว์ในหน้าแอดมินไม่ได้
 */
export async function saveCreditPolicy(input: {
  mode: unknown;
  dormantMonths: unknown;
  updatedBy: number | null;
}): Promise<CreditPolicy | null> {
  const mode = input.mode;
  if (mode !== 'off' && mode !== 'block') return null;

  const months = Number(input.dormantMonths);
  if (!Number.isInteger(months) || months < 1 || months > 240) return null;

  const { rows } = await pool.query(
    `UPDATE public.quotation_credit_policy
        SET mode = $1, dormant_months = $2, updated_at = CURRENT_TIMESTAMP, updated_by = $3
      WHERE id = 1
      RETURNING mode, dormant_months`,
    [mode, months, input.updatedBy]
  );

  const row = rows[0];
  if (!row) return null;
  return { mode: row.mode, dormant_months: Number(row.dormant_months) };
}
