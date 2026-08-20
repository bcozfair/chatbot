import { pool } from '../config/db.js';
import {
  insertApiLogRows,
  deleteApiLogsOlderThan,
  type ApiLogInsertRow,
} from '../db/repositories.js';

/**
 * ตัวเขียน api_logs แบบ batch + ตัวลบของเก่า
 *
 * หน้าที่เดียวของไฟล์นี้คือ "รับแถวจาก middleware แล้วเขียนลง DB โดยไม่ให้ใครต้องรอ"
 * middleware (config/apiLogger.ts) เรียกแค่ enqueueApiLog() ซึ่งเป็นการ push เข้า array
 * ไม่มี await ไม่มีการยิง DB ในเส้นทางของ request เลย
 *
 * โครงตาม pattern ของ services/syncService.ts (setInterval ระดับโมดูล + init/stop คู่กัน)
 */

const FLUSH_INTERVAL_MS = 2_000;   // หน่วงสูงสุดก่อนแถวลง DB — สั้นพอที่กด refresh แล้วเห็นข้อมูลใหม่
const FLUSH_BATCH       = 500;     // แถวต่อ 1 INSERT — ~90 KB ต่อ statement ยังห่างจาก statement_timeout มาก
const MAX_BUFFER        = 5_000;   // เพดาน ~1 MB — เกินแล้วทิ้ง ไม่ปล่อยให้โตไม่จำกัดจน process ตาย

const RETENTION_TICK_MS   = 60 * 60 * 1000;   // ทุกชั่วโมง — ลบทีละนิดดีกว่าก้อนยักษ์วันละครั้ง
const RETENTION_START_MS  = 5 * 60 * 1000;    // รอบแรกหลัง boot 5 นาที ไม่แย่ง resource ตอนสตาร์ท
const DELETE_BATCH        = 5_000;
const MAX_BATCHES_PER_RUN = 40;               // เพดาน 200k แถว/รอบ กันรอบแรกหลังลด retention กินยาว

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;

const buffer: ApiLogInsertRow[] = [];
let flushing = false;
let flushTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;

const metrics = {
  enqueued: 0,
  written: 0,
  droppedOverflow: 0,
  droppedError: 0,
  flushErrors: 0,
};

/** ตัวเลขสะสมสำหรับ diag และการตรวจสุขภาพ */
export function getApiLogMetrics() {
  return { ...metrics, buffered: buffer.length };
}

/**
 * รับแถวเข้าคิว — ต้องเป็น synchronous ล้วนและห้าม throw
 *
 * ตอน buffer เต็มเลือก "ทิ้งของใหม่" ไม่ใช่ "ดันของเก่าออก" เพราะเวลา DB มีปัญหา
 * แถวเก่าคือแถวที่อยู่ใกล้ต้นเหตุที่สุด จึงมีค่ากว่าแถวที่เพิ่งเกิด
 */
export function enqueueApiLog(row: ApiLogInsertRow): void {
  if (buffer.length >= MAX_BUFFER) {
    metrics.droppedOverflow++;
    // log ทุก 100 ครั้ง — ตอนถูกถล่มถ้า log ทุกครั้งจะได้ log ท่วมซ้ำอีกชั้นเปล่า ๆ
    if (metrics.droppedOverflow % 100 === 1) {
      console.warn(
        `[api-log] buffer เต็ม (${MAX_BUFFER}) — ทิ้งแถวใหม่ · สะสม ${metrics.droppedOverflow} แถว`);
    }
    return;
  }
  buffer.push(row);
  metrics.enqueued++;
}

/**
 * เขียนของที่กองอยู่ลง DB จนหมด
 *
 * splice เอาแถวออกจาก buffer "ก่อน" ยิง query — ระหว่างที่ await อยู่ request ใหม่ยัง enqueue เข้ามาได้
 * ตามปกติโดยไม่ชนกัน (แต่ละรอบทำงานกับ array ของตัวเอง)
 */
async function flushOnce(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  try {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, FLUSH_BATCH);
      try {
        await insertApiLogRows(pool, batch);
        metrics.written += batch.length;
      } catch (err: any) {
        // ทิ้งก้อนนี้ ไม่ใส่กลับเข้า buffer — ถ้า DB ล่มยาว การ requeue จะวนพังไม่จบและกิน memory
        // จนลากทั้งแอปล่ม · ยอมเสีย log ดีกว่าทำให้ระบบที่ log กำลังเฝ้าอยู่พังเสียเอง
        metrics.droppedError += batch.length;
        metrics.flushErrors++;
        console.error(
          `[api-log] flush ล้มเหลว ทิ้ง ${batch.length} แถว (สะสม ${metrics.droppedError}):`,
          err?.message ?? err);
        break;                                     // หยุดรอบนี้ รอ tick ถัดไปค่อยลองใหม่
      }
    }
  } finally {
    flushing = false;
  }
}

/** ผลลัพธ์ของการประมวลผล 1 event ของ webhook — map เป็น status code ในตาราง */
export type WebhookOutcome = 'replied' | 'timeout' | 'dropped' | 'failed';

const WEBHOOK_STATUS: Record<WebhookOutcome, number> = {
  replied: 200,
  timeout: 504,   // งานเกินงบเวลา — abort ไปแล้ว
  dropped: 499,   // ถูกทิ้งตั้งแต่ยังไม่เริ่มเพราะคิวตัน (client ฝั่ง LINE เลิกรอไปแล้ว)
  failed: 500,
};

/**
 * บันทึก "แถวที่สอง" ของ POST /callback — แถวที่บอกเวลาทำงานจริง
 *
 * ทำไมต้องมี: /callback ตอบ 200 กลับ LINE ทันทีก่อนเริ่มทำงาน (index.ts) แถว HTTP ปกติจึงวัดได้
 * ~1ms ทุกครั้ง ทั้งที่งานจริงกิน 10-40 วินาที ถ้ามีแต่แถวนั้น ตัวเลข duration จะโกหก
 * และ webhook คือภาระที่หนักที่สุดของระบบพอดี = จุดที่ต้องดูที่สุดตอนวิเคราะห์ทรัพยากร
 *
 * ทำไมไม่ UPDATE แถวเดิม: ตอนงานจบ แถว HTTP อาจยังกองอยู่ใน buffer ไม่มี id ให้ update
 * และการมี 2 แถวก็ตรงความจริงกว่า — LINE ยิง HTTP มา 1 ครั้ง (จบใน 1ms) แล้วเราทำงานต่อ n ชิ้น
 * ทั้งสองแถวใช้ request_id เดียวกัน จึงจับคู่กันได้ผ่าน idx_api_logs_request_id
 */
export function recordWebhookProcessing(info: {
  requestId: string | undefined;
  lineUserId: string;
  outcome: WebhookOutcome;
  /** เวลานั่งรอในคิวก่อนได้เริ่มทำงาน */
  waitedMs: number;
  /** เวลาทั้งหมดนับจากตอนรับ webhook = เวลาที่ผู้ใช้รอจริง (รวมเวลารอคิว) */
  totalMs: number;
}): void {
  // ไม่มี requestId = ปิด log อยู่ (API_LOG_ENABLED=false) → ไม่ต้องบันทึกอะไร
  if (!info.requestId) return;

  enqueueApiLog({
    createdAt: new Date(),
    requestId: info.requestId,
    method: 'TASK',
    route: '/callback (async)',
    path: '/callback (async)',
    statusCode: WEBHOOK_STATUS[info.outcome],
    durationMs: info.totalMs,
    respBytes: null,
    adminUserId: null,
    lineUserId: info.lineUserId.slice(0, 40),
    // แถวนี้เป็นงานเบื้องหลัง ไม่ใช่ request จริง — IP อยู่ที่แถว ack ที่ request_id เดียวกันแล้ว
    ip: null,
    inflight: null,
    dbWaiting: null,
    // duration_ms - queue_waited_ms = เวลาประมวลผลจริง
    // ค่านี้สูง = คิวตัน ต้องเพิ่มเครื่อง · ส่วนต่างสูง = โค้ด/LLM ช้า ต้อง optimize
    queueWaitedMs: info.waitedMs,
  });
}

/**
 * อ่านจำนวนวันที่เก็บย้อนหลังจาก env — ฟังก์ชันบริสุทธิ์ แยกออกมาให้ diag เทสได้โดยไม่ต้องตั้ง env จริง
 * (เลียนแบบ shouldRunNow ใน syncService)
 *
 * ค่าที่อ่านไม่ออก/ต่ำกว่า 1 ต้องตกกลับเป็นค่าตั้งต้น ไม่ใช่ 0 — เพราะ 0 แปลว่า "ลบทุกแถวทันที"
 */
export function parseRetentionDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RETENTION_DAYS;
  return Math.min(Math.floor(n), MAX_RETENTION_DAYS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retentionTick(): Promise<void> {
  try {
    const days = parseRetentionDays(process.env.API_LOG_RETENTION_DAYS);
    const t0 = Date.now();
    let total = 0;
    let batches = 0;

    for (; batches < MAX_BATCHES_PER_RUN; batches++) {
      const n = await deleteApiLogsOlderThan(pool, days, DELETE_BATCH);
      total += n;
      if (n < DELETE_BATCH) break;                 // ก้อนสุดท้ายไม่เต็ม = หมดแล้ว
      await sleep(200);                            // เว้นจังหวะ ไม่ยึด I/O ของ DB ยาว ๆ
    }

    if (total > 0) {
      console.log(
        `[api-log] retention ลบ ${total} แถวที่เก่ากว่า ${days} วัน` +
        ` (${batches + 1} batch, ${Date.now() - t0}ms)`);
    }
  } catch (err: any) {
    console.error('[api-log] retention tick error:', err?.message ?? err);
  }
}

/** เรียกครั้งเดียวหลัง app.listen */
export function initApiLogWriter(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => { void flushOnce(); }, FLUSH_INTERVAL_MS);

  if (retentionTimer) clearTimeout(retentionTimer);
  // รอบแรกหน่วงไว้ก่อน แล้วค่อยเข้าจังหวะรายชั่วโมง
  retentionTimer = setTimeout(() => {
    void retentionTick();
    retentionTimer = setInterval(() => { void retentionTick(); }, RETENTION_TICK_MS);
  }, RETENTION_START_MS);

  console.log(
    `[api-log] เริ่มทำงาน (flush ทุก ${FLUSH_INTERVAL_MS / 1000} วินาที,` +
    ` retention ทุก ${RETENTION_TICK_MS / 60000} นาที, เก็บ ${parseRetentionDays(process.env.API_LOG_RETENTION_DAYS)} วัน)`);
}

/** หยุด timer ทั้งสองตัว — ใช้ตอน graceful shutdown ก่อนเรียก flushApiLogs() */
export function stopApiLogWriter(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  // retentionTimer เป็น setTimeout ในช่วงแรกแล้วกลายเป็น setInterval — เคลียร์ทั้งสองแบบ
  if (retentionTimer) { clearTimeout(retentionTimer); clearInterval(retentionTimer); retentionTimer = null; }
}

/**
 * เขียนของที่ค้างให้หมดก่อนปิด process
 *
 * ต้องเรียก "หลัง" webhookQueue.drain() ในลำดับ shutdown เพราะงานที่เพิ่งจบใน drain
 * ก็สร้างแถวใหม่เข้ามาเหมือนกัน · มีเพดานเวลากันค้างถ้า DB ไม่ตอบ (hardExit 55 วิ ยังคุมอีกชั้น)
 */
export async function flushApiLogs(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (buffer.length > 0 && Date.now() < deadline) {
    const before = buffer.length;
    await flushOnce();
    if (buffer.length >= before) break;             // ไม่คืบหน้า (DB มีปัญหา) — เลิกรอ
  }
  if (buffer.length > 0) {
    console.warn(`[api-log] ปิดโดยยังมี ${buffer.length} แถวที่เขียนไม่ทัน`);
  }
}
