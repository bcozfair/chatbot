import type { Level } from './config.js';

/**
 * แปลงบรรทัดดิบจาก `docker logs --timestamps` เป็นแถวของตาราง system_logs
 *
 * ทุกฟังก์ชันในไฟล์นี้เป็นฟังก์ชันบริสุทธิ์ (ไม่แตะ DB ไม่แตะ process) เพื่อให้
 * scripts/diag/logWorkerSmoke.ts ทดสอบได้ครบทุกเคสโดยไม่ต้องมี docker หรือ DB
 */

/** ความยาวสูงสุดของ message ที่ยอมเก็บ — บรรทัดเดียวที่ยาวผิดปกติต้องไม่ทำให้ตารางบวม */
export const MAX_MESSAGE = 4_096;
/** ความยาวสูงสุดของ stack trace / บรรทัดต่อเนื่องที่ผนวกเข้าแถวเดียวกัน */
export const MAX_STACK = 8_192;

export interface TimedLine {
  ts: Date;
  text: string;
}

/**
 * แยก timestamp ที่ docker เติมให้ออกจากเนื้อบรรทัด
 *
 * docker เติม RFC3339 ระดับนาโนวินาทีให้ "ทุกบรรทัด" รวมบรรทัดต่อเนื่องของ stack trace ด้วย
 * ⇒ ใช้ค่านี้เป็น created_at ได้ตรง ๆ และนั่นคือเหตุผลที่ worker หยุดไป 10 นาทีแล้วกลับมา
 *   เก็บย้อนหลัง เวลาบนแถวยังตรงกับตอนที่เหตุการณ์เกิดจริง ไม่ใช่ตอนที่ worker อ่านเจอ
 *
 * คืน null เมื่อบรรทัดไม่มี timestamp (ไม่ควรเกิด แต่ถ้าเกิดต้องข้าม ไม่ใช่เขียนเวลามั่ว)
 */
export function splitTimestamp(line: string): TimedLine | null {
  const sp = line.indexOf(' ');
  if (sp <= 0) return null;
  const ts = new Date(line.slice(0, sp));
  if (Number.isNaN(ts.getTime())) return null;
  return { ts, text: line.slice(sp + 1) };
}

/**
 * บรรทัดนี้เป็น "ส่วนต่อของบรรทัดก่อนหน้า" หรือไม่
 *
 * stack trace ของ Node ขึ้นต้นด้วยช่องว่างแล้วตามด้วย at ... ส่วน object/array ที่ console.log
 * พิมพ์หลายบรรทัดจะจบด้วย } หรือ ] เดี่ยว ๆ · การรวมไว้ในแถวเดียวกันทำให้อ่านรู้เรื่อง
 * และไม่ทำให้ 1 error กลายเป็น 20 แถวในตาราง
 */
export function isContinuation(text: string): boolean {
  if (text.length === 0) return false;
  if (/^\s/.test(text)) return true;                 // stack trace / ค่าใน object ที่ย่อหน้า
  return /^[}\])]\s*,?$/.test(text.trim());          // ปีกกา/วงเล็บปิดเดี่ยว ๆ
}

/** ดึงชื่อโมดูลจากวงเล็บเหลี่ยมต้นบรรทัด: "[sync] ..." → "sync" */
const SOURCE_RE = /^\[([A-Za-z0-9_.:-]{1,60})\]\s*/;
/** reqId=<hex 16 ตัว> — รูปแบบที่ [queue] ใช้อยู่แล้ววันนี้ */
const REQ_ID_RE = /\breq(?:uest)?[_-]?[Ii]d[=:]\s*"?([0-9a-f]{16})"?/;
/** สัญญาณว่าโปรเซสกำลังจะตาย — หนักกว่า error ธรรมดาเพราะกระทบทั้งระบบ ไม่ใช่แค่ request เดียว */
const FATAL_RE = /uncaughtException|unhandledRejection|FATAL|out of memory|Cannot find module/i;
/** ข้อความที่บอกเองว่าเป็นแค่คำเตือน — ใช้แยก warn ออกจาก error ภายในสตรีม stderr */
const WARN_RE = /⚠|\bwarn(?:ing)?\b/i;

export interface ParsedEntry {
  level: Level;
  source: string | null;
  event: string | null;
  message: string;
  requestId: string | null;
  ctx: Record<string, unknown> | null;
}

/**
 * ระดับความรุนแรงของบรรทัด
 *
 * ⚠️ ตัวชี้หลักคือ "สตรีม" ไม่ใช่คำในข้อความ — Node ส่ง console.log/info ออก stdout
 * และ console.warn/error ออก stderr เสมอ ซึ่งเป็นสัญญาณที่แม่นยำ 100% โดยไม่ต้องแก้โค้ดแอปเลย
 *
 * การเดาจากคำพัง ยกตัวอย่างจริงจาก log ของระบบนี้:
 *   [queue] reqId=... [replied=144 timedOut=0 dropped=0 failed=0]
 * มีคำว่า failed และ timedOut แต่เป็นบรรทัดที่ปกติที่สุดของระบบ (สรุปสถิติสะสม)
 * ถ้าเดาจากคำ บรรทัดนี้จะกลายเป็น error ทุกครั้งที่บอทตอบข้อความ = ตารางเต็มไปด้วยสัญญาณปลอม
 */
export function detectLevel(text: string, stream: 'stdout' | 'stderr'): Level {
  if (FATAL_RE.test(text)) return 'fatal';
  if (stream === 'stderr') return WARN_RE.test(text) ? 'warn' : 'error';
  return 'info';
}

/** บรรทัดที่เป็น JSON ทั้งบรรทัด (เฟส 6 จะทยอยเปลี่ยน console.* มาเป็นแบบนี้) */
function tryJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const o = JSON.parse(t);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  return clamp(v.trim(), max);
}

/**
 * แปลง 1 บรรทัดเป็นแถว
 *
 * รองรับ 2 รูปแบบในฟังก์ชันเดียว:
 *   1. บรรทัด JSON — อ่าน level/source/event/message/requestId จากฟิลด์ตรง ๆ (แม่นยำที่สุด)
 *   2. บรรทัดข้อความธรรมดา (821 จุดที่มีอยู่วันนี้) — อ่านจากสตรีม + วงเล็บเหลี่ยมต้นบรรทัด
 * ⇒ เปลี่ยน console.* เป็น JSON ทีละโมดูลได้เรื่อย ๆ โดยไม่ต้องแก้ worker และไม่มีวันที่ต้อง "ตัดสวิตช์"
 */
export function parseEntry(text: string, stream: 'stdout' | 'stderr'): ParsedEntry {
  const json = tryJson(text);

  if (json) {
    const lvl = String(json.level ?? '').toLowerCase();
    const known = ['fatal', 'error', 'warn', 'info', 'debug'].includes(lvl);
    const { level: _l, source: _s, event: _e, msg: _m, message: _mm,
            requestId: _r, request_id: _r2, ...rest } = json as Record<string, unknown>;
    return {
      level: known ? (lvl as Level) : detectLevel(text, stream),
      source: str(json.source, 60),
      event: str(json.event, 80),
      message: str(json.message ?? json.msg, MAX_MESSAGE) ?? clamp(text, MAX_MESSAGE),
      requestId: str(json.requestId ?? json.request_id, 16),
      ctx: Object.keys(rest).length > 0 ? rest : null,
    };
  }

  const m = SOURCE_RE.exec(text);
  const source = m ? m[1] : null;
  const body = m ? text.slice(m[0].length) : text;
  const rid = REQ_ID_RE.exec(text);

  return {
    level: detectLevel(text, stream),
    source,
    event: null,
    message: clamp(body.length > 0 ? body : text, MAX_MESSAGE),
    requestId: rid ? rid[1] : null,
    ctx: null,
  };
}
