import { Router, type Request, type Response } from 'express';
import { Parser } from 'json2csv';
import type { AdminRequest } from '../config/auth.js';
import { getRequestId } from '../config/apiLogger.js';
import { getClientIp } from '../config/loginRateLimit.js';
import { thaiDateParts } from '../utils/thaiTime.js';
import {
  listTrafficBuckets, getTrafficTotals, getTrafficCoverage,
  listAuditLogs, countAuditLogs, getAuditLogById, getAuditFacets,
  listSystemLogs, countSystemLogs, getSystemLogFacets,
  getRequestTimeline, getWorkerStatus, recordLogAccess,
  type Granularity,
} from '../db/logRepositories.js';

/**
 * API ของหน้า "บันทึกและรายงาน" (รายงานการใช้งาน / บันทึกการแก้ไข / บันทึกระบบ)
 *
 * ⚠️ ไฟล์ใหม่ทั้งไฟล์ ไม่แตะ endpoint เดิมสักตัว — /api/admin/api-logs ของเดิมยังอยู่ใน index.ts
 *   เหมือนเดิมทุกบรรทัด · ถอนทั้งแผนออก = ลบไฟล์นี้ + db/logRepositories.ts + 2 บรรทัดใน index.ts
 *
 * สิทธิ์เข้าถึงถูกบังคับที่จุด mount ใน index.ts (adminAuthMiddleware + requireRole('admin'))
 * ไม่ใช่ในไฟล์นี้ ⇒ ไม่มีทางที่ route ใหม่จะหลุดออกไปโดยไม่มีการตรวจสิทธิ์
 */
export const logsRouter = Router();

// ── ตัวช่วยร่วม ──────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** วันไทยวันนี้ในรูป YYYY-MM-DD — ใช้ตัวเดียวกับที่ระบบใช้ออกเลขใบเสนอราคา จึงตรงกันเสมอ */
function todayThai(): string {
  const t = thaiDateParts();
  return `${t.year}-${t.month}-${t.day}`;
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** ช่วงวันตั้งต้น 7 วันย้อนหลังรวมวันนี้ (กติกาเดียวกับหน้า "บันทึกการเรียก API" เดิม) */
function dateRange(q: any, defaultDays = 7): { dateFrom: string; dateTo: string } {
  const today = todayThai();
  const ok = (s: any) => typeof s === 'string' && DATE_RE.test(s);
  const to = ok(q.dateTo) ? q.dateTo : today;
  return {
    dateFrom: ok(q.dateFrom) ? q.dateFrom : shiftDay(to, -(defaultDays - 1)),
    dateTo: to,
  };
}

function paging(q: any, maxLimit = 200): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(parseInt(q.limit) || 50, 1), maxLimit),
    offset: Math.min(Math.max(parseInt(q.offset) || 0, 0), 10_000),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * บันทึกว่าใครมาเปิดดู/ส่งออก log
 *
 * ยิงแบบไม่รอ (ไม่มี await) — การบันทึกต้องไม่มีวันทำให้การอ่านช้าลงหรือล้มเหลว
 */
function audit(req: Request, action: 'log.view' | 'log.export', entityType: string, note?: string): void {
  const admin = (req as AdminRequest).admin;
  recordLogAccess({
    action, entityType, note,
    actorId: admin?.id ?? null,
    actorName: admin?.username ?? null,
    requestId: getRequestId(req),
    ip: getClientIp(req),
  });
}

/** ห่อ handler ให้ error กลายเป็น 500 พร้อมข้อความ แทนที่จะทำให้ทั้ง process ร้อง unhandled */
function safe(name: string, fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err: any) {
      console.error(`[logs] ${name} error:`, err?.message ?? err);
      res.status(500).json({ error: err?.message ?? 'ผิดพลาดไม่ทราบสาเหตุ' });
    }
  };
}

// ── รายงานการใช้งาน (traffic) ───────────────────────────────────────────────

const GRANULARITY: Granularity[] = ['day', 'week', 'month', 'year'];

/**
 * ชุดข้อมูลของหน้ารายงาน — คืนทั้งช่วงที่ขอ, ช่วงก่อนหน้าเท่ากันสำหรับเทียบ, และช่วงที่มีข้อมูลจริง
 * รวมใน request เดียวเพื่อให้หน้าจอไม่ต้องยิง 3 ครั้งแล้วมาเจอสถานะครึ่ง ๆ กลาง ๆ ระหว่างโหลด
 */
logsRouter.get('/traffic', safe('GET /traffic', async (req, res) => {
  const q = req.query as any;
  const granularity: Granularity =
    GRANULARITY.includes(q.granularity) ? q.granularity : 'day';
  const { dateFrom, dateTo } = dateRange(q, 30);

  // ช่วงก่อนหน้าที่ "ยาวเท่ากัน" — เทียบเดือนต่อเดือนได้โดยไม่ต้องแคร์ว่าเดือนไหนมี 28 หรือ 31 วัน
  const spanDays =
    Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
  const prevTo = shiftDay(dateFrom, -1);
  const prevFrom = shiftDay(prevTo, -(spanDays - 1));

  const [buckets, totals, previous, coverage] = await Promise.all([
    listTrafficBuckets(granularity, dateFrom, dateTo),
    getTrafficTotals(dateFrom, dateTo),
    getTrafficTotals(prevFrom, prevTo),
    getTrafficCoverage(),
  ]);

  audit(req, 'log.view', 'traffic', `${dateFrom}..${dateTo} (${granularity})`);
  res.json({
    granularity, dateFrom, dateTo,
    buckets, totals,
    previous: { dateFrom: prevFrom, dateTo: prevTo, totals: previous },
    coverage: coverage[0] ?? { first_day: null, last_day: null },
    // หน้าจอต้องแสดงป้ายนี้ให้เห็น — ตัวเลขต้องไม่โกหก
    notes: {
      p95: 'p95 ของช่วงยาวคือ "p95 สูงสุดรายวันในช่วงนี้" ไม่ใช่ p95 จริงของทั้งช่วง (รวมย้อนกลับไม่ได้)',
      uniq: 'ผู้ใช้ไม่ซ้ำของช่วงยาวคือ "ค่าสูงสุดรายวัน" ไม่ใช่ผลรวม (คนเดิมเข้าหลายวันจะถูกนับซ้ำ)',
    },
  });
}));

// ── บันทึกการแก้ไข (audit) ──────────────────────────────────────────────────

function auditFilters(q: any) {
  const { dateFrom, dateTo } = dateRange(q, 30);
  return {
    ...(str(q.requestId) ? { requestId: str(q.requestId) } : { dateFrom, dateTo }),
    entityType: str(q.entityType),
    entityId: str(q.entityId),
    actorId: str(q.actorId),
    actorType: str(q.actorType),
    action: str(q.action),
    search: str(q.q),
    // ตั้งต้นซ่อนการเข้าดู — ส่ง includeViews=1 มาเมื่อผู้ใช้ติ๊กช่อง "แสดงการเข้าดู"
    hideViews: q.includeViews !== '1' && !str(q.action),
  };
}

logsRouter.get('/audit', safe('GET /audit', async (req, res) => {
  const q = req.query as any;
  const f = auditFilters(q);
  const { limit, offset } = paging(q);

  const [data, total] = await Promise.all([listAuditLogs(f, limit, offset), countAuditLogs(f)]);
  audit(req, 'log.view', 'audit_log');
  res.json({ data, total, limit, offset, ...f });
}));

logsRouter.get('/audit/facets', safe('GET /audit/facets', async (_req, res) => {
  res.json({ data: await getAuditFacets() });
}));

logsRouter.get('/audit/:id', safe('GET /audit/:id', async (req, res) => {
  // ต้องตรวจก่อน ไม่งั้น cast เป็น bigint จะพังเป็น 500 แทนที่จะเป็น 400 (บทเรียนจาก api-logs/:id)
  // req.params ของ Express 5 เป็น string | string[] — ปักเป็น string ก่อนใช้ทุกครั้ง
  const id = String(req.params.id);
  if (!/^\d+$/.test(id)) {
    res.status(400).json({ error: 'id ต้องเป็นตัวเลข' });
    return;
  }
  const row = await getAuditLogById(id);
  if (!row) {
    res.status(404).json({ error: 'ไม่พบรายการนี้ (อาจถูกลบไปแล้วตามอายุการเก็บ)' });
    return;
  }
  res.json(row);
}));

// ── บันทึกระบบ (system) ─────────────────────────────────────────────────────

function systemFilters(q: any) {
  const { dateFrom, dateTo } = dateRange(q);
  return {
    ...(str(q.requestId) ? { requestId: str(q.requestId) } : { dateFrom, dateTo }),
    level: str(q.level),
    minLevel: str(q.minLevel),
    source: str(q.source),
    search: str(q.q),
  };
}

logsRouter.get('/system', safe('GET /system', async (req, res) => {
  const q = req.query as any;
  const f = systemFilters(q);
  const { limit, offset } = paging(q);

  const [data, total, facets] = await Promise.all([
    listSystemLogs(f, limit, offset),
    countSystemLogs(f),
    getSystemLogFacets(f),
  ]);
  audit(req, 'log.view', 'system_log');
  res.json({ data, total, limit, offset, facets, ...f });
}));

/** สถานะงานเบื้องหลัง — หน้า "บันทึกระบบ" แสดงแถบเตือนเมื่อ stale = true */
logsRouter.get('/worker-status', safe('GET /worker-status', async (_req, res) => {
  res.json({ data: await getWorkerStatus() });
}));

// ── ตามรอย request เดียวข้ามทุกตาราง ────────────────────────────────────────

logsRouter.get('/request/:requestId', safe('GET /request/:id', async (req, res) => {
  const id = String(req.params.requestId);
  if (!/^[0-9a-f]{16}$/.test(id)) {
    res.status(400).json({ error: 'request id ต้องเป็นเลขฐานสิบหก 16 ตัว' });
    return;
  }
  res.json({ requestId: id, data: await getRequestTimeline(id) });
}));

// ── ส่งออก CSV ──────────────────────────────────────────────────────────────

/**
 * ส่งออกเป็น CSV — จำเป็นจริง ไม่ใช่ของแถม
 * เป็นรูปแบบที่ต้องส่งมอบเมื่อเจ้าหน้าที่รัฐเรียกดูข้อมูลจราจรตาม พ.ร.บ.คอมพิวเตอร์ ม.26
 *
 * เพดาน 50,000 แถวต่อครั้ง — มากกว่านั้นให้แบ่งช่วงวัน (กัน memory ของแอปพุ่งจาก request เดียว)
 */
const EXPORT_LIMIT = 50_000;

logsRouter.get('/export/:kind', safe('GET /export/:kind', async (req, res) => {
  const kind = String(req.params.kind);
  const q = req.query as any;

  let rows: unknown[];
  if (kind === 'audit') {
    rows = await listAuditLogs(auditFilters(q), EXPORT_LIMIT, 0);
  } else if (kind === 'system') {
    rows = await listSystemLogs(systemFilters(q), EXPORT_LIMIT, 0);
  } else if (kind === 'traffic') {
    const { dateFrom, dateTo } = dateRange(q, 365);
    rows = await listTrafficBuckets(
      GRANULARITY.includes(q.granularity) ? q.granularity : 'day', dateFrom, dateTo);
  } else {
    res.status(400).json({ error: 'kind ต้องเป็น audit, system หรือ traffic' });
    return;
  }

  audit(req, 'log.export', kind, `${rows.length} แถว`);

  if (rows.length === 0) {
    res.status(404).json({ error: 'ไม่มีข้อมูลในช่วงที่เลือก' });
    return;
  }

  const csv = new Parser().parse(rows);
  const stamp = todayThai();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${kind}-${stamp}.csv"`);
  // BOM — ไม่มีแล้ว Excel บน Windows จะอ่านภาษาไทยเป็นตัวยึกยือทั้งไฟล์
  res.send(`﻿${csv}`);
}));
