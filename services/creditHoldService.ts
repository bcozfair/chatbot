// ─────────────────────────────────────────────────────────────────────────────
//  ระงับการเสนอราคาบริษัทที่ไม่มีคำสั่งซื้อมานาน (credit hold)
//
//  ไฟล์นี้ถือ "ความรู้เรื่องเกณฑ์" อย่างเดียว ไม่มีถ้อยคำที่แสดงให้เซลล์เห็น และไม่ตัดสินว่า
//  จะบล็อกตรงไหน — การบล็อกจริงเป็นเงื่อนไข CUSTOMER_CREDIT_HOLD ใน validateQuotationItems()
//  ของ services/quotationService.ts (แบบเดียวกับ blacklistService.ts)
//
//  ── ข้อมูลมาจากไหน ──
//  customers_data_view.last_order_at = วันที่มีคำสั่งซื้อล่าสุดของ "นิติบุคคล" ที่บริษัทนี้สังกัด
//  คำนวณไว้แล้วตอน build ตาราง (นิยามอยู่ใน view customers_data_build — ดู migrations/schema.sql)
//  ไฟล์นี้จึงแค่อ่านค่ามาเทียบกับเกณฑ์ ไม่ไปไล่ sale_orders เอง
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

/** off = ไม่ตรวจเลย · warn = ตรวจ+log แต่ยังออกใบได้ · block = ห้ามออกใบ */
export type CreditPolicyMode = 'off' | 'warn' | 'block';

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
    mode: row.mode === 'warn' || row.mode === 'block' ? row.mode : 'off',
    dormant_months: Number.isInteger(months) && months > 0 ? months : DEFAULT_POLICY.dormant_months,
  };
}

export interface CreditHoldResult {
  /** เข้าเกณฑ์ "เงียบเกินกำหนด" หรือไม่ (ไม่สนใจ mode) */
  dormant: boolean;
  /** ต้องบล็อกจริงหรือไม่ — เป็น true เฉพาะ mode = 'block' */
  held: boolean;
  /** วันที่ซื้อล่าสุดของนิติบุคคลนี้ · null = ไม่เคยซื้อเลย */
  last_order_at: Date | null;
  /** เกณฑ์ที่ใช้ตัดสินรอบนี้ (เอาไปประกอบข้อความให้เซลล์) */
  dormant_months: number;
}

/**
 * บริษัทรายนี้ต้องถูกระงับเพราะไม่มีคำสั่งซื้อมานานเกินเกณฑ์หรือไม่
 *
 * กติกา (ตกลงกันไว้ 2026-08-20):
 *   ไม่เคยมี sale_order เลย  → ผ่าน  ← ลูกค้าใหม่/prospect ต้องเสนอราคาได้ตามปกติ
 *   ซื้อล่าสุด ≥ เกณฑ์        → ผ่าน
 *   ซื้อล่าสุด < เกณฑ์         → บล็อก
 *
 * `max(last_order_at) < now() - ...` คืน NULL เมื่อไม่มีคำสั่งซื้อเลย ซึ่งไม่ใช่ true
 * ⇒ เคส "ไม่เคยซื้อ" ผ่านด่านไปเองโดยไม่ต้องเขียนเงื่อนไขแยก
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

  // โหมด warn มีไว้ให้ดูก่อนเปิดจริงว่า "ถ้าเปิดแล้วจะโดนใครบ้าง" — log ที่นี่ที่เดียว
  // จะได้ไม่ต้องไปเติม log ให้ครบทุกด่านที่เรียกฟังก์ชันนี้
  if (dormant && policy.mode === 'warn') {
    console.warn(
      `[creditHold] (warn) company_id=${company} ซื้อล่าสุด ${lastOrderAt?.toISOString() ?? '-'} ` +
        `เกินเกณฑ์ ${policy.dormant_months} เดือน — ยังปล่อยผ่านเพราะ mode=warn`
    );
  }

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
 * คืนเฉพาะตอน mode = 'block' โดยตั้งใจ — โหมด warn ยังออกใบได้ ถ้าติดป้ายห้ามคลิก
 * ฝั่ง UI จะกลายเป็นบล็อกจริงทั้งที่เกณฑ์ยังไม่เปิด
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
  if (mode !== 'off' && mode !== 'warn' && mode !== 'block') return null;

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
