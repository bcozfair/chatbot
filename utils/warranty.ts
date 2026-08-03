/**
 * การรับประกันของทั้งใบ = ค่าที่ "สั้นที่สุด" ในบรรดารายการสินค้า
 *
 * แยกออกมาเป็นตัวกลางเพราะมี 2 ที่ที่ต้องได้ตัวเลขเดียวกันเป๊ะ:
 * PDF (หมายเหตุท้ายเอกสาร) และไฟล์นำเข้า Sale Order ของ Odoo (ช่อง note)
 */

/** ค่าที่ใช้เมื่อไม่มี snapshot ให้อ่าน หรือทั้งใบมีแต่บรรทัดค่าขนส่ง */
export const DEFAULT_WARRANTY_DISPLAY = '1 ปี';

/** ข้อความหมายเหตุที่ทั้ง PDF และ Odoo ใช้ร่วมกัน */
export function warrantyNoteText(warrantyDisplay: string): string {
  return `เงื่อนไขการรับประกันสินค้า ${warrantyDisplay || DEFAULT_WARRANTY_DISPLAY}`;
}

/** '18 เดือน' → 18, '3 ปี' → 36 — รูปแบบเดียวกับที่ warrantyDisplayOf() เขียนลง snapshot */
function warrantyMonthsOf(display: string): number {
  const value = parseInt(display) || 1;
  if (display.includes('เดือน')) return value;
  if (display.includes('ปี')) return value * 12;
  return 12;
}

/**
 * warranty_display ที่สั้นที่สุดใน snapshot ของใบ
 *
 * ค่าขนส่งไม่มีการรับประกัน — ถ้าปล่อยผ่าน warranty_display ที่ว่างจะกลายเป็น "1 ปี"
 * แล้วลากการรับประกันของทั้งใบลงมาเหลือ 1 ปี ทั้งที่สินค้าจริงอาจรับประกัน 3 ปี
 */
export function resolveMinWarrantyDisplay(snapshots: any[]): string {
  let minMonths = Infinity;
  let display = DEFAULT_WARRANTY_DISPLAY;

  (Array.isArray(snapshots) ? snapshots : []).forEach((snap: any) => {
    if (snap?.delivery_source === 'shipping_fee') return;

    const text = snap?.warranty_display || DEFAULT_WARRANTY_DISPLAY;
    const months = warrantyMonthsOf(text);
    if (months < minMonths) {
      minMonths = months;
      display = text;
    }
  });

  return minMonths === Infinity ? DEFAULT_WARRANTY_DISPLAY : display;
}
