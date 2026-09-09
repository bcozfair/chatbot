import { pool, log } from './logworker/config.js';
import { runAuditActorJob } from './logworker/auditActorJob.js';

/**
 * ไล่ย้อนหาชื่อคนแก้ให้แถว audit ที่เคยปิดเคสไปแล้วว่า 'ไม่ทราบ'
 *
 * ใช้เมื่อไหร่: ตอนเพิ่ง "เพิ่มชั้นการจับคู่ใหม่" ให้ auditActorJob (เช่นชั้นผู้ใช้ LINE)
 * ของเก่าที่ปิดเคสไปก่อนหน้านั้นจะยังเป็น 'ไม่ทราบ' ค้างอยู่ ทั้งที่กติกาใหม่ตอบได้แล้ว
 *
 * ทำไมไม่ยัดเข้ารอบประจำของ logworker: 'ไม่ทราบ' คือคำตอบที่ปิดเคสแล้ว การรื้อมาหาใหม่
 * ทุกนาทีคือยิง query เปล่าทุกนาทีตลอดไปเพื่อผลลัพธ์ที่ไม่เปลี่ยน
 *
 * ปลอดภัยกับของเดิม: แตะเฉพาะแถวที่ actor_type='unknown' และยังไม่มี actor_id เท่านั้น
 * แถวที่รู้ตัวคนทำอยู่แล้ว (direct/correlated/ambiguous) ไม่ถูกแตะ · รันซ้ำได้ผลเท่าเดิม
 *
 * รัน (บน host เหมือน logworker เพราะใช้ค่าเชื่อมต่อชุดเดียวกัน):
 *   npm run backfill:audit-actor
 */
async function main(): Promise<void> {
  const { rows: before } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs WHERE actor_type = 'unknown' AND actor_id IS NULL`);
  log(`ก่อนเริ่ม: แถวที่ยัง 'ไม่ทราบ' ${before[0].n} แถว`);

  await runAuditActorJob('recheck');

  const { rows: after } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs WHERE actor_type = 'unknown' AND actor_id IS NULL`);
  log(`เสร็จแล้ว: เหลือ 'ไม่ทราบ' ${after[0].n} แถว` +
      ` (แถวที่เหลือคือการแก้จาก psql/script จริง ๆ ซึ่งเป็นคำตอบที่ถูกต้อง)`);
}

main()
  .catch(err => {
    console.error('[backfill:audit-actor] ล้มเหลว:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
