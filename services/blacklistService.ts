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
import {
  companyKeysSql,
  contactKeySql,
  matchesKeysSql,
  keysOverlapSql,
} from '../db/companyIdentity.js';

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

// นิยาม "เป็นนิติบุคคลเดียวกัน" ย้ายไป db/companyIdentity.ts แล้ว (import ด้านบน)
// เพราะฝั่งค้นผู้ติดต่อให้เซลส์เลือกต้องใช้กติกาชุดเดียวกันเป๊ะ — ถ้านิยามแยกกันสองที่
// จะเกิดช่องที่ "ค้นเจอแต่ด่านไม่เห็น" (เกิดขึ้นจริงแล้ว 2026-08-07: บล็อก company_id 1
// แต่ใบออกด้วย company_id 969120 ซึ่งเป็นนิติบุคคลเดียวกัน)

/**
 * CTE `bl` = ทุกแถวในบัญชีดำ พร้อมคีย์ของนิติบุคคลที่แถวนั้นชี้ถึง
 *
 * ⚠️ ต้องเป็น CROSS JOIN LATERAL — LATERAL บังคับให้ `c.company_id = b.company_id`
 *    เป็น index cond เสมอ planner จะเอาไปแปลงเป็น hashed subplan ที่ scan ทั้งตารางไม่ได้
 *
 * ตาราง blacklist เล็ก (หลักสิบ) การยิง index scan ต่อแถวจึงถูกกว่า scan cdv รอบเดียวมาก
 */
const BLACKLIST_KEYS_CTE = `
  bl AS (
    SELECT b.company_id, b.contact_id, k.taxes, k.refs, k.nms, k.cnms
      FROM public.quotation_blacklist b
      CROSS JOIN LATERAL (
        SELECT ${companyKeysSql('c')},
               ${contactKeySql('c', 'c.contact_id = b.contact_id')}
          FROM public.customers_data_view c
         WHERE c.company_id = b.company_id
      ) k
  )`;

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

  // เงื่อนไขท่อนล่างอ่านว่า "แถวนี้กินถึงผู้ติดต่อรายนี้ไหม":
  //   contact_id IS NULL         → แถวระดับบริษัท กินทุกคนอยู่แล้ว
  //   ตรงทั้ง company_id/contact_id → คนเดียวกันแบบไม่ต้องเดา
  //   me.cnms && bl.cnms          → คนเดียวกันที่อยู่คนละรหัสบริษัทในนิติบุคคลเดียวกัน
  //
  // ไม่รู้ผู้ติดต่อ (contact เป็น null) → me.cnms เป็น NULL ผลของ && เป็น NULL ไม่ใช่ true
  // จึงเหลือตรวจได้แค่ระดับบริษัท ซึ่งเป็นพฤติกรรมที่ต้องการพอดี
  const { rowCount } = await pool.query(
    `WITH me AS (
       SELECT ${companyKeysSql('m')},
              ${contactKeySql('m', 'm.contact_id = $2::int')}
         FROM public.customers_data_view m
        WHERE m.company_id = $1
     ),
     ${BLACKLIST_KEYS_CTE}
     SELECT 1
       FROM bl, me
      WHERE (bl.company_id = $1 OR ${keysOverlapSql('me', 'bl')})
        AND (bl.contact_id IS NULL
             OR (bl.company_id = $1 AND bl.contact_id = $2::int)
             OR me.cnms && bl.cnms)
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
    `WITH ${BLACKLIST_KEYS_CTE}
     SELECT DISTINCT u.company_id
       FROM unnest($1::int[]) AS u(company_id)
       CROSS JOIN LATERAL (
         SELECT ${companyKeysSql('m')}
           FROM public.customers_data_view m
          WHERE m.company_id = u.company_id
       ) me
       JOIN bl ON bl.contact_id IS NULL
              AND (bl.company_id = u.company_id OR ${keysOverlapSql('me', 'bl')})`,
    [ids]
  );

  return new Set(rows.map((r: { company_id: number }) => r.company_id));
}

/**
 * ใช้ติดป้ายเตือนในรายชื่อผู้ติดต่อของบริษัทเดียว
 *
 * wholeCompany = true → ผู้ติดต่อทุกคนของบริษัทนี้ถูกระงับ (ฝั่งเรียกไม่ต้องดู contactIds อีก)
 * contactIds   = ผู้ติดต่อที่ถูกระงับเป็นรายคน
 *
 * ⚠️ contactIds ต้องเป็นรหัสของ "บริษัทที่ถาม" ($1) เท่านั้น ห้ามคืน contact_id ในบัญชีดำดิบ ๆ
 *    เพราะรายการนั้นอาจถูกบันทึกไว้ใต้รหัสบริษัทพี่น้องคนละตัว แล้ว contact_id ของมัน
 *    จะไม่มีวันตรงกับรหัสในรายชื่อที่ฝั่งเรียกกำลังจะเอาไปติดป้าย → ป้ายไม่ขึ้นทั้งที่โดนบล็อกจริง
 */
export async function findBlockedContacts(
  companyId: unknown
): Promise<{ wholeCompany: boolean; contactIds: Set<number> }> {
  const company = normalizeId(companyId);
  if (company === null) return { wholeCompany: false, contactIds: new Set() };

  // NULL หนึ่งแถว = ถูกระงับทั้งบริษัท / แถวที่เหลือ = รหัสผู้ติดต่อของบริษัทนี้ที่โดนรายคน
  const { rows } = await pool.query(
    `WITH ${BLACKLIST_KEYS_CTE},
     me AS (
       SELECT ${companyKeysSql('m')}
         FROM public.customers_data_view m
        WHERE m.company_id = $1
     ),
     hit AS (
       SELECT bl.* FROM bl, me
        WHERE bl.company_id = $1 OR ${keysOverlapSql('me', 'bl')}
     )
     SELECT DISTINCT contact_id FROM (
       SELECT NULL::int AS contact_id FROM hit WHERE hit.contact_id IS NULL
       UNION ALL
       SELECT q.contact_id
         FROM hit
         JOIN public.customers_data_view q ON q.company_id = $1
        WHERE hit.contact_id IS NOT NULL
          AND ((hit.company_id = $1 AND q.contact_id = hit.contact_id)
               OR NULLIF(TRIM(q.contact_name),'') = ANY(hit.cnms))
     ) x`,
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

export interface RelatedCompany {
  company_id: number;
  display_name: string | null;
  reference: string | null;
  tax_id: string | null;
}

/**
 * รหัสบริษัททั้งหมดที่จะถูกครอบถ้าบล็อก companyId นี้ (รวมตัวมันเอง)
 *
 * มีไว้ให้หน้าแอดมินโชว์ก่อนกดบันทึก — เกณฑ์ "ชื่อตรงกัน" ครอบกว้างกว่าที่คนคาด
 * โดยเฉพาะลูกค้าที่บันทึกชื่อเป็นชื่อบุคคล ("คุณไก่" ผูก 4 รหัสที่เป็นคนละคน)
 * ถ้าไม่โชว์ แอดมินจะไม่มีทางรู้ว่ากดครั้งเดียวแล้วโดนใครบ้าง
 *
 * ตรงนี้ scan cdv รอบเดียวโดยตั้งใจ (~85 ms) — คำถาม "มีใครบ้าง" ไม่มี index รองรับ
 * ต่างจากด่านตรวจที่ถามแค่ "รายนี้โดนไหม" ราคานี้จ่ายเฉพาะตอนแอดมินเปิดดู ไม่อยู่ในเส้นทางแชท
 */
export async function listRelatedCompanies(companyId: unknown): Promise<RelatedCompany[]> {
  const company = normalizeId(companyId);
  if (company === null) return [];

  const { rows } = await pool.query(
    `WITH me AS (
       SELECT ${companyKeysSql('m')}
         FROM public.customers_data_view m
        WHERE m.company_id = $1
     )
     SELECT DISTINCT ON (t.company_id)
            t.company_id,
            NULLIF(TRIM(t.customer_name),'')      AS display_name,
            NULLIF(TRIM(t.customer_reference),'') AS reference,
            NULLIF(TRIM(t.customer_tax_id),'')    AS tax_id
       FROM public.customers_data_view t, me
      WHERE t.company_id = $1 OR ${matchesKeysSql('t', 'me')}
      ORDER BY t.company_id, t.contact_id`,
    [company]
  );
  return rows as RelatedCompany[];
}

export interface RelatedContact {
  company_id: number;
  contact_id: number;
  contact_name: string | null;
  company_name: string | null;
  reference: string | null;
}

/**
 * คู่ (บริษัท, ผู้ติดต่อ) ทั้งหมดที่จะถูกครอบถ้าบล็อกเฉพาะผู้ติดต่อรายนี้
 *
 * คู่กับ listRelatedCompanies แต่ใช้ตอนแอดมินเลือก "ระงับเฉพาะผู้ติดต่อ" — จำเป็นเพราะ
 * การขยายชั้นผู้ติดต่ออาศัยชื่อ แอดมินต้องเห็นว่าไปโดนใครใต้รหัสไหนบ้างก่อนกดบันทึก
 *
 * คืนอย่างน้อยหนึ่งแถวเสมอเมื่อคู่นั้นมีอยู่จริง เพราะเงื่อนไขแรกคือตัวมันเอง
 */
export async function listRelatedContacts(
  companyId: unknown,
  contactId: unknown
): Promise<RelatedContact[]> {
  const company = normalizeId(companyId);
  const contact = normalizeId(contactId);
  if (company === null || contact === null) return [];

  const { rows } = await pool.query(
    `WITH me AS (
       SELECT ${companyKeysSql('m')},
              ${contactKeySql('m', 'm.contact_id = $2::int')}
         FROM public.customers_data_view m
        WHERE m.company_id = $1
     )
     SELECT t.company_id,
            t.contact_id,
            NULLIF(TRIM(t.contact_name),'')       AS contact_name,
            NULLIF(TRIM(t.customer_name),'')      AS company_name,
            NULLIF(TRIM(t.customer_reference),'') AS reference
       FROM public.customers_data_view t, me
      WHERE (t.company_id = $1 OR ${matchesKeysSql('t', 'me')})
        AND ((t.company_id = $1 AND t.contact_id = $2::int)
             OR NULLIF(TRIM(t.contact_name),'') = ANY(me.cnms))
      ORDER BY t.company_id, t.contact_id`,
    [company, contact]
  );
  return rows as RelatedContact[];
}

export interface BlacklistRow {
  id: number;
  company_id: number;
  contact_id: number | null;
  company_name: string | null;
  company_reference: string | null;
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
 *
 * ⚠️ ตั้งใจไม่นับ "ครอบกี่รหัสบริษัท" ตรงนี้ — เคยลองแล้ววัดได้ 2.7 วิ (LATERAL ต่อแถว)
 * และ 12.5 วิ (CTE + UNION) เพราะการเทียบชื่อ/รหัสไม่มี index รองรับเลยต้อง scan cdv 82k แถว
 * ความครอบไปแสดงในหน้าแก้ไขแทน ผ่าน listRelatedCompanies/listRelatedContacts
 * ซึ่งจ่ายเฉพาะตอนแอดมินเปิดดู
 */
export async function listBlacklist(): Promise<BlacklistRow[]> {
  const { rows } = await pool.query(
    `SELECT b.id, b.company_id, b.contact_id, b.reason, b.created_at,
            au.name AS created_by_name,
            co.customer_name      AS company_name,
            cr.customer_reference AS company_reference,
            ct.contact_name       AS contact_name
       FROM public.quotation_blacklist b
       LEFT JOIN public.admin_users au ON au.id = b.created_by
       LEFT JOIN LATERAL (
         SELECT customer_name FROM public.customers_data_view
          WHERE company_id = b.company_id AND customer_name IS NOT NULL
          ORDER BY contact_id LIMIT 1
       ) co ON true
       -- แยก lateral ของรหัสอ้างอิงออกจากชื่อ เพราะ cdv มี 1 แถวต่อผู้ติดต่อ และบางแถว
       -- customer_reference เป็น NULL ทั้งที่แถวอื่นของบริษัทเดียวกันมีค่า — ถ้ารวมไว้ใน
       -- lateral เดียวจะได้รหัสว่างตามแถวที่ถูกเลือกด้วยเงื่อนไขของ "ชื่อ"
       LEFT JOIN LATERAL (
         SELECT customer_reference FROM public.customers_data_view
          WHERE company_id = b.company_id
            AND customer_reference IS NOT NULL AND customer_reference <> ''
          ORDER BY contact_id LIMIT 1
       ) cr ON true
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

/**
 * แก้ไขขอบเขต (ทั้งบริษัท ↔ เฉพาะผู้ติดต่อ) และเหตุผล — คืน false เมื่อไม่มีแถวนั้น
 *
 * ไม่เปิดให้แก้ `company_id` โดยตั้งใจ: เปลี่ยนบริษัทคือคนละรายการ ให้ปลดแล้วเพิ่มใหม่
 * จะได้ไม่เสียประวัติว่าใครเป็นคนขึ้นบัญชีบริษัทเดิมไว้เมื่อไหร่
 *
 * ชนกับรายการที่มีอยู่แล้ว (เช่นแก้เป็น "ทั้งบริษัท" ทั้งที่มีแถวนั้นอยู่) → โยน error รหัส 23505
 */
export async function updateBlacklistEntry(
  id: number,
  input: { contactId: unknown; reason: unknown }
): Promise<boolean> {
  const contact = normalizeId(input.contactId);
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null;

  const { rowCount } = await pool.query(
    `UPDATE public.quotation_blacklist
        SET contact_id = $1, reason = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3`,
    [contact, reason, id]
  );
  return (rowCount ?? 0) > 0;
}

/** ปลดออกจากบัญชี — คืน false เมื่อไม่มีแถวนั้น (กดลบซ้ำ/คนอื่นลบไปก่อน) */
export async function removeBlacklistEntry(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM public.quotation_blacklist WHERE id = $1',
    [id]
  );
  return (rowCount ?? 0) > 0;
}
