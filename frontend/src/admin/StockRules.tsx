import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  Plus,
  Search,
  Trash2,
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface ProductStockRule {
  product_id: number;
  is_active: boolean;
  model: string;
  name: string;
  actual_quantity?: number;
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
  brand?: string;
}

// Product Multi-Select Component with Search by Brand and Select All
interface ProductMultiSelectProps {
  label: string;
  placeholder: string;
  selectedProducts: Array<{ id: number; model: string; name: string; internal_reference?: string; brand?: string }>;
  onChange: (vals: Array<{ id: number; model: string; name: string; internal_reference?: string; brand?: string }>) => void;
  existingReferences: string[];
  error?: boolean;
  disabled?: boolean;
}

const ProductMultiSelect: React.FC<ProductMultiSelectProps> = ({
  label,
  placeholder,
  selectedProducts,
  onChange,
  existingReferences,
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
        const resp = await fetch(`/api/products/search?q=${encodeURIComponent(query)}&limit=250`);
        if (resp.ok) {
          const data = await resp.json();
          setResults(data);
        }
      } catch (err) {
        console.error("Product search error in MultiSelect:", err);
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [query, results.length]);

  const handleToggleProduct = (prod: ProductSearchResult) => {
    const isSelected = selectedProducts.some(p => p.id === prod.product_id);
    if (isSelected) {
      onChange(selectedProducts.filter(p => p.id !== prod.product_id));
    } else {
      onChange([...selectedProducts, {
        id: prod.product_id,
        model: prod.model,
        name: prod.name,
        internal_reference: prod.internal_reference,
        brand: prod.brand
      }]);
    }
  };

  const handleSelectAllResults = () => {
    const validResults = results.filter(prod => {
      const hasValidRef = prod.internal_reference && prod.internal_reference.trim() !== '' && prod.internal_reference !== 'N/A';
      const isAlreadyConfigured = prod.internal_reference ? existingReferences.includes(prod.internal_reference) : false;
      return hasValidRef && !isAlreadyConfigured;
    });

    const newSelections = [...selectedProducts];
    validResults.forEach(prod => {
      if (!newSelections.some(p => p.id === prod.product_id)) {
        newSelections.push({
          id: prod.product_id,
          model: prod.model,
          name: prod.name,
          internal_reference: prod.internal_reference,
          brand: prod.brand
        });
      }
    });
    onChange(newSelections);
  };

  const handleRemoveProduct = (productId: number) => {
    onChange(selectedProducts.filter(p => p.id !== productId));
  };

  const handleClearAll = () => {
    onChange([]);
  };

  const validResults = results.filter(prod => {
    const hasValidRef = prod.internal_reference && prod.internal_reference.trim() !== '' && prod.internal_reference !== 'N/A';
    const isAlreadyConfigured = prod.internal_reference ? existingReferences.includes(prod.internal_reference) : false;
    return hasValidRef && !isAlreadyConfigured;
  });
  const isAllResultsSelected = validResults.length > 0 && validResults.every(prod => selectedProducts.some(p => p.id === prod.product_id));

  return (
    <div className="space-y-1.5" ref={dropdownRef}>
      <div className="flex items-center justify-between">
        <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">
          {label}
        </label>
        {selectedProducts.length > 0 && (
          <button
            type="button"
            onClick={handleClearAll}
            className="text-[11px] font-semibold text-red-500 hover:text-red-700 transition-colors"
          >
            ล้างทั้งหมด ({selectedProducts.length})
          </button>
        )}
      </div>

      <div className="relative">
        <div
          className={`flex flex-wrap items-center gap-2 w-full min-h-[44px] p-2 rounded-xl border text-sm transition-all ${disabled
              ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
              : isOpen
                ? 'border-[#009032] bg-white ring-2 ring-[#009032]/10 shadow-sm'
                : error
                  ? 'border-red-300 bg-red-50/10'
                  : selectedProducts.length > 0
                    ? 'border-slate-300 bg-white'
                    : 'border-slate-200 bg-slate-55 hover:border-slate-300'
            }`}
          onClick={() => !disabled && setIsOpen(true)}
        >
          <Search className="w-4 h-4 text-slate-400 flex-shrink-0 ml-1.5" />

          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIsOpen(true);
            }}
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(true);
            }}
            placeholder={selectedProducts.length > 0 ? '' : placeholder}
            className="flex-1 min-w-[120px] bg-transparent outline-none text-sm text-slate-800 placeholder:text-slate-400"
            disabled={disabled}
          />
        </div>

        {isOpen && !disabled && (
          <div className="absolute z-50 mt-1.5 w-full bg-white border border-slate-200 rounded-xl shadow-xl max-h-72 overflow-hidden flex flex-col">
            {results.length > 0 && (
              <div className="p-2 bg-slate-50 flex items-center justify-between text-xs border-b border-slate-150 flex-shrink-0">
                <span className="text-slate-500 font-medium">พบ {results.length} รายการ</span>
                <button
                  type="button"
                  onClick={handleSelectAllResults}
                  disabled={isAllResultsSelected || validResults.length === 0}
                  className={`px-2 py-1 rounded font-semibold transition-colors ${isAllResultsSelected || validResults.length === 0
                      ? 'text-slate-400 bg-slate-100 cursor-not-allowed'
                      : 'text-white bg-[#009032] hover:bg-emerald-700'
                    }`}
                >
                  {isAllResultsSelected ? 'เลือกทั้งหมดแล้ว' : 'เลือกทั้งหมดในผลลัพธ์'}
                </button>
              </div>
            )}

            <div className="overflow-y-auto max-h-56 divide-y divide-slate-100">
              {isLoading ? (
                <div className="p-4 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 text-[#009032] animate-spin" />
                  กำลังค้นหา...
                </div>
              ) : results.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400">
                  {query.trim() ? 'ไม่พบสินค้าในระบบ' : 'พิมพ์รหัส, รุ่น หรือแบรนด์เพื่อเริ่มค้นหา'}
                </div>
              ) : (
                results.map((prod) => {
                  const isSelected = selectedProducts.some(p => p.id === prod.product_id);
                  const isAlreadyConfigured = prod.internal_reference ? existingReferences.includes(prod.internal_reference) : false;
                  const hasValidRef = prod.internal_reference && prod.internal_reference.trim() !== '' && prod.internal_reference !== 'N/A';
                  const isChecked = isSelected || isAlreadyConfigured;
                  const isDisabled = !hasValidRef || isAlreadyConfigured;

                  return (
                    <button
                      key={prod.product_id}
                      type="button"
                      disabled={isDisabled}
                      onClick={() => handleToggleProduct(prod)}
                      className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 transition-colors flex items-center justify-between gap-3 ${isDisabled ? 'opacity-60 cursor-not-allowed bg-slate-55' : ''
                        }`}
                    >
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {prod.brand && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-700 border border-slate-200 uppercase">
                              {prod.brand}
                            </span>
                          )}
                          <span className="font-bold text-slate-800 text-xs font-mono">
                            {prod.internal_reference ? `[${prod.internal_reference}] ` : ''}{prod.model}
                          </span>
                          {isAlreadyConfigured && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                              ตั้งกฎแล้ว
                            </span>
                          )}
                        </div>
                        <span className="text-slate-500 line-clamp-1">{prod.name}</span>
                        {!hasValidRef && (
                          <span className="text-red-500 text-[10px] font-semibold mt-0.5">
                            * ไม่มีรหัสอ้างอิงภายใน (Internal Ref.)
                          </span>
                        )}
                      </div>
                      <div className="flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          readOnly
                          disabled={isDisabled}
                          className="w-4 h-4 rounded border-slate-300 text-[#009032] focus:ring-[#009032]/20"
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* Selected Products Tags Chips */}
      {selectedProducts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-2 bg-slate-50/50 border border-slate-200 rounded-xl">
          {selectedProducts.map(prod => (
            <div
              key={prod.id}
              className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-800 border border-emerald-100/50 px-2 py-1 rounded-lg text-xs"
            >
              <div className="flex flex-col text-[10px] leading-tight">
                <span className="font-bold font-mono text-emerald-950 truncate max-w-[150px]">
                  {prod.internal_reference ? `[${prod.internal_reference}] ` : ''}{prod.model}
                </span>
                {prod.brand && <span className="opacity-70 text-[8px] font-semibold uppercase">{prod.brand}</span>}
              </div>
              <button
                type="button"
                onClick={() => handleRemoveProduct(prod.id)}
                className="w-4 h-4 rounded-full hover:bg-emerald-150 flex items-center justify-center text-emerald-600 hover:text-emerald-800 transition-colors ml-1"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const StockRules: React.FC = () => {
  const { token } = useAuth();
  const [rules, setRules] = useState<ProductStockRule[]>([]);
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
  const [ruleToDelete, setRuleToDelete] = useState<ProductStockRule | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Form Fields
  const [selectedProducts, setSelectedProducts] = useState<Array<{ id: number; model: string; name: string; internal_reference?: string; brand?: string }>>([]);
  const [isActive, setIsActive] = useState(true);

  // Fetch stock rules
  const fetchRules = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/stock-rules', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!response.ok) {
        throw new Error('ไม่สามารถโหลดข้อมูลกฎสินค้าหมดสต็อกได้');
      }
      const data = await response.json();
      setRules(data);
    } catch (err: unknown) {
      console.error("Fetch stock rules error:", err);
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
    setFormError(null);
    setSelectedProducts([]);
    setIsActive(true);
    setIsModalOpen(true);
  };

  // Open delete confirmation
  const handleDeleteOpen = (rule: ProductStockRule) => {
    setRuleToDelete(rule);
    setIsDeleteConfirmOpen(true);
  };

  // Form Submit (Create or Update)
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedProducts.length === 0) {
      setFormError('กรุณาเลือกสินค้าอย่างน้อย 1 รายการ');
      return;
    }

    const validReferences = selectedProducts
      .map(p => p.internal_reference)
      .filter((ref): ref is string => !!ref && ref.trim() !== '' && ref !== 'N/A');

    if (validReferences.length === 0) {
      setFormError('สินค้าที่เลือกไม่มีรหัสอ้างอิงภายใน (Internal Reference) ที่ถูกต้อง');
      return;
    }

    setFormError(null);
    setIsSaving(true);

    const payload = {
      internal_references: validReferences,
      is_active: isActive
    };

    try {
      const url = '/api/admin/stock-rules';
      const method = 'POST';

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
      showToast(`สร้างกฎสต็อกใหม่สำหรับสินค้า ${validReferences.length} รายการสำเร็จ`);
      fetchRules();
    } catch (err: unknown) {
      console.error("Save stock rule error:", err);
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
      const response = await fetch(`/api/admin/stock-rules/${ruleToDelete.internal_reference}`, {
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
      showToast('ลบกฎระงับเสนอขายสต็อกสำเร็จเรียบร้อย');
      fetchRules();
    } catch (err: unknown) {
      console.error("Delete stock rule error:", err);
      const errMsg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการลบข้อมูล';
      setError(errMsg);
    } finally {
      setIsSaving(false);
    }
  };

  // Toggle active status directly
  const handleToggleActive = async (rule: ProductStockRule) => {
    try {
      const response = await fetch(`/api/admin/stock-rules/${rule.internal_reference}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          is_active: !rule.is_active
        })
      });

      if (!response.ok) {
        throw new Error('ไม่สามารถแก้ไขสถานะการใช้งานได้');
      }

      setRules(prev => prev.map(r => r.internal_reference === rule.internal_reference ? { ...r, is_active: !r.is_active } : r));
      showToast(`แก้ไขสถานะกฎของรุ่น "${rule.model}" สำเร็จ`);
    } catch (err: unknown) {
      console.error("Toggle active error:", err);
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
      (rule.internal_reference && rule.internal_reference.toLowerCase().includes(q))
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
          <ShieldAlert className="w-5 h-5 text-[#009032]" />
          <h2 className="text-base font-bold text-slate-900 whitespace-nowrap">กฎระงับเสนอขายสต็อกหมด</h2>
          <span className="text-xs text-slate-400 hidden lg:inline">
            ป้องกันการเสนอขายสินค้าที่สต็อกหมดหรือติดลบ
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
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดกฎสินค้าหมดสต็อก...</p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-9 h-9 text-red-600" />
          <p className="font-bold">เกิดข้อผิดพลาดในการดึงข้อมูล</p>
          <p className="text-sm text-red-600">{error}</p>
        </div>
      ) : sortedRules.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm text-slate-500 flex flex-col items-center justify-center gap-2">
          <ShieldAlert className="w-9 h-9 text-slate-300" />
          <p className="font-bold">ไม่พบกฎระงับเสนอขายสินค้าสต็อก</p>
          <p className="text-xs">สินค้าที่ไม่อยู่ในตารางนี้ เซลส์จะสามารถเสนอราคาได้ปกติแม้สต็อกหมด</p>
        </div>
      ) : (
        /* Rules Table */
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider select-none">
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('internal_reference')}>
                    รหัสสินค้า (Internal Ref.) {renderSortIcon('internal_reference')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('model')}>
                    รหัสรุ่น (Model) {renderSortIcon('model')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('name')}>
                    ชื่อสินค้า {renderSortIcon('name')}
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
                    <td className="px-4 py-2.5 font-bold text-slate-800 font-mono">{rule.model}</td>
                    <td className="px-4 py-2.5 text-slate-600 line-clamp-1">{rule.name}</td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => handleToggleActive(rule)}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-all ${rule.is_active
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
                          onClick={() => handleDeleteOpen(rule)}
                          className="p-1.5 hover:bg-red-50 text-slate-500 hover:text-red-600 rounded-lg transition-colors"
                          title="ลบกฎระงับ"
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

      {/* Create Modal Form */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">

            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">สร้างกฎระงับเสนอราคาใหม่</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">เลือกสินค้าที่จะถูกระงับเมื่อสต็อกหมด</p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="w-7 h-7 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="flex flex-col flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-[360px]">
                {formError && (
                  <div className="bg-red-50 border border-red-100 text-red-700 p-3.5 rounded-xl flex items-start gap-2.5 text-xs">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{formError}</span>
                  </div>
                )}

                {/* Product MultiSelect */}
                <ProductMultiSelect
                  label="เลือกสินค้าหมดสต็อกที่จะทำกฎ"
                  placeholder="พิมพ์รุ่น, ชื่อสินค้า หรือแบรนด์เพื่อค้นหา..."
                  selectedProducts={selectedProducts}
                  onChange={setSelectedProducts}
                  existingReferences={rules.map(r => r.internal_reference).filter(Boolean)}
                  error={!!formError && selectedProducts.length === 0}
                />

                {/* Active toggle */}
                <label className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all bg-slate-50 border-slate-200 hover:border-slate-300">
                  <div>
                    <p className="text-xs font-bold text-slate-700">สถานะเปิดใช้งานกฎนี้</p>
                    <p className="text-[10px] text-slate-400">หากเปิดไว้ บอท LINE จะปฏิเสธการเซฟใบเสนอราคาหากสินค้านี้หมด</p>
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
                  บันทึกข้อมูล
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
              <h3 className="font-bold text-slate-900 text-sm">ยืนยันการลบกฎระงับสต็อก</h3>
              <p className="text-xs text-slate-500 mt-1">
                ต้องการลบกฎระงับเสนอขายของสินค้า <span className="font-bold text-slate-800">"{ruleToDelete.model}"</span> หรือไม่?
                การลบจะทำให้เซลส์กลับมาทำใบเสนอราคาสินค้านี้ได้ตามปกติ
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
