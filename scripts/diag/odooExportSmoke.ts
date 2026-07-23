// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของไฟล์นำเข้า Sale Order สำหรับ Odoo (template "24.Sale order.xlsx")
//  รัน:  npm run diag:odoo-export            (ค่าตั้งต้น 20 ใบล่าสุด)
//        npm run diag:odoo-export -- --limit 100
//        npm run diag:odoo-export -- --status draft
//
//  read-only ทั้งหมด — อ่านใบเสนอราคาจริงมา build แถวแล้วตรวจ ไม่เขียนอะไรลง DB
//
//  ครอบคลุม: ลำดับ/จำนวนหัวคอลัมน์ · กติกา one2many ของ Odoo (แถวที่ 2+ ต้องเว้น A–I) ·
//            ช่องบังคับที่ว่างไม่ได้ · ชนิดข้อมูลของช่องตัวเลข · ส่วนต่างของยอดรวม
//            หลังยุบส่วนลด 2 ชั้นเหลือช่องเดียว · รายการที่หา product/หน่วยนับไม่เจอ
//  ให้รันซ้ำทุกครั้งที่แตะ services/odooSaleOrderExport.ts หรือ endpoint export
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { getProductUomByTemplateIds } from '../../db/repositories.js';
import {
  ODOO_SO_HEADERS,
  buildOdooSaleOrderRows,
  collectProductTemplateIds,
  loadOdooExportConfig,
  serializeOdooRowsToCsv,
  serializeOdooRowsToXlsx,
  type OdooExportQuotationRow,
} from '../../services/odooSaleOrderExport.js';
import { calcLineTotal } from '../../utils/pricing.js';

const ok = (label: string, cond: boolean, extra = '') =>
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const limit = Math.max(1, Number(argValue('limit', '20')) || 20);
const status = argValue('status', 'confirmed');

/** หัวคอลัมน์ที่คัดลอกจากชีต "Import " ของ template ต้นฉบับ — ตัวเทียบอิสระจากโค้ด */
const TEMPLATE_HEADERS = [
  'partner_id', 'contact_id', 'partner_invoice_id', 'partner_shipping_id',
  'date_order', 'Pricelist_id', 'payment_term_id', 'Salesperson', 'Sales Team',
  'order_line/product', 'order_line/product_template_id', 'order_line/product_uom_qty',
  'order_line/product_uom', 'order_line/price_unit', 'order_line/tax_id', 'order_line/discount',
];

// ── 1. หัวคอลัมน์ตรงกับ template ────────────────────────────────────────
ok('หัวคอลัมน์มี 16 ช่อง', ODOO_SO_HEADERS.length === 16, `(ได้ ${ODOO_SO_HEADERS.length})`);
ok('หัวคอลัมน์ตรงกับ template ทั้งชื่อและลำดับ',
  JSON.stringify([...ODOO_SO_HEADERS]) === JSON.stringify(TEMPLATE_HEADERS));

// ── 2. ดึงใบจริงมา build ────────────────────────────────────────────────
const { rows: quotes } = await pool.query<OdooExportQuotationRow & { quotation_no: string; total_sum: string }>(
  `SELECT q.quotation_no, q.total_sum, q.created_at, q.customer_details, q.item_details, q.employee_details,
          s.name AS salesperson_name, s.branch AS salesperson_branch
     FROM quotations q
     LEFT JOIN salesperson s ON q.user_id = s.user_id
    WHERE q.status = $1
    ORDER BY q.created_at DESC
    LIMIT $2`,
  [status, limit]
);
console.log(`   สถานะ="${status}" ดึงมา ${quotes.length} ใบ`);
if (quotes.length === 0) {
  console.log('⚠️  ไม่มีใบเสนอราคาให้ตรวจ — ลองเปลี่ยน --status หรือใส่ข้อมูลทดสอบก่อน');
  await pool.end();
  process.exit(0);
}

const config = loadOdooExportConfig();
console.log(`   config: pricelist="${config.pricelist}" tax="${config.tax}"` +
  ` paymentTermFallback="${config.paymentTermFallback}" uomFallback="${config.uomFallback}"`);

const uomMap = await getProductUomByTemplateIds(collectProductTemplateIds(quotes));
const rows = buildOdooSaleOrderRows(quotes, uomMap, config);

const quotesWithItems = quotes.filter(q => Array.isArray(q.item_details) && q.item_details.length > 0);
const expectedRowCount = quotesWithItems.reduce((sum, q) => sum + q.item_details.length, 0);
ok('จำนวนแถวรวม = ผลรวมจำนวนรายการของทุกใบ', rows.length === expectedRowCount,
  `(ได้ ${rows.length} / คาด ${expectedRowCount})`);
if (quotesWithItems.length !== quotes.length) {
  console.log(`   ℹ️  ข้าม ${quotes.length - quotesWithItems.length} ใบที่ไม่มีรายการสินค้า (นำเข้า Odoo ไม่ได้)`);
}

// ── 3. กติกา one2many: แถวแรกของใบมีหัวใบครบ แถวถัดไปต้องว่าง ───────────
const HEADER_KEYS = [
  'partner_id', 'contact_id', 'partner_invoice_id', 'partner_shipping_id',
  'date_order', 'pricelist_id', 'payment_term_id', 'salesperson', 'sales_team',
] as const;

let cursor = 0;
let firstRowBad = 0;
let continuationBad = 0;
let missingCompany = 0;
let missingPaymentTerm = 0;
let missingAddress = 0;

for (const quote of quotesWithItems) {
  const slice = rows.slice(cursor, cursor + quote.item_details.length);
  cursor += quote.item_details.length;

  const first = slice[0];
  // partner_id / date_order / Pricelist_id เป็นช่องที่ Odoo บังคับในแถวหัวใบ
  if (!first.date_order || !first.pricelist_id) {
    firstRowBad++;
    console.log(`   ✗ ${quote.quotation_no}: แถวแรกขาดค่าหัวใบ (date_order="${first.date_order}" pricelist="${first.pricelist_id}")`);
  }
  if (!first.partner_id) {
    missingCompany++;
    console.log(`   ⚠️  ${quote.quotation_no}: partner_id ว่าง — ใบนี้ยังไม่ได้ผูกลูกค้า นำเข้า Odoo ไม่ผ่าน`);
  }
  if (!first.payment_term_id) missingPaymentTerm++;
  // C/D (ที่อยู่ออกใบกำกับ/ส่งของ) ไม่ใช่ช่องบังคับใน Odoo — แค่เตือนให้เห็นว่าใบไหนไม่มีที่อยู่
  if (!first.partner_invoice_id) missingAddress++;

  for (const row of slice.slice(1)) {
    const leaked = HEADER_KEYS.filter(key => row[key] !== '');
    if (leaked.length > 0) {
      continuationBad++;
      console.log(`   ✗ ${quote.quotation_no}: แถวต่อเนื่องมีค่าหัวใบค้าง → ${leaked.join(', ')}`);
    }
  }
}

ok('ทุกใบมีค่าหัวใบครบในแถวแรก', firstRowBad === 0, firstRowBad ? `(พลาด ${firstRowBad} ใบ)` : '');
ok('แถวที่ 2 ขึ้นไปเว้นคอลัมน์ A–I ว่างตามกติกา one2many', continuationBad === 0,
  continuationBad ? `(พลาด ${continuationBad} แถว)` : '');
ok('ทุกใบผูกลูกค้าแล้ว (partner_id ไม่ว่าง)', missingCompany === 0,
  missingCompany ? `(ว่าง ${missingCompany} ใบ)` : '');
if (missingPaymentTerm > 0) {
  console.log(`   ⚠️  ${missingPaymentTerm} ใบไม่มี payment_term_id (Odoo บังคับ) — ตั้ง ODOO_EXPORT_PAYMENT_TERM ใน .env`);
}
if (missingAddress > 0) {
  console.log(`   ⚠️  ${missingAddress} ใบไม่มีที่อยู่ (partner_invoice_id/partner_shipping_id จะว่าง)`);
}

// ── 4. ชนิด/ช่วงค่าของช่องรายการสินค้า ──────────────────────────────────
const noProduct = rows.filter(r => !r.product).length;
const noTemplateId = rows.filter(r => r.product_template_id === null).length;
const badNumber = rows.filter(r => !Number.isFinite(r.quantity) || !Number.isFinite(r.price_unit)).length;
const badDiscount = rows.filter(r => !(r.discount >= 0 && r.discount <= 100)).length;
const fallbackUom = rows.filter(r => r.uom === config.uomFallback).length;

ok('ทุกแถวมีรหัสสินค้า (order_line/product)', noProduct === 0, noProduct ? `(ว่าง ${noProduct} แถว)` : '');
ok('จำนวนและราคาเป็นตัวเลขทุกแถว', badNumber === 0, badNumber ? `(พลาด ${badNumber} แถว)` : '');
ok('ส่วนลดอยู่ในช่วง 0–100%', badDiscount === 0, badDiscount ? `(นอกช่วง ${badDiscount} แถว)` : '');
if (noTemplateId > 0) {
  const refs = Array.from(new Set(rows.filter(r => r.product_template_id === null).map(r => r.product)));
  console.log(`   ⚠️  ${noTemplateId} แถวไม่มี product_template_id (ช่อง K จะว่าง) → ${refs.join(', ')}`);
}
if (fallbackUom > 0) console.log(`   ⚠️  ${fallbackUom} แถวใช้หน่วยสำรอง "${config.uomFallback}" เพราะหา unit_of_measure ไม่เจอ`);

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
  writeFileSync(join(outDir, 'sale_order_odoo_sample.csv'), csv, 'utf8');
  writeFileSync(join(outDir, 'sale_order_odoo_sample.xlsx'), xlsx);
  console.log(`   เขียนไฟล์ตัวอย่างไว้ที่ ${outDir}`);
}

console.log(`\nสรุป: ${quotes.length} ใบ → ${rows.length} แถว`);
await pool.end();
