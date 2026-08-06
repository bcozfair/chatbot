/**
 * repositories — ชั้นเข้าถึงฐานข้อมูลด้วย pool.query + SQL ตรงๆ (แทน Supabase-style builder เดิม)
 *
 * กติกา:
 *  - ทุกฟังก์ชัน SELECT คืน rows (array) หรือ [] เมื่อ error — log error ภายใน ไม่ throw
 *    (คงพฤติกรรมเดิมของ dbClient ที่ caller เช็ค data null/[] แล้วไปต่อ)
 *  - ฟังก์ชัน INSERT/UPDATE/DELETE คืน rows จาก RETURNING * หรือ null เมื่อ error
 *  - ชื่อคอลัมน์ mapping ที่ dbClient เคยซ่อนไว้ ถูกเขียนตรงๆ ใน SQL:
 *      customers_view.branch → alias เป็น branch_code
 */
import { pool, type DbExecutor } from '../config/db.js';

function logErr(fn: string, err: any): void {
  console.error(`[repo.${fn}]`, err?.message || err);
}

// ═══════════════════════════ customers ═══════════════════════════

// Phase 3: customers_view/contacts_view ถูกปลดแล้ว — ทุก query ลูกค้า/ผู้ติดต่ออ่านจาก customers_data_view
// (ตารางรวม customers+sale_orders → เห็น orphan company/contact ที่มีเฉพาะใน sale_orders ด้วย)
//
// CDV_COMPANY_SUBQ = 1 แถว/บริษัท (DISTINCT ON company_id, contact แรก) map ชื่อคอลัมน์ให้ตรง customers_view เดิมเป๊ะ
//   (id/display_name/reference/tax_id/phone/email/branch/salesperson/customer_type/customer_payment_terms)
//   → wrapper เดิมที่ทำ `... branch AS branch_code` ใช้ต่อได้ไม่ต้องแก้
// CDV_CONTACT_SUBQ = 1 แถว/ผู้ติดต่อ map ตรง contacts_view เดิม (id/name/mobile/phone/email/invoice_*/customer_id)
//   phone=COALESCE(contact_phone,phone) email=COALESCE(contact_email,email); contact_id>0 กัน row บริษัทไม่มีชื่อ
const CDV_COMPANY_SUBQ =
  `SELECT DISTINCT ON (company_id)
     company_id             AS id,
     customer_name          AS display_name,
     customer_reference     AS reference,
     customer_tax_id        AS tax_id,
     phone,
     email,
     customer_sale_area     AS branch,
     salesperson,
     customer_type,
     customer_payment_terms
   FROM customers_data_view
   WHERE customer_name IS NOT NULL
   ORDER BY company_id, contact_id`;

const CDV_CONTACT_SUBQ =
  `SELECT contact_id AS id, contact_name AS name, contact_mobile AS mobile,
     COALESCE(contact_phone, phone) AS phone, COALESCE(contact_email, email) AS email,
     invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip,
     company_id AS customer_id
   FROM customers_data_view WHERE contact_id > 0`;

const CUSTOMER_VIEW_COLS =
  'id, display_name, reference, tax_id, phone, email, branch AS branch_code, salesperson, customer_type, customer_payment_terms';

/** ค้นหาลูกค้าจาก reference codes (ILIKE ANY) — ใช้ใน reference fast-path */
export async function searchCustomersByReferencePatterns(refs: string[], limit = 30): Promise<any[]> {
  if (!refs.length) return [];
  try {
    const patterns = refs.map(r => `%${r}%`);
    const { rows } = await pool.query(
      `SELECT id, display_name, reference, branch AS branch_code, salesperson
       FROM (${CDV_COMPANY_SUBQ}) v WHERE v.reference ILIKE ANY($1::text[]) LIMIT $2`,
      [patterns, limit]);
    return rows;
  } catch (err) { logErr('searchCustomersByReferencePatterns', err); return []; }
}

/** ค้นหาลูกค้าจากชื่อ (ILIKE ANY ของหลาย pattern) — ใช้ใน phrase/name-term query */
export async function searchCustomersByNamePatterns(terms: string[], limit: number): Promise<any[]> {
  if (!terms.length) return [];
  try {
    const patterns = terms.map(t => `%${t}%`);
    const { rows } = await pool.query(
      `SELECT id, display_name, reference, branch AS branch_code, salesperson
       FROM (${CDV_COMPANY_SUBQ}) v WHERE v.display_name ILIKE ANY($1::text[]) LIMIT $2`,
      [patterns, limit]);
    return rows;
  } catch (err) { logErr('searchCustomersByNamePatterns', err); return []; }
}

/** ดึงลูกค้ารายตัวจาก id (customers_view) — คืน row เดียวหรือ null */
export async function getCustomerById(id: number | string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      `SELECT ${CUSTOMER_VIEW_COLS} FROM (${CDV_COMPANY_SUBQ}) v WHERE id = $1 LIMIT 1`, [id]);
    return rows[0] || null;
  } catch (err) { logErr('getCustomerById', err); return null; }
}

/** ดึงลูกค้าจากชื่อเต็มตรงตัว (ใช้ตอน rebuild snapshot ใบเสนอราคา) */
export async function getCustomerByDisplayName(displayName: string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      `SELECT ${CUSTOMER_VIEW_COLS} FROM (${CDV_COMPANY_SUBQ}) v WHERE display_name = $1 LIMIT 1`, [displayName]);
    return rows[0] || null;
  } catch (err) { logErr('getCustomerByDisplayName', err); return null; }
}

/** ผู้ติดต่อของบริษัท (กรองชื่อตรงตัวได้) — คืนแถวแรกหรือ null */
export async function getFirstContact(customerId: number | string, contactName?: string | null): Promise<any | null> {
  try {
    const params: any[] = [customerId];
    let nameFilter = '';
    if (contactName) {
      params.push(contactName);
      nameFilter = 'AND name = $2';
    }
    const { rows } = await pool.query(
      `SELECT * FROM (${CDV_CONTACT_SUBQ}) c WHERE c.customer_id = $1 ${nameFilter} LIMIT 1`, params);
    return rows[0] || null;
  } catch (err) { logErr('getFirstContact', err); return null; }
}

/** ที่อยู่ของบริษัทจากตารางฐาน customers (ทุกแถว contact ของบริษัท เรียงตาม contact_id) */
export async function getCompanyAddressRows(companyId: number | string): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip
       FROM customers WHERE company_id = $1 ORDER BY contact_id ASC`, [companyId]);
    return rows;
  } catch (err) { logErr('getCompanyAddressRows', err); return []; }
}

// ═══════════════════════════ contacts ═══════════════════════════

// contacts อ่านจาก customers_data_view (ตารางรวม customers+sale_orders) แทน contacts_view
// เพื่อให้ orphan contact ที่มีเฉพาะใน sale_orders (~5,906 คน เช่น คุณหนิง/คุณต๊อบ ของ ควอเซอร์) โผล่ใน picker ด้วย
// alias คอลัมน์ให้ตรง output เดิมของ contacts_view เป๊ะ: id/name/mobile/phone/email + invoice_* (blend แล้วใน view)
//   phone = COALESCE(contact_phone, phone) , email = COALESCE(contact_email, email) เหมือน contacts_view เดิม
//   contact_id>0 = ตัด row บริษัทไม่มีผู้ติดต่อ (contact_id=0 ไม่มีชื่อ → ไม่ให้โผล่เป็นผู้ติดต่อผี)
const CONTACT_VIEW_COLS =
  `contact_id AS id, contact_name AS name, contact_mobile AS mobile,
   COALESCE(contact_phone, phone) AS phone, COALESCE(contact_email, email) AS email,
   invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip`;

/** ผู้ติดต่อทั้งหมดของบริษัท */
export async function getContactsByCustomerId(customerId: number | string): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT ${CONTACT_VIEW_COLS} FROM customers_data_view
       WHERE company_id = $1 AND contact_id > 0
       ORDER BY contact_id`, [customerId]);
    return rows;
  } catch (err) { logErr('getContactsByCustomerId', err); return []; }
}

/** ผู้ติดต่อรายตัวจาก id */
export async function getContactById(contactId: number | string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      `SELECT ${CONTACT_VIEW_COLS}, company_id AS customer_id FROM customers_data_view
       WHERE contact_id = $1 LIMIT 1`, [contactId]);
    return rows[0] || null;
  } catch (err) { logErr('getContactById', err); return null; }
}

/** ชื่อผู้ติดต่อของหลายบริษัทพร้อมกัน (ใช้สร้าง evidence) */
export async function getContactNamesByCustomerIds(customerIds: any[]): Promise<any[]> {
  if (!customerIds.length) return [];
  try {
    const { rows } = await pool.query(
      `SELECT company_id AS customer_id, contact_name AS name FROM customers_data_view
       WHERE company_id = ANY($1) AND contact_id > 0 AND contact_name IS NOT NULL`,
      [customerIds]);
    return rows;
  } catch (err) { logErr('getContactNamesByCustomerIds', err); return []; }
}

/**
 * reverse lookup: หาบริษัทจากชื่อผู้ติดต่อ (JOIN ผู้ติดต่อ ↔ บริษัท จาก customers_data_view)
 * คืนรูป { name, customer_id, customers: { id, display_name, salesperson, branch_code } } ตาม shape เดิม
 */
export async function findContactsWithCustomerByName(
  namePattern: string, branchCodes: string[] | null, limit = 50
): Promise<any[]> {
  try {
    const params: any[] = [`%${namePattern}%`];
    let branchFilter = '';
    if (branchCodes && branchCodes.length > 0) {
      params.push(branchCodes);
      branchFilter = `AND cust.branch = ANY($${params.length})`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT c.name, c.customer_id,
              cust.id AS cust_id, cust.display_name, cust.salesperson, cust.branch AS branch_code
       FROM (${CDV_CONTACT_SUBQ}) c
       INNER JOIN (${CDV_COMPANY_SUBQ}) cust ON c.customer_id = cust.id
       WHERE c.name ILIKE $1 ${branchFilter}
       LIMIT $${params.length}`,
      params);
    return rows.map(r => ({
      name: r.name,
      customer_id: r.customer_id,
      customers: {
        id: r.cust_id,
        display_name: r.display_name,
        salesperson: r.salesperson,
        branch_code: r.branch_code,
      },
    }));
  } catch (err) { logErr('findContactsWithCustomerByName', err); return []; }
}

// ═══════════════════════════ salesperson ═══════════════════════════
// ตาราง salesperson ใช้คอลัมน์ "branch" — โค้ดชั้นบนเรียก branch_code จึง alias สองทางที่นี่

function mapSalespersonWrite(data: Record<string, any>): Record<string, any> {
  const out = { ...data };
  if (out.branch_code !== undefined) {
    out.branch = out.branch_code;
    delete out.branch_code;
  }
  return out;
}

export async function getSalespersonByUserId(userId: string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      `SELECT *, branch AS branch_code FROM salesperson WHERE user_id = $1 LIMIT 1`, [userId]);
    return rows[0] || null;
  } catch (err) { logErr('getSalespersonByUserId', err); return null; }
}

export async function insertSalesperson(data: Record<string, any>): Promise<any | null> {
  try {
    const row = mapSalespersonWrite(data);
    const keys = Object.keys(row);
    const cols = keys.map(k => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `INSERT INTO salesperson (${cols}) VALUES (${placeholders}) RETURNING *`,
      keys.map(k => row[k]));
    return rows[0] || null;
  } catch (err) { logErr('insertSalesperson', err); return null; }
}

/** อัปเดต salesperson ตาม user_id — คืน row ที่อัปเดตหรือ null เมื่อ error/ไม่พบ */
export async function updateSalespersonByUserId(userId: string, updates: Record<string, any>): Promise<any | null> {
  try {
    const row = mapSalespersonWrite(updates);
    const keys = Object.keys(row);
    if (keys.length === 0) return null;
    const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE salesperson SET ${setClauses} WHERE user_id = $${keys.length + 1} RETURNING *, branch AS branch_code`,
      [...keys.map(k => row[k]), userId]);
    return rows[0] || null;
  } catch (err) { logErr('updateSalespersonByUserId', err); return null; }
}

// ═══════════════════════════ messages ═══════════════════════════

export async function insertMessage(msg: {
  user_id: string; message_id: string; type: string;
  content: string; reply_token?: string | null; reply_content?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO messages (user_id, message_id, type, content, reply_token, reply_content)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [msg.user_id, msg.message_id, msg.type, msg.content, msg.reply_token ?? null, msg.reply_content ?? null]);
  } catch (err) { logErr('insertMessage', err); }
}

/** ประวัติแชทล่าสุดของ user (ใหม่→เก่า) สำหรับ AI context */
export async function getRecentMessages(userId: string, limit = 10): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT content, reply_content, created_at FROM messages
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
    return rows;
  } catch (err) { logErr('getRecentMessages', err); return []; }
}

// ═══════════════════════════ quotations ═══════════════════════════

export async function getQuotationsByIds(ids: any[], userId: string): Promise<any[]> {
  if (!ids.length || !userId) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, quotation_no FROM quotations WHERE id = ANY($1) AND user_id = $2`, [ids, userId]);
    return rows;
  } catch (err) { logErr('getQuotationsByIds', err); return []; }
}

export async function getQuotationsByNos(nos: string[], userId: string): Promise<any[]> {
  if (!nos.length || !userId) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id, quotation_no FROM quotations WHERE quotation_no = ANY($1) AND user_id = $2`, [nos, userId]);
    return rows;
  } catch (err) { logErr('getQuotationsByNos', err); return []; }
}

export async function getRecentConfirmedQuotations(userId: string, sinceIso: string): Promise<any[]> {
  try {
    // ใช้ updated_at (เวลายืนยัน) ไม่ใช่ created_at (เวลาร่าง) เพราะ confirmQuotationAtomic
    // ไม่เขียนทับ created_at อีกต่อไป — fallback ของ LIFF round-trip จึงต้องดูเวลายืนยันล่าสุด
    const { rows } = await pool.query(
      `SELECT id, quotation_no FROM quotations
       WHERE user_id = $1 AND status = 'confirmed' AND updated_at >= $2
       ORDER BY updated_at DESC`, [userId, sinceIso]);
    return rows;
  } catch (err) { logErr('getRecentConfirmedQuotations', err); return []; }
}

/** ลบใบเสนอราคาที่ค้างสถานะ pending/draft ของ user (ใช้ตอนเริ่มรายการใหม่/ยกเลิก) */
export async function deletePendingQuotations(userId: string): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM quotations WHERE user_id = $1 AND status = ANY($2)`,
      [userId, ['pending_company', 'pending_contact', 'pending_product', 'draft']]);
  } catch (err) { logErr('deletePendingQuotations', err); }
}

/**
 * ท่อน JOIN ที่หา "ทีมขายของผู้ติดต่อ" ให้ช่อง Sales Team ของไฟล์นำเข้า Odoo
 *
 * ทีมขายเป็นคุณสมบัติของผู้ติดต่อ (customers_data_view.sales_team) ไม่ใช่สังกัดของเซลล์ที่ออกใบ
 * จึง join ด้วย quotations.contact_id เท่านั้น — ห้ามกลับไปใช้ salesperson.branch
 *
 * ⚠️ contact_id ไม่ unique ใน customers_data_view (แถวบริษัทที่ไม่มีผู้ติดต่อใช้ contact_id = 0 ซ้ำกันได้)
 *    จึงกรอง > 0 และเรียงให้แถวที่ company_id ตรงกับใบมาก่อน เพื่อไม่หยิบทีมขายของบริษัทอื่น
 *
 * ใช้ร่วมกันระหว่าง endpoint export (index.ts) กับ diag harness (scripts/diag/odooExportSmoke.ts)
 * ให้ทั้งสองที่เห็นค่าเดียวกันเสมอ — ต้องมี alias ตาราง `q` = quotations อยู่ก่อนหน้าในคำสั่ง
 */
export const ODOO_EXPORT_SALES_TEAM_JOIN = `
  LEFT JOIN LATERAL (
    SELECT cd.sales_team
      FROM customers_data_view cd
     WHERE cd.contact_id = q.contact_id AND q.contact_id > 0
     ORDER BY (cd.company_id = q.customer_id) DESC NULLS LAST, cd.company_id
     LIMIT 1
  ) cust ON TRUE`;

/**
 * ท่อน JOIN ที่ดึง "ชื่อดิบ" ของบริษัท/ผู้ติดต่อจากตารางหลักให้ไฟล์นำเข้า Odoo
 *
 * ทำไมต้องมี: snapshot ใน quotations.customer_details ได้ชื่อมาจาก customers_data_view ซึ่งห่อทุกชื่อ
 * ด้วย clean_text() = btrim() ช่องว่างท้ายชื่อจึงหายตั้งแต่ตอนสร้างใบ แต่ Odoo เทียบชื่อ res.partner
 * แบบตรงตัวทุกอักขระ และชื่อที่ลงท้ายด้วยช่องว่างมีอยู่จริงในระบบ (customers 17,664 แถว / sale_orders
 * 2,371 ผู้ติดต่อ) ใบที่โดนตัดจึงนำเข้าไม่ผ่านทั้งใบ — ที่นี่จึงข้าม view ไปอ่านตารางหลักตรง ๆ
 *
 * ⚠️ เงื่อนไข btrim(...) = btrim(...) คือตัวกันพลาด — หยิบชื่อจากตารางหลักได้ก็ต่อเมื่อเป็น "ชื่อเดียวกัน
 *    ต่างแค่ช่องว่างหัวท้าย" เท่านั้น ถ้าลูกค้าถูกเปลี่ยนชื่อใน Odoo ทีหลัง หรือ contact นั้นหาไม่เจอ
 *    (ใบที่ contact อยู่แค่ใน sale_orders และไม่ตรง) lateral จะคืน NULL แล้วฝั่ง TS ตกกลับไปใช้ snapshot
 *    เหมือนเดิมทุกประการ — การแก้นี้จึงเปลี่ยนได้แค่ช่องว่างหัวท้าย ไม่มีทางเปลี่ยนตัวชื่อ
 *
 * แหล่งข้อมูลเรียงตาม pri ให้ตรงกับ 2 arm ของ customers_data_view: customers ก่อน แล้วค่อย sale_orders
 * (arm 2 = contact ที่มีเฉพาะใน sale_orders) และในฝั่ง sale_orders เอาใบสั่งขายล่าสุดเหมือน latest_so
 *
 * ใช้ร่วมกันระหว่าง endpoint export (index.ts) กับ diag harness (scripts/diag/odooExportSmoke.ts)
 * ต้องมี alias ตาราง `q` = quotations อยู่ก่อนหน้าในคำสั่ง เหมือน ODOO_EXPORT_SALES_TEAM_JOIN
 */
export const ODOO_EXPORT_RAW_NAME_JOINS = `
  LEFT JOIN LATERAL (
    SELECT n.customer_name
      FROM (
        SELECT 0 AS pri, NULL::timestamptz AS ord, c.customer_name
          FROM customers c
         WHERE c.company_id = q.customer_id
        UNION ALL
        SELECT 1 AS pri, s.order_date AS ord, s.customer_name
          FROM sale_orders s
         WHERE s.contact_id = q.contact_id AND q.contact_id > 0
      ) n
     WHERE btrim(n.customer_name) = btrim(split_part(q.customer_details->>'customer_name', ' | ', 1))
     ORDER BY n.pri, n.ord DESC NULLS LAST
     LIMIT 1
  ) raw_company ON TRUE
  LEFT JOIN LATERAL (
    SELECT n.contact_name
      FROM (
        SELECT 0 AS pri, NULL::timestamptz AS ord, c.contact_name
          FROM customers c
         WHERE c.contact_id = q.contact_id AND q.contact_id > 0
        UNION ALL
        SELECT 1 AS pri, s.order_date AS ord, s.contact_name
          FROM sale_orders s
         WHERE s.contact_id = q.contact_id AND q.contact_id > 0
      ) n
     WHERE btrim(n.contact_name) = btrim(q.customer_details->>'contact_name')
     ORDER BY n.pri, n.ord DESC NULLS LAST
     LIMIT 1
  ) raw_contact ON TRUE`;

/** คอลัมน์ชื่อดิบที่คู่กับ ODOO_EXPORT_RAW_NAME_JOINS — ใส่ใน SELECT list ของทั้ง endpoint และ diag */
export const ODOO_EXPORT_RAW_NAME_COLS =
  'raw_company.customer_name AS raw_customer_name, raw_contact.contact_name AS raw_contact_name';

// ────────────── ติดตามการส่งออกไป Odoo (กันส่งออกซ้ำ) ──────────────
//
// ⚠️ กลุ่มนี้ "โยน error ออกไป" ต่างจากกติกาหัวไฟล์ที่ให้ log แล้วคืน []/null โดยเจตนา
//    เพราะทุกตัวถูกเรียกใน withTransaction ของ endpoint export — ถ้ากลืน error ไว้เงียบ ๆ
//    transaction จะ COMMIT ทั้งที่มาร์กใบไปแล้วแต่ log ไม่ครบ (หรือกลับกัน) แล้วตามแกะทีหลังไม่ได้

export type ExportedFilter = 'no' | 'yes' | 'all';

/** แปลง query param เป็นค่าที่ใช้ได้จริง — ค่าที่ไม่รู้จักตกเป็น fallback ที่ผู้เรียกกำหนด */
export function parseExportedFilter(raw: any, fallback: ExportedFilter): ExportedFilter {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'no' || v === 'yes' || v === 'all' ? v : fallback;
}

/**
 * เงื่อนไข WHERE ของตัวกรอง "สถานะการส่งออก" — คืน '' เมื่อไม่ต้องกรอง
 * เป็นค่าคงที่ล้วน ไม่รับ input ผู้ใช้เข้ามาต่อสตริง จึงไม่ต้อง parameterize
 * (ต้องมี alias ตาราง `q` = quotations อยู่ก่อนหน้าในคำสั่ง เหมือน ODOO_EXPORT_SALES_TEAM_JOIN)
 */
export function exportedFilterCondition(filter: ExportedFilter): string {
  if (filter === 'no') return 'q.odoo_exported_at IS NULL';
  if (filter === 'yes') return 'q.odoo_exported_at IS NOT NULL';
  return '';
}

/**
 * เงื่อนไขช่วงวันที่ของหน้าประวัติใบเสนอราคา — ตีความ 'yyyy-mm-dd' ที่แอดมินเลือกเป็น "วันตามเวลาไทย"
 * (ต้องมี alias ตาราง `q` = quotations อยู่ก่อนหน้าในคำสั่ง เหมือน exportedFilterCondition)
 *
 * ⚠️ ห้ามตัด ::timestamp ออก — `$1::date AT TIME ZONE 'Asia/Bangkok'` (ไม่มี cast) ดูเหมือนถูกแต่ผิด:
 *    AT TIME ZONE มี 2 overload คือ timezone(text, timestamp) และ timezone(text, timestamptz)
 *    เมื่อ input เป็น `date` PostgreSQL เลือกตัว timestamptz (เป็น preferred type ของหมวด datetime)
 *    → กลายเป็น "อ่านวันที่เป็นเที่ยงคืนตาม session TimeZone แล้วแปลงเป็นเวลาไทย" ซึ่งกลับทางกับที่ต้องการ
 *    ผลคือขอบเขตเลื่อนตาม TimeZone ของ DB: ตรงเมื่อ session = Asia/Bangkok (เครื่อง dev) แต่บน
 *    production ที่เป็น UTC ขอบล่างไปตกที่ 14:00 น. ของวันที่เลือก → ใบช่วงเช้าของวันแรกหายไปเงียบ ๆ
 *    การ cast เป็น ::timestamp ก่อน บังคับให้เข้า overload ที่ถูกต้อง ผลลัพธ์จึงไม่ขึ้นกับ TimeZone ของ DB
 *    (เช็คได้ด้วย pg_typeof — ต้องได้ `timestamp with time zone` ทั้งสองฝั่ง)
 */
export function createdAtFromThaiDayCondition(paramIndex: number): string {
  return `q.created_at >= (($${paramIndex}::date)::timestamp AT TIME ZONE 'Asia/Bangkok')`;
}

/** ขอบบน = เที่ยงคืนของ "วันถัดจาก" dateTo ตามโซนไทย → ใช้คู่กับ '<' เพื่อรวมทั้งวันของ dateTo */
export function createdAtToThaiDayCondition(paramIndex: number): string {
  return `q.created_at < ((($${paramIndex}::date)::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok')`;
}

/**
 * จอง (claim) ใบที่จะใส่ลงไฟล์ — มาร์ก odoo_exported_at แล้วคืน id ที่ "เป็นของ request นี้"
 *
 * onlyUnexported = true (ตัวกรอง 'ยังไม่ส่งออก') จะใส่ guard `odoo_exported_at IS NULL` ไว้ด้วย
 * ถ้าแอดมินสองคนกดพร้อมกัน UPDATE ที่มาทีหลังจะได้ id กลับมาน้อยลงตามจำนวนที่คนแรกคว้าไปแล้ว
 * ผู้เรียกจึงสร้างไฟล์จาก "id ที่ RETURNING คืนมา" เท่านั้น ไฟล์สองไฟล์ก็ไม่มีใบซ้ำกัน
 * — ใช้วิธีนี้แทน SELECT ... FOR UPDATE เพราะ statement_timeout 15 วิ ทำให้การรอล็อกกลายเป็น error แทน
 */
export async function claimQuotationsForExport(
  db: DbExecutor, ids: string[], onlyUnexported: boolean
): Promise<string[]> {
  if (!ids.length) return [];
  const guard = onlyUnexported ? 'AND odoo_exported_at IS NULL' : '';
  const { rows } = await db.query(
    `UPDATE quotations SET odoo_exported_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1::uuid[]) ${guard}
      RETURNING id`, [ids]);
  return rows.map((r: any) => String(r.id));
}

/** บันทึกหัวชุดการส่งออก 1 ครั้ง แล้วคืน batch id */
export async function insertExportBatch(db: DbExecutor, batch: {
  adminId: number | null; adminUsername: string | null; format: string;
  quotationCount: number; rowCount: number; filters: any;
}): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO quotation_export_batches
       (exported_by_id, exported_by_username, format, quotation_count, row_count, filters)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [batch.adminId, batch.adminUsername, batch.format,
     batch.quotationCount, batch.rowCount, JSON.stringify(batch.filters ?? {})]);
  return String(rows[0].id);
}

/** บันทึกรายใบของชุดนั้น — insert ทีเดียวด้วย UNNEST ไม่วนยิงทีละใบ */
export async function insertExportLogRows(
  db: DbExecutor, batchId: string, quotations: { id: string; quotation_no: string | null }[]
): Promise<void> {
  if (!quotations.length) return;
  await db.query(
    `INSERT INTO quotation_export_log (batch_id, quotation_id, quotation_no)
     SELECT $1::uuid, x.id, x.no
       FROM UNNEST($2::uuid[], $3::varchar[]) AS x(id, no)`,
    [batchId, quotations.map(q => q.id), quotations.map(q => q.quotation_no ?? null)]);
}

/**
 * ยกเลิกเครื่องหมาย "ส่งออกแล้ว" ของใบเดียว (ใช้ตอนนำเข้า Odoo ไม่ผ่าน)
 * คืน false ถ้าไม่มีใบนั้น หรือใบนั้นยังไม่เคยถูกมาร์กอยู่แล้ว
 */
export async function unmarkQuotationExport(db: DbExecutor, id: string): Promise<boolean> {
  const upd = await db.query(
    `UPDATE quotations SET odoo_exported_at = NULL
      WHERE id = $1::uuid AND odoo_exported_at IS NOT NULL RETURNING id`, [id]);
  if (!upd.rowCount) return false;
  // ไม่ลบแถว log ทิ้ง — ประวัติว่า "เคยส่งแล้วถอย" ต้องตรวจย้อนหลังได้
  await db.query(
    `UPDATE quotation_export_log SET reverted_at = CURRENT_TIMESTAMP
      WHERE quotation_id = $1::uuid AND reverted_at IS NULL`, [id]);
  return true;
}

/** ยกเลิกเครื่องหมายทั้งชุด — คืนจำนวนใบที่ถูกถอยจริง (ใบที่ถูกถอยไปแล้วไม่นับซ้ำ) */
export async function unmarkExportBatch(db: DbExecutor, batchId: string): Promise<number> {
  const { rows } = await db.query(
    `UPDATE quotation_export_log SET reverted_at = CURRENT_TIMESTAMP
      WHERE batch_id = $1::uuid AND reverted_at IS NULL AND quotation_id IS NOT NULL
      RETURNING quotation_id`, [batchId]);
  const ids = rows.map((r: any) => String(r.quotation_id));
  if (!ids.length) return 0;
  const upd = await db.query(
    `UPDATE quotations SET odoo_exported_at = NULL
      WHERE id = ANY($1::uuid[]) AND odoo_exported_at IS NOT NULL`, [ids]);
  return upd.rowCount || 0;
}

/**
 * ประวัติชุดการส่งออก — active_count = จำนวนใบที่ยังนับว่า "ส่งออกแล้ว" (ยังไม่ถูกถอย)
 * ตัวนี้เป็น SELECT ล้วนนอก transaction จึงคืน [] เมื่อ error ตามกติกาหัวไฟล์
 */
export async function getExportBatches(limit: number, offset: number): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.exported_at, b.exported_by_id, b.exported_by_username, b.format,
              b.quotation_count, b.row_count, b.filters,
              COUNT(l.id) FILTER (WHERE l.reverted_at IS NULL)::int AS active_count
         FROM quotation_export_batches b
         LEFT JOIN quotation_export_log l ON l.batch_id = b.id
        GROUP BY b.id
        ORDER BY b.exported_at DESC
        LIMIT $1 OFFSET $2`, [limit, offset]);
    return rows;
  } catch (err) { logErr('getExportBatches', err); return []; }
}

/** จำนวนชุดส่งออกทั้งหมด (ไว้ทำ pagination ของหน้าประวัติ) */
export async function countExportBatches(): Promise<number> {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM quotation_export_batches`);
    return rows[0]?.n || 0;
  } catch (err) { logErr('countExportBatches', err); return 0; }
}

// ═══════════════════════════ products ═══════════════════════════

/**
 * หน่วยนับของสินค้าตาม product_template_id — คืน map { [templateId]: unit_of_measure }
 *
 * snapshot ใน quotations.item_details ไม่ได้เก็บหน่วยไว้ ตอน export ไป Odoo จึงต้องดึงสด
 * ดึงทีเดียวทั้งชุดแทนการยิงรายบรรทัด เพราะ export ครั้งหนึ่งมีได้หลายร้อยรายการ
 */
export async function getProductUomByTemplateIds(ids: number[]): Promise<Record<number, string>> {
  const uniq = Array.from(new Set((ids || []).filter(id => Number.isFinite(id))));
  if (!uniq.length) return {};
  try {
    const { rows } = await pool.query(
      `SELECT product_template_id, unit_of_measure FROM products WHERE product_template_id = ANY($1)`,
      [uniq]);
    const map: Record<number, string> = {};
    rows.forEach((r: any) => {
      const uom = String(r.unit_of_measure ?? '').trim();
      if (uom) map[Number(r.product_template_id)] = uom;
    });
    return map;
  } catch (err) { logErr('getProductUomByTemplateIds', err); return {}; }
}

// ═══════════════════════════ branch (รายการสาขาคงที่) ═══════════════════════════

const STATIC_BRANCHES = [
  'สมุทรปราการ', 'พระราม 2', 'ปทุมธานี', 'ชลบุรี', 'ภาคใต้', 'ภาคอีสาน', 'ต่างประเทศ',
  'ภาคเหนือ', 'ภาคตะวันออก', 'Product Specialist', 'PLC', 'Sales', 'Service', 'Healthcare', 'Marketing',
];

/** รายการสาขาทั้งหมด (shape เดิม: { branch, branch_code, name }) */
export function getStaticBranches(): any[] {
  return STATIC_BRANCHES.map(b => ({ branch: b, branch_code: b, name: b }));
}

/** กรองสาขาตามรหัส (คืน shape เดิม) */
export function getBranchesByCodes(codes: string[]): any[] {
  return getStaticBranches().filter(b => codes.includes(b.branch_code));
}

// ═══════════════════════════ salespeople (จาก sale_orders) ═══════════════════════════

/** รายชื่อเซลส์ทั้งหมดจากประวัติ sale_orders (ชื่อ clean แล้ว, ล่าสุดต่อคน) */
export async function listSalespeopleFromOrders(): Promise<any[]> {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (salesperson)
          salesperson AS name,
          salesperson_id,
          salesperson_phone AS phone,
          COALESCE(customer_sale_area, sales_team) AS branch
      FROM sale_orders
      WHERE salesperson IS NOT NULL AND salesperson != '' AND salesperson_id IS NOT NULL
      ORDER BY salesperson, order_date DESC;
    `);
    const seen = new Map<string, any>();
    for (const row of result.rows) {
      const cleanName = row.name.replace(/\s*\([^)]*\)\s*$/gi, '').trim();
      let cleanPhone = null;
      if (row.phone && row.phone !== 'null') cleanPhone = row.phone.trim();
      if (!seen.has(cleanName)) {
        seen.set(cleanName, {
          name: cleanName,
          salesperson_id: row.salesperson_id ? String(row.salesperson_id) : null,
          phone: cleanPhone,
          branch: row.branch || null,
        });
      }
    }
    return Array.from(seen.values()).sort((a: any, b: any) => a.name.localeCompare(b.name, 'th'));
  } catch (err) { logErr('listSalespeopleFromOrders', err); return []; }
}

/** Query สาขาทั้งหมดจาก COALESCE(customer_sale_area, sales_team) ใน sale_orders */
export async function getBranches(): Promise<any[]> {
  try {
    const result = await pool.query(`
      SELECT DISTINCT COALESCE(customer_sale_area, sales_team) AS branch
      FROM sale_orders
      WHERE COALESCE(customer_sale_area, sales_team) IS NOT NULL
        AND COALESCE(customer_sale_area, sales_team) != ''
      ORDER BY branch
    `);
    return result.rows.map((r, i) => ({ index: i + 1, name: r.branch }));
  } catch (err) { logErr('getBranches', err); return []; }
}

// ═══════════════════════════ sale_orders ═══════════════════════════

// ═══════════════════════════ admin (index.ts) ═══════════════════════════

// ค้นจาก customers_data_view (ตารางรวม customers+sale_orders) แทน customers_view
// เพื่อให้ orphan company ที่มีเฉพาะใน sale_orders (~1,112 บริษัท synthetic company_id) ค้นเจอในหน้า LIFF ด้วย
// cdv grain = 1 แถว/ผู้ติดต่อ → DISTINCT ON(company_id) ORDER BY contact_id ให้เหลือ 1 แถว/บริษัท เหมือน customers_view เดิม
// map ชื่อคอลัมน์กลับ shape เดิมเป๊ะ: id/display_name/reference/branch_code/salesperson/payment_terms
const ADMIN_COMPANY_SUBQ =
  `SELECT DISTINCT ON (company_id)
     company_id             AS id,
     customer_name          AS display_name,
     customer_reference     AS reference,
     customer_sale_area     AS branch_code,
     salesperson,
     customer_payment_terms AS payment_terms
   FROM customers_data_view
   WHERE customer_name IS NOT NULL
   ORDER BY company_id, contact_id`;

/** ค้นหาลูกค้าหน้าแอดมิน/LIFF (ชื่อหรือรหัส) */
export async function searchCustomersAdmin(q: string, limit = 30): Promise<any[]> {
  try {
    // payment_terms ติดมาด้วยเพื่อให้หน้า LIFF อัปเดตช่อง "เครดิต" ได้ทันทีที่เปลี่ยนบริษัท
    // (ค่าตอนโหลดครั้งแรกมาจาก enrichQuotationData แต่ตอนเลือกบริษัทใหม่มีแค่ผลค้นหานี้)
    if (q.trim()) {
      const { rows } = await pool.query(
        `SELECT * FROM (${ADMIN_COMPANY_SUBQ}) v
         WHERE v.display_name ILIKE $1 OR v.reference ILIKE $1 LIMIT $2`,
        [`%${q}%`, limit]);
      return rows;
    }
    const { rows } = await pool.query(
      `SELECT * FROM (${ADMIN_COMPANY_SUBQ}) v LIMIT $1`, [limit]);
    return rows;
  } catch (err) { logErr('searchCustomersAdmin', err); return []; }
}

/** สาขา+เซลส์ของลูกค้าที่เซลส์ชื่อนี้ดูแล (ใช้แนะนำสาขาตอน register) */
export async function getCustomerBranchesBySalesperson(name: string): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT branch AS branch_code, salesperson FROM (${CDV_COMPANY_SUBQ}) v WHERE v.salesperson ILIKE $1`,
      [`%${name}%`]);
    return rows;
  } catch (err) { logErr('getCustomerBranchesBySalesperson', err); return []; }
}

// ═══════════════════════════ quotations (evidence) ═══════════════════════════

/** จำนวนใบเสนอราคาที่ยืนยันแล้วของแต่ละบริษัท (evidence สำหรับการเลือกบริษัท) */
export async function getConfirmedQuotationCounts(customerIds: any[]): Promise<Map<any, number>> {
  if (!customerIds.length) return new Map();
  try {
    const { rows } = await pool.query(
      `SELECT customer_id, COUNT(*)::int AS n FROM quotations
       WHERE customer_id = ANY($1) AND status = 'confirmed' GROUP BY customer_id`,
      [customerIds]);
    return new Map(rows.map((r: any) => [r.customer_id, r.n]));
  } catch (err) { logErr('getConfirmedQuotationCounts', err); return new Map(); }
}
