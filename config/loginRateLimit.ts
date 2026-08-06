import { Request } from 'express';

/**
 * จำกัดจำนวนครั้งที่กรอกรหัสผ่านผิดของหน้า /api/admin/login
 *
 * เก็บตัวนับไว้ใน memory ของ process ไม่ใช่ใน DB — แอปรันกล่องเดียวและตัวนับนี้ไม่ใช่ข้อมูลที่เสียไม่ได้
 * ผลข้างเคียงที่ยอมรับ: restart แอปแล้วตัวนับรีเซ็ตหมด ซึ่งไม่ช่วยคนเดารหัสเท่าไหร่
 * เพราะ deploy ไม่ได้เกิดบ่อยพอจะใช้เป็นช่องทางล้างตัวนับได้จริง
 */

const WINDOW_MS = 15 * 60 * 1000;   // ช่วงเวลาที่นับย้อนหลัง
const MAX_FAILURES = 8;             // ผิดเกินจำนวนนี้ในหนึ่งช่วง = ถูกกั้น
const MAX_ENTRIES = 10_000;         // เพดานกันตารางโตไม่จำกัด

interface AttemptRecord {
  failures: number;
  /** เวลาที่ record นี้หมดอายุ — ขยับออกไปทุกครั้งที่กรอกผิดเพิ่ม */
  expiresAt: number;
}

const attempts = new Map<string, AttemptRecord>();

/**
 * หา IP จริงของผู้ใช้
 *
 * เส้นทางจริงของ request คือ ผู้ใช้ → Cloudflare edge → cloudflared (คอนเทนเนอร์ cf-tunnel) → แอป
 * Cloudflare เขียน CF-Connecting-IP ให้ที่ edge เสมอ และ "ทับ" ค่าที่ผู้ใช้ส่งมาเอง จึงปลอมจากภายนอกไม่ได้
 * ส่วน req.socket.remoteAddress จะเป็น IP ของ cloudflared ทุก request จึงใช้แยกคนไม่ได้ — เก็บไว้เป็นทางสุดท้าย
 */
export function getClientIp(req: Request): string {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

  // XFF เป็นรายการต่อกันด้วยจุลภาค ตัวแรกสุดคือ client เดิม
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof forwardedValue === 'string' && forwardedValue.trim()) {
    const first = forwardedValue.split(',')[0]?.trim();
    if (first) return first;
  }

  return req.socket.remoteAddress || 'unknown';
}

/**
 * คีย์ของตัวนับ = IP + ชื่อผู้ใช้ ไม่ใช่ IP อย่างเดียว และไม่ใช่ชื่อผู้ใช้อย่างเดียว
 *
 * ถ้านับต่อ IP ล้วน: คนในออฟฟิศเดียวกันออกเน็ตด้วย IP เดียวกัน คนหนึ่งกรอกผิดจนถูกกั้น
 *   จะลากคนอื่นถูกกั้นไปด้วยทั้งที่ไม่ได้ทำอะไรผิด (และถ้าวันหน้า header หาย IP จะกลายเป็นค่าเดียวกันทั้งระบบ)
 * ถ้านับต่อชื่อผู้ใช้ล้วน: ใครก็ได้จากที่ไหนก็ได้ยิงชื่อ 'admin' รัว ๆ เพื่อกั้นไม่ให้แอดมินตัวจริงเข้าระบบ
 * รวมสองอย่าง = คนเดารหัสต้องอยู่ IP เดียวกับเหยื่อถึงจะกวนได้ ซึ่งยากกว่ามาก
 */
function buildKey(ip: string, username: string): string {
  return `${ip}|${username.trim().toLowerCase()}`;
}

/** ลบ record ที่หมดอายุทิ้ง — เรียกตอนเขียนเท่านั้น จะได้ไม่ต้องมี timer ค้างไว้ตลอดอายุ process */
function pruneExpired(now: number): void {
  for (const [key, record] of attempts) {
    if (record.expiresAt <= now) attempts.delete(key);
  }
}

/**
 * เช็คก่อนตรวจรหัสผ่าน — คืนจำนวนวินาทีที่ต้องรอถ้าถูกกั้นอยู่ คืน null ถ้าผ่านได้
 */
export function checkLoginRateLimit(ip: string, username: string): number | null {
  const record = attempts.get(buildKey(ip, username));
  if (!record) return null;

  const now = Date.now();
  if (record.expiresAt <= now) return null;         // หมดอายุแล้ว ปล่อยผ่าน (เดี๋ยว prune ตอนเขียนครั้งหน้า)
  if (record.failures < MAX_FAILURES) return null;

  return Math.ceil((record.expiresAt - now) / 1000);
}

/** เรียกเมื่อรหัสผ่านผิด (รวมถึงกรณีไม่มี username นั้นในระบบ) */
export function recordFailedLogin(ip: string, username: string): void {
  const now = Date.now();
  pruneExpired(now);

  // prune แล้วยังเต็มเพดาน = โดนยิงถล่มอยู่ ไม่รับ record ใหม่เพิ่ม (ของเดิมที่นับไว้ยังกั้นได้ตามปกติ)
  const key = buildKey(ip, username);
  if (!attempts.has(key) && attempts.size >= MAX_ENTRIES) return;

  const record = attempts.get(key);
  const failures = record && record.expiresAt > now ? record.failures + 1 : 1;
  attempts.set(key, { failures, expiresAt: now + WINDOW_MS });
}

/** เรียกเมื่อเข้าสู่ระบบสำเร็จ — ล้างประวัติผิดทิ้ง คนที่พิมพ์ผิดไปสองสามครั้งจะได้ไม่มีอะไรค้าง */
export function clearLoginAttempts(ip: string, username: string): void {
  attempts.delete(buildKey(ip, username));
}
