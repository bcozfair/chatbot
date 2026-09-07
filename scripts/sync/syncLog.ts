/**
 * รูปแบบ log ของงาน sync — จุดเดียวที่กำหนดหน้าตาบรรทัด log ของทั้ง 3 resource
 *
 * ทำไมต้องมีไฟล์นี้: log เดิมเขียนกระจายอยู่ในแต่ละ syncXxx.ts และพิมพ์ทีละแถวที่ upsert
 * (รอบ incremental ที่ขยับ 65 แถว = 113 บรรทัด · รอบ --full = ~82,000 บรรทัด ซึ่ง console.log
 * เขียน stdout แบบ blocking จึงถ่วงเวลา sync จริง) ทั้งที่ log พวกนั้นไม่เคยใช้แก้ปัญหา
 * ที่นี่จึงยุบเหลือ "1 resource = 1 บรรทัดสรุป" + บรรทัด progress แบบ throttle ตอนรอบยาว
 *
 * ของเดิมไม่ได้หายไป — ตั้ง SYNC_LOG_VERBOSE=1 จะได้ log ละเอียดแบบเดิมกลับมาครบ
 * (ใช้ตอนต้องดีบั๊ก gateway/แถวที่พังจริง ๆ ไม่ต้องแก้โค้ดกลับ)
 *
 * ทุกบรรทัดขึ้นต้น '[sync] ' เสมอ เพื่อให้ `docker logs | grep '\[sync\]'` เก็บได้ครบ
 * (ของเดิมบรรทัด emoji ไม่มี prefix เลย จึงกรองไม่ติด)
 */
import { thaiClock } from '../../utils/thaiTime.js';

/** เปิด log ละเอียดแบบเดิม (per-row / REQUEST / RESPONSE / cursor เต็ม) */
export const SYNC_LOG_VERBOSE = process.env.SYNC_LOG_VERBOSE === '1';

/** ความกว้างคอลัมน์ชื่อ resource — จัดให้บรรทัดสรุปตรงคอลัมน์กัน ('saleorders' ยาวสุด 10) */
const ID_WIDTH = 10;

/** progress ตอนรอบยาว: ออกบรรทัดเมื่อครบ 50 หน้า "หรือ" ครบ 10 วิ แล้วแต่อะไรถึงก่อน */
const PROGRESS_EVERY_PAGES = 50;
const PROGRESS_EVERY_MS = 10_000;

export function slog(msg: string) {
  console.log(`[sync] ${msg}`);
}

export function swarn(msg: string) {
  console.warn(`[sync] ⚠️ ${msg}`);
}

export function serr(msg: string) {
  console.error(`[sync] ✗ ${msg}`);
}

/** log ที่ออกเฉพาะโหมด verbose — เนื้อหาเดิมของ log ชุดเก่า */
export function vlog(...args: any[]) {
  if (SYNC_LOG_VERBOSE) console.log(...args);
}

export function padId(resource: string) {
  return resource.padEnd(ID_WIDTH);
}

/** คั่นหลักพัน — 82,211 อ่านเร็วกว่า 82211 */
export function fmtNum(n: number) {
  return n.toLocaleString('en-US');
}

/** ระยะเวลาแบบสั้น: 0.9s / 42.3s / 5m48s (ปัดวินาทีรวมก่อนหาร กัน '1m60s') */
export function fmtDur(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/**
 * cursor แสดงเป็น "กวาดถึงเวลาไหนแล้ว" ไม่ใช่ token base64 88 ตัวอักษรที่ไม่มีใครอ่าน
 * (token เต็มยังอยู่ใน sync_state.sync_cursor ถ้าต้องใช้จริง — และโหมด verbose ก็ยังพิมพ์ให้)
 */
export function fmtCursorTime(iso?: string | null) {
  if (!iso) return 'cursor→ยังไม่มี';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'cursor→?';
  return `cursor→${thaiClock(at)}`;
}

export function clockNow() {
  return thaiClock();
}

/**
 * บริบทของ request ที่กำลังยิงอยู่ — ให้ gatewayClient เอาไปประกอบข้อความ retry ได้ว่า
 * "resource ไหน หน้าไหน" ซึ่งตัวมันเองไม่รู้ (ของเดิม log ว่า '[gateway] temporary 502' ลอย ๆ
 * พอมี 3 resource ยิงต่อกันจึงบอกไม่ได้ว่าใครพัง)
 */
const ctx: { resource: string | null; page: number } = { resource: null, page: 0 };

export function setSyncCtx(resource: string | null, page = 0) {
  ctx.resource = resource;
  ctx.page = page;
}

/** 'customers หน้า 37: ' — คืนสตริงว่างถ้าไม่ได้อยู่ในรอบ sync (เช่นถูกเรียกจากที่อื่น) */
export function syncCtxLabel() {
  if (!ctx.resource) return '';
  return ctx.page > 0 ? `${ctx.resource} หน้า ${ctx.page}: ` : `${ctx.resource}: `;
}

/**
 * ตัวพิมพ์ progress ระหว่างกวาดหลายหน้า — คืนฟังก์ชันที่เรียกได้ทุกหน้า แล้วมันจะ throttle เอง
 * รอบ 1 หน้า (incremental ปกติ) จึงไม่พิมพ์อะไรเลย ส่วนรอบ --full จะเห็นความคืบหน้าเป็นระยะ
 * มี rows/s ให้ประเมินได้ว่าจะจบเมื่อไหร่ ซึ่ง log ชุดเดิมไม่มี
 */
export function createPageTicker(resource: string, unitLabel: string) {
  const t0 = Date.now();
  let lastPage = 0;
  let lastAt = t0;

  return function tick(page: number, rows: number, units: number) {
    const now = Date.now();
    if (page - lastPage < PROGRESS_EVERY_PAGES && now - lastAt < PROGRESS_EVERY_MS) return;
    lastPage = page;
    lastAt = now;

    const elapsed = now - t0;
    const rate = elapsed > 0 ? Math.round((rows / elapsed) * 1000) : 0;
    slog(
      `… ${padId(resource)} ${String(page).padStart(4)} หน้า · ${fmtNum(rows)} rows · ` +
        `${fmtNum(units)} ${unitLabel} · ${fmtDur(elapsed)} · ${fmtNum(rate)} rows/s`
    );
  };
}

/**
 * บรรทัดสรุปท้าย resource — แทน 🏁 + 🎉 + 💾 ของเดิม
 * รอบที่ไม่มีข้อมูลใหม่ตัดตัวเลข 0 ทิ้ง เพราะ "ไม่มีข้อมูลใหม่" สื่อกว่า '0 templates · 0 rows'
 */
export function logResourceDone(args: {
  resource: string;
  units: number;
  unitLabel: string;
  rows: number;
  /** ชื่อหน่วยของแถวดิบ — customers เป็น 'contacts' (1 บริษัทมีหลายผู้ติดต่อ) ที่เหลือเป็น 'rows' */
  rowLabel?: string;
  pages: number;
  ms: number;
  cursorTimestamp?: string | null;
}) {
  const head = `✓ ${padId(args.resource)}`;
  const tail = `${args.pages} หน้า · ${fmtDur(args.ms)} · ${fmtCursorTime(args.cursorTimestamp)}`;
  if (args.rows === 0) {
    slog(`${head} ไม่มีข้อมูลใหม่ · ${tail}`);
    return;
  }
  slog(
    `${head} ${fmtNum(args.units).padStart(6)} ${args.unitLabel} · ${fmtNum(args.rows)} ${args.rowLabel || 'rows'} · ${tail}`
  );
}
