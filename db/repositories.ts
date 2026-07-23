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
import { pool } from '../config/db.js';

function logErr(fn: string, err: any): void {
  console.error(`[repo.${fn}]`, err?.message || err);
}

// ═══════════════════════════ customers ═══════════════════════════

const CUSTOMER_VIEW_COLS =
  'id, display_name, reference, tax_id, phone, email, branch AS branch_code, salesperson, customer_type, customer_payment_terms';

/** ค้นหาลูกค้าจาก reference codes (ILIKE ANY) — ใช้ใน reference fast-path */
export async function searchCustomersByReferencePatterns(refs: string[], limit = 30): Promise<any[]> {
  if (!refs.length) return [];
  try {
    const patterns = refs.map(r => `%${r}%`);
    const { rows } = await pool.query(
      `SELECT id, display_name, reference, branch AS branch_code, salesperson
       FROM customers_view WHERE reference ILIKE ANY($1::text[]) LIMIT $2`,
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
       FROM customers_view WHERE display_name ILIKE ANY($1::text[]) LIMIT $2`,
      [patterns, limit]);
    return rows;
  } catch (err) { logErr('searchCustomersByNamePatterns', err); return []; }
}

/** ดึงลูกค้ารายตัวจาก id (customers_view) — คืน row เดียวหรือ null */
export async function getCustomerById(id: number | string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      `SELECT ${CUSTOMER_VIEW_COLS} FROM customers_view WHERE id = $1 LIMIT 1`, [id]);
    return rows[0] || null;
  } catch (err) { logErr('getCustomerById', err); return null; }
}

/** ดึงลูกค้าจากชื่อเต็มตรงตัว (ใช้ตอน rebuild snapshot ใบเสนอราคา) */
export async function getCustomerByDisplayName(displayName: string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      `SELECT ${CUSTOMER_VIEW_COLS} FROM customers_view WHERE display_name = $1 LIMIT 1`, [displayName]);
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
      `SELECT * FROM contacts_view WHERE customer_id = $1 ${nameFilter} LIMIT 1`, params);
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

const CONTACT_VIEW_COLS =
  'id, name, mobile, phone, email, invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip';

/** ผู้ติดต่อทั้งหมดของบริษัท */
export async function getContactsByCustomerId(customerId: number | string): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT ${CONTACT_VIEW_COLS} FROM contacts_view WHERE customer_id = $1`, [customerId]);
    return rows;
  } catch (err) { logErr('getContactsByCustomerId', err); return []; }
}

/** ผู้ติดต่อรายตัวจาก id */
export async function getContactById(contactId: number | string): Promise<any | null> {
  try {
    const { rows } = await pool.query(
      `SELECT ${CONTACT_VIEW_COLS}, customer_id FROM contacts_view WHERE id = $1 LIMIT 1`, [contactId]);
    return rows[0] || null;
  } catch (err) { logErr('getContactById', err); return null; }
}

/** ชื่อผู้ติดต่อของหลายบริษัทพร้อมกัน (ใช้สร้าง evidence) */
export async function getContactNamesByCustomerIds(customerIds: any[]): Promise<any[]> {
  if (!customerIds.length) return [];
  try {
    const { rows } = await pool.query(
      `SELECT customer_id, name FROM contacts_view WHERE customer_id = ANY($1) AND name IS NOT NULL`,
      [customerIds]);
    return rows;
  } catch (err) { logErr('getContactNamesByCustomerIds', err); return []; }
}

/**
 * reverse lookup: หาบริษัทจากชื่อผู้ติดต่อ (JOIN contacts_view ↔ customers_view)
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
       FROM contacts_view c
       INNER JOIN customers_view cust ON c.customer_id = cust.id
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

/** ค้นหาลูกค้าหน้าแอดมิน/LIFF (ชื่อหรือรหัส) */
export async function searchCustomersAdmin(q: string, limit = 30): Promise<any[]> {
  try {
    // payment_terms ติดมาด้วยเพื่อให้หน้า LIFF อัปเดตช่อง "เครดิต" ได้ทันทีที่เปลี่ยนบริษัท
    // (ค่าตอนโหลดครั้งแรกมาจาก enrichQuotationData แต่ตอนเลือกบริษัทใหม่มีแค่ผลค้นหานี้)
    if (q.trim()) {
      const { rows } = await pool.query(
        `SELECT id, display_name, reference, branch AS branch_code, salesperson,
                customer_payment_terms AS payment_terms
         FROM customers_view WHERE display_name ILIKE $1 OR reference ILIKE $1 LIMIT $2`,
        [`%${q}%`, limit]);
      return rows;
    }
    const { rows } = await pool.query(
      `SELECT id, display_name, reference, branch AS branch_code, salesperson,
              customer_payment_terms AS payment_terms
       FROM customers_view LIMIT $1`, [limit]);
    return rows;
  } catch (err) { logErr('searchCustomersAdmin', err); return []; }
}

/** สาขา+เซลส์ของลูกค้าที่เซลส์ชื่อนี้ดูแล (ใช้แนะนำสาขาตอน register) */
export async function getCustomerBranchesBySalesperson(name: string): Promise<any[]> {
  try {
    const { rows } = await pool.query(
      `SELECT branch AS branch_code, salesperson FROM customers_view WHERE salesperson ILIKE $1`,
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
