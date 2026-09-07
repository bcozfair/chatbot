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
  ChevronRight,
  Edit2,
  X,
  FileSpreadsheet
} from 'lucide-react';
import { PageHeader } from './PageHeader';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

type ToastType = 'success' | 'error' | 'warning';

interface Salesperson {
  user_id: string;
  name: string;
  status: string;
  phone: string | null;
  salesperson_id: string | null;
  branch: string | null;
  /** ชื่อจริงฝั่ง Odoo — ใช้เป็นช่อง employee_quotation_id ตอน export ใบเสนอราคา */
  employee_quotation_id: string | null;
  has_sale_sig: boolean;
  quotation_count: number;
  created_at: string;
  updated_at: string;
}

// รายชื่อพนักงานจริงจาก sale_orders — ชุดเดียวกับที่หน้า LIFF ใช้ใน dropdown
interface RosterEntry {
  name: string;
  salesperson_id: string | null;
  phone: string | null;
  branch: string | null;
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
      ? <ArrowUp className="w-3.5 h-3.5 text-[var(--brand-fg)] ml-1 inline-block font-bold" />
      : <ArrowDown className="w-3.5 h-3.5 text-[var(--brand-fg)] ml-1 inline-block font-bold" />;
  };
  
  // Upload State
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [sigTimestamp, setSigTimestamp] = useState<number>(0);

  // Dialog/Toast Message
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);

  // รายชื่อพนักงานจริง (สำหรับ dropdown ในโมดัลแก้ไข)
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [showNameSuggest, setShowNameSuggest] = useState(false);

  // Delete confirm
  const [deletingSp, setDeletingSp] = useState<Salesperson | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Edit profile modal (ชื่อ / เบอร์โทร / รหัสพนักงาน)
  const [editingSp, setEditingSp] = useState<Salesperson | null>(null);
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formSpId, setFormSpId] = useState('');
  const [formEmpQuotationId, setFormEmpQuotationId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentUploadTarget = useRef<{ id: string } | null>(null);

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

  // รายชื่อพนักงานจริงจาก sale_orders (endpoint เดียวกับที่หน้า LIFF ใช้ — ไม่ต้องใช้ token)
  useEffect(() => {
    fetch('/api/salespeople')
      .then(res => res.ok ? res.json() : [])
      .then((data: RosterEntry[]) => setRoster(Array.isArray(data) ? data : []))
      .catch(err => console.error('โหลดรายชื่อพนักงานไม่สำเร็จ:', err));
  }, []);

  const showToast = (message: string, type: ToastType = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, type === 'success' ? 4000 : 7000);
  };

  const openEditModal = (sp: Salesperson) => {
    setEditingSp(sp);
    // ชื่อตั้งต้น 'รอดำเนินการ' คือ placeholder ตอนบอทสร้างแถว ไม่ใช่ชื่อจริง — ให้แอดมินเลือกใหม่
    setFormName(sp.name === 'รอดำเนินการ' ? '' : sp.name);
    setFormPhone(sp.phone || '');
    setFormSpId(sp.salesperson_id || '');
    setFormEmpQuotationId(sp.employee_quotation_id || '');
    setFormError(null);
    setShowNameSuggest(false);
  };

  // เลือกชื่อจากรายการ → เติมรหัส/เบอร์ให้อัตโนมัติ เหมือนหน้า LIFF
  const applyRosterPick = (entry: RosterEntry) => {
    setFormName(entry.name);
    setFormSpId(entry.salesperson_id || '');
    if (entry.phone) setFormPhone(entry.phone);
    setShowNameSuggest(false);
  };

  const nameSuggestions = roster.filter(r => {
    const q = formName.trim().toLowerCase();
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || (r.salesperson_id || '').toLowerCase().includes(q);
  }).slice(0, 50);

  const handleDelete = async () => {
    if (!deletingSp) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/admin/salespersons/${encodeURIComponent(deletingSp.user_id)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || 'ลบพนักงานขายไม่สำเร็จ');
      }
      setDeletingSp(null);
      showToast(`ลบ ${result.name || deletingSp.name} ออกจากระบบแล้ว`);
      fetchSalespersons();
    } catch (err: unknown) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'ลบพนักงานขายไม่สำเร็จ', 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSp) return;

    const name = formName.trim();
    const salespersonId = formSpId.trim();
    if (!name) { setFormError('กรุณากรอกชื่อพนักงานขาย'); return; }
    if (!salespersonId) { setFormError('กรุณากรอกรหัสพนักงานขาย'); return; }

    setIsSaving(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/admin/salespersons/${encodeURIComponent(editingSp.user_id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        // employeeQuotationId ว่าง = สั่งลบค่าเดิมทิ้ง (backend แปลงเป็น NULL)
        body: JSON.stringify({
          name,
          phone: formPhone.trim(),
          salespersonId,
          employeeQuotationId: formEmpQuotationId.trim()
        })
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || 'บันทึกข้อมูลไม่สำเร็จ');
      }

      setEditingSp(null);
      // รหัสซ้ำไม่ได้บล็อกไว้ แต่ต้องบอกให้รู้ เพราะลายเซ็นผูกกับรหัส = ใช้ร่วมกับคนนั้นทันที
      const dup: string[] = result.duplicateWith || [];
      if (dup.length > 0) {
        showToast(`บันทึกแล้ว แต่รหัส ${salespersonId} ซ้ำกับ: ${dup.join(', ')} — ทั้งสองคนจะใช้ลายเซ็นใบเดียวกัน`, 'warning');
      } else {
        showToast('บันทึกข้อมูลพนักงานขายสำเร็จ');
      }
      fetchSalespersons();
    } catch (err: unknown) {
      console.error(err);
      setFormError(err instanceof Error ? err.message : 'บันทึกข้อมูลไม่สำเร็จ');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUploadClick = (salespersonId: string) => {
    currentUploadTarget.current = { id: salespersonId };
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUploadTarget.current) return;

    const { id: salespersonId } = currentUploadTarget.current;

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
              image: base64Data
            })
          });

          const result = await res.json();

          if (!res.ok) {
            throw new Error(result.error || 'เกิดข้อผิดพลาดในการอัปโหลดลายเซ็น');
          }

          showToast('อัปโหลดลายเซ็นพนักงานขายสำเร็จ');
          setSigTimestamp(prev => prev + 1);
          fetchSalespersons(); // Refresh list to update signature status
        } catch (err: unknown) {
          console.error(err);
          const errorMessage = err instanceof Error ? err.message : 'ไม่สามารถอัปโหลดไฟล์ได้';
          showToast(errorMessage, 'error');
        } finally {
          setUploadingId(null);
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
      currentUploadTarget.current = null;
    }
  };

  const handleDeleteSignature = async (deleteKey: string) => {
    if (!window.confirm('คุณแน่ใจหรือไม่ที่จะลบลายเซ็นพนักงานขายนี้?')) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/signatures/${encodeURIComponent(deleteKey)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || 'เกิดข้อผิดพลาดในการลบลายเซ็น');
      }

      showToast('ลบลายเซ็นพนักงานขายสำเร็จ');
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
      (sp.branch && sp.branch.toLowerCase().includes(term)) ||
      (sp.employee_quotation_id && sp.employee_quotation_id.toLowerCase().includes(term))
    );
  });

  const sortedSalespersons = [...filteredSalespersons].sort((a, b) => {
    const aValue = a[sortField];
    const bValue = b[sortField];

    // Handle null/undefined values
    if (aValue === null || aValue === undefined) return sortDirection === 'asc' ? 1 : -1;
    if (bValue === null || bValue === undefined) return sortDirection === 'asc' ? -1 : 1;

    // Handle boolean values (has_sale_sig)
    if (typeof aValue === 'boolean' && typeof bValue === 'boolean') {
      return sortDirection === 'asc'
        ? (aValue === bValue ? 0 : aValue ? -1 : 1)
        : (aValue === bValue ? 0 : aValue ? 1 : -1);
    }

    // Handle string values (name, branch, etc.)
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
          className={`fixed bottom-5 right-5 z-[60] max-w-md flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl transition-all border animate-fade-in ${
            toast.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : toast.type === 'warning'
                ? 'bg-amber-50 border-amber-200 text-amber-900'
                : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
          ) : (
            <AlertTriangle className={`w-5 h-5 flex-shrink-0 ${toast.type === 'warning' ? 'text-amber-500' : 'text-red-600'}`} />
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

      {/* หัวเรื่อง + ช่องค้นหา ขึ้นไปอยู่บนแถบบน (ดู PageHeader.tsx) */}
      <PageHeader
        icon={UserCheck}
        title="จัดการข้อมูลพนักงาน"
        description="แก้ไขชื่อ/เบอร์โทร/รหัสพนักงาน และอัปโหลดลายเซ็น (PNG, JPG/JPEG)"
      >
        <div className="relative w-48 sm:w-64 lg:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            id="salesperson-search-input"
            type="text"
            placeholder="ค้นหาชื่อ, รหัส, เบอร์โทร, สาขา, employee_name..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            className="w-full pl-10 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 hover:border-slate-300 focus:border-[var(--brand-fg)] focus:bg-card rounded-2xl outline-none transition-all shadow-inner"
          />
        </div>
      </PageHeader>

      {/* Loading state */}
      {loading ? (
        <div className="bg-card border border-slate-200 rounded-3xl p-12 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 text-[var(--brand-fg)] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดข้อมูลพนักงานขาย...</p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-3xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-10 h-10 text-red-600" />
          <p className="font-bold">เกิดข้อผิดพลาด</p>
          <p className="text-sm text-red-600">{error}</p>
          <button 
            onClick={fetchSalespersons}
            className="mt-3 px-4 py-2 bg-card border border-red-200 text-red-700 hover:bg-red-100/50 rounded-xl text-xs font-semibold transition-all active:scale-95"
          >
            ลองใหม่อีกครั้ง
          </button>
        </div>
      ) : sortedSalespersons.length === 0 ? (
        <div className="bg-card border border-slate-200 rounded-3xl p-12 text-center shadow-sm text-slate-500 flex flex-col items-center justify-center gap-2">
          <User className="w-10 h-10 text-slate-300" />
          <p className="font-bold">ไม่พบข้อมูลพนักงานขาย</p>
          <p className="text-xs">ลองค้นหาด้วยเงื่อนไขอื่น หรือพนักงานขายอาจยังไม่ได้ลงทะเบียนผ่าน LINE</p>
        </div>
      ) : (
        <div className="bg-card border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
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
                    onClick={() => handleSort('employee_quotation_id')}
                    className="px-6 py-4 cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    employee_name {renderSortIcon('employee_quotation_id')}
                  </th>
                  <th
                    onClick={() => handleSort('branch')}
                    className="px-6 py-4 cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    สังกัด/สาขา {renderSortIcon('branch')}
                  </th>
                  <th
                    onClick={() => handleSort('has_sale_sig')}
                    className="px-6 py-4 text-center cursor-pointer hover:bg-slate-100 transition-colors w-50"
                  >
                    ลายเซ็นพนักงานขาย {renderSortIcon('has_sale_sig')}
                  </th>
                  <th className="px-6 py-4 text-center w-20">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                {paginatedSalespersons.map((sp) => (
                  <tr key={sp.user_id} className="hover:bg-slate-50/50 transition-colors">
                    {/* ข้อมูลทั่วไป */}
                    <td className="px-6 py-4 space-y-1">
                      <div className="font-bold text-slate-900">{sp.name}</div>
                      {sp.salesperson_id ? (
                        <div className="text-xs text-slate-500 flex items-center gap-1.5">
                          <FileText className="w-3.5 h-3.5 text-slate-400" />
                          ID: <span className="font-semibold text-slate-700">{sp.salesperson_id}</span>
                        </div>
                      ) : (
                        // ไม่มีรหัส = พนักงานคนนี้บันทึกหน้าลงทะเบียน LIFF ไม่ได้จนกว่าแอดมินจะเติมให้
                        <div className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 inline-flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                          ไม่มีรหัสพนักงาน
                        </div>
                      )}
                      {sp.phone && (
                        <div className="text-xs text-slate-500 flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 text-slate-400" />
                          <span className="font-mono text-slate-600">{sp.phone}</span>
                        </div>
                      )}
                    </td>

                    {/* employee_name — ชื่อจริงของเซลล์ที่ไฟล์ export (ช่อง J) ใช้ ว่างได้ */}
                    <td className="px-6 py-4">
                      {sp.employee_quotation_id ? (
                        <div className="flex items-center gap-1.5">
                          <FileSpreadsheet className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                          <span className="font-semibold text-slate-800">{sp.employee_quotation_id}</span>
                        </div>
                      ) : (
                        <span className="text-xs italic text-slate-400">ยังไม่ระบุ</span>
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

                    {/* ลายเซ็นพนักงานขาย */}
                    <td className="px-6 py-4 text-center">
                      <SignatureCell
                        salesperson={sp}
                        hasSig={sp.has_sale_sig}
                        uploading={uploadingId === sp.salesperson_id}
                        sigTimestamp={sigTimestamp}
                        onUpload={() => sp.salesperson_id && handleUploadClick(sp.salesperson_id)}
                        onDelete={() => sp.salesperson_id && handleDeleteSignature(sp.salesperson_id)}
                      />
                    </td>

                    {/* จัดการ */}
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => openEditModal(sp)}
                          className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-900 rounded-lg transition-colors"
                          title="แก้ไขชื่อ / เบอร์โทร / รหัสพนักงาน"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeletingSp(sp)}
                          className="p-1.5 hover:bg-red-50 text-slate-500 hover:text-red-600 rounded-lg transition-colors"
                          title="ลบพนักงานขายออกจากระบบ"
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
                  className="h-7 px-2 rounded-lg border border-slate-200 bg-card text-xs font-semibold outline-none focus:border-[var(--brand-fg)]"
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
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 bg-card text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
                      ? 'bg-[var(--brand)] text-white'
                      : 'bg-card border border-slate-200 text-slate-600 hover:bg-slate-100'
                      }`}
                  >
                    {p}
                  </button>
                )
              )}

              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 bg-card text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Profile Modal — ชื่อ / เบอร์โทร / รหัสพนักงาน */}
      {editingSp && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-slate-200 w-full max-w-md shadow-2xl flex flex-col">

            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">แก้ไขข้อมูลพนักงานขาย</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">LINE User ID: {editingSp.user_id}</p>
              </div>
              <button
                onClick={() => setEditingSp(null)}
                className="w-7 h-7 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveProfile} className="flex flex-col">
              <div className="px-5 py-4 space-y-4">
                {formError && (
                  <div className="bg-red-50 border border-red-100 text-red-700 p-3.5 rounded-xl flex items-start gap-2.5 text-xs">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{formError}</span>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                    ชื่อพนักงานขาย <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => { setFormName(e.target.value); setShowNameSuggest(true); }}
                      onFocus={() => setShowNameSuggest(true)}
                      onBlur={() => setTimeout(() => setShowNameSuggest(false), 150)}
                      placeholder="แตะเพื่อเลือกจากรายชื่อ หรือพิมพ์ค้นหา..."
                      autoComplete="off"
                      className="w-full h-9 px-3 bg-card border border-slate-200 focus:border-[var(--brand-fg)] rounded-xl text-sm text-slate-800 outline-none transition-all focus:ring-2 focus:ring-[var(--brand-fg)]/10"
                    />
                    {showNameSuggest && (
                      <div className="absolute left-0 right-0 top-full mt-1 z-10 max-h-52 overflow-y-auto bg-card border border-slate-200 rounded-xl shadow-lg">
                        {nameSuggestions.length === 0 ? (
                          <div className="px-3 py-2.5 text-xs text-slate-400 italic">
                            ไม่พบชื่อในรายการขาย — พิมพ์ชื่อและรหัสเองได้สำหรับพนักงานใหม่
                          </div>
                        ) : nameSuggestions.map((r) => (
                          <button
                            key={`${r.salesperson_id}-${r.name}`}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); applyRosterPick(r); }}
                            className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-b-0 transition-colors"
                          >
                            <span className="text-sm text-slate-800">{r.name}</span>
                            <span className="ml-2 text-[11px] font-mono text-slate-400">{r.salesperson_id}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    เลือกจากรายชื่อแล้วรหัส/เบอร์จะเติมให้อัตโนมัติ — พนักงานใหม่ที่ยังไม่มีออร์เดอร์ พิมพ์เองได้
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">เบอร์โทรศัพท์</label>
                  <input
                    type="text"
                    value={formPhone}
                    onChange={(e) => setFormPhone(e.target.value)}
                    placeholder="เช่น 081-234-5678"
                    maxLength={100}
                    className="w-full h-9 px-3 bg-card border border-slate-200 focus:border-[var(--brand-fg)] rounded-xl text-sm text-slate-800 outline-none transition-all focus:ring-2 focus:ring-[var(--brand-fg)]/10"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                    รหัสพนักงานขาย <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formSpId}
                    onChange={(e) => setFormSpId(e.target.value)}
                    placeholder="เช่น SP001"
                    maxLength={50}
                    className="w-full h-9 px-3 bg-card border border-slate-200 focus:border-[var(--brand-fg)] rounded-xl text-sm font-mono text-slate-800 outline-none transition-all focus:ring-2 focus:ring-[var(--brand-fg)]/10"
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    รหัสนี้ใช้ผูกกับไฟล์ลายเซ็น และพนักงานต้องมีรหัสก่อนจึงจะบันทึกหน้าลงทะเบียนใน LINE ได้
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                    employee_name (ชื่อจริงสำหรับ export)
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={formEmpQuotationId}
                      onChange={(e) => setFormEmpQuotationId(e.target.value)}
                      placeholder="เช่น นฤเบศร์ ทองดี"
                      maxLength={255}
                      className="w-full h-9 pl-3 pr-9 bg-card border border-slate-200 focus:border-[var(--brand-fg)] rounded-xl text-sm text-slate-800 outline-none transition-all focus:ring-2 focus:ring-[var(--brand-fg)]/10"
                    />
                    {formEmpQuotationId && (
                      <button
                        type="button"
                        onClick={() => setFormEmpQuotationId('')}
                        title="ล้างค่า (บันทึกแล้วจะลบชื่อจริงออกจากระบบ)"
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-red-600 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    ชื่อจริงของเซลล์ฝั่ง Odoo — ไฟล์ export จะเติมสังกัด (PM)/(THT) ให้เองตามเลขที่ใบ
                    เว้นว่างไว้ได้ ช่องนี้ในไฟล์จะเป็นเซลล์ว่าง
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
                <button
                  type="button"
                  onClick={() => setEditingSp(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-lg transition-all"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-5 py-2 text-xs font-bold text-white bg-[var(--brand)] hover:bg-[var(--brand-hover)] rounded-lg transition-all active:scale-95 shadow-sm flex items-center gap-1.5 disabled:opacity-60"
                >
                  {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                  บันทึกข้อมูล
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deletingSp && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-slate-200 w-full max-w-md shadow-2xl">
            <div className="px-5 py-4 border-b border-slate-100 flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-4.5 h-4.5 text-red-600" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900 text-sm">ลบพนักงานขายรายนี้?</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {deletingSp.name} · รหัส {deletingSp.salesperson_id || 'ไม่มีรหัส'}
                </p>
              </div>
            </div>

            <div className="px-5 py-4 space-y-2.5 text-xs text-slate-600">
              <p className="font-semibold text-slate-700">สิ่งที่จะเกิดขึ้น</p>
              <ul className="space-y-1.5 list-disc list-inside">
                <li>ผู้ใช้ LINE รายนี้จะกลายเป็นผู้ที่ยังไม่ลงทะเบียน ต้องลงทะเบียนใหม่จึงจะใช้บอทได้</li>
                {deletingSp.quotation_count > 0 && (
                  <li className="text-amber-700">
                    ใบเสนอราคา <span className="font-bold">{deletingSp.quotation_count}</span> ใบจะไม่ผูกกับพนักงานคนนี้อีก
                    (ใบยังอยู่ในระบบ ชื่อ/รหัสบนใบยังพิมพ์ออกได้จากข้อมูลที่บันทึกไว้ตอนออกใบ แต่ผูกกลับคืนไม่ได้แม้ลงทะเบียนใหม่)
                  </li>
                )}
                <li>ไฟล์ลายเซ็นไม่ถูกลบ (ผูกกับรหัสพนักงาน) — ลงทะเบียนใหม่ด้วยรหัสเดิมแล้วใช้ได้เหมือนเดิม</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
              <button
                type="button"
                onClick={() => setDeletingSp(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-lg transition-all"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-5 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-all active:scale-95 shadow-sm flex items-center gap-1.5 disabled:opacity-60"
              >
                {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                ลบพนักงานขาย
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
  hasSig: boolean;
  uploading: boolean;
  sigTimestamp: number;
  onUpload: () => void;
  onDelete: () => void;
}

function SignatureCell({ salesperson, hasSig, uploading, sigTimestamp, onUpload, onDelete }: SignatureCellProps) {
  // ลายเซ็นพนักงานขายผูกกับรหัสพนักงาน (salesperson_id)
  const dir = 'sale_sigs';
  const fileKey = salesperson.salesperson_id ? salesperson.salesperson_id.trim() : null;

  // ถ้าไม่มีรหัสพนักงาน จะจัดการลายเซ็นไม่ได้
  if (!fileKey) {
    return (
      <div className="flex flex-col items-center justify-center p-2 text-slate-400 text-xs">
        <AlertTriangle className="w-4 h-4 text-amber-500 mb-1" />
        <span>ต้องการรหัสพนักงาน</span>
        <span>เพื่อจัดการลายเซ็น</span>
      </div>
    );
  }

  if (uploading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 text-[var(--brand-fg)] animate-spin" />
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
          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-2 transition-opacity duration-200">
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
            className="flex items-center gap-1.5 px-3 py-1 bg-card hover:bg-slate-100 text-slate-700 hover:text-slate-950 border border-slate-200 hover:border-slate-300 rounded-xl text-xs font-semibold shadow-sm transition-all active:scale-95"
          >
            <Upload className="w-3.5 h-3.5 text-slate-500" />
            อัปโหลด
          </button>
        </div>
      )}
    </div>
  );
}
