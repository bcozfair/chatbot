import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../PageHeader';
import { DateInput } from '../DateInput';
import {
  BarChart3, Download, Loader2, AlertCircle, TrendingUp, TrendingDown, Minus, Info, RefreshCw,
} from 'lucide-react';
import { useHashState } from './useHashState';
import {
  errMsg, formatDate, formatMs, formatNumber, formatBytes, delta, downloadCsv,
} from './format';

/**
 * หน้า "รายงานการใช้งาน" — ปริมาณการใช้งานย้อนหลัง วัน/สัปดาห์/เดือน/ปี
 *
 * อ่านจาก traffic_daily ตัวเดียวทุกมุมมอง ⇒ ตัวเลขของ "วัน" รวมกันได้เท่ากับ "เดือน" เสมอ
 * ไม่มีสูตรสองชุดให้เพี้ยนกันทีหลัง
 *
 * ⚠️ กติกาที่ห้ามผ่อน: ตัวเลขต้องไม่โกหก
 *   - ค่าเฉลี่ยรวมย้อนกลับได้ถูกต้อง (sum ของเวลา ÷ sum ของจำนวน) → แสดงเป็นตัวเลขหลักได้
 *   - p95 ของช่วงยาวรวมย้อนกลับ "ไม่ได้" → แสดงพร้อมป้าย "สูงสุดรายวัน" เสมอ
 *   - ผู้ใช้ไม่ซ้ำของช่วงยาวก็รวมไม่ได้ (คนเดิมเข้าหลายวัน) → แสดงเป็น "สูงสุดรายวัน" เช่นกัน
 */

const BRAND = 'var(--brand-fg)';

interface Bucket {
  bucket: string; days: number;
  requests: number; requests_api: number;
  webhook_events: number; webhook_dropped: number; webhook_timeout: number;
  errors_4xx: number; errors_5xx: number;
  uniq_line_users_max: number; uniq_admin_users_max: number; uniq_ips_max: number;
  bytes_out: string | null; avg_ms: number | null; p95_worst_day: number | null;
  max_inflight: number | null; db_wait_hits: number;
  quotations_created: number; messages_in: number;
  audit_changes: number; system_errors: number;
}

interface TrafficResponse {
  granularity: 'day' | 'week' | 'month' | 'year';
  dateFrom: string; dateTo: string;
  buckets: Bucket[];
  totals: Bucket | null;
  previous: { dateFrom: string; dateTo: string; totals: Bucket | null };
  coverage: { first_day: string | null; last_day: string | null };
  notes: { p95: string; uniq: string };
}

const GRANULARITIES: { key: TrafficResponse['granularity']; label: string; days: number }[] = [
  { key: 'day', label: 'รายวัน', days: 30 },
  { key: 'week', label: 'รายสัปดาห์', days: 90 },
  { key: 'month', label: 'รายเดือน', days: 365 },
  { key: 'year', label: 'รายปี', days: 1095 },
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

/** หัวข้อของแท่งในกราฟตามระดับการรวม — สัปดาห์ต้องบอกว่า "สัปดาห์ของวันที่..." ไม่ใช่แค่วันที่ลอย ๆ */
function bucketLabel(b: string, g: TrafficResponse['granularity']): string {
  if (g === 'year') return b.slice(0, 4);
  if (g === 'month') {
    return new Date(`${b}T00:00:00+07:00`).toLocaleDateString('th-TH',
      { timeZone: 'Asia/Bangkok', month: 'short', year: '2-digit' });
  }
  if (g === 'week') return `สัปดาห์ ${formatDate(b)}`;
  return formatDate(b);
}

// ── ชิ้นส่วนหน้าจอ ───────────────────────────────────────────────────────────

const Kpi: React.FC<{
  label: string; value: string; sub?: string; hint?: string;
  now?: number; before?: number; tone?: 'normal' | 'bad';
}> = ({ label, value, sub, hint, now, before, tone = 'normal' }) => {
  const d = now !== undefined && before !== undefined ? delta(now, before) : null;
  // ค่า error ที่ "เพิ่มขึ้น" คือข่าวร้าย ส่วน request ที่เพิ่มขึ้นคือข่าวดี — ลูกศรจึงสีตามความหมาย ไม่ใช่ตามทิศ
  const good = d?.dir === 'flat' ? null : tone === 'bad' ? d?.dir === 'down' : d?.dir === 'up';
  const Icon = d?.dir === 'up' ? TrendingUp : d?.dir === 'down' ? TrendingDown : Minus;

  return (
    <div className="bg-card border border-slate-200 rounded-2xl p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        {label}
        {hint && <span title={hint}><Info className="w-3.5 h-3.5 text-slate-400" /></span>}
      </div>
      <div className="mt-1.5 text-2xl font-bold text-slate-900 tabular-nums">{value}</div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {sub && <span className="text-slate-400">{sub}</span>}
        {d && (
          <span
            className={`inline-flex items-center gap-0.5 font-medium ${
              good === null ? 'text-slate-400' : good ? 'text-emerald-600' : 'text-red-600'}`}
            title="เทียบกับช่วงก่อนหน้าที่ยาวเท่ากัน"
          >
            <Icon className="w-3 h-3" />{d.text}
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * กราฟแท่งปริมาณ + แถบข้อผิดพลาดซ้อน — วาดด้วย div ล้วน ไม่ดึงไลบรารีกราฟเข้ามา
 * ข้อมูลมีมิติเดียว (จำนวนต่อช่วงเวลา) ซึ่งไม่คุ้มกับการเพิ่ม dependency ให้ frontend bundle
 */
const Bars: React.FC<{
  buckets: Bucket[];
  granularity: TrafficResponse['granularity'];
  onPick: (b: Bucket) => void;
}> = ({ buckets, granularity, onPick }) => {
  const max = Math.max(1, ...buckets.map(b => b.requests + b.webhook_events));

  return (
    <div className="overflow-x-auto">
      <div className="flex items-end gap-1 min-w-max h-52 px-1">
        {buckets.map(b => {
          const total = b.requests + b.webhook_events;
          const errors = b.errors_4xx + b.errors_5xx;
          const h = Math.max(2, Math.round((total / max) * 190));
          const eh = total > 0 ? Math.round((errors / total) * h) : 0;
          return (
            <button
              key={b.bucket}
              onClick={() => onPick(b)}
              className="group relative flex flex-col justify-end w-8 shrink-0 focus:outline-none
                         focus-visible:ring-2 focus-visible:ring-[var(--brand-fg)] rounded-t"
              title={`${bucketLabel(b.bucket, granularity)}\nเรียกทั้งหมด ${formatNumber(total)}\nข้อผิดพลาด ${formatNumber(errors)}`}
              aria-label={`${bucketLabel(b.bucket, granularity)} เรียก ${total} ครั้ง ข้อผิดพลาด ${errors} ครั้ง`}
            >
              <div className="w-full rounded-t transition-opacity group-hover:opacity-80"
                   style={{ height: h - eh, background: BRAND }} />
              {eh > 0 && <div className="w-full bg-red-500 rounded-t" style={{ height: eh }} />}
            </button>
          );
        })}
      </div>
      <div className="flex gap-1 min-w-max px-1 mt-1.5">
        {buckets.map(b => (
          <div key={b.bucket}
               className="w-8 shrink-0 text-[9px] text-slate-400 text-center truncate"
               title={bucketLabel(b.bucket, granularity)}>
            {granularity === 'year' ? b.bucket.slice(2, 4) : b.bucket.slice(5).replace('-', '/')}
          </div>
        ))}
      </div>
    </div>
  );
};

// ── หน้าหลัก ─────────────────────────────────────────────────────────────────

export const Traffic: React.FC = () => {
  const { token } = useAuth();
  const today = todayThai();

  const { state, set } = useHashState('traffic', {
    granularity: 'day',
    dateFrom: shiftDay(today, -29),
    dateTo: today,
  });
  const granularity = (state.granularity || 'day') as TrafficResponse['granularity'];

  const [data, setData] = useState<TrafficResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Bucket | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({
        granularity, dateFrom: state.dateFrom, dateTo: state.dateTo,
      });
      const res = await fetch(`/api/admin/logs/traffic?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setData(await res.json());
    } catch (e: unknown) { setError(errMsg(e)); } finally { setLoading(false); }
  }, [token, granularity, state.dateFrom, state.dateTo]);

  // ยิงผ่าน setTimeout ไม่เรียก setState ตรง ๆ ในตัว effect (กฎ react-hooks/set-state-in-effect
  // — pattern เดียวกับ ApiLogs.tsx / Quotations.tsx)
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  /** เลือกระดับการรวม = เปลี่ยนช่วงวันตั้งต้นให้เหมาะกันด้วย (ดูรายปีด้วยช่วง 30 วันไม่มีความหมาย) */
  const pickGranularity = (g: typeof granularity) => {
    const days = GRANULARITIES.find(x => x.key === g)!.days;
    set({ granularity: g, dateTo: today, dateFrom: shiftDay(today, -(days - 1)) });
    setPicked(null);
  };

  /** เลื่อนหน้า–หลังทีละความยาวช่วงปัจจุบัน */
  const shiftRange = (dir: -1 | 1) => {
    const span = Math.round(
      (Date.parse(`${state.dateTo}T00:00:00Z`) - Date.parse(`${state.dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
    set({
      dateFrom: shiftDay(state.dateFrom, dir * span),
      dateTo: shiftDay(state.dateTo, dir * span),
    });
    setPicked(null);
  };

  const t = data?.totals ?? null;
  const p = data?.previous.totals ?? null;
  const errRate = useMemo(() => {
    if (!t || t.requests === 0) return 0;
    return ((t.errors_4xx + t.errors_5xx) / t.requests) * 100;
  }, [t]);
  const prevErrRate = useMemo(() => {
    if (!p || p.requests === 0) return 0;
    return ((p.errors_4xx + p.errors_5xx) / p.requests) * 100;
  }, [p]);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const doExport = async () => {
    setExporting(true); setExportError(null);
    try {
      await downloadCsv(
        `/api/admin/logs/export/traffic?granularity=${granularity}&dateFrom=${state.dateFrom}&dateTo=${state.dateTo}`,
        token, `traffic-${state.dateFrom}-${state.dateTo}.csv`);
    } catch (e: unknown) { setExportError(errMsg(e)); } finally { setExporting(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeader icon={BarChart3} title="รายงานการใช้งาน"
                  description="ปริมาณการใช้งานย้อนหลัง วัน / สัปดาห์ / เดือน / ปี">
        <button
          onClick={() => { void load(); }}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200
                     text-sm text-slate-600 hover:bg-slate-50 transition"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">โหลดใหม่</span>
        </button>
        <button
          onClick={() => { void doExport(); }}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-white
                     transition disabled:opacity-60"
          style={{ background: BRAND }}
          title={exportError ?? 'ส่งออกเป็น CSV — รูปแบบที่ใช้ส่งมอบเมื่อมีหมายเรียก'}
        >
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          <span className="hidden sm:inline">ส่งออก CSV</span>
        </button>
      </PageHeader>

      {/* ── ตัวเลือกช่วงเวลา ── */}
      <div className="bg-card border border-slate-200 rounded-2xl p-4 flex flex-wrap items-end gap-3">
        <div className="flex rounded-xl border border-slate-200 overflow-hidden">
          {GRANULARITIES.map(g => (
            <button
              key={g.key}
              onClick={() => pickGranularity(g.key)}
              className={`px-3.5 py-2 text-sm font-medium transition ${
                granularity === g.key ? 'text-white' : 'text-slate-600 hover:bg-slate-50'}`}
              style={granularity === g.key ? { background: BRAND } : undefined}
              aria-pressed={granularity === g.key}
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <div>
            <label className="block text-xs text-slate-500 mb-1">ตั้งแต่</label>
            <DateInput value={state.dateFrom} onChange={v => set({ dateFrom: v })} />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">ถึง</label>
            <DateInput value={state.dateTo} onChange={v => set({ dateTo: v })} />
          </div>
        </div>

        <div className="flex gap-1">
          <button onClick={() => shiftRange(-1)}
                  className="px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-600 hover:bg-slate-50">
            ← ช่วงก่อน
          </button>
          <button onClick={() => shiftRange(1)}
                  className="px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-600 hover:bg-slate-50">
            ช่วงถัดไป →
          </button>
        </div>

        {data?.coverage.first_day && (
          <div className="text-xs text-slate-400 ml-auto">
            มีข้อมูลตั้งแต่ {formatDate(data.coverage.first_day)} ถึง {formatDate(data.coverage.last_day)}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-red-800">โหลดรายงานไม่สำเร็จ</div>
            <div className="text-xs text-red-600 mt-0.5">{error}</div>
          </div>
          <button onClick={() => { void load(); }}
                  className="px-3 py-1.5 rounded-lg bg-white border border-red-200 text-sm text-red-700">
            ลองใหม่
          </button>
        </div>
      )}

      {loading && !data && (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-card border border-slate-200 rounded-2xl p-4 animate-pulse">
              <div className="h-3 w-20 bg-slate-200 rounded" />
              <div className="h-7 w-16 bg-slate-200 rounded mt-2.5" />
            </div>
          ))}
        </div>
      )}

      {data && t && (
        <>
          {/* ── แถว KPI ── */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <Kpi label="เรียก API ทั้งหมด" value={formatNumber(t.requests)}
                 now={t.requests} before={p?.requests ?? 0}
                 sub={`${formatNumber(t.days)} วัน`} />
            <Kpi label="งานของบอท" value={formatNumber(t.webhook_events)}
                 now={t.webhook_events} before={p?.webhook_events ?? 0}
                 sub={t.webhook_dropped + t.webhook_timeout > 0
                   ? `ตกหล่น ${formatNumber(t.webhook_dropped + t.webhook_timeout)}` : 'ไม่มีตกหล่น'} />
            <Kpi label="ผู้ใช้ LINE ไม่ซ้ำ" value={formatNumber(t.uniq_line_users_max)}
                 hint={data.notes.uniq} sub="สูงสุดรายวัน" />
            <Kpi label="ใบเสนอราคาที่ออก" value={formatNumber(t.quotations_created)}
                 now={t.quotations_created} before={p?.quotations_created ?? 0} />
            <Kpi label="อัตราข้อผิดพลาด" value={`${errRate.toFixed(2)}%`} tone="bad"
                 now={Math.round(errRate * 100)} before={Math.round(prevErrRate * 100)}
                 sub={`4xx ${formatNumber(t.errors_4xx)} · 5xx ${formatNumber(t.errors_5xx)}`} />
            <Kpi label="เวลาตอบเฉลี่ย" value={formatMs(t.avg_ms)} tone="bad"
                 now={t.avg_ms ?? 0} before={p?.avg_ms ?? 0}
                 hint={data.notes.p95}
                 sub={`p95 สูงสุดรายวัน ${formatMs(t.p95_worst_day)}`} />
          </div>

          {/* ── กราฟ ── */}
          <div className="bg-card border border-slate-200 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-700">ปริมาณตามช่วงเวลา</h3>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: BRAND }} /> ปกติ
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-red-500" /> ข้อผิดพลาด
                </span>
              </div>
            </div>
            {data.buckets.length === 0 ? (
              <div className="py-14 text-center text-sm text-slate-400">
                ไม่มีข้อมูลในช่วงที่เลือก
                {data.coverage.first_day &&
                  <div className="mt-1 text-xs">ลองเลือกช่วงตั้งแต่ {formatDate(data.coverage.first_day)} เป็นต้นไป</div>}
              </div>
            ) : (
              <Bars buckets={data.buckets} granularity={granularity} onPick={setPicked} />
            )}
          </div>

          {/* ── ตารางรายละเอียด (ยุบเป็นการ์ดบนจอแคบ) ── */}
          <div className="bg-card border border-slate-200 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto hidden md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-4 py-2.5">ช่วง</th>
                    <th className="text-right font-medium px-3 py-2.5">เรียก API</th>
                    <th className="text-right font-medium px-3 py-2.5">งานบอท</th>
                    <th className="text-right font-medium px-3 py-2.5">ใบเสนอราคา</th>
                    <th className="text-right font-medium px-3 py-2.5">ข้อความเข้า</th>
                    <th className="text-right font-medium px-3 py-2.5">4xx</th>
                    <th className="text-right font-medium px-3 py-2.5">5xx</th>
                    <th className="text-right font-medium px-3 py-2.5">เฉลี่ย</th>
                    <th className="text-right font-medium px-3 py-2.5" title={data.notes.p95}>p95 สูงสุด</th>
                    <th className="text-right font-medium px-3 py-2.5">การแก้ไข</th>
                    <th className="text-right font-medium px-4 py-2.5">ข้อมูลออก</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.buckets.map(b => (
                    <tr key={b.bucket}
                        className={`hover:bg-slate-50 cursor-pointer ${picked?.bucket === b.bucket ? 'bg-slate-50' : ''}`}
                        onClick={() => setPicked(picked?.bucket === b.bucket ? null : b)}>
                      <td className="px-4 py-2.5 text-slate-700">{bucketLabel(b.bucket, granularity)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(b.requests)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(b.webhook_events)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(b.quotations_created)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(b.messages_in)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${b.errors_4xx > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                        {formatNumber(b.errors_4xx)}
                      </td>
                      <td className={`px-3 py-2.5 text-right tabular-nums ${b.errors_5xx > 0 ? 'text-red-600 font-medium' : 'text-slate-400'}`}>
                        {formatNumber(b.errors_5xx)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatMs(b.avg_ms)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{formatMs(b.p95_worst_day)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(b.audit_changes)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{formatBytes(b.bytes_out)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* จอแคบ: ยุบเป็นการ์ด */}
            <div className="md:hidden divide-y divide-slate-100">
              {data.buckets.map(b => (
                <div key={b.bucket} className="p-3.5">
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm font-medium text-slate-700">{bucketLabel(b.bucket, granularity)}</span>
                    <span className="text-sm tabular-nums text-slate-900">{formatNumber(b.requests)} ครั้ง</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 tabular-nums">
                    <span>งานบอท {formatNumber(b.webhook_events)}</span>
                    <span>ใบเสนอราคา {formatNumber(b.quotations_created)}</span>
                    <span className={b.errors_5xx > 0 ? 'text-red-600 font-medium' : ''}>
                      5xx {formatNumber(b.errors_5xx)}
                    </span>
                    <span>เฉลี่ย {formatMs(b.avg_ms)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── รายละเอียดของช่วงที่คลิก ── */}
          {picked && (
            <div className="bg-card border rounded-2xl p-4" style={{ borderColor: 'var(--brand-border)' }}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-700">
                  {bucketLabel(picked.bucket, granularity)}
                  <span className="ml-2 text-xs font-normal text-slate-400">({picked.days} วัน)</span>
                </h3>
                <button onClick={() => setPicked(null)} className="text-xs text-slate-400 hover:text-slate-600">
                  ปิด
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-x-6 gap-y-2.5 text-sm">
                {([
                  ['เรียก API ทั้งหมด', formatNumber(picked.requests)],
                  ['เฉพาะ /api/*', formatNumber(picked.requests_api)],
                  ['งานของบอท', formatNumber(picked.webhook_events)],
                  ['บอทตกหล่น (คิวตัน)', formatNumber(picked.webhook_dropped)],
                  ['บอทเกินงบเวลา', formatNumber(picked.webhook_timeout)],
                  ['ผู้ใช้ LINE ไม่ซ้ำ', formatNumber(picked.uniq_line_users_max)],
                  ['แอดมินไม่ซ้ำ', formatNumber(picked.uniq_admin_users_max)],
                  ['IP ไม่ซ้ำ', formatNumber(picked.uniq_ips_max)],
                  ['pool ไม่พอ (ครั้ง)', formatNumber(picked.db_wait_hits)],
                  ['request พร้อมกันสูงสุด', formatNumber(picked.max_inflight)],
                  ['การแก้ไขข้อมูล', formatNumber(picked.audit_changes)],
                  ['ข้อผิดพลาดของระบบ', formatNumber(picked.system_errors)],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k}>
                    <div className="text-xs text-slate-400">{k}</div>
                    <div className="tabular-nums text-slate-800">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-slate-400 px-1 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{data.notes.p95} · {data.notes.uniq}</span>
          </p>
        </>
      )}

      {loading && data && (
        <div className="fixed bottom-6 right-6 bg-card border border-slate-200 rounded-full px-3.5 py-2
                        shadow-lg flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังโหลด
        </div>
      )}
    </div>
  );
};
