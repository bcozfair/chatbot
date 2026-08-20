/**
 * ลิงก์ดาวน์โหลด PDF ใบเสนอราคา
 *
 * รูปแบบ: /download-pdf/{uuid}/{quotation_no}
 *
 * UUID คือกุญแจจริงที่ใช้ค้นข้อมูล — เลขใบเสนอราคาต่อท้ายเป็นแค่ป้ายให้คนอ่านรู้ว่าใบไหน
 * (เดาเลขอย่างเดียวเปิดไม่ได้) ใบร่างที่ยังไม่ยืนยันจะไม่มีเลข จึงได้ลิงก์แบบ UUID เปล่า
 * ซึ่งเป็นรูปแบบเดิมและยังใช้งานได้ตลอด — ลิงก์เก่าที่ส่งไปในแชท LINE แล้วจึงไม่พัง
 */

/** path ของลิงก์ดาวน์โหลด (ไม่มี origin / query) — ใช้เป็น canonical เวลา redirect ด้วย */
export function buildPdfPath(quoteId: string, quotationNo?: string | null): string {
  const no = (quotationNo || '').trim();
  return no
    ? `/download-pdf/${quoteId}/${encodeURIComponent(no)}`
    : `/download-pdf/${quoteId}`;
}

/** ลิงก์เต็มสำหรับส่งใน LINE — openExternalBrowser=1 บังคับให้เปิดนอก in-app browser */
export function buildPdfLink(baseUrl: string, quoteId: string, quotationNo?: string | null): string {
  return `${baseUrl}${buildPdfPath(quoteId, quotationNo)}?openExternalBrowser=1`;
}

/**
 * รูปแบบเลขที่ใบเสนอราคาที่ระบบออกให้ — ต้องตรงกับ allocateQuotationNo ใน quotationService
 *
 *   QP-260805512      ใบปกติ
 *   QP-260805512-01   ฉบับแก้ไข (revision) — ท้ายเป็น "-01" ไม่ใช่ "-R01"
 *
 * ⚠️ เคยเขียนผิดเป็น (?:-R[0-9]+)? ทำให้ใบ revision ทุกใบขอ PDF ทางแชทไม่ได้ (พบ 2026-08-20)
 *    ถ้ารูปแบบเลขที่เปลี่ยน ให้แก้ที่ค่าคงที่ตัวเดียวข้างล่างนี้ที่เดียว
 */
const QUOTATION_NO_SRC = '(?:QT|QP)-[0-9]+(?:-[0-9]+)?';

/** ทั้งข้อความต้องเป็นเลขที่ใบล้วน ๆ (คั่นด้วยเว้นวรรค/จุลภาคได้) ถึงจะนับว่าเป็นคำขอ PDF */
const ONLY_QUOTATION_NOS_RE = new RegExp(`^\\s*(?:${QUOTATION_NO_SRC}[\\s,]*)+$`, 'i');
const QUOTATION_NO_RE = new RegExp(QUOTATION_NO_SRC, 'gi');

/**
 * แกะเลขที่ใบเสนอราคาจากข้อความที่เซลล์พิมพ์มา — คืน null ถ้าไม่ใช่คำขอ PDF
 *
 * ด่านและตัวจับใช้ค่าคงที่ตัวเดียวกัน จึงเป็นไปไม่ได้ที่ด่านจะผ่านแล้วตัวจับได้เลขที่สั้นกว่าเดิม
 * (ถ้าแยกกันเขียนแล้วสองสูตรไม่ตรงกัน จะเกิดเคส "ตัด -01 ทิ้ง → ส่ง PDF ผิดใบให้ลูกค้า")
 */
export function parseQuotationNosFromText(text: string | null | undefined): string[] | null {
  const trimmed = (text || '').trim();
  if (!trimmed || !ONLY_QUOTATION_NOS_RE.test(trimmed)) return null;
  const found = trimmed.toUpperCase().match(QUOTATION_NO_RE);
  return found && found.length ? found : null;
}
