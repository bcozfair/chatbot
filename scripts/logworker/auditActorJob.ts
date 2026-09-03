import { pool, log } from './config.js';
import { markOk, markError } from './state.js';

/**
 * งานที่ 2 ของ logworker — เติม "ใครเป็นคนแก้" ให้แถว audit ที่ trigger ทิ้งไว้เป็น pending
 *
 * ══ ทำไมต้องมีงานนี้ (ขั้น A ของแผน) ══
 * trigger อยู่ในฝั่ง DB ซึ่งไม่รู้จัก JWT ไม่รู้จัก session ⇒ บอกไม่ได้เองว่าใครกดปุ่ม
 * ทางตรงคือให้แอปบอกผ่าน SET LOCAL app.actor แต่ต้องแก้ handler ทีละจุด (43 จุด) = ต้องรอ
 * งานนี้ทำให้ "ได้ชื่อคนทำตั้งแต่วันแรกโดยไม่แตะโค้ดแอปเลย" แล้วค่อยทยอยทำขั้น B ทีหลัง
 * จุดที่ทำขั้น B แล้วจะเป็น actor_type='admin' ตั้งแต่แรก งานนี้จะไม่แตะ
 *
 * ══ วิธีจับคู่ — ใช้ "ช่วงเวลาของ request" ไม่ใช่ระยะห่างของเวลา ══
 * api_logs.created_at คือเวลาที่ response ปิด (res.on('finish')) และมี duration_ms กำกับ
 * ⇒ request นั้นเริ่มที่ created_at - duration_ms และจบที่ created_at
 * ⇒ การแก้ข้อมูลที่เกิด "ระหว่าง" ช่วงนั้นคือการแก้ที่เกิดจาก request นั้นแน่นอน
 * นี่แม่นกว่าการหา "แถวที่เวลาใกล้ที่สุด" มาก เพราะไม่ต้องเดาค่าความคลาดเคลื่อนเลย
 *
 * ══ ความซื่อสัตย์ของตัวเลข ══
 * ถ้าช่วงนั้นมีแอดมินมากกว่า 1 คนยิงคำสั่งเขียนพร้อมกัน ⇒ ติดป้าย 'ambiguous' ไม่ใช่เดาเอาคนใดคนหนึ่ง
 * ถ้าไม่มีเลย (แก้จาก psql / script ตรง ๆ) ⇒ 'unknown' ซึ่งเป็นคำตอบที่ถูกต้อง ไม่ใช่ความล้มเหลว
 * และแถวที่จับคู่ได้จะติด actor_source='correlated' เสมอ เพื่อให้หน้าจอแยกออกจาก 'direct' ได้
 */

/** รอเท่านี้ก่อนเริ่มจับคู่ — apiLogService flush ทุก 2 วินาที แถวคู่ของมันต้องลง DB ก่อน */
const GRACE_SEC = 20;
/** เกินเท่านี้แล้วยังจับคู่ไม่ได้ = ไม่มีทางเจอแล้ว ปิดเคสเป็น unknown */
const GIVE_UP_MIN = 10;
/** จำนวนแถวที่ประมวลผลต่อรอบ — audit เขียนไม่กี่สิบแถว/วัน เพดานนี้จึงเหลือเฟือมาก */
const BATCH = 500;

/**
 * ทำทั้งหมดใน statement เดียว
 *
 * เหตุผล: ถ้าดึงมาวนใน Node แล้วยิงกลับทีละแถว จะเปิด transaction สั้น ๆ หลายสิบครั้งต่อรอบ
 * และมีช่วงที่ข้อมูลครึ่ง ๆ กลาง ๆ · statement เดียวจบใน transaction เดียว อ่านง่ายกว่าและถูกกว่า
 */
const SQL = `
WITH pend AS (
  SELECT id, occurred_at
    FROM audit_logs
   WHERE actor_type = 'pending'
     AND occurred_at < now() - ($1 || ' seconds')::interval
   ORDER BY occurred_at
   LIMIT ${BATCH}
),
hit AS (
  SELECT p.id,
         count(DISTINCT l.admin_user_id)                              AS actors,
         min(l.admin_user_id)                                         AS admin_user_id,
         (array_agg(l.request_id ORDER BY l.duration_ms))[1]          AS request_id,
         (array_agg(l.ip         ORDER BY l.duration_ms))[1]          AS ip
    FROM pend p
    LEFT JOIN api_logs l
      -- ขอบเขตกว้าง ๆ ก่อน เพื่อให้ใช้ idx_api_logs_created_at คัดแถวส่วนใหญ่ทิ้งได้ถูก ๆ
      ON l.created_at BETWEEN p.occurred_at - interval '1 minute'
                          AND p.occurred_at + interval '5 minutes'
     AND l.admin_user_id IS NOT NULL
     AND l.method IN ('POST', 'PUT', 'PATCH', 'DELETE')
      -- แล้วค่อยตรวจเงื่อนไขจริง: การแก้เกิดขึ้นระหว่าง request นั้นกำลังทำงานอยู่
     AND l.created_at >= p.occurred_at
     AND l.created_at - (l.duration_ms || ' milliseconds')::interval <= p.occurred_at
   GROUP BY p.id
)
UPDATE audit_logs a
   SET actor_type = CASE
         WHEN h.actors = 1 THEN 'admin'
         WHEN h.actors > 1 THEN 'ambiguous'
         ELSE 'unknown'
       END,
       actor_source = CASE WHEN h.actors = 1 THEN 'correlated' ELSE NULL END,
       actor_id     = CASE WHEN h.actors = 1 THEN h.admin_user_id::text ELSE NULL END,
       actor_name   = CASE WHEN h.actors = 1
                           THEN (SELECT u.username FROM admin_users u WHERE u.id = h.admin_user_id)
                           ELSE NULL END,
       request_id   = COALESCE(a.request_id, CASE WHEN h.actors = 1 THEN h.request_id END),
       ip           = COALESCE(a.ip,         CASE WHEN h.actors = 1 THEN h.ip         END),
       note         = CASE
         WHEN h.actors > 1 THEN 'ช่วงเวลานั้นมีแอดมินมากกว่า 1 คนยิงคำสั่งเขียนพร้อมกัน — แยกไม่ออก'
         WHEN h.actors = 0 THEN 'ไม่พบ request ของแอดมินที่ครอบเวลานี้ — น่าจะแก้จาก psql หรือ script ตรง ๆ'
         ELSE a.note
       END
  FROM hit h
 WHERE a.id = h.id
   -- ยังไม่ถึงเวลายอมแพ้ ⇒ ปล่อยไว้เป็น pending รอบหน้าค่อยลองใหม่ (เผื่อ api_logs ยังเขียนไม่ทัน)
   AND (h.actors > 0 OR a.occurred_at < now() - ($2 || ' minutes')::interval)
RETURNING a.actor_type`;

export async function runAuditActorJob(): Promise<void> {
  const job = 'audit_actor';
  try {
    const { rows } = await pool.query<{ actor_type: string }>(SQL, [GRACE_SEC, GIVE_UP_MIN]);
    if (rows.length > 0) {
      const tally = rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.actor_type] = (acc[r.actor_type] ?? 0) + 1;
        return acc;
      }, {});
      log(`audit_actor: เติมชื่อผู้แก้ไข ${rows.length} แถว ·`,
        Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' '));
    }
    await markOk(job, null, rows.length);
  } catch (err) {
    await markError(job, err);
    throw err;
  }
}
