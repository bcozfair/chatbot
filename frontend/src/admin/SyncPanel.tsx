import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Database,
  Save,
  Info,
} from 'lucide-react';

const BRAND = '#009032';

type ResourceId = 'products' | 'customers' | 'saleorders';

type RunStatus = 'success' | 'failed' | 'aborted' | 'skipped';

interface ResourceStatus {
  id: ResourceId;
  label: string;
  /** เวลาที่ commit หน้าล่าสุดสำเร็จ — ไม่ใช่ "รอบล่าสุดสำเร็จ" ต้องอ่านคู่กับ last_status */
  last_success_at: string | null;
  records_synced: number;
  sync_mode: string | null;
  last_status: RunStatus | null;
  last_run_at: string | null;
  /** error ล่าสุด — ไม่ถูกล้างเมื่อรอบถัดไปสำเร็จ จึงยังเห็นได้แม้ตอนนี้ปกติแล้ว */
  last_error: string | null;
  last_error_at: string | null;
}

interface SyncSettings {
  auto_enabled: boolean;
  /** 0=อาทิตย์ … 6=เสาร์ ตรงกับ Date.getDay() — ว่าง = ทุกวัน */
  days: number[];
  window_start: string; // 'HH:MM'
  window_end: string; // 'HH:MM'
  interval_seconds: number;
  resources: ResourceId[];
  updated_at: string | null;
}

interface SyncStatus {
  running: boolean;
  currentResource: ResourceId | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  aborted: boolean;
  trigger: 'manual' | 'schedule' | null;
  resources: ResourceStatus[];
  settings: SyncSettings;
}

/** เรียงแบบปฏิทินไทย จันทร์ก่อน แต่ค่าที่เก็บตรงกับ Date.getDay() */
const DAY_CHIPS: { value: number; label: string }[] = [
  { value: 1, label: 'จ' },
  { value: 2, label: 'อ' },
  { value: 3, label: 'พ' },
  { value: 4, label: 'พฤ' },
  { value: 5, label: 'ศ' },
  { value: 6, label: 'ส' },
  { value: 0, label: 'อา' },
];

const MIN_INTERVAL_SECONDS = 30;
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const sameDays = (a: number[], b: number[]) => a.length === b.length && b.every((d) => a.includes(d));

/** ปุ่มลัด — ติดสถานะ active ด้วย จึงบอกได้ในตัวว่าตอนนี้เลือกอยู่แบบไหน */
const DAY_PRESETS: { label: string; days: number[]; isActive: (days: number[]) => boolean }[] = [
  { label: 'ทุกวัน', days: ALL_DAYS, isActive: (d) => d.length === 0 || sameDays(d, ALL_DAYS) },
  { label: 'จ.-ศ.', days: WEEKDAYS, isActive: (d) => sameDays(d, WEEKDAYS) },
];

type IntervalUnit = 'sec' | 'min';

/** วินาที → ค่าที่โชว์ในช่องกรอก + หน่วยที่เหมาะ (90 วิ ไม่ลงตัวนาที จึงโชว์เป็นวินาที) */
function splitInterval(seconds: number): { value: number; unit: IntervalUnit } {
  if (seconds >= 60 && seconds % 60 === 0) return { value: seconds / 60, unit: 'min' };
  return { value: seconds, unit: 'sec' };
}

function describeSchedule(s: SyncSettings): string {
  const days =
    s.days.length === 0 || s.days.length === 7
      ? 'ทุกวัน'
      : s.days.length === 5 && WEEKDAYS.every((d) => s.days.includes(d))
      ? 'จ.-ศ.'
      : DAY_CHIPS.filter((d) => s.days.includes(d.value))
          .map((d) => d.label)
          .join(' ');

  const { value, unit } = splitInterval(s.interval_seconds);
  const every = `ทุก ${value} ${unit === 'min' ? 'นาที' : 'วินาที'}`;
  const when =
    s.window_start === s.window_end ? `เวลา ${s.window_start}` : `${s.window_start}-${s.window_end}`;

  return `${days} ${when} · ${every}`;
}

const STATUS_LABEL: Record<RunStatus, string> = {
  success: 'สำเร็จ',
  failed: 'ล้มเหลว',
  aborted: 'ถูกยกเลิก',
  skipped: 'ถูกข้าม',
};

const RECENT_ERROR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** error เก่ากว่า 7 วันไม่ต้องเตือนแล้ว (ไม่งั้นแถบเตือนค้างตลอดกาลเพราะเราไม่ล้างค่า) */
function isRecent(iso: string | null): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !isNaN(t) && Date.now() - t < RECENT_ERROR_WINDOW_MS;
}

function formatThaiDateTime(iso: string | null): string {
  if (!iso) return 'ยังไม่เคย sync';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'ยังไม่เคย sync';
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SyncPanel() {
  const { token } = useAuth();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // ฟอร์มตั้งเวลา (แยกจาก status เพื่อแก้ไขได้อิสระ)
  const [form, setForm] = useState<SyncSettings | null>(null);
  // ช่อง interval แยกเก็บเป็นสตริง+หน่วย เพื่อให้พิมพ์ลบจนว่างได้โดยฟอร์มไม่กระตุก
  const [intervalInput, setIntervalInput] = useState('15');
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('min');
  const intervalReady = useRef(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasRunning = useRef(false);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const fetchStatus = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!token) return;
      if (!opts?.silent) setLoading(true);
      try {
        const res = await fetch('/api/admin/sync/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('ไม่สามารถดึงสถานะการ sync ได้');
        const data: SyncStatus = await res.json();
        setStatus(data);
        setError(null);
        // ตั้งค่าฟอร์มครั้งแรก / เมื่อยังไม่แตะ (ถ้าแตะแล้วไม่ทับ)
        setForm((prev) => prev ?? data.settings);
        if (!intervalReady.current) {
          const { value, unit } = splitInterval(data.settings.interval_seconds);
          setIntervalInput(String(value));
          setIntervalUnit(unit);
          intervalReady.current = true;
        }
        return data;
      } catch (err: unknown) {
        if (!opts?.silent) {
          setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการโหลดข้อมูล');
        }
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [token]
  );

  // โหลดครั้งแรก — defer ด้วย setTimeout(0) เพื่อไม่ให้ setState ทำงาน sync ใน effect body
  useEffect(() => {
    const t = setTimeout(() => fetchStatus(), 0);
    return () => {
      clearTimeout(t);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [fetchStatus]);

  // Poll ระหว่างที่กำลัง sync แล้วหยุดเมื่อเสร็จ
  const running = status?.running ?? false;
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      if (!pollTimer.current) {
        pollTimer.current = setInterval(() => {
          fetchStatus({ silent: true });
        }, 3000);
      }
      return;
    }

    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    // เพิ่งเปลี่ยนจากรัน -> ไม่รัน => แจ้งผล (defer เพื่อไม่ให้ setState ทำงาน sync ใน effect body)
    if (wasRunning.current) {
      wasRunning.current = false;
      const err = status?.lastError;
      const t = setTimeout(() => {
        if (err) showToast(`sync เสร็จ แต่มีข้อผิดพลาด: ${err}`, 'error');
        else showToast('sync ข้อมูลเสร็จเรียบร้อยแล้ว', 'success');
      }, 0);
      return () => clearTimeout(t);
    }
  }, [running, status?.lastError, fetchStatus, showToast]);

  const triggerSync = async (resources: ResourceId[] | 'all') => {
    if (!token || running) return;
    try {
      const res = await fetch('/api/admin/sync/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ resources }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'ไม่สามารถเริ่ม sync ได้');
      showToast('เริ่ม sync ข้อมูลแล้ว...', 'success');
      await fetchStatus({ silent: true });
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'เริ่ม sync ไม่สำเร็จ', 'error');
    }
  };

  const saveSettings = async () => {
    if (!token || !form) return;
    setIsSaving(true);
    try {
      const res = await fetch('/api/admin/sync/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(form),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'ไม่สามารถบันทึกการตั้งค่าได้');
      setForm(result.settings);
      setStatus((prev) => (prev ? { ...prev, settings: result.settings } : prev));
      // server clamp ค่าให้อยู่ในช่วงที่รับได้ → sync ช่องกรอกกลับตามของจริงที่บันทึกลงไป
      const applied = splitInterval(result.settings.interval_seconds);
      setIntervalInput(String(applied.value));
      setIntervalUnit(applied.unit);
      showToast('บันทึกการตั้งค่าตารางเวลาสำเร็จ', 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleFormResource = (id: ResourceId) => {
    setForm((prev) => {
      if (!prev) return prev;
      const has = prev.resources.includes(id);
      const next = has ? prev.resources.filter((r) => r !== id) : [...prev.resources, id];
      return { ...prev, resources: next };
    });
  };

  const toggleDay = (day: number) => {
    setForm((prev) => {
      if (!prev) return prev;
      const has = prev.days.includes(day);
      const next = has ? prev.days.filter((d) => d !== day) : [...prev.days, day];
      return { ...prev, days: next.sort((a, b) => a - b) };
    });
  };

  /** ช่องเลข interval — อัปเดต form เฉพาะตอนที่ค่าใช้ได้ ระหว่างพิมพ์ปล่อยให้ว่างได้ */
  const applyInterval = (raw: string, unit: IntervalUnit) => {
    setIntervalInput(raw);
    setIntervalUnit(unit);
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return;
    setForm((prev) => (prev ? { ...prev, interval_seconds: unit === 'min' ? n * 60 : n } : prev));
  };

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-7 h-7 animate-spin" style={{ color: BRAND }} />
        <p className="text-slate-500 text-sm font-medium">กำลังโหลดสถานะการ sync...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-700 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
          <button
            onClick={() => fetchStatus()}
            className="ml-auto text-xs font-semibold text-red-700 underline hover:no-underline"
          >
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  const resources = status?.resources ?? [];
  const failing = resources.filter((r) => r.last_status && r.last_status !== 'success');
  const recovered = resources.filter(
    (r) => r.last_status === 'success' && r.last_error && isRecent(r.last_error_at)
  );

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'rgba(0,144,50,0.10)', color: BRAND }}
          >
            <Database className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900 leading-tight">ซิงค์ข้อมูลจาก ERP</h3>
            <p className="text-[11px] text-slate-400 leading-tight truncate">สินค้า · ลูกค้า · ใบสั่งขาย</p>
          </div>
        </div>
        <button
          onClick={() => triggerSync('all')}
          disabled={running}
          className="flex items-center justify-center gap-1.5 px-3.5 py-2 text-white text-xs font-bold rounded-lg shadow-sm transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
          style={{ backgroundColor: BRAND }}
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {running ? 'กำลัง sync...' : 'Sync ทั้งหมด'}
        </button>
      </div>

      {/* Running banner */}
      {running && (
        <div className="flex items-center gap-2 px-4 sm:px-5 py-1.5 bg-emerald-50 border-b border-emerald-100 text-emerald-800 text-[11px] font-medium">
          <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          <span className="truncate">
            กำลัง sync
            {status?.currentResource
              ? `: ${resources.find((r) => r.id === status.currentResource)?.label ?? status.currentResource}`
              : '...'}
            {status?.trigger === 'schedule' ? ' (อัตโนมัติ)' : ''}
          </span>
        </div>
      )}

      {/* แถบแดงค้าง — รอบล่าสุดยังพังอยู่ ต่างจาก toast ตรงที่ไม่หายไปใน 4 วิ */}
      {!running && failing.length > 0 && (
        <div className="px-4 sm:px-5 py-2 bg-red-50 border-b border-red-100 text-red-800 text-[11px] space-y-0.5">
          {failing.map((r) => (
            <div key={r.id} className="flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span className="min-w-0">
                <span className="font-bold">
                  {r.label}: {STATUS_LABEL[r.last_status as RunStatus]}
                </span>{' '}
                {formatThaiDateTime(r.last_run_at)} — {r.last_error}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* แถบเหลือง — ตอนนี้ปกติแล้ว แต่เคยพังภายใน 7 วัน (error ไม่ถูกล้างตอน sync สำเร็จ
          เพราะ auto sync แบบ interval จะทับ error กลางดึกทิ้งก่อนมีคนเห็น) */}
      {!running && failing.length === 0 && recovered.length > 0 && (
        <div className="px-4 sm:px-5 py-2 bg-amber-50 border-b border-amber-100 text-amber-800 text-[11px] space-y-0.5">
          {recovered.map((r) => (
            <div key={r.id} className="flex items-start gap-2">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span className="min-w-0">
                <span className="font-bold">{r.label}</span> เคยผิดพลาด{' '}
                {formatThaiDateTime(r.last_error_at)} — {r.last_error}{' '}
                <span className="text-amber-600">(ตอนนี้ปกติแล้ว)</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Per-resource rows */}
      <div className="divide-y divide-slate-100">
        {resources.map((r) => {
          const isCurrent = running && status?.currentResource === r.id;
          const failed = !!r.last_status && r.last_status !== 'success';
          return (
            <div key={r.id} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-slate-800 shrink-0">{r.label}</span>
                {failed ? (
                  <span className="shrink-0 px-1.5 py-px rounded bg-red-100 text-red-700 text-[10px] font-bold">
                    {STATUS_LABEL[r.last_status as RunStatus]}
                  </span>
                ) : r.last_status === 'success' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
                ) : null}
                <span className="text-[11px] text-slate-400 flex items-center gap-1 min-w-0">
                  <Clock className="w-3 h-3 shrink-0" />
                  <span className="truncate">
                    {/* รอบที่ล้ม: last_success_at คือ "ข้อมูลไหลถึงไหน" ไม่ใช่เวลาที่ sync สำเร็จ */}
                    {failed
                      ? `ล้มเหลว ${formatThaiDateTime(r.last_run_at)} · ข้อมูลถึง ${formatThaiDateTime(r.last_success_at)}`
                      : formatThaiDateTime(r.last_run_at ?? r.last_success_at)}
                    {r.records_synced ? ` · ${r.records_synced.toLocaleString('th-TH')}` : ''}
                  </span>
                </span>
              </div>
              <button
                onClick={() => triggerSync([r.id])}
                disabled={running}
                className="flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-md text-[11px] font-semibold shadow-sm transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {isCurrent ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Sync
              </button>
            </div>
          );
        })}
      </div>

      {/* Auto schedule section */}
      {form && (
        <div className="border-t border-slate-100 bg-slate-50/50 px-4 sm:px-5 py-3 space-y-3">
          {/* Enable toggle */}
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-xs font-bold text-slate-700">Sync อัตโนมัติตามเวลา</span>
            <div
              className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors ${
                form.auto_enabled ? '' : 'bg-slate-300'
              }`}
              style={form.auto_enabled ? { backgroundColor: BRAND } : undefined}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-all ${
                  form.auto_enabled ? 'left-4' : 'left-0.5'
                }`}
              />
              <input
                type="checkbox"
                checked={form.auto_enabled}
                onChange={(e) => setForm({ ...form, auto_enabled: e.target.checked })}
                className="sr-only"
              />
            </div>
          </label>

          {form.auto_enabled && (
            <div className="space-y-2.5 animate-fade-in">
              {/* วัน */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[11px] font-semibold text-slate-400 w-12 shrink-0">วัน</span>

                {/* segmented control — 7 วันเป็นก้อนเดียว ไม่ใช่ปุ่มลอย 7 ตัว */}
                <div className="flex rounded-lg border border-slate-200 overflow-hidden divide-x divide-slate-200">
                  {DAY_CHIPS.map((d) => {
                    // days ว่าง = ทุกวัน จึงโชว์เป็นเลือกครบ
                    const active = form.days.length === 0 || form.days.includes(d.value);
                    return (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => toggleDay(d.value)}
                        aria-pressed={active}
                        className={`w-8 py-1 text-[11px] font-bold transition-colors ${
                          active ? 'text-white' : 'bg-slate-50 text-slate-400 hover:bg-white'
                        }`}
                        style={active ? { backgroundColor: BRAND } : undefined}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>

                {/* ชิดขวาตามแพตเทิร์นของการ์ดนี้ (ป้ายซ้าย–ปุ่มขวา) ให้อ่านว่าคนละหน้าที่กับชิปวัน */}
                <div className="flex items-center gap-1 ml-auto">
                  {DAY_PRESETS.map((p) => {
                    const active = p.isActive(form.days);
                    return (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => setForm({ ...form, days: [...p.days] })}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
                          active ? '' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                        }`}
                        style={active ? { backgroundColor: 'rgba(0,144,50,0.10)', color: BRAND } : undefined}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ช่วงเวลา */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-[11px] font-semibold text-slate-400 w-12 shrink-0">เวลา</span>
                <input
                  type="time"
                  value={form.window_start}
                  onChange={(e) => setForm({ ...form, window_start: e.target.value })}
                  className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#009032]/20 focus:border-[#009032]"
                />
                <span className="text-slate-500">ถึง</span>
                <input
                  type="time"
                  value={form.window_end}
                  onChange={(e) => setForm({ ...form, window_end: e.target.value })}
                  className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#009032]/20 focus:border-[#009032]"
                />
                <span className="text-slate-400">น.</span>
              </div>

              {/* interval */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-[11px] font-semibold text-slate-400 w-12 shrink-0">ทุก ๆ</span>
                <input
                  type="number"
                  min={1}
                  value={intervalInput}
                  onChange={(e) => applyInterval(e.target.value, intervalUnit)}
                  className="w-20 px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#009032]/20 focus:border-[#009032]"
                />
                <select
                  value={intervalUnit}
                  onChange={(e) => applyInterval(intervalInput, e.target.value as IntervalUnit)}
                  className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#009032]/20 focus:border-[#009032]"
                >
                  <option value="sec">วินาที</option>
                  <option value="min">นาที</option>
                </select>
              </div>

              {/* สรุปเป็นประโยค — config มี 3 มิติแล้ว อ่านจากฟอร์มเปล่า ๆ ตีความยาก */}
              <p className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: BRAND }}>
                <Clock className="w-3 h-3 shrink-0" />
                {describeSchedule(form)}
              </p>

              {form.window_start === form.window_end && (
                <p className="flex items-start gap-1 text-[11px] text-slate-400">
                  <Info className="w-3 h-3 shrink-0 mt-0.5" />
                  เวลาเริ่มกับสิ้นสุดเท่ากัน = ยิงครั้งเดียวต่อวัน (ถ้า interval ตั้งไว้ตั้งแต่ 1 นาทีขึ้นไป)
                </p>
              )}

              {form.interval_seconds < 60 && (
                <p className="flex items-start gap-1 text-[11px] text-amber-600">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  รอบ sync จริงใช้เวลาหลายนาที ตั้งต่ำกว่า 1 นาทีจะกลายเป็นวิ่งต่อเนื่องตลอดช่วงเวลา
                  (ต่ำสุดที่ระบบรับคือ {MIN_INTERVAL_SECONDS} วินาที)
                </p>
              )}

              {/* Resource selection (compact chips) */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-slate-400 mr-0.5">ข้อมูล:</span>
                {resources.map((r) => {
                  const checked = form.resources.includes(r.id);
                  return (
                    <label
                      key={r.id}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold border cursor-pointer transition-all ${
                        checked ? 'border-transparent' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                      }`}
                      style={
                        checked
                          ? { backgroundColor: 'rgba(0,144,50,0.10)', color: BRAND, borderColor: 'rgba(0,144,50,0.24)' }
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleFormResource(r.id)}
                        className="sr-only"
                      />
                      {checked && <CheckCircle2 className="w-3 h-3" />}
                      {r.label}
                    </label>
                  );
                })}
              </div>

              {form.resources.length === 0 && (
                <p className="flex items-center gap-1 text-[11px] text-amber-600">
                  <Info className="w-3 h-3 shrink-0" />
                  ไม่เลือก = sync ทั้งหมดโดยปริยาย
                </p>
              )}
            </div>
          )}

          {/* Save */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] text-slate-400 truncate">
              {form.updated_at ? `ตั้งค่าล่าสุด: ${formatThaiDateTime(form.updated_at)}` : 'ยังไม่เคยตั้งค่า'}
            </p>
            <button
              onClick={saveSettings}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-bold text-white rounded-lg transition-all active:scale-95 shadow-sm disabled:opacity-60 shrink-0"
              style={{ backgroundColor: BRAND }}
            >
              {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              บันทึก
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl border animate-fade-in ${
            toast.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
          )}
          <span className="text-sm font-medium">{toast.message}</span>
        </div>
      )}
    </div>
  );
}
