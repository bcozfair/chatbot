import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../PageHeader';
import { DateInput } from '../DateInput';
import {
  History, Download, Loader2, AlertCircle, Search, ChevronLeft, ChevronRight,
  ChevronDown, ChevronRight as ChevronRightSmall, ArrowRight, Link2,
} from 'lucide-react';
import { useHashState } from './useHashState';
import {
  errMsg, formatDateTime, relativeTime, formatNumber, actorStyle, entityLabel,
  actionLabel, displayValue, downloadCsv, inputCls, PAGE_SIZE_OPTIONS,
} from './format';
import { RequestTimeline } from './RequestTimeline';

/**
 * หน้า "บันทึกการแก้ไข" — ใครแก้อะไร จากค่าอะไรเป็นค่าอะไร
 *
 * ⚠️ กติกาที่ห้ามผ่อน: ชื่อคนทำต้องแสดง "ที่มา" ควบคู่เสมอ
 *   'ยืนยันแล้ว'    = แอปบอกมาตรง ๆ (SET LOCAL app.actor) — แม่นยำ 100%
 *   'จับคู่จากเวลา' = logworker หาจาก api_logs ที่ครอบเวลานั้น — แม่นสูงแต่ไม่ใช่ 100%
 *   'ไม่ทราบ'      = แก้จาก psql/script ตรง ๆ ← เป็นคำตอบที่ถูกต้อง ไม่ใช่ความล้มเหลว
 * ถ้าแสดงแต่ชื่อเฉย ๆ เท่ากับหน้าจอโกหกว่ารู้แน่กว่าที่รู้จริง
 *
 * ตั้งต้นซ่อนแถว 'เข้าดู' (log.view) เพราะมีมากกว่าการแก้จริงหลายเท่าจนกลบของที่ต้องดู
 * — ไม่ได้ลบทิ้ง ติ๊กช่องเดียวก็เห็นครบ
 */

const BRAND = 'var(--brand-fg)';

interface AuditRow {
  id: string;
  occurred_at: string;
  request_id: string | null;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_source: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  changed_cols: string[] | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  result: string;
  note: string | null;
}

interface Facet { kind: string; value: string; n: number }

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

/** ตารางเทียบค่าเดิม → ค่าใหม่ ทีละช่อง */
const DiffTable: React.FC<{ row: AuditRow }> = ({ row }) => {
  const cols = row.changed_cols ?? [];
  if (cols.length === 0) {
    return <div className="text-xs text-slate-400">ไม่มีรายละเอียดของช่องที่เปลี่ยน</div>;
  }
  const isCreate = row.before === null;
  const isDelete = row.after === null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="text-left font-medium py-1.5 pr-4 w-52">ช่อง</th>
            {!isCreate && <th className="text-left font-medium py-1.5 pr-4">ค่าเดิม</th>}
            {!isCreate && !isDelete && <th className="w-6" />}
            {!isDelete && <th className="text-left font-medium py-1.5">{isCreate ? 'ค่า' : 'ค่าใหม่'}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {cols.map(c => (
            <tr key={c}>
              <td className="py-1.5 pr-4 font-mono text-slate-500 align-top">{c}</td>
              {!isCreate && (
                <td className="py-1.5 pr-4 text-slate-500 align-top break-all">
                  {displayValue(row.before?.[c])}
                </td>
              )}
              {!isCreate && !isDelete && (
                <td className="py-1.5 align-top text-slate-300"><ArrowRight className="w-3.5 h-3.5" /></td>
              )}
              {!isDelete && (
                <td className="py-1.5 text-slate-800 font-medium align-top break-all">
                  {displayValue(row.after?.[c])}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const AuditLogs: React.FC = () => {
  const { token } = useAuth();
  const today = todayThai();

  const { state, set, reset } = useHashState('audit', {
    dateFrom: shiftDay(today, -29),
    dateTo: today,
    entityType: '',
    actorType: '',
    q: '',
    includeViews: '',
    page: '1',
    size: '50',
  });

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facet[]>([]);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const page = Math.max(1, parseInt(state.page) || 1);
  const size = parseInt(state.size) || 50;
  const searchRef = useRef<HTMLInputElement>(null);

  const buildQs = useCallback((extra?: Record<string, string>) => {
    const qs = new URLSearchParams({
      dateFrom: state.dateFrom, dateTo: state.dateTo,
      limit: String(size), offset: String((page - 1) * size),
    });
    if (state.entityType) qs.set('entityType', state.entityType);
    if (state.actorType) qs.set('actorType', state.actorType);
    if (state.q.trim()) qs.set('q', state.q.trim());
    if (state.includeViews === '1') qs.set('includeViews', '1');
    for (const [k, v] of Object.entries(extra ?? {})) qs.set(k, v);
    return qs;
  }, [state, page, size]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/admin/logs/audit?${buildQs()}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const json = await res.json();
      setRows(json.data); setTotal(json.total);
    } catch (e: unknown) { setError(errMsg(e)); } finally { setLoading(false); }
  }, [token, buildQs]);

  // หน่วง 300ms เพื่อรวบการพิมพ์รัวในช่องค้นหา (pattern เดียวกับ ApiLogs.tsx)
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetch('/api/admin/logs/audit/facets', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : { data: [] })
        .then(j => setFacets(j.data ?? []))
        .catch(() => { /* ตัวเลือกตัวกรองโหลดไม่ได้ ไม่ใช่เรื่องที่ต้องขึ้น error ทั้งหน้า */ });
    }, 0);
    return () => clearTimeout(t);
  }, [token]);

  // '/' โฟกัสช่องค้นหา · Esc ปิดรายละเอียดที่กางอยู่
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
      await downloadCsv(`/api/admin/logs/export/audit?${qs}`, token,
        `audit-${state.dateFrom}-${state.dateTo}.csv`);
    } catch (e: unknown) { setError(errMsg(e)); } finally { setExporting(false); }
  };

  const entityFacets = facets.filter(f => f.kind === 'entity_type');
  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <div className="space-y-4">
      <PageHeader icon={History} title="บันทึกการแก้ไข"
                  description="ใครแก้อะไร จากค่าอะไรเป็นค่าอะไร">
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

      {/* ── ตัวกรอง ── */}
      <div className="bg-card border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-56">
            <label className="block text-xs text-slate-500 mb-1">ค้นหา (ชื่อคนทำ / ชื่อรายการ / การกระทำ)</label>
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
            <label className="block text-xs text-slate-500 mb-1">ชนิดข้อมูล</label>
            <select className={inputCls} value={state.entityType}
                    onChange={e => set({ entityType: e.target.value, page: '1' })}>
              <option value="">ทั้งหมด</option>
              {entityFacets.map(f => (
                <option key={f.value} value={f.value}>{entityLabel(f.value)} ({f.n})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">ความแน่นอนของชื่อคนทำ</label>
            <select className={inputCls} value={state.actorType}
                    onChange={e => set({ actorType: e.target.value, page: '1' })}>
              <option value="">ทั้งหมด</option>
              <option value="admin">รู้ตัวคนทำ</option>
              <option value="unknown">ไม่ทราบ (แก้จาก psql/script)</option>
              <option value="ambiguous">แยกไม่ออก</option>
              <option value="pending">กำลังหา</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="inline-flex items-center gap-2 text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={state.includeViews === '1'}
              onChange={e => set({ includeViews: e.target.checked ? '1' : '', page: '1' })}
              className="rounded border-slate-300"
            />
            แสดงการเข้าดู log ด้วย
            <span className="text-slate-400">(ตั้งต้นซ่อนไว้เพราะมีมากกว่าการแก้จริงหลายเท่า)</span>
          </label>
          <button onClick={reset} className="text-slate-400 hover:text-slate-600 underline underline-offset-2">
            ล้างตัวกรอง
          </button>
          <span className="ml-auto text-slate-500 tabular-nums">
            {loading ? 'กำลังโหลด…' : `${formatNumber(total)} รายการ`}
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
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="p-4 animate-pulse flex gap-4">
                <div className="h-4 w-32 bg-slate-200 rounded" />
                <div className="h-4 flex-1 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        )}

        {!loading && rows.length === 0 && !error && (
          <div className="py-16 text-center">
            <History className="w-9 h-9 text-slate-300 mx-auto" />
            <div className="mt-2 text-sm text-slate-500">ไม่มีการแก้ไขในช่วงที่เลือก</div>
            <div className="mt-1 text-xs text-slate-400">
              ตารางตั้งค่าถูกแก้กันวันละไม่กี่ครั้ง — ช่วงที่ว่างเปล่าเป็นเรื่องปกติ
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="divide-y divide-slate-100">
            {rows.map(r => {
              const a = actorStyle(r.actor_type, r.actor_source);
              const open = expanded === r.id;
              return (
                <div key={r.id}>
                  <button
                    onClick={() => setExpanded(open ? null : r.id)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 transition flex items-start gap-3
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-inset
                               focus-visible:ring-[var(--brand-fg)]"
                    aria-expanded={open}
                  >
                    {open
                      ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                      : <ChevronRightSmall className="w-4 h-4 text-slate-300 shrink-0 mt-0.5" />}

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-slate-800">{actionLabel(r.action)}</span>
                        {r.entity_label && (
                          <span className="text-sm text-slate-500 truncate max-w-xs">{r.entity_label}</span>
                        )}
                        {r.changed_cols && r.changed_cols.length > 0 && r.before && r.after && (
                          <span className="text-xs text-slate-400">
                            ({r.changed_cols.length} ช่อง)
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        <span title={a.hint}
                              className={`inline-flex items-center px-1.5 py-0.5 rounded border ${a.cls}`}>
                          {a.label}
                        </span>
                        <span className="text-slate-700">{r.actor_name ?? '—'}</span>
                        <span className="text-slate-300">·</span>
                        <span title={formatDateTime(r.occurred_at)}>{relativeTime(r.occurred_at)}</span>
                        {r.ip && <><span className="text-slate-300">·</span><span>{r.ip}</span></>}
                      </div>
                    </div>
                  </button>

                  {open && (
                    <div className="px-4 pb-4 pl-11 space-y-3">
                      <DiffTable row={r} />

                      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-slate-400">
                        <span>เวลา: <span className="text-slate-600">{formatDateTime(r.occurred_at)}</span></span>
                        <span>ชนิด: <span className="text-slate-600">{entityLabel(r.entity_type)}</span></span>
                        {r.entity_id && <span>รหัส: <span className="text-slate-600 font-mono">{r.entity_id}</span></span>}
                        {r.request_id && (
                          <button
                            onClick={() => setTimelineFor(r.request_id)}
                            className="inline-flex items-center gap-1 text-[var(--brand-fg)] hover:underline"
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            ดูทุกอย่างของ request นี้
                          </button>
                        )}
                      </div>

                      {r.note && (
                        <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-600">
                          {r.note}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── แบ่งหน้า ── */}
        {total > size && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-sm">
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
