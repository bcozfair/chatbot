/**
 * "กำหนดส่ง" ของทั้งใบ — ประเภทการจัดส่ง + จำนวนวัน
 *
 * เป็นจุดเดียวในระบบที่รู้ว่าประเภทการส่งมีอะไรบ้าง เขียนออกมาหน้าตายังไง และเลือกยังไง
 * ทุกที่ที่แสดง/ส่งออกกำหนดส่งต้องเรียกโมดูลนี้: pdfGenerator (เอกสาร), utils/flexTemplates
 * (สรุปในแชท), services/odooSaleOrderExport (ไฟล์นำเข้า Odoo), liff_pages/quote-edit (หน้าแก้ใบ)
 *
 * ⚠️ ไม่คำนวณ "จำนวนวันอัตโนมัติ" เอง — เจ้าของเรื่องนั้นคือ resolveQuotationDeliveryDays()
 *    ใน services/quotationService.ts โมดูลนี้รับผลลัพธ์มาแล้วเลือกว่าจะใช้ค่าไหนกับคำไหน
 *
 * ไฟล์นี้ต้องเป็น pure function ล้วน (ห้าม import db/express) เพราะทั้ง pdfGenerator และ
 * odooSaleOrderExport ที่ตั้งใจไม่ผูกกับ DB ต้องเรียกได้
 */

export type DeliveryTypeKey = 'in_stock' | 'make_to_order' | 'import' | 'install';

/** ที่มาของค่าที่ resolve ได้ — ไว้ตรวจย้อนหลังว่าใบนี้เซลล์ตั้งเองหรือระบบคิดให้ */
export type DeliveryValueSource = 'auto' | 'override' | 'frozen';

export interface DeliveryTypeDef {
  key: DeliveryTypeKey;
  /**
   * คำที่ใช้จริงทุกที่ — ตรงกับตัวเลือกใน dropdown ของ Odoo ทุกอักขระ
   *
   * ⚠️ ห้ามแปลไทยหรือแต่งคำใหม่ที่ไหนทั้งสิ้น เซลล์ต้องเห็นคำชุดเดียวกันตั้งแต่หน้าแก้ใบ
   *    ยันเอกสารที่ลูกค้าได้รับ ยันช่องใน Odoo ไม่งั้นจะเทียบกันไม่ออกว่าอันไหนคืออันไหน
   */
  label: string;
  /**
   * ระบบเลือกประเภทนี้ให้เองได้เมื่อสต๊อกเป็นแบบไหน — null = เลือกให้อัตโนมัติไม่ได้
   * (เซลล์ต้องกดเลือกเองเท่านั้น เพราะระบบไม่มีทางรู้ว่าใบนี้ต้องนำเข้าหรือมีงานติดตั้ง)
   */
  auto: 'in_stock' | 'out_of_stock' | null;
}

/**
 * ตารางเดียวของทั้งระบบ — เพิ่มประเภทใหม่ = เพิ่ม 1 แถวที่นี่
 * (แล้วขยาย CHECK constraint quotations_delivery_type_override_check ให้รับคีย์ใหม่ด้วย)
 */
export const DELIVERY_TYPES: readonly DeliveryTypeDef[] = [
  { key: 'in_stock',      label: 'In_stock.,With in',      auto: 'in_stock' },
  { key: 'make_to_order', label: 'Make to order.,With in', auto: 'out_of_stock' },
  { key: 'import',        label: 'Import.,With in',        auto: null },
  { key: 'install',       label: 'Install.,With in',       auto: null },
];

/** ค่าตั้งต้นเมื่ออ่านจำนวนวันจากใบไม่ได้เลย — ตรงกับ DELIVERY_DAYS_FALLBACK_* ใน quotationService */
const DAYS_FALLBACK_IN_STOCK = 3;
const DAYS_FALLBACK_OUT_OF_STOCK = 7;

export interface DeliveryTerms {
  type: DeliveryTypeKey;
  days: number;
  /** สต๊อกครบทุกรายการหรือไม่ ณ ตอนที่ค่านี้ถูกคิด — ใช้เลือกสี badge ในแชท/หน้าแก้ใบ */
  all_in_stock: boolean;
  type_source: DeliveryValueSource;
  days_source: DeliveryValueSource;
}

function isValueSource(value: any): value is DeliveryValueSource {
  return value === 'auto' || value === 'override' || value === 'frozen';
}

/** true เมื่อ key เป็นประเภทที่รู้จัก */
export function isDeliveryTypeKey(value: any): value is DeliveryTypeKey {
  return DELIVERY_TYPES.some(t => t.key === value);
}

/** ประเภทที่ระบบเลือกให้เองจากสถานะสต๊อก */
function autoTypeOf(allInStock: boolean): DeliveryTypeKey {
  const want = allInStock ? 'in_stock' : 'out_of_stock';
  return (DELIVERY_TYPES.find(t => t.auto === want) || DELIVERY_TYPES[0]).key;
}

/** ตัวเลขที่ใช้ได้จริง (จำนวนเต็ม ≥ 0) — คืน null เมื่อค่าที่ส่งมาไม่ใช่ตัวเลข */
function toDays(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * กำหนดส่งของใบหนึ่งใบ ตามลำดับความสำคัญ:
 *   1. delivery_terms  — ค่าที่ตรึงไว้ตอนยืนยันใบ (ใบที่มีเลขที่แล้วต้องได้ค่านี้เสมอ)
 *   2. delivery_type_override / delivery_days_override — ค่าที่เซลล์ตั้งเอง
 *   3. delivery_all_in_stock / delivery_days_auto — ค่าที่ระบบคำนวณจากกฎ + สต๊อก
 *   4. 3/7 วันตามสถานะสต๊อก — ใบเก่าที่ไม่มี snapshot ให้อ่าน
 *
 * ใบที่ไม่มีค่าใหม่สักตัว (ใบเก่าทั้งหมด) จะตกลงมาที่ข้อ 3/4 ซึ่งคือพฤติกรรมเดิมทุกประการ
 */
export function resolveDeliveryTerms(quote: any): DeliveryTerms {
  const frozen = quote?.delivery_terms;
  if (frozen && typeof frozen === 'object' && isDeliveryTypeKey(frozen.type)) {
    const frozenDays = toDays(frozen.days);
    if (frozenDays !== null) {
      // คืน *_source ที่ตรึงมาด้วย ไม่ใช่ 'frozen' ทับ — ฝั่งแสดงผลใช้ค่านี้ตัดสินว่าจะบอก
      // "(ตั้งค่าเอง)" ไหม ถ้าทับทิ้งไป ป้ายนั้นจะหายไปทันทีที่ใบถูกยืนยัน
      return {
        type: frozen.type,
        days: frozenDays,
        all_in_stock: frozen.all_in_stock !== false,
        type_source: isValueSource(frozen.type_source) ? frozen.type_source : 'frozen',
        days_source: isValueSource(frozen.days_source) ? frozen.days_source : 'frozen',
      };
    }
  }

  const allInStock = quote?.delivery_all_in_stock !== false;
  const autoDays = toDays(quote?.delivery_days_auto);
  const overrideDays = toDays(quote?.delivery_days_override);
  const overrideType = isDeliveryTypeKey(quote?.delivery_type_override)
    ? (quote.delivery_type_override as DeliveryTypeKey)
    : null;

  const fallbackDays = allInStock ? DAYS_FALLBACK_IN_STOCK : DAYS_FALLBACK_OUT_OF_STOCK;

  return {
    type: overrideType ?? autoTypeOf(allInStock),
    days: overrideDays ?? autoDays ?? fallbackDays,
    all_in_stock: allInStock,
    type_source: overrideType ? 'override' : 'auto',
    days_source: overrideDays !== null ? 'override' : 'auto',
  };
}

/** คำของประเภทนั้น ๆ — ประเภทที่ไม่รู้จักตกกลับเป็นตัวแรกในตาราง */
export function deliveryTypeLabel(type: DeliveryTypeKey): string {
  return (DELIVERY_TYPES.find(t => t.key === type) || DELIVERY_TYPES[0]).label;
}

/**
 * ข้อความกำหนดส่งที่ใช้ร่วมกันทุกที่ที่คนอ่าน — PDF, สรุปในแชท (Flex) และหน้าแก้ใบ
 *
 * ⚠️ เว้นวรรค 2 ตัวคร่อมตัวเลขเป็นรูปแบบเดิมของเอกสารที่ใช้กันมา ห้ามบีบให้เหลือช่องเดียว
 */
export function deliveryDisplayText(terms: DeliveryTerms): string {
  return `${deliveryTypeLabel(terms.type)}  ${terms.days}  Days`;
}

/** คอลัมน์ delivery_name ของไฟล์นำเข้า Odoo — ค่าเดียวกับตัวเลือกใน dropdown ฝั่งนั้น */
export function deliveryOdooName(terms: DeliveryTerms): string {
  return deliveryTypeLabel(terms.type);
}

/** คอลัมน์ delivery_time ของไฟล์นำเข้า Odoo — ต้องเป็นตัวเลขล้วน ไม่ใช่ข้อความ */
export function deliveryOdooTime(terms: DeliveryTerms): number {
  return terms.days;
}

/**
 * ค่า delivery_type_override ที่รับมาจาก client
 *   undefined = ไม่ได้ส่งมา → คงค่าเดิมในฐานข้อมูล
 *   null      = สั่งกลับไปใช้ค่าอัตโนมัติ
 * โยน Error เมื่อส่งค่าที่ไม่รู้จักมา (กติกาเดียวกับ parseDeliveryDaysOverride)
 */
export function parseDeliveryTypeOverride(raw: any): DeliveryTypeKey | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (isDeliveryTypeKey(raw)) return raw;
  throw new Error('ประเภทการจัดส่งไม่ถูกต้อง');
}
