import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext';
import { X, Loader2, AlertCircle, Globe, History, Terminal } from 'lucide-react';
import { errMsg, formatDateTime, formatMs, levelStyle, actionLabel } from './format';

/**
 * "ดูทุกอย่างของ request นี้" — ไทม์ไลน์รวมของ api_logs + audit_logs + system_logs
 *
 * นี่คือผลตอบแทนหลักของทั้งแผน log · ก่อนหน้านี้ถ้าผู้ใช้บอกว่า "ตอนบ่ายสองกดแล้วมันพัง"
 * ต้องไล่ 3 ที่ด้วยมือแล้วเทียบเวลาเอาเอง ซึ่งพลาดง่ายและเสียเวลาทั้งวัน
 * ตอนนี้ทุกตารางมี request_id เดียวกัน ⇒ กดปุ่มเดียวเห็นครบทั้งเส้น
 */

interface TimelineRow {
  kind: 'api' | 'audit' | 'system';
  id: string;
  at: string;
  title: string;
  detail: string | null;
  duration_ms: number | null;
}

const KIND_META: Record<TimelineRow['kind'], { label: string; icon: typeof Globe; cls: string }> = {
  api:    { label: 'การเรียก API', icon: Globe,    cls: 'bg-sky-50 border-sky-200 text-sky-700' },
  audit:  { label: 'การแก้ไข',     icon: History,  cls: 'bg-violet-50 border-violet-200 text-violet-700' },
  system: { label: 'บันทึกระบบ',   icon: Terminal, cls: 'bg-slate-50 border-slate-200 text-slate-600' },
};

export const RequestTimeline: React.FC<{ requestId: string; onClose: () => void }> = ({
  requestId, onClose,
}) => {
  const { token } = useAuth();
  const [rows, setRows] = useState<TimelineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void fetch(`/api/admin/logs/request/${requestId}`,
        { headers: { Authorization: `Bearer ${token}` } })
        .then(async r => {
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
          return r.json();
        })
        .then(j => { if (!cancelled) setRows(j.data); })
        .catch((e: unknown) => { if (!cancelled) setError(errMsg(e)); });
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [requestId, token]);

  // Esc ปิด — เป็นกติกาเดียวกันทั้ง 3 หน้าใหม่
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`ไทม์ไลน์ของ request ${requestId}`}
    >
      <div
        className="bg-card border border-slate-200 rounded-2xl shadow-xl w-full max-w-3xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">ทุกอย่างของ request นี้</h3>
            <div className="text-xs text-slate-400 font-mono truncate">{requestId}</div>
          </div>
          <button onClick={onClose} aria-label="ปิด"
                  className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5">
          {!rows && !error && (
            <div className="py-10 flex items-center justify-center gap-2 text-sm text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลด
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {rows && rows.length === 0 && (
            <div className="py-10 text-center text-sm text-slate-400">
              ไม่พบข้อมูลของ request นี้
              <div className="mt-1 text-xs">อาจถูกลบไปแล้วตามอายุการเก็บของแต่ละตาราง</div>
            </div>
          )}

          {rows && rows.length > 0 && (
            <ol className="relative border-l border-slate-200 ml-2 space-y-4">
              {rows.map(r => {
                const m = KIND_META[r.kind];
                const Icon = m.icon;
                // แถว system ใช้สีตามระดับความรุนแรง ส่วนแถวอื่นใช้สีประจำชนิด
                const lvl = r.kind === 'system' ? levelStyle(r.title.split(' ')[0]) : null;
                return (
                  <li key={`${r.kind}-${r.id}`} className="ml-5">
                    <span className="absolute -left-[9px] flex items-center justify-center w-[18px] h-[18px]
                                     rounded-full bg-card border border-slate-200">
                      <Icon className="w-2.5 h-2.5 text-slate-400" />
                    </span>
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${lvl?.cls ?? m.cls}`}>
                        {lvl?.label ?? m.label}
                      </span>
                      <span className="text-sm text-slate-800 break-all">
                        {r.kind === 'audit' ? actionLabel(r.title) : r.title}
                      </span>
                      {r.duration_ms !== null && (
                        <span className="text-xs text-slate-400 tabular-nums">{formatMs(r.duration_ms)}</span>
                      )}
                    </div>
                    {r.detail && (
                      <div className="mt-0.5 text-xs text-slate-500 break-all whitespace-pre-wrap">{r.detail}</div>
                    )}
                    <div className="mt-0.5 text-[11px] text-slate-400 tabular-nums">
                      {formatDateTime(r.at)}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
