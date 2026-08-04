/**
 * แปลงใบเสนอราคาเป็นไฟล์นำเข้า Sale Order ของ Odoo (template "import odoo template.xlsx")
 *
 * เป็นจุดเดียวในระบบที่รู้เรื่อง format นี้ — ทั้งลำดับ 18 คอลัมน์ การแปลงค่า และการเขียนไฟล์
 * โมดูลนี้ไม่ยุ่งกับ Express/HTTP เพื่อให้ diag harness เรียกทดสอบได้ตรง ๆ
 *
 * ⚠️ กติกา one2many ของ Odoo: 1 ใบสั่งขายที่มีหลายรายการ = แถวแรกใส่ครบ A–R
 *    แถวที่ 2 เป็นต้นไปต้อง **เว้น A–L ว่าง** ใส่แต่ M–R
 *    ถ้าใส่ค่าหัวใบซ้ำทุกแถว Odoo จะสร้างใบสั่งขายแยกทีละแถว
 */
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';
import { calcNetPrice } from '../utils/pricing.js';
import { resolveMinWarrantyDisplay, warrantyNoteText } from '../utils/warranty.js';

/** หัวคอลัมน์ A–R — ต้องตรงกับชีต "Import " ของ template เป๊ะ ห้ามสลับลำดับ */
export const ODOO_SO_HEADERS = [
  'name',
  'partner_id',
  'contact',
  'partner_invoice_id',
  'partner_shipping_id',
  'date_order',
  'payment_term_id',
  'Salesperson',
  'Sales Team',
  'employee_quotation_id',
  'source_id',
  'note',
  'order_line/product',
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
  /** Q: order_line/tax_id — template กำหนดให้ใส่ค่าเดียวกันทุกแถว */
  tax: string;
  /** K: source_id — template กำหนดให้ใส่ "Sales" เสมอ */
  sourceId: string;
  /** O: order_line/product_uom — template กำหนดให้เป็น Pcs ทุกแถว ไม่ดูหน่วยจริงของสินค้า */
  uom: string;
}

/** แถวใบเสนอราคาที่ endpoint/diag ส่งเข้ามา (มาจาก quotations LEFT JOIN salesperson) */
export interface OdooExportQuotationRow {
  /** A: name — เลขที่ใบเสนอราคา */
  quotation_no?: string | null;
  /** F: date_order — template ใหม่ใช้เวลาที่แก้ไขล่าสุด ไม่ใช่เวลาที่สร้าง */
  updated_at?: Date | string | null;
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
  name: string;
  partner_id: string;
  /** 'ชื่อบริษัท, ชื่อผู้ติดต่อ' ตาม display name ของ res.partner ลูก */
  contact: string;
  partner_invoice_id: string;
  partner_shipping_id: string;
  /** 'YYYY-MM-DD HH:mm:ss' ตามเวลา Asia/Bangkok — ว่างในแถวต่อเนื่อง */
  date_order: string;
  payment_term_id: string;
  salesperson: string;
  sales_team: string;
  employee_quotation_id: string;
  source_id: string;
  /** หมายเหตุการรับประกันของทั้งใบ (ข้อความเดียวกับท้าย PDF) */
  note: string;
  product: string;
  quantity: number;
  uom: string;
  price_unit: number;
  tax_id: string;
  /** หน่วยเป็นเปอร์เซ็นต์ตรง ๆ (5 = 5%) ตามที่ field discount ของ Odoo เก็บ */
  discount: number;
}

export function loadOdooExportConfig(): OdooExportConfig {
  return {
    tax: process.env.ODOO_EXPORT_TAX || 'Output VAT 7% (Exc)',
    sourceId: process.env.ODOO_EXPORT_SOURCE || 'Sales',
    uom: process.env.ODOO_EXPORT_UOM || 'Pcs',
  };
}

/** ค่าที่ snapshot ใช้แทน "ไม่มีข้อมูล" มีทั้ง null, '' และ '-' */
function clean(value: any): string {
  const s = String(value ?? '').trim();
  return s === '-' ? '' : s;
}

/**
 * ชื่อลูกค้า/ผู้ติดต่อต้องส่งดิบ ๆ ห้ามตัดช่องว่างหัวท้าย
 *
 * Odoo จับคู่ res.partner ด้วยการเทียบชื่อแบบตรงตัวทุกอักขระ และชื่อที่ลงท้ายด้วยช่องว่างมีอยู่จริง
 * ในระบบ (ฝั่ง master เจอ 17,666 แถวในชื่อผู้ติดต่อ) พอ clean() .trim() ทิ้ง ค่าที่ส่งออกจะกลายเป็น
 * คนละชื่อกับที่ Odoo เก็บ แล้วนำเข้าไม่ผ่านทั้งใบ — เคสที่เจอคือ "คุณแนน " ของ บริษัท ฟิลด์ เทส
 * เซอร์วิส จำกัด, "คุณชาตรี " ของ เอซี เมคคาทรอนิค, "คุณกษมา " ของ ทริปเปิ้ลคิวแฟชั่น และ
 * "คุณวรฐ " ของ พลัส เทค
 *
 * ยังคงตัด '-' และค่าที่มีแต่ช่องว่างให้เป็นเซลล์ว่างเหมือนเดิม เพราะนั่นคือ "ไม่มีข้อมูล" ไม่ใช่ชื่อ
 */
function cleanName(value: any): string {
  const s = String(value ?? '');
  const t = s.trim();
  return t === '' || t === '-' ? '' : s;
}

/**
 * วันเวลาตามโซน Asia/Bangkok รูปแบบ 'YYYY-MM-DD HH:mm:ss'
 *
 * updated_at เป็น timestamptz — ถ้าปล่อยให้ toISOString() จะได้เวลา UTC ซึ่งเลื่อนไป 7 ชั่วโมง
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

/**
 * ต่อท้ายชื่อเซลล์ด้วยสังกัดของใบ เช่น "คุณนฤเบศร์" → "คุณนฤเบศร์(PM)"
 *
 * สังกัดดูจากคำนำหน้าเลขที่ใบ (QP=PM, QT=THT) — กติกาเดียวกับที่ pdfGenerator และ
 * enrichQuotationData ใช้ ใบที่ยังไม่มีเลขที่จะไม่เดาสังกัดให้ (ปล่อยชื่อเปล่า)
 */
export function withCompanySuffix(name: string, quotationNo: string): string {
  const no = String(quotationNo ?? '').trim().toUpperCase();
  const suffix = no.startsWith('QT') ? '(THT)' : no.startsWith('QP') ? '(PM)' : '';
  if (!name || !suffix || name.endsWith(suffix)) return name;
  return `${name}${suffix}`;
}

/**
 * แปลงใบเสนอราคาเป็นแถวตาม template — ใบที่ไม่มีรายการสินค้าจะถูกข้าม (นำเข้า Odoo ไม่ได้)
 *
 * ⚠️ อ่านรายการจาก item_details (snapshot ดิบ) ไม่ใช่ items ที่ enrichQuotationData() คืนมา
 *    เพราะ whitelist ที่นั่นตัด internal_reference ทิ้ง ซึ่งเป็นค่าที่ช่อง order_line/product ต้องใช้
 */
export function buildOdooSaleOrderRows(
  quotes: OdooExportQuotationRow[],
  config: OdooExportConfig
): OdooSoRow[] {
  const rows: OdooSoRow[] = [];

  (quotes || []).forEach(quote => {
    const items = Array.isArray(quote.item_details) ? quote.item_details : [];
    if (items.length === 0) return;

    const cust = quote.customer_details || {};
    // snapshot ควรเก็บเฉพาะชื่อบริษัท แต่ข้อมูลเก่าอาจปนเป็น "company | contact" — split แบบเดียวกับ
    // enrichQuotationData() (services/quotationService.ts) เพื่อให้ชื่อที่ส่งออกตรงกับที่หน้าจอโชว์
    const company = cleanName(String(cust.customer_name ?? '').split(' | ')[0]);
    const contact = cleanName(cust.contact_name);
    // ช่อง contact ของ Odoo คือ res.partner ลูก ซึ่ง display name = "บริษัท, ผู้ติดต่อ"
    // ต่อชื่อตาม template เสมอแม้ 2 ชื่อจะซ้ำกัน (ลูกค้าบุคคลจะได้ "ก, ก" — ตั้งใจให้เป็นแบบนั้น)
    // ใบที่ยังไม่มีชื่อผู้ติดต่อใส่แค่ชื่อบริษัท ไม่ต้องมี ", " ห้อยท้าย
    const contactDisplay = company && contact ? `${company}, ${contact}` : (company || contact);
    // ทั้ง Salesperson และ employee_quotation_id มาจาก saleperson ตัวเดียวกันตามชีต "คำอธิบาย"
    // และต้องมีสังกัดห้อยท้ายเพราะเซลล์คนเดียวกันเป็นคนละ user ใน Odoo ของ PM กับ THT
    const quotationNo = clean(quote.quotation_no);
    const salesperson = withCompanySuffix(
      clean(quote.employee_details?.saleperson) || clean(quote.salesperson_name),
      quotationNo
    );

    const header = {
      name: quotationNo,
      partner_id: company,
      contact: contactDisplay,
      partner_invoice_id: company,
      partner_shipping_id: company,
      date_order: formatBangkok(quote.updated_at ?? quote.created_at),
      // ใบที่ไม่มีเครดิตเทอมปล่อยเป็นเซลล์ว่าง ไม่ยัดค่าตั้งต้นให้ — ให้ Odoo ใช้เทอมของลูกค้าเอง
      payment_term_id: clean(cust.payment_terms),
      salesperson,
      sales_team: clean(quote.salesperson_branch),
      employee_quotation_id: salesperson,
      source_id: config.sourceId,
      note: warrantyNoteText(resolveMinWarrantyDisplay(items)),
    };

    items.forEach((item: any, index: number) => {
      const isFirst = index === 0;
      const price = Number(item?.price) || 0;

      rows.push({
        name: isFirst ? header.name : '',
        partner_id: isFirst ? header.partner_id : '',
        contact: isFirst ? header.contact : '',
        partner_invoice_id: isFirst ? header.partner_invoice_id : '',
        partner_shipping_id: isFirst ? header.partner_shipping_id : '',
        date_order: isFirst ? header.date_order : '',
        payment_term_id: isFirst ? header.payment_term_id : '',
        salesperson: isFirst ? header.salesperson : '',
        sales_team: isFirst ? header.sales_team : '',
        employee_quotation_id: isFirst ? header.employee_quotation_id : '',
        source_id: isFirst ? header.source_id : '',
        note: isFirst ? header.note : '',
        product: clean(item?.internal_reference) || clean(item?.model),
        quantity: Number(item?.quantity) || 0,
        uom: config.uom,
        price_unit: price,
        tax_id: config.tax,
        discount: combinedDiscountPercent(price, Number(item?.discount_1) || 0, Number(item?.discount_2) || 0),
      });
    });
  });

  return rows;
}

/** ค่าของแถวเรียงตามลำดับคอลัมน์ A–R */
function toOrderedValues(row: OdooSoRow, format: OdooExportFormat): (string | number | Date | null)[] {
  // xlsx ใช้ null เพื่อให้เซลล์ว่างจริง ส่วน csv ใช้สตริงว่าง
  const blank = format === 'xlsx' ? null : '';
  const text = (v: string) => (v ? v : blank);
  // เวลาใน Excel ไม่มีโซนเวลา — ตีสตริงเวลาไทยเป็น UTC เพื่อให้เซลล์แสดงตรงกับที่คำนวณไว้
  const date = row.date_order ? new Date(`${row.date_order.replace(' ', 'T')}Z`) : null;

  return [
    text(row.name),
    text(row.partner_id),
    text(row.contact),
    text(row.partner_invoice_id),
    text(row.partner_shipping_id),
    row.date_order ? (format === 'xlsx' ? date : row.date_order) : blank,
    text(row.payment_term_id),
    text(row.salesperson),
    text(row.sales_team),
    text(row.employee_quotation_id),
    text(row.source_id),
    text(row.note),
    text(row.product),
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
  // (ชีต "คำอธิบาย" ใน template เป็นคู่มือของคน ไม่เกี่ยวกับการนำเข้า)
  const sheet = workbook.addWorksheet(ODOO_SO_SHEET_NAME);

  sheet.addRow([...ODOO_SO_HEADERS]);
  sheet.getRow(1).font = { bold: true };
  rows.forEach(row => sheet.addRow(toOrderedValues(row, 'xlsx')));

  // คอลัมน์ F (date_order) — ต้องเป็นเซลล์วันที่ ไม่ใช่ตัวเลข serial ดิบ
  sheet.getColumn(6).numFmt = 'yyyy-mm-dd h:mm:ss';
  ODOO_SO_HEADERS.forEach((headerText, i) => {
    sheet.getColumn(i + 1).width = Math.max(14, Math.min(38, headerText.length + 4));
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
