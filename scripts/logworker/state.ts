import { pool } from './config.js';

/**
 * อ่าน/เขียน checkpoint ของแต่ละงานใน log_worker_state
 *
 * ทำไม checkpoint ต้องอยู่ใน DB ไม่ใช่ไฟล์บน host:
 *   worker ต้อง restart ได้ตลอดเวลา (deploy / systemd restart / เครื่อง reboot) แล้วเก็บบรรทัดที่
 *   หายไประหว่างนั้นได้ครบและไม่ซ้ำ · ไฟล์บน host หายไปพร้อมเครื่องและ backup ไม่ได้เก็บให้
 *   ส่วนใน DB มันถูก backup ไปพร้อมข้อมูลที่มันชี้อยู่เสมอ
 */

export async function getCursor(job: string): Promise<Date | null> {
  const { rows } = await pool.query<{ cursor_at: Date | null }>(
    'SELECT cursor_at FROM log_worker_state WHERE job = $1', [job]);
  return rows[0]?.cursor_at ?? null;
}

/** บันทึกความคืบหน้าหลังทำงานสำเร็จ — cursor_at เดินหน้าอย่างเดียว ไม่มีวันถอยหลัง */
export async function markOk(job: string, cursorAt: Date | null, rowsWritten = 0): Promise<void> {
  await pool.query(
    `INSERT INTO log_worker_state (job, cursor_at, last_run_at, last_ok_at, last_error, runs, rows_written)
     VALUES ($1, $2, now(), now(), NULL, 1, $3)
     ON CONFLICT (job) DO UPDATE SET
       -- GREATEST กัน cursor ถอยหลังเมื่อมี worker 2 ตัวหลุดมารันซ้อนกัน (advisory lock กันอีกชั้นแล้ว)
       cursor_at    = GREATEST(log_worker_state.cursor_at, EXCLUDED.cursor_at),
       last_run_at  = now(),
       last_ok_at   = now(),
       last_error   = NULL,
       runs         = log_worker_state.runs + 1,
       rows_written = log_worker_state.rows_written + EXCLUDED.rows_written`,
    [job, cursorAt, rowsWritten]);
}

/**
 * บันทึกความล้มเหลว — ไม่ขยับ cursor_at
 *
 * สำคัญ: last_run_at ขยับแต่ last_ok_at ไม่ขยับ ⇒ หน้าจอแยกได้ว่า "worker ตาย" (last_run_at ค้าง)
 * กับ "worker ยังหายใจแต่ทำงานไม่สำเร็จ" (last_run_at เดิน แต่ last_ok_at ค้าง) ซึ่งแก้คนละวิธี
 */
export async function markError(job: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    await pool.query(
      `INSERT INTO log_worker_state (job, last_run_at, last_error, runs)
       VALUES ($1, now(), $2, 1)
       ON CONFLICT (job) DO UPDATE SET
         last_run_at = now(),
         last_error  = EXCLUDED.last_error,
         runs        = log_worker_state.runs + 1`,
      [job, msg.slice(0, 2000)]);
  } catch {
    // DB ล่มก็บันทึกความล้มเหลวลง DB ไม่ได้อยู่แล้ว — ไม่ใช่เรื่องที่ต้องทำให้ worker ตายตาม
  }
}
