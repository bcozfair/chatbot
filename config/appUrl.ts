import dotenv from 'dotenv';

dotenv.config();

/**
 * โดเมนสาธารณะของระบบ — ฐานของลิงก์ PDF ที่บอทส่งเข้าแชท LINE
 *
 * ทำไมต้องมีไฟล์นี้ (เหตุการณ์จริง 2026-08-20):
 *   เดิม APP_URL ไม่ได้ตั้งใน .env แล้วโค้ดมีทางสำรอง "เดาจาก Host header ของ request แรก
 *   ที่วิ่งเข้ามาหลัง container เกิดใหม่" แล้วเขียนค่าที่เดาได้ทับ process.env ค้างไว้
 *   วันนั้น request แรกบังเอิญเป็น curl ตรวจสุขภาพจากในเครื่อง ค่าจึงถูกล็อกเป็น
 *   http://127.0.0.1:3011 → ใบเสนอราคา 4 ใบส่งลิงก์ที่มือถือลูกค้าเปิดไม่ได้ออกไป
 *   โดยฝั่ง server ไม่มี error ให้เห็นแม้แต่บรรทัดเดียว
 *
 * บทเรียน: ค่าที่ "ผิดแล้วเงียบ" ต้องไม่มีทางสำรอง — ให้ล้มตั้งแต่ boot ดีกว่าส่งของผิดให้ลูกค้า
 * จึงไม่มี fallback ในไฟล์นี้ทุกกรณี (แนวเดียวกับ getJwtSecret ใน config/jwt.ts)
 */

/** โฮสต์ที่ยอมให้ใช้ http:// ได้ — เครื่องนักพัฒนาเท่านั้น ของจริงต้อง https:// เสมอ */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const HINT = 'ตัวอย่าง: APP_URL=https://salechatbot.primus-iot.com (ไม่ต้องมี / ปิดท้าย)';

/**
 * ตรวจและทำให้ค่าเป็นรูปแบบมาตรฐาน — โยน Error พร้อมบอกวิธีแก้ ถ้าใช้ไม่ได้
 *
 * แยกเป็นฟังก์ชัน pure ไม่อ่าน env เอง เพื่อให้ diag ทดสอบได้ทุกเคสโดยไม่ต้องตั้ง env จริง
 * (แนวเดียวกับ parseRetentionDays / shouldRunNow)
 *
 * คืนค่าเป็น origin ล้วน ๆ ซึ่งตัด / ปิดท้ายให้เองด้วย — กัน `https://x//download-pdf/...`
 */
export function normalizeAppUrl(raw: string | undefined | null): string {
  const value = (raw ?? '').trim();
  if (!value) {
    throw new Error(`[APP_URL] ไม่ได้ตั้งค่า APP_URL — เซิร์ฟเวอร์เริ่มทำงานไม่ได้ · ${HINT}`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[APP_URL] ค่า "${value}" ไม่ใช่ URL ที่ถูกต้อง · ${HINT}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`[APP_URL] ค่า "${value}" ต้องขึ้นต้นด้วย https:// · ${HINT}`);
  }

  // มี path/query/hash แปลว่าคนตั้งเข้าใจผิดว่าต้องใส่ทั้งลิงก์ — ปล่อยผ่านจะได้ลิงก์เพี้ยนทุกใบ
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`[APP_URL] ค่า "${value}" ต้องเป็นแค่โดเมน ห้ามมี path หรือ query · ${HINT}`);
  }

  // http:// กับโดเมนจริงคือเคส "เกือบถูก" ที่อันตรายที่สุด — ลิงก์กดได้แต่ไม่เข้ารหัส
  // และ LINE บางเวอร์ชันไม่เปิด http ให้ · ยอมเฉพาะเครื่อง dev
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `[APP_URL] ค่า "${value}" ใช้ http:// กับโดเมนจริง ซึ่งไม่ปลอดภัยและ LINE อาจไม่เปิดให้ · ${HINT}`
    );
  }

  return url.origin;
}

let _appUrl: string | null = null;

/**
 * โดเมนสาธารณะที่ตรวจแล้ว — ใช้ตัวนี้ทุกที่ที่ต้องประกอบลิงก์ส่งออกนอกระบบ
 *
 * ⚠️ ห้ามกลับไปอ่าน process.env.APP_URL ตรง ๆ และห้ามใส่ค่าสำรอง (|| '...') ที่จุดเรียกเด็ดขาด
 *    ค่าสำรองคือสิ่งที่ทำให้เหตุการณ์ 2026-08-20 พังเงียบ
 */
export function getAppUrl(): string {
  if (_appUrl) return _appUrl;
  _appUrl = normalizeAppUrl(process.env.APP_URL);
  return _appUrl;
}
