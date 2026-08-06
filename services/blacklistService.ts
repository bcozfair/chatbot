// ─────────────────────────────────────────────────────────────────────────────
//  บัญชีห้ามเสนอราคา (blacklist) — จุดเดียวในระบบที่รู้จักโครงสร้างตาราง quotation_blacklist
//
//  ไฟล์นี้ถือ "ความรู้เรื่องตาราง" อย่างเดียว ไม่มีถ้อยคำที่แสดงให้เซลล์เห็น และไม่ตัดสินว่า
//  จะบล็อกตรงไหน — การบล็อกจริงเป็นเงื่อนไข CUSTOMER_BLACKLISTED ใน validateQuotationItems()
//  ของ services/quotationService.ts (ดู docs/plan-user-roles-auth.md §4.4)
//
//  ⚠️ ทุกฟังก์ชันในไฟล์นี้ปล่อยให้ error ลอยขึ้นไปหา caller โดยตั้งใจ ห้ามกลืนเป็นค่า false/ว่าง
//     เพราะด่านตรวจกฎเป็น fail-closed — DB ล่มต้องกลายเป็น "ตรวจไม่สำเร็จ ห้ามออกใบ"
//     ไม่ใช่ "ไม่พบในบัญชีดำ ปล่อยผ่าน"
// ─────────────────────────────────────────────────────────────────────────────

import { pool } from '../config/db.js';

/**
 * ในตาราง blacklist "บล็อกทั้งบริษัท" เขียนด้วย contact_id = NULL เท่านั้น
 *
 * แต่ customers_data_view ใช้ contact_id = 0 แทนแถวบริษัทที่ไม่มีผู้ติดต่อ
 * (ดู CONTACT_VIEW_COLS ใน db/repositories.ts) และใบเสนอราคาที่ยังไม่ผูกผู้ติดต่อ
 * ก็อาจเก็บมาเป็น 0 ได้ — ต้องยุบให้เหลือ null ก่อนเทียบเสมอ ไม่งั้นจะกลายเป็นการหา
 * "ผู้ติดต่อรหัส 0" ซึ่งไม่มีวันเจอ แล้วหลุดด่านไปทั้งที่บริษัทถูกบล็อกอยู่
 */
function normalizeId(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * ลูกค้ารายนี้ถูกห้ามเสนอราคาหรือไม่
 *
 * บล็อกเมื่อเจออย่างใดอย่างหนึ่ง: แถวระดับบริษัท (contact_id IS NULL) หรือแถวที่ตรงทั้งคู่
 * → ขึ้นบัญชีทั้งบริษัทแล้วผู้ติดต่อทุกคนโดนหมด แต่ขึ้นบัญชีผู้ติดต่อ A ไม่กระทบผู้ติดต่อ B
 *
 * ยังไม่ผูกบริษัท (companyId ว่าง/0) = ยังไม่มีอะไรให้ตรวจ คืน false — ใบพวกนี้ยืนยันไม่ได้อยู่แล้ว
 * ด้วยเงื่อนไขสถานะ pending_* และด่าน isCustomerInfoIncomplete
 */
export async function isBlacklisted(
  companyId: unknown,
  contactId: unknown
): Promise<boolean> {
  const company = normalizeId(companyId);
  if (company === null) return false;

  const contact = normalizeId(contactId);

  // contact_id = $2 เมื่อ $2 เป็น NULL จะได้ผลลัพธ์ NULL (ไม่ใช่ true) → เหลือแค่สาขา IS NULL
  // ซึ่งเป็นพฤติกรรมที่ต้องการพอดี: ไม่รู้ผู้ติดต่อ = ตรวจได้แค่ระดับบริษัท
  const { rowCount } = await pool.query(
    `SELECT 1 FROM public.quotation_blacklist
      WHERE company_id = $1 AND (contact_id IS NULL OR contact_id = $2)
      LIMIT 1`,
    [company, contact]
  );

  return (rowCount ?? 0) > 0;
}

/**
 * ใช้ติดป้ายเตือนในผลค้นหา — คืน Set ของ company_id ที่ถูกบล็อก "ทั้งบริษัท"
 *
 * query เดียวจบทั้งชุดผลลัพธ์ ไม่ยิงทีละแถว เพราะผลค้นหามีได้ถึง 30 รายการต่อครั้ง
 * และเส้นทางแชทมีงบเวลาตอบกลับ (deadlineAt ใน handleEvent)
 *
 * เอาเฉพาะระดับบริษัทเพราะผลค้นหาชั้นนี้เป็นรายบริษัท ยังไม่รู้ว่าเซลล์จะเลือกผู้ติดต่อคนไหน
 * การเตือนระดับผู้ติดต่อทำตอนดึงรายชื่อผู้ติดต่อของบริษัทนั้นแยกต่างหาก
 */
export async function findBlockedCompanyIds(companyIds: unknown[]): Promise<Set<number>> {
  const ids = [...new Set(companyIds.map(normalizeId).filter((n): n is number => n !== null))];
  if (ids.length === 0) return new Set();

  const { rows } = await pool.query(
    `SELECT DISTINCT company_id FROM public.quotation_blacklist
      WHERE contact_id IS NULL AND company_id = ANY($1::int[])`,
    [ids]
  );

  return new Set(rows.map((r: { company_id: number }) => r.company_id));
}

/**
 * ใช้ติดป้ายเตือนในรายชื่อผู้ติดต่อของบริษัทเดียว
 *
 * wholeCompany = true → ผู้ติดต่อทุกคนของบริษัทนี้ถูกระงับ (ฝั่งเรียกไม่ต้องดู contactIds อีก)
 * contactIds   = ผู้ติดต่อที่ถูกระงับเป็นรายคน
 */
export async function findBlockedContacts(
  companyId: unknown
): Promise<{ wholeCompany: boolean; contactIds: Set<number> }> {
  const company = normalizeId(companyId);
  if (company === null) return { wholeCompany: false, contactIds: new Set() };

  const { rows } = await pool.query(
    'SELECT contact_id FROM public.quotation_blacklist WHERE company_id = $1',
    [company]
  );

  const contactIds = new Set<number>();
  let wholeCompany = false;
  for (const r of rows as { contact_id: number | null }[]) {
    if (r.contact_id === null) wholeCompany = true;
    else contactIds.add(r.contact_id);
  }
  return { wholeCompany, contactIds };
}

// ═══════════════════════════ หน้าจัดการฝั่งแอดมิน ═══════════════════════════

export interface BlacklistRow {
  id: number;
  company_id: number;
  contact_id: number | null;
  company_name: string | null;
  contact_name: string | null;
  reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

/**
 * รายการทั้งหมดพร้อมชื่อบริษัท/ผู้ติดต่อสำหรับแสดงผล
 *
 * ⚠️ ต้องเป็น LEFT JOIN เท่านั้น — customers_data_view ถูกสร้างใหม่ทั้งก้อนทุกรอบ sync
 * ลูกค้าที่ถูกลบจาก Odoo จะหายไปจากตารางนั้น ถ้าใช้ INNER JOIN รายการที่ยังบล็อกอยู่จริง
 * จะหายจากหน้าจอจนแอดมินปลดออกไม่ได้ → ชื่อเป็น null ให้ฝั่ง UI โชว์ id ดิบแทน
 */
export async function listBlacklist(): Promise<BlacklistRow[]> {
  const { rows } = await pool.query(
    `SELECT b.id, b.company_id, b.contact_id, b.reason, b.created_at,
            au.name AS created_by_name,
            co.customer_name AS company_name,
            ct.contact_name  AS contact_name
       FROM public.quotation_blacklist b
       LEFT JOIN public.admin_users au ON au.id = b.created_by
       LEFT JOIN LATERAL (
         SELECT customer_name FROM public.customers_data_view
          WHERE company_id = b.company_id AND customer_name IS NOT NULL
          ORDER BY contact_id LIMIT 1
       ) co ON true
       LEFT JOIN LATERAL (
         SELECT contact_name FROM public.customers_data_view
          WHERE company_id = b.company_id AND contact_id = b.contact_id LIMIT 1
       ) ct ON true
      ORDER BY b.created_at DESC, b.id DESC`
  );
  return rows as BlacklistRow[];
}

/** เพิ่มรายการ — คืน null เมื่อ companyId ใช้ไม่ได้ · โยน error รหัส 23505 เมื่อมีอยู่แล้ว */
export async function addBlacklistEntry(input: {
  companyId: unknown;
  contactId: unknown;
  reason: unknown;
  createdBy: number | null;
}): Promise<{ id: number } | null> {
  const company = normalizeId(input.companyId);
  if (company === null) return null;

  const contact = normalizeId(input.contactId);
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null;

  const { rows } = await pool.query(
    `INSERT INTO public.quotation_blacklist (company_id, contact_id, reason, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [company, contact, reason, input.createdBy]
  );
  return { id: rows[0].id };
}

/** ปลดออกจากบัญชี — คืน false เมื่อไม่มีแถวนั้น (กดลบซ้ำ/คนอื่นลบไปก่อน) */
export async function removeBlacklistEntry(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM public.quotation_blacklist WHERE id = $1',
    [id]
  );
  return (rowCount ?? 0) > 0;
}
