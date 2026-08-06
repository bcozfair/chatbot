// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของไฟล์นำเข้า Sale Order สำหรับ Odoo (template "import odoo template.xlsx")
//  รัน:  npm run diag:odoo-export            (ค่าตั้งต้น QP 20 ใบล่าสุด)
//        npm run diag:odoo-export -- --company qt       (⚠️ ต้องรันทั้ง qp และ qt ถึงจะครบ)
//        npm run diag:odoo-export -- --limit 100
//        npm run diag:odoo-export -- --status draft
//        npm run diag:odoo-export -- --exported no      (เฉพาะใบที่ยังไม่เคยส่งออก)
//
//  สคริปต์นี้ตรวจ "รูปแบบไฟล์" เท่านั้น กลไกกันส่งออกซ้ำอยู่ที่ npm run diag:export-tracking
//
//  read-only ทั้งหมด — อ่านใบเสนอราคาจริงมา build แถวแล้วตรวจ ไม่เขียนอะไรลง DB
//
//  ครอบคลุม: ลำดับ/จำนวนหัวคอลัมน์ · กติกา one2many ของ Odoo (แถวที่ 2+ ต้องเว้น A–L) ·
//            ช่องบังคับที่ว่างไม่ได้ · ช่องค่าคงที่ (source_id/uom/tax) · ชนิดข้อมูลของช่องตัวเลข
//            การแยกบริษัท: ไฟล์มีเฉพาะใบของบริษัทที่เลือก ใบที่เลขไม่ขึ้นต้น QP/QT ไม่ลงไฟล์
//            และชื่อภาษีเป็นค่าของบริษัทนั้น (QP กับ QT ต่างกันแค่เว้นวรรค แต่ต่างกันจริง)
//            ส่วนต่างของยอดรวมหลังยุบส่วนลด 2 ชั้นเหลือช่องเดียว · หมายเหตุการรับประกัน
//            ช่อง Sales Team (I) = ทีมขายของผู้ติดต่อจาก customers_data ไม่ใช่สังกัดของเซลล์
//            ช่อง employee_quotation_id (J) = ชื่อจริงของเซลล์จากตาราง salesperson + สังกัดห้อยท้าย
//  ให้รันซ้ำทุกครั้งที่แตะ services/odooSaleOrderExport.ts หรือ endpoint export
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  ODOO_EXPORT_SALES_TEAM_JOIN,
  ODOO_EXPORT_RAW_NAME_JOINS,
  ODOO_EXPORT_RAW_NAME_COLS,
  exportedFilterCondition,
  parseExportedFilter,
} from '../../db/repositories.js';
import {
  ODOO_SO_HEADERS,
  buildOdooSaleOrderRows,
  loadOdooExportConfig,
  parseExportCompany,
  selectExportableQuotes,
  serializeOdooRowsToCsv,
  serializeOdooRowsToXlsx,
  type OdooExportQuotationRow,
} from '../../services/odooSaleOrderExport.js';
import { calcLineTotal } from '../../utils/pricing.js';
import { resolveMinWarrantyDisplay, warrantyNoteText } from '../../utils/warranty.js';

const ok = (label: string, cond: boolean, extra = '') =>
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const limit = Math.max(1, Number(argValue('limit', '20')) || 20);
// ค่าตั้งต้นว่าง = เดินเส้นทางเดียวกับ endpoint (ทุกใบที่มีเลขที่ใบเสนอราคา)
// ใส่ --status <ค่า> เพื่อเจาะจงสถานะเดียว
const status = argValue('status', '');
// ตั้งต้น 'all' ไม่ใช่ 'no' เหมือน endpoint — สคริปต์นี้ตรวจ "รูปแบบไฟล์" จึงต้องเห็นใบชุดเดิม
// ทุกครั้งที่รัน ผลถึงเทียบย้อนหลังกันได้ ไม่ผันไปตามว่าใครกดส่งออกอะไรไปแล้วบ้าง
const exported = parseExportedFilter(argValue('exported', 'all'), 'all');
// 1 ไฟล์ = 1 บริษัทเหมือน endpoint — ต้องรันทั้ง --company qp และ --company qt ถึงจะครบ
const company = parseExportCompany(argValue('company', 'qp'));
if (!company) {
  console.log('✗ FAIL  --company รับได้แค่ qp หรือ qt');
  await pool.end();
  process.exit(1);
}

/** หัวคอลัมน์ที่คัดลอกจากชีต "Import " ของ template ต้นฉบับ — ตัวเทียบอิสระจากโค้ด */
const TEMPLATE_HEADERS = [
  'name', 'partner_id', 'contact', 'partner_invoice_id', 'partner_shipping_id',
  'date_order', 'payment_term_id', 'Salesperson', 'Sales Team', 'employee_quotation_id',
  'source_id', 'note', 'order_line/product', 'order_line/product_uom_qty',
  'order_line/product_uom', 'order_line/price_unit', 'order_line/tax_id', 'order_line/discount',
];

// ── 1. หัวคอลัมน์ตรงกับ template ────────────────────────────────────────
ok('หัวคอลัมน์มี 18 ช่อง', ODOO_SO_HEADERS.length === 18, `(ได้ ${ODOO_SO_HEADERS.length})`);
ok('หัวคอลัมน์ตรงกับ template ทั้งชื่อและลำดับ',
  JSON.stringify([...ODOO_SO_HEADERS]) === JSON.stringify(TEMPLATE_HEADERS));

// ── 2. ดึงใบจริงมา build ────────────────────────────────────────────────
// สะท้อนเงื่อนไขของ endpoint: เจาะจงสถานะถ้าส่ง --status มา ไม่งั้นเอาทุกใบที่มีเลขที่ใบ
// บวกตัวกรองสถานะการส่งออก Odoo (ใช้ฟังก์ชันตัวเดียวกับ endpoint ไม่ให้เงื่อนไขแตกกัน)
const conditions = [status
  ? 'q.status = $1'
  : "q.quotation_no IS NOT NULL AND TRIM(q.quotation_no) <> ''"];
const exportedCondition = exportedFilterCondition(exported);
if (exportedCondition) conditions.push(exportedCondition);
// endpoint กรองบริษัทฝั่ง TS (selectExportableQuotes) แต่ที่นี่กรองใน SQL ด้วยเพื่อให้ --limit N
// ได้ตัวอย่าง N ใบของบริษัทที่ตรวจจริง ๆ ไม่ใช่ N ใบล่าสุดที่บังเอิญเป็นอีกบริษัทเสียครึ่ง
// (ค่า company ผ่าน parseExportCompany มาแล้ว เป็น 'QP'/'QT' เท่านั้น ต่อสตริงได้ปลอดภัย)
conditions.push(`q.quotation_no ILIKE '${company}%'`);

const filterParams = status ? [status, limit] : [limit];
const limitParam = status ? '$2' : '$1';
const { rows: quotes } = await pool.query<OdooExportQuotationRow & {
  quotation_no: string; total_sum: string; customer_id: number | null; contact_id: number | null;
}>(
  `SELECT q.quotation_no, q.total_sum, q.created_at, q.updated_at, q.customer_details, q.item_details, q.employee_details,
          q.customer_id, q.contact_id,
          s.name AS salesperson_name, cust.sales_team AS customer_sales_team,
          s.employee_quotation_id AS salesperson_employee_quotation_id,
          ${ODOO_EXPORT_RAW_NAME_COLS}
     FROM quotations q
     LEFT JOIN salesperson s ON q.user_id = s.user_id
     ${ODOO_EXPORT_SALES_TEAM_JOIN}
     ${ODOO_EXPORT_RAW_NAME_JOINS}
    WHERE ${conditions.join(' AND ')}
    ORDER BY q.created_at DESC
    LIMIT ${limitParam}`,
  filterParams
);
console.log(`   บริษัท=${company} · ตัวกรอง=${status ? `สถานะ "${status}"` : 'ทุกใบที่มีเลขที่ใบเสนอราคา'} · การส่งออก=${exported} ดึงมา ${quotes.length} ใบ`);
if (quotes.length === 0) {
  console.log('⚠️  ไม่มีใบเสนอราคาให้ตรวจ — ลองเปลี่ยน --company/--status หรือใส่ข้อมูลทดสอบก่อน');
  await pool.end();
  process.exit(0);
}

const config = loadOdooExportConfig();
const tax = config.taxByCompany[company];
console.log(`   config: tax(${company})="${tax}" sourceId="${config.sourceId}" uom="${config.uom}"`);

const rows = buildOdooSaleOrderRows(quotes, config, company);

const quotesWithItems = selectExportableQuotes(quotes, company);
const expectedRowCount = quotesWithItems.reduce((sum, q) => sum + q.item_details.length, 0);
ok('จำนวนแถวรวม = ผลรวมจำนวนรายการของทุกใบ', rows.length === expectedRowCount,
  `(ได้ ${rows.length} / คาด ${expectedRowCount})`);
if (quotesWithItems.length !== quotes.length) {
  console.log(`   ℹ️  ข้าม ${quotes.length - quotesWithItems.length} ใบที่ไม่มีรายการสินค้า (นำเข้า Odoo ไม่ได้)`);
}

// ── 2.1 แยกบริษัท: ไฟล์มีเฉพาะใบของบริษัทที่เลือก และภาษีเป็นค่าของบริษัทนั้น ──
// ตรวจแบบ pure ด้วยใบสมมติ ไม่ต้องรอให้ DB มีใบครบทุกแบบ
const mixed: OdooExportQuotationRow[] = [
  { quotation_no: 'QP-999999001', item_details: [{ model: 'A', quantity: 1, price: 100 }] },
  { quotation_no: 'QT-999999002', item_details: [{ model: 'B', quantity: 1, price: 100 }] },
  { quotation_no: '', item_details: [{ model: 'C', quantity: 1, price: 100 }] },
  { quotation_no: 'XX-999999003', item_details: [{ model: 'D', quantity: 1, price: 100 }] },
];
const picked = selectExportableQuotes(mixed, company);
ok(`เลือกบริษัท ${company} แล้วได้เฉพาะใบของบริษัทนั้น 1 ใบ`,
  picked.length === 1 && String(picked[0].quotation_no ?? '').startsWith(company),
  `(ได้ ${picked.map(q => q.quotation_no || '(ไม่มีเลข)').join(', ') || 'ไม่ได้ใบเลย'})`);
ok('ใบที่เลขที่ไม่ขึ้นต้นด้วย QP/QT ไม่ลงไฟล์ของทั้งสองบริษัท',
  selectExportableQuotes(mixed, 'QP').length === 1 && selectExportableQuotes(mixed, 'QT').length === 1);
ok('ชื่อภาษีของ QP กับ QT ต่างกันจริง (ต่างกันแค่เว้นวรรค — ห้ามแก้ให้เหมือนกัน)',
  config.taxByCompany.QP !== config.taxByCompany.QT,
  `QP="${config.taxByCompany.QP}" QT="${config.taxByCompany.QT}"`);
ok('ทุกแถวในไฟล์เป็นใบของบริษัทที่เลือก',
  quotesWithItems.every(q => String(q.quotation_no ?? '').toUpperCase().startsWith(company)));

// ── 3. กติกา one2many: แถวแรกของใบมีหัวใบครบ แถวถัดไปต้องว่าง ───────────
const HEADER_KEYS = [
  'name', 'partner_id', 'contact', 'partner_invoice_id', 'partner_shipping_id',
  'date_order', 'payment_term_id', 'salesperson', 'sales_team', 'employee_quotation_id',
  'source_id', 'note',
] as const;

// ตัวเทียบอิสระของช่อง I: อ่าน sales_team จาก customers_data ตรง ๆ ไม่ผ่านท่อน JOIN ที่ export ใช้
// เรียง company_id ให้ตรงกับลำดับใน ODOO_EXPORT_SALES_TEAM_JOIN เพื่อให้เลือกแถวเดียวกันตอน contact_id ซ้ำ
const contactIds = Array.from(new Set(
  quotes.map(q => Number(q.contact_id)).filter(id => Number.isInteger(id) && id > 0)
));
const teamByPair = new Map<string, string>();
const teamByContact = new Map<number, string>();
if (contactIds.length > 0) {
  const { rows: cdRows } = await pool.query<{ company_id: number; contact_id: number; sales_team: string | null }>(
    `SELECT company_id, contact_id, sales_team FROM customers_data
      WHERE contact_id = ANY($1) ORDER BY contact_id, company_id`,
    [contactIds]
  );
  for (const r of cdRows) {
    // ให้กติกาเดียวกับ clean() ของ export: '-' และช่องว่างล้วน = ไม่มีข้อมูล
    const t = String(r.sales_team ?? '').trim();
    const team = t === '-' ? '' : t;
    teamByPair.set(`${r.company_id}:${r.contact_id}`, team);
    if (!teamByContact.has(r.contact_id)) teamByContact.set(r.contact_id, team);
  }
}
/** ทีมขายที่ช่อง I ควรได้ — ใบที่ยังไม่ผูกผู้ติดต่อต้องเป็นเซลล์ว่าง ไม่ใช่สังกัดของเซลล์ */
const expectedSalesTeam = (q: { customer_id: number | null; contact_id: number | null }): string => {
  const cid = Number(q.contact_id);
  if (!Number.isInteger(cid) || cid <= 0) return '';
  return teamByPair.get(`${q.customer_id}:${cid}`) ?? teamByContact.get(cid) ?? '';
};

// ตัวเทียบอิสระของช่อง B–E: อ่านชื่อดิบจากตารางหลักตรง ๆ ไม่ผ่าน ODOO_EXPORT_RAW_NAME_JOINS ที่ export ใช้
// customers มาก่อน sale_orders ตาม 2 arm ของ customers_data_view และฝั่ง sale_orders เอาใบล่าสุด
const baseCompanyByPair = new Map<string, string>();
const baseContactByContactId = new Map<number, string>();
const companyIds = Array.from(new Set(
  quotes.map(q => Number(q.customer_id)).filter(id => Number.isInteger(id))
));
if (contactIds.length > 0 || companyIds.length > 0) {
  const { rows: baseRows } = await pool.query<{
    company_id: number | null; contact_id: number | null; customer_name: string | null; contact_name: string | null;
  }>(
    `SELECT company_id, contact_id, customer_name, contact_name FROM customers
      WHERE company_id = ANY($1) OR contact_id = ANY($2)
     UNION ALL
     SELECT * FROM (
       SELECT DISTINCT ON (contact_id) NULL::int, contact_id, customer_name, contact_name
         FROM sale_orders WHERE contact_id = ANY($2)
        ORDER BY contact_id, order_date DESC NULLS LAST
     ) so`,
    [companyIds, contactIds]
  );
  for (const r of baseRows) {
    const cid = Number(r.contact_id);
    if (r.customer_name && r.company_id !== null) {
      baseCompanyByPair.set(`${r.company_id}|${cid}`, r.customer_name);
    }
    if (r.contact_name && Number.isInteger(cid) && cid > 0 && !baseContactByContactId.has(cid)) {
      baseContactByContactId.set(cid, r.contact_name);
    }
  }
  // ใบ orphan (contact อยู่แค่ใน sale_orders) ไม่มีแถวใน customers → เติมชื่อบริษัทจากฝั่ง sale_orders
  for (const q of quotes) {
    const key = `${q.customer_id}|${Number(q.contact_id)}`;
    if (baseCompanyByPair.has(key)) continue;
    const so = baseRows.find(r => r.company_id === null && Number(r.contact_id) === Number(q.contact_id));
    if (so?.customer_name) baseCompanyByPair.set(key, so.customer_name);
  }
}

let cursor = 0;
let firstRowBad = 0;
let continuationBad = 0;
let missingCompany = 0;
let missingQuotationNo = 0;
let missingPaymentTerm = 0;
let badContact = 0;
let badNote = 0;
let badSuffix = 0;
let badSalesTeam = 0;
let emptySalesTeam = 0;
let noContactId = 0;
let badEmpQuotationId = 0;
let emptyEmpQuotationId = 0;
// ชื่อที่มีช่องว่างหัว/ท้ายต้องไปถึงไฟล์แบบครบตัวอักษร ไม่โดน trim ระหว่างทาง
let edgeSpaceNames = 0;
let edgeSpaceTrimmed = 0;
// ชื่อในไฟล์ต้องตรงกับตารางหลักแบบตรงตัวทุกอักขระ (ตัวเทียบอิสระจากท่อน JOIN ที่ export ใช้)
let baseNameChecked = 0;
let baseNameMismatch = 0;

for (const quote of quotesWithItems) {
  const slice = rows.slice(cursor, cursor + quote.item_details.length);
  cursor += quote.item_details.length;

  const first = slice[0];
  // date_order / source_id เป็นช่องที่ Odoo บังคับในแถวหัวใบ
  if (!first.date_order || !first.source_id) {
    firstRowBad++;
    console.log(`   ✗ ${quote.quotation_no}: แถวแรกขาดค่าหัวใบ (date_order="${first.date_order}" source_id="${first.source_id}")`);
  }
  if (!first.partner_id) {
    missingCompany++;
    console.log(`   ⚠️  ${quote.quotation_no}: partner_id ว่าง — ใบนี้ยังไม่ได้ผูกลูกค้า นำเข้า Odoo ไม่ผ่าน`);
  }
  if (!first.name) missingQuotationNo++;
  // เครดิตเทอมว่าง = ปล่อยเซลล์ว่างตามที่ตกลงไว้ ไม่ใช่ข้อผิดพลาด — นับไว้ให้เห็นภาพเฉย ๆ
  if (!first.payment_term_id) missingPaymentTerm++;

  // C: contact ต้องเป็น "บริษัท, ผู้ติดต่อ" ตาม template — ต่อชื่อเสมอแม้ 2 ชื่อซ้ำกัน
  // ชื่อต้องคงช่องว่างหัวท้ายไว้ดิบ ๆ (ห้าม .trim()) เพราะ Odoo เทียบชื่อ res.partner แบบตรงตัวทุกอักขระ
  // ชื่อดิบจากตารางหลักมาก่อน snapshot ตามลำดับเดียวกับ buildOdooSaleOrderRows()
  const rawContactName = String(quote.raw_contact_name ?? quote.customer_details?.contact_name ?? '');
  const hasContact = rawContactName.trim() !== '' && rawContactName.trim() !== '-';
  const contactName = hasContact ? rawContactName : '';
  const expectedContact = hasContact && first.partner_id
    ? `${first.partner_id}, ${contactName}`
    : (first.partner_id || contactName);
  if (first.contact !== expectedContact) {
    badContact++;
    console.log(`   ✗ ${quote.quotation_no}: contact ไม่ตรงรูปแบบ (ได้ "${first.contact}" คาด "${expectedContact}")`);
  }

  // กันการถดถอยของบั๊กที่ทำให้นำเข้า Odoo ไม่ผ่าน: ชื่อผู้ติดต่ออย่าง "คุณแนน " (มีช่องว่างท้าย)
  // เคยโดน .trim() ตอน export แล้วกลายเป็นคนละ res.partner กับที่ Odoo เก็บ ทั้งใบจึงนำเข้าไม่ได้
  const rawCompanyName = String(
    quote.raw_customer_name ?? String(quote.customer_details?.customer_name ?? '').split(' | ')[0]
  );
  for (const [label, raw, got] of [
    ['ชื่อบริษัท', rawCompanyName, first.partner_id],
    ['ชื่อผู้ติดต่อ', rawContactName, first.contact],
  ] as const) {
    if (raw.trim() === '' || raw.trim() === '-' || raw === raw.trim()) continue;
    edgeSpaceNames++;
    if (!got.includes(raw)) {
      edgeSpaceTrimmed++;
      console.log(`   ✗ ${quote.quotation_no}: ${label}โดนตัดช่องว่าง — ต้นทาง "${raw}" แต่ไฟล์ได้ "${got}"`);
    }
  }

  // ตัวเทียบอิสระ: ชื่อในไฟล์ต้องตรงกับตารางหลัก (customers/sale_orders) แบบตรงตัวทุกอักขระ
  // ไม่ได้อ่านผ่าน ODOO_EXPORT_RAW_NAME_JOINS ที่ export ใช้ เพื่อให้จับได้ถ้าท่อน JOIN นั้นเองผิด
  for (const [label, baseName, got] of [
    ['ชื่อบริษัท', baseCompanyByPair.get(`${quote.customer_id}|${quote.contact_id}`), first.partner_id],
    ['ชื่อผู้ติดต่อ', baseContactByContactId.get(Number(quote.contact_id)), first.contact],
  ] as const) {
    // เทียบเฉพาะใบที่ชื่อ "ตัวเดียวกัน ต่างแค่ช่องว่าง" — ใบที่ลูกค้าถูกเปลี่ยนชื่อใน Odoo ทีหลัง
    // ตั้งใจให้คงชื่อตาม snapshot จึงไม่ใช่ข้อผิดพลาด
    if (!baseName || !got) continue;
    if (baseName.trim() === '' || !got.includes(baseName.trim())) continue;
    baseNameChecked++;
    if (!got.includes(baseName)) {
      baseNameMismatch++;
      console.log(`   ✗ ${quote.quotation_no}: ${label}ในไฟล์ไม่ตรงตารางหลัก — ตาราง "${baseName}" แต่ไฟล์ได้ "${got}"`);
    }
  }

  // H: ชื่อเซลล์ต้องมีสังกัดห้อยท้ายตามคำนำหน้าเลขที่ใบ
  const expectedSuffix = quote.quotation_no.toUpperCase().startsWith('QT') ? '(THT)' : '(PM)';
  if (first.salesperson && !first.salesperson.endsWith(expectedSuffix)) {
    badSuffix++;
    console.log(`   ✗ ${quote.quotation_no}: ชื่อเซลล์ไม่ลงท้าย ${expectedSuffix} (H="${first.salesperson}")`);
  }

  // J: ชื่อจริงของเซลล์จาก salesperson.employee_quotation_id + สังกัดห้อยท้ายชุดเดียวกับช่อง H
  // ยังไม่กรอกในหน้าแอดมิน (NULL/''/'-') = เซลล์ว่าง ห้ามถอยไปใช้ชื่อจากช่อง H
  // ตัวเทียบอิสระ: คำนวณสังกัดจากคำนำหน้าเลขที่ใบเอง (ใบที่ไม่ใช่ QT/QP ไม่ห้อยสังกัด)
  // และไม่ห้อยซ้ำถ้าแอดมินพิมพ์สังกัดมาในค่าเองแล้ว — กติกาเดียวกับ withCompanySuffix()
  const upperNo = quote.quotation_no.toUpperCase();
  const suffix = upperNo.startsWith('QT') ? '(THT)' : upperNo.startsWith('QP') ? '(PM)' : '';
  const rawEmpQuotationId = String(quote.salesperson_employee_quotation_id ?? '').trim();
  const wantEmpQuotationId = rawEmpQuotationId === '' || rawEmpQuotationId === '-'
    ? ''
    : (suffix && !rawEmpQuotationId.endsWith(suffix) ? `${rawEmpQuotationId}${suffix}` : rawEmpQuotationId);
  if (first.employee_quotation_id !== wantEmpQuotationId) {
    badEmpQuotationId++;
    console.log(`   ✗ ${quote.quotation_no}: employee_quotation_id ไม่ตรง (ได้ "${first.employee_quotation_id}" คาด "${wantEmpQuotationId}")`);
  }
  if (!first.employee_quotation_id) emptyEmpQuotationId++;

  // I: Sales Team ต้องเป็นทีมขายของผู้ติดต่อใน customers_data (join ด้วย contact_id)
  // ไม่ใช่สังกัดของเซลล์ (salesperson.branch) — ใบที่ผู้ติดต่อไม่มีทีมขายต้องได้เซลล์ว่าง
  const wantSalesTeam = expectedSalesTeam(quote);
  if (first.sales_team !== wantSalesTeam) {
    badSalesTeam++;
    console.log(`   ✗ ${quote.quotation_no}: Sales Team ไม่ตรง customers_data (ได้ "${first.sales_team}" คาด "${wantSalesTeam}" contact_id=${quote.contact_id})`);
  }
  if (!first.sales_team) emptySalesTeam++;
  if (!(Number(quote.contact_id) > 0)) noContactId++;

  // L: note ต้องเป็นหมายเหตุการรับประกันชุดเดียวกับที่ PDF พิมพ์
  const expectedNote = warrantyNoteText(resolveMinWarrantyDisplay(quote.item_details));
  if (first.note !== expectedNote) {
    badNote++;
    console.log(`   ✗ ${quote.quotation_no}: note ไม่ตรง (ได้ "${first.note}" คาด "${expectedNote}")`);
  }

  for (const row of slice.slice(1)) {
    const leaked = HEADER_KEYS.filter(key => row[key] !== '');
    if (leaked.length > 0) {
      continuationBad++;
      console.log(`   ✗ ${quote.quotation_no}: แถวต่อเนื่องมีค่าหัวใบค้าง → ${leaked.join(', ')}`);
    }
  }
}

ok('ทุกใบมีค่าหัวใบครบในแถวแรก', firstRowBad === 0, firstRowBad ? `(พลาด ${firstRowBad} ใบ)` : '');
ok('แถวที่ 2 ขึ้นไปเว้นคอลัมน์ A–L ว่างตามกติกา one2many', continuationBad === 0,
  continuationBad ? `(พลาด ${continuationBad} แถว)` : '');
ok('ทุกใบผูกลูกค้าแล้ว (partner_id ไม่ว่าง)', missingCompany === 0,
  missingCompany ? `(ว่าง ${missingCompany} ใบ)` : '');
ok('ช่อง contact เป็นรูปแบบ "บริษัท, ผู้ติดต่อ"', badContact === 0,
  badContact ? `(พลาด ${badContact} ใบ)` : '');
ok('ชื่อลูกค้า/ผู้ติดต่อคงช่องว่างหัวท้ายไว้ครบ (ไม่โดน trim)', edgeSpaceTrimmed === 0,
  edgeSpaceTrimmed ? `(โดนตัด ${edgeSpaceTrimmed} ชื่อ)` : `(ตรวจ ${edgeSpaceNames} ชื่อที่มีช่องว่างหัวท้าย)`);
ok('ชื่อในไฟล์ตรงกับตารางหลัก customers/sale_orders ทุกอักขระ', baseNameMismatch === 0,
  baseNameMismatch ? `(ไม่ตรง ${baseNameMismatch} ชื่อ)` : `(ตรวจ ${baseNameChecked} ชื่อ)`);
ok('ช่อง note ตรงกับหมายเหตุการรับประกันของใบ', badNote === 0, badNote ? `(พลาด ${badNote} ใบ)` : '');
ok('ชื่อเซลล์ (H) มีสังกัด (PM)/(THT) ห้อยท้ายตามเลขที่ใบ', badSuffix === 0,
  badSuffix ? `(พลาด ${badSuffix} ใบ)` : '');
ok('Sales Team (I) ตรงกับ customers_data ของ contact_id นั้น', badSalesTeam === 0,
  badSalesTeam ? `(พลาด ${badSalesTeam} ใบ)` : `(ตรวจ ${quotesWithItems.length} ใบ)`);
if (emptySalesTeam > 0) {
  console.log(`   ℹ️  ${emptySalesTeam} ใบได้ Sales Team เป็นเซลล์ว่าง` +
    (noContactId > 0 ? ` (ในนั้น ${noContactId} ใบยังไม่ผูก contact_id)` : '') +
    ' — ผู้ติดต่อไม่มีทีมขายในฐานข้อมูล ไม่ถอยไปใช้สังกัดของเซลล์ตามที่ตกลงไว้');
}
ok('employee_quotation_id (J) ตรงกับ salesperson.employee_quotation_id + สังกัดห้อยท้าย',
  badEmpQuotationId === 0,
  badEmpQuotationId ? `(พลาด ${badEmpQuotationId} ใบ)` : `(ตรวจ ${quotesWithItems.length} ใบ)`);
if (emptyEmpQuotationId > 0) {
  console.log(`   ℹ️  ${emptyEmpQuotationId} ใบได้ช่อง J เป็นเซลล์ว่าง — เซลล์ยังไม่ถูกกรอกชื่อจริง` +
    ' (หรือถูกลบไปแล้ว) ในหน้าจัดการพนักงาน ไม่ถอยไปใช้ชื่อจากช่อง H ตามที่ตกลงไว้');
}
if (missingQuotationNo > 0) {
  console.log(`   ⚠️  ${missingQuotationNo} ใบไม่มีเลขที่ใบเสนอราคา (ช่อง name จะว่าง — Odoo จะออกเลขให้เอง)`);
}
if (missingPaymentTerm > 0) {
  console.log(`   ℹ️  ${missingPaymentTerm} ใบไม่มีเครดิตเทอม → ช่อง payment_term_id เป็นเซลล์ว่าง (ตามที่ตกลงไว้)`);
}

// ── 4. ชนิด/ช่วงค่าของช่องรายการสินค้า ──────────────────────────────────
const noProduct = rows.filter(r => !r.product).length;
const badNumber = rows.filter(r => !Number.isFinite(r.quantity) || !Number.isFinite(r.price_unit)).length;
const badDiscount = rows.filter(r => !(r.discount >= 0 && r.discount <= 100)).length;
const badUom = rows.filter(r => r.uom !== config.uom).length;
const badTax = rows.filter(r => r.tax_id !== tax).length;

ok('ทุกแถวมีรหัสสินค้า (order_line/product)', noProduct === 0, noProduct ? `(ว่าง ${noProduct} แถว)` : '');
ok('จำนวนและราคาเป็นตัวเลขทุกแถว', badNumber === 0, badNumber ? `(พลาด ${badNumber} แถว)` : '');
ok('ส่วนลดอยู่ในช่วง 0–100%', badDiscount === 0, badDiscount ? `(นอกช่วง ${badDiscount} แถว)` : '');
ok(`หน่วยนับเป็น "${config.uom}" ทุกแถวตาม template`, badUom === 0, badUom ? `(พลาด ${badUom} แถว)` : '');
ok(`ภาษีเป็น "${tax}" ทุกแถวตามบริษัท ${company}`, badTax === 0, badTax ? `(พลาด ${badTax} แถว)` : '');

// ── 5. ส่วนต่างของยอดหลังยุบส่วนลด 2 ชั้นเหลือช่องเดียว ─────────────────
//  ยอดที่ Odoo จะได้ = Σ qty × price × (1 − discount/100) ต้องเท่ากับยอดที่ระบบคิดไว้
const TOLERANCE = 1; // บาท
cursor = 0;
let maxDrift = 0;
let overTolerance = 0;

for (const quote of quotesWithItems) {
  const slice = rows.slice(cursor, cursor + quote.item_details.length);
  cursor += quote.item_details.length;

  const odooSum = slice.reduce((sum, r) => sum + r.quantity * r.price_unit * (1 - r.discount / 100), 0);
  const systemSum = quote.item_details.reduce((sum: number, item: any) => sum + calcLineTotal(item), 0);
  const drift = Math.abs(odooSum - systemSum);
  if (drift > maxDrift) maxDrift = drift;
  if (drift > TOLERANCE) {
    overTolerance++;
    console.log(`   ✗ ${quote.quotation_no}: ยอดต่าง ${drift.toFixed(2)} บาท (Odoo ${odooSum.toFixed(2)} / ระบบ ${systemSum.toFixed(2)})`);
  }
}
ok(`ยอดรวมหลังยุบส่วนลดตรงกับระบบ (คลาด ≤ ${TOLERANCE} บาท/ใบ)`, overTolerance === 0,
  `ส่วนต่างสูงสุด ${maxDrift.toFixed(4)} บาท`);

// ── 6. เขียนไฟล์ได้จริงทั้ง 2 รูปแบบ ────────────────────────────────────
const csv = serializeOdooRowsToCsv(rows);
const csvHeaderLine = csv.replace(/^﻿/, '').split('\n')[0].replace(/\r$/, '');
const expectedCsvHeader = TEMPLATE_HEADERS.map(h => `"${h}"`).join(',');
ok('CSV มี BOM UTF-8', csv.startsWith('﻿'));
ok('บรรทัดหัวของ CSV ตรงกับ template', csvHeaderLine === expectedCsvHeader,
  csvHeaderLine === expectedCsvHeader ? '' : `\n     ได้: ${csvHeaderLine}\n     คาด: ${expectedCsvHeader}`);
ok('จำนวนบรรทัดข้อมูลใน CSV ตรงกับจำนวนแถว',
  csv.replace(/^﻿/, '').trimEnd().split('\n').length === rows.length + 1);

const xlsx = await serializeOdooRowsToXlsx(rows);
// ไฟล์ xlsx เป็น zip — ต้องขึ้นต้นด้วยลายเซ็น PK
ok('เขียนไฟล์ .xlsx ได้และเป็นไฟล์ zip ที่ถูกต้อง',
  xlsx.length > 0 && xlsx[0] === 0x50 && xlsx[1] === 0x4b, `(${xlsx.length} bytes)`);

// ── 7. เขียนไฟล์ตัวอย่างไว้ตรวจด้วยตา (ถ้าสั่ง --write) ─────────────────
const outDir = process.argv.includes('--write') ? argValue('write', '.') : '';
if (outDir) {
  const { writeFileSync } = await import('fs');
  const { join } = await import('path');
  writeFileSync(join(outDir, 'salechatbot_quotation_sample.csv'), csv, 'utf8');
  writeFileSync(join(outDir, 'salechatbot_quotation_sample.xlsx'), xlsx);
  console.log(`   เขียนไฟล์ตัวอย่างไว้ที่ ${outDir}`);
}

console.log(`\nสรุป: ${company} ${quotes.length} ใบ → ${rows.length} แถว`);
await pool.end();
