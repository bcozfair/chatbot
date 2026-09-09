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
 * ══ 2 ชั้นของการจับคู่ — แอดมินก่อน แล้วค่อย "เจ้าของข้อมูลแก้เองผ่าน LINE" ══
 * ชั้นที่ 1 (แอดมิน): api_logs ที่มี admin_user_id = คนกดจากหน้าเว็บหลังบ้าน
 * ชั้นที่ 2 (ผู้ใช้ LINE): แถวจำนวนมากของตารางอย่าง salesperson ถูกแก้จาก "ตัวเจ้าของเอง"
 *   ผ่านบอท/LIFF ซึ่งไม่มี admin_user_id เลย ⇒ ชั้นที่ 1 ตอบ 'unknown' ทั้งที่รู้ตัวคนทำได้
 *   ชั้นนี้จับคู่แบบเข้มงวด: api_logs.line_user_id ต้องเท่ากับ "รหัสของแถวที่ถูกแก้" (entity_id)
 *   ⇒ ไม่ใช่แค่ "บังเอิญมีใครสักคนกำลังคุยกับบอทตอนนั้น" แต่เป็น "คนที่เป็นเจ้าของแถวนั้นเอง
 *      กำลังมี request ทำงานอยู่พอดี" ซึ่งบังเอิญพร้อมกันได้ยากมาก
 *   จงใจไม่ทำชั้น "ผู้ใช้ LINE คนไหนก็ได้ที่ออนไลน์ตอนนั้น" เพราะบอทประมวลผลทีละ 10-40 วินาที
 *   หลายคนพร้อมกัน ⇒ การเดาแบบนั้นจะยัดชื่อผิดให้การแก้จาก psql/script ได้ง่ายเกินไป
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
 * แถวที่งานนี้หยิบมาทำ
 *   'pending' = งานประจำ — แถวที่ trigger เพิ่งทิ้งไว้ ยังไม่เคยหาคนทำ
 *   'recheck' = ไล่ย้อนของเก่าที่เคยปิดเคสเป็น 'unknown' ไปแล้ว (ใช้ตอนเพิ่งเพิ่มชั้นจับคู่ใหม่)
 *               ⚠️ ใช้จาก scripts/backfillAuditActor.ts เท่านั้น ไม่เอาเข้ารอบประจำ —
 *               'unknown' คือคำตอบที่ปิดเคสแล้ว การรื้อมาหาใหม่ทุกนาทีคือเผาแรงเปล่า
 */
export type AuditActorMode = 'pending' | 'recheck';

const PEND_WHERE: Record<AuditActorMode, string> = {
  pending: `actor_type = 'pending'`,
  // ไม่แตะแถวที่มีชื่อคนทำอยู่แล้ว และไม่ย้อนไปไกลกว่าอายุที่ api_logs เก็บไว้ (หาอย่างไรก็ไม่เจอ)
  recheck: `actor_type = 'unknown' AND actor_id IS NULL
            AND occurred_at > (SELECT COALESCE(min(created_at), now()) FROM api_logs)`,
};

/**
 * ทำทั้งหมดใน statement เดียว
 *
 * เหตุผล: ถ้าดึงมาวนใน Node แล้วยิงกลับทีละแถว จะเปิด transaction สั้น ๆ หลายสิบครั้งต่อรอบ
 * และมีช่วงที่ข้อมูลครึ่ง ๆ กลาง ๆ · statement เดียวจบใน transaction เดียว อ่านง่ายกว่าและถูกกว่า
 *
 * ขอบเขตเวลาที่ใช้ทั้ง 2 ชั้น เขียนเหมือนกันเป๊ะ: กว้าง ๆ ก่อนเพื่อให้ใช้ idx_api_logs_created_at
 * คัดแถวส่วนใหญ่ทิ้งได้ถูก ๆ แล้วค่อยตรวจเงื่อนไขจริงว่า "การแก้เกิดระหว่าง request นั้นทำงานอยู่"
 */
function buildSql(mode: AuditActorMode): string {
  return `
WITH pend AS (
  SELECT id, occurred_at, entity_id
    FROM audit_logs
   WHERE ${PEND_WHERE[mode]}
     AND occurred_at < now() - ($1 || ' seconds')::interval
   ORDER BY occurred_at
   LIMIT ${BATCH}
),
adm AS (
  SELECT p.id,
         count(DISTINCT l.admin_user_id)                              AS actors,
         min(l.admin_user_id)                                         AS admin_user_id,
         (array_agg(l.request_id ORDER BY l.duration_ms))[1]          AS request_id,
         (array_agg(l.ip         ORDER BY l.duration_ms))[1]          AS ip
    FROM pend p
    LEFT JOIN api_logs l
      ON l.created_at BETWEEN p.occurred_at - interval '1 minute'
                          AND p.occurred_at + interval '5 minutes'
     AND l.admin_user_id IS NOT NULL
     AND l.method IN ('POST', 'PUT', 'PATCH', 'DELETE')
     AND l.created_at >= p.occurred_at
     AND l.created_at - (l.duration_ms || ' milliseconds')::interval <= p.occurred_at
   GROUP BY p.id
),
lu AS (
  SELECT p.id,
         count(*)                                                     AS hits,
         (array_agg(l.line_user_id ORDER BY l.duration_ms))[1]        AS line_user_id,
         (array_agg(l.request_id   ORDER BY l.duration_ms))[1]        AS request_id,
         (array_agg(l.ip           ORDER BY l.duration_ms))[1]        AS ip
    FROM pend p
    JOIN api_logs l
      ON l.created_at BETWEEN p.occurred_at - interval '1 minute'
                          AND p.occurred_at + interval '5 minutes'
      -- เข้มงวดตรงนี้: ต้องเป็น "เจ้าของแถวที่ถูกแก้" เอง ไม่ใช่ผู้ใช้ LINE คนไหนก็ได้
     AND l.line_user_id = p.entity_id
      -- TASK = งานเบื้องหลังของ webhook (แถวที่วัดเวลาทำงานจริงของบอท) — การแก้ส่วนใหญ่เกิดตรงนี้
     AND l.method IN ('POST', 'PUT', 'PATCH', 'DELETE', 'TASK')
     AND l.created_at >= p.occurred_at
     AND l.created_at - (l.duration_ms || ' milliseconds')::interval <= p.occurred_at
   GROUP BY p.id
),
hit AS (
  SELECT a.id,
         a.actors                                    AS admins,
         a.admin_user_id,
         COALESCE(n.hits, 0)                         AS line_hits,
         n.line_user_id,
         COALESCE(n.request_id, a.request_id)        AS request_id,
         COALESCE(n.ip,         a.ip)                AS ip
    FROM adm a
    LEFT JOIN lu n ON n.id = a.id
)
UPDATE audit_logs a
   SET actor_type = CASE
         WHEN h.admins = 1     THEN 'admin'
         WHEN h.admins > 1     THEN 'ambiguous'
         WHEN h.line_hits > 0  THEN 'line_user'
         ELSE 'unknown'
       END,
       actor_source = CASE WHEN h.admins = 1 OR (h.admins = 0 AND h.line_hits > 0)
                           THEN 'correlated' ELSE NULL END,
       actor_id     = CASE WHEN h.admins = 1    THEN h.admin_user_id::text
                           WHEN h.admins = 0 AND h.line_hits > 0 THEN h.line_user_id
                           ELSE NULL END,
       actor_name   = CASE
         WHEN h.admins = 1
           THEN (SELECT u.username FROM admin_users u WHERE u.id = h.admin_user_id)
         WHEN h.admins = 0 AND h.line_hits > 0
           -- ไม่รู้จักชื่อก็คืนรหัส LINE ไปตรง ๆ — นั่นคือ "ตัวตน" ที่รู้จริง ไม่ใช่การเดาชื่อ
           THEN COALESCE((SELECT s.name FROM salesperson s WHERE s.user_id = h.line_user_id),
                         h.line_user_id)
         ELSE NULL END,
       request_id   = COALESCE(a.request_id,
                        CASE WHEN h.admins <= 1 THEN h.request_id END),
       ip           = COALESCE(a.ip,
                        CASE WHEN h.admins <= 1 THEN h.ip END),
       note         = CASE
         WHEN h.admins > 1 THEN 'ช่วงเวลานั้นมีแอดมินมากกว่า 1 คนยิงคำสั่งเขียนพร้อมกัน — แยกไม่ออก'
         WHEN h.admins = 0 AND h.line_hits > 0
           THEN 'เจ้าของข้อมูลแก้เองผ่าน LINE — จับคู่จาก request ของผู้ใช้คนนี้ที่ครอบเวลาที่แก้พอดี'
         WHEN h.admins = 0 THEN 'ไม่พบ request ของแอดมินหรือของเจ้าของข้อมูลเองที่ครอบเวลานี้ — น่าจะแก้จาก psql หรือ script ตรง ๆ'
         ELSE a.note
       END
  FROM hit h
 WHERE a.id = h.id
   -- ยังไม่ถึงเวลายอมแพ้ ⇒ ปล่อยไว้เป็น pending รอบหน้าค่อยลองใหม่ (เผื่อ api_logs ยังเขียนไม่ทัน)
   AND (h.admins > 0 OR h.line_hits > 0 OR a.occurred_at < now() - ($2 || ' minutes')::interval)
RETURNING a.actor_type`;
}

const SQL: Record<AuditActorMode, string> = {
  pending: buildSql('pending'),
  recheck: buildSql('recheck'),
};

export async function runAuditActorJob(mode: AuditActorMode = 'pending'): Promise<void> {
  const job = 'audit_actor';
  try {
    const { rows } = await pool.query<{ actor_type: string }>(SQL[mode], [GRACE_SEC, GIVE_UP_MIN]);
    if (rows.length > 0) {
      const tally = rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.actor_type] = (acc[r.actor_type] ?? 0) + 1;
        return acc;
      }, {});
      log(`audit_actor: เติมชื่อผู้แก้ไข ${rows.length} แถว ·`,
        Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' '));
    }
    // งานไล่ย้อนของเก่าเป็นงานที่คนสั่งเอง ไม่ใช่รอบประจำ — ไม่เขียนทับสถานะของงานประจำ
    if (mode === 'pending') await markOk(job, null, rows.length);
  } catch (err) {
    if (mode === 'pending') await markError(job, err);
    throw err;
  }
}
