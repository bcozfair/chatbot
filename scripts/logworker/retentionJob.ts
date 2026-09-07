import { cfg, pool, log } from './config.js';
import { markOk, markError } from './state.js';

/**
 * งานที่ 4 ของ logworker — ลบ log ที่เกินอายุ
 *
 * ══ อายุการเก็บต้องนับเป็น "วัน" ไม่ใช่ "จำนวนแถว" ══
 * เพดานจำนวนแถวดูปลอดภัยกว่าเพราะคุมขนาดได้แน่นอน แต่มันผิดกฎหมาย:
 * วันที่มี traffic พุ่ง เพดานแถวจะลบข้อมูลของวันก่อนหน้าทิ้งก่อนครบ 90 วัน
 * = ละเมิด พ.ร.บ.คอมพิวเตอร์ ม.26 โดยที่ไม่มีใครรู้ตัวจนกว่าจะมีคนมาขอข้อมูล
 * ⇒ คุมขนาดด้วย "ระดับที่เก็บ" (SYSTEM_LOG_DB_LEVEL) แทน ซึ่งไม่กระทบอายุการเก็บเลย
 *
 * ══ ทำไม audit_logs ต้องอยู่ในนี้ทั้งที่ 2 ปียังไม่ถึง ══
 * เพื่อให้ "เส้นทางการลบ" ถูกเขียนและอ่านได้ตั้งแต่วันนี้ ไม่ใช่ให้คนในอนาคตมาเดาเอง
 * ในทางปฏิบัติมันจะไม่ลบอะไรเลยตลอด 2 ปีแรก
 *
 * ลบทีละก้อนแล้วเว้นจังหวะ (เลียนแบบ retentionTick ใน services/apiLogService.ts)
 * เพราะ DELETE ก้อนยักษ์ครั้งเดียวจะถือ lock ยาวและดัน WAL พรวดเดียว
 */

const DELETE_BATCH = 5_000;
const MAX_BATCHES  = 40;      // เพดาน 200k แถว/รอบ กันรอบแรกหลังลดค่า retention กินยาว

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function deleteOlderThan(
  table: string, column: string, days: number, extraWhere = ''
): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { rows } = await pool.query<{ n: number }>(
      `WITH victim AS (
         SELECT ctid FROM ${table}
          WHERE ${column} < now() - ($1 || ' days')::interval ${extraWhere}
          ORDER BY ${column}
          LIMIT ${DELETE_BATCH}
       )
       DELETE FROM ${table} t USING victim v WHERE t.ctid = v.ctid
       RETURNING 1`,
      [days]);
    total += rows.length;
    if (rows.length < DELETE_BATCH) break;
    await sleep(200);
  }
  return total;
}

export async function runRetentionJob(): Promise<void> {
  const job = 'log_retention';
  try {
    // info/debug อายุสั้นกว่า — เป็นของสำหรับ dev ไล่ปัญหาที่เพิ่งเกิด ไม่ใช่หลักฐานตามกฎหมาย
    const info = await deleteOlderThan(
      'system_logs', 'created_at', cfg.systemInfoRetentionDays,
      `AND level IN ('info', 'debug')`);
    // warn ขึ้นไปเก็บเท่าข้อมูลจราจร เพราะเป็นของที่ต้องใช้ตอบตอนมีเหตุ
    const warn = await deleteOlderThan(
      'system_logs', 'created_at', cfg.systemRetentionDays,
      `AND level NOT IN ('info', 'debug')`);
    const audit = await deleteOlderThan(
      'audit_logs', 'occurred_at', cfg.auditRetentionDays);

    const total = info + warn + audit;
    if (total > 0) {
      log(`retention ลบ system_logs ${info + warn} แถว (info/debug ${info}, warn+ ${warn})` +
          ` · audit_logs ${audit} แถว`);
    }
    await markOk(job, new Date(), total);
  } catch (err) {
    await markError(job, err);
    throw err;
  }
}
