import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { 
  Plus, 
  Search, 
  Edit2, 
  Trash2, 
  X, 
  Loader2, 
  CheckCircle2, 
  AlertTriangle, 
  Link as LinkIcon,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface ProductOptionalLink {
  id: number;
  trigger_product_id: string;
  optional_product_id: string;
  is_active: boolean;
  note: string | null;
  trigger_model: string;
  trigger_name: string;
  optional_model: string;
  optional_name: string;
  created_at: string;
  updated_at: string;
}

interface ProductSearchResult {
  product_id: number;
  model: string;
  name: string;
  price: number;
  internal_reference?: string;
}

// Product AutoComplete ComboBox Component
interface ProductComboBoxProps {
  label: string;
  placeholder: string;
  value: { id: number; model: string; name: string; internal_reference?: string } | null;
  onChange: (val: { id: number; model: string; name: string; internal_reference?: string } | null) => void;
  error?: boolean;
}

const ProductComboBox: React.FC<ProductComboBoxProps> = ({
  label,
  placeholder,
  value,
  onChange,
  error
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      if (results.length > 0) {
        const timer = setTimeout(() => {
          setResults([]);
        }, 0);
        return () => clearTimeout(timer);
      }
      return;
    }

    const delayDebounceFn = setTimeout(async () => {
      setIsLoading(true);
      try {
        const resp = await fetch(`/api/products/search?q=${encodeURIComponent(query)}`);
        if (resp.ok) {
          const data = await resp.json();
          setResults(data);
        }
      } catch (err) {
        console.error("Product search error in ComboBox:", err);
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [query, results.length]);

  return (
    <div className="space-y-1.5" ref={dropdownRef}>
      <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">
        {label}
      </label>
      <div className="relative">
        <div
          className={`flex items-center gap-2 w-full h-11 px-3.5 rounded-xl border text-sm transition-all ${
            isOpen
              ? 'border-[#009032] bg-white ring-2 ring-[#009032]/10 shadow-sm'
              : error
              ? 'border-red-300 bg-red-50/10'
              : value
              ? 'border-slate-300 bg-white'
              : 'border-slate-200 bg-slate-50 hover:border-slate-300'
          }`}
          onClick={() => setIsOpen(true)}
        >
          <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
          {isOpen ? (
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="พิมพ์รหัสอ้างอิง, รุ่น หรือชื่อสินค้า..."
              className="flex-1 bg-transparent outline-none text-sm text-slate-800 placeholder:text-slate-400"
              autoFocus
            />
          ) : (
            <span className={`flex-1 truncate ${value ? 'text-slate-800 font-semibold' : 'text-slate-400'}`}>
              {value ? `${value.internal_reference ? `[${value.internal_reference}] ` : ''}${value.model} - ${value.name}` : placeholder}
            </span>
          )}
          {value && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
                setQuery('');
              }}
              className="w-5 h-5 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors"
            >
              <X className="w-3 h-3 text-slate-500" />
            </button>
          )}
        </div>

        {isOpen && (
          <div className="absolute z-50 mt-1.5 w-full bg-white border border-slate-200 rounded-xl shadow-xl max-h-56 overflow-y-auto divide-y divide-slate-100">
            {isLoading ? (
              <div className="p-4 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 text-[#009032] animate-spin" />
                กำลังค้นหา...
              </div>
            ) : results.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">
                {query.trim() ? 'ไม่พบสินค้าในระบบ' : 'พิมพ์รหัส/ชื่อสินค้าเพื่อเริ่มค้นหา'}
              </div>
            ) : (
              results.map((prod) => (
                <button
                  key={prod.product_id}
                  type="button"
                  onClick={() => {
                    onChange({ id: prod.product_id, model: prod.model, name: prod.name, internal_reference: prod.internal_reference });
                    setQuery('');
                    setIsOpen(false);
                  }}
                  className="w-full text-left px-4 py-3 text-xs hover:bg-slate-50 transition-colors flex flex-col gap-0.5"
                >
                  <span className="font-semibold text-slate-800 text-sm">
                    {prod.internal_reference ? `[${prod.internal_reference}] ` : ''}{prod.model}
                  </span>
                  <span className="text-slate-500 line-clamp-1">{prod.name}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const OptionalLinks: React.FC = () => {
  const { token } = useAuth();
  const [links, setLinks] = useState<ProductOptionalLink[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Sort State
  const [sortField, setSortField] = useState<string>('id');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Modal / Form States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [linkToDelete, setLinkToDelete] = useState<ProductOptionalLink | null>(null);
  const [editingLink, setEditingLink] = useState<ProductOptionalLink | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Form Fields
  const [triggerProduct, setTriggerProduct] = useState<{ id: number; model: string; name: string; internal_reference?: string } | null>(null);
  const [optionalProduct, setOptionalProduct] = useState<{ id: number; model: string; name: string; internal_reference?: string } | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [note, setNote] = useState('');

  // Fetch optional links
  const fetchLinks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/optional-links', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!response.ok) {
        throw new Error('ไม่สามารถโหลดข้อมูลสินค้าเสริมได้');
      }
      const data = await response.json();
      setLinks(data);
    } catch (err: unknown) {
      console.error("Fetch optional links error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
      setError(errMsg);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      const timer = setTimeout(() => {
        fetchLinks();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [token, fetchLinks]);

  // Toast helper
  const showToast = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // Sort handler
  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
    setCurrentPage(1);
  };

  const renderSortIcon = (field: string) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-3.5 h-3.5 text-slate-300 ml-1.5 inline-block" />;
    }
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-[#009032] ml-1.5 inline-block font-bold" />
      : <ArrowDown className="w-3.5 h-3.5 text-[#009032] ml-1.5 inline-block font-bold" />;
  };

  // Open modal for Create
  const handleCreateOpen = () => {
    setEditingLink(null);
    setFormError(null);
    setTriggerProduct(null);
    setOptionalProduct(null);
    setIsActive(true);
    setNote('');
    setIsModalOpen(true);
  };

  // Open modal for Edit
  const handleEditOpen = (link: ProductOptionalLink) => {
    setEditingLink(link);
    setFormError(null);
    setTriggerProduct({
      id: 0,
      model: link.trigger_model,
      name: link.trigger_name,
      internal_reference: link.trigger_product_id
    });
    setOptionalProduct({
      id: 0,
      model: link.optional_model,
      name: link.optional_name,
      internal_reference: link.optional_product_id
    });
    setIsActive(link.is_active);
    setNote(link.note || '');
    setIsModalOpen(true);
  };

  // Open delete confirmation
  const handleDeleteOpen = (link: ProductOptionalLink) => {
    setLinkToDelete(link);
    setIsDeleteConfirmOpen(true);
  };

  // Form Submit (Create or Update)
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!triggerProduct || !optionalProduct) {
      setFormError('กรุณาเลือกทั้งสินค้าหลักและสินค้าเสริม');
      return;
    }
    const trigRef = triggerProduct.internal_reference || triggerProduct.model;
    const optRef = optionalProduct.internal_reference || optionalProduct.model;
    if (trigRef === optRef) {
      setFormError('สินค้าหลักและสินค้าเสริมต้องไม่เป็นตัวเดียวกัน');
      return;
    }

    setFormError(null);
    setIsSaving(true);

    const payload = {
      trigger_product_id: trigRef,
      optional_product_id: optRef,
      is_active: isActive,
      note: note.trim() || null
    };

    try {
      const url = editingLink 
        ? `/api/admin/optional-links/${editingLink.id}` 
        : '/api/admin/optional-links';
      
      const method = editingLink ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'เกิดข้อผิดพลาดในการบันทึกข้อมูล');
      }

      setIsModalOpen(false);
      showToast(editingLink ? 'แก้ไขข้อมูลการจับคู่สำเร็จ' : 'สร้างคู่สินค้าเสริมใหม่สำเร็จ');
      fetchLinks();
    } catch (err: unknown) {
      console.error("Save error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการบันทึกข้อมูล';
      setFormError(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  // Confirm delete
  const handleDeleteConfirm = async () => {
    if (!linkToDelete) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/admin/optional-links/${linkToDelete.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'ไม่สามารถลบความสัมพันธ์นี้ได้');
      }

      setIsDeleteConfirmOpen(false);
      setLinkToDelete(null);
      showToast('ลบการจับคู่สินค้าสำเร็จเรียบร้อย');
      fetchLinks();
    } catch (err: unknown) {
      console.error("Delete error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการลบข้อมูล';
      setError(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  // Toggle active status directly
  const handleToggleActive = async (link: ProductOptionalLink) => {
    try {
      const response = await fetch(`/api/admin/optional-links/${link.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          trigger_product_id: link.trigger_product_id,
          optional_product_id: link.optional_product_id,
          is_active: !link.is_active,
          note: link.note
        })
      });

      if (!response.ok) {
        throw new Error('ไม่สามารถแก้ไขสถานะการใช้งานได้');
      }

      setLinks(prev => prev.map(l => l.id === link.id ? { ...l, is_active: !l.is_active } : l));
      showToast(`แก้ไขสถานะการเชื่อมโยงของรุ่น "${link.trigger_model}" สำเร็จ`);
    } catch (err: unknown) {
      console.error("Toggle error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการแก้ไขสถานะ';
      setError(errMsg);
    }
  };

  // Filter and Sort links
  const filteredLinks = links.filter(link => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      link.trigger_model.toLowerCase().includes(q) ||
      link.trigger_name.toLowerCase().includes(q) ||
      link.optional_model.toLowerCase().includes(q) ||
      link.optional_name.toLowerCase().includes(q) ||
      (link.note && link.note.toLowerCase().includes(q))
    );
  });

  const sortedLinks = [...filteredLinks].sort((a, b) => {
    let aVal: string | number = '';
    let bVal: string | number = '';

    if (sortField === 'id') {
      aVal = a.id;
      bVal = b.id;
    } else if (sortField === 'trigger') {
      aVal = a.trigger_model;
      bVal = b.trigger_model;
    } else if (sortField === 'optional') {
      aVal = a.optional_model;
      bVal = b.optional_model;
    } else if (sortField === 'note') {
      aVal = a.note || '';
      bVal = b.note || '';
    } else if (sortField === 'is_active') {
      aVal = a.is_active ? 1 : 0;
      bVal = b.is_active ? 1 : 0;
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDirection === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });

  // Pagination derived values
  const totalItems = sortedLinks.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const paginatedLinks = sortedLinks.slice(startIdx, startIdx + pageSize);
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
    <div className="space-y-4">
      {/* Toast popup alert */}
      {successMsg && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl transition-all border animate-fade-in bg-emerald-50 border-emerald-200 text-emerald-800">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
          <span className="text-sm font-semibold">{successMsg}</span>
        </div>
      )}

      {/* Compact single-row header */}
      <div className="bg-white border border-slate-200 rounded-2xl px-5 py-3.5 shadow-sm flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 flex-shrink-0">
          <LinkIcon className="w-5 h-5 text-[#009032]" />
          <h2 className="text-base font-bold text-slate-900 whitespace-nowrap">คู่สินค้าหลัก-สินค้าเสริม (Optional)</h2>
          <span className="text-xs text-slate-400 hidden lg:inline">
            พ่วงเสนอขายสินค้าเสริมอัตโนมัติเมื่อเลือกสินค้าหลัก
          </span>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-60">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="ค้นหา..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 hover:border-slate-300 focus:border-[#009032] focus:bg-white rounded-xl outline-none transition-all"
            />
          </div>

          <button
            onClick={handleCreateOpen}
            className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#009032] hover:bg-[#007b2b] text-white text-sm font-bold rounded-xl shadow-sm transition-all active:scale-95 flex-shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">สร้างคู่ใหม่</span>
          </button>
        </div>
      </div>

      {/* Loading & Empty States */}
      {isLoading ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-7 h-7 text-[#009032] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดข้อมูลสินค้าเสริม...</p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-9 h-9 text-red-600" />
          <p className="font-bold">เกิดข้อผิดพลาดในการดึงข้อมูล</p>
          <p className="text-sm text-red-600">{error}</p>
        </div>
      ) : sortedLinks.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm text-slate-500 flex flex-col items-center justify-center gap-2">
          <LinkIcon className="w-9 h-9 text-slate-300" />
          <p className="font-bold">ไม่พบความสัมพันธ์สินค้าเสริม</p>
          <p className="text-xs">ทดลองใช้ช่องค้นหาอื่น หรือสร้างการจับคู่ใหม่ได้ทันที</p>
        </div>
      ) : (
        /* Links Table */
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider select-none">
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors w-20" onClick={() => handleSort('id')}>
                    ID {renderSortIcon('id')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('trigger')}>
                    สินค้าหลัก (Trigger) {renderSortIcon('trigger')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('optional')}>
                    สินค้าเสริม (Optional) {renderSortIcon('optional')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('note')}>
                    หมายเหตุ {renderSortIcon('note')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors text-center w-28" onClick={() => handleSort('is_active')}>
                    สถานะ {renderSortIcon('is_active')}
                  </th>
                  <th className="px-4 py-3 text-center w-20">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                {paginatedLinks.map((link) => (
                  <tr key={link.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-4 py-2.5 font-mono font-bold text-slate-400">#{link.id}</td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="font-semibold text-slate-900 text-[13px] font-mono">{link.trigger_model}</div>
                      <div className="text-[11px] text-slate-500 line-clamp-1">{link.trigger_name}</div>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="font-semibold text-[#009032] text-[13px] font-mono">{link.optional_model}</div>
                      <div className="text-[11px] text-slate-500 line-clamp-1">{link.optional_name}</div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-500 text-xs italic">
                      {link.note || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => handleToggleActive(link)}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-all ${
                          link.is_active
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-slate-50 border-slate-200 text-slate-400'
                        }`}
                      >
                        {link.is_active ? 'เปิด' : 'ปิด'}
                      </button>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleEditOpen(link)}
                          className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-900 rounded-lg transition-colors"
                          title="แก้ไขความสัมพันธ์"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteOpen(link)}
                          className="p-1.5 hover:bg-red-50 text-slate-500 hover:text-red-600 rounded-lg transition-colors"
                          title="ลบความสัมพันธ์"
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

      {/* Edit/Create Modal Form */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">

            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">
                  {editingLink ? 'แก้ไขคู่สินค้าเสริม' : 'เพิ่มคู่สินค้าเสริมใหม่'}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">เลือกสินค้าหลักและสินค้าเสริมที่จะจับคู่</p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="w-7 h-7 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="flex flex-col flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                {formError && (
                  <div className="bg-red-50 border border-red-100 text-red-700 p-3.5 rounded-xl flex items-start gap-2.5 text-xs">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{formError}</span>
                  </div>
                )}

                {/* Trigger Product ComboBox */}
                <ProductComboBox
                  label="สินค้าหลัก (Trigger Product)"
                  placeholder="เลือกสินค้าหลัก..."
                  value={triggerProduct}
                  onChange={setTriggerProduct}
                  error={!!formError && !triggerProduct}
                />

                {/* Optional Product ComboBox */}
                <ProductComboBox
                  label="สินค้าเสริม (Optional Product)"
                  placeholder="เลือกสินค้าเสริม..."
                  value={optionalProduct}
                  onChange={setOptionalProduct}
                  error={!!formError && !optionalProduct}
                />

                {/* Note / Memo */}
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                    หมายเหตุ / เหตุผล
                  </label>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="เช่น ซีรีส์นี้ต้องการตัวแปลงเสริมพ่วง..."
                    className="w-full h-9 px-3 bg-white border border-slate-200 focus:border-[#009032] rounded-xl text-sm text-slate-800 outline-none transition-all focus:ring-2 focus:ring-[#009032]/10"
                  />
                </div>

                {/* Active toggle */}
                <label className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all bg-slate-50 border-slate-200 hover:border-slate-300">
                  <div>
                    <p className="text-xs font-bold text-slate-700">เปิดใช้งานความสัมพันธ์นี้</p>
                    <p className="text-[10px] text-slate-400">ระบุการทำงานพ่วงแถมสินค้าแบบอัตโนมัติในใบเสนอราคา</p>
                  </div>
                  <div className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors ${isActive ? 'bg-[#009032]' : 'bg-slate-300'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-all ${isActive ? 'left-4' : 'left-0.5'}`} />
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={e => setIsActive(e.target.checked)}
                      className="sr-only"
                    />
                  </div>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-lg transition-all"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-5 py-2 text-xs font-bold text-white bg-[#009032] hover:bg-[#007b2b] rounded-lg transition-all active:scale-95 shadow-sm flex items-center gap-1.5"
                >
                  {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                  {editingLink ? 'บันทึกการแก้ไข' : 'บันทึกข้อมูล'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {isDeleteConfirmOpen && linkToDelete && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-sm shadow-2xl">
            <div className="p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3">
                <Trash2 className="w-6 h-6 text-red-500" />
              </div>
              <h3 className="font-bold text-slate-900 text-sm">ยืนยันการลบการจับคู่</h3>
              <p className="text-xs text-slate-500 mt-1">
                การลบคู่สินค้าของสินค้าหลัก <span className="font-bold text-slate-800">"{linkToDelete.trigger_model}"</span> และสินค้าเสริม <span className="font-bold text-slate-800">"{linkToDelete.optional_model}"</span> จะไม่สามารถกู้คืนได้ภายหลัง
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
              <button
                type="button"
                onClick={() => setIsDeleteConfirmOpen(false)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 border border-slate-200 hover:bg-slate-100 rounded-lg transition-all"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={isSaving}
                className="px-5 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-all active:scale-95 shadow-sm flex items-center gap-1.5"
              >
                {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                ยืนยันการลบ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
