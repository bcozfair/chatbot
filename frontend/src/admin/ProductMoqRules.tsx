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
  ShoppingCart,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface ProductMoqRule {
  product_id: number;
  min_order_qty: number;
  sale_line_warn_msg: string;
  is_active: boolean;
  model: string;
  name: string;
  created_at: string;
  updated_at: string;
  internal_reference: string;
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
  disabled?: boolean;
}

const ProductComboBox: React.FC<ProductComboBoxProps> = ({
  label,
  placeholder,
  value,
  onChange,
  error,
  disabled
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
            disabled
              ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
              : isOpen
              ? 'border-[#009032] bg-white ring-2 ring-[#009032]/10 shadow-sm'
              : error
              ? 'border-red-300 bg-red-50/10'
              : value
              ? 'border-slate-300 bg-white'
              : 'border-slate-200 bg-slate-50 hover:border-slate-300'
          }`}
          onClick={() => !disabled && setIsOpen(true)}
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
              disabled={disabled}
            />
          ) : (
            <span className={`flex-1 truncate ${value ? 'text-slate-800 font-semibold' : 'text-slate-400'}`}>
              {value ? `${value.internal_reference ? `[${value.internal_reference}] ` : ''}${value.model} - ${value.name}` : placeholder}
            </span>
          )}
          {value && !disabled && (
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

        {isOpen && !disabled && (
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

export const ProductMoqRules: React.FC = () => {
  const { token } = useAuth();
  const [rules, setRules] = useState<ProductMoqRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Sort State
  const [sortField, setSortField] = useState<string>('internal_reference');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Modal / Form States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [ruleToDelete, setRuleToDelete] = useState<ProductMoqRule | null>(null);
  const [editingRule, setEditingRule] = useState<ProductMoqRule | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Form Fields
  const [selectedProduct, setSelectedProduct] = useState<{ id: number; model: string; name: string; internal_reference?: string } | null>(null);
  const [minOrderQty, setMinOrderQty] = useState<number | ''>('');
  const [warnMsg, setWarnMsg] = useState('');
  const [isActive, setIsActive] = useState(true);

  // Fetch MOQ rules
  const fetchRules = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/moq-rules', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!response.ok) {
        throw new Error('ไม่สามารถโหลดข้อมูลกฎ MOQ สินค้าได้');
      }
      const data = await response.json();
      setRules(data);
    } catch (err: unknown) {
      console.error("Fetch MOQ rules error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
      setError(errMsg);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      const timer = setTimeout(() => {
        fetchRules();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [token, fetchRules]);

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
    setEditingRule(null);
    setFormError(null);
    setSelectedProduct(null);
    setMinOrderQty('');
    setWarnMsg('');
    setIsActive(true);
    setIsModalOpen(true);
  };

  // Open modal for Edit
  const handleEditOpen = (rule: ProductMoqRule) => {
    setEditingRule(rule);
    setFormError(null);
    setSelectedProduct({
      id: rule.product_id,
      model: rule.model,
      name: rule.name,
      internal_reference: rule.internal_reference
    });
    setMinOrderQty(rule.min_order_qty);
    setWarnMsg(rule.sale_line_warn_msg);
    setIsActive(rule.is_active);
    setIsModalOpen(true);
  };

  // Open delete confirmation
  const handleDeleteOpen = (rule: ProductMoqRule) => {
    setRuleToDelete(rule);
    setIsDeleteConfirmOpen(true);
  };

  // Form Submit (Create or Update)
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct || minOrderQty === '' || !warnMsg.trim()) {
      setFormError('กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน');
      return;
    }
    if (Number(minOrderQty) <= 0) {
      setFormError('จำนวนสั่งซื้อขั้นต่ำ (MOQ) ต้องมีค่ามากกว่า 0');
      return;
    }
    if (!selectedProduct.internal_reference || selectedProduct.internal_reference.trim() === '' || selectedProduct.internal_reference === 'N/A') {
      setFormError('สินค้านี้ไม่มีรหัสอ้างอิงภายใน (Internal Reference) ที่ถูกต้อง ไม่สามารถตั้งกฎ MOQ ได้');
      return;
    }

    setFormError(null);
    setIsSaving(true);

    const payload = {
      internal_reference: selectedProduct.internal_reference,
      min_order_qty: Number(minOrderQty),
      sale_line_warn_msg: warnMsg.trim(),
      is_active: isActive
    };

    try {
      const url = editingRule 
        ? `/api/admin/moq-rules/${editingRule.internal_reference}` 
        : '/api/admin/moq-rules';
      
      const method = editingRule ? 'PUT' : 'POST';

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
      showToast(editingRule ? 'แก้ไขข้อมูลกฎ MOQ สำเร็จ' : 'สร้างกฎ MOQ สำหรับสินค้าสำเร็จ');
      fetchRules();
    } catch (err: unknown) {
      console.error("Save MOQ rule error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการบันทึกข้อมูล';
      setFormError(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  // Confirm delete
  const handleDeleteConfirm = async () => {
    if (!ruleToDelete) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/admin/moq-rules/${ruleToDelete.internal_reference}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'ไม่สามารถลบกฎนี้ได้');
      }

      setIsDeleteConfirmOpen(false);
      setRuleToDelete(null);
      showToast('ลบกฎ MOQ สินค้าสำเร็จเรียบร้อย');
      fetchRules();
    } catch (err: unknown) {
      console.error("Delete MOQ rule error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการลบข้อมูล';
      setError(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  // Toggle active status directly
  const handleToggleActive = async (rule: ProductMoqRule) => {
    try {
      const response = await fetch(`/api/admin/moq-rules/${rule.internal_reference}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          min_order_qty: rule.min_order_qty,
          sale_line_warn_msg: rule.sale_line_warn_msg,
          is_active: !rule.is_active
        })
      });

      if (!response.ok) {
        throw new Error('ไม่สามารถแก้ไขสถานะการใช้งานได้');
      }

      setRules(prev => prev.map(r => r.internal_reference === rule.internal_reference ? { ...r, is_active: !r.is_active } : r));
      showToast(`แก้ไขสถานะกฎ MOQ ของรุ่น "${rule.model}" สำเร็จ`);
    } catch (err: unknown) {
      console.error("Toggle active MOQ error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการแก้ไขสถานะ';
      setError(errMsg);
    }
  };

  // Filter and Sort rules
  const filteredRules = rules.filter(rule => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      rule.model.toLowerCase().includes(q) ||
      rule.name.toLowerCase().includes(q) ||
      (rule.internal_reference && rule.internal_reference.toLowerCase().includes(q)) ||
      rule.sale_line_warn_msg.toLowerCase().includes(q)
    );
  });

  const sortedRules = [...filteredRules].sort((a, b) => {
    let aVal: string | number = '';
    let bVal: string | number = '';

    if (sortField === 'internal_reference') {
      aVal = a.internal_reference || '';
      bVal = b.internal_reference || '';
    } else if (sortField === 'model') {
      aVal = a.model;
      bVal = b.model;
    } else if (sortField === 'name') {
      aVal = a.name;
      bVal = b.name;
    } else if (sortField === 'moq') {
      aVal = a.min_order_qty;
      bVal = b.min_order_qty;
    } else if (sortField === 'warn_msg') {
      aVal = a.sale_line_warn_msg;
      bVal = b.sale_line_warn_msg;
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
  const totalItems = sortedRules.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const paginatedRules = sortedRules.slice(startIdx, startIdx + pageSize);
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
          <ShoppingCart className="w-5 h-5 text-[#009032]" />
          <h2 className="text-base font-bold text-slate-900 whitespace-nowrap">กฎสั่งซื้อขั้นต่ำรายสินค้า (MOQ)</h2>
          <span className="text-xs text-slate-400 hidden lg:inline">
            กำหนดจำนวนขั้นต่ำและข้อความเตือนรายชิ้น
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
            <span className="hidden sm:inline">สร้างกฎใหม่</span>
          </button>
        </div>
      </div>

      {/* Loading & Empty States */}
      {isLoading ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-7 h-7 text-[#009032] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดกฎสั่งซื้อขั้นต่ำ MOQ...</p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-9 h-9 text-red-600" />
          <p className="font-bold">เกิดข้อผิดพลาดในการดึงข้อมูล</p>
          <p className="text-sm text-red-600">{error}</p>
        </div>
      ) : sortedRules.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm text-slate-500 flex flex-col items-center justify-center gap-2">
          <ShoppingCart className="w-9 h-9 text-slate-300" />
          <p className="font-bold">ไม่พบกฎ MOQ ของสินค้า</p>
          <p className="text-xs">สินค้าที่ไม่มีในตารางนี้จะสามารถสั่งซื้อในจำนวนเท่าใดก็ได้ตามปกติ</p>
        </div>
      ) : (
        /* Rules Table */
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider select-none">
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('internal_reference')}>
                    รหัส (Internal Ref.) {renderSortIcon('internal_reference')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('name')}>
                    ชื่อสินค้า {renderSortIcon('name')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors text-center w-36" onClick={() => handleSort('moq')}>
                    ขั้นต่ำ (MOQ) {renderSortIcon('moq')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors text-center" onClick={() => handleSort('warn_msg')}>
                    ข้อความแจ้งเตือน {renderSortIcon('warn_msg')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors text-center w-28" onClick={() => handleSort('is_active')}>
                    สถานะ {renderSortIcon('is_active')}
                  </th>
                  <th className="px-4 py-3 text-center w-20">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                {paginatedRules.map((rule) => (
                  <tr key={rule.internal_reference} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-4 py-2.5 font-mono font-bold text-slate-800">{rule.internal_reference}</td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="font-semibold text-slate-900 text-[13px] font-mono">{rule.model}</div>
                      <div className="text-[11px] text-slate-500 line-clamp-1">{rule.name}</div>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="inline-flex items-center px-2.5 py-0.5 bg-sky-50 border border-sky-200 text-sky-700 rounded-full text-[11px] font-bold whitespace-nowrap">
                        {rule.min_order_qty.toLocaleString()} ชิ้น
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className="inline-block px-2 py-0.5 bg-yellow-50 border border-yellow-200 text-yellow-800 text-[11px] font-semibold rounded-full max-w-[220px] truncate" title={rule.sale_line_warn_msg}>
                        {rule.sale_line_warn_msg}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => handleToggleActive(rule)}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-all ${
                          rule.is_active
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-slate-50 border-slate-200 text-slate-400'
                        }`}
                      >
                        {rule.is_active ? 'เปิด' : 'ปิด'}
                      </button>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => handleEditOpen(rule)}
                          className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-900 rounded-lg transition-colors"
                          title="แก้ไขข้อมูลกฎ MOQ"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteOpen(rule)}
                          className="p-1.5 hover:bg-red-50 text-slate-500 hover:text-red-600 rounded-lg transition-colors"
                          title="ลบกฎ MOQ"
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
                  {editingRule ? 'แก้ไขกฎ MOQ รายสินค้า' : 'สร้างกฎ MOQ สินค้าใหม่'}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">กำหนดจำนวนสั่งซื้อขั้นต่ำและข้อความเตือน</p>
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

                {/* Product ComboBox */}
                <ProductComboBox
                  label="เลือกสินค้าที่จะกำหนดขั้นต่ำ (MOQ)"
                  placeholder={editingRule ? "รุ่นสินค้าเป้าหมาย" : "เลือกสินค้าเป้าหมาย..."}
                  value={selectedProduct}
                  onChange={setSelectedProduct}
                  error={!!formError && !selectedProduct}
                  disabled={!!editingRule}
                />

                {/* MOQ Quantity Input */}
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                    จำนวนสั่งซื้อขั้นต่ำ (Minimum Order Quantity)
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={minOrderQty}
                    onChange={(e) => setMinOrderQty(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="เช่น 10, 50, 100..."
                    className="w-full h-9 px-3 bg-white border border-slate-200 focus:border-[#009032] rounded-xl text-sm text-slate-800 outline-none transition-all focus:ring-2 focus:ring-[#009032]/10"
                  />
                </div>

                {/* Warning message text input */}
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                    ข้อความเตือนเมื่อสั่งซื้อไม่ถึงขั้นต่ำ (Warning Message)
                  </label>
                  <input
                    type="text"
                    value={warnMsg}
                    onChange={(e) => setWarnMsg(e.target.value)}
                    placeholder="เช่น *** สั่งซื้อขั้นต่ำ 10 ชิ้นขึ้นไป ***"
                    className="w-full h-9 px-3 bg-white border border-slate-200 focus:border-[#009032] rounded-xl text-sm text-slate-800 outline-none transition-all focus:ring-2 focus:ring-[#009032]/10"
                  />
                </div>

                {/* Active toggle */}
                <label className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all bg-slate-50 border-slate-200 hover:border-slate-300">
                  <div>
                    <p className="text-xs font-bold text-slate-700">สถานะเปิดใช้งานกฎนี้</p>
                    <p className="text-[10px] text-slate-400">บอท LINE จะปฏิเสธการเสนอขายหากสั่งสินค้าชิ้นนี้ต่ำกว่าขั้นต่ำ</p>
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
                  {editingRule ? 'บันทึกการแก้ไข' : 'บันทึกข้อมูล'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {isDeleteConfirmOpen && ruleToDelete && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-sm shadow-2xl">
            <div className="p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3">
                <Trash2 className="w-6 h-6 text-red-500" />
              </div>
              <h3 className="font-bold text-slate-900 text-sm">ยืนยันการลบกฎ MOQ</h3>
              <p className="text-xs text-slate-500 mt-1">
                ต้องการลบกฎสั่งซื้อขั้นต่ำของสินค้า <span className="font-bold text-slate-800">"{ruleToDelete.model}"</span> หรือไม่?
                การลบจะทำให้เซลส์ทำรายการสินค้านี้ในจำนวนใดก็ได้ตามปกติโดยไม่มีขั้นต่ำกำกับ
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
