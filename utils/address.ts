/**
 * ประกอบที่อยู่ไทยจากคอลัมน์ invoice_* (customers / sale_orders / customers_data_view)
 *
 * แยกออกมาเป็นตัวกลางเพราะเดิมโค้ดชุดนี้ถูก copy ไว้ 5 ที่ (index.ts x2, customerService,
 * quotationService x3) แล้วต้องได้ที่อยู่ "ข้อความเดียวกันเป๊ะ" ทั้งหน้า LIFF, snapshot ในใบเสนอราคา
 * และ PDF ที่พิมพ์ออกไปให้ลูกค้า
 *
 * กติกาข้อมูล (ดูจากตาราง sale_orders ซึ่งเป็นแหล่งที่กรอกครบที่สุด):
 *   invoice_sub_district = ตำบล/แขวง   invoice_district = อำเภอ/เขต   invoice_state = จังหวัด
 * จึงต้องเรียง ตำบล → อำเภอ → จังหวัด (ของเดิมเรียงอำเภอก่อนตำบล ซึ่งสลับกับที่อยู่ไทย)
 */

/** ที่อยู่ที่มีอักษรไทยเท่านั้นถึงจะเติมคำนำหน้า — ที่อยู่ต่างประเทศปล่อยตามต้นฉบับ */
const THAI_CHAR_RE = /[฀-๿]/;

/** กรุงเทพฯ ใช้ แขวง/เขต และไม่มีคำว่า "จ." นำหน้าชื่อจังหวัด */
const BANGKOK_RE = /กรุงเทพ|bangkok/i;

/** ข้อมูลบางแถวพิมพ์คำนำหน้ามาเองแล้ว (เช่น "ต.ราษฎร์นิยม", "แขวงรามอินทรา") ห้ามเติมซ้ำ */
const HAS_PREFIX_RE = /(^|\s)(ต\.|ตำบล|แขวง|อ\.|อำเภอ|เขต|จ\.|จังหวัด)/;

/** "ปทุมธานี (TH)" → "ปทุมธานี" */
export const cleanState = (s: any) => String(s || '').replace(/\s*\(.*/, '').split(/\s+/)[0].trim();

/**
 * ตัดคำขยะออกจากช่องตำบล/อำเภอ: รหัสไปรษณีย์ซ้ำ, ชื่อประเทศ และชื่อจังหวัดที่ถูกกรอกซ้ำเข้ามา
 *
 * หมายเหตุ: ตัดชื่อจังหวัดเฉพาะคำที่ "ตรงกัน" หรือ "เป็นส่วนหนึ่งของชื่อจังหวัด" เท่านั้น
 * ไม่ตัดคำที่แค่มีชื่อจังหวัดอยู่ข้างใน เพราะนั่นคืออำเภอเมืองของจริง (อ.เมืองชลบุรี, อ.เมืองสมุทรสาคร)
 */
export const cleanAddressField = (fieldVal: any, rawState: any, zip: any): string => {
  if (!fieldVal) return '';
  const cleanZip = String(zip || '').trim();
  const cleanStateVal = String(rawState || '').replace(/\s*\(.*/, '').trim();
  const words = String(fieldVal).split(/[\s,]+/).map((w: string) => w.trim()).filter(Boolean);
  const filtered = words.filter((word: string) => {
    const wordLower = word.toLowerCase();
    if (cleanZip && wordLower === cleanZip.toLowerCase()) return false;
    if (['thailand', 'th', 'china', 'taiwan', 'malaysia', 'singapore', 'israel'].includes(wordLower)) return false;
    if (cleanStateVal) {
      const stateLower = cleanStateVal.toLowerCase();
      if (stateLower.includes(wordLower)) return false;
    }
    return true;
  });
  return filtered.join(' ');
};

/** เติม ต./อ./จ. (หรือ แขวง/เขต ของกรุงเทพฯ) ให้ค่าที่ยังไม่มีคำนำหน้า */
function withPrefix(value: string, prefix: string): string {
  const v = String(value || '').trim();
  if (!v || !prefix) return v;
  if (!THAI_CHAR_RE.test(v)) return v;   // ที่อยู่ภาษาอังกฤษ/ต่างประเทศ
  if (HAS_PREFIX_RE.test(v)) return v;   // ต้นทางใส่คำนำหน้ามาแล้ว
  return prefix + v;
}

export interface AddressParts {
  street: string;
  /** ตำบล/แขวง (ยังไม่เติมคำนำหน้า) */
  subDistrict: string;
  /** อำเภอ/เขต (ยังไม่เติมคำนำหน้า) */
  district: string;
  /** จังหวัด (ยังไม่เติมคำนำหน้า) */
  state: string;
  zip: string;
  /** ที่อยู่บรรทัดเดียวพร้อมคำนำหน้า ต./อ./จ. */
  full: string;
}

/**
 * คืนทั้งส่วนย่อยที่ล้างแล้วและที่อยู่เต็มบรรทัดเดียว
 * รับ row ที่มีคอลัมน์ invoice_street / invoice_sub_district / invoice_district / invoice_state / invoice_zip
 */
export function buildAddressParts(src: any): AddressParts {
  const street = String(src?.invoice_street || '').trim();
  const zip = String(src?.invoice_zip || '').trim();
  const state = cleanState(src?.invoice_state);
  const district = cleanAddressField(src?.invoice_district, src?.invoice_state, src?.invoice_zip);
  const subDistrict = cleanAddressField(src?.invoice_sub_district, src?.invoice_state, src?.invoice_zip);

  const isBangkok = BANGKOK_RE.test(state);
  const full = [
    street,
    withPrefix(subDistrict, isBangkok ? 'แขวง' : 'ต.'),
    withPrefix(district, isBangkok ? 'เขต' : 'อ.'),
    isBangkok ? state : withPrefix(state, 'จ.'),
    zip
  ].map(s => String(s || '').trim()).filter(Boolean).join(' ');

  return { street, subDistrict, district, state, zip, full };
}

/** ที่อยู่บรรทัดเดียวพร้อมคำนำหน้า ต./อ./จ. — ช่องไหนใน DB เป็น null ก็ข้ามไปเฉย ๆ */
export function buildThaiAddress(src: any): string {
  return buildAddressParts(src).full;
}
