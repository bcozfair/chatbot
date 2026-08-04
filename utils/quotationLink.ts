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
