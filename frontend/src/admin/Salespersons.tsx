import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { 
  Search, 
  Upload, 
  Trash2, 
  User, 
  Phone, 
  Building2, 
  FileText, 
  CheckCircle2, 
  AlertTriangle, 
  Loader2, 
  Image as ImageIcon,
  UserCheck,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface Salesperson {
  user_id: string;
  name: string;
  status: string;
  phone: string | null;
  salesperson_id: string | null;
  branch: string | null;
  employee_quotations: string | null;
  employee_quotations_phone: string | null;
  has_sale_sig: boolean;
  has_admin_sig: boolean;
  admin_sig_key: string | null;
  created_at: string;
  updated_at: string;
}

export function Salespersons() {
  const { token } = useAuth();
  const [salespersons, setSalespersons] = useState<Salesperson[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Sorting State
  const [sortField, setSortField] = useState<keyof Salesperson>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const handleSort = (field: keyof Salesperson) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
    setCurrentPage(1);
  };

  const renderSortIcon = (field: keyof Salesperson) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-3.5 h-3.5 text-slate-300 ml-1 inline-block opacity-65" />;
    }
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-[#009032] ml-1 inline-block font-bold" />
      : <ArrowDown className="w-3.5 h-3.5 text-[#009032] ml-1 inline-block font-bold" />;
  };
  
  // Upload State
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadingType, setUploadingType] = useState<'sale' | 'admin' | null>(null);
  const [sigTimestamp, setSigTimestamp] = useState<number>(0);
  
  // Dialog/Toast Message
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentUploadTarget = useRef<{ id: string; type: 'sale' | 'admin'; adminName?: string | null } | null>(null);

  const fetchSalespersons = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/salespersons', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) {
        throw new Error('ไม่สามารถดึงข้อมูลพนักงานขายได้');
      }
      const data = await res.json();
      setSalespersons(data);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
      console.error(err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSalespersons();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchSalespersons]);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  const handleUploadClick = (salespersonId: string, type: 'sale' | 'admin', adminName?: string | null) => {
    currentUploadTarget.current = { id: salespersonId, type, adminName };
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUploadTarget.current) return;

    const { id: salespersonId, type, adminName } = currentUploadTarget.current;

    // ลายเซ็นแอดมินผูกกับชื่อแอดมิน (employee_quotations) — ต้องมีชื่อจึงอัปโหลดได้
    if (type === 'admin' && (!adminName || !adminName.trim())) {
      showToast('ยังไม่มีชื่อแอดมินสำหรับพนักงานคนนี้ ไม่สามารถอัปโหลดลายเซ็นได้', 'error');
      return;
    }

    // Validate extension
    const validExtensions = ['image/png', 'image/jpeg', 'image/jpg'];
    if (!validExtensions.includes(file.type)) {
      showToast('กรุณาเลือกไฟล์รูปภาพ PNG หรือ JPG/JPEG เท่านั้น', 'error');
      return;
    }

    // Validate size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      showToast('ขนาดไฟล์รูปภาพต้องไม่เกิน 5MB', 'error');
      return;
    }

    setUploadingId(salespersonId);
    setUploadingType(type);

    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = async () => {
        const base64Data = reader.result as string;
        
        try {
          const res = await fetch('/api/admin/signatures/upload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              salespersonId,
              type,
              adminName: type === 'admin' ? adminName : undefined,
              image: base64Data
            })
          });

          const result = await res.json();

          if (!res.ok) {
            throw new Error(result.error || 'เกิดข้อผิดพลาดในการอัปโหลดลายเซ็น');
          }

          showToast(`อัปโหลดลายเซ็น${type === 'sale' ? 'พนักงานขาย' : 'ผู้อนุมัติ'}สำเร็จ`);
          setSigTimestamp(prev => prev + 1);
          fetchSalespersons(); // Refresh list to update signature status
        } catch (err: unknown) {
          console.error(err);
          const errorMessage = err instanceof Error ? err.message : 'ไม่สามารถอัปโหลดไฟล์ได้';
          showToast(errorMessage, 'error');
        } finally {
          setUploadingId(null);
          setUploadingType(null);
          currentUploadTarget.current = null;
        }
      };
      reader.onerror = () => {
        throw new Error('ไม่สามารถอ่านไฟล์รูปภาพได้');
      };
    } catch (err: unknown) {
      console.error(err);
      const errorMessage = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการประมวลผลไฟล์';
      showToast(errorMessage, 'error');
      setUploadingId(null);
      setUploadingType(null);
      currentUploadTarget.current = null;
    }
  };

  const handleDeleteSignature = async (deleteKey: string, type: 'sale' | 'admin') => {
    if (!window.confirm(`คุณแน่ใจหรือไม่ที่จะลบลายเซ็น${type === 'sale' ? 'พนักงานขาย' : 'ผู้อนุมัติ'}นี้?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/signatures/${type}/${encodeURIComponent(deleteKey)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || 'เกิดข้อผิดพลาดในการลบลายเซ็น');
      }

      showToast(`ลบลายเซ็น${type === 'sale' ? 'พนักงานขาย' : 'ผู้อนุมัติ'}สำเร็จ`);
      setSigTimestamp(prev => prev + 1);
      fetchSalespersons(); // Refresh list to update signature status
    } catch (err: unknown) {
      console.error(err);
      const errorMessage = err instanceof Error ? err.message : 'ไม่สามารถลบลายเซ็นได้';
      showToast(errorMessage, 'error');
    }
  };

  const filteredSalespersons = salespersons.filter((sp) => {
    const term = searchQuery.toLowerCase().trim();
    if (!term) return true;
    
    return (
      sp.name.toLowerCase().includes(term) ||
      (sp.salesperson_id && sp.salesperson_id.toLowerCase().includes(term)) ||
      (sp.phone && sp.phone.toLowerCase().includes(term)) ||
      (sp.branch && sp.branch.toLowerCase().includes(term))
    );
  });

  const sortedSalespersons = [...filteredSalespersons].sort((a, b) => {
    const aValue = a[sortField];
    const bValue = b[sortField];

    // Handle null/undefined values
    if (aValue === null || aValue === undefined) return sortDirection === 'asc' ? 1 : -1;
    if (bValue === null || bValue === undefined) return sortDirection === 'asc' ? -1 : 1;

    // Handle boolean values (has_sale_sig, has_admin_sig)
    if (typeof aValue === 'boolean' && typeof bValue === 'boolean') {
      return sortDirection === 'asc'
        ? (aValue === bValue ? 0 : aValue ? -1 : 1)
        : (aValue === bValue ? 0 : aValue ? 1 : -1);
    }

    // Handle string values (name, branch, employee_quotations, etc.)
    if (typeof aValue === 'string' && typeof bValue === 'string') {
      return sortDirection === 'asc'
        ? aValue.localeCompare(bValue, 'th', { sensitivity: 'base' })
        : bValue.localeCompare(aValue, 'th', { sensitivity: 'base' });
    }

    // Fallback for any other type (numbers, etc.)
    return sortDirection === 'asc'
      ? (aValue > bValue ? 1 : -1)
      : (aValue < bValue ? 1 : -1);
  });

  // Pagination derived values
  const totalItems = sortedSalespersons.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const paginatedSalespersons = sortedSalespersons.slice(startIdx, startIdx + pageSize);
  const rangeStart = totalItems === 0 ? 0 : startIdx + 1;
  const rangeEnd = Math.min(startIdx + pageSize, totalItems);

  const pageNumbers = React.useMemo(() => {
    const pages: (number | 'ellipsis')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
      return pages;
    }
    pages.push(1);
    if (safePage > 3) pages.push('ellipsis');
    const start = Math.max(2, safePage - 1);
    const end = Math.min(totalPages - 1, safePage + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (safePage < totalPages - 2) pages.push('ellipsis');
    pages.push(totalPages);
    return pages;
  }, [totalPages, safePage]);

  return (
    <div className="space-y-6">
      {/* Toast Alert */}
      {toast && (
        <div 
          id="toast-notification"
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl transition-all border animate-fade-in ${
            toast.type === 'success' 
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800' 
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0" />
          )}
          <span className="text-sm font-semibold">{toast.message}</span>
        </div>
      )}

      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".png,.jpg,.jpeg"
        className="hidden"
      />

      {/* Header and Search Actions */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <UserCheck className="w-6 h-6 text-[#009032]" />
            จัดการลายเซ็นพนักงาน
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            ค้นหาข้อมูลพนักงานขาย และอัปโหลด/ลบลายเซ็นรูปภาพ (รองรับไฟล์ PNG และ JPG/JPEG)
          </p>
        </div>

        {/* Search Bar */}
        <div className="relative max-w-md w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            id="salesperson-search-input"
            type="text"
            placeholder="ค้นหาชื่อ, รหัส, เบอร์โทร, สาขา..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            className="w-full pl-10 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 hover:border-slate-300 focus:border-[#009032] focus:bg-white rounded-2xl outline-none transition-all shadow-inner"
          />
        </div>
      </div>

      {/* Loading state */}
      {loading ? (
        <div className="bg-white border border-slate-200 rounded-3xl p-12 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 text-[#009032] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดข้อมูลพนักงานขาย...</p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-3xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-10 h-10 text-red-600" />
          <p className="font-bold">เกิดข้อผิดพลาด</p>
          <p className="text-sm text-red-600">{error}</p>
          <button 
            onClick={fetchSalespersons}
            className="mt-3 px-4 py-2 bg-white border border-red-200 text-red-700 hover:bg-red-100/50 rounded-xl text-xs font-semibold transition-all active:scale-95"
          >
            ลองใหม่อีกครั้ง
          </button>
        </div>
      ) : sortedSalespersons.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-3xl p-12 text-center shadow-sm text-slate-500 flex flex-col items-center justify-center gap-2">
          <User className="w-10 h-10 text-slate-300" />
          <p className="font-bold">ไม่พบข้อมูลพนักงานขาย</p>
          <p className="text-xs">ลองค้นหาด้วยเงื่อนไขอื่น หรือพนักงานขายอาจยังไม่ได้ลงทะเบียนผ่าน LINE</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs font-semibold uppercase tracking-wider select-none">
                  <th 
                    onClick={() => handleSort('name')}
                    className="px-6 py-4 cursor-pointer hover:bg-slate-100 transition-colors w-50"
                  >
                    พนักงานขาย {renderSortIcon('name')}
                  </th>
                  <th 
                    onClick={() => handleSort('branch')}
                    className="px-6 py-4 cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    สังกัด/สาขา {renderSortIcon('branch')}
                  </th>
                  <th 
                    onClick={() => handleSort('employee_quotations')}
                    className="px-6 py-4 cursor-pointer hover:bg-slate-100 transition-colors w-60"
                  >
                    แอดมิน {renderSortIcon('employee_quotations')}
                  </th>
                  <th 
                    onClick={() => handleSort('has_sale_sig')}
                    className="px-6 py-4 text-center cursor-pointer hover:bg-slate-100 transition-colors w-50"
                  >
                    ลายเซ็นพนักงานขาย {renderSortIcon('has_sale_sig')}
                  </th>
                  <th 
                    onClick={() => handleSort('has_admin_sig')}
                    className="px-6 py-4 text-center cursor-pointer hover:bg-slate-100 transition-colors w-50"
                  >
                    ลายเซ็นแอดมิน {renderSortIcon('has_admin_sig')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                {paginatedSalespersons.map((sp) => (
                  <tr key={sp.user_id} className="hover:bg-slate-50/50 transition-colors">
                    {/* ข้อมูลทั่วไป */}
                    <td className="px-6 py-4 space-y-1">
                      <div className="font-bold text-slate-900">{sp.name}</div>
                      <div className="text-xs text-slate-500 flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5 text-slate-400" />
                        ID: <span className="font-semibold text-slate-700">{sp.salesperson_id || 'ไม่มีรหัส'}</span>
                      </div>
                      {sp.phone && (
                        <div className="text-xs text-slate-500 flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 text-slate-400" />
                          <span className="font-mono text-slate-600">{sp.phone}</span>
                        </div>
                      )}
                    </td>

                    {/* สาขา */}
                    <td className="px-6 py-4">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-100 border border-slate-200 rounded-full text-xs font-semibold text-slate-700">
                        <Building2 className="w-3.5 h-3.5 text-slate-500" />
                        {sp.branch || 'ไม่ได้ระบุ'}
                      </div>
                      <div className="text-[10px] text-slate-400 mt-1 uppercase tracking-wider">
                        สถานะ: <span className={sp.status === 'active' ? 'text-emerald-600 font-bold' : 'text-amber-500 font-bold'}>{sp.status}</span>
                      </div>
                    </td>

                    {/* ผู้อนุมัติ */}
                    <td className="px-6 py-4 space-y-1">
                      <div className="font-medium text-slate-800">{sp.employee_quotations ? sp.employee_quotations.replace(/\s*\(.*?\)\s*$/, '').trim() : '-'}</div>
                      {sp.employee_quotations_phone && sp.employee_quotations_phone !== '-' && (
                        <div className="text-xs text-slate-500 flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 text-slate-400" />
                          <span className="font-mono text-slate-600">{sp.employee_quotations_phone}</span>
                        </div>
                      )}
                    </td>

                    {/* ลายเซ็นพนักงานขาย */}
                    <td className="px-6 py-4 text-center">
                      <SignatureCell 
                        salesperson={sp}
                        type="sale"
                        hasSig={sp.has_sale_sig}
                        uploading={uploadingId === sp.salesperson_id && uploadingType === 'sale'}
                        sigTimestamp={sigTimestamp}
                        onUpload={() => sp.salesperson_id && handleUploadClick(sp.salesperson_id, 'sale')}
                        onDelete={() => sp.salesperson_id && handleDeleteSignature(sp.salesperson_id, 'sale')}
                      />
                    </td>

                    {/* ลายเซ็นแอดมิน */}
                    <td className="px-6 py-4 text-center">
                      <SignatureCell 
                        salesperson={sp}
                        type="admin"
                        hasSig={sp.has_admin_sig}
                        uploading={uploadingId === sp.salesperson_id && uploadingType === 'admin'}
                        sigTimestamp={sigTimestamp}
                        onUpload={() => sp.salesperson_id && handleUploadClick(sp.salesperson_id, 'admin', sp.employee_quotations)}
                        onDelete={() => sp.admin_sig_key && handleDeleteSignature(sp.admin_sig_key, 'admin')}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Pagination Footer ── */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50/60">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>
                แสดง <span className="font-semibold text-slate-700">{rangeStart}-{rangeEnd}</span> จาก{' '}
                <span className="font-semibold text-slate-700">{totalItems}</span> รายการ
              </span>
              <span className="text-slate-300">|</span>
              <label className="flex items-center gap-1.5">
                ต่อหน้า
                <select
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                  className="h-7 px-2 rounded-lg border border-slate-200 bg-white text-xs font-semibold outline-none focus:border-[#009032]"
                >
                  {PAGE_SIZE_OPTIONS.map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              {pageNumbers.map((p, idx) =>
                p === 'ellipsis' ? (
                  <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-xs text-slate-400">…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setCurrentPage(p)}
                    className={`w-7 h-7 flex items-center justify-center rounded-lg text-xs font-bold transition-colors ${p === safePage
                      ? 'bg-[#009032] text-white'
                      : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                      }`}
                  >
                    {p}
                  </button>
                )
              )}

              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface SignatureCellProps {
  salesperson: Salesperson;
  type: 'sale' | 'admin';
  hasSig: boolean;
  uploading: boolean;
  sigTimestamp: number;
  onUpload: () => void;
  onDelete: () => void;
}

function SignatureCell({ salesperson, type, hasSig, uploading, sigTimestamp, onUpload, onDelete }: SignatureCellProps) {
  // key ของไฟล์ลายเซ็น: sale ผูกกับ salesperson_id, admin ผูกกับ admin_sig_key (ชื่อแอดมิน)
  const dir = type === 'sale' ? 'sale_sigs' : 'admin_sigs';
  const fileKey = type === 'sale'
    ? (salesperson.salesperson_id ? salesperson.salesperson_id.trim() : null)
    : salesperson.admin_sig_key;

  // ถ้าไม่มี key จะจัดการลายเซ็นไม่ได้
  if (!fileKey) {
    return (
      <div className="flex flex-col items-center justify-center p-2 text-slate-400 text-xs">
        <AlertTriangle className="w-4 h-4 text-amber-500 mb-1" />
        <span>{type === 'sale' ? 'ต้องการรหัสพนักงาน' : 'ต้องการชื่อแอดมิน'}</span>
        <span>เพื่อจัดการลายเซ็น</span>
      </div>
    );
  }

  if (uploading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 text-[#009032] animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2">
      {hasSig ? (
        <div className="group relative bg-slate-50 hover:bg-slate-100 border border-slate-200 hover:border-slate-300 rounded-xl p-2 w-32 h-16 flex items-center justify-center transition-all overflow-hidden shadow-inner">
          {/* Preview Image using dynamic timestamp to avoid caching */}
          <img
            src={`/data/${dir}/${fileKey}.png?t=${sigTimestamp}`}
            alt="Signature"
            className="max-h-full max-w-full object-contain pointer-events-none transition-transform group-hover:scale-105"
            onError={(e) => {
              // หากดึงไฟล์ .png แล้วมีปัญหา (เช่นจริงแล้วเป็นไฟล์ .jpg) ลองสลับ src
              const target = e.target as HTMLImageElement;
              if (target.src.includes('.png')) {
                target.src = `/data/${dir}/${fileKey}.jpg?t=${sigTimestamp}`;
              }
            }}
          />
          
          {/* Action Overlay */}
          <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-2 transition-opacity duration-200">
            <button
              onClick={onUpload}
              title="อัปโหลดใหม่"
              className="p-1.5 bg-white/20 hover:bg-white/40 text-white rounded-lg transition-colors active:scale-90"
            >
              <Upload className="w-4 h-4" />
            </button>
            <button
              onClick={onDelete}
              title="ลบลายเซ็น"
              className="p-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors active:scale-90"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1.5">
          <div className="w-32 h-16 border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center bg-slate-50/50 text-slate-400">
            <ImageIcon className="w-5 h-5 text-slate-300 mb-1" />
            <span className="text-[10px] font-semibold uppercase tracking-wider">ไม่มีรูปภาพ</span>
          </div>
          <button
            onClick={onUpload}
            className="flex items-center gap-1.5 px-3 py-1 bg-white hover:bg-slate-100 text-slate-700 hover:text-slate-950 border border-slate-200 hover:border-slate-300 rounded-xl text-xs font-semibold shadow-sm transition-all active:scale-95"
          >
            <Upload className="w-3.5 h-3.5 text-slate-500" />
            อัปโหลด
          </button>
        </div>
      )}
    </div>
  );
}
