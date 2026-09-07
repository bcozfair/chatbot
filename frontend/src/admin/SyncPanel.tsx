import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
  ChevronRight,
  RotateCcw,
  MoreVertical,
} from 'lucide-react';

const BRAND = 'var(--brand-fg)';

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
  /** true = รอบที่กำลังรันเป็น full sync (กวาดใหม่ทั้งหมด) */
  forceFull?: boolean;
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
/** ต้องพิมพ์ตรงตัวก่อนเริ่ม full sync — กันกดยืนยันโดยไม่ได้อ่าน */
const CONFIRM_WORD = 'ยืนยัน';
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

/** จำสถานะ ย่อ/ขยาย ของแต่ละแถบไว้ใน localStorage — refresh แล้วยังจำได้ (default = ยุบ) */
function useCollapsed(storageKey: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      // ค่าอื่นนอกจาก 'false' = ยุบ (รวม null ตอนยังไม่เคยตั้ง จึงยุบเป็น default)
      return localStorage.getItem(storageKey) !== 'false';
    } catch {
      return true;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* localStorage ใช้ไม่ได้ (private mode ฯลฯ) — ยังทำงานได้แค่ไม่จำข้ามรอบ */
      }
      return next;
    });
  }, [storageKey]);
  return [collapsed, toggle];
}

/** โทนสีของแถบ — คุมพื้นหลัง/เส้นขอบ/ตัวอักษร/สีจาง ให้แดงกับเหลืองใช้โครงเดียวกัน */
const BAND_TONES = {
  red: {
    wrap: 'bg-red-50 border-red-100 text-red-800',
    hover: 'hover:bg-red-100/60',
    muted: 'text-red-600',
  },
  amber: {
    wrap: 'bg-amber-50 border-amber-100 text-amber-800',
    hover: 'hover:bg-amber-100/60',
    muted: 'text-amber-600',
  },
} as const;

type BandTone = keyof typeof BAND_TONES;

/**
 * แถบแจ้งเตือนที่ย่อ/ขยายได้ — ยุบเหลือสรุปบรรทัดเดียว + จำนวน, คลิกทั้งหัวแถบเพื่อกาง
 * ถ้ามีรายการเดียวก็โชว์เต็มไปเลย (ยุบ 1 บรรทัดเหลือ 1 บรรทัดไม่มีประโยชน์)
 */
function CollapsibleAlertBand<T>({
  tone,
  icon,
  items,
  summary,
  renderItem,
  storageKey,
}: {
  tone: BandTone;
  icon: ReactNode;
  items: T[];
  /** สรุปบรรทัดเดียวตอนยุบ — รับจำนวนไปประกอบข้อความ */
  summary: (count: number) => ReactNode;
  renderItem: (item: T) => ReactNode;
  storageKey: string;
}) {
  const [collapsed, toggle] = useCollapsed(storageKey);
  const t = BAND_TONES[tone];
  const collapsible = items.length > 1;
  const showList = !collapsible || !collapsed;

  return (
    <div className={`border-b ${t.wrap} text-[11px]`}>
      {collapsible && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className={`w-full flex items-center gap-2 px-4 sm:px-5 py-2 text-left transition-colors ${t.hover}`}
        >
          <ChevronRight
            className={`w-3.5 h-3.5 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          <span className="shrink-0">{icon}</span>
          <span className="min-w-0 font-bold truncate">{summary(items.length)}</span>
          <span className={`ml-auto shrink-0 font-semibold ${t.muted}`}>
            {collapsed ? 'แสดง' : 'ซ่อน'}
          </span>
        </button>
      )}
      {showList && (
        <div className={`px-4 sm:px-5 pb-2 space-y-0.5 ${collapsible ? '' : 'pt-2'}`}>
          {items.map((item) => renderItem(item))}
        </div>
      )}
    </div>
  );
}

export function SyncPanel() {
  const { token } = useAuth();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // เมนู "..." ราย resource — เปิดได้ทีละอันเดียว จึงใช้ ref เดียวพอ
  const [menuFor, setMenuFor] = useState<ResourceId | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** resource ที่รอยืนยัน full sync (null = ไม่มี dialog) + ข้อความที่ผู้ใช้พิมพ์ */
  const [fullTarget, setFullTarget] = useState<{ id: ResourceId; label: string } | null>(null);
  const [confirmText, setConfirmText] = useState('');

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

  // ปิดเมนู "..." เมื่อคลิกที่อื่นหรือกด Esc
  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuFor]);

  // Esc = ยกเลิกการยืนยัน full sync (ปุ่มยกเลิกยังมีอยู่ตามปกติ)
  useEffect(() => {
    if (!fullTarget) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullTarget(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [fullTarget]);

  const triggerSync = async (resources: ResourceId[] | 'all', full = false) => {
    if (!token || running) return;
    try {
      const res = await fetch('/api/admin/sync/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ resources, full }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'ไม่สามารถเริ่ม sync ได้');
      showToast(full ? 'เริ่ม full sync แล้ว (อาจใช้เวลานาน)...' : 'เริ่ม sync ข้อมูลแล้ว...', 'success');
      await fetchStatus({ silent: true });
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'เริ่ม sync ไม่สำเร็จ', 'error');
    }
  };

  /**
   * full sync กวาดใหม่ทั้งหมด ใช้เวลานานกว่ารอบปกติมากและกระทบข้อมูลทั้งชุด
   * จึงซ่อนไว้ในเมนู "..." แล้วบังคับพิมพ์คำยืนยันอีกชั้น
   * และรับได้ทีละ resource เท่านั้น (ฝั่ง server ก็ปฏิเสธถ้าส่งมาหลายรายการ)
   */
  const askFullSync = (id: ResourceId, label: string) => {
    if (running) return;
    setMenuFor(null);
    setConfirmText('');
    setFullTarget({ id, label });
  };

  const confirmFullSync = () => {
    if (!fullTarget || confirmText.trim() !== CONFIRM_WORD) return;
    const { id } = fullTarget;
    setFullTarget(null);
    setConfirmText('');
    void triggerSync([id], true);
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
      <div className="bg-card border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-7 h-7 animate-spin" style={{ color: BRAND }} />
        <p className="text-slate-500 text-sm font-medium">กำลังโหลดสถานะการ sync...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-card border border-slate-200 rounded-2xl p-6 shadow-sm">
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
  /** รอบที่กำลังรันอยู่เป็น full sync — ใช้เลือกว่าจะหมุน spinner ที่ปุ่มไหน */
  const fullRun = running && !!status?.forceFull;
  const failing = resources.filter((r) => r.last_status && r.last_status !== 'success');
  const recovered = resources.filter(
    (r) => r.last_status === 'success' && r.last_error && isRecent(r.last_error_at)
  );

  return (
    <div className="bg-card border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--brand-soft)', color: BRAND }}
          >
            <Database className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900 leading-tight">ซิงค์ข้อมูลจาก ERP</h3>
            <p className="text-[11px] text-slate-400 leading-tight truncate">สินค้า · ลูกค้า · ใบสั่งขาย</p>
          </div>
        </div>
        {/* Sync ทั้งหมด = incremental เสมอ — full sync มีให้เฉพาะรายรายการด้านล่าง
            (กวาดใหม่ทั้ง 3 resource พร้อมกันกินเวลานานเกินกว่าจะเป็นปุ่มกดพลาดได้) */}
        <button
          onClick={() => triggerSync('all')}
          disabled={running}
          className="flex items-center justify-center gap-1.5 px-3.5 py-2 text-white text-xs font-bold rounded-lg shadow-sm transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
          style={{ backgroundColor: 'var(--brand)' }}
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
            {fullRun ? 'กำลัง full sync' : 'กำลัง sync'}
            {status?.currentResource
              ? `: ${resources.find((r) => r.id === status.currentResource)?.label ?? status.currentResource}`
              : '...'}
            {status?.trigger === 'schedule' ? ' (อัตโนมัติ)' : ''}
          </span>
        </div>
      )}

      {/* แถบแดงค้าง — รอบล่าสุดยังพังอยู่ ต่างจาก toast ตรงที่ไม่หายไปใน 4 วิ */}
      {!running && failing.length > 0 && (
        <CollapsibleAlertBand
          tone="red"
          storageKey="syncPanel.failing.collapsed"
          items={failing}
          icon={<AlertTriangle className="w-3.5 h-3.5" />}
          summary={(n) => `${n} รายการ sync ล้มเหลว`}
          renderItem={(r) => (
            <div key={r.id} className="flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span className="min-w-0">
                <span className="font-bold">
                  {r.label}: {STATUS_LABEL[r.last_status as RunStatus]}
                </span>{' '}
                {formatThaiDateTime(r.last_run_at)} — {r.last_error}
              </span>
            </div>
          )}
        />
      )}

      {/* แถบเหลือง — ตอนนี้ปกติแล้ว แต่เคยพังภายใน 7 วัน (error ไม่ถูกล้างตอน sync สำเร็จ
          เพราะ auto sync แบบ interval จะทับ error กลางดึกทิ้งก่อนมีคนเห็น) */}
      {!running && failing.length === 0 && recovered.length > 0 && (
        <CollapsibleAlertBand
          tone="amber"
          storageKey="syncPanel.recovered.collapsed"
          items={recovered}
          icon={<Info className="w-3.5 h-3.5" />}
          summary={(n) => `${n} รายการเคยผิดพลาด (ตอนนี้ปกติแล้ว)`}
          renderItem={(r) => (
            <div key={r.id} className="flex items-start gap-2">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span className="min-w-0">
                <span className="font-bold">{r.label}</span> เคยผิดพลาด{' '}
                {formatThaiDateTime(r.last_error_at)} — {r.last_error}{' '}
                <span className="text-amber-600">(ตอนนี้ปกติแล้ว)</span>
              </span>
            </div>
          )}
        />
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
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => triggerSync([r.id])}
                  disabled={running}
                  className="flex items-center gap-1 px-2.5 py-1 bg-card hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-md text-[11px] font-semibold shadow-sm transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isCurrent && !fullRun ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3 h-3" />
                  )}
                  Sync
                </button>
                {/* Full sync — กวาดใหม่ทั้งหมด เสี่ยง/ใช้เวลานาน จึงเก็บไว้ในเมนู "..." ไม่ให้เด่นเท่า Sync ปกติ */}
                <div className="relative" ref={menuFor === r.id ? menuRef : undefined}>
                  <button
                    type="button"
                    onClick={() => setMenuFor((prev) => (prev === r.id ? null : r.id))}
                    disabled={running}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === r.id}
                    aria-label={`ตัวเลือกเพิ่มเติมของ ${r.label}`}
                    title="ตัวเลือกเพิ่มเติม"
                    className={`flex items-center justify-center w-7 h-[26px] rounded-md transition-all active:scale-95 disabled:cursor-not-allowed ${
                      menuFor === r.id
                        ? 'bg-slate-100 text-slate-700'
                        : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                    } ${running ? 'opacity-50' : ''}`}
                  >
                    {isCurrent && fullRun ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <MoreVertical className="w-3.5 h-3.5" />
                    )}
                  </button>
                  {menuFor === r.id && (
                    <div
                      role="menu"
                      className="absolute right-0 top-full mt-1 z-20 w-60 bg-card border border-slate-200 rounded-lg shadow-lg py-1 animate-fade-in"
                    >
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => askFullSync(r.id, r.label)}
                        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-amber-50 transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600" />
                        <span className="min-w-0">
                          <span className="block text-[11px] font-bold text-slate-800">
                            Full sync {r.label}
                          </span>
                          <span className="block text-[10px] text-slate-400 leading-snug">
                            ล้าง cursor แล้วดึงใหม่ทั้งหมด · ใช้เวลานาน
                          </span>
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Auto schedule section */}
      {form && (
        <div className="border-t border-slate-100 bg-slate-50/50 px-4 sm:px-5 py-2.5 space-y-2.5">
          {/* Enable toggle */}
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-xs font-bold text-slate-700">Sync อัตโนมัติตามเวลา</span>
            <div
              className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors ${
                form.auto_enabled ? '' : 'bg-slate-300'
              }`}
              style={form.auto_enabled ? { backgroundColor: 'var(--brand)' } : undefined}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 bg-card rounded-full shadow-sm transition-all ${
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
            <div className="space-y-2 animate-fade-in">
              {/* วัน — nowrap เพื่อให้ปุ่มลัด (ทุกวัน/จ.-ศ.) อยู่แถวเดียวกับชิปวันเสมอ ไม่ตกบรรทัด */}
              <div className="flex flex-nowrap items-center gap-2 text-xs">
                <span className="text-[11px] font-semibold text-slate-400 w-12 shrink-0">วัน</span>

                {/* segmented control — 7 วันเป็นก้อนเดียว, ชิปยืดแบ่งพื้นที่ (flex-1) เพื่อไม่ล้นขอบการ์ด */}
                <div className="flex flex-1 min-w-0 rounded-lg border border-slate-200 overflow-hidden divide-x divide-slate-200">
                  {DAY_CHIPS.map((d) => {
                    // days ว่าง = ทุกวัน จึงโชว์เป็นเลือกครบ
                    const active = form.days.length === 0 || form.days.includes(d.value);
                    return (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => toggleDay(d.value)}
                        aria-pressed={active}
                        className={`flex-1 min-w-0 py-1 text-[11px] font-bold transition-colors ${
                          active ? 'text-white' : 'bg-slate-50 text-slate-400 hover:bg-card'
                        }`}
                        style={active ? { backgroundColor: 'var(--brand)' } : undefined}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>

                {/* ปุ่มลัด — ป้ายซ้าย–ปุ่มขวา, shrink-0 กันโดนบีบ (ชิปวันยืดแทน) */}
                <div className="flex shrink-0 items-center gap-1">
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
                        style={active ? { backgroundColor: 'var(--brand-soft)', color: BRAND } : undefined}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ช่วงเวลา + interval รวมแถวเดียว — สองกลุ่มสั้น อยู่บรรทัดเดียวกันได้ ลดความสูง */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-slate-400 w-12 shrink-0">เวลา</span>
                  <input
                    type="time"
                    value={form.window_start}
                    onChange={(e) => setForm({ ...form, window_start: e.target.value })}
                    className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-[var(--brand-fg)]/20 focus:border-[var(--brand-fg)]"
                  />
                  <span className="text-slate-500">ถึง</span>
                  <input
                    type="time"
                    value={form.window_end}
                    onChange={(e) => setForm({ ...form, window_end: e.target.value })}
                    className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-[var(--brand-fg)]/20 focus:border-[var(--brand-fg)]"
                  />
                  <span className="text-slate-400">น.</span>
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-slate-400 shrink-0">ทุก ๆ</span>
                  <input
                    type="number"
                    min={1}
                    value={intervalInput}
                    onChange={(e) => applyInterval(e.target.value, intervalUnit)}
                    className="w-16 px-2.5 py-1.5 border border-slate-200 rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-[var(--brand-fg)]/20 focus:border-[var(--brand-fg)]"
                  />
                  <select
                    value={intervalUnit}
                    onChange={(e) => applyInterval(intervalInput, e.target.value as IntervalUnit)}
                    className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-[var(--brand-fg)]/20 focus:border-[var(--brand-fg)]"
                  >
                    <option value="sec">วินาที</option>
                    <option value="min">นาที</option>
                  </select>
                </div>
              </div>

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
                        checked ? 'border-transparent' : 'bg-card text-slate-500 border-slate-200 hover:bg-slate-50'
                      }`}
                      style={
                        checked
                          ? { backgroundColor: 'var(--brand-soft)', color: BRAND, borderColor: 'var(--brand-border)' }
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

          {/* Save — สรุปตารางเวลาอยู่ซ้ายปุ่ม แทนที่แถวสรุปเดี่ยว ๆ (ลดไป 1 แถว) */}
          <div className="flex items-center justify-between gap-3">
            {form.auto_enabled ? (
              <p className="flex items-center gap-1 text-[11px] font-semibold min-w-0" style={{ color: BRAND }}>
                <Clock className="w-3 h-3 shrink-0" />
                <span className="truncate">{describeSchedule(form)}</span>
              </p>
            ) : (
              <p className="text-[10px] text-slate-400 truncate">
                {form.updated_at ? `ตั้งค่าล่าสุด: ${formatThaiDateTime(form.updated_at)}` : 'ยังไม่เคยตั้งค่า'}
              </p>
            )}
            <button
              onClick={saveSettings}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-bold text-white rounded-lg transition-all active:scale-95 shadow-sm disabled:opacity-60 shrink-0"
              style={{ backgroundColor: 'var(--brand)' }}
            >
              {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              บันทึก
            </button>
          </div>
        </div>
      )}

      {/* ยืนยัน full sync — บังคับพิมพ์คำยืนยัน เพราะกวาดข้อมูลใหม่ทั้งชุดและหยุดกลางคันไม่ได้ */}
      {fullTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="bg-card rounded-2xl border border-slate-200 w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-slate-100 flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
              </div>
              <div className="min-w-0">
                <h3 className="font-bold text-slate-900 text-sm">Full sync {fullTarget.label}?</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  ดึงข้อมูลใหม่ทั้งหมดจาก ERP ไม่ใช่เฉพาะที่เปลี่ยนแปลง
                </p>
              </div>
            </div>

            <div className="px-5 py-4 space-y-3 text-xs text-slate-600">
              <div className="space-y-2">
                <p className="font-semibold text-slate-700">สิ่งที่จะเกิดขึ้น</p>
                <ul className="space-y-1.5 list-disc list-inside">
                  <li>
                    cursor ของ <span className="font-bold">{fullTarget.label}</span> จะถูกล้าง
                    แล้วกวาดข้อมูลใหม่ตั้งแต่ต้น
                  </li>
                  <li>ใช้เวลานานกว่ารอบปกติมาก และระหว่างนั้น sync อื่นทั้งหมดจะทำไม่ได้</li>
                  <li className="text-amber-700">
                    ข้อมูลในระบบจะถูกเขียนทับด้วยค่าล่าสุดจาก ERP — ย้อนกลับเองไม่ได้
                  </li>
                </ul>
              </div>

              <div className="space-y-1.5">
                <label className="block font-semibold text-slate-700" htmlFor="full-sync-confirm">
                  พิมพ์ <span className="font-bold text-slate-900">{CONFIRM_WORD}</span> เพื่อยืนยัน
                </label>
                <input
                  id="full-sync-confirm"
                  autoFocus
                  autoComplete="off"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmFullSync();
                  }}
                  placeholder={CONFIRM_WORD}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-card text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
              <button
                type="button"
                onClick={() => setFullTarget(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-lg transition-all"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={confirmFullSync}
                disabled={confirmText.trim() !== CONFIRM_WORD}
                className="px-5 py-2 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-all active:scale-95 shadow-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-amber-600"
              >
                <RotateCcw className="w-3 h-3" />
                เริ่ม full sync
              </button>
            </div>
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
