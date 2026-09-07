import { pool } from '../config/db.js';

/**
 * คำสั่งอ่านของหน้า "บันทึกและรายงาน" (traffic_daily / audit_logs / system_logs)
 *
 * ⚠️ ไฟล์ใหม่แยกจาก db/repositories.ts โดยเจตนา — ไฟล์นั้นเป็นเส้นทางที่ระบบหลักใช้ทุกวินาที
 * การไปแทรกโค้ดใหม่ในไฟล์เดียวกันคือความเสี่ยงที่ไม่มีใครได้อะไรกลับมา
 * ถอนทั้งแผนออก = ลบไฟล์นี้ + routes/logs.ts + 2 บรรทัดใน index.ts จบ
 *
 * ทุกฟังก์ชันในไฟล์นี้ "อ่านอย่างเดียว" ยกเว้น recordLogAccess ซึ่งเป็นการบันทึกว่าใครมาเปิดดู log
 * (ข้อบังคับของ พ.ร.บ. เรื่องการกำหนดสิทธิ์เข้าถึงและตรวจสอบได้)
 */

/** ทุก query ในไฟล์นี้อ่านตารางที่โตได้ ⇒ ต้องมีเพดานเวลาเสมอ ไม่ให้ค้างจนบล็อกงานอื่น */
const READ_TIMEOUT_MS = 20_000;

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${READ_TIMEOUT_MS}`);
    const { rows } = await client.query(sql, params);
    await client.query('COMMIT');
    return rows as T[];
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection ตายแล้ว */ }
    throw err;
  } finally {
    client.release();
  }
}

// ═══════════════════════════ traffic_daily ═══════════════════════════

export type Granularity = 'day' | 'week' | 'month' | 'year';

const TRUNC: Record<Granularity, string> = {
  day: 'day', week: 'week', month: 'month', year: 'year',
};

/**
 * ชุดตัวเลขต่อช่วงเวลา
 *
 * ⚠️ ค่าเฉลี่ยคำนวณจาก sum(duration_sum_ms)/sum(requests) ซึ่งถูกต้อง 100% ทุกระดับการรวม
 *    ส่วน p95 ของช่วงยาวเป็น max ของ p95 รายวัน — รวมย้อนกลับไม่ได้ทางคณิตศาสตร์
 *    ชื่อฟิลด์จึงเป็น p95_worst_day ไม่ใช่ p95 เพื่อให้หน้าจอไม่มีทางเผลอแสดงเป็น p95 จริง
 */
export interface TrafficBucket {
  bucket: string;
  days: number;
  requests: number;
  requests_api: number;
  webhook_events: number;
  webhook_dropped: number;
  webhook_timeout: number;
  errors_4xx: number;
  errors_5xx: number;
  uniq_line_users_max: number;
  uniq_admin_users_max: number;
  uniq_ips_max: number;
  bytes_out: string | null;
  avg_ms: number | null;
  p95_worst_day: number | null;
  max_inflight: number | null;
  db_wait_hits: number;
  quotations_created: number;
  messages_in: number;
  audit_changes: number;
  system_errors: number;
}

const BUCKET_SELECT = `
  date_trunc($1, day)::date::text                              AS bucket,
  count(*)::int                                                AS days,
  COALESCE(sum(requests), 0)::int                              AS requests,
  COALESCE(sum(requests_api), 0)::int                          AS requests_api,
  COALESCE(sum(webhook_events), 0)::int                        AS webhook_events,
  COALESCE(sum(webhook_dropped), 0)::int                       AS webhook_dropped,
  COALESCE(sum(webhook_timeout), 0)::int                       AS webhook_timeout,
  COALESCE(sum(errors_4xx), 0)::int                            AS errors_4xx,
  COALESCE(sum(errors_5xx), 0)::int                            AS errors_5xx,
  -- ⚠️ ผู้ใช้ไม่ซ้ำ "รวมข้ามวันไม่ได้" (คนเดิมเข้าทุกวันจะถูกนับซ้ำ) ⇒ ใช้ค่าสูงสุดรายวันของช่วง
  --    และตั้งชื่อฟิลด์ให้บอกตรง ๆ เพื่อไม่ให้หน้าจอเผลอแสดงเป็น "ผู้ใช้ทั้งหมดของเดือน"
  COALESCE(max(uniq_line_users), 0)::int                       AS uniq_line_users_max,
  COALESCE(max(uniq_admin_users), 0)::int                      AS uniq_admin_users_max,
  COALESCE(max(uniq_ips), 0)::int                              AS uniq_ips_max,
  sum(bytes_out)::text                                         AS bytes_out,
  (sum(duration_sum_ms) / NULLIF(sum(requests), 0))::int       AS avg_ms,
  max(p95_ms)                                                  AS p95_worst_day,
  max(max_inflight)                                            AS max_inflight,
  COALESCE(sum(db_wait_hits), 0)::int                          AS db_wait_hits,
  COALESCE(sum(quotations_created), 0)::int                    AS quotations_created,
  COALESCE(sum(messages_in), 0)::int                           AS messages_in,
  COALESCE(sum(audit_changes), 0)::int                         AS audit_changes,
  COALESCE(sum(system_errors), 0)::int                         AS system_errors`;

export function listTrafficBuckets(
  granularity: Granularity, from: string, to: string
): Promise<TrafficBucket[]> {
  return q<TrafficBucket>(
    `SELECT ${BUCKET_SELECT}
       FROM traffic_daily
      WHERE day BETWEEN $2::date AND $3::date
      GROUP BY 1
      ORDER BY 1`,
    [TRUNC[granularity], from, to]);
}

/**
 * ตัวเลขรวมของทั้งช่วง (ใช้เป็นแถว KPI) — ใช้สูตรเดียวกับ bucket เป๊ะ ๆ ตัวเลขจึงตรงกันเสมอ
 *
 * ไม่มี GROUP BY เลย: aggregate ล้วนบนช่วงที่กรองแล้ว ⇒ ได้ 1 แถวเสมอ ไม่ว่าช่วงจะข้ามปีหรือไม่
 * (bucket ในผลลัพธ์ถูกแทนด้วยวันเริ่มช่วง เพื่อให้ใช้ type เดียวกับ listTrafficBuckets ได้)
 */
export async function getTrafficTotals(from: string, to: string): Promise<TrafficBucket | null> {
  const rows = await q<TrafficBucket>(
    `SELECT ${BUCKET_SELECT.replace('date_trunc($1, day)::date::text', '$1::text')}
       FROM traffic_daily
      WHERE day BETWEEN $2::date AND $3::date`,
    [from, from, to]);
  // ช่วงที่ไม่มีข้อมูลเลยจะได้แถวที่ทุกค่าเป็น 0 (days = 0) ไม่ใช่ null — หน้าจอจึงไม่ต้องมีสองเส้นทาง
  return rows[0] ?? null;
}

/** ช่วงวันที่มีข้อมูลจริง — หน้าจอใช้บอกว่าเลื่อนย้อนหลังได้ถึงไหน แทนที่จะให้ผู้ใช้เจอหน้าว่าง */
export function getTrafficCoverage(): Promise<{ first_day: string | null; last_day: string | null }[]> {
  return q(`SELECT min(day)::text AS first_day, max(day)::text AS last_day FROM traffic_daily`);
}

// ═══════════════════════════ audit_logs ═══════════════════════════

export interface AuditFilters {
  dateFrom?: string;
  dateTo?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  actorType?: string;
  action?: string;
  requestId?: string;
  search?: string;
  /** ซ่อนแถว log.view — ดูเหตุผลที่ auditWhere */
  hideViews?: boolean;
}

/**
 * ตัวช่วยประกอบ WHERE — เก็บพารามิเตอร์ไว้ในตัวเองแล้วคืนเลข $n ให้
 *
 * เขียนเป็น class เล็ก ๆ แทนการ replace('?') เพราะเงื่อนไขค้นหาต้องใช้พารามิเตอร์ตัวเดียว
 * ในหลายตำแหน่ง (ILIKE 3 คอลัมน์) ซึ่ง replace ตัวแรกอย่างเดียวจะสร้าง SQL ที่ผิดแบบเงียบ ๆ
 */
class Where {
  readonly params: unknown[] = [];
  private readonly clauses: string[] = [];

  /** ผูกค่าแล้วคืน '$n' — เรียกซ้ำด้วยค่าเดิมได้ถ้าอยากใช้ตำแหน่งเดิม (เก็บเลขไว้เอง) */
  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  add(clause: string): void {
    this.clauses.push(clause);
  }

  /** ช่วงวันแบบไทย — from/to เป็น YYYY-MM-DD และ to นับรวมทั้งวัน */
  addThaiDateRange(column: string, from?: string, to?: string): void {
    if (from) this.add(`${column} >= (${this.bind(from)} || ' 00:00:00')::timestamp AT TIME ZONE 'Asia/Bangkok'`);
    if (to)   this.add(`${column} <  ((${this.bind(to)} || ' 00:00:00')::timestamp + interval '1 day') AT TIME ZONE 'Asia/Bangkok'`);
  }

  eq(column: string, value: string | undefined): void {
    if (value) this.add(`${column} = ${this.bind(value)}`);
  }

  toString(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

function auditWhere(f: AuditFilters): { where: string; params: unknown[] } {
  const w = new Where();

  // ระบุ request_id = ตามรอยจาก id ที่ผู้ใช้แคปมา ไม่รู้วันที่ → ต้องไม่ถูกกรองด้วยช่วงวัน
  // (กติกาเดียวกับ /api/admin/api-logs)
  if (f.requestId) w.eq('request_id', f.requestId);
  else             w.addThaiDateRange('occurred_at', f.dateFrom, f.dateTo);

  w.eq('entity_type', f.entityType);
  w.eq('entity_id',   f.entityId);
  w.eq('actor_id',    f.actorId);
  w.eq('actor_type',  f.actorType);
  w.eq('action',      f.action);
  if (f.search) {
    const n = w.bind(`%${f.search}%`);
    w.add(`(actor_name ILIKE ${n} OR entity_label ILIKE ${n} OR action ILIKE ${n})`);
  }

  // ทุกครั้งที่แอดมินเปิดหน้า log จะเกิดแถว log.view 1 แถว (ข้อบังคับเรื่องตรวจสอบการเข้าถึงได้)
  // ซึ่งมีจำนวนมากกว่าการแก้ข้อมูลจริงหลายเท่า ⇒ ตั้งต้นซ่อนไว้ ไม่งั้นหน้า "บันทึกการแก้ไข"
  // จะเต็มไปด้วยการเปิดดูของตัวเองจนหาการแก้ไขจริงไม่เจอ
  // ไม่ได้ลบทิ้ง — ติ๊ก "แสดงการเข้าดู" เมื่อไหร่ก็เห็นครบ และการส่งออก (log.export) ไม่เคยถูกซ่อน
  if (f.hideViews) w.add(`action <> 'log.view'`);

  return { where: w.toString(), params: w.params };
}

const AUDIT_COLS = `
  id::text AS id, occurred_at, request_id, actor_type, actor_id, actor_name, actor_source,
  action, entity_type, entity_id, entity_label, changed_cols, "before", "after", ip, result, note`;

export function listAuditLogs(f: AuditFilters, limit: number, offset: number) {
  const { where, params } = auditWhere(f);
  return q(
    `SELECT ${AUDIT_COLS} FROM audit_logs ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]);
}

export async function countAuditLogs(f: AuditFilters): Promise<number> {
  const { where, params } = auditWhere(f);
  const rows = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs ${where}`, params);
  return rows[0]?.n ?? 0;
}

export async function getAuditLogById(id: string) {
  const rows = await q(`SELECT ${AUDIT_COLS} FROM audit_logs WHERE id = $1::bigint`, [id]);
  return rows[0] ?? null;
}

/** ค่าที่มีอยู่จริงในตาราง — ใช้เติมช่องตัวเลือกของตัวกรอง ไม่ต้อง hardcode รายชื่อไว้ในหน้าจอ */
export function getAuditFacets() {
  return q(
    `SELECT 'entity_type' AS kind, entity_type AS value, count(*)::int AS n
       FROM audit_logs WHERE entity_type IS NOT NULL GROUP BY 2
     UNION ALL
     SELECT 'action', action, count(*)::int FROM audit_logs GROUP BY 2
     UNION ALL
     SELECT 'actor', COALESCE(actor_name, actor_type), count(*)::int FROM audit_logs GROUP BY 2
     ORDER BY 1, 3 DESC`);
}

// ═══════════════════════════ system_logs ═══════════════════════════

export interface SystemFilters {
  dateFrom?: string;
  dateTo?: string;
  level?: string;
  minLevel?: string;
  source?: string;
  requestId?: string;
  search?: string;
}

const LEVEL_ORDER = `CASE level WHEN 'fatal' THEN 0 WHEN 'error' THEN 1 WHEN 'warn' THEN 2
                                WHEN 'info' THEN 3 ELSE 4 END`;

function systemWhere(f: SystemFilters): { where: string; params: unknown[] } {
  const w = new Where();

  if (f.requestId) w.eq('request_id', f.requestId);
  else             w.addThaiDateRange('created_at', f.dateFrom, f.dateTo);

  w.eq('level', f.level);
  if (f.minLevel) {
    const n = w.bind(f.minLevel);
    w.add(`${LEVEL_ORDER} <= (CASE ${n} WHEN 'fatal' THEN 0 WHEN 'error' THEN 1
                              WHEN 'warn' THEN 2 WHEN 'info' THEN 3 ELSE 4 END)`);
  }
  w.eq('source', f.source);
  if (f.search) w.add(`message ILIKE ${w.bind(`%${f.search}%`)}`);

  return { where: w.toString(), params: w.params };
}

const SYSTEM_COLS = `
  id::text AS id, created_at, container, stream, level, source, event,
  message, request_id, ctx, err_stack`;

export function listSystemLogs(f: SystemFilters, limit: number, offset: number) {
  const { where, params } = systemWhere(f);
  return q(
    `SELECT ${SYSTEM_COLS} FROM system_logs ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]);
}

export async function countSystemLogs(f: SystemFilters): Promise<number> {
  const { where, params } = systemWhere(f);
  const rows = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM system_logs ${where}`, params);
  return rows[0]?.n ?? 0;
}

/** สรุปตามระดับ + โมดูล สำหรับแถบสรุปบนหัวหน้า "บันทึกระบบ" */
export function getSystemLogFacets(f: SystemFilters) {
  const { where, params } = systemWhere(f);
  return q(
    `SELECT 'level' AS kind, level AS value, count(*)::int AS n FROM system_logs ${where} GROUP BY 2
     UNION ALL
     SELECT 'source', COALESCE(source, '(ไม่ระบุ)'), count(*)::int FROM system_logs ${where} GROUP BY 2
     ORDER BY 1, 3 DESC`, params);
}

// ═══════════════════════════ ตามรอย request เดียวข้ามทุกตาราง ═══════════════════════════

/**
 * ไทม์ไลน์รวมของ request เดียว — ผลตอบแทนหลักของทั้งแผน
 *
 * ก่อนหน้านี้ถ้าผู้ใช้บอกว่า "ตอนบ่ายสองกดแล้วมันพัง" ต้องไล่ 3 ที่ด้วยมือแล้วเทียบเวลาเอง
 * ตอนนี้ทุกตารางมี request_id เดียวกัน ⇒ ดึงมาเรียงรวมกันในหน้าจอเดียวได้
 */
export function getRequestTimeline(requestId: string) {
  return q(
    `SELECT 'api'   AS kind, id::text, created_at  AS at,
            method || ' ' || path AS title,
            status_code::text     AS detail,
            duration_ms
       FROM api_logs   WHERE request_id = $1
     UNION ALL
     SELECT 'audit', id::text, occurred_at,
            action, COALESCE(entity_label, entity_id), NULL
       FROM audit_logs WHERE request_id = $1
     UNION ALL
     SELECT 'system', id::text, created_at,
            level || ' ' || COALESCE(source, ''), left(message, 300), NULL
       FROM system_logs WHERE request_id = $1
     ORDER BY at, kind`,
    [requestId]);
}

// ═══════════════════════════ สถานะ logworker ═══════════════════════════

/**
 * สถานะของงานเบื้องหลังทั้งหมด — แสดงบนหน้า "บันทึกระบบ"
 *
 * "worker หยุดเงียบ ๆ" เป็นความเสี่ยงจริงของสถาปัตยกรรมนี้ (แอปไม่รู้ด้วยซ้ำว่ามันหายไป)
 * ⇒ ต้องมีที่ให้คนเห็นได้โดยไม่ต้อง ssh เข้าเครื่อง · stale = true เมื่อไม่สำเร็จเกิน 15 นาที
 */
export function getWorkerStatus() {
  return q(
    `SELECT job, cursor_at, last_run_at, last_ok_at, last_error,
            runs::text, rows_written::text,
            (last_ok_at IS NULL OR last_ok_at < now() - interval '15 minutes') AS stale
       FROM log_worker_state ORDER BY job`);
}

// ═══════════════════════════ บันทึกว่าใครมาเปิดดู log ═══════════════════════════

/**
 * เขียน audit_logs สำหรับการเปิดดู/ส่งออก log — จุดเดียวในแอปทั้งระบบที่เขียนตารางนี้
 *
 * ⚠️ ห้าม await ในเส้นทางของ request และห้าม throw ไม่ว่ากรณีใด
 *   การบันทึกว่า "มีคนมาดู log" ต้องไม่มีวันทำให้ "การดู log" ล้มเหลว
 */
export function recordLogAccess(info: {
  action: 'log.view' | 'log.export';
  actorId: number | null;
  actorName: string | null;
  requestId?: string;
  ip?: string | null;
  entityType: string;
  note?: string;
}): void {
  void pool.query(
    `INSERT INTO audit_logs
       (request_id, actor_type, actor_id, actor_name, actor_source,
        action, entity_type, ip, note)
     VALUES ($1, $2, $3, $4, 'direct', $5, $6, $7, $8)`,
    [info.requestId ?? null,
     info.actorId === null ? 'unknown' : 'admin',
     info.actorId === null ? null : String(info.actorId),
     info.actorName, info.action, info.entityType, info.ip ?? null, info.note ?? null],
  ).catch(err => {
    console.error('[logs] บันทึกการเข้าดู log ไม่สำเร็จ (ไม่กระทบการแสดงผล):', err?.message ?? err);
  });
}
