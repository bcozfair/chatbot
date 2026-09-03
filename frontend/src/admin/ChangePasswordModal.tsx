import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { KeyRound, Eye, EyeOff, AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';

const BRAND = 'var(--brand-fg)';
const MIN_PASSWORD_LENGTH = 8;

interface ChangePasswordModalProps {
  onClose: () => void;
}

/**
 * เปลี่ยนรหัสผ่านของตัวเอง — ใช้ได้ทุก role
 * สำเร็จแล้วบังคับออกจากระบบ เพราะ token ใบเดิมยังใช้ได้ต่อ การให้ล็อกอินใหม่ทำให้เห็นชัดว่ารหัสใหม่ใช้ได้จริง
 */
export const ChangePasswordModal: React.FC<ChangePasswordModalProps> = ({ onClose }) => {
  const { token, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!currentPassword || !newPassword) {
      setError('กรุณากรอกข้อมูลให้ครบ');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`รหัสผ่านใหม่ต้องมีอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน');
      return;
    }
    if (newPassword === currentPassword) {
      setError('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม');
      return;
    }

    setIsSubmitting(true);
    try {
      const resp = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      setIsDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เปลี่ยนรหัสผ่านไม่สำเร็จ');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    'w-full bg-card border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[var(--brand-fg)] focus:ring-2 focus:ring-[var(--brand-fg)]/10 transition-all disabled:opacity-50';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-card rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--brand-soft)', color: BRAND }}
          >
            <KeyRound className="w-4 h-4" />
          </div>
          <h3 className="text-sm font-bold text-slate-900 flex-1">เปลี่ยนรหัสผ่าน</h3>
          {!isDone && (
            <button
              onClick={onClose}
              aria-label="ปิด"
              className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {isDone ? (
          <div className="p-6 space-y-5 text-center">
            <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-500" />
            <div>
              <p className="text-sm font-bold text-slate-900">เปลี่ยนรหัสผ่านเรียบร้อย</p>
              <p className="text-xs text-slate-500 mt-1">
                กรุณาเข้าสู่ระบบใหม่ด้วยรหัสผ่านที่เพิ่งตั้ง
              </p>
            </div>
            <button
              onClick={() => logout()}
              className="w-full py-2.5 px-4 text-white text-sm font-semibold rounded-xl transition-all active:scale-[0.98]"
              style={{ backgroundColor: 'var(--brand)' }}
            >
              เข้าสู่ระบบใหม่
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            {error && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 p-3 rounded-xl text-red-700 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="current-password" className="block text-xs font-semibold text-slate-600">
                รหัสผ่านปัจจุบัน
              </label>
              <input
                id="current-password"
                name="current-password"
                autoComplete="current-password"
                type={showPasswords ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={isSubmitting}
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="new-password" className="block text-xs font-semibold text-slate-600">
                รหัสผ่านใหม่ <span className="font-normal text-slate-400">(อย่างน้อย {MIN_PASSWORD_LENGTH} ตัวอักษร)</span>
              </label>
              <input
                id="new-password"
                name="new-password"
                autoComplete="new-password"
                type={showPasswords ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={isSubmitting}
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="confirm-password" className="block text-xs font-semibold text-slate-600">
                ยืนยันรหัสผ่านใหม่
              </label>
              <input
                id="confirm-password"
                name="confirm-password"
                autoComplete="new-password"
                type={showPasswords ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={isSubmitting}
                className={inputClass}
              />
            </div>

            <button
              type="button"
              onClick={() => setShowPasswords((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors"
            >
              {showPasswords ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showPasswords ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
            </button>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="flex-1 py-2.5 px-4 border border-slate-200 text-slate-600 text-sm font-semibold rounded-xl hover:bg-slate-50 transition-all disabled:opacity-50"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex-1 py-2.5 px-4 text-white text-sm font-semibold rounded-xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ backgroundColor: 'var(--brand)' }}
              >
                {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                บันทึก
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body
  );
};
