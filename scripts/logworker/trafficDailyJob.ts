import { pool, log } from './config.js';
import { markOk, markError } from './state.js';

/**
 * งานที่ 3 ของ logworker — สรุป traffic รายวันลง traffic_daily
 *
 * ══ ทำไมสรุปเก็บ ไม่อ่านสดจาก api_logs ══
 * api_logs เก็บ 120 วัน ⇒ มุมมอง "ปี" จะว่างตลอดกาลถ้าอ่านจากแถวดิบ
 * สรุปวันละครั้งเก็บไม่ลบ = 365 แถว/ปี แล้วทุกมุมมอง (วัน/สัปดาห์/เดือน/ปี) อ่านจากตารางเดียวกัน
 * ⇒ ตัวเลขตรงกันเสมอโดยไม่ต้องมีสูตรสองชุดให้เพี้ยนกันทีหลัง
 *
 * ══ "วัน" คือวันไทยเสมอ ══
 * (created_at AT TIME ZONE 'Asia/Bangkok')::date — ไม่ใช่วัน UTC และไม่ขึ้นกับ TimeZone ของ session
 * ที่รัน (ปักไว้ในตัว query เอง) ⇒ รันจากที่ไหนก็ได้ผลเดียวกัน
 *
 * ══ ทำซ้ำได้ (idempotent) ══
 * ON CONFLICT (day) DO UPDATE ⇒ รันซ้ำวันเดิมกี่ครั้งก็ได้ค่าเดิม · backfill ย้อนหลังได้ทันที
 * และ "วันนี้" ถูกคำนวณใหม่เรื่อย ๆ ระหว่างวันโดยไม่ต้องมีเส้นทางพิเศษ
 */

/** ⚠️ ข้อบังคับของโปรเจกต์: query วิเคราะห์ต้องมี statement_timeout เสมอ */
const STATEMENT_TIMEOUT_MS = 60_000;

const SQL = `
WITH bound AS (
  SELECT ($1::date)::timestamp AT TIME ZONE 'Asia/Bangkok'                        AS lo,
         (($1::date + 1))::timestamp AT TIME ZONE 'Asia/Bangkok'                  AS hi
),
l AS (
  SELECT * FROM api_logs, bound WHERE created_at >= lo AND created_at < hi
),
http AS (SELECT * FROM l WHERE method <> 'TASK'),
task AS (SELECT * FROM l WHERE method =  'TASK')
INSERT INTO traffic_daily AS td (
  day, requests, requests_api, webhook_events, webhook_dropped, webhook_timeout,
  errors_4xx, errors_5xx, uniq_line_users, uniq_admin_users, uniq_ips,
  bytes_out, duration_sum_ms, p50_ms, p95_ms, p99_ms, max_inflight, db_wait_hits,
  quotations_created, messages_in, audit_changes, system_errors,
  audit_digest, audit_prev_digest, computed_at
)
SELECT
  $1::date,
  (SELECT count(*)                       FROM http),
  (SELECT count(*)                       FROM http WHERE path LIKE '/api/%'),
  (SELECT count(*)                       FROM task),
  (SELECT count(*)                       FROM task WHERE status_code = 499),
  (SELECT count(*)                       FROM task WHERE status_code = 504),
  (SELECT count(*)                       FROM http WHERE status_code BETWEEN 400 AND 499),
  (SELECT count(*)                       FROM http WHERE status_code >= 500),
  (SELECT count(DISTINCT line_user_id)   FROM l    WHERE line_user_id  IS NOT NULL),
  (SELECT count(DISTINCT admin_user_id)  FROM l    WHERE admin_user_id IS NOT NULL),
  (SELECT count(DISTINCT ip)             FROM l    WHERE ip            IS NOT NULL),
  (SELECT sum(resp_bytes)::bigint        FROM http),
  -- ผลรวมของเวลา — ตัวที่ทำให้ "ค่าเฉลี่ยของเดือน/ปี" คำนวณย้อนกลับได้ถูกต้อง 100%
  (SELECT COALESCE(sum(duration_ms), 0)::bigint FROM http),
  (SELECT percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms)::int FROM http),
  (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int FROM http),
  (SELECT percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms)::int FROM http),
  (SELECT max(inflight)                  FROM http),
  (SELECT count(*)                       FROM l    WHERE db_waiting > 0),
  (SELECT count(*) FROM quotations, bound WHERE created_at >= lo AND created_at < hi),
  (SELECT count(*) FROM messages,   bound WHERE created_at >= lo AND created_at < hi),
  (SELECT count(*) FROM audit_logs, bound WHERE occurred_at >= lo AND occurred_at < hi),
  (SELECT count(*) FROM system_logs, bound
    WHERE created_at >= lo AND created_at < hi AND level IN ('error', 'fatal')),
  -- ลายนิ้วมือรายวันของ audit — ต่อโซ่กับ digest ของเมื่อวาน
  -- ⚠️ NULL เมื่อวันนั้นไม่มีแถว audit เลย (COALESCE เป็นสตริงว่างจะทำให้ digest ของ "วันว่าง"
  --    ทุกวันเหมือนกันหมดจนไร้ความหมาย) — โซ่ข้ามวันว่างไปได้ ไม่ขาด
  (SELECT encode(digest(
            string_agg(
              a.id::text || '|' || a.occurred_at::text || '|' || a.action || '|' ||
              COALESCE(a.actor_id, '') || '|' || COALESCE(a.entity_id, '') || '|' ||
              COALESCE(a."before"::text, '') || '|' || COALESCE(a."after"::text, ''),
              E'\\n' ORDER BY a.id)
            || COALESCE((SELECT p.audit_digest FROM traffic_daily p WHERE p.day = $1::date - 1), ''),
          'sha256'), 'hex')
     FROM audit_logs a, bound WHERE a.occurred_at >= lo AND a.occurred_at < hi),
  (SELECT p.audit_digest FROM traffic_daily p WHERE p.day = $1::date - 1),
  now()
ON CONFLICT (day) DO UPDATE SET
  requests = EXCLUDED.requests, requests_api = EXCLUDED.requests_api,
  webhook_events = EXCLUDED.webhook_events, webhook_dropped = EXCLUDED.webhook_dropped,
  webhook_timeout = EXCLUDED.webhook_timeout,
  errors_4xx = EXCLUDED.errors_4xx, errors_5xx = EXCLUDED.errors_5xx,
  uniq_line_users = EXCLUDED.uniq_line_users, uniq_admin_users = EXCLUDED.uniq_admin_users,
  uniq_ips = EXCLUDED.uniq_ips, bytes_out = EXCLUDED.bytes_out,
  duration_sum_ms = EXCLUDED.duration_sum_ms,
  p50_ms = EXCLUDED.p50_ms, p95_ms = EXCLUDED.p95_ms, p99_ms = EXCLUDED.p99_ms,
  max_inflight = EXCLUDED.max_inflight, db_wait_hits = EXCLUDED.db_wait_hits,
  quotations_created = EXCLUDED.quotations_created, messages_in = EXCLUDED.messages_in,
  audit_changes = EXCLUDED.audit_changes, system_errors = EXCLUDED.system_errors,
  -- ⚠️ digest ของวันที่ "ปิดไปแล้ว" ห้ามเขียนทับ — ไม่งั้นการแก้แถวเก่าย้อนหลังจะถูกกลบด้วย
  --    การคำนวณใหม่ ซึ่งทำลายเหตุผลทั้งหมดที่มีคอลัมน์นี้
  --    วันที่ยังไม่ปิด (วันนี้/เมื่อวานที่เพิ่งสรุปครั้งแรก) ยังเขียนได้ตามปกติ
  audit_digest = CASE WHEN td.day >= (now() AT TIME ZONE 'Asia/Bangkok')::date - 1
                      THEN EXCLUDED.audit_digest ELSE td.audit_digest END,
  audit_prev_digest = CASE WHEN td.day >= (now() AT TIME ZONE 'Asia/Bangkok')::date - 1
                           THEN EXCLUDED.audit_prev_digest ELSE td.audit_prev_digest END,
  computed_at = now()
RETURNING td.day, td.requests, td.webhook_events`;

/** สรุป 1 วัน (รับเป็น 'YYYY-MM-DD' ตามวันไทย) — เรียกซ้ำได้ ผลเท่าเดิม */
export async function summarizeDay(day: string): Promise<{ requests: number } | null> {
  const client = await pool.connect();
  try {
    // SET LOCAL มีผลเฉพาะใน transaction — นอก transaction จะเงียบ ๆ ไม่ทำอะไร
    // ต้องครอบ BEGIN/COMMIT จริง ไม่งั้น timeout ที่ตั้งไว้เป็นแค่ความรู้สึกปลอดภัย
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const { rows } = await client.query<{ requests: number }>(SQL, [day]);
    await client.query('COMMIT');
    return rows[0] ?? null;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection ตายไปแล้ว — ปล่อยให้ release จัดการ */ }
    throw err;
  } finally {
    client.release();
  }
}

/** วันไทยวันนี้ในรูป YYYY-MM-DD */
export function thaiToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * รอบปกติ: สรุป "เมื่อวาน" (ให้ปิดวันแน่ ๆ) แล้วอัปเดต "วันนี้" ต่อ
 * ทำทั้งสองวันทุกรอบ ⇒ ไม่ต้องมีตัวจับเวลาเที่ยงคืนที่พลาดได้ถ้า worker หลับตอนนั้นพอดี
 */
export async function runTrafficDailyJob(): Promise<void> {
  const job = 'traffic_daily';
  try {
    const today = thaiToday();
    const yesterday = shiftDay(today, -1);
    for (const d of [yesterday, today]) await summarizeDay(d);
    await markOk(job, new Date(), 2);
  } catch (err) {
    await markError(job, err);
    throw err;
  }
}

/**
 * เติมย้อนหลังจากข้อมูลที่ api_logs ยังมีอยู่ — เรียกครั้งเดียวตอน worker สตาร์ท
 * เดินจากเก่าไปใหม่เพื่อให้โซ่ audit_digest ต่อกันถูกลำดับ
 */
export async function backfillFromApiLogs(): Promise<number> {
  const { rows } = await pool.query<{ d: string }>(
    `SELECT DISTINCT (created_at AT TIME ZONE 'Asia/Bangkok')::date::text AS d
       FROM api_logs
      WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date
            NOT IN (SELECT day FROM traffic_daily)
      ORDER BY 1`);
  for (const r of rows) await summarizeDay(r.d);
  if (rows.length > 0) log(`traffic_daily: เติมย้อนหลัง ${rows.length} วัน (${rows[0].d} … ${rows[rows.length - 1].d})`);
  return rows.length;
}
