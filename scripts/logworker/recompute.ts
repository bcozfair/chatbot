import { pool, log } from './config.js';
import { summarizeDay } from './trafficDailyJob.js';

/**
 * คำนวณแถว traffic_daily ของวันที่ "มีอยู่แล้ว" ใหม่ — เครื่องมือใช้มือ ไม่ได้อยู่ในรอบอัตโนมัติ
 *
 * ทำไมต้องมีแยกจาก backfillFromApiLogs:
 *   ตัวนั้นจงใจข้ามวันที่มีแถวอยู่แล้ว (NOT IN (SELECT day FROM traffic_daily)) เพื่อไม่ให้
 *   worker คำนวณร้อยกว่าวันใหม่ทุกครั้งที่รีสตาร์ท ⇒ ตอนเพิ่มคอลัมน์ใหม่ให้ตาราง วันเก่าจะค้าง
 *   เป็น NULL ตลอดไป ทั้งที่ api_logs ยังมีข้อมูลดิบให้คำนวณอยู่
 *
 * ปลอดภัยกับ audit_digest: SQL ฝั่ง ON CONFLICT กันไม่ให้เขียนทับ digest ของวันที่ปิดไปแล้ว
 * อยู่แล้ว (CASE WHEN td.day >= เมื่อวาน) ⇒ รันกี่ครั้งก็ไม่ทำลายโซ่ integrity
 *
 * รัน (จากโฟลเดอร์ deploy/logworker เพื่อให้เจอ node_modules):
 *   node --import tsx ../../scripts/logworker/recompute.ts               # ทุกวันที่มีแถวอยู่
 *   node --import tsx ../../scripts/logworker/recompute.ts 2026-08-01 2026-09-07
 *
 * ⚠️ วันที่เก่ากว่า retention ของ api_logs (120 วัน) ไม่มีข้อมูลดิบให้คำนวณแล้ว — คำนวณใหม่
 *    จะได้ค่าที่ "ไม่ครบแต่ดูเหมือนครบ" ⇒ สคริปต์จึงข้ามวันที่ไม่มีแถวใน api_logs เลย
 *    ปล่อยตัวเลขเดิมที่สรุปไว้ตอนข้อมูลยังอยู่ไว้ตามนั้น
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2);
  for (const v of [from, to]) {
    if (v !== undefined && !DAY_RE.test(v)) {
      console.error(`รูปแบบวันที่ต้องเป็น YYYY-MM-DD (ได้: ${v})`);
      process.exit(1);
    }
  }

  // เอาเฉพาะวันที่มีทั้งแถวใน traffic_daily และข้อมูลดิบใน api_logs เหลืออยู่
  const { rows } = await pool.query<{ d: string }>(
    `SELECT td.day::text AS d
       FROM traffic_daily td
      WHERE ($1::date IS NULL OR td.day >= $1::date)
        AND ($2::date IS NULL OR td.day <= $2::date)
        AND EXISTS (SELECT 1 FROM api_logs a
                     WHERE a.created_at >= (td.day)::timestamp     AT TIME ZONE 'Asia/Bangkok'
                       AND a.created_at <  (td.day + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')
      ORDER BY td.day`,
    [from ?? null, to ?? null]);

  if (rows.length === 0) {
    log('recompute: ไม่มีวันไหนเข้าเงื่อนไข (ไม่มีแถวใน traffic_daily หรือข้อมูลดิบหมดอายุไปแล้ว)');
    return;
  }

  log(`recompute: เริ่มคำนวณใหม่ ${rows.length} วัน (${rows[0].d} … ${rows[rows.length - 1].d})`);
  for (const r of rows) await summarizeDay(r.d);
  log('recompute: เสร็จแล้ว');
}

main()
  .catch(err => { console.error('recompute ล้มเหลว:', err); process.exitCode = 1; })
  .finally(() => { void pool.end(); });
