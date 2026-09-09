import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../PageHeader';
import { DateInput } from '../DateInput';
import {
  History, Download, Loader2,
  ChevronDown, ChevronRight as ChevronRightSmall, ArrowRight, Link2, Layers,
} from 'lucide-react';
import { useHashState } from './useHashState';
import {
  errMsg, formatDateTime, relativeTime, formatNumber, actorStyle, entityLabel,
  actionLabel, displayValue, downloadCsv, inputCls, isBulk,
} from './format';
import {
  CheckField, EmptyState, ErrorBox, FilterCard, FilterField, FilterFooter, FilterRow,
  Pagination, SearchField, SelectField, SkeletonRows, TimeSortToggle,
} from './ui';
import { RequestTimeline } from './RequestTimeline';

/**
 * หน้า "บันทึกการแก้ไข" — ใครแก้อะไร จากค่าอะไรเป็นค่าอะไร
 *
 * ⚠️ กติกาที่ห้ามผ่อน: ชื่อคนทำต้องแสดง "ที่มา" ควบคู่เสมอ
 *   'ยืนยันแล้ว'    = แอปบอกมาตรง ๆ (SET LOCAL app.actor) — แม่นยำ 100%
 *   'จับคู่จากเวลา' = logworker หาจาก api_logs ที่ครอบเวลานั้น — แม่นสูงแต่ไม่ใช่ 100%
 *   'เจ้าตัวผ่าน LINE' = เจ้าของข้อมูลแก้เองผ่านบอท/LIFF (ไม่มีแอดมินเกี่ยวข้อง) — จับคู่จากเวลาเช่นกัน
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

/**
 * แถวสรุปของการกดยกชุด — คำสั่งเดียวที่กระทบเกินเพดาน trigger จะไม่เก็บรายตัว
 * ต้องบอกให้ชัดว่า "ไม่ได้เก็บค่าเดิม→ค่าใหม่ของแต่ละรายการ" ไม่ใช่ปล่อยให้เข้าใจว่าไม่มีอะไรเปลี่ยน
 */
const BulkSummary: React.FC<{ row: AuditRow }> = ({ row }) => {
  const after = row.after as { rows?: number; sample?: string[] } | null;
  const total = after?.rows ?? 0;
  const sample = after?.sample ?? [];
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-start gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        <Layers className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          คำสั่งเดียวกระทบ <strong className="tabular-nums">{formatNumber(total)}</strong> รายการ
          จึงเก็บเป็นสรุปแถวเดียว — ไม่ได้เก็บค่าเดิม → ค่าใหม่ของแต่ละรายการไว้
        </span>
      </div>
      {(row.changed_cols?.length ?? 0) > 0 && (
        <div>
          <div className="text-slate-400 mb-1">ช่องที่เปลี่ยน</div>
          <div className="flex flex-wrap gap-1.5">
            {row.changed_cols!.map(c => (
              <span key={c} className="font-mono bg-slate-100 text-slate-600 rounded px-1.5 py-0.5">{c}</span>
            ))}
          </div>
        </div>
      )}
      {sample.length > 0 && (
        <div>
          <div className="text-slate-400 mb-1">
            ตัวอย่างรายการที่กระทบ ({sample.length} จาก {formatNumber(total)})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sample.map((s, i) => (
              <span key={`${s}-${i}`} className="font-mono bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 break-all">{s}</span>
            ))}
          </div>
        </div>
      )}
      {row.note && <div className="text-slate-400 leading-relaxed">{row.note}</div>}
    </div>
  );
};

/** ตารางเทียบค่าเดิม → ค่าใหม่ ทีละช่อง */
const DiffTable: React.FC<{ row: AuditRow }> = ({ row }) => {
  if (isBulk(row.action)) return <BulkSummary row={row} />;

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
    // ว่าง = ใหม่ไปเก่า (ค่าตั้งต้น) จึงไม่ถูกเขียนลง URL เว้นแต่ผู้ใช้สลับเป็น asc เอง
    dir: '',
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
    // เรียงที่ SQL — หน้านี้แบ่งหน้าจาก server การกลับลำดับเฉพาะหน้าที่เปิดอยู่จะได้ลำดับที่ผิด
    if (state.dir === 'asc') qs.set('dir', 'asc');
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
      <FilterCard>
        <FilterRow>
          <FilterField label="ค้นหา (ชื่อคนทำ / ชื่อรายการ / การกระทำ)" grow>
            <SearchField
              ref={searchRef}
              value={state.q}
              onChange={v => set({ q: v, page: '1' })}
              placeholder="พิมพ์เพื่อค้นหา… (กด / เพื่อโฟกัส)"
            />
          </FilterField>
          <FilterField label="ตั้งแต่" width="w-36">
            <DateInput className={inputCls} value={state.dateFrom}
                       onChange={v => set({ dateFrom: v, page: '1' })} aria-label="ตั้งแต่วันที่" />
          </FilterField>
          <FilterField label="ถึง" width="w-36">
            <DateInput className={inputCls} value={state.dateTo}
                       onChange={v => set({ dateTo: v, page: '1' })} aria-label="ถึงวันที่" />
          </FilterField>
          <FilterField label="ชนิดข้อมูล" width="w-52">
            <SelectField value={state.entityType} onChange={v => set({ entityType: v, page: '1' })}>
              <option value="">ทั้งหมด</option>
              {entityFacets.map(f => (
                <option key={f.value} value={f.value}>{entityLabel(f.value)} ({f.n})</option>
              ))}
            </SelectField>
          </FilterField>
          <FilterField label="ความแน่นอนของชื่อคนทำ" width="w-52">
            <SelectField value={state.actorType} onChange={v => set({ actorType: v, page: '1' })}>
              <option value="">ทั้งหมด</option>
              <option value="admin">รู้ตัวคนทำ</option>
              <option value="line_user">เจ้าตัวแก้เองผ่าน LINE</option>
              <option value="unknown">ไม่ทราบ (แก้จาก psql/script)</option>
              <option value="ambiguous">แยกไม่ออก</option>
              <option value="pending">กำลังหา</option>
            </SelectField>
          </FilterField>
          <div className="pb-px">
            <CheckField
              checked={state.includeViews === '1'}
              onChange={v => set({ includeViews: v ? '1' : '', page: '1' })}
              label="แสดงการเข้าดู log ด้วย"
              hint="ตั้งต้นซ่อนไว้เพราะมีมากกว่าการแก้จริงหลายเท่า"
            />
          </div>
        </FilterRow>

        <FilterFooter onReset={reset} loading={loading} total={total} unit="รายการ">
          <TimeSortToggle
            dir={state.dir === 'asc' ? 'asc' : 'desc'}
            onChange={d => set({ dir: d === 'asc' ? 'asc' : '', page: '1' })}
          />
        </FilterFooter>
      </FilterCard>

      {error && <ErrorBox message={error} onRetry={() => { void load(); }} />}

      {/* ── รายการ ── */}
      <div className="bg-card border border-slate-200 rounded-2xl overflow-hidden">
        {loading && rows.length === 0 && <SkeletonRows rows={6} />}

        {!loading && rows.length === 0 && !error && (
          <EmptyState
            icon={History}
            title="ไม่มีการแก้ไขในช่วงที่เลือก"
            hint="ตารางตั้งค่าถูกแก้กันวันละไม่กี่ครั้ง — ช่วงที่ว่างเปล่าเป็นเรื่องปกติ"
          />
        )}

        {rows.length > 0 && (
          <div className="divide-y divide-slate-100">
            {rows.map(r => {
              const a = actorStyle(r.actor_type, r.actor_source);
              const open = expanded === r.id;
              return (
                <div key={r.id}>
                  {/* แถวเดียวจบ — ทุกช่องมีความกว้างของตัวเอง ตาจึงไล่ลงคอลัมน์ได้เหมือนตาราง
                      ส่วนที่ยาวไม่จำกัด (ชื่อรายการ) เป็นตัวเดียวที่ยืด/ตัดท้าย ที่เหลือไม่ขยับ */}
                  <button
                    onClick={() => setExpanded(open ? null : r.id)}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-50 transition flex items-center gap-2
                               overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-inset
                               focus-visible:ring-[var(--brand-fg)]"
                    aria-expanded={open}
                  >
                    {open
                      ? <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      : <ChevronRightSmall className="w-3.5 h-3.5 text-slate-300 shrink-0" />}

                    <span className="shrink-0 w-20 sm:w-24 text-xs text-slate-400 truncate"
                          title={formatDateTime(r.occurred_at)}>
                      {relativeTime(r.occurred_at)}
                    </span>

                    <span title={a.hint}
                          className={`shrink-0 text-[11px] leading-4 px-1.5 rounded border ${a.cls}`}>
                      {a.label}
                    </span>

                    <span className="shrink-0 w-20 sm:w-32 text-xs text-slate-700 truncate"
                          title={r.actor_name ?? undefined}>
                      {r.actor_name ?? '—'}
                    </span>

                    <span className="shrink-0 text-xs font-medium text-slate-800">{actionLabel(r.action)}</span>

                    {r.entity_label && (
                      <span className="min-w-0 flex-1 text-xs text-slate-500 truncate" title={r.entity_label}>
                        {r.entity_label}
                      </span>
                    )}

                    {/* ดันของที่เหลือไปชิดขวาเมื่อไม่มีชื่อรายการมายืดแทน */}
                    {!r.entity_label && <span className="flex-1" />}

                    {r.changed_cols && r.changed_cols.length > 0 && r.before && r.after && (
                      <span className="shrink-0 text-[11px] text-slate-400 hidden sm:inline"
                            title={r.changed_cols.join(', ')}>
                        {/* ช่องน้อย ๆ บอกชื่อช่องไปเลย มีประโยชน์กว่าการบอกแค่จำนวน */}
                        {r.changed_cols.length <= 2
                          ? r.changed_cols.join(', ')
                          : `${r.changed_cols.length} ช่อง`}
                      </span>
                    )}

                    {isBulk(r.action) && (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] leading-4 px-1.5 rounded
                                       border border-amber-200 bg-amber-50 text-amber-700">
                        <Layers className="w-3 h-3" />ยกชุด
                      </span>
                    )}

                    {r.ip && (
                      <span className="shrink-0 text-[11px] text-slate-400 hidden lg:inline tabular-nums">{r.ip}</span>
                    )}
                  </button>

                  {open && (
                    <div className="px-3 pb-4 pl-9 pt-1 space-y-3">
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
        {total > 0 && (
          <Pagination
            page={Math.min(page, pages)} pages={pages} size={size} total={total} unit="รายการ"
            onPage={p => set({ page: String(p) })}
            onSize={s => set({ size: String(s), page: '1' })}
          />
        )}
      </div>

      {timelineFor && (
        <RequestTimeline requestId={timelineFor} onClose={() => setTimelineFor(null)} />
      )}
    </div>
  );
};
