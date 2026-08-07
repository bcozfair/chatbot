import React, { useState, useEffect } from 'react';
import { useAuth, type Role } from '../context/AuthContext';
import {
  Users as UsersIcon,
  Plus,
  Edit2,
  Trash2,
  KeyRound,
  Shield,
  ShieldCheck,
  FileText,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  X,
} from 'lucide-react';

const BRAND = '#009032';
const MIN_PASSWORD_LENGTH = 8;

interface AdminUserRow {
  id: number;
  username: string;
  name: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

/** ลำดับที่ใช้แสดงทุกที่ในหน้านี้ — ไล่จากสิทธิ์มากไปน้อย */
const ROLE_ORDER: Role[] = ['admin', 'subadmin', 'user'];

const ROLE_LABEL: Record<Role, string> = {
  admin: 'ผู้ดูแลระบบ',
  subadmin: 'ผู้ดูแลใบเสนอราคา',
  user: 'ผู้ใช้ทั่วไป',
};

const ROLE_DESCRIPTION: Record<Role, string> = {
  admin: 'จัดการได้ทุกเมนู รวมถึงผู้ใช้',
  subadmin: 'เข้าได้เฉพาะหน้าประวัติใบเสนอราคา',
  user: 'เข้าได้เฉพาะหน้าบัญชีห้ามเสนอราคา',
};

/** สีและไอคอนของป้ายสิทธิ์ในตาราง — แยกเป็น map เพื่อไม่ต้องไล่แก้ ternary ทุกครั้งที่เพิ่ม role */
const ROLE_BADGE: Record<Role, { className: string; Icon: typeof Shield }> = {
  admin: { className: 'bg-emerald-50 border-emerald-200 text-emerald-700', Icon: ShieldCheck },
  subadmin: { className: 'bg-sky-50 border-sky-200 text-sky-700', Icon: FileText },
  user: { className: 'bg-slate-50 border-slate-200 text-slate-500', Icon: Shield },
};

type FormMode = { kind: 'create' } | { kind: 'edit'; target: AdminUserRow };

const inputClass =
  'w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 transition-all disabled:opacity-50';

/** แยกการยิง API ออกจาก state เพื่อให้ทุก setState เกิดหลัง await (กฎ react-hooks/set-state-in-effect) */
async function fetchUsers(token: string): Promise<AdminUserRow[]> {
  const resp = await fetch('/api/admin/users', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
  return body;
}

export const Users: React.FC = () => {
  const { token, user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<AdminUserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUserRow | null>(null);
  // บวกค่านี้ = สั่งให้ effect โหลดรายชื่อใหม่ ใช้หลังเพิ่ม/แก้/ลบสำเร็จ
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchUsers(token);
        if (cancelled) return;
        setUsers(rows);
        setLoadError('');
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, reloadKey]);

  // ข้อความแจ้งสำเร็จหายเองใน 3 วิ ไม่ต้องให้ผู้ใช้กดปิด
  useEffect(() => {
    if (!successMsg) return;
    const timer = setTimeout(() => setSuccessMsg(''), 3000);
    return () => clearTimeout(timer);
  }, [successMsg]);

  const handleSaved = (message: string) => {
    setFormMode(null);
    setPasswordTarget(null);
    setDeleteTarget(null);
    setSuccessMsg(message);
    setReloadKey((v) => v + 1);
  };

  return (
    <div className="space-y-4">
      {successMsg && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl border animate-fade-in bg-emerald-50 border-emerald-200 text-emerald-800">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
          <span className="text-sm font-semibold">{successMsg}</span>
        </div>
      )}

      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-2xl px-5 py-3.5 shadow-sm flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 flex-shrink-0">
          <UsersIcon className="w-5 h-5 text-[#009032]" />
          <h2 className="text-base font-bold text-slate-900 whitespace-nowrap">ผู้ใช้งานระบบหลังบ้าน</h2>
          <span className="text-xs text-slate-400 hidden lg:inline">
            เพิ่ม ลบ แก้ไข และกำหนดสิทธิ์ผู้เข้าใช้ Admin Portal
          </span>
        </div>

        <div className="flex-1" />

        <button
          onClick={() => setFormMode({ kind: 'create' })}
          className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#009032] hover:bg-[#007b2b] text-white text-sm font-bold rounded-xl shadow-sm transition-all active:scale-95 flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>เพิ่มผู้ใช้</span>
        </button>
      </div>

      {isLoading ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-7 h-7 text-[#009032] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดรายชื่อผู้ใช้...</p>
        </div>
      ) : loadError ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-9 h-9 text-red-600" />
          <p className="font-bold">โหลดรายชื่อผู้ใช้ไม่ได้</p>
          <p className="text-xs">{loadError}</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider select-none">
                  <th className="px-4 py-3">ชื่อผู้ใช้งาน</th>
                  <th className="px-4 py-3">ชื่อ-นามสกุล</th>
                  <th className="px-4 py-3 w-48">สิทธิ์</th>
                  <th className="px-4 py-3 text-center w-32">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                {users.map((row) => {
                  const isSelf = row.id === currentUser?.id;
                  const badge = ROLE_BADGE[row.role];
                  return (
                    <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="font-semibold text-slate-900 font-mono text-[13px]">{row.username}</div>
                        {isSelf && <div className="text-[11px] text-slate-400">บัญชีของคุณ</div>}
                      </td>
                      <td className="px-4 py-2.5">{row.name}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${badge.className}`}
                        >
                          <badge.Icon className="w-3 h-3" />
                          {ROLE_LABEL[row.role]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => setFormMode({ kind: 'edit', target: row })}
                            className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-900 rounded-lg transition-colors"
                            title="แก้ไขชื่อและสิทธิ์"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setPasswordTarget(row)}
                            className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-900 rounded-lg transition-colors"
                            title="ตั้งรหัสผ่านใหม่"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(row)}
                            disabled={isSelf}
                            className="p-1.5 hover:bg-red-50 text-slate-500 hover:text-red-600 rounded-lg transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 disabled:cursor-not-allowed"
                            title={isSelf ? 'ลบบัญชีของตัวเองไม่ได้' : 'ลบผู้ใช้'}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {formMode && (
        <UserFormModal
          mode={formMode}
          isSelf={formMode.kind === 'edit' && formMode.target.id === currentUser?.id}
          token={token}
          onClose={() => setFormMode(null)}
          onSaved={handleSaved}
        />
      )}

      {passwordTarget && (
        <ResetPasswordModal
          target={passwordTarget}
          token={token}
          onClose={() => setPasswordTarget(null)}
          onSaved={handleSaved}
        />
      )}

      {deleteTarget && (
        <DeleteUserModal
          target={deleteTarget}
          token={token}
          onClose={() => setDeleteTarget(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
};

/* ─────────────────────────── Modal ย่อย ─────────────────────────── */

const ModalShell: React.FC<{
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, icon, onClose, children }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
    <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'rgba(0, 144, 50, 0.10)', color: BRAND }}
        >
          {icon}
        </div>
        <h3 className="text-sm font-bold text-slate-900 flex-1">{title}</h3>
        <button
          onClick={onClose}
          aria-label="ปิด"
          className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {children}
    </div>
  </div>
);

const ErrorBox: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-start gap-2 bg-red-50 border border-red-200 p-3 rounded-xl text-red-700 text-xs">
    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
    <span>{message}</span>
  </div>
);

const SubmitRow: React.FC<{
  onClose: () => void;
  isSubmitting: boolean;
  label: string;
  danger?: boolean;
}> = ({ onClose, isSubmitting, label, danger }) => (
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
      style={{ backgroundColor: danger ? '#dc2626' : BRAND }}
    >
      {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
      {label}
    </button>
  </div>
);

const RoleSelect: React.FC<{
  value: Role;
  onChange: (role: Role) => void;
  disabled: boolean;
  disabledHint?: string;
}> = ({ value, onChange, disabled, disabledHint }) => (
  <div className="space-y-1">
    <label className="block text-xs font-semibold text-slate-600">สิทธิ์การใช้งาน</label>
    <div className="grid grid-cols-1 gap-2">
      {ROLE_ORDER.map((role) => (
        <label
          key={role}
          className={`flex items-start gap-2 p-2.5 rounded-xl border transition-colors ${
            value === role ? 'border-[#009032] bg-[#009032]/5' : 'border-slate-200'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-slate-50'}`}
        >
          <input
            type="radio"
            name="role"
            checked={value === role}
            disabled={disabled}
            onChange={() => onChange(role)}
            className="mt-0.5 accent-[#009032] shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-slate-800">{ROLE_LABEL[role]}</span>
            <span className="block text-[11px] leading-snug text-slate-500">{ROLE_DESCRIPTION[role]}</span>
          </span>
        </label>
      ))}
    </div>
    {disabled && disabledHint && <p className="text-[11px] text-amber-600">{disabledHint}</p>}
  </div>
);

const UserFormModal: React.FC<{
  mode: FormMode;
  isSelf: boolean;
  token: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}> = ({ mode, isSelf, token, onClose, onSaved }) => {
  const isEdit = mode.kind === 'edit';
  const [username, setUsername] = useState(isEdit ? mode.target.username : '');
  const [name, setName] = useState(isEdit ? mode.target.name : '');
  const [role, setRole] = useState<Role>(isEdit ? mode.target.role : 'user');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('กรุณากรอกชื่อ-นามสกุล');
      return;
    }
    if (!isEdit) {
      if (!username.trim()) {
        setError('กรุณากรอกชื่อผู้ใช้งาน');
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(`รหัสผ่านต้องมีอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const url = isEdit ? `/api/admin/users/${mode.target.id}` : '/api/admin/users';
      const resp = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(
          isEdit
            ? { name: name.trim(), role }
            : { username: username.trim(), password, name: name.trim(), role }
        ),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      onSaved(isEdit ? 'บันทึกข้อมูลผู้ใช้แล้ว' : 'เพิ่มผู้ใช้ใหม่แล้ว');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
      setIsSubmitting(false);
    }
  };

  return (
    <ModalShell
      title={isEdit ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้ใหม่'}
      icon={<UsersIcon className="w-4 h-4" />}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="p-5 space-y-3">
        {error && <ErrorBox message={error} />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="user-username" className="block text-xs font-semibold text-slate-600">
              ชื่อผู้ใช้งาน (Username)
            </label>
            <input
              id="user-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              // แก้ username ทีหลังไม่รองรับ เพราะเป็นตัวระบุที่ผูกกับการเข้าสู่ระบบ
              disabled={isEdit || isSubmitting}
              placeholder="เช่น somchai"
              className={`${inputClass} font-mono`}
            />
            {isEdit && <p className="text-[11px] text-slate-400">แก้ไขภายหลังไม่ได้</p>}
          </div>

          <div className="space-y-1">
            <label htmlFor="user-name" className="block text-xs font-semibold text-slate-600">
              ชื่อ-นามสกุล
            </label>
            <input
              id="user-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              placeholder="เช่น สมชาย ใจดี"
              className={inputClass}
            />
          </div>
        </div>

        {!isEdit && (
          <div className="space-y-1">
            <label htmlFor="user-password" className="block text-xs font-semibold text-slate-600">
              รหัสผ่านเริ่มต้น{' '}
              <span className="font-normal text-slate-400">
                — อย่างน้อย {MIN_PASSWORD_LENGTH} ตัวอักษร แจ้งให้เจ้าตัวเปลี่ยนเองหลังเข้าสู่ระบบ
              </span>
            </label>
            <input
              id="user-password"
              type="text"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
              className={inputClass}
            />
          </div>
        )}

        <RoleSelect
          value={role}
          onChange={setRole}
          disabled={isSubmitting || isSelf}
          disabledHint={isSelf ? 'แก้ไขสิทธิ์ของบัญชีตัวเองไม่ได้ เพื่อไม่ให้ล็อกตัวเองออกจากระบบ' : undefined}
        />

        <SubmitRow onClose={onClose} isSubmitting={isSubmitting} label="บันทึก" />
      </form>
    </ModalShell>
  );
};

const ResetPasswordModal: React.FC<{
  target: AdminUserRow;
  token: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}> = ({ target, token, onClose, onSaved }) => {
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`รหัสผ่านต้องมีอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`);
      return;
    }

    setIsSubmitting(true);
    try {
      const resp = await fetch(`/api/admin/users/${target.id}/password`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newPassword }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      onSaved(`ตั้งรหัสผ่านใหม่ให้ ${target.username} แล้ว`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ตั้งรหัสผ่านไม่สำเร็จ');
      setIsSubmitting(false);
    }
  };

  return (
    <ModalShell title="ตั้งรหัสผ่านใหม่" icon={<KeyRound className="w-4 h-4" />} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        {error && <ErrorBox message={error} />}

        <p className="text-xs text-slate-500">
          ตั้งรหัสผ่านใหม่ให้{' '}
          <span className="font-semibold text-slate-800 font-mono">{target.username}</span> ({target.name})
          โดยไม่ต้องรู้รหัสผ่านเดิม
        </p>

        <div className="space-y-1.5">
          <label htmlFor="reset-password" className="block text-xs font-semibold text-slate-600">
            รหัสผ่านใหม่{' '}
            <span className="font-normal text-slate-400">(อย่างน้อย {MIN_PASSWORD_LENGTH} ตัวอักษร)</span>
          </label>
          <input
            id="reset-password"
            type="text"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={isSubmitting}
            className={inputClass}
          />
        </div>

        <SubmitRow onClose={onClose} isSubmitting={isSubmitting} label="ตั้งรหัสผ่าน" />
      </form>
    </ModalShell>
  );
};

const DeleteUserModal: React.FC<{
  target: AdminUserRow;
  token: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}> = ({ target, token, onClose, onSaved }) => {
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const resp = await fetch(`/api/admin/users/${target.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      onSaved(`ลบผู้ใช้ ${target.username} แล้ว`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ลบไม่สำเร็จ');
      setIsSubmitting(false);
    }
  };

  return (
    <ModalShell title="ลบผู้ใช้" icon={<Trash2 className="w-4 h-4" />} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        {error && <ErrorBox message={error} />}

        <p className="text-sm text-slate-600">
          ต้องการลบผู้ใช้{' '}
          <span className="font-semibold text-slate-900 font-mono">{target.username}</span> ({target.name})
          ใช่หรือไม่ ผู้ใช้จะออกจากระบบทันทีและเข้าใช้งานไม่ได้อีก
        </p>

        <SubmitRow onClose={onClose} isSubmitting={isSubmitting} label="ลบผู้ใช้" danger />
      </form>
    </ModalShell>
  );
};
