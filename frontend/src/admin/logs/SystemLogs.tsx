import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../PageHeader';
import { DateInput } from '../DateInput';
import {
  Terminal, Download, Loader2, AlertCircle, AlertTriangle, Search,
  ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightSmall, Link2,
} from 'lucide-react';
import { useHashState } from './useHashState';
import {
  errMsg, formatDateTime, relativeTime, formatNumber, levelStyle,
  downloadCsv, inputCls, PAGE_SIZE_OPTIONS,
} from './format';
import { RequestTimeline } from './RequestTimeline';

/**
 * หน้า "บันทึกระบบ" — ระบบพังตรงไหน เพราะอะไร (ย้อนหลังเกินอายุ docker logs)
 *
 * ⚠️ ระดับความรุนแรงมาจาก "สตรีม" ไม่ใช่คำในข้อความ (ดู scripts/logworker/parseLine.ts)
 *   ⇒ บรรทัดอย่าง "[queue] ... failed=0" ไม่ถูกนับเป็น error ทั้งที่มีคำว่า failed
 *
 * ⚠️ หน้านี้ต้องแสดง "สถานะ logworker" ด้วยเสมอ
 *   worker เป็นโปรเซสแยกบน host ที่แอปไม่รู้จัก ⇒ ถ้ามันตายเงียบ ๆ ตารางจะหยุดโตโดยไม่มีใครรู้
 *   แล้วคนจะเข้าใจผิดว่า "ระบบไม่มี error เลย" ทั้งที่ความจริงคือ "ไม่มีใครเก็บอยู่"
 */

const BRAND = 'var(--brand-fg)';

interface SystemRow {
  id: string;
  created_at: string;
  container: string;
  stream: string;
  level: string;
  source: string | null;
  event: string | null;
  message: string;
  request_id: string | null;
  ctx: Record<string, unknown> | null;
  err_stack: string | null;
}

interface Facet { kind: string; value: string; n: number }

interface WorkerJob {
  job: string;
  cursor_at: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  runs: string;
  rows_written: string;
  stale: boolean;
}

const MIN_LEVELS: { key: string; label: string }[] = [
  { key: '', label: 'ทุกระดับ' },
  { key: 'error', label: 'ผิดพลาดขึ้นไป' },
  { key: 'warn', label: 'เตือนขึ้นไป' },
  { key: 'info', label: 'ข้อมูลขึ้นไป' },
];

function todayThai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function shiftDay(day: string, d: number): string {
  const x = new Date(`${day}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
}

/** ชื่องานเบื้องหลังที่คนอ่านออก */
function jobLabel(job: string): string {
  if (job.startsWith('system_log:')) return `เก็บ log ของ ${job.slice('system_log:'.length)}`;
  if (job === 'audit_actor') return 'เติมชื่อผู้แก้ไข';
  if (job === 'traffic_daily') return 'สรุป traffic รายวัน';
  if (job === 'log_retention') return 'ลบ log ที่เกินอายุ';
  return job;
}

/** แถบสถานะ logworker — ขึ้นเตือนเมื่อมีงานไหนค้าง */
const WorkerBanner: React.FC<{ jobs: WorkerJob[] }> = ({ jobs }) => {
  const [open, setOpen] = useState(false);
  const neverRan = jobs.filter(j => j.last_ok_at === null);
  const stale = jobs.filter(j => j.stale && j.last_ok_at !== null);
  const failing = jobs.filter(j => j.last_error);
  const healthy = stale.length === 0 && failing.length === 0 && neverRan.length === 0;

  return (
    <div className={`border rounded-2xl overflow-hidden ${
      healthy ? 'bg-card border-slate-200' : 'bg-amber-50 border-amber-200'}`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left"
        aria-expanded={open}
      >
        {healthy
          ? <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
          : <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />}
        <span className={`text-sm ${healthy ? 'text-slate-600' : 'text-amber-800 font-medium'}`}>
          {healthy
            ? 'ตัวเก็บ log ทำงานปกติ'
            : neverRan.length === jobs.length
              ? 'ยังไม่ได้เปิด logworker — ตารางนี้จะไม่มีข้อมูลใหม่จนกว่าจะเปิด'
              : `ตัวเก็บ log มีปัญหา ${stale.length + failing.length + neverRan.length} งาน — ข้อมูลอาจไม่ครบ`}
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400 ml-auto" />
              : <ChevronRightSmall className="w-4 h-4 text-slate-400 ml-auto" />}
      </button>

      {open && (
        <div className="px-4 pb-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left font-medium py-1.5 pr-4">งาน</th>
                <th className="text-left font-medium py-1.5 pr-4">สำเร็จล่าสุด</th>
                <th className="text-right font-medium py-1.5 pr-4">รอบ</th>
                <th className="text-right font-medium py-1.5 pr-4">แถวที่เขียน</th>
                <th className="text-left font-medium py-1.5">ข้อผิดพลาดล่าสุด</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/60">
              {jobs.map(j => (
                <tr key={j.job}>
                  <td className="py-1.5 pr-4 text-slate-700">{jobLabel(j.job)}</td>
                  <td className={`py-1.5 pr-4 ${j.stale ? 'text-amber-700 font-medium' : 'text-slate-500'}`}
                      title={formatDateTime(j.last_ok_at)}>
                    {j.last_ok_at ? relativeTime(j.last_ok_at) : 'ยังไม่เคยรัน'}
                  </td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-slate-500">{j.runs}</td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-slate-500">{j.rows_written}</td>
                  <td className="py-1.5 text-red-600 break-all">{j.last_error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export const SystemLogs: React.FC = () => {
  const { token } = useAuth();
  const today = todayThai();

  const { state, set, reset } = useHashState('system', {
    dateFrom: shiftDay(today, -6),
    dateTo: today,
    minLevel: '',
    source: '',
    q: '',
    page: '1',
    size: '50',
  });

  const [rows, setRows] = useState<SystemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facet[]>([]);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const page = Math.max(1, parseInt(state.page) || 1);
  const size = parseInt(state.size) || 50;
  const searchRef = useRef<HTMLInputElement>(null);

  const buildQs = useCallback(() => {
    const qs = new URLSearchParams({
      dateFrom: state.dateFrom, dateTo: state.dateTo,
      limit: String(size), offset: String((page - 1) * size),
    });
    if (state.minLevel) qs.set('minLevel', state.minLevel);
    if (state.source) qs.set('source', state.source);
    if (state.q.trim()) qs.set('q', state.q.trim());
    return qs;
  }, [state, page, size]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/admin/logs/system?${buildQs()}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const json = await res.json();
      setRows(json.data); setTotal(json.total); setFacets(json.facets ?? []);
    } catch (e: unknown) { setError(errMsg(e)); } finally { setLoading(false); }
  }, [token, buildQs]);

  useEffect(() => {
    const t = setTimeout(() => { load(); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetch('/api/admin/logs/worker-status', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : { data: [] })
        .then(j => setJobs(j.data ?? []))
        .catch(() => { /* สถานะ worker โหลดไม่ได้ ไม่ใช่เหตุให้ทั้งหน้าเป็น error */ });
    }, 0);
    return () => clearTimeout(t);
  }, [token]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault(); searchRef.current?.focus();
      } else if (e.key === 'Escape') {
        setExpanded(null); setTimelineFor(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const doExport = async () => {
    setExporting(true);
    try {
      const qs = buildQs();
      qs.delete('limit'); qs.delete('offset');
      await downloadCsv(`/api/admin/logs/export/system?${qs}`, token,
        `system-log-${state.dateFrom}-${state.dateTo}.csv`);
    } catch (e: unknown) { setError(errMsg(e)); } finally { setExporting(false); }
  };

  const levelFacets = facets.filter(f => f.kind === 'level');
  const sourceFacets = facets.filter(f => f.kind === 'source');
  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <div className="space-y-4">
      <PageHeader icon={Terminal} title="บันทึกระบบ"
                  description="ระบบพังตรงไหน เพราะอะไร — ย้อนหลังได้เกินอายุ docker logs">
        <button
          onClick={() => { void doExport(); }}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-white
                     transition disabled:opacity-60"
          style={{ background: BRAND }}
        >
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          <span className="hidden sm:inline">ส่งออก CSV</span>
        </button>
      </PageHeader>

      {jobs.length > 0 && <WorkerBanner jobs={jobs} />}

      {/* ── ตัวกรอง ── */}
      <div className="bg-card border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-56">
            <label className="block text-xs text-slate-500 mb-1">ค้นหาในข้อความ</label>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                ref={searchRef}
                className={`${inputCls} pl-10`}
                placeholder="พิมพ์เพื่อค้นหา… (กด / เพื่อโฟกัส)"
                value={state.q}
                onChange={e => set({ q: e.target.value, page: '1' })}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">ตั้งแต่</label>
            <DateInput value={state.dateFrom} onChange={v => set({ dateFrom: v, page: '1' })} />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">ถึง</label>
            <DateInput value={state.dateTo} onChange={v => set({ dateTo: v, page: '1' })} />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">ระดับ</label>
            <select className={inputCls} value={state.minLevel}
                    onChange={e => set({ minLevel: e.target.value, page: '1' })}>
              {MIN_LEVELS.map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">โมดูล</label>
            <select className={inputCls} value={state.source}
                    onChange={e => set({ source: e.target.value, page: '1' })}>
              <option value="">ทั้งหมด</option>
              {sourceFacets.filter(f => f.value !== '(ไม่ระบุ)').map(f => (
                <option key={f.value} value={f.value}>{f.value} ({f.n})</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {levelFacets.map(f => {
            const s = levelStyle(f.value);
            return (
              <span key={f.value}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border ${s.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                {s.label} {formatNumber(f.n)}
              </span>
            );
          })}
          <button onClick={reset} className="text-slate-400 hover:text-slate-600 underline underline-offset-2">
            ล้างตัวกรอง
          </button>
          <span className="ml-auto text-slate-500 tabular-nums">
            {loading ? 'กำลังโหลด…' : `${formatNumber(total)} บรรทัด`}
          </span>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-red-800">โหลดข้อมูลไม่สำเร็จ</div>
            <div className="text-xs text-red-600 mt-0.5">{error}</div>
          </div>
          <button onClick={() => { void load(); }}
                  className="px-3 py-1.5 rounded-lg bg-white border border-red-200 text-sm text-red-700">
            ลองใหม่
          </button>
        </div>
      )}

      {/* ── รายการ ── */}
      <div className="bg-card border border-slate-200 rounded-2xl overflow-hidden">
        {loading && rows.length === 0 && (
          <div className="divide-y divide-slate-100">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="p-3.5 animate-pulse flex gap-3">
                <div className="h-4 w-16 bg-slate-200 rounded" />
                <div className="h-4 flex-1 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <div className="py-16 text-center">
            <Terminal className="w-9 h-9 text-slate-300 mx-auto" />
            <div className="mt-2 text-sm text-slate-500">ไม่มีบันทึกในช่วงที่เลือก</div>
            <div className="mt-1 text-xs text-slate-400">
              ระบบเก็บเฉพาะระดับที่ตั้งไว้ใน SYSTEM_LOG_DB_LEVEL — ระดับต่ำกว่านั้นยังดูได้จาก docker logs
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="divide-y divide-slate-100 font-mono text-xs">
            {rows.map(r => {
              const s = levelStyle(r.level);
              const open = expanded === r.id;
              const hasMore = !!(r.err_stack || r.ctx);
              return (
                <div key={r.id}>
                  <button
                    onClick={() => hasMore && setExpanded(open ? null : r.id)}
                    className={`w-full text-left px-3.5 py-2 flex items-start gap-2.5 transition
                                focus:outline-none focus-visible:ring-2 focus-visible:ring-inset
                                focus-visible:ring-[var(--brand-fg)]
                                ${hasMore ? 'hover:bg-slate-50 cursor-pointer' : 'cursor-default'}`}
                    aria-expanded={hasMore ? open : undefined}
                  >
                    <span className="shrink-0 w-4 pt-0.5">
                      {hasMore && (open
                        ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                        : <ChevronRightSmall className="w-3.5 h-3.5 text-slate-300" />)}
                    </span>
                    <span className="shrink-0 text-slate-400 tabular-nums w-[122px]"
                          title={formatDateTime(r.created_at)}>
                      {formatDateTime(r.created_at)}
                    </span>
                    <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 rounded border ${s.cls}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                      {s.label}
                    </span>
                    {r.source && (
                      <span className="shrink-0 text-slate-500 max-w-32 truncate">[{r.source}]</span>
                    )}
                    <span className="min-w-0 flex-1 text-slate-700 break-all line-clamp-2 whitespace-pre-wrap">
                      {r.message}
                    </span>
                  </button>

                  {open && (
                    <div className="px-3.5 pb-3 pl-11 space-y-2">
                      {r.err_stack && (
                        <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded-lg p-3
                                        overflow-x-auto text-slate-600 whitespace-pre">{r.err_stack}</pre>
                      )}
                      {r.ctx && (
                        <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded-lg p-3
                                        overflow-x-auto text-slate-600">{JSON.stringify(r.ctx, null, 2)}</pre>
                      )}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400 font-sans">
                        <span>คอนเทนเนอร์: {r.container}</span>
                        <span>สตรีม: {r.stream}</span>
                        {r.event && <span>เหตุการณ์: {r.event}</span>}
                        {r.request_id && (
                          <button
                            onClick={() => setTimelineFor(r.request_id)}
                            className="inline-flex items-center gap-1 text-[var(--brand-fg)] hover:underline"
                          >
                            <Link2 className="w-3 h-3" /> ดูทุกอย่างของ request นี้
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {total > size && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100">
            <select
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-card text-slate-600"
              value={size}
              onChange={e => set({ size: e.target.value, page: '1' })}
            >
              {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n} ต่อหน้า</option>)}
            </select>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => set({ page: String(page - 1) })}
                className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
                aria-label="หน้าก่อนหน้า"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-500 tabular-nums">หน้า {page} / {pages}</span>
              <button
                disabled={page >= pages}
                onClick={() => set({ page: String(page + 1) })}
                className="p-1.5 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
                aria-label="หน้าถัดไป"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {timelineFor && (
        <RequestTimeline requestId={timelineFor} onClose={() => setTimelineFor(null)} />
      )}
    </div>
  );
};
