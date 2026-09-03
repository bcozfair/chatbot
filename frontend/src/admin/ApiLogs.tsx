import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { DateInput } from './DateInput';
import {
  Activity,
  Gauge,
  Search,
  Filter,
  Calendar,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  AlertTriangle,
  Clock,
  Copy,
  Check,
  X,
} from 'lucide-react';

/**
 * หน้าดูบันทึกการเรียก API — ตอบ 2 คำถาม
 *   แท็บ "ภาพรวม"  → endpoint ไหนช้า ช่วงไหนโหลดหนัก ทรัพยากรพอไหม
 *   แท็บ "รายการ"  → ใครเรียกอะไร เมื่อไหร่ ได้ status อะไร
 *
 * ตารางนี้ไม่เก็บ request body โดยตั้งใจ (ดูเหตุผลใน migrations/changes/2026-08-10_01_api_logs.sql)
 * จึงไม่มีอะไรให้กางดูนอกจากข้อมูลของ request เอง
 *
 * ⚠️ "เจ้าของเอกสาร" ไม่ใช่ "ผู้เรียก" — ลิงก์ /download-pdf เป็นลิงก์สาธารณะที่เซลล์ forward
 *    ต่อให้ลูกค้าได้ จึงไม่มีทางรู้ว่าใครกด · ที่แสดงได้คือ "เอกสารนี้เป็นของเซลล์คนไหน"
 *    ทุกที่ที่แสดงค่านี้ต้องมีคำว่า "เอกสารของ" กำกับเสมอ ห้ามปล่อยให้อ่านแล้วเข้าใจว่าเป็นคนกด
 */

const BRAND = 'var(--brand-fg)';
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];

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

/** ข้อความ error จาก catch — catch ให้ unknown เสมอ ห้ามใช้ any (กติกา lint ของ frontend) */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
}
interface Stats {
  byRoute: RouteStat[]; byHour: HourStat[]; slowest: ApiLogBase[];
  saturation: Saturation | null; dateFrom: string; dateTo: string;
}

// ปัก Asia/Bangkok ไว้เสมอ ไม่ใช้ TimeZone ของเบราว์เซอร์ — ต้องตรงกับตัวกรองวันที่ฝั่ง SQL
// ที่ตีความเป็นวันตามเวลาไทย ไม่งั้นเครื่องที่ตั้งโซนอื่นจะเห็นวันในตารางไม่ตรงกับช่วงที่กรอง
function formatDateTime(s: string) {
  if (!s) return '-';
  return new Date(s).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
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

function formatMs(ms: number) {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} วิ`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} วิ`;
  return `${ms} ms`;
}

function formatBytes(b: number | null) {
  if (b === null || b === undefined) return '-';
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function statusStyle(code: number) {
  if (code >= 500) return 'bg-red-50 border-red-200 text-red-700';
  if (code >= 400) return 'bg-amber-50 border-amber-200 text-amber-700';
  if (code >= 300) return 'bg-blue-50 border-blue-200 text-blue-700';
  return 'bg-emerald-50 border-emerald-200 text-emerald-700';
}

/** สีของ duration — ให้สายตาจับ endpoint ที่ช้าได้ทันทีโดยไม่ต้องอ่านตัวเลข */
function durationStyle(ms: number) {
  if (ms >= 10_000) return 'text-red-600 font-semibold';
  if (ms >= 3_000) return 'text-amber-600 font-medium';
  if (ms >= 1_000) return 'text-slate-700';
  return 'text-slate-500';
}

function shortUser(id: string | null) {
  if (!id) return null;
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'TASK'];

const inputCls =
  'w-full bg-card border border-slate-200 focus:border-[var(--brand-fg)] focus:ring-2 focus:ring-[var(--brand-fg)]/10' +
  ' focus:outline-none rounded-xl px-4 py-2.5 text-sm text-slate-800 transition-all';

export function ApiLogs() {
  const { token } = useAuth();
  const [tab, setTab] = useState<'overview' | 'list'>('overview');

  // ช่วงวันร่วมกันทั้งสองแท็บ — ว่าง = ให้ backend ใส่ค่าตั้งต้น 7 วันล่าสุดให้
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const authFetch = useCallback(
    (url: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
    [token]);

  const dateQs = `${dateFrom ? `&dateFrom=${dateFrom}` : ''}${dateTo ? `&dateTo=${dateTo}` : ''}`;

  // ── ภาพรวม ────────────────────────────────────────────────────────────────
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [pathQuery, setPathQuery] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('all');
  const [minDuration, setMinDuration] = useState('');
  const [requestId, setRequestId] = useState('');
  const [lineUserId, setLineUserId] = useState('');
  const [ipFilter, setIpFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiLogDetail | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setListLoading(true); setListError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('limit', String(pageSize));
      qs.set('offset', String((page - 1) * pageSize));
      if (dateFrom) qs.set('dateFrom', dateFrom);
      if (dateTo) qs.set('dateTo', dateTo);
      if (pathQuery.trim()) qs.set('path', pathQuery.trim());
      if (method) qs.set('method', method);
      if (status !== 'all') qs.set('status', status);
      if (minDuration) qs.set('minDuration', minDuration);
      if (requestId.trim()) qs.set('requestId', requestId.trim());
      if (lineUserId.trim()) qs.set('lineUserId', lineUserId.trim());
      if (ipFilter.trim()) qs.set('ip', ipFilter.trim());

      const res = await authFetch(`/api/admin/api-logs?${qs}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const json = await res.json();
      setRows(json.data); setTotal(json.total);
    } catch (e: unknown) { setListError(errMsg(e)); } finally { setListLoading(false); }
  }, [authFetch, page, pageSize, dateFrom, dateTo, pathQuery, method, status, minDuration, requestId, lineUserId, ipFilter]);

  // ทั้งสองตัวยิงผ่าน setTimeout ไม่เรียก setState ตรง ๆ ในตัว effect
  // (loadStats/loadList เซ็ต loading ทันทีที่ถูกเรียก ซึ่งกฎ react-hooks/set-state-in-effect ห้ามไว้
  //  — pattern เดียวกับ Quotations.tsx) และการหน่วงยังช่วยรวบการพิมพ์รัวในช่องค้นหาไปในตัว
  useEffect(() => {
    if (tab !== 'overview') return;
    const t = setTimeout(() => { loadStats(); }, 0);
    return () => clearTimeout(t);
  }, [tab, loadStats]);

  useEffect(() => {
    if (tab !== 'list') return;
    const t = setTimeout(() => { loadList(); }, 300);
    return () => clearTimeout(t);
  }, [tab, loadList]);

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

  const jumpToRequest = (rid: string) => {
    setRequestId(rid); setPathQuery(''); setMethod(''); setStatus('all');
    setMinDuration(''); setLineUserId(''); setPage(1); setTab('list');
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageNumbers = React.useMemo(() => {
    const pages: (number | 'ellipsis')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
      return pages;
    }
    pages.push(1);
    if (safePage > 3) pages.push('ellipsis');
    for (let i = Math.max(2, safePage - 1); i <= Math.min(totalPages - 1, safePage + 1); i++) pages.push(i);
    if (safePage < totalPages - 2) pages.push('ellipsis');
    pages.push(totalPages);
    return pages;
  }, [totalPages, safePage]);

  const sat = stats?.saturation;
  const maxHourCount = Math.max(1, ...(stats?.byHour ?? []).map(h => h.count));
  const maxTotalMs = Math.max(1, ...(stats?.byRoute ?? []).map(r => Number(r.total_ms)));

  return (
    <div className="space-y-4">
      {/* แท็บ + ช่วงวัน */}
      <div className="bg-card rounded-2xl border border-slate-200 p-4 md:p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="inline-flex bg-slate-100 rounded-xl p-1">
            {([['overview', 'ภาพรวม', Gauge], ['list', 'รายการ', Activity]] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
                  tab === key ? 'bg-card shadow-sm text-slate-900 font-medium' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Icon className="w-4 h-4" style={tab === key ? { color: BRAND } : undefined} />
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 z-10 pointer-events-none" />
              <DateInput value={dateFrom} onChange={setDateFrom} aria-label="ตั้งแต่วันที่"
                className={inputCls.replace('px-4', 'pl-10 pr-3')} />
            </div>
            <span className="text-slate-400 text-sm">ถึง</span>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 z-10 pointer-events-none" />
              <DateInput value={dateTo} onChange={setDateTo} aria-label="ถึงวันที่"
                className={inputCls.replace('px-4', 'pl-10 pr-3')} />
            </div>
            {(dateFrom || dateTo) && (
              <button onClick={() => { setDateFrom(''); setDateTo(''); }}
                className="text-slate-400 hover:text-slate-600 p-2" aria-label="ล้างช่วงวัน">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        {!dateFrom && !dateTo && (
          <p className="text-xs text-slate-400">ไม่ระบุช่วงวัน = 7 วันล่าสุด</p>
        )}
      </div>

      {/* ══════════════ ภาพรวม ══════════════ */}
      {tab === 'overview' && (
        <>
          {statsError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
              <AlertCircle className="w-4 h-4" />{statsError}
            </div>
          )}
          {statsLoading && !stats && (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
          )}

          {sat && (
            <>
              {/* การ์ดสรุป */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="จำนวน request" value={sat.total.toLocaleString()} sub={`${stats?.dateFrom} → ${stats?.dateTo}`} />
                <StatCard label="p95 ของเวลาตอบ" value={formatMs(sat.p95)}
                  sub="95% ของ request เร็วกว่านี้" />
                <StatCard label="อัตรา error"
                  value={sat.total ? `${(sat.errors * 100 / sat.total).toFixed(1)}%` : '-'}
                  sub={`${sat.errors.toLocaleString()} ครั้ง (4xx/5xx)`}
                  danger={sat.total > 0 && sat.errors / sat.total > 0.05} />
                <StatCard label="request พร้อมกันสูงสุด" value={String(sat.max_inflight)}
                  sub={sat.db_wait_hits > 0
                    ? `⚠ connection pool ไม่พอ ${sat.db_wait_hits.toLocaleString()} ครั้ง`
                    : 'connection pool เพียงพอตลอดช่วง'}
                  danger={sat.db_wait_hits > 0} />
              </div>

              {/* เตือนเรื่อง webhook โดยเฉพาะ — เป็นภาระหนักที่สุดของระบบ */}
              {(sat.webhook_dropped > 0 || sat.webhook_timeout > 0 || sat.max_queue_waited > 5000) && (
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-1">
                  <div className="flex items-center gap-2 text-amber-800 font-medium text-sm">
                    <AlertTriangle className="w-4 h-4" />คิวประมวลผลข้อความ LINE
                  </div>
                  <p className="text-sm text-amber-700">
                    {sat.webhook_dropped > 0 && <>ถูกทิ้งเพราะคิวตัน <b>{sat.webhook_dropped}</b> ครั้ง · </>}
                    {sat.webhook_timeout > 0 && <>หมดเวลาตอบ <b>{sat.webhook_timeout}</b> ครั้ง · </>}
                    รอคิวนานสุด <b>{formatMs(sat.max_queue_waited)}</b>
                  </p>
                  <p className="text-xs text-amber-600">
                    รอคิวนาน = ต้องเพิ่มทรัพยากร/ความขนาน · ถ้ารอคิวสั้นแต่เวลารวมนาน = ตัวงานเองช้า ต้องแก้โค้ด
                  </p>
                </div>
              )}

              {/* endpoint เรียงตามเวลารวม */}
              <div className="bg-card rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100">
                  <h3 className="font-medium text-slate-800">endpoint ที่กินเวลาเครื่องรวมมากที่สุด</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    เรียงตาม "เวลารวม" ไม่ใช่ตัวที่ช้าที่สุด — ตัวที่กินเวลาเครื่องรวมมากที่สุดคือตัวที่ควร optimize ก่อน
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500 text-xs">
                      <tr>
                        <th className="text-left font-medium px-5 py-2.5">endpoint</th>
                        <th className="text-right font-medium px-3 py-2.5">ครั้ง</th>
                        <th className="text-right font-medium px-3 py-2.5">p50</th>
                        <th className="text-right font-medium px-3 py-2.5">p95</th>
                        <th className="text-right font-medium px-3 py-2.5">p99</th>
                        <th className="text-right font-medium px-3 py-2.5">สูงสุด</th>
                        <th className="text-right font-medium px-3 py-2.5">error</th>
                        <th className="text-left font-medium px-5 py-2.5 w-48">เวลารวม</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {stats!.byRoute.map((r) => (
                        <tr key={r.route} className="hover:bg-slate-50/60">
                          <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{decodePath(r.route)}</td>
                          <td className="px-3 py-2.5 text-right text-slate-600">{r.count.toLocaleString()}</td>
                          <td className="px-3 py-2.5 text-right text-slate-500">{formatMs(r.p50)}</td>
                          <td className={`px-3 py-2.5 text-right ${durationStyle(r.p95)}`}>{formatMs(r.p95)}</td>
                          <td className={`px-3 py-2.5 text-right ${durationStyle(r.p99)}`}>{formatMs(r.p99)}</td>
                          <td className={`px-3 py-2.5 text-right ${durationStyle(r.max_ms)}`}>{formatMs(r.max_ms)}</td>
                          <td className="px-3 py-2.5 text-right">
                            {r.errors > 0
                              ? <span className="text-red-600">{r.errors}</span>
                              : <span className="text-slate-300">0</span>}
                          </td>
                          <td className="px-5 py-2.5">
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
                      {stats!.byRoute.length === 0 && (
                        <tr><td colSpan={8} className="px-5 py-10 text-center text-slate-400">ไม่มีข้อมูลในช่วงนี้</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* กราฟรายชั่วโมง — ใช้ div ล้วน ไม่เพิ่ม dependency กราฟเข้าโปรเจกต์ */}
              {stats!.byHour.length > 0 && (
                <div className="bg-card rounded-2xl border border-slate-200 p-5">
                  <h3 className="font-medium text-slate-800">ปริมาณรายชั่วโมง (เวลาไทย)</h3>
                  <p className="text-xs text-slate-400 mt-0.5 mb-4">
                    แท่งสูง = คนใช้เยอะ · สีแดง = ชั่วโมงที่ connection pool ไม่พอ
                  </p>
                  <div className="flex items-end gap-[2px] h-40 overflow-x-auto pb-1">
                    {stats!.byHour.map((h) => (
                      <div key={h.hour} className="flex-1 min-w-[6px] group relative flex flex-col justify-end h-full">
                        <div
                          className="w-full rounded-t transition-all"
                          style={{
                            height: `${Math.max(2, h.count / maxHourCount * 100)}%`,
                            background: (h.max_db_waiting ?? 0) > 0 ? 'var(--color-red-600)' : BRAND,
                            opacity: h.errors > 0 ? 0.65 : 1,
                          }}
                        />
                        <div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-10
                                        bg-slate-200 text-slate-900 border border-slate-300 text-[11px] rounded-lg px-2.5 py-1.5 whitespace-nowrap">
                          {h.hour} น.<br />
                          {h.count.toLocaleString()} request · p95 {formatMs(h.p95)}<br />
                          พร้อมกันสูงสุด {h.max_inflight ?? '-'} · error {h.errors}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-400 mt-2">
                    <span>{stats!.byHour[0]?.hour}</span>
                    <span>{stats!.byHour[stats!.byHour.length - 1]?.hour}</span>
                  </div>
                </div>
              )}

              {/* 20 อันดับที่ช้าที่สุด */}
              <div className="bg-card rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100">
                  <h3 className="font-medium text-slate-800">20 request ที่ช้าที่สุดในช่วงนี้</h3>
                  <p className="text-xs text-slate-400 mt-0.5">กดแถวเพื่อไปดูรายละเอียดในแท็บรายการ</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500 text-xs">
                      <tr>
                        <th className="text-left font-medium px-5 py-2.5">เวลา</th>
                        <th className="text-left font-medium px-3 py-2.5">endpoint</th>
                        <th className="text-left font-medium px-3 py-2.5">ผู้เรียก</th>
                        <th className="text-center font-medium px-3 py-2.5">status</th>
                        <th className="text-right font-medium px-5 py-2.5">ใช้เวลา</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {stats!.slowest.map((r) => (
                        <tr key={r.id} onClick={() => jumpToRequest(r.request_id)}
                          className="hover:bg-slate-50/60 cursor-pointer">
                          <td className="px-5 py-2.5 text-slate-500 text-xs whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                          <td className="px-3 py-2.5">
                            <span className="font-mono text-[11px] text-slate-400 mr-1.5">{r.method}</span>
                            <span className="font-mono text-xs text-slate-700">{decodePath(r.path)}</span>
                          </td>
                          <td className="px-3 py-2.5 text-xs text-slate-500">
                            {r.admin_username ?? shortUser(r.line_user_id) ?? '-'}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-md border text-xs ${statusStyle(r.status_code)}`}>
                              {r.status_code}
                            </span>
                          </td>
                          <td className={`px-5 py-2.5 text-right tabular-nums ${durationStyle(r.duration_ms)}`}>
                            {formatMs(r.duration_ms)}
                            {r.queue_waited_ms !== null && (
                              <div className="text-[11px] text-slate-400 font-normal">
                                รอคิว {formatMs(r.queue_waited_ms)}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                      {stats!.slowest.length === 0 && (
                        <tr><td colSpan={5} className="px-5 py-10 text-center text-slate-400">ไม่มีข้อมูลในช่วงนี้</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ══════════════ รายการ ══════════════ */}
      {tab === 'list' && (
        <>
          <div className="bg-card rounded-2xl border border-slate-200 p-4 md:p-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
              <div className="relative xl:col-span-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                <input value={pathQuery} onChange={(e) => { setPathQuery(e.target.value); setPage(1); }}
                  placeholder="ค้นหา path เช่น /api/quotation"
                  className={inputCls.replace('px-4', 'pl-10 pr-4')} />
              </div>

              <div className="relative">
                <select value={method} onChange={(e) => { setMethod(e.target.value); setPage(1); }}
                  className={`${inputCls} appearance-none cursor-pointer`}>
                  <option value="">ทุก method</option>
                  {METHODS.map(m => <option key={m} value={m}>{m}{m === 'TASK' ? ' (งานเบื้องหลัง)' : ''}</option>)}
                </select>
                <Filter className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              <div className="relative">
                <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                  className={`${inputCls} appearance-none cursor-pointer`}>
                  <option value="all">ทุก status</option>
                  <option value="2xx">2xx สำเร็จ</option>
                  <option value="4xx">4xx ผิดฝั่งผู้เรียก</option>
                  <option value="5xx">5xx ผิดฝั่งระบบ</option>
                </select>
                <Filter className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>

              <div className="relative">
                <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                <input value={minDuration} inputMode="numeric"
                  onChange={(e) => { setMinDuration(e.target.value.replace(/\D/g, '')); setPage(1); }}
                  placeholder="ช้ากว่า (ms)"
                  className={inputCls.replace('px-4', 'pl-10 pr-4')} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input value={requestId} onChange={(e) => { setRequestId(e.target.value); setPage(1); }}
                placeholder="Request ID (ค้นได้โดยไม่ต้องรู้วันที่)"
                className={`${inputCls} font-mono text-xs`} />
              <input value={lineUserId} onChange={(e) => { setLineUserId(e.target.value); setPage(1); }}
                placeholder="LINE User ID"
                className={`${inputCls} font-mono text-xs`} />
            </div>

            {/* กรองด้วย IP = ดูว่า "เครื่องเดียวกันนี้" เรียกอะไรไปบ้างในช่วงเวลานั้น ซึ่งเป็นวิธีเดียว
                ที่พอจะบอกได้ว่าคนที่กดลิงก์ PDF สาธารณะเป็นเซลล์เจ้าของใบเองหรือคนอื่น */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input value={ipFilter} onChange={(e) => { setIpFilter(e.target.value); setPage(1); }}
                placeholder="IP ต้นทาง (กดที่ IP ในตารางเพื่อกรองได้เลย)"
                className={`${inputCls} font-mono text-xs`} />
            </div>

            {(pathQuery || method || status !== 'all' || minDuration || requestId || lineUserId || ipFilter) && (
              <button
                onClick={() => {
                  setPathQuery(''); setMethod(''); setStatus('all');
                  setMinDuration(''); setRequestId(''); setLineUserId(''); setIpFilter(''); setPage(1);
                }}
                className="text-sm text-slate-500 hover:text-slate-700 inline-flex items-center gap-1.5">
                <X className="w-3.5 h-3.5" />ล้างตัวกรอง
              </button>
            )}
            {requestId && (
              <p className="text-xs text-slate-400">
                ค้นด้วย Request ID จะข้ามเงื่อนไขช่วงวันทั้งหมด
              </p>
            )}
          </div>

          {listError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
              <AlertCircle className="w-4 h-4" />{listError}
            </div>
          )}

          <div className="bg-card rounded-2xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-left font-medium px-5 py-3">เวลา</th>
                    <th className="text-left font-medium px-3 py-3">endpoint</th>
                    <th className="text-left font-medium px-3 py-3">ผู้เรียก</th>
                    <th className="text-center font-medium px-3 py-3">status</th>
                    <th className="text-right font-medium px-3 py-3">ใช้เวลา</th>
                    <th className="text-right font-medium px-3 py-3">ขนาด</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {listLoading && rows.length === 0 && (
                    <tr><td colSpan={7} className="px-5 py-16 text-center">
                      <Loader2 className="w-6 h-6 animate-spin text-slate-400 mx-auto" />
                    </td></tr>
                  )}
                  {!listLoading && rows.length === 0 && (
                    <tr><td colSpan={7} className="px-5 py-16 text-center text-slate-400">ไม่พบรายการตามเงื่อนไขนี้</td></tr>
                  )}
                  {rows.map((r) => (
                    <React.Fragment key={r.id}>
                      <tr onClick={() => openDetail(r.id)} className="hover:bg-slate-50/60 cursor-pointer">
                        <td className="px-5 py-2.5 text-slate-500 text-xs whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[11px] text-slate-400">{r.method}</span>
                            <span className="font-mono text-xs text-slate-700 break-all">{decodePath(r.path)}</span>
                          </div>
                          {r.route_group !== r.path && (
                            <div className="font-mono text-[11px] text-slate-400 mt-0.5">{decodePath(r.route_group)}</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-xs">
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
                              onClick={(e) => { e.stopPropagation(); setIpFilter(r.ip!); setPage(1); }}
                              title="กรองเฉพาะ request ที่มาจาก IP นี้"
                              className="font-mono text-[11px] text-slate-400 hover:text-slate-700 hover:underline mt-0.5 block">
                              {r.ip}
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded-md border text-xs ${statusStyle(r.status_code)}`}>
                            {r.status_code}
                          </span>
                        </td>
                        <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${durationStyle(r.duration_ms)}`}>
                          {formatMs(r.duration_ms)}
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
                        <td className="px-3 py-2.5 text-right text-xs text-slate-400">{formatBytes(r.resp_bytes)}</td>
                        <td className="px-3 py-2.5 text-slate-300">
                          {expandedId === r.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </td>
                      </tr>

                      {expandedId === r.id && (
                        <tr>
                          <td colSpan={7} className="bg-slate-50/70 px-5 py-4">
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
                                    <code className="block bg-card border border-slate-200 rounded-lg px-3 py-2 break-all text-slate-700">
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
                                            <span className="font-mono text-[11px] text-slate-400 w-12">{rel.method}</span>
                                            <span className="font-mono text-slate-700 flex-1 break-all">{decodePath(rel.path)}</span>
                                            <span className={`px-2 py-0.5 rounded-md border ${statusStyle(rel.status_code)}`}>
                                              {rel.status_code}
                                            </span>
                                            <span className={`tabular-nums ${durationStyle(rel.duration_ms)}`}>
                                              {formatMs(rel.duration_ms)}
                                            </span>
                                            {rel.queue_waited_ms !== null && (
                                              <span className="text-slate-400">รอคิว {formatMs(rel.queue_waited_ms)}</span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  <p className="text-[11px] text-slate-400">
                                    ระบบไม่เก็บเนื้อหาที่ส่งมากับ request (ทั้ง body และ query) โดยตั้งใจ
                                    เพื่อให้ log เบาและไม่มีข้อมูลส่วนบุคคลของลูกค้า
                                  </p>
                                </div>
                              )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {/* เลขหน้า */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-slate-100 text-sm">
              <div className="flex items-center gap-2 text-slate-500">
                <span>
                  แสดง {total === 0 ? 0 : (safePage - 1) * pageSize + 1}
                  -{Math.min(safePage * pageSize, total)} จาก {total.toLocaleString()}
                </span>
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                  className="bg-card border border-slate-200 rounded-lg px-2 py-1 text-xs cursor-pointer">
                  {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n} ต่อหน้า</option>)}
                </select>
              </div>

              <div className="flex items-center gap-1">
                <button disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}
                  className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label="หน้าก่อนหน้า">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {pageNumbers.map((p, i) =>
                  p === 'ellipsis'
                    ? <span key={`e${i}`} className="px-2 text-slate-300">…</span>
                    : <button key={p} onClick={() => setPage(p)}
                        className={`min-w-[32px] h-8 rounded-lg text-xs transition-all ${
                          p === safePage ? 'text-white' : 'text-slate-600 hover:bg-slate-100'}`}
                        style={p === safePage ? { background: 'var(--brand)' } : undefined}>
                        {p}
                      </button>
                )}
                <button disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}
                  className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
                  aria-label="หน้าถัดไป">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, danger }: {
  label: string; value: string; sub?: string; danger?: boolean;
}) {
  return (
    <div className={`bg-card rounded-2xl border p-4 ${danger ? 'border-red-200' : 'border-slate-200'}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${danger ? 'text-red-600' : 'text-slate-800'}`}>{value}</div>
      {sub && <div className={`text-[11px] mt-1 ${danger ? 'text-red-500' : 'text-slate-400'}`}>{sub}</div>}
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
