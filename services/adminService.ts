import crypto from 'crypto';

// ค่า placeholder ที่ใช้เป็นค่าเริ่มต้นเมื่อยังไม่มีข้อมูลแอดมินจริง
const ADMIN_PLACEHOLDERS = new Set(['ชื่อแอดมิน', 'เบอร์โทร', '-', '']);

/**
 * normalizeAdminName
 * ปรับชื่อแอดมินให้เป็นรูปแบบมาตรฐานเพื่อใช้คำนวณ key ของไฟล์ลายเซ็น
 * - ตัดคำนำหน้า (คุณ/นาย/นาง/นางสาว)
 * - ตัดข้อความในวงเล็บ เช่น (สำนักงานใหญ่)
 * - ตัดช่องว่างทั้งหมด + lowercase
 * เป้าหมาย: แอดมินคนเดียวกัน (สะกดชื่อเหมือนกัน) → ได้ค่าเดียวกันเสมอ
 */
export function normalizeAdminName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/^(คุณ|นางสาว|นาย|นาง|ดร\.)\s*/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .trim();
}

/**
 * cleanAdminName
 * คืนชื่อแอดมินแบบสะอาดสำหรับ "แสดงผล/บันทึก" — ตัดวงเล็บทั้งหมด (เช่น (PM)/(THT)) + ยุบช่องว่าง
 * แต่คงชื่อไทยอ่านง่าย (ไม่ lowercase / ไม่ตัดช่องว่างทั้งหมดเหมือน normalizeAdminName ที่ใช้ทำ hash)
 * เช่น "ณัฐติยา  พันธ์เพ็ง(PM)" → "ณัฐติยา พันธ์เพ็ง"
 */
export function cleanAdminName(name: string | null | undefined): string {
  if (!name) return '';
  return name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * computeAdminKey
 * คืน key แบบ filesystem-safe (hex 12 ตัว) สำหรับตั้งชื่อไฟล์ลายเซ็นแอดมิน
 * อิงจาก "ชื่อแอดมินอย่างเดียว" (ไม่รวมเบอร์) → คนเดียวกัน = ไฟล์เดียวกัน
 * คืน null ถ้าชื่อว่างหรือเป็นค่า placeholder (จะได้ไม่ต้องไปหาไฟล์)
 */
export function computeAdminKey(name: string | null | undefined): string | null {
  if (!name || ADMIN_PLACEHOLDERS.has(name.trim())) return null;
  const normalized = normalizeAdminName(name);
  if (!normalized) return null;
  return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 12);
}
