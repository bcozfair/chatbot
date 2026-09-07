import { cfg, pool, log, logErr } from './config.js';
import { startSystemLogJob, stopSystemLogJob } from './systemLogJob.js';
import { runAuditActorJob } from './auditActorJob.js';
import { runTrafficDailyJob, backfillFromApiLogs, summarizeDay } from './trafficDailyJob.js';
import { runRetentionJob } from './retentionJob.js';

/**
 * logworker — โปรเซสแยกที่รันบน host (systemd) ทำงานเบื้องหลัง 4 อย่างของแผน log
 *
 *   ① docker logs → system_logs                    (เฟส 2)
 *   ② เติมชื่อผู้แก้ไขให้แถว audit ที่ยัง pending      (เฟส 3)
 *   ③ สรุป traffic รายวัน → traffic_daily           (เฟส 4)
 *   ④ ลบ log ที่เกินอายุ                             (เฟส 2-3)
 *
 * ══ สัญญาข้อเดียวที่สำคัญที่สุดของไฟล์นี้ ══
 * หยุด/พัง/ถอน logworker เมื่อไหร่ ระบบหลักต้องทำงานปกติทุกอย่าง
 * ⇒ ไม่มีโค้ดในแอปที่เรียกอะไรจากที่นี่ · ไม่แชร์ pool กับแอป · ไม่ถือ lock ที่แอปต้องใช้
 * ⇒ ทดสอบข้อนี้ได้ตรง ๆ ด้วย `systemctl stop logworker` แล้วใช้งานระบบตามปกติ
 *
 * รัน:  npm run logworker           (หรือผ่าน systemd — ดู deploy/logworker.service)
 */

/** กันรันซ้อน 2 ตัว — เลขนี้ไม่มีความหมายในตัว แค่ต้องไม่ชนกับใคร (แอปไม่ใช้ advisory lock เลย) */
const ADVISORY_LOCK_KEY = 918_264_401;

const AUDIT_ACTOR_INTERVAL_MS  = 60_000;        // ทุก 1 นาที — แถว pending ต้องได้ชื่อเร็วพอที่คนจะเห็นทัน
const TRAFFIC_INTERVAL_MS      = 15 * 60_000;   // ทุก 15 นาที — "วันนี้" บนหน้าจอจึงสดพอโดยไม่กวน DB
const RETENTION_INTERVAL_MS    = 60 * 60_000;   // ทุกชั่วโมง เหมือน retention ของ api_logs

const timers: NodeJS.Timeout[] = [];
let lockClient: import('pg').PoolClient | null = null;
let shuttingDown = false;

/**
 * ตัวห่องานตามเวลา — งานที่ล้มต้องไม่ทำให้ timer ตายและไม่ทำให้โปรเซสตาย
 * (unhandled rejection ใน setInterval callback = Node ปิดตัวเองใน v15+)
 */
function every(ms: number, name: string, fn: () => Promise<void>): void {
  const tick = async () => {
    if (shuttingDown) return;
    try {
      await fn();
    } catch (err) {
      logErr(`${name} ล้มเหลว (รอบหน้าลองใหม่):`, err instanceof Error ? err.message : err);
    }
  };
  void tick();                                   // ยิงรอบแรกทันที ไม่ต้องรอครบช่วง
  timers.push(setInterval(() => { void tick(); }, ms));
}

/**
 * ขอสิทธิ์เป็น worker ตัวเดียวของ DB นี้
 *
 * ใช้ advisory lock แทนไฟล์ pid เพราะมันผูกกับ "connection" ⇒ โปรเซสตายกะทันหัน (SIGKILL,
 * ไฟดับ) lock หลุดเองทันทีที่ connection ขาด ไม่มีไฟล์ค้างให้ต้องมาเก็บกวาดด้วยมือ
 */
async function acquireLock(): Promise<boolean> {
  lockClient = await pool.connect();
  const { rows } = await lockClient.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_KEY]);
  if (!rows[0]?.ok) {
    lockClient.release();
    lockClient = null;
    return false;
  }
  return true;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`ได้รับ ${signal} — กำลังปิด`);
  for (const t of timers) clearInterval(t);
  try {
    await stopSystemLogJob();
  } catch (err) {
    logErr('ปิด systemLogJob ไม่เรียบร้อย:', err instanceof Error ? err.message : err);
  }
  if (lockClient) {
    try { await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]); } catch { /* ปิดอยู่แล้ว */ }
    lockClient.release();
  }
  await pool.end().catch(() => { /* ปิดอยู่แล้ว */ });
  log('ปิดเรียบร้อย');
  process.exit(0);
}

/**
 * โหมด "รันงานเดียวแล้วออก" — `npm run logworker -- --once <job>`
 *
 * มีไว้ให้ ops ใช้จริง ไม่ใช่แค่ของสำหรับเทส:
 *   --once traffic            สรุปใหม่ทั้งหมดหลังแก้สูตร หรือหลัง restore DB
 *   --once traffic 2026-08-15 สรุปเฉพาะวันนั้นวันเดียว
 *   --once audit_actor        เร่งเติมชื่อผู้แก้ไขทันทีโดยไม่ต้องรอรอบถัดไป
 *   --once retention          เร่งลบของเก่าทันทีหลังลดค่า retention
 *
 * ไม่ขอ advisory lock — ตั้งใจให้รันคู่ขนานกับ worker ตัวจริงที่ทำงานอยู่ได้
 * (ทุกงานเป็น idempotent: traffic ใช้ ON CONFLICT DO UPDATE · audit_actor แตะเฉพาะแถว pending
 *  · retention ลบของที่เกินอายุ ซึ่งลบซ้ำก็ได้ผลเท่าเดิม)
 */
async function runOnce(job: string, arg?: string): Promise<void> {
  if (job === 'traffic') {
    if (arg) {
      await summarizeDay(arg);
      log(`สรุป traffic ของวันที่ ${arg} เรียบร้อย`);
    } else {
      const n = await backfillFromApiLogs();
      await runTrafficDailyJob();
      log(`สรุป traffic เรียบร้อย (เติมย้อนหลัง ${n} วัน + เมื่อวาน/วันนี้)`);
    }
  } else if (job === 'audit_actor') {
    await runAuditActorJob();
  } else if (job === 'retention') {
    await runRetentionJob();
  } else {
    logErr(`ไม่รู้จักงาน '${job}' — ใช้ได้: traffic | audit_actor | retention`);
    await pool.end();
    process.exit(1);
  }
  await pool.end();
}

async function main(): Promise<void> {
  const onceIdx = process.argv.indexOf('--once');
  if (onceIdx >= 0) {
    await runOnce(process.argv[onceIdx + 1] ?? '', process.argv[onceIdx + 2]);
    return;
  }

  log(`เริ่มทำงาน · คอนเทนเนอร์: ${cfg.containers.join(', ')} · ระดับที่เขียนลง DB: ${cfg.dbLevel}`);

  if (!(await acquireLock())) {
    logErr('มี logworker อีกตัวทำงานอยู่แล้ว (advisory lock ไม่ว่าง) — ปิดตัวเอง');
    await pool.end();
    process.exit(0);
  }

  // ตรวจว่า migration ขึ้นครบก่อนเริ่ม — ล้มที่นี่ชัดเจนกว่าไปล้มทีละ query ตอนทำงาน
  const { rows } = await pool.query<{ missing: string }>(
    `SELECT t AS missing FROM unnest(ARRAY['system_logs','log_worker_state','audit_logs','traffic_daily']) t
      WHERE to_regclass('public.' || t) IS NULL`);
  if (rows.length > 0) {
    logErr(`ยังไม่ได้รัน migration: ขาดตาราง ${rows.map(r => r.missing).join(', ')}`);
    logErr('รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-09-03_0{3,4,5}_*.sql');
    await pool.end();
    process.exit(1);
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });

  await startSystemLogJob();

  // เติม traffic ย้อนหลังจากที่ api_logs ยังมีอยู่ — ทำครั้งเดียวตอนสตาร์ท ไม่ให้หน้าจอว่างวันแรก
  try {
    await backfillFromApiLogs();
  } catch (err) {
    logErr('backfill ล้มเหลว (ไม่กระทบงานอื่น):', err instanceof Error ? err.message : err);
  }

  every(AUDIT_ACTOR_INTERVAL_MS, 'audit_actor',   runAuditActorJob);
  every(TRAFFIC_INTERVAL_MS,     'traffic_daily', runTrafficDailyJob);
  every(RETENTION_INTERVAL_MS,   'log_retention', runRetentionJob);

  log('พร้อมทำงาน');
}

main().catch(err => {
  logErr('เริ่มทำงานไม่สำเร็จ:', err);
  process.exit(1);
});
