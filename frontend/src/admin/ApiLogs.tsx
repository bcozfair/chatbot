import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { DateInput } from './DateInput';
import { PageHeader } from './PageHeader';
import { RequestTimeline } from './logs/RequestTimeline';
import { useHashState } from './logs/useHashState';
import {
  errMsg, formatBytes, formatDateTime, formatMs, formatNumber,
  inputCls, monoChipCls, numCls, tdCls, thCls,
} from './logs/format';
import {
  CheckField, Duration, EmptyState, ErrorBox, FilterCard, FilterChip, FilterField,
  FilterFooter, FilterRow, MethodTag, Pagination, SearchField, SelectField,
  SkeletonRows, SortHeader, StatTile, StatusPill, TableCard, TableScroll,
} from './logs/ui';
import { useTableSort } from './logs/useTableSort';
import type { SortAccessors } from './logs/useTableSort';
import { AreaChart, ChartLegend, Donut } from './logs/charts';
import {
  Activity, AlertTriangle, Check, ChevronDown, ChevronUp, Copy, Info, Link2,
  Loader2, RefreshCw, SlidersHorizontal,
} from 'lucide-react';

/**
 * หน้าดูบันทึกการเรียก API — ใครเรียกอะไร เมื่อไหร่ ได้ status อะไร และช้าตรงไหน
 *
 * โครงของหน้า (เรียงจากบนลงล่างตามลำดับที่คนใช้จริง):
 *   1. แถบภาพรวม — ตัวเลขสรุป + ปริมาณรายชั่วโมง ตอบว่า "ช่วงนี้ระบบปกติไหม" ใน 2 วินาที
 *   2. ตัวกรอง   — ช่องที่ใช้บ่อยอยู่แถวเดียว ที่เหลือพับไว้ใต้ "ตัวกรองขั้นสูง"
 *   3. รายการ    — ตารางหลัก กดแถวเพื่อกางรายละเอียด
 *   ส่วนวิเคราะห์เชิงลึก (endpoint ที่กินเวลารวม / 20 อันดับช้าสุด) พับไว้ใน (1)
 *   เพราะเป็นงานที่ทำเดือนละครั้งตอนจะ optimize ไม่ใช่ของที่ต้องเห็นทุกครั้งที่เปิดหน้า
 *
 * ตารางนี้ไม่เก็บ request body โดยตั้งใจ (ดูเหตุผลใน migrations/changes/2026-08-10_01_api_logs.sql)
 * จึงไม่มีอะไรให้กางดูนอกจากข้อมูลของ request เอง
 *
 * ⚠️ "เจ้าของเอกสาร" ไม่ใช่ "ผู้เรียก" — ลิงก์ /download-pdf เป็นลิงก์สาธารณะที่เซลล์ forward
 *    ต่อให้ลูกค้าได้ จึงไม่มีทางรู้ว่าใครกด · ที่แสดงได้คือ "เอกสารนี้เป็นของเซลล์คนไหน"
 *    ทุกที่ที่แสดงค่านี้ต้องมีคำว่า "เอกสารของ" กำกับเสมอ ห้ามปล่อยให้อ่านแล้วเข้าใจว่าเป็นคนกด
 */

const BRAND = 'var(--brand-fg)';

/** ค่าตั้งต้นของตัวกรอง — คีย์ที่ยังเป็นค่านี้จะไม่ถูกเขียนลง URL (ลิงก์ที่ส่งต่อจึงสั้นและอ่านออก) */
const DEFAULTS = {
  q: '', method: '', status: '', minDuration: '',
  requestId: '', lineUserId: '', ip: '',
  dateFrom: '', dateTo: '', page: '1', size: '50',
  sort: 'created_at', dir: 'desc',
};

/** เกณฑ์ของคำว่า "ช้า" ในช่องติ๊กด่วน — ตรงกับเกณฑ์ที่ Duration เริ่มเปลี่ยนสี */
const SLOW_MS = '1000';

interface ApiLogBase {
  id: string;
  created_at: string;
  request_id: string;
  method: string;
  route: string | null;
  path: string;
  status_code: number;
  duration_ms: number;
  resp_bytes: number | null;
  admin_user_id: number | null;
  admin_username: string | null;
  line_user_id: string | null;
  ip: string | null;
  /** เจ้าของใบเสนอราคาของลิงก์ /download-pdf — "ไม่ใช่" คนที่กดลิงก์ (ดูคำเตือนหัวไฟล์) */
  doc_owner_user_id: string | null;
  doc_owner_name: string | null;
  inflight: number | null;
  db_waiting: number | null;
  queue_waited_ms: number | null;
}

/** แถวในตารางรายการ — มี route_group ที่ backend ย่อ path ให้ตอนอ่าน (ดู API_LOG_ROUTE_GROUP) */
interface ApiLogRow extends ApiLogBase {
  route_group: string;
}

/** แถวอื่นที่ใช้ request_id เดียวกัน — เช่นแถว TASK ที่เป็นงานเบื้องหลังของ /callback */
interface RelatedRow {
  id: string; created_at: string; method: string; path: string;
  status_code: number; duration_ms: number; queue_waited_ms: number | null;
}

interface ApiLogDetail extends ApiLogBase {
  related: RelatedRow[];
}

interface RouteStat {
  route: string; count: number; p50: number; p95: number; p99: number;
  max_ms: number; total_ms: string; errors: number;
}
interface HourStat {
  hour: string; count: number; p95: number;
  max_inflight: number | null; max_db_waiting: number | null; errors: number;
}
interface Saturation {
  total: number; max_inflight: number; max_db_waiting: number; db_wait_hits: number;
  errors: number; webhook_dropped: number; webhook_timeout: number;
  p95: number; max_queue_waited: number;
  /** จำนวนแยกตามกลุ่ม status สำหรับกราฟโดนัท — เก่ากว่า migration นี้จะไม่มีค่ามาให้ */
  s2xx?: number; s3xx?: number; s4xx?: number; s5xx?: number;
}
interface Stats {
  byRoute: RouteStat[]; byHour: HourStat[]; slowest: ApiLogBase[];
  saturation: Saturation | null; dateFrom: string; dateTo: string;
}

/**
 * path ถูกเก็บตรงตามที่ client ส่งมาจริง ๆ ซึ่งเป็นรูป URL-encoded เมื่อมีอักษรไทย
 * (/api/%E0%B8%A1%E0%B8%B1%E0%B9%88%E0%B8%A7) — เก็บแบบนั้นถูกแล้วสำหรับ log
 * แต่ตอนแสดงผลต้อง decode ให้คนอ่านออก · ห่อ try เพราะ % ที่ไม่ครบชุดจะทำให้ decode โยน error
 */
function decodePath(p: string): string {
  if (!p || !p.includes('%')) return p;
  try { return decodeURIComponent(p); } catch { return p; }
}

/** '2026-09-07 11:00' → '07/09 11:00 น.' — ปีไม่ต้องแสดง กราฟนี้ยาวสุด 90 วัน */
function hourLabel(h: string): string {
  const [d, t] = h.split(' ');
  const [, mo, day] = d.split('-');
  return `${day}/${mo} ${t} น.`;
}

/** Date → '2026-09-07 11:00' — อ่าน/เขียนด้วย UTC ล้วนโดยตั้งใจ (ดู fillHours) */
function hourKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:00`;
}

/**
 * เติมชั่วโมงที่ไม่มี request เลยให้เป็น 0
 *
 * SQL คืนเฉพาะชั่วโมงที่มีแถว (GROUP BY) ⇒ ตี 1 ถึงตี 5 ที่ไม่มีใครใช้งานจะ "หายไปทั้งชั่วโมง"
 * ตอนเป็นกราฟแท่งความผิดนี้มองไม่เห็นเพราะแท่งเรียงชิดกันอยู่แล้ว แต่กราฟเส้นจะลากตรง
 * ข้ามช่วงที่เงียบ กลายเป็นบอกว่ากลางดึกมีทราฟฟิกพอ ๆ กับตอนเย็น ซึ่งไม่จริง
 *
 * สตริงจาก SQL เป็นเวลาไทยที่จัดรูปมาแล้ว จึงอ่านเป็น UTC และเดินทีละชั่วโมงแบบ UTC
 * ห้ามใช้ตัวช่วยเวลาท้องถิ่น — เครื่องที่ตั้งโซนอื่นจะได้ชั่วโมงเลื่อนไปทั้งแถว
 */
function fillHours(rows: HourStat[]): HourStat[] {
  if (rows.length < 2) return rows;
  const found = new Map(rows.map(r => [r.hour, r]));
  const cursor = new Date(`${rows[0].hour.replace(' ', 'T')}:00Z`);
  const end = new Date(`${rows[rows.length - 1].hour.replace(' ', 'T')}:00Z`).getTime();
  const out: HourStat[] = [];
  // เพดานกันลูปหลุด: 90 วัน = 2,160 จุด ซึ่งยังน้อยกว่านี้มาก
  while (cursor.getTime() <= end && out.length < 5000) {
    const key = hourKey(cursor);
    out.push(found.get(key) ?? {
      hour: key, count: 0, p95: 0, max_inflight: null, max_db_waiting: null, errors: 0,
    });
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return out;
}

function shortUser(id: string | null): string | null {
  if (!id) return null;
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'TASK'];

/** คอลัมน์ที่เรียงได้ของตาราง "endpoint ที่กินเวลาเครื่องรวม" — total_ms มาเป็นสตริง (bigint) ต้องแปลงก่อนเทียบ */
const ROUTE_SORTS: SortAccessors<RouteStat> = {
  route: r => r.route,
  count: r => r.count,
  p50: r => r.p50,
  p95: r => r.p95,
  p99: r => r.p99,
  max_ms: r => r.max_ms,
  errors: r => r.errors,
  total_ms: r => Number(r.total_ms),
};

/** คอลัมน์ที่เรียงได้ของตาราง 20 อันดับช้าสุด — "ผู้เรียก" รวมสามแหล่งเป็นข้อความเดียวเพื่อให้เรียงได้ */
const SLOWEST_SORTS: SortAccessors<ApiLogBase> = {
  created_at: r => r.created_at,
  path: r => r.path,
  caller: r => r.admin_username ?? r.line_user_id ?? null,
  status_code: r => r.status_code,
  duration_ms: r => r.duration_ms,
};

/** คอลัมน์ที่เริ่มด้วยการเรียงจากน้อยไปมาก — ที่เหลือเป็นตัวเลข เริ่มจากมากไปน้อย */
const TEXT_COLS = new Set(['route', 'path', 'caller', 'method']);

export function ApiLogs() {
  const { token } = useAuth();
  const { state, set, reset } = useHashState('apilogs', DEFAULTS);
  const searchRef = useRef<HTMLInputElement>(null);

  const page = Math.max(1, parseInt(state.page) || 1);
  const size = parseInt(state.size) || 50;

  /** เปิด/ปิดส่วนวิเคราะห์เชิงลึก และตัวกรองขั้นสูง — เป็นสภาพการมองเห็น ไม่ใช่ตัวกรอง จึงไม่ลง URL */
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);

  const authFetch = useCallback(
    (url: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
    [token]);

  // ── ภาพรวม ────────────────────────────────────────────────────────────────
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const dateQs = `${state.dateFrom ? `&dateFrom=${state.dateFrom}` : ''}${state.dateTo ? `&dateTo=${state.dateTo}` : ''}`;

  const loadStats = useCallback(async () => {
    setStatsLoading(true); setStatsError(null);
    try {
      const res = await authFetch(`/api/admin/api-logs/stats?_=1${dateQs}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setStats(await res.json());
    } catch (e: unknown) { setStatsError(errMsg(e)); } finally { setStatsLoading(false); }
  }, [authFetch, dateQs]);

  // ── รายการ ────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<ApiLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiLogDetail | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setListLoading(true); setListError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('limit', String(size));
      qs.set('offset', String((page - 1) * size));
      if (state.dateFrom) qs.set('dateFrom', state.dateFrom);
      if (state.dateTo) qs.set('dateTo', state.dateTo);
      if (state.q.trim()) qs.set('path', state.q.trim());
      if (state.method) qs.set('method', state.method);
      if (state.status) qs.set('status', state.status);
      if (state.minDuration) qs.set('minDuration', state.minDuration);
      if (state.requestId.trim()) qs.set('requestId', state.requestId.trim());
      if (state.lineUserId.trim()) qs.set('lineUserId', state.lineUserId.trim());
      if (state.ip.trim()) qs.set('ip', state.ip.trim());
      // เรียงที่ SQL ไม่ใช่ที่หน้าจอ — ตารางนี้แบ่งหน้าจาก server การเรียงเฉพาะ 50 แถวที่เห็น
      // จะให้ลำดับที่ผิดโดยดูเหมือนถูก (แถวที่ช้าที่สุดจริง ๆ อาจอยู่หน้า 7)
      qs.set('sort', state.sort);
      qs.set('dir', state.dir);

      const res = await authFetch(`/api/admin/api-logs?${qs}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const json = await res.json();
      setRows(json.data); setTotal(json.total);
    } catch (e: unknown) { setListError(errMsg(e)); } finally { setListLoading(false); }
  }, [authFetch, page, size, state.dateFrom, state.dateTo, state.q, state.method,
      state.status, state.minDuration, state.requestId, state.lineUserId, state.ip,
      state.sort, state.dir]);

  // ทั้งสองตัวยิงผ่าน setTimeout ไม่เรียก setState ตรง ๆ ในตัว effect
  // (loadStats/loadList เซ็ต loading ทันทีที่ถูกเรียก ซึ่งกฎ react-hooks/set-state-in-effect ห้ามไว้
  //  — pattern เดียวกับ Quotations.tsx) และการหน่วงยังช่วยรวบการพิมพ์รัวในช่องค้นหาไปในตัว
  useEffect(() => {
    const t = setTimeout(() => { void loadStats(); }, 0);
    return () => clearTimeout(t);
  }, [loadStats]);

  useEffect(() => {
    const t = setTimeout(() => { void loadList(); }, 300);
    return () => clearTimeout(t);
  }, [loadList]);

  // กด / เพื่อโฟกัสช่องค้นหา — กติกาเดียวกันทั้ง 4 หน้าในกลุ่ม
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        || el instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape') { setExpandedId(null); setDetail(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openDetail = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); setDetail(null); return; }
    setExpandedId(id); setDetail(null);
    const res = await authFetch(`/api/admin/api-logs/${id}`);
    if (res.ok) setDetail(await res.json());
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  };

  /** จาก "20 อันดับช้าสุด" มาที่รายการ โดยเหลือเงื่อนไขเดียวคือ request นั้น */
  const jumpToRequest = (rid: string) => {
    set({ ...DEFAULTS, requestId: rid });
    setShowAdvanced(true);
    setShowAnalysis(false);
  };

  const pages = Math.max(1, Math.ceil(total / size));
  const sat = stats?.saturation;
  /** ชั่วโมงที่จะพล็อต — เติมชั่วโมงที่ไม่มี request ให้เป็น 0 ก่อนเสมอ (ดู fillHours) */
  const hours = useMemo(() => fillHours(stats?.byHour ?? []), [stats]);

  // สองตารางนี้โหลดมาครบแล้ว (ไม่แบ่งหน้า) จึงเรียงในหน้าได้ตรง ๆ ต่างจากตารางรายการข้างล่าง
  const byRoute = useMemo(() => stats?.byRoute ?? [], [stats]);
  const slowest = useMemo(() => stats?.slowest ?? [], [stats]);
  const routeSort = useTableSort(byRoute, ROUTE_SORTS, { col: 'total_ms', dir: 'desc' });
  const slowSort = useTableSort(slowest, SLOWEST_SORTS, { col: 'duration_ms', dir: 'desc' });

  /** ทิศของตารางรายการ — เก็บใน hash เป็นสตริง จึงต้องบีบให้เหลือสองค่าก่อนใช้ */
  const listDir: 'asc' | 'desc' = state.dir === 'asc' ? 'asc' : 'desc';
  /** กดหัวเดิม = สลับทิศ · กดหัวใหม่ = เริ่มจากทิศที่ใช้บ่อยที่สุดของคอลัมน์นั้น */
  const sortList = (col: string) => set({
    sort: col,
    dir: state.sort === col
      ? (listDir === 'desc' ? 'asc' : 'desc')
      : (TEXT_COLS.has(col) ? 'asc' : 'desc'),
    page: '1',
  });
  const maxTotalMs = Math.max(1, ...(stats?.byRoute ?? []).map(r => Number(r.total_ms)));

  /** ชิปของตัวกรองที่ค้างอยู่ — โดยเฉพาะตัวที่ถูกพับไว้ ต้องมีอะไรบอกว่ายังกรองอยู่ */
  const chips = useMemo(() => {
    const out: { key: keyof typeof DEFAULTS; label: string; value: string }[] = [];
    if (state.q) out.push({ key: 'q', label: 'path', value: state.q });
    if (state.method) out.push({ key: 'method', label: 'method', value: state.method });
    if (state.status) out.push({ key: 'status', label: 'status', value: state.status });
    if (state.minDuration) out.push({ key: 'minDuration', label: 'ช้ากว่า', value: `${state.minDuration} ms` });
    if (state.requestId) out.push({ key: 'requestId', label: 'Request ID', value: state.requestId });
    if (state.lineUserId) out.push({ key: 'lineUserId', label: 'LINE User', value: state.lineUserId });
    if (state.ip) out.push({ key: 'ip', label: 'IP', value: state.ip });
    return out;
  }, [state]);

  const advancedActive = !!(state.requestId || state.lineUserId || state.ip);

  return (
    <div className="space-y-4">
      <PageHeader icon={Activity} title="บันทึกการเรียก API"
                  description="ใครเรียกอะไร เมื่อไหร่ ได้ status อะไร และช้าตรงไหน">
        <button
          onClick={() => { void loadStats(); void loadList(); }}
          disabled={statsLoading || listLoading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium
                     border border-slate-200 text-slate-600 hover:bg-slate-50 transition disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${statsLoading || listLoading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">โหลดใหม่</span>
        </button>
      </PageHeader>

      {/* ══════════ 1. ภาพรวมของช่วงที่เลือก ══════════ */}
      {statsError && <ErrorBox message={statsError} onRetry={() => { void loadStats(); }} />}

      {sat && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="จำนวน request" value={formatNumber(sat.total)}
                      sub={`${stats?.dateFrom} → ${stats?.dateTo}`} />
            <StatTile label="p95 ของเวลาตอบ" value={formatMs(sat.p95)}
                      sub="95% ของ request เร็วกว่านี้" />
            <StatTile label="อัตรา error"
                      value={sat.total ? `${(sat.errors * 100 / sat.total).toFixed(1)}%` : '-'}
                      sub={`${formatNumber(sat.errors)} ครั้ง (4xx/5xx)`}
                      danger={sat.total > 0 && sat.errors / sat.total > 0.05} />
            <StatTile label="request พร้อมกันสูงสุด" value={String(sat.max_inflight)}
                      sub={sat.db_wait_hits > 0
                        ? `⚠ connection pool ไม่พอ ${formatNumber(sat.db_wait_hits)} ครั้ง`
                        : 'connection pool เพียงพอตลอดช่วง'}
                      danger={sat.db_wait_hits > 0} />
          </div>

          {/* เตือนเรื่อง webhook โดยเฉพาะ — เป็นภาระหนักที่สุดของระบบ
              บีบเหลือบรรทัดเดียว: ตัวเลขอยู่บนแถบ ส่วนวิธีอ่านตัวเลขย้ายไปอยู่ใน tooltip
              (คำอธิบายยาว ๆ ที่ต้องอ่านทุกครั้งที่ผ่านตา สุดท้ายกลายเป็นสิ่งที่ไม่มีใครอ่าน) */}
          {(sat.webhook_dropped > 0 || sat.webhook_timeout > 0 || sat.max_queue_waited > 5000) && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5
                            flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-amber-700">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
              <span className="font-medium text-amber-800">คิวข้อความ LINE</span>
              <span>รอนานสุด <b>{formatMs(sat.max_queue_waited)}</b></span>
              {sat.webhook_dropped > 0 && <span>· ถูกทิ้ง <b>{sat.webhook_dropped}</b></span>}
              {sat.webhook_timeout > 0 && <span>· หมดเวลา <b>{sat.webhook_timeout}</b></span>}
              <span
                title="รอคิวนาน = ทรัพยากร/ความขนานไม่พอ · รอคิวสั้นแต่เวลารวมนาน = ตัวงานเองช้า ต้องแก้โค้ด"
                className="text-amber-600 cursor-help"
              >
                <Info className="w-3.5 h-3.5" />
              </span>
            </div>
          )}

          {/* กราฟรายชั่วโมง + สัดส่วนสถานะ — ทั้งคู่วาดด้วย SVG เอง (ดูเหตุผลใน charts.tsx) */}
          <div className="grid grid-cols-1 xl:grid-cols-5 gap-3 items-stretch">
            {hours.length > 0 && (
              <div className="xl:col-span-3">
                <TableCard
                  className="h-full"
                  title="ปริมาณรายชั่วโมง (เวลาไทย)"
                  hint="ชี้ที่กราฟเพื่อดูค่าของชั่วโมงนั้น · ขีดแดงใต้แกน = ชั่วโมงที่ connection pool ไม่พอ"
                  action={
                    <ChartLegend items={[
                      { label: 'สำเร็จ', color: BRAND },
                      { label: 'ผิดพลาด', color: 'var(--color-red-600)' },
                    ]} />
                  }
                >
                  <div className="px-2 pt-2 pb-1">
                    <AreaChart
                      height={210}
                      labels={hours.map(h => hourLabel(h.hour))}
                      marks={hours.map(h => (h.max_db_waiting ?? 0) > 0)}
                      markHint="ชั่วโมงนี้มี request ที่ต้องรอ connection pool"
                      series={[
                        {
                          key: 'ok', label: 'สำเร็จ', color: BRAND,
                          values: hours.map(h => Math.max(0, h.count - h.errors)),
                        },
                        {
                          key: 'err', label: 'ผิดพลาด (4xx/5xx)', color: 'var(--color-red-600)',
                          values: hours.map(h => h.errors),
                        },
                      ]}
                      extra={(i) => {
                        const h = hours[i];
                        return `p95 ${formatMs(h.p95)} · พร้อมกันสูงสุด ${h.max_inflight ?? '-'}`
                          + ((h.max_db_waiting ?? 0) > 0 ? ' · pool ไม่พอ' : '');
                      }}
                    />
                  </div>
                </TableCard>
              </div>
            )}

            <div className="xl:col-span-2">
              <TableCard title="สัดส่วนสถานะ" className="h-full flex flex-col"
                         hint="ชี้ที่วงเพื่อดูตัวเลขของกลุ่มนั้น">
                {/* จัดกึ่งกลางแนวตั้ง — การ์ดถูกยืดให้สูงเท่ากราฟเส้น วงจึงต้องไม่ลอยไปติดขอบบน */}
                <div className="p-4 flex-1 flex items-center justify-center">
                  <Donut
                    size={150}
                    centerLabel="request ทั้งหมด"
                    slices={[
                      { key: '2xx', label: 'สำเร็จ (2xx)', value: sat.s2xx ?? 0, color: 'var(--brand-fg)' },
                      { key: '3xx', label: 'เปลี่ยนทาง (3xx)', value: sat.s3xx ?? 0, color: 'var(--color-blue-600)' },
                      { key: '4xx', label: 'ผิดฝั่งผู้เรียก (4xx)', value: sat.s4xx ?? 0, color: 'var(--color-amber-500)' },
                      { key: '5xx', label: 'ผิดฝั่งระบบ (5xx)', value: sat.s5xx ?? 0, color: 'var(--color-red-600)' },
                    ]}
                  />
                </div>
              </TableCard>
            </div>
          </div>

          {/* ปุ่มกางส่วนวิเคราะห์ — แยกออกมาเป็นแถวของตัวเองเพราะมันคุมทั้งสองการ์ดข้างล่าง
              ไม่ใช่ของการ์ดใดการ์ดหนึ่ง */}
          <button
            onClick={() => setShowAnalysis(v => !v)}
            aria-expanded={showAnalysis}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-2xl
                       border border-dashed border-slate-200 text-xs font-medium
                       hover:border-slate-300 transition-colors"
            style={{ color: BRAND }}
          >
            {showAnalysis
              ? 'ซ่อนรายละเอียดประสิทธิภาพ'
              : 'ดูรายละเอียดประสิทธิภาพ (endpoint ที่กินเวลารวม · 20 อันดับช้าสุด)'}
            {showAnalysis ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {/* ── ส่วนวิเคราะห์เชิงลึก (พับไว้) ── */}
          {showAnalysis && (
            <>
              <TableCard
                title="endpoint ที่กินเวลาเครื่องรวมมากที่สุด"
                hint='เรียงตาม "เวลารวม" ไม่ใช่ตัวที่ช้าที่สุด — ตัวที่กินเวลาเครื่องรวมมากที่สุดคือตัวที่ควร optimize ก่อน'
              >
                <TableScroll>
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        {([
                          ['endpoint', 'route', 'left'],
                          ['ครั้ง', 'count', 'right'],
                          ['p50', 'p50', 'right'],
                          ['p95', 'p95', 'right'],
                          ['p99', 'p99', 'right'],
                          ['สูงสุด', 'max_ms', 'right'],
                          ['error', 'errors', 'right'],
                          ['เวลารวม', 'total_ms', 'left'],
                        ] as const).map(([label, col, align]) => (
                          <SortHeader
                            key={col} label={label} col={col} align={align}
                            className={col === 'total_ms' ? 'w-48' : undefined}
                            active={routeSort.col} dir={routeSort.dir}
                            onSort={(c) => routeSort.toggle(c, !TEXT_COLS.has(c))}
                          />
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {routeSort.sorted.map((r) => (
                        <tr key={r.route} className="hover:bg-slate-50/60">
                          <td className={`${tdCls} font-mono text-xs text-slate-700`}>{decodePath(r.route)}</td>
                          <td className={`${tdCls} ${numCls} text-slate-600`}>{formatNumber(r.count)}</td>
                          <td className={`${tdCls} ${numCls} text-slate-500`}>{formatMs(r.p50)}</td>
                          <td className={`${tdCls} ${numCls}`}><Duration ms={r.p95} /></td>
                          <td className={`${tdCls} ${numCls}`}><Duration ms={r.p99} /></td>
                          <td className={`${tdCls} ${numCls}`}><Duration ms={r.max_ms} /></td>
                          <td className={`${tdCls} ${numCls}`}>
                            {r.errors > 0
                              ? <span className="text-red-600">{r.errors}</span>
                              : <span className="text-slate-300">0</span>}
                          </td>
                          <td className={tdCls}>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full rounded-full"
                                  style={{ width: `${Number(r.total_ms) / maxTotalMs * 100}%`, background: 'var(--brand)' }} />
                              </div>
                              <span className="text-xs text-slate-500 tabular-nums w-16 text-right">
                                {(Number(r.total_ms) / 1000).toFixed(1)} วิ
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {byRoute.length === 0 && (
                        <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">ไม่มีข้อมูลในช่วงนี้</td></tr>
                      )}
                    </tbody>
                  </table>
                </TableScroll>
              </TableCard>

              <TableCard title="20 request ที่ช้าที่สุดในช่วงนี้"
                         hint="กดแถวเพื่อกรองรายการข้างล่างให้เหลือเฉพาะ request นั้น">
                <TableScroll>
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        {([
                          ['เวลา', 'created_at', 'left'],
                          ['endpoint', 'path', 'left'],
                          ['ผู้เรียก', 'caller', 'left'],
                          ['status', 'status_code', 'center'],
                          ['ใช้เวลา', 'duration_ms', 'right'],
                        ] as const).map(([label, col, align]) => (
                          <SortHeader
                            key={col} label={label} col={col} align={align}
                            active={slowSort.col} dir={slowSort.dir}
                            onSort={(c) => slowSort.toggle(c, !TEXT_COLS.has(c))}
                          />
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {slowSort.sorted.map((r) => (
                        <tr key={r.id} onClick={() => jumpToRequest(r.request_id)}
                          className="hover:bg-slate-50/60 cursor-pointer">
                          <td className={`${tdCls} text-slate-500 text-xs whitespace-nowrap`}>{formatDateTime(r.created_at)}</td>
                          <td className={tdCls}>
                            <div className="flex items-center gap-1.5">
                              <MethodTag method={r.method} />
                              <span className="font-mono text-xs text-slate-700">{decodePath(r.path)}</span>
                            </div>
                          </td>
                          <td className={`${tdCls} text-xs text-slate-500`}>
                            {r.admin_username ?? shortUser(r.line_user_id) ?? '-'}
                          </td>
                          <td className={`${tdCls} text-center`}><StatusPill code={r.status_code} /></td>
                          <td className={`${tdCls} ${numCls}`}>
                            <Duration ms={r.duration_ms} />
                            {r.queue_waited_ms !== null && (
                              <div className="text-[11px] text-slate-400 font-normal">
                                รอคิว {formatMs(r.queue_waited_ms)}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                      {slowest.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">ไม่มีข้อมูลในช่วงนี้</td></tr>
                      )}
                    </tbody>
                  </table>
                </TableScroll>
              </TableCard>
            </>
          )}
        </>
      )}

      {statsLoading && !stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-card border border-slate-200 rounded-2xl p-3.5 animate-pulse">
              <div className="h-3 w-24 bg-slate-100 rounded" />
              <div className="h-7 w-20 bg-slate-200 rounded mt-2" />
            </div>
          ))}
        </div>
      )}

      {/* ══════════ 2. ตัวกรอง ══════════ */}
      <FilterCard>
        <FilterRow>
          <FilterField label="ค้นหา path" grow>
            <SearchField
              ref={searchRef}
              value={state.q}
              onChange={(v) => set({ q: v, page: '1' })}
              placeholder="เช่น /api/quotation … (กด / เพื่อโฟกัส)"
            />
          </FilterField>
          <FilterField label="method" width="w-36">
            <SelectField value={state.method} onChange={(v) => set({ method: v, page: '1' })}>
              <option value="">ทุก method</option>
              {METHODS.map(m => <option key={m} value={m}>{m}{m === 'TASK' ? ' (งานเบื้องหลัง)' : ''}</option>)}
            </SelectField>
          </FilterField>
          <FilterField label="สถานะ" width="w-40">
            <SelectField value={state.status} onChange={(v) => set({ status: v, page: '1' })}>
              <option value="">ทุก status</option>
              <option value="2xx">2xx สำเร็จ</option>
              <option value="4xx">4xx ผิดฝั่งผู้เรียก</option>
              <option value="5xx">5xx ผิดฝั่งระบบ</option>
            </SelectField>
          </FilterField>
          <FilterField label="ตั้งแต่" width="w-36">
            <DateInput value={state.dateFrom} onChange={(v) => set({ dateFrom: v, page: '1' })}
                       className={inputCls} aria-label="ตั้งแต่วันที่" />
          </FilterField>
          <FilterField label="ถึง" width="w-36">
            <DateInput value={state.dateTo} onChange={(v) => set({ dateTo: v, page: '1' })}
                       className={inputCls} aria-label="ถึงวันที่" />
          </FilterField>
          <div className="pb-px">
            <CheckField
              checked={!!state.minDuration}
              onChange={(v) => set({ minDuration: v ? SLOW_MS : '', page: '1' })}
              label="เฉพาะที่ช้า"
              hint={`เฉพาะ request ที่ใช้เวลาตั้งแต่ ${SLOW_MS} ms ขึ้นไป (ตั้งค่าละเอียดได้ในตัวกรองขั้นสูง)`}
            />
          </div>
        </FilterRow>

        {showAdvanced && (
          <FilterRow>
            <FilterField label="Request ID" grow>
              <input value={state.requestId} onChange={(e) => set({ requestId: e.target.value, page: '1' })}
                placeholder="ค้นได้โดยไม่ต้องรู้วันที่"
                className={`${inputCls} font-mono text-xs`} />
            </FilterField>
            <FilterField label="LINE User ID" grow>
              <input value={state.lineUserId} onChange={(e) => set({ lineUserId: e.target.value, page: '1' })}
                placeholder="U1234…"
                className={`${inputCls} font-mono text-xs`} />
            </FilterField>
            {/* กรองด้วย IP = ดูว่า "เครื่องเดียวกันนี้" เรียกอะไรไปบ้างในช่วงเวลานั้น ซึ่งเป็นวิธีเดียว
                ที่พอจะบอกได้ว่าคนที่กดลิงก์ PDF สาธารณะเป็นเซลล์เจ้าของใบเองหรือคนอื่น */}
            <FilterField label="IP ต้นทาง" grow>
              <input value={state.ip} onChange={(e) => set({ ip: e.target.value, page: '1' })}
                placeholder="กดที่ IP ในตารางเพื่อกรองได้เลย"
                className={`${inputCls} font-mono text-xs`} />
            </FilterField>
            <FilterField label="ช้ากว่า (ms)" width="w-32">
              <input value={state.minDuration} inputMode="numeric"
                onChange={(e) => set({ minDuration: e.target.value.replace(/\D/g, ''), page: '1' })}
                placeholder="1000"
                className={inputCls} />
            </FilterField>
          </FilterRow>
        )}

        <FilterFooter onReset={chips.length ? reset : undefined}
                      loading={listLoading} total={total} unit="รายการ">
          <button
            onClick={() => setShowAdvanced(v => !v)}
            aria-expanded={showAdvanced}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-colors ${
              advancedActive
                ? ''
                : 'border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}
            style={advancedActive
              ? { backgroundColor: 'var(--brand-soft)', borderColor: 'var(--brand-border)', color: BRAND }
              : undefined}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            ตัวกรองขั้นสูง
            {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {chips.map(c => (
            <FilterChip key={c.key} label={c.label} value={c.value}
                        onRemove={() => set({ [c.key]: '', page: '1' })} />
          ))}

          {state.requestId && (
            <span className="text-slate-400">ค้นด้วย Request ID จะข้ามเงื่อนไขช่วงวันทั้งหมด</span>
          )}
        </FilterFooter>
      </FilterCard>

      {/* ══════════ 3. รายการ ══════════ */}
      {listError && <ErrorBox message={listError} onRetry={() => { void loadList(); }} />}

      <TableCard>
        {listLoading && rows.length === 0 && <SkeletonRows rows={8} />}

        {!listLoading && rows.length === 0 && !listError && (
          <EmptyState
            icon={Activity}
            title="ไม่พบรายการตามเงื่อนไขนี้"
            hint={chips.length > 0
              ? 'มีตัวกรองค้างอยู่ — ลองเอาชิปเงื่อนไขข้างบนออกทีละอัน'
              : 'ไม่ระบุช่วงวัน = 7 วันล่าสุด · ถ้าเพิ่งติดตั้งระบบ ข้อมูลอาจยังไม่ถูกบันทึก'}
          />
        )}

        {rows.length > 0 && (
          <TableScroll>
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <SortHeader label="เวลา" col="created_at" active={state.sort} dir={listDir} onSort={sortList} />
                  <SortHeader label="endpoint" col="path" active={state.sort} dir={listDir} onSort={sortList} />
                  {/* "ผู้เรียก" เรียงไม่ได้โดยตั้งใจ — ค่าในช่องนี้มาจากสามแหล่ง (แอดมิน / LINE /
                      เจ้าของเอกสาร) การเรียงจะได้ลำดับที่ไม่มีความหมายและชวนให้เข้าใจผิดว่าเทียบกันได้ */}
                  <th className={thCls}>ผู้เรียก</th>
                  <SortHeader label="สถานะ" col="status_code" align="center"
                              active={state.sort} dir={listDir} onSort={sortList} />
                  <SortHeader label="ใช้เวลา" col="duration_ms" align="right"
                              active={state.sort} dir={listDir} onSort={sortList} />
                  <SortHeader label="ขนาด" col="resp_bytes" align="right"
                              active={state.sort} dir={listDir} onSort={sortList} />
                  <th className={`${thCls} w-8`} />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <React.Fragment key={r.id}>
                    <tr onClick={() => { void openDetail(r.id); }}
                        className="hover:bg-slate-50/60 cursor-pointer">
                      <td className={`${tdCls} text-slate-500 text-xs whitespace-nowrap`}>
                        {formatDateTime(r.created_at)}
                      </td>
                      <td className={tdCls}>
                        <div className="flex items-center gap-1.5">
                          <MethodTag method={r.method} />
                          <span className="font-mono text-xs text-slate-700 break-all">{decodePath(r.path)}</span>
                        </div>
                        {r.route_group !== r.path && (
                          <div className="font-mono text-[11px] text-slate-400 mt-0.5 pl-[3.125rem]">
                            {decodePath(r.route_group)}
                          </div>
                        )}
                      </td>
                      <td className={`${tdCls} text-xs`}>
                        {r.admin_username
                          ? <span className="text-slate-700">{r.admin_username}</span>
                          : r.line_user_id
                            ? <span className="font-mono text-slate-500">{shortUser(r.line_user_id)}</span>
                            : r.doc_owner_user_id
                              // ลิงก์สาธารณะ ไม่มีล็อกอิน = ไม่รู้ว่าใครกด บอกได้แค่ว่าเอกสารของใคร
                              ? <span className="text-slate-400" title="เอกสารของเซลล์คนนี้ — ไม่ได้แปลว่าเป็นคนกดลิงก์ ลิงก์นี้เปิดได้โดยไม่ต้องล็อกอิน">
                                  เอกสารของ {r.doc_owner_name ?? shortUser(r.doc_owner_user_id)}
                                </span>
                              : <span className="text-slate-300">-</span>}
                        {r.ip && (
                          <button
                            onClick={(e) => { e.stopPropagation(); set({ ip: r.ip!, page: '1' }); setShowAdvanced(true); }}
                            title="กรองเฉพาะ request ที่มาจาก IP นี้"
                            className="font-mono text-[11px] text-slate-400 hover:text-slate-700 hover:underline mt-0.5 block">
                            {r.ip}
                          </button>
                        )}
                      </td>
                      <td className={`${tdCls} text-center`}><StatusPill code={r.status_code} /></td>
                      <td className={`${tdCls} ${numCls} whitespace-nowrap`}>
                        <Duration ms={r.duration_ms} />
                        {/* /callback ตอบ 200 กลับ LINE ทันทีก่อนเริ่มทำงาน ตัวเลขนี้จึงเป็นเวลารับ ไม่ใช่เวลาทำงาน */}
                        {r.path === '/callback' && (
                          <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-normal"
                            title="ตอบ 200 กลับ LINE ทันทีก่อนเริ่มทำงาน — เวลาทำงานจริงอยู่ที่แถว TASK ที่ Request ID เดียวกัน">
                            ACK
                          </span>
                        )}
                        {r.queue_waited_ms !== null && (
                          <div className="text-[11px] text-slate-400 font-normal">รอคิว {formatMs(r.queue_waited_ms)}</div>
                        )}
                      </td>
                      <td className={`${tdCls} ${numCls} text-xs text-slate-400`}>{formatBytes(r.resp_bytes)}</td>
                      <td className={`${tdCls} text-slate-300`}>
                        {expandedId === r.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </td>
                    </tr>

                    {expandedId === r.id && (
                      <tr>
                        <td colSpan={7} className="bg-slate-50/70 px-4 py-4">
                          {!detail
                            ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                            : (
                              <div className="space-y-3">
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                  <Field label="Request ID">
                                    <button onClick={() => copy(detail.request_id)}
                                      className="font-mono inline-flex items-center gap-1.5 text-slate-700 hover:text-slate-900">
                                      {detail.request_id}
                                      {copied === detail.request_id
                                        ? <Check className="w-3 h-3 text-emerald-600" />
                                        : <Copy className="w-3 h-3 text-slate-400" />}
                                    </button>
                                  </Field>
                                  <Field label="route ที่ระบบรู้จัก">
                                    <span className="font-mono">{detail.route ?? <span className="text-slate-400">— (ย่อจาก path ตอนแสดงผล)</span>}</span>
                                  </Field>
                                  <Field label="request พร้อมกันตอนนั้น">{detail.inflight ?? '-'}</Field>
                                  <Field label="คิวรอ DB ตอนนั้น">
                                    {detail.db_waiting === null ? '-' :
                                      detail.db_waiting > 0
                                        ? <span className="text-red-600">{detail.db_waiting} (pool ไม่พอ)</span>
                                        : '0'}
                                  </Field>
                                  <Field label="LINE User ID">
                                    <span className="font-mono break-all">{detail.line_user_id ?? '-'}</span>
                                  </Field>
                                  <Field label="ผู้ใช้ระบบ">
                                    {detail.admin_username ?? (detail.admin_user_id ? `#${detail.admin_user_id} (ถูกลบแล้ว)` : '-')}
                                  </Field>
                                  <Field label="IP ต้นทาง">
                                    <span className="font-mono">{detail.ip ?? '-'}</span>
                                  </Field>
                                  <Field label="เจ้าของเอกสาร (ไม่ใช่คนกดลิงก์)">
                                    {detail.doc_owner_user_id
                                      ? <span title={detail.doc_owner_user_id}>
                                          {detail.doc_owner_name ?? shortUser(detail.doc_owner_user_id)}
                                        </span>
                                      : '-'}
                                  </Field>
                                  <Field label="ขนาดที่ตอบกลับ">{formatBytes(detail.resp_bytes)}</Field>
                                  <Field label="เวลารอคิว">
                                    {detail.queue_waited_ms === null ? '-' : formatMs(detail.queue_waited_ms)}
                                  </Field>
                                </div>

                                <div className="text-xs">
                                  <div className="text-slate-400 mb-1">path เต็ม</div>
                                  <code className={`block ${monoChipCls} px-3 py-2 break-all`}>
                                    {decodePath(detail.path)}
                                  </code>
                                </div>

                                {detail.related?.length > 0 && (
                                  <div className="text-xs">
                                    <div className="text-slate-400 mb-1">
                                      แถวอื่นที่ Request ID เดียวกัน (งานเบื้องหลังของ request นี้)
                                    </div>
                                    <div className="space-y-1">
                                      {detail.related.map((rel) => (
                                        <div key={rel.id}
                                          className="flex items-center gap-3 bg-card border border-slate-200 rounded-lg px-3 py-2">
                                          <MethodTag method={rel.method} />
                                          <span className="font-mono text-slate-700 flex-1 break-all">{decodePath(rel.path)}</span>
                                          <StatusPill code={rel.status_code} />
                                          <Duration ms={rel.duration_ms} />
                                          {rel.queue_waited_ms !== null && (
                                            <span className="text-slate-400">รอคิว {formatMs(rel.queue_waited_ms)}</span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-slate-400">
                                  <button
                                    onClick={() => setTimelineFor(detail.request_id)}
                                    className="inline-flex items-center gap-1 hover:underline"
                                    style={{ color: BRAND }}
                                  >
                                    <Link2 className="w-3.5 h-3.5" />
                                    ดูทุกอย่างของ request นี้ (รวมการแก้ไข + บันทึกระบบ)
                                  </button>
                                  <span>
                                    ระบบไม่เก็บเนื้อหาที่ส่งมากับ request (ทั้ง body และ query) โดยตั้งใจ
                                    เพื่อให้ log เบาและไม่มีข้อมูลส่วนบุคคลของลูกค้า
                                  </span>
                                </div>
                              </div>
                            )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        {total > 0 && (
          <Pagination
            page={Math.min(page, pages)}
            pages={pages}
            size={size}
            total={total}
            onPage={(p) => set({ page: String(p) })}
            onSize={(s) => set({ size: String(s), page: '1' })}
          />
        )}
      </TableCard>

      {timelineFor && (
        <RequestTimeline requestId={timelineFor} onClose={() => setTimelineFor(null)} />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-slate-400 mb-0.5">{label}</div>
      <div className="text-slate-700">{children}</div>
    </div>
  );
}
