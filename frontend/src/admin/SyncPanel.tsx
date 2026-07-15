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

interface ResourceStatus {
  id: ResourceId;
  label: string;
  last_success_at: string | null;
  records_synced: number;
  sync_mode: string | null;
}

interface SyncSettings {
  auto_enabled: boolean;
  mode: 'daily' | 'interval';
  daily_time: string;
  interval_minutes: number;
  resources: ResourceId[];
  updated_at: string | null;
}

interface SyncStatus {
  running: boolean;
  currentResource: ResourceId | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  trigger: 'manual' | 'schedule' | null;
  resources: ResourceStatus[];
  settings: SyncSettings;
}

const INTERVAL_OPTIONS = [1, 3, 5, 10, 15, 30, 60];

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

      {/* Per-resource rows */}
      <div className="divide-y divide-slate-100">
        {resources.map((r) => {
          const isCurrent = running && status?.currentResource === r.id;
          return (
            <div key={r.id} className="flex items-center justify-between gap-3 px-4 sm:px-5 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-slate-800 shrink-0">{r.label}</span>
                <span className="text-[11px] text-slate-400 flex items-center gap-1 min-w-0">
                  <Clock className="w-3 h-3 shrink-0" />
                  <span className="truncate">
                    {formatThaiDateTime(r.last_success_at)}
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
              {/* Mode selector + detail on one row */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {(['daily', 'interval'] as const).map((m) => {
                  const active = form.mode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setForm({ ...form, mode: m })}
                      className={`px-3 py-1.5 rounded-lg font-semibold border transition-all ${
                        active
                          ? 'text-white border-transparent shadow-sm'
                          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                      }`}
                      style={active ? { backgroundColor: BRAND } : undefined}
                    >
                      {m === 'daily' ? 'รายวัน' : 'ทุกช่วงเวลา'}
                    </button>
                  );
                })}

                <span className="text-slate-300">|</span>

                {form.mode === 'daily' ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-500">ทุกวันเวลา</span>
                    <input
                      type="time"
                      value={form.daily_time}
                      onChange={(e) => setForm({ ...form, daily_time: e.target.value })}
                      className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#009032]/20 focus:border-[#009032]"
                    />
                    <span className="text-slate-400">น.</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-500">ทุก ๆ</span>
                    <select
                      value={form.interval_minutes}
                      onChange={(e) => setForm({ ...form, interval_minutes: Number(e.target.value) })}
                      className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#009032]/20 focus:border-[#009032]"
                    >
                      {INTERVAL_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m} นาที
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

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
