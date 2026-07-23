/**
 * แปลงใบเสนอราคาเป็นไฟล์นำเข้า Sale Order ของ Odoo (template "24.Sale order.xlsx")
 *
 * เป็นจุดเดียวในระบบที่รู้เรื่อง format นี้ — ทั้งลำดับ 16 คอลัมน์ การแปลงค่า และการเขียนไฟล์
 * โมดูลนี้ไม่ยุ่งกับ Express/HTTP เพื่อให้ diag harness เรียกทดสอบได้ตรง ๆ
 *
 * ⚠️ กติกา one2many ของ Odoo: 1 ใบสั่งขายที่มีหลายรายการ = แถวแรกใส่ครบ A–P
 *    แถวที่ 2 เป็นต้นไปต้อง **เว้น A–I ว่าง** ใส่แต่ J–P
 *    ถ้าใส่ค่าหัวใบซ้ำทุกแถว Odoo จะสร้างใบสั่งขายแยกทีละแถว
 */
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';
import { calcNetPrice } from '../utils/pricing.js';

/** หัวคอลัมน์ A–P — ต้องตรงกับชีต "Import " ของ template เป๊ะ ห้ามสลับลำดับ */
export const ODOO_SO_HEADERS = [
  'partner_id',
  'contact_id',
  'partner_invoice_id',
  'partner_shipping_id',
  'date_order',
  'Pricelist_id',
  'payment_term_id',
  'Salesperson',
  'Sales Team',
  'order_line/product',
  'order_line/product_template_id',
  'order_line/product_uom_qty',
  'order_line/product_uom',
  'order_line/price_unit',
  'order_line/tax_id',
  'order_line/discount',
] as const;

/** ชื่อชีตที่ Odoo อ่าน — มีเว้นวรรคท้ายตาม template ต้นฉบับ */
export const ODOO_SO_SHEET_NAME = 'Import ';

export type OdooExportFormat = 'xlsx' | 'csv';

export interface OdooExportConfig {
  /** F: Pricelist_id — Odoo บังคับ แต่ระบบเราไม่ได้เก็บ */
  pricelist: string;
  /** O: order_line/tax_id */
  tax: string;
  /** G: payment_term_id — ใช้เมื่อ snapshot ของใบไม่มีเครดิตเทอม */
  paymentTermFallback: string;
  /** M: order_line/product_uom — ใช้เมื่อหาหน่วยของสินค้าไม่เจอ */
  uomFallback: string;
}

/** แถวใบเสนอราคาที่ endpoint/diag ส่งเข้ามา (มาจาก quotations LEFT JOIN salesperson) */
export interface OdooExportQuotationRow {
  quotation_no?: string | null;
  created_at?: Date | string | null;
  customer_details?: any;
  item_details?: any;
  employee_details?: any;
  /** salesperson.name — ใช้เป็น fallback ของช่อง Salesperson */
  salesperson_name?: string | null;
  /** salesperson.branch — ใช้เป็นช่อง Sales Team */
  salesperson_branch?: string | null;
}

/** 1 แถวในไฟล์ = 1 รายการสินค้า (ช่องหัวใบเป็นค่าว่างในแถวที่ 2 ขึ้นไปของใบเดียวกัน) */
export interface OdooSoRow {
  partner_id: string;
  contact_id: string;
  partner_invoice_id: string;
  partner_shipping_id: string;
  /** 'YYYY-MM-DD HH:mm:ss' ตามเวลา Asia/Bangkok — ว่างในแถวต่อเนื่อง */
  date_order: string;
  pricelist_id: string;
  payment_term_id: string;
  salesperson: string;
  sales_team: string;
  product: string;
  product_template_id: number | null;
  quantity: number;
  uom: string;
  price_unit: number;
  tax_id: string;
  /** หน่วยเป็นเปอร์เซ็นต์ตรง ๆ (5 = 5%) ตามที่ field discount ของ Odoo เก็บ */
  discount: number;
}

export function loadOdooExportConfig(): OdooExportConfig {
  return {
    pricelist: process.env.ODOO_EXPORT_PRICELIST || 'THB pricelist (THB)',
    tax: process.env.ODOO_EXPORT_TAX || 'Output VAT 7% (Exc)',
    paymentTermFallback: process.env.ODOO_EXPORT_PAYMENT_TERM || '',
    uomFallback: process.env.ODOO_EXPORT_UOM || 'Units',
  };
}

/** ค่าที่ snapshot ใช้แทน "ไม่มีข้อมูล" มีทั้ง null, '' และ '-' */
function clean(value: any): string {
  const s = String(value ?? '').trim();
  return s === '-' ? '' : s;
}

/**
 * วันเวลาตามโซน Asia/Bangkok รูปแบบ 'YYYY-MM-DD HH:mm:ss'
 *
 * created_at เป็น timestamptz — ถ้าปล่อยให้ toISOString() จะได้เวลา UTC ซึ่งเลื่อนไป 7 ชั่วโมง
 * จากที่เซลล์เห็นในระบบ ใบที่ออกช่วงเช้าจะกลายเป็นวันก่อนหน้า
 */
function formatBangkok(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * ส่วนลดรวมของ 2 ชั้นเป็นเปอร์เซ็นต์เดียว — Odoo มีช่อง discount ช่องเดียว
 *
 * ใช้ calcNetPrice() เป็นตัวตั้งเพื่อไม่ให้สูตรส่วนลดแตกไปจากที่ระบบคิดยอดจริง
 * เก็บ 4 ตำแหน่งเพื่อกันเศษ float (เช่น 14.499999999999998) — Odoo จะปัดเหลือ 2 ตำแหน่งเองตอนนำเข้า
 */
function combinedDiscountPercent(price: number, disc1: number, disc2: number): number {
  if (!Number.isFinite(price) || price === 0) return 0;
  const pct = (1 - calcNetPrice(price, disc1, disc2) / price) * 100;
  return Math.round(pct * 10000) / 10000;
}

/** product_template_id ทั้งหมดที่ใช้ในชุดใบเสนอราคา — เอาไปดึงหน่วยนับทีเดียว */
export function collectProductTemplateIds(quotes: OdooExportQuotationRow[]): number[] {
  const ids: number[] = [];
  (quotes || []).forEach(q => {
    const items = Array.isArray(q.item_details) ? q.item_details : [];
    items.forEach((item: any) => {
      const id = Number(item?.product_id);
      if (Number.isFinite(id) && id > 0) ids.push(id);
    });
  });
  return Array.from(new Set(ids));
}

/**
 * แปลงใบเสนอราคาเป็นแถวตาม template — ใบที่ไม่มีรายการสินค้าจะถูกข้าม (นำเข้า Odoo ไม่ได้)
 *
 * ⚠️ อ่านรายการจาก item_details (snapshot ดิบ) ไม่ใช่ items ที่ enrichQuotationData() คืนมา
 *    เพราะ whitelist ที่นั่นตัด internal_reference ทิ้ง ซึ่งเป็นค่าที่ช่อง order_line/product ต้องใช้
 */
export function buildOdooSaleOrderRows(
  quotes: OdooExportQuotationRow[],
  uomMap: Record<number, string>,
  config: OdooExportConfig
): OdooSoRow[] {
  const rows: OdooSoRow[] = [];

  (quotes || []).forEach(quote => {
    const items = Array.isArray(quote.item_details) ? quote.item_details : [];
    if (items.length === 0) return;

    const cust = quote.customer_details || {};
    // snapshot ควรเก็บเฉพาะชื่อบริษัท แต่ข้อมูลเก่าอาจปนเป็น "company | contact" — split แบบเดียวกับ
    // enrichQuotationData() (services/quotationService.ts) เพื่อให้ชื่อที่ส่งออกตรงกับที่หน้าจอโชว์
    const company = clean(String(cust.customer_name ?? '').split(' | ')[0]);
    const contact = clean(cust.contact_name);
    const address = clean(cust.address);

    const header = {
      partner_id: company,
      contact_id: contact,
      partner_invoice_id: address,
      partner_shipping_id: address,
      date_order: formatBangkok(quote.created_at),
      pricelist_id: config.pricelist,
      payment_term_id: clean(cust.payment_terms) || config.paymentTermFallback,
      salesperson: clean(quote.employee_details?.saleperson) || clean(quote.salesperson_name),
      sales_team: clean(quote.salesperson_branch),
    };

    items.forEach((item: any, index: number) => {
      const isFirst = index === 0;
      const templateId = Number(item?.product_id);
      const hasTemplateId = Number.isFinite(templateId) && templateId > 0;
      const price = Number(item?.price) || 0;

      rows.push({
        partner_id: isFirst ? header.partner_id : '',
        contact_id: isFirst ? header.contact_id : '',
        partner_invoice_id: isFirst ? header.partner_invoice_id : '',
        partner_shipping_id: isFirst ? header.partner_shipping_id : '',
        date_order: isFirst ? header.date_order : '',
        pricelist_id: isFirst ? header.pricelist_id : '',
        payment_term_id: isFirst ? header.payment_term_id : '',
        salesperson: isFirst ? header.salesperson : '',
        sales_team: isFirst ? header.sales_team : '',
        product: clean(item?.internal_reference) || clean(item?.model),
        product_template_id: hasTemplateId ? templateId : null,
        quantity: Number(item?.quantity) || 0,
        uom: (hasTemplateId ? uomMap[templateId] : '') || config.uomFallback,
        price_unit: price,
        tax_id: config.tax,
        discount: combinedDiscountPercent(price, Number(item?.discount_1) || 0, Number(item?.discount_2) || 0),
      });
    });
  });

  return rows;
}

/** ค่าของแถวเรียงตามลำดับคอลัมน์ A–P */
function toOrderedValues(row: OdooSoRow, format: OdooExportFormat): (string | number | Date | null)[] {
  // xlsx ใช้ null เพื่อให้เซลล์ว่างจริง ส่วน csv ใช้สตริงว่าง
  const blank = format === 'xlsx' ? null : '';
  const text = (v: string) => (v ? v : blank);
  // เวลาใน Excel ไม่มีโซนเวลา — ตีสตริงเวลาไทยเป็น UTC เพื่อให้เซลล์แสดงตรงกับที่คำนวณไว้
  const date = row.date_order ? new Date(`${row.date_order.replace(' ', 'T')}Z`) : null;

  return [
    text(row.partner_id),
    text(row.contact_id),
    text(row.partner_invoice_id),
    text(row.partner_shipping_id),
    row.date_order ? (format === 'xlsx' ? date : row.date_order) : blank,
    text(row.pricelist_id),
    text(row.payment_term_id),
    text(row.salesperson),
    text(row.sales_team),
    text(row.product),
    row.product_template_id === null ? blank : row.product_template_id,
    row.quantity,
    text(row.uom),
    row.price_unit,
    text(row.tax_id),
    row.discount,
  ];
}

/** CSV พร้อม BOM UTF-8 (ไม่มี BOM แล้ว Excel จะอ่านภาษาไทยเพี้ยน) */
export function serializeOdooRowsToCsv(rows: OdooSoRow[]): string {
  const fields = [...ODOO_SO_HEADERS];
  const records = rows.map(row => {
    const values = toOrderedValues(row, 'csv');
    return Object.fromEntries(fields.map((field, i) => [field, values[i]]));
  });
  const csv = new Parser({ fields }).parse(records);
  return `﻿${csv}`;
}

export async function serializeOdooRowsToXlsx(rows: OdooSoRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  // Odoo อ่านเฉพาะชีตแรกของไฟล์ จึงสร้างชีตเดียวแทนการ round-trip ไฟล์ template
  // (template จริงมีรูปหน้าจอ ~700KB ในชีต Details ที่ไม่จำเป็นต่อการนำเข้า)
  const sheet = workbook.addWorksheet(ODOO_SO_SHEET_NAME);

  sheet.addRow([...ODOO_SO_HEADERS]);
  sheet.getRow(1).font = { bold: true };
  rows.forEach(row => sheet.addRow(toOrderedValues(row, 'xlsx')));

  // คอลัมน์ E (date_order) — ต้องเป็นเซลล์วันที่ ไม่ใช่ตัวเลข serial ดิบ
  sheet.getColumn(5).numFmt = 'yyyy-mm-dd h:mm:ss';
  ODOO_SO_HEADERS.forEach((headerText, i) => {
    sheet.getColumn(i + 1).width = Math.max(14, Math.min(38, headerText.length + 4));
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
