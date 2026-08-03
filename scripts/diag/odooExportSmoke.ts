// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของไฟล์นำเข้า Sale Order สำหรับ Odoo (template "import odoo template.xlsx")
//  รัน:  npm run diag:odoo-export            (ค่าตั้งต้น 20 ใบล่าสุด)
//        npm run diag:odoo-export -- --limit 100
//        npm run diag:odoo-export -- --status draft
//
//  read-only ทั้งหมด — อ่านใบเสนอราคาจริงมา build แถวแล้วตรวจ ไม่เขียนอะไรลง DB
//
//  ครอบคลุม: ลำดับ/จำนวนหัวคอลัมน์ · กติกา one2many ของ Odoo (แถวที่ 2+ ต้องเว้น A–L) ·
//            ช่องบังคับที่ว่างไม่ได้ · ช่องค่าคงที่ (source_id/uom/tax) · ชนิดข้อมูลของช่องตัวเลข
//            ส่วนต่างของยอดรวมหลังยุบส่วนลด 2 ชั้นเหลือช่องเดียว · หมายเหตุการรับประกัน
//  ให้รันซ้ำทุกครั้งที่แตะ services/odooSaleOrderExport.ts หรือ endpoint export
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  ODOO_SO_HEADERS,
  buildOdooSaleOrderRows,
  loadOdooExportConfig,
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
const filterSql = status
  ? 'q.status = $1'
  : "q.quotation_no IS NOT NULL AND TRIM(q.quotation_no) <> ''";
const filterParams = status ? [status, limit] : [limit];
const limitParam = status ? '$2' : '$1';
const { rows: quotes } = await pool.query<OdooExportQuotationRow & { quotation_no: string; total_sum: string }>(
  `SELECT q.quotation_no, q.total_sum, q.created_at, q.updated_at, q.customer_details, q.item_details, q.employee_details,
          s.name AS salesperson_name, s.branch AS salesperson_branch
     FROM quotations q
     LEFT JOIN salesperson s ON q.user_id = s.user_id
    WHERE ${filterSql}
    ORDER BY q.created_at DESC
    LIMIT ${limitParam}`,
  filterParams
);
console.log(`   ตัวกรอง=${status ? `สถานะ "${status}"` : 'ทุกใบที่มีเลขที่ใบเสนอราคา'} ดึงมา ${quotes.length} ใบ`);
if (quotes.length === 0) {
  console.log('⚠️  ไม่มีใบเสนอราคาให้ตรวจ — ลองเปลี่ยน --status หรือใส่ข้อมูลทดสอบก่อน');
  await pool.end();
  process.exit(0);
}

const config = loadOdooExportConfig();
console.log(`   config: tax="${config.tax}" sourceId="${config.sourceId}" uom="${config.uom}"`);

const rows = buildOdooSaleOrderRows(quotes, config);

const quotesWithItems = quotes.filter(q => Array.isArray(q.item_details) && q.item_details.length > 0);
const expectedRowCount = quotesWithItems.reduce((sum, q) => sum + q.item_details.length, 0);
ok('จำนวนแถวรวม = ผลรวมจำนวนรายการของทุกใบ', rows.length === expectedRowCount,
  `(ได้ ${rows.length} / คาด ${expectedRowCount})`);
if (quotesWithItems.length !== quotes.length) {
  console.log(`   ℹ️  ข้าม ${quotes.length - quotesWithItems.length} ใบที่ไม่มีรายการสินค้า (นำเข้า Odoo ไม่ได้)`);
}

// ── 3. กติกา one2many: แถวแรกของใบมีหัวใบครบ แถวถัดไปต้องว่าง ───────────
const HEADER_KEYS = [
  'name', 'partner_id', 'contact', 'partner_invoice_id', 'partner_shipping_id',
  'date_order', 'payment_term_id', 'salesperson', 'sales_team', 'employee_quotation_id',
  'source_id', 'note',
] as const;

let cursor = 0;
let firstRowBad = 0;
let continuationBad = 0;
let missingCompany = 0;
let missingQuotationNo = 0;
let missingPaymentTerm = 0;
let badContact = 0;
let badNote = 0;
let badSuffix = 0;

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
  const contactName = String(quote.customer_details?.contact_name ?? '').trim();
  const hasContact = contactName !== '' && contactName !== '-';
  const expectedContact = hasContact && first.partner_id
    ? `${first.partner_id}, ${contactName}`
    : (first.partner_id || (hasContact ? contactName : ''));
  if (first.contact !== expectedContact) {
    badContact++;
    console.log(`   ✗ ${quote.quotation_no}: contact ไม่ตรงรูปแบบ (ได้ "${first.contact}" คาด "${expectedContact}")`);
  }

  // H/J: ชื่อเซลล์ต้องมีสังกัดห้อยท้ายตามคำนำหน้าเลขที่ใบ และต้องเป็นค่าเดียวกันทั้ง 2 ช่อง
  const expectedSuffix = quote.quotation_no.toUpperCase().startsWith('QT') ? '(THT)' : '(PM)';
  if (first.salesperson !== first.employee_quotation_id ||
      (first.salesperson && !first.salesperson.endsWith(expectedSuffix))) {
    badSuffix++;
    console.log(`   ✗ ${quote.quotation_no}: ชื่อเซลล์ไม่ลงท้าย ${expectedSuffix}` +
      ` (H="${first.salesperson}" J="${first.employee_quotation_id}")`);
  }

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
ok('ช่อง note ตรงกับหมายเหตุการรับประกันของใบ', badNote === 0, badNote ? `(พลาด ${badNote} ใบ)` : '');
ok('ชื่อเซลล์ (H/J) มีสังกัด (PM)/(THT) ห้อยท้ายตามเลขที่ใบ', badSuffix === 0,
  badSuffix ? `(พลาด ${badSuffix} ใบ)` : '');
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
const badTax = rows.filter(r => r.tax_id !== config.tax).length;

ok('ทุกแถวมีรหัสสินค้า (order_line/product)', noProduct === 0, noProduct ? `(ว่าง ${noProduct} แถว)` : '');
ok('จำนวนและราคาเป็นตัวเลขทุกแถว', badNumber === 0, badNumber ? `(พลาด ${badNumber} แถว)` : '');
ok('ส่วนลดอยู่ในช่วง 0–100%', badDiscount === 0, badDiscount ? `(นอกช่วง ${badDiscount} แถว)` : '');
ok(`หน่วยนับเป็น "${config.uom}" ทุกแถวตาม template`, badUom === 0, badUom ? `(พลาด ${badUom} แถว)` : '');
ok(`ภาษีเป็น "${config.tax}" ทุกแถวตาม template`, badTax === 0, badTax ? `(พลาด ${badTax} แถว)` : '');

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

console.log(`\nสรุป: ${quotes.length} ใบ → ${rows.length} แถว`);
await pool.end();
