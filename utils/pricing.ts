// ─────────────────────────────────────────────────────────────────────────────
//  สูตรคำนวณราคาที่ใช้ร่วมกันทั้งระบบ — เดิมสูตรเดียวกันนี้ถูก inline ไว้ 9 จุด
//
//  ⚠️ liff_pages/quote-edit.html มีสูตรชุดเดียวกันเขียนซ้ำไว้ (vanilla JS ไม่มี bundler
//     ตาม AGENTS.md) เป็น duplication จุดเดียวที่ยอมรับโดยตั้งใจ — แก้ที่นี่ต้องไปแก้ที่นั่นด้วยมือ
// ─────────────────────────────────────────────────────────────────────────────

export const VAT_RATE = 0.07;

/** ปัดเป็นทศนิยม 2 ตำแหน่ง */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * ราคาต่อหน่วยหลังหักส่วนลด 2 ขั้น
 *
 * ⚠️ ตั้งใจไม่ปัดเศษ — มีผู้เรียกเพียงจุดเดียว (lineHandler: ส่วนลดแบบ net ที่เขียนทับ unit price)
 * ที่ต้องการค่าปัดแล้ว จุดนั้นเรียก round2() ครอบเอง ถ้าย้ายการปัดเข้ามาในนี้
 * ยอดรวมของทุกใบจะเลื่อนระดับสตางค์
 */
export function calcNetPrice(price: number, disc1: number, disc2: number): number {
  const p = Number(price) || 0;
  const d1 = Number(disc1) || 0;
  const d2 = Number(disc2) || 0;
  return p * (1 - d1 / 100) * (1 - d2 / 100);
}

/** ยอดรวมของรายการเดียว = จำนวน × ราคาสุทธิต่อหน่วย (รองรับทั้ง quantity และ qty) */
export function calcLineTotal(item: any): number {
  const qty = Number(item?.quantity ?? item?.qty) || 0;
  return qty * calcNetPrice(item?.price, item?.discount_1, item?.discount_2);
}

/** ยอดรวมสินค้าทั้งใบ (ก่อน VAT) */
export function sumLineTotals(items: any[]): number {
  return (items || []).reduce((sum, item) => sum + calcLineTotal(item), 0);
}

/** VAT 7% จากฐานก่อน VAT (ปัด 2 ตำแหน่ง) */
export function calcVat(baseBeforeVat: number): number {
  return round2(baseBeforeVat * VAT_RATE);
}

/** ยอดสุทธิรวม VAT (ปัด 2 ตำแหน่ง) */
export function calcGrandTotal(baseBeforeVat: number): number {
  return round2(baseBeforeVat + calcVat(baseBeforeVat));
}
