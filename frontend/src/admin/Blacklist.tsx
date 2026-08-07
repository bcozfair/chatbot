import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  Ban,
  Plus,
  Edit2,
  Trash2,
  Search,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Building2,
  Layers,
  User,
  X,
} from 'lucide-react';

const BRAND = '#009032';
const MIN_SEARCH_CHARS = 2;

interface BlacklistRow {
  id: number;
  company_id: number;
  contact_id: number | null;
  company_name: string | null;
  company_reference: string | null;
  contact_name: string | null;
  reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

interface RelatedCompany {
  company_id: number;
  display_name: string | null;
  reference: string | null;
  tax_id: string | null;
}

interface RelatedContact {
  company_id: number;
  contact_id: number;
  contact_name: string | null;
  company_name: string | null;
  reference: string | null;
}

interface CompanyOption {
  id: number;
  display_name: string;
  reference: string | null;
}

interface ContactOption {
  id: number;
  name: string;
}

const inputClass =
  'w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 transition-all disabled:opacity-50';

/** แยกการยิง API ออกจาก state เพื่อให้ทุก setState เกิดหลัง await (กฎ react-hooks/set-state-in-effect) */
async function fetchJson<T>(url: string, token: string | null): Promise<T> {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
  return body as T;
}

/** ลูกค้าที่ถูกลบจาก Odoo จะไม่มีชื่อใน customers_data_view อีก — โชว์รหัสแทนไม่ให้แถวดูว่าง */
const companyLabel = (row: BlacklistRow) => row.company_name || `บริษัทรหัส ${row.company_id}`;

export const Blacklist: React.FC = () => {
  const { token } = useAuth();
  const [rows, setRows] = useState<BlacklistRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [editTarget, setEditTarget] = useState<BlacklistRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BlacklistRow | null>(null);
  // บวกค่านี้ = สั่งให้ effect โหลดรายการใหม่ ใช้หลังเพิ่ม/ปลดสำเร็จ
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchJson<BlacklistRow[]>('/api/admin/blacklist', token);
        if (cancelled) return;
        setRows(data);
        setLoadError('');
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'โหลดบัญชีระงับไม่สำเร็จ');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, reloadKey]);

  useEffect(() => {
    if (!successMsg) return;
    const timer = setTimeout(() => setSuccessMsg(''), 3000);
    return () => clearTimeout(timer);
  }, [successMsg]);

  const handleSaved = (message: string) => {
    setIsAdding(false);
    setEditTarget(null);
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
          <Ban className="w-5 h-5 text-[#009032]" />
          <h2 className="text-base font-bold text-slate-900 whitespace-nowrap">บัญชีห้ามเสนอราคา</h2>
          <span className="text-xs text-slate-400 hidden lg:inline">
            บริษัทหรือผู้ติดต่อในบัญชีนี้ เซลล์จะกดยืนยันออกใบเสนอราคาไม่ได้
          </span>
        </div>

        <div className="flex-1" />

        <button
          onClick={() => setIsAdding(true)}
          className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#009032] hover:bg-[#007b2b] text-white text-sm font-bold rounded-xl shadow-sm transition-all active:scale-95 flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>เพิ่มรายการ</span>
        </button>
      </div>

      {isLoading ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-7 h-7 text-[#009032] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดบัญชีระงับ...</p>
        </div>
      ) : loadError ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-9 h-9 text-red-600" />
          <p className="font-bold">โหลดบัญชีระงับไม่ได้</p>
          <p className="text-xs">{loadError}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0, 144, 50, 0.10)', color: BRAND }}
          >
            <Ban className="w-6 h-6" />
          </div>
          <p className="font-bold text-slate-900">ยังไม่มีรายการในบัญชีระงับ</p>
          <p className="text-sm text-slate-500 max-w-md">
            กด "เพิ่มรายการ" เพื่อระงับการเสนอราคาให้บริษัท หรือเจาะจงเฉพาะผู้ติดต่อบางคน
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider select-none">
                  <th className="px-4 py-3 w-32">รหัสบริษัท</th>
                  <th className="px-4 py-3">บริษัท</th>
                  <th className="px-4 py-3 w-56">ขอบเขต</th>
                  <th className="px-4 py-3">เหตุผล</th>
                  <th className="px-4 py-3 w-40">ผู้เพิ่ม</th>
                  <th className="px-4 py-3 text-center w-24">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-4 py-2.5">
                      {row.company_reference ? (
                        <span className="font-mono text-[13px] font-semibold text-slate-700">
                          {row.company_reference}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-slate-900">{companyLabel(row)}</div>
                      {!row.company_name && (
                        <div className="text-[11px] text-amber-600">ไม่พบชื่อในฐานข้อมูลลูกค้าแล้ว</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {row.contact_id === null ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border bg-red-50 border-red-200 text-red-700">
                          <Building2 className="w-3 h-3" />
                          ทั้งบริษัท
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border bg-amber-50 border-amber-200 text-amber-700">
                          <User className="w-3 h-3" />
                          {row.contact_name || `ผู้ติดต่อรหัส ${row.contact_id}`}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">
                      {row.reason || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 text-[13px]">
                      {row.created_by_name || <span className="text-slate-300">—</span>}
                      <div className="text-[11px] text-slate-400">
                        {new Date(row.created_at).toLocaleDateString('th-TH')}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => setEditTarget(row)}
                          className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-900 rounded-lg transition-colors"
                          title="แก้ไขขอบเขตและเหตุผล"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(row)}
                          className="p-1.5 hover:bg-red-50 text-slate-500 hover:text-red-600 rounded-lg transition-colors"
                          title="ปลดออกจากบัญชีระงับ"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isAdding && (
        <AddBlacklistModal token={token} onClose={() => setIsAdding(false)} onSaved={handleSaved} />
      )}

      {editTarget && (
        <EditBlacklistModal
          target={editTarget}
          token={token}
          onClose={() => setEditTarget(null)}
          onSaved={handleSaved}
        />
      )}

      {deleteTarget && (
        <RemoveBlacklistModal
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
  disabled?: boolean;
  label: string;
  danger?: boolean;
}> = ({ onClose, isSubmitting, disabled, label, danger }) => (
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
      disabled={isSubmitting || disabled}
      className="flex-1 py-2.5 px-4 text-white text-sm font-semibold rounded-xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50"
      style={{ backgroundColor: danger ? '#dc2626' : BRAND }}
    >
      {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
      {label}
    </button>
  </div>
);

/**
 * กล่องเตือน "กดครั้งนี้แล้วโดนใครบ้าง"
 *
 * จำเป็นเพราะการบล็อกไม่ได้ผูกกับ company_id/contact_id ตัวเดียว — Odoo แตกนิติบุคคลเดียวกัน
 * เป็นหลายรหัส ระบบจึงขยายด้วยชื่อ/รหัสอ้างอิง/เลขภาษี (และชื่อผู้ติดต่อในชั้นผู้ติดต่อ)
 * ซึ่งครอบกว้างกว่าที่คนคาด เช่นลูกค้าที่บันทึกชื่อบริษัทเป็นชื่อบุคคล
 *
 * ⚠️ ฝั่งเรียกต้องใส่ key={contactId} เสมอ เพื่อให้ React ล้าง state ตอนสลับขอบเขต
 *    ไม่งั้นจะเห็นรายการของขอบเขตก่อนหน้าค้างอยู่ชั่วครู่ระหว่างรอผลใหม่
 */
const CoveragePreview: React.FC<{
  companyId: number;
  /** '' = ทั้งบริษัท */
  contactId: string;
  token: string | null;
  verb: string;
}> = ({ companyId, contactId, token, verb }) => {
  const [companies, setCompanies] = useState<RelatedCompany[]>([]);
  const [contacts, setContacts] = useState<RelatedContact[]>([]);

  // setState ทุกตัวอยู่หลัง await (กฎ react-hooks/set-state-in-effect) จึงไม่มีสถานะ "กำลังโหลด"
  // — กล่องนี้โผล่เมื่อมีข้อมูลแล้วเท่านั้น ซึ่งพอสำหรับ query ระดับ 50–90 ms
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (contactId) {
          const data = await fetchJson<RelatedContact[]>(
            `/api/admin/blacklist/customers/${companyId}/related-contacts?contactId=${encodeURIComponent(contactId)}`,
            token
          );
          if (!cancelled) setContacts(data);
        } else {
          const data = await fetchJson<RelatedCompany[]>(
            `/api/admin/blacklist/customers/${companyId}/related`,
            token
          );
          if (!cancelled) setCompanies(data);
        }
      } catch {
        if (!cancelled) {
          setCompanies([]);
          setContacts([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, contactId, token]);

  // ครอบแค่ตัวเองไม่ต้องเตือน — กล่องมีไว้บอกว่า "โดนมากกว่าที่เลือก"
  const count = contactId ? contacts.length : companies.length;
  if (count <= 1) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
      <div className="flex items-start gap-2 text-amber-800">
        <Layers className="w-4 h-4 shrink-0 mt-px" />
        <span className="text-xs font-semibold">
          {contactId
            ? `${verb} ${count} คู่บริษัท–ผู้ติดต่อ ที่ระบบถือว่าเป็นคนเดียวกัน`
            : `${verb} ${count} รหัสบริษัทที่ระบบถือว่าเป็นรายเดียวกัน`}
          <span className="block font-normal text-[11px] text-amber-700 mt-0.5">
            {contactId
              ? 'คนเดียวกันที่อยู่คนละรหัสบริษัทมีรหัสผู้ติดต่อคนละเลข ระบบจึงจับจากชื่อที่ตรงกันภายในนิติบุคคลเดียวกัน'
              : '(ชื่อ รหัสอ้างอิง หรือเลขผู้เสียภาษี ตรงกัน) ตรวจให้แน่ใจว่าไม่มีรายที่ไม่เกี่ยวข้องปนมา'}
          </span>
        </span>
      </div>
      <div className="max-h-32 overflow-y-auto rounded-lg border border-amber-200 bg-white divide-y divide-amber-100">
        {contactId
          ? contacts.map((r) => (
              <div key={`${r.company_id}-${r.contact_id}`} className="px-2.5 py-1.5">
                <div className="text-[12px] text-slate-800 truncate">
                  {r.contact_name || `ผู้ติดต่อรหัส ${r.contact_id}`}
                </div>
                <div className="text-[10px] text-slate-400 truncate">
                  {r.company_name || `บริษัทรหัส ${r.company_id}`}
                  {r.reference ? ` · ${r.reference}` : ''}
                </div>
              </div>
            ))
          : companies.map((r) => (
              <div key={r.company_id} className="px-2.5 py-1.5">
                <div className="text-[12px] text-slate-800 truncate">
                  {r.display_name || `บริษัทรหัส ${r.company_id}`}
                </div>
                <div className="text-[10px] text-slate-400 font-mono">
                  {r.reference || '—'}
                  {r.tax_id ? ` · ${r.tax_id}` : ''}
                </div>
              </div>
            ))}
      </div>
    </div>
  );
};

const AddBlacklistModal: React.FC<{
  token: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}> = ({ token, onClose, onSaved }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CompanyOption[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [company, setCompany] = useState<CompanyOption | null>(null);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  // '' = ทั้งบริษัท (ส่ง contactId เป็น null)
  const [contactId, setContactId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ค้นหาแบบหน่วง 300ms — ไม่ยิงทุกตัวอักษร
  // setState ทั้งหมดอยู่ใน callback ของ timer ไม่ใช่ตัว effect (กฎ react-hooks/set-state-in-effect)
  useEffect(() => {
    if (company) return;
    const q = query.trim();
    if (q.length < MIN_SEARCH_CHARS) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        setIsSearching(true);
        try {
          const data = await fetchJson<CompanyOption[]>(
            `/api/admin/blacklist/customers?q=${encodeURIComponent(q)}`,
            token
          );
          if (!cancelled) setResults(data);
        } catch {
          if (!cancelled) setResults([]);
        } finally {
          if (!cancelled) setIsSearching(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, company, token]);

  // คำค้นสั้นเกิน/เลือกบริษัทแล้ว = ไม่โชว์ dropdown — คิดตอน render แทนการล้าง state ใน effect
  const visibleResults = !company && query.trim().length >= MIN_SEARCH_CHARS ? results : [];

  // เลือกบริษัทแล้วค่อยดึงรายชื่อผู้ติดต่อมาให้เลือกขอบเขต (ความครอบอยู่ที่ CoveragePreview)
  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    (async () => {
      try {
        const ct = await fetchJson<ContactOption[]>(
          `/api/admin/blacklist/customers/${company.id}/contacts`,
          token
        );
        if (!cancelled) setContacts(ct);
      } catch {
        if (!cancelled) setContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [company, token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!company) {
      setError('กรุณาเลือกบริษัทที่ต้องการระงับ');
      return;
    }

    setIsSubmitting(true);
    try {
      const resp = await fetch('/api/admin/blacklist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          companyId: company.id,
          contactId: contactId ? Number(contactId) : null,
          reason: reason.trim() || null,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      onSaved('เพิ่มเข้าบัญชีระงับแล้ว');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
      setIsSubmitting(false);
    }
  };

  return (
    <ModalShell title="เพิ่มเข้าบัญชีระงับ" icon={<Ban className="w-4 h-4" />} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5 space-y-3">
        {error && <ErrorBox message={error} />}

        {/* ขั้นที่ 1 — เลือกบริษัท */}
        <div className="space-y-1">
          <label htmlFor="bl-company" className="block text-xs font-semibold text-slate-600">
            บริษัท
          </label>

          {company ? (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[#009032] bg-[#009032]/5">
              <Building2 className="w-4 h-4 text-[#009032] shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-slate-800 truncate">
                  {company.display_name}
                </span>
                {company.reference && (
                  <span className="block font-mono text-[11px] text-slate-500">{company.reference}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => {
                  setCompany(null);
                  setContacts([]);
                  setContactId('');
                  setQuery('');
                }}
                disabled={isSubmitting}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800 shrink-0"
              >
                เปลี่ยน
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  id="bl-company"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`พิมพ์ชื่อบริษัท หรือรหัสอ้างอิง อย่างน้อย ${MIN_SEARCH_CHARS} ตัวอักษร`}
                  className={`${inputClass} pl-10`}
                  autoComplete="off"
                />
                {isSearching && (
                  <Loader2 className="w-4 h-4 text-slate-400 animate-spin absolute right-3.5 top-1/2 -translate-y-1/2" />
                )}
              </div>

              {visibleResults.length > 0 && (
                <div className="max-h-44 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
                  {visibleResults.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => setCompany(row)}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors"
                    >
                      <div className="text-sm text-slate-800 truncate">{row.display_name}</div>
                      {row.reference && (
                        <div className="text-[11px] text-slate-400 font-mono">{row.reference}</div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ขั้นที่ 2 — ขอบเขต */}
        {company && (
          <div className="space-y-1">
            <label htmlFor="bl-contact" className="block text-xs font-semibold text-slate-600">
              ขอบเขตการระงับ
            </label>
            <select
              id="bl-contact"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              disabled={isSubmitting}
              className={inputClass}
            >
              <option value="">ทั้งบริษัท — ผู้ติดต่อทุกคนถูกระงับ</option>
              {contacts.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  เฉพาะ {c.name}
                </option>
              ))}
            </select>
            {contactId && (
              <p className="text-[11px] text-slate-400">
                ผู้ติดต่อคนอื่นของบริษัทนี้ยังเสนอราคาได้ตามปกติ
              </p>
            )}
          </div>
        )}

        {/* พรีวิวขอบเขตจริง — เกณฑ์ชื่อ/รหัส/เลขภาษี ครอบกว้างกว่าที่คนคาด ต้องเห็นก่อนกด */}
        {company && (
          <CoveragePreview
            key={contactId}
            companyId={company.id}
            contactId={contactId}
            token={token}
            verb="จะระงับ"
          />
        )}

        {/* ขั้นที่ 3 — เหตุผล */}
        <div className="space-y-1">
          <label htmlFor="bl-reason" className="block text-xs font-semibold text-slate-600">
            เหตุผล{' '}
            <span className="font-normal text-slate-400">— บันทึกไว้ให้แอดมินอ่านกันเอง เซลล์ไม่เห็น</span>
          </label>
          <input
            id="bl-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isSubmitting}
            placeholder="เช่น ค้างชำระเกินกำหนด"
            className={inputClass}
          />
        </div>

        <SubmitRow
          onClose={onClose}
          isSubmitting={isSubmitting}
          disabled={!company}
          label="เพิ่มเข้าบัญชี"
          danger
        />
      </form>
    </ModalShell>
  );
};

const EditBlacklistModal: React.FC<{
  target: BlacklistRow;
  token: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}> = ({ target, token, onClose, onSaved }) => {
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contactId, setContactId] = useState(target.contact_id === null ? '' : String(target.contact_id));
  const [reason, setReason] = useState(target.reason || '');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ct = await fetchJson<ContactOption[]>(
          `/api/admin/blacklist/customers/${target.company_id}/contacts`,
          token
        );
        if (!cancelled) setContacts(ct);
      } catch {
        if (!cancelled) setContacts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.company_id, token]);

  // ผู้ติดต่อที่ถูกระงับอยู่อาจหายจากฐานข้อมูลลูกค้าไปแล้ว — ต้องคง option เดิมไว้
  // ไม่งั้น select จะเด้งไปเป็น "ทั้งบริษัท" เอง แล้วกดบันทึกทีเดียวขอบเขตเปลี่ยนโดยไม่ตั้งใจ
  const missingCurrent =
    target.contact_id !== null && !contacts.some((c) => c.id === target.contact_id);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const resp = await fetch(`/api/admin/blacklist/${target.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          contactId: contactId ? Number(contactId) : null,
          reason: reason.trim() || null,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      onSaved('บันทึกการแก้ไขแล้ว');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
      setIsSubmitting(false);
    }
  };

  return (
    <ModalShell title="แก้ไขรายการระงับ" icon={<Edit2 className="w-4 h-4" />} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5 space-y-3">
        {error && <ErrorBox message={error} />}

        {/* บริษัทแก้ไม่ได้ — เปลี่ยนบริษัทคือคนละรายการ ให้ปลดแล้วเพิ่มใหม่ */}
        <div className="space-y-1">
          <label className="block text-xs font-semibold text-slate-600">บริษัท</label>
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50">
            <Building2 className="w-4 h-4 text-slate-400 shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-slate-700 truncate">
                {companyLabel(target)}
              </span>
              {target.company_reference && (
                <span className="block font-mono text-[11px] text-slate-500">{target.company_reference}</span>
              )}
            </span>
          </div>
          <p className="text-[11px] text-slate-400">
            เปลี่ยนบริษัทไม่ได้ — ถ้าขึ้นบัญชีผิดบริษัท ให้ปลดรายการนี้แล้วเพิ่มใหม่
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="bl-edit-contact" className="block text-xs font-semibold text-slate-600">
            ขอบเขตการระงับ
          </label>
          <select
            id="bl-edit-contact"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            disabled={isSubmitting}
            className={inputClass}
          >
            <option value="">ทั้งบริษัท — ผู้ติดต่อทุกคนถูกระงับ</option>
            {missingCurrent && (
              <option value={String(target.contact_id)}>
                เฉพาะ {target.contact_name || `ผู้ติดต่อรหัส ${target.contact_id}`} (ไม่พบในฐานข้อมูลแล้ว)
              </option>
            )}
            {contacts.map((c) => (
              <option key={c.id} value={String(c.id)}>
                เฉพาะ {c.name}
              </option>
            ))}
          </select>
          {contactId && (
            <p className="text-[11px] text-slate-400">
              ผู้ติดต่อคนอื่นของบริษัทนี้ยังเสนอราคาได้ตามปกติ
            </p>
          )}
        </div>

        <CoveragePreview
          key={contactId}
          companyId={target.company_id}
          contactId={contactId}
          token={token}
          verb="ขอบเขตนี้ครอบ"
        />

        <div className="space-y-1">
          <label htmlFor="bl-edit-reason" className="block text-xs font-semibold text-slate-600">
            เหตุผล{' '}
            <span className="font-normal text-slate-400">— บันทึกไว้ให้แอดมินอ่านกันเอง เซลล์ไม่เห็น</span>
          </label>
          <input
            id="bl-edit-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={isSubmitting}
            placeholder="เช่น ค้างชำระเกินกำหนด"
            className={inputClass}
          />
        </div>

        <SubmitRow onClose={onClose} isSubmitting={isSubmitting} label="บันทึก" />
      </form>
    </ModalShell>
  );
};

const RemoveBlacklistModal: React.FC<{
  target: BlacklistRow;
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
      const resp = await fetch(`/api/admin/blacklist/${target.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      onSaved('ปลดออกจากบัญชีระงับแล้ว');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ปลดไม่สำเร็จ');
      setIsSubmitting(false);
    }
  };

  return (
    <ModalShell title="ปลดออกจากบัญชีระงับ" icon={<Trash2 className="w-4 h-4" />} onClose={onClose}>
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        {error && <ErrorBox message={error} />}

        <p className="text-sm text-slate-600">
          ต้องการปลด <span className="font-semibold text-slate-900">{companyLabel(target)}</span>
          {target.contact_id !== null && (
            <>
              {' '}
              เฉพาะผู้ติดต่อ{' '}
              <span className="font-semibold text-slate-900">
                {target.contact_name || `รหัส ${target.contact_id}`}
              </span>
            </>
          )}{' '}
          ออกจากบัญชีระงับใช่หรือไม่ เซลล์จะกลับมาออกใบเสนอราคาให้ได้ทันที
        </p>

        <SubmitRow onClose={onClose} isSubmitting={isSubmitting} label="ปลดออก" danger />
      </form>
    </ModalShell>
  );
};
