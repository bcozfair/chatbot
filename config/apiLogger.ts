import { randomBytes } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AdminRequest } from './auth.js';
import { pool, POOL_MAX } from './db.js';
import { enqueueApiLog } from '../services/apiLogService.js';

/**
 * บันทึกการเรียก API ทุกครั้งลงตาราง api_logs — เพื่อตอบ 2 คำถาม
 *   1. "ใครทำอะไร"            — user ไหนเรียก endpoint ไหน ได้ status อะไร
 *   2. "ช้าตรงไหน/ทรัพยากรพอไหม" — endpoint ไหนกินเวลา ช่วงไหนโหลดหนัก pool ตันไหม
 *
 * ⚠️⚠️ ห้ามเติม express.json() หรือ body parser ตัวใดก็ตามแบบ global คู่กับ middleware นี้
 *   line.middleware(lineConfig) ที่ POST /callback ต้องได้ "เนื้อ request แบบดิบ" ไปคำนวณ HMAC
 *   ของ header x-line-signature ถ้ามีใคร parse ก่อน ลายเซ็นจะตรวจไม่ผ่าน = บอทหยุดตอบทั้งระบบ
 *   middleware ตัวนี้จึงไม่แตะ stream ของ request เลย (ไม่ req.on('data') ไม่เรียก parser ไม่ await)
 *
 * ทำไมไม่ทำให้ระบบช้าลง — 3 ชั้น
 *   1. ขาเข้าทำงานระดับไมโครวินาที ไม่มี await ส่งต่อ next() ทันทีแบบ synchronous
 *   2. งานตอนจบผูกไว้กับ res.on('finish') ซึ่งยิงหลัง byte สุดท้ายออกจาก socket แล้ว
 *      → ไม่อยู่ในเส้นทางที่ผู้ใช้รอ (และเป็นเหตุผลที่ตารางนี้จงใจไม่เก็บ request body:
 *        ถ้าเก็บ ต้องเดิน object + stringify ทุก request ซึ่งเป็นงาน CPU ที่หนักกว่านี้หลายเท่า)
 *   3. ไม่มีการยิง DB ในเส้นทางของ request เลย — services/apiLogService.ts กองไว้แล้วเขียนเป็น batch
 */

/** ปิดทั้งระบบได้ด้วย API_LOG_ENABLED=false แล้ว restart (อ่านครั้งเดียวตอนโหลดโมดูล) */
const API_LOG_ENABLED = process.env.API_LOG_ENABLED !== 'false';

/** path ที่ต้อง log เสมอ — ตรวจก่อนกฎนามสกุล กันเคส path param ที่ลงท้ายเหมือนชื่อไฟล์ static */
const FORCE_LOG_PREFIXES = ['/api/', '/callback', '/download-pdf/', '/liff/'] as const;

const STATIC_EXT_RE =
  /\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|txt|xml|webmanifest)$/i;

/**
 * ข้ามไฟล์ static — ฟังก์ชันบริสุทธิ์ แยกออกมาให้ diag เทสได้โดยไม่ต้องยิง HTTP จริง
 *
 * .html ไม่อยู่ใน STATIC_EXT_RE โดยเจตนา — หน้า LIFF เป็น HTML และต้อง log
 */
export function shouldSkipLogging(method: string, pathname: string): boolean {
  if (method === 'OPTIONS') return true;                          // CORS preflight ไม่มีสาระให้ตรวจ
  for (const p of FORCE_LOG_PREFIXES) if (pathname.startsWith(p)) return false;
  if (pathname === '/admin' || pathname === '/') return false;
  if (pathname.startsWith('/assets/')) return true;               // build output ของ Vite
  if (pathname.startsWith('/data/')) return true;                 // รูปลายเซ็น (express.static)
  if (pathname === '/favicon.ico' || pathname === '/robots.txt') return true;
  return STATIC_EXT_RE.test(pathname);
}

/**
 * หา LINE userId ของ request — ฟังก์ชันบริสุทธิ์ แยกออกมาให้ diag เทสได้
 *
 * หมายเหตุ: อ่าน "ค่าจาก body" ไม่ใช่ "เก็บ body" — ตารางนี้ไม่มีคอลัมน์ request body
 */
export function extractLineUserId(
  body: any, query: any, params: any, override?: string
): string | null {
  if (override && override.trim()) return override.trim();

  const cand =
    // webhook: event ทั้งชุดเป็นของคนเดียวกันเสมอในระบบนี้ (คิวใช้ userId เป็น key อยู่แล้ว)
    body?.events?.[0]?.source?.userId ??
    body?.events?.[0]?.source?.groupId ??
    // LIFF: POST /api/quotations, draft-cart, confirm, cancel, update-branches, PUT /api/quotation/:id
    body?.userId ?? body?.user_id ??
    query?.userId ?? query?.user_id ??
    params?.userId;                                                // GET /api/salesperson/:userId

  return typeof cand === 'string' && cand.trim() ? cand.trim() : null;
}

/**
 * ค่าที่ควรบันทึกลง db_waiting — ฟังก์ชันบริสุทธิ์ แยกออกมาให้ diag เทสได้
 *
 * ⚠️ pool.waitingCount ดิบ ๆ ใช้ไม่ได้ เพราะ pg-pool push ทุกคำขอลง _pendingQueue "ก่อนเสมอ"
 * แล้วค่อยระบายใน process.nextTick ต่อให้มี client ว่างรออยู่ (pg-pool/index.js)
 * ⇒ ใครก็ตามที่อ่าน waitingCount ภายใน tick เดียวกันจะเห็น > 0 แม้ pool ว่างสนิท
 *
 * วัดจริงจาก api_logs 533 แถว: 70 แถวมี db_waiting > 0 และ "ทั้ง 70 แถว" มี inflight = 1
 * (= ตอนนั้นมี request ตัวเดียวในทั้งระบบ) ส่วน inflight สูงสุดที่เคยเกิดคือ 3 จากเพดาน 40
 * ⇒ สัญญาณผิด 100% ซึ่งแพงกว่าไม่มีสัญญาณเลย เพราะสักวันจะพาไปขยาย pool/DB ทั้งที่ไม่มีปัญหา
 *
 * การตันจริงต้องครบ 3 ข้อพร้อมกัน — ตรงกับเงื่อนไขที่ pg-pool ใช้เข้าคิวเป๊ะ ๆ
 *   1. มีคนรออยู่จริง                 (waiting > 0)
 *   2. จ่าย connection ใหม่ไม่ได้แล้ว  (total ถึงเพดาน — ตรงกับ _isFull())
 *   3. ไม่มีตัวว่างให้หยิบ            (idle = 0)
 * ขาดข้อไหนก็เป็นการรอชั่วขณะที่จะหายไปเองใน tick ถัดไป ไม่ใช่ปัญหาทรัพยากร
 * ข้อ 3 สำคัญไม่แพ้ข้อ 2: pool ที่เต็มแต่มีตัวว่างค้างอยู่ก็เข้าคิวเหมือนกัน (ดู `_isFull() || _idle.length`)
 */
export function dbWaitingSignal(
  s: { waiting: number; total: number; idle: number; max: number }
): number {
  return s.waiting > 0 && s.total >= s.max && s.idle === 0 ? s.waiting : 0;
}

interface ApiLogState {
  requestId: string;
  startNs: bigint;
  /** ต้องจับตอนขาเข้า ไม่ใช่ตอนจบ — app.use('/data', ...) rewrite req.url ระหว่างทาง */
  path: string;
  method: string;
  /** จำนวน request ที่ค้างอยู่ ณ ตอนที่ request นี้เริ่ม (รวมตัวเองแล้ว จึงต่ำสุดคือ 1) */
  inflightAtStart: number;
  lineUserIdOverride?: string;
}

/**
 * เก็บ state ใน WeakMap ไม่แปะ property บน req — ไม่ชนชื่อกับ Express/LINE SDK
 * ไม่ต้อง cast any หรือ augment Express.Request และ GC เก็บเองเมื่อ request ตาย
 */
const states = new WeakMap<Request, ApiLogState>();

/** จำนวน request ที่กำลังค้างอยู่ในระบบ — ++ ตอนเข้า, -- ตอน response ปิด */
let inflight = 0;

/**
 * แหล่งสุ่มสำหรับ request id — ขอจาก CSPRNG ทีเดียวก้อนใหญ่แล้วตัดใช้ทีละ 8 ไบต์
 *
 * randomBytes(8) ต่อ request วัดได้ 3.46 µs ซึ่งเป็นต้นทุนที่แพงที่สุดของ middleware นี้ทั้งตัว
 * (มากกว่าทุกอย่างที่เหลือรวมกัน) ส่วนวิธีนี้วัดได้ 0.23 µs = เร็วขึ้น 15 เท่า
 * ความสุ่มไม่ได้ลดลงเลย — ยังมาจาก crypto.randomBytes ตัวเดิม แค่ขอทีละก้อนแทนทีละครั้ง
 */
const ID_BYTES = 8;
const ID_POOL_SIZE = ID_BYTES * 512;
let idPool = randomBytes(ID_POOL_SIZE);
let idPoolPos = 0;

function nextRequestId(): string {
  if (idPoolPos >= ID_POOL_SIZE) {
    idPool = randomBytes(ID_POOL_SIZE);
    idPoolPos = 0;
  }
  const id = idPool.toString('hex', idPoolPos, idPoolPos + ID_BYTES);
  idPoolPos += ID_BYTES;
  return id;
}

/** ตัดสตริงให้ไม่เกินความยาวคอลัมน์ — แถวเดียวที่ยาวเกินจะทำให้ INSERT ทั้ง batch (500 แถว) พัง */
function clamp(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** smallint = -32768..32767 — ค่าที่เกินต้องถูกตรึง ไม่งั้น INSERT ทั้ง batch พัง */
function clampSmallInt(n: number | null | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(-32768, Math.min(32767, Math.round(n)));
}

function parseContentLength(res: Response): number | null {
  const raw = res.getHeader('content-length');
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** id ของ request นี้ (ตัวเดียวกับ header X-Request-Id) — undefined ถ้า path ถูกข้ามหรือปิด log อยู่ */
export function getRequestId(req: Request): string | undefined {
  return states.get(req)?.requestId;
}

/** ช่องให้ handler บอก LINE userId ตรง ๆ เมื่อ extractLineUserId หาไม่เจอ (ยังไม่มีใครใช้ตอนนี้) */
export function setLogLineUser(req: Request, userId: string): void {
  const st = states.get(req);
  if (st) st.lineUserIdOverride = userId;
}

export function apiLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  // ทั้งก้อนห่อ try/catch: บั๊กใน logger ต้องทำได้อย่างมากแค่ "แถวนั้นหาย"
  // ห้ามลามไปล้ม response หรือ process — และ next() ต้องถูกเรียกครั้งเดียวเสมอไม่ว่าเกิดอะไร
  try {
    if (API_LOG_ENABLED) {
      // req.path เป็น getter ที่ Express แกะ URL ใหม่ทุกครั้งที่อ่าน — อ่านครั้งเดียวแล้วส่งต่อ
      const pathname = req.path;
      if (!shouldSkipLogging(req.method, pathname)) begin(req, res, pathname);
    }
  } catch (err: any) {
    console.error('[api-log] middleware ล้มเหลว:', err?.message ?? err);
  }
  next();
}

function begin(req: Request, res: Response, pathname: string): void {
  const requestId = nextRequestId();
  // ตอบ id กลับไปด้วย เพื่อให้ผู้ใช้ที่เจอปัญหาแคปหน้าจอมาแล้วแอดมินค้นเจอทันที
  // ไม่รับค่า X-Request-Id ที่ client ส่งเข้ามา — ปลอมได้และจะทำให้ log ชนกันโดยเจตนา
  res.setHeader('X-Request-Id', requestId);

  inflight++;
  states.set(req, {
    requestId,
    startNs: process.hrtime.bigint(),
    path: pathname,
    method: req.method,
    inflightAtStart: inflight,
  });

  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    inflight--;                                    // ต้องลดทั้งสองทาง ไม่งั้นตัวเลขรั่วจนไร้ความหมาย
    try {
      collect(req, res);
    } catch (err: any) {
      console.error('[api-log] เก็บข้อมูลแถวล้มเหลว:', err?.message ?? err);
    }
  };
  res.on('finish', done);   // ตอบครบตามปกติ
  res.on('close', done);    // client ตัดกลางคัน / socket ตาย — 'finish' ไม่ยิง
}

function collect(req: Request, res: Response): void {
  const st = states.get(req);
  if (!st) return;

  const durationMs = Math.round(Number(process.hrtime.bigint() - st.startNs) / 1e6);

  // เก็บ route "เฉพาะตอนที่ Express บอกมาเป็น string เท่านั้น ไม่เดาเอง"
  // เป็น undefined ตอน 404/static และเป็น array ตอน route ที่ประกาศเป็น array
  // (app.get(['/liff/register', '/liff/register/register'], ...)) → ทั้งสองกรณีเก็บ NULL
  // การจัดกลุ่มสำหรับหน้าสถิติไปทำตอนอ่าน (COALESCE(route, ย่อ path)) เพื่อไม่ให้เขียนค่าที่เดาผิดค้างใน DB
  const rawRoute = (req as any).route?.path;
  const route = typeof rawRoute === 'string' ? rawRoute : null;

  enqueueApiLog({
    createdAt: new Date(),
    requestId: st.requestId,
    method: clamp(st.method, 6) ?? 'UNK',
    route: clamp(route, 120),
    path: clamp(st.path, 200) ?? '/',
    statusCode: clampSmallInt(res.statusCode) ?? 0,
    durationMs,
    respBytes: parseContentLength(res),
    adminUserId: (req as AdminRequest).admin?.id ?? null,
    lineUserId: clamp(
      extractLineUserId(req.body, req.query, req.params, st.lineUserIdOverride), 40),
    inflight: clampSmallInt(st.inflightAtStart),
    // > 0 เมื่อไหร่แปลว่า pool 40 connection ไม่พอ "จริง ๆ" — ดูเหตุผลที่ dbWaitingSignal
    dbWaiting: clampSmallInt(dbWaitingSignal({
      waiting: pool.waitingCount, total: pool.totalCount, idle: pool.idleCount, max: POOL_MAX,
    })),
    queueWaitedMs: null,                           // ใช้เฉพาะแถว TASK ของ webhook (เฟส 2)
  });
}
