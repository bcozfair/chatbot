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

/**
 * บริษัทเจ้าของใบ — ดูจากคำนำหน้าเลขที่ใบ (QP = PM, QT = THT)
 *
 * 1 ไฟล์ = 1 บริษัทเสมอ เพราะ Odoo ของ PM กับ THT เป็นคนละระบบ และชื่อภาษีคนละค่ากัน
 */
export type OdooExportCompany = 'QP' | 'QT';

export interface OdooExportConfig {
  /**
   * Q: order_line/tax_id — ค่าเดียวกันทุกแถวในไฟล์ แต่คนละค่าระหว่าง QP กับ QT
   *
   * ⚠️ สองค่านี้ต่างกันแค่ "เว้นวรรคหน้าวงเล็บ" และมันต่างกันจริงตามที่ Odoo แต่ละระบบตั้งชื่อไว้
   *    ห้ามแก้ให้เหมือนกันเพราะเห็นว่าน่าจะพิมพ์ตก — Odoo จับคู่ภาษีด้วยชื่อแบบตรงตัวทุกอักขระ
   */
  taxByCompany: Record<OdooExportCompany, string>;
  /** K: source_id — template กำหนดให้ใส่ "Sales" เสมอ */
  sourceId: string;
  /** O: order_line/product_uom — template กำหนดให้เป็น Pcs ทุกแถว ไม่ดูหน่วยจริงของสินค้า */
  uom: string;
}

/** แถวใบเสนอราคาที่ endpoint/diag ส่งเข้ามา (มาจาก quotations LEFT JOIN salesperson) */
export interface OdooExportQuotationRow {
  /** quotations.id — ไม่ได้ลงในไฟล์ แต่ endpoint ใช้มาร์ก odoo_exported_at ของใบที่อยู่ในไฟล์จริง */
  id?: string;
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
  /**
   * J: employee_quotation_id — ชื่อจริงของเซลล์ฝั่ง Odoo (salesperson.employee_quotation_id)
   * อ่านจากตาราง salesperson สด ๆ อย่างเดียว ไม่มี fallback ไป snapshot — ใบของพนักงานที่ถูกลบ
   * (user_id = NULL) จึงได้เซลล์ว่าง เหมือนช่อง I ที่อ่านทีมขายจาก customers_data_view สด ๆ
   */
  salesperson_employee_quotation_id?: string | null;
  /**
   * I: Sales Team — customers_data_view.sales_team ของผู้ติดต่อบนใบ (join ด้วย contact_id)
   * ไม่ใช่สังกัดของเซลล์ (salesperson.branch) เพราะทีมขายเป็นคุณสมบัติของลูกค้า
   */
  customer_sales_team?: string | null;
  /**
   * B/D/E: ชื่อบริษัทดิบจากตารางหลัก (customers/sale_orders ผ่าน ODOO_EXPORT_RAW_NAME_JOINS)
   *
   * snapshot ได้ชื่อมาจาก customers_data_view ที่ btrim() ช่องว่างท้ายทิ้งไปแล้ว ค่านี้จึงเป็นชื่อ
   * ตัวเดียวกันแบบครบทุกอักขระ — NULL เมื่อหาไม่เจอหรือชื่อไม่ตรง (แปลว่าให้ใช้ snapshot ตามเดิม)
   */
  raw_customer_name?: string | null;
  /** C: ชื่อผู้ติดต่อดิบจากตารางหลัก — กติกาเดียวกับ raw_customer_name */
  raw_contact_name?: string | null;
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
  /** J: ชื่อจริงของเซลล์ฝั่ง Odoo พร้อมสังกัดห้อยท้ายเหมือนช่อง H — ว่างถ้ายังไม่กรอกในหน้าแอดมิน */
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
    taxByCompany: {
      QP: process.env.ODOO_EXPORT_TAX_QP || 'Output VAT 7% (Exc)',
      // ไม่มีเว้นวรรคหน้าวงเล็บ — ตั้งใจ ดูคำเตือนที่ OdooExportConfig.taxByCompany
      QT: process.env.ODOO_EXPORT_TAX_QT || 'Output VAT 7%(Exc)',
    },
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
 * บริษัทเจ้าของใบจากคำนำหน้าเลขที่ใบ — คืน null เมื่อเดาไม่ได้ (ใบร่างที่ยังไม่มีเลข หรือเลขรูปแบบอื่น)
 *
 * เป็นจุดเดียวในโมดูลนี้ที่รู้ว่าคำนำหน้าไหนคือบริษัทไหน — ทั้งสังกัดห้อยท้ายชื่อเซลล์ (H/J),
 * การคัดใบเข้าไฟล์ และการเลือกชื่อภาษี ใช้ตัวนี้ตัวเดียวกันหมด
 */
export function resolveExportCompany(quotationNo: any): OdooExportCompany | null {
  const no = String(quotationNo ?? '').trim().toUpperCase();
  if (no.startsWith('QT')) return 'QT';
  if (no.startsWith('QP')) return 'QP';
  return null;
}

/** แปลง query param เป็นบริษัทที่ใช้ได้จริง — คืน null เมื่อไม่ได้ส่งมาหรือค่าไม่รู้จัก */
export function parseExportCompany(raw: any): OdooExportCompany | null {
  const v = String(raw ?? '').trim().toUpperCase();
  return v === 'QP' || v === 'QT' ? v : null;
}

/** สังกัดที่ห้อยท้ายชื่อเซลล์ในช่อง H/J ของไฟล์ */
const COMPANY_SUFFIX: Record<OdooExportCompany, string> = { QP: '(PM)', QT: '(THT)' };

/**
 * ต่อท้ายชื่อเซลล์ด้วยสังกัดของใบ เช่น "คุณนฤเบศร์" → "คุณนฤเบศร์(PM)"
 *
 * สังกัดดูจากคำนำหน้าเลขที่ใบ (QP=PM, QT=THT) — กติกาเดียวกับที่ pdfGenerator และ
 * enrichQuotationData ใช้ ใบที่ยังไม่มีเลขที่จะไม่เดาสังกัดให้ (ปล่อยชื่อเปล่า)
 */
export function withCompanySuffix(name: string, quotationNo: string): string {
  const company = resolveExportCompany(quotationNo);
  const suffix = company ? COMPANY_SUFFIX[company] : '';
  if (!name || !suffix || name.endsWith(suffix)) return name;
  return `${name}${suffix}`;
}

/**
 * คัดเฉพาะใบที่จะปรากฏในไฟล์จริง — ข้ามใบที่ไม่มีรายการสินค้า (นำเข้า Odoo ไม่ได้)
 * และใบที่ไม่ใช่บริษัทที่กำลังส่งออก (รวมถึงใบที่เดาบริษัทจากเลขที่ใบไม่ได้)
 *
 * แยกออกมาเป็นฟังก์ชันของตัวเองเพราะ endpoint ต้องใช้กติกาเดียวกันนี้ตอน "ทำเครื่องหมายว่าส่งออกแล้ว"
 * ถ้ามาร์กใบที่ไม่ได้อยู่ในไฟล์ไปด้วย ใบนั้นจะหายจาก export ตลอดกาลทั้งที่ไม่เคยอยู่ในไฟล์เลยสักครั้ง
 *
 * ⚠️ ตัวกรองบริษัทต้องอยู่ที่นี่เท่านั้น ห้ามย้ายไปเป็นเงื่อนไข WHERE ใน SQL ของ endpoint —
 *    ฟังก์ชันนี้คือตัวตัดสินร่วมของ "ใบที่ลงไฟล์" กับ "ใบที่ถูกมาร์ก" ถ้ากติกาอยู่คนละที่
 *    วันหลังแก้ที่เดียวจะได้ไฟล์กับเครื่องหมายที่ไม่ตรงกันทันที
 */
export function selectExportableQuotes<T extends OdooExportQuotationRow>(
  quotes: T[], company: OdooExportCompany
): T[] {
  return (quotes || []).filter(q =>
    Array.isArray(q.item_details) && q.item_details.length > 0 &&
    resolveExportCompany(q.quotation_no) === company);
}

/**
 * แปลงใบเสนอราคาเป็นแถวตาม template ของบริษัทที่เลือก — ใบที่ selectExportableQuotes() คัดออก
 * (ไม่มีรายการสินค้า หรือคนละบริษัท) จะไม่อยู่ในผลลัพธ์
 *
 * ⚠️ อ่านรายการจาก item_details (snapshot ดิบ) ไม่ใช่ items ที่ enrichQuotationData() คืนมา
 *    เพราะ whitelist ที่นั่นตัด internal_reference ทิ้ง ซึ่งเป็นค่าที่ช่อง order_line/product ต้องใช้
 */
export function buildOdooSaleOrderRows(
  quotes: OdooExportQuotationRow[],
  config: OdooExportConfig,
  company: OdooExportCompany
): OdooSoRow[] {
  const rows: OdooSoRow[] = [];
  // ทุกใบในไฟล์เป็นบริษัทเดียวกันแล้ว (selectExportableQuotes กรองไว้) ชื่อภาษีจึงคงที่ทั้งไฟล์
  const tax = config.taxByCompany[company];

  selectExportableQuotes(quotes || [], company).forEach(quote => {
    const items = quote.item_details as any[];

    const cust = quote.customer_details || {};
    // snapshot ควรเก็บเฉพาะชื่อบริษัท แต่ข้อมูลเก่าอาจปนเป็น "company | contact" — split แบบเดียวกับ
    // enrichQuotationData() (services/quotationService.ts) เพื่อให้ชื่อที่ส่งออกตรงกับที่หน้าจอโชว์
    //
    // ชื่อดิบจากตารางหลักมาก่อน snapshot เสมอ เพราะ snapshot โดน customers_data_view btrim() ช่องว่างท้าย
    // ทิ้งไปแล้ว (ดู ODOO_EXPORT_RAW_NAME_JOINS) — ค่า raw_* เป็น NULL เมื่อชื่อไม่ตรงกัน จึงตกกลับมาใช้
    // snapshot เองโดยอัตโนมัติ ?? ไม่ใช่ || เพราะชื่อว่าง '' ที่ผ่านเงื่อนไขมาแล้วก็ยังเป็นคำตอบที่ถูก
    const company = cleanName(
      quote.raw_customer_name ?? String(cust.customer_name ?? '').split(' | ')[0]
    );
    const contact = cleanName(quote.raw_contact_name ?? cust.contact_name);
    // ช่อง contact ของ Odoo คือ res.partner ลูก ซึ่ง display name = "บริษัท, ผู้ติดต่อ"
    // ต่อชื่อตาม template เสมอแม้ 2 ชื่อจะซ้ำกัน (ลูกค้าบุคคลจะได้ "ก, ก" — ตั้งใจให้เป็นแบบนั้น)
    // ใบที่ยังไม่มีชื่อผู้ติดต่อใส่แค่ชื่อบริษัท ไม่ต้องมี ", " ห้อยท้าย
    const contactDisplay = company && contact ? `${company}, ${contact}` : (company || contact);
    // ช่อง Salesperson ต้องมีสังกัดห้อยท้าย เพราะเซลล์คนเดียวกันเป็นคนละ user ใน Odoo ของ PM กับ THT
    const quotationNo = clean(quote.quotation_no);
    const salesperson = withCompanySuffix(
      clean(quote.employee_details?.saleperson) || clean(quote.salesperson_name),
      quotationNo
    );
    // J: ชื่อจริงของเซลล์ที่แอดมินกรอกไว้ในตาราง salesperson — ห้อยสังกัดด้วยกติกาเดียวกับช่อง H
    // ยังไม่กรอก = เซลล์ว่าง ไม่ถอยไปใช้ชื่อจากช่อง H เพราะสองช่องนี้เป็นคนละความหมาย
    const employeeQuotationId = withCompanySuffix(
      clean(quote.salesperson_employee_quotation_id),
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
      // I: ทีมขายของผู้ติดต่อ (มาจาก customers_data_view ผ่าน contact_id) — ผู้ติดต่อที่ยังไม่มีทีมขาย
      // ในฐานข้อมูล หรือใบที่ยังไม่ผูก contact_id ปล่อยเป็นเซลล์ว่าง ไม่ถอยไปใช้สังกัดของเซลล์
      sales_team: clean(quote.customer_sales_team),
      employee_quotation_id: employeeQuotationId,
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
        // J: เป็นช่องหัวใบเหมือน A–L ที่เหลือ — แถวที่ 2 ขึ้นไปของใบเดียวกันต้องเว้นว่างตามกติกา one2many
        employee_quotation_id: isFirst ? header.employee_quotation_id : '',
        source_id: isFirst ? header.source_id : '',
        note: isFirst ? header.note : '',
        product: clean(item?.internal_reference) || clean(item?.model),
        quantity: Number(item?.quantity) || 0,
        uom: config.uom,
        price_unit: price,
        tax_id: tax,
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
