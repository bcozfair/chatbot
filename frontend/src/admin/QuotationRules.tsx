import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  Plus,
  Search,
  Edit2,
  Trash2,
  FileText,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

// ── ComboBox ─────────────────────────────────────────────────────────────
function ComboBox({
  options,
  value,
  onChange,
  placeholder = 'ไม่ระบุ',
}: {
  options: string[];
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = query.trim()
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <div
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 w-full h-9 px-3 rounded-xl border text-sm cursor-pointer transition-all ${open
          ? 'border-[#009032] bg-white ring-2 ring-[#009032]/10'
          : value
            ? 'border-slate-300 bg-white'
            : 'border-slate-200 bg-slate-50 hover:border-slate-300'
          }`}
      >
        {open ? (
          <input
            autoFocus
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onClick={e => e.stopPropagation()}
            placeholder="พิมพ์เพื่อค้นหา..."
            className="flex-1 bg-transparent outline-none text-sm text-slate-800 placeholder:text-slate-400"
          />
        ) : (
          <span className={`flex-1 truncate ${value ? 'text-slate-800 font-medium' : 'text-slate-400'}`}>
            {value || placeholder}
          </span>
        )}
        <div className="flex items-center gap-1 flex-shrink-0">
          {value && !open && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onChange(''); setQuery(''); }}
              className="w-4 h-4 rounded-full bg-slate-200 hover:bg-slate-300 flex items-center justify-center transition-colors"
            >
              <X className="w-2.5 h-2.5 text-slate-500" />
            </button>
          )}
          <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-4 py-3 text-xs text-slate-400 text-center">ไม่พบผลลัพธ์</p>
            ) : (
              filtered.map(opt => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => { onChange(opt); setQuery(''); setOpen(false); }}
                  className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${opt === value
                    ? 'bg-emerald-50 text-[#009032] font-semibold'
                    : 'text-slate-700 hover:bg-slate-50'
                    }`}
                >
                  {opt}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface QuotationRule {
  id: number;
  production: string | null;
  brand: string | null;
  series: string | null;
  quote_company: 'PM' | 'THT' | null;
  warranty_years: number;
  warranty_unit: 'month' | 'year';
  is_locked: boolean;
  delivery_in_stock_days: number;
  delivery_out_of_stock_days: number;
  created_at: string;
  updated_at: string;
}

interface ProductRelation {
  production: string | null;
  brand: string | null;
  series: string | null;
}

interface RuleOptions {
  productions: string[];
  brands: string[];
  series: string[];
  relations?: ProductRelation[];
}

const EMPTY_RELATIONS: ProductRelation[] = [];
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function QuotationRules() {
  const { token } = useAuth();
  const [rules, setRules] = useState<QuotationRule[]>([]);
  const [options, setOptions] = useState<RuleOptions>({ productions: [], brands: [], series: [], relations: [] });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Modal & Form State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<QuotationRule | null>(null);
  const [formData, setFormData] = useState({
    production: '',
    brand: '',
    series: '',
    quote_company: '' as 'PM' | 'THT' | '',
    warranty_years: 1,
    warranty_unit: 'year' as 'month' | 'year',
    is_locked: false,
    delivery_in_stock_days: 3,
    delivery_out_of_stock_days: 7
  });

  const relations = options.relations || EMPTY_RELATIONS;

  const availableBrands = React.useMemo(() => {
    let brands = options.brands;
    if (formData.production) {
      const filtered = relations
        .filter(r => r.production === formData.production && r.brand)
        .map(r => r.brand as string);
      brands = Array.from(new Set(filtered)).sort();
    }

    const usedBrands = rules
      .filter(r =>
        (!editingRule || r.id !== editingRule.id) &&
        (r.production || null) === (formData.production || null) &&
        r.brand &&
        !r.series
      )
      .map(r => r.brand as string);

    return brands.filter(b => !usedBrands.includes(b));
  }, [formData.production, options.brands, relations, rules, editingRule]);

  const availableSeries = React.useMemo(() => {
    let filteredRelations = relations;
    if (formData.production) {
      filteredRelations = filteredRelations.filter(r => r.production === formData.production);
    }
    if (formData.brand) {
      filteredRelations = filteredRelations.filter(r => r.brand === formData.brand);
    }
    const filtered = filteredRelations
      .filter(r => r.series)
      .map(r => r.series as string);
    const uniqueSeries = Array.from(new Set(filtered)).sort();

    const usedSeries = rules
      .filter(r =>
        (!editingRule || r.id !== editingRule.id) &&
        (r.production || null) === (formData.production || null) &&
        (r.brand || null) === (formData.brand || null) &&
        r.series
      )
      .map(r => r.series as string);

    return uniqueSeries.filter(s => !usedSeries.includes(s));
  }, [formData.production, formData.brand, relations, rules, editingRule]);

  // Sorting State
  const [sortField, setSortField] = useState<keyof QuotationRule>('id');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchRules = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/quotation-rules', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('ไม่สามารถโหลดข้อมูลเงื่อนไขใบเสนอราคาได้');
      const data = await res.json();
      setRules(data);
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการโหลดข้อมูล');
    } finally {
      setLoading(false);
    }
  }, [token]);

  const fetchOptions = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/admin/quotation-rules/options', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setOptions(data);
      }
    } catch (err) {
      console.error('Error fetching rule options:', err);
    }
  }, [token]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRules();
      fetchOptions();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchRules, fetchOptions]);

  const handleSort = (field: keyof QuotationRule) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
    setCurrentPage(1);
  };

  const renderSortIcon = (field: keyof QuotationRule) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-3 h-3 text-slate-300 ml-1 inline-block opacity-65" />;
    }
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3 h-3 text-[#009032] ml-1 inline-block" />
      : <ArrowDown className="w-3 h-3 text-[#009032] ml-1 inline-block" />;
  };

  const openAddModal = () => {
    setEditingRule(null);
    setFormData({
      production: '',
      brand: '',
      series: '',
      quote_company: '',
      warranty_years: 1,
      warranty_unit: 'year',
      is_locked: false,
      delivery_in_stock_days: 3,
      delivery_out_of_stock_days: 7
    });
    setIsModalOpen(true);
  };

  const openEditModal = (rule: QuotationRule) => {
    setEditingRule(rule);
    setFormData({
      production: rule.production || '',
      brand: rule.brand || '',
      series: rule.series || '',
      quote_company: rule.quote_company || '',
      warranty_years: rule.warranty_years,
      warranty_unit: rule.warranty_unit || 'year',
      is_locked: rule.is_locked,
      delivery_in_stock_days: rule.delivery_in_stock_days,
      delivery_out_of_stock_days: rule.delivery_out_of_stock_days
    });
    setIsModalOpen(true);
  };

  const handleDeleteRule = async (id: number, label: string) => {
    if (!window.confirm(`คุณแน่ใจหรือไม่ที่จะลบเงื่อนไขสำหรับ "${label}"?`)) return;

    try {
      const res = await fetch(`/api/admin/quotation-rules/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'เกิดข้อผิดพลาดในการลบเงื่อนไข');
      showToast('ลบเงื่อนไขใบเสนอราคาสำเร็จ');
      fetchRules();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถลบเงื่อนไขได้', 'error');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.production && !formData.brand && !formData.series) {
      showToast('กรุณาระบุอย่างน้อย 1 ช่อง (ฝ่ายผลิต, ยี่ห้อ หรือซีรีส์)', 'error');
      return;
    }

    const requestData = {
      production: formData.production || null,
      brand: formData.brand || null,
      series: formData.series || null,
      quote_company: formData.quote_company || null,
      warranty_years: formData.warranty_years,
      warranty_unit: formData.warranty_unit,
      is_locked: formData.is_locked,
      delivery_in_stock_days: formData.delivery_in_stock_days,
      delivery_out_of_stock_days: formData.delivery_out_of_stock_days
    };

    try {
      const url = editingRule
        ? `/api/admin/quotation-rules/${editingRule.id}`
        : '/api/admin/quotation-rules';
      const method = editingRule ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(requestData)
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'เกิดข้อผิดพลาดในการบันทึกข้อมูล');

      showToast(editingRule ? 'แก้ไขข้อมูลสำเร็จ' : 'เพิ่มเงื่อนไขสำเร็จ');
      setIsModalOpen(false);
      fetchRules();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'บันทึกข้อมูลไม่สำเร็จ', 'error');
    }
  };

  const getRuleLabel = (rule: QuotationRule) => {
    if (rule.series) return `ยี่ห้อ ${rule.brand} ซีรีส์ ${rule.series}`;
    if (rule.brand) return `ยี่ห้อ ${rule.brand}`;
    return `ฝ่ายผลิต ${rule.production || 'ทั่วไป'}`;
  };

  const filteredRules = rules.filter((rule) => {
    const term = searchQuery.toLowerCase().trim();
    if (!term) return true;
    return (
      (rule.production && rule.production.toLowerCase().includes(term)) ||
      (rule.brand && rule.brand.toLowerCase().includes(term)) ||
      (rule.series && rule.series.toLowerCase().includes(term))
    );
  });

  const sortedRules = [...filteredRules].sort((a, b) => {
    const aValue = a[sortField];
    const bValue = b[sortField];

    if (aValue === null || aValue === undefined) return sortDirection === 'asc' ? 1 : -1;
    if (bValue === null || bValue === undefined) return sortDirection === 'asc' ? -1 : 1;

    if (typeof aValue === 'string' && typeof bValue === 'string') {
      return sortDirection === 'asc'
        ? aValue.localeCompare(bValue, 'th', { sensitivity: 'base' })
        : bValue.localeCompare(aValue, 'th', { sensitivity: 'base' });
    }

    if (typeof aValue === 'boolean' && typeof bValue === 'boolean') {
      return sortDirection === 'asc'
        ? (aValue === bValue ? 0 : aValue ? -1 : 1)
        : (aValue === bValue ? 0 : aValue ? 1 : -1);
    }

    return sortDirection === 'asc'
      ? (aValue > bValue ? 1 : -1)
      : (aValue < bValue ? 1 : -1);
  });

  // ── Pagination derived values ──────────────────────────────────────
  const totalItems = sortedRules.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const paginatedRules = sortedRules.slice(startIdx, startIdx + pageSize);
  const rangeStart = totalItems === 0 ? 0 : startIdx + 1;
  const rangeEnd = Math.min(startIdx + pageSize, totalItems);

  const pageNumbers = React.useMemo(() => {
    // Show up to 5 page buttons with ellipses for long lists
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
      {/* Toast Alert */}
      {toast && (
        <div
          id="toast-notification"
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl transition-all border animate-fade-in ${toast.type === 'success'
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

      {/* Compact single-row header */}
      <div className="bg-white border border-slate-200 rounded-2xl px-5 py-3.5 shadow-sm flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 flex-shrink-0">
          <FileText className="w-5 h-5 text-[#009032]" />
          <h2 className="text-base font-bold text-slate-900 whitespace-nowrap">เงื่อนไขใบเสนอราคา</h2>
          <span className="text-xs text-slate-400 hidden lg:inline">
            ตั้งค่าการรับประกัน/จัดส่งตามฝ่ายผลิต ยี่ห้อ หรือซีรีส์
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
            onClick={openAddModal}
            className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#009032] hover:bg-[#007b2b] text-white text-sm font-bold rounded-xl shadow-sm transition-all active:scale-95 flex-shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">เพิ่มเงื่อนไข</span>
          </button>
        </div>
      </div>

      {/* Loading & Empty States */}
      {loading ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-7 h-7 text-[#009032] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดข้อมูลเงื่อนไข...</p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-9 h-9 text-red-600" />
          <p className="font-bold">เกิดข้อผิดพลาดในการดึงข้อมูล</p>
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={fetchRules}
            className="mt-3 px-4 py-2 bg-white border border-red-200 text-red-700 hover:bg-red-50 rounded-xl text-xs font-semibold transition-all active:scale-95"
          >
            ลองใหม่อีกครั้ง
          </button>
        </div>
      ) : sortedRules.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm text-slate-500 flex flex-col items-center justify-center gap-2">
          <FileText className="w-9 h-9 text-slate-300" />
          <p className="font-bold">ไม่พบเงื่อนไขใบเสนอราคา</p>
          <p className="text-xs">ลองค้นหาด้วยคำอื่น หรือกดปุ่ม "เพิ่มเงื่อนไข" เพื่อเริ่มสร้างกฎ</p>
        </div>
      ) : (
        /* Rules Table */
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider select-none">
                  <th onClick={() => handleSort('production')} className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors w-40">
                    ฝ่ายผลิต {renderSortIcon('production')}
                  </th>
                  <th onClick={() => handleSort('brand')} className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors">
                    ยี่ห้อ / ซีรีส์ {renderSortIcon('brand')}
                  </th>
                  <th onClick={() => handleSort('quote_company')} className="px-4 py-3 text-center cursor-pointer hover:bg-slate-100 transition-colors w-32">
                    เสนอในนาม {renderSortIcon('quote_company')}
                  </th>
                  <th onClick={() => handleSort('warranty_years')} className="px-4 py-3 text-center cursor-pointer hover:bg-slate-100 transition-colors w-32">
                    รับประกัน {renderSortIcon('warranty_years')}
                  </th>
                  <th onClick={() => handleSort('delivery_in_stock_days')} className="px-4 py-3 text-center cursor-pointer hover:bg-slate-100 transition-colors w-36">
                    จัดส่ง (มีสต็อก) {renderSortIcon('delivery_in_stock_days')}
                  </th>
                  <th onClick={() => handleSort('delivery_out_of_stock_days')} className="px-4 py-3 text-center cursor-pointer hover:bg-slate-100 transition-colors w-40">
                    จัดส่ง (ไม่มีสต็อก) {renderSortIcon('delivery_out_of_stock_days')}
                  </th>
                  <th onClick={() => handleSort('is_locked')} className="px-4 py-3 text-center cursor-pointer hover:bg-slate-100 transition-colors w-28">
                    สถานะ {renderSortIcon('is_locked')}
                  </th>
                  <th className="px-4 py-3 text-center w-20">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                {paginatedRules.map((rule) => {
                  const label = getRuleLabel(rule);
                  return (
                    <tr key={rule.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-4 py-2.5 align-top">
                        <div className="font-semibold text-slate-900 text-[13px]">
                          {rule.production || '-'}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                          {rule.brand ? (
                            <span className="font-bold text-slate-950 text-[13px]">{rule.brand}</span>
                          ) : rule.series ? (
                            <span className="text-xs text-slate-400">(ไม่ระบุยี่ห้อ)</span>
                          ) : (
                            <span className="text-slate-400 text-xs italic">ปรับใช้กับทั้งฝ่ายผลิต</span>
                          )}
                          {rule.series && (
                            <span className="text-xs text-[#009032] font-semibold">· ซีรีส์ {rule.series}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-center align-top">
                        {rule.quote_company === 'PM' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 border border-emerald-200 text-emerald-700">
                            PM
                          </span>
                        ) : rule.quote_company === 'THT' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-orange-50 border border-orange-200 text-orange-700">
                            THT
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-50 border border-slate-200 text-slate-400 italic">
                            อัตโนมัติ
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center align-top">
                        {rule.is_locked ? (
                          <span className="text-slate-300 text-xs">—</span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 bg-sky-50 border border-sky-200 text-sky-700 rounded-full text-[11px] font-bold whitespace-nowrap">
                            {rule.warranty_years} {rule.warranty_unit === 'month' ? 'เดือน' : 'ปี'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center align-top font-mono text-[13px]">
                        {rule.is_locked ? (
                          <span className="text-slate-300 text-xs font-sans">—</span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            {rule.delivery_in_stock_days} วัน
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center align-top font-mono text-[13px]">
                        {rule.is_locked ? (
                          <span className="text-slate-300 text-xs font-sans">—</span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            {rule.delivery_out_of_stock_days} วัน
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center align-top">
                        {rule.is_locked ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 border border-red-200 text-red-700 rounded-full text-[10px] font-bold uppercase whitespace-nowrap">
                            <ShieldAlert className="w-3 h-3 text-red-500" />
                            บล็อก
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full text-[10px] font-semibold">
                            ปกติ
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openEditModal(rule)}
                            className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-900 rounded-lg transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteRule(rule.id, label)}
                            className="p-1.5 hover:bg-red-50 text-slate-500 hover:text-red-600 rounded-lg transition-colors"
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

      {/* Modal — redesigned for a tighter, easier-to-scan layout */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">

            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">
                  {editingRule ? 'แก้ไขเงื่อนไข' : 'เพิ่มเงื่อนไขใหม่'}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">ระบุอย่างน้อย 1 ช่องในขอบเขตเงื่อนไข</p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="w-7 h-7 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

                {/* ── Scope: production / brand / series in one row ── */}
                <section>
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                    ขอบเขตเงื่อนไข
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                        ฝ่ายผลิต
                      </label>
                      <ComboBox
                        options={options.productions}
                        value={formData.production}
                        onChange={val => {
                          const nextBrands = !val
                            ? options.brands
                            : Array.from(new Set(
                              relations
                                .filter(r => r.production === val && r.brand)
                                .map(r => r.brand as string)
                            )).sort();

                          const isBrandValid = formData.brand && nextBrands.includes(formData.brand);

                          setFormData(p => ({
                            ...p,
                            production: val,
                            brand: isBrandValid ? p.brand : '',
                            series: isBrandValid ? p.series : ''
                          }));
                        }}
                        placeholder="ทุกฝ่ายผลิต"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                        ยี่ห้อ
                      </label>
                      <ComboBox
                        options={availableBrands}
                        value={formData.brand}
                        onChange={val => {
                          let filteredRelations = relations;
                          if (formData.production) {
                            filteredRelations = filteredRelations.filter(r => r.production === formData.production);
                          }
                          if (val) {
                            filteredRelations = filteredRelations.filter(r => r.brand === val);
                          }
                          const nextSeries = Array.from(new Set(
                            filteredRelations.filter(r => r.series).map(r => r.series as string)
                          )).sort();

                          const isSeriesValid = formData.series && nextSeries.includes(formData.series);

                          setFormData(p => ({
                            ...p,
                            brand: val,
                            series: isSeriesValid ? p.series : ''
                          }));
                        }}
                        placeholder="ไม่ระบุ"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                        ซีรีส์
                      </label>
                      <ComboBox
                        options={availableSeries}
                        value={formData.series}
                        onChange={val => setFormData(p => ({ ...p, series: val }))}
                        placeholder="ไม่ระบุ"
                      />
                    </div>
                  </div>
                </section>

                {/* ── Quote company: compact segmented control ── */}
                <section className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50">
                  <div>
                    <p className="text-xs font-bold text-slate-700">เสนอในนาม</p>
                    <p className="text-[10px] text-slate-400">บริษัทที่ใช้ออกใบเสนอราคา</p>
                  </div>
                  <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-bold bg-white flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => setFormData(p => ({ ...p, quote_company: '' }))}
                      className={`px-2.5 h-8 transition-colors ${formData.quote_company === '' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
                    >
                      อัตโนมัติ
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData(p => ({ ...p, quote_company: 'PM' }))}
                      className={`px-3 h-8 transition-colors border-l border-slate-200 ${formData.quote_company === 'PM' ? 'bg-emerald-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
                    >
                      PM
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData(p => ({ ...p, quote_company: 'THT' }))}
                      className={`px-3 h-8 transition-colors border-l border-slate-200 ${formData.quote_company === 'THT' ? 'bg-orange-500 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
                    >
                      THT
                    </button>
                  </div>
                </section>

                {/* ── Lock toggle: compact single row ── */}
                <label
                  className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all ${formData.is_locked
                    ? 'bg-red-50 border-red-200'
                    : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                    }`}
                >
                  <div className="flex items-center gap-2.5">
                    <ShieldAlert className={`w-4 h-4 flex-shrink-0 ${formData.is_locked ? 'text-red-500' : 'text-slate-400'}`} />
                    <div>
                      <p className={`text-xs font-bold ${formData.is_locked ? 'text-red-700' : 'text-slate-700'}`}>
                        บล็อกห้ามเสนอราคา
                      </p>
                      <p className="text-[10px] text-slate-400">ห้ามออกใบเสนอราคาสินค้ากลุ่มนี้เด็ดขาด</p>
                    </div>
                  </div>
                  <div className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors ${formData.is_locked ? 'bg-red-500' : 'bg-slate-300'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-all ${formData.is_locked ? 'left-4' : 'left-0.5'}`} />
                    <input
                      type="checkbox"
                      checked={formData.is_locked}
                      onChange={e => setFormData(p => ({ ...p, is_locked: e.target.checked }))}
                      className="sr-only"
                    />
                  </div>
                </label>

                {/* ── Warranty + delivery: unified 3-column stat cards ── */}
                {!formData.is_locked && (
                  <section>
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                      เงื่อนไขใบเสนอราคา
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-2.5">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-sky-500 flex-shrink-0" />
                          <p className="text-[11px] font-semibold text-slate-600 whitespace-nowrap">รับประกัน</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="0"
                            max="999"
                            value={formData.warranty_years}
                            onChange={e => setFormData(p => ({ ...p, warranty_years: Math.max(0, parseInt(e.target.value) || 0) }))}
                            className="w-11 h-8 text-center text-xs font-bold bg-white border border-slate-200 rounded-lg outline-none focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 transition-all"
                          />
                          <select
                            value={formData.warranty_unit}
                            onChange={e => setFormData(p => ({ ...p, warranty_unit: e.target.value as 'month' | 'year' }))}
                            className="flex-1 h-8 px-1 text-[11px] font-bold bg-white border border-slate-200 rounded-lg outline-none focus:border-[#009032]"
                          >
                            <option value="year">ปี</option>
                            <option value="month">เดือน</option>
                          </select>
                        </div>
                      </div>

                      <div className="bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-2.5">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                          <p className="text-[11px] font-semibold text-slate-600 whitespace-nowrap">มีสต็อก</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="1"
                            max="365"
                            value={formData.delivery_in_stock_days}
                            onChange={e => setFormData(p => ({ ...p, delivery_in_stock_days: Math.max(1, parseInt(e.target.value) || 1) }))}
                            className="w-11 h-8 text-center text-xs font-bold bg-white border border-slate-200 rounded-lg outline-none focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 transition-all"
                          />
                          <span className="text-[11px] text-slate-500">วัน</span>
                        </div>
                      </div>

                      <div className="bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-2.5">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                          <p className="text-[11px] font-semibold text-slate-600 whitespace-nowrap">สต็อกไม่พอ</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="1"
                            max="365"
                            value={formData.delivery_out_of_stock_days}
                            onChange={e => setFormData(p => ({ ...p, delivery_out_of_stock_days: Math.max(1, parseInt(e.target.value) || 1) }))}
                            className="w-11 h-8 text-center text-xs font-bold bg-white border border-slate-200 rounded-lg outline-none focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 transition-all"
                          />
                          <span className="text-[11px] text-slate-500">วัน</span>
                        </div>
                      </div>
                    </div>
                  </section>
                )}
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
                  className="px-5 py-2 text-xs font-bold text-white bg-[#009032] hover:bg-[#007b2b] rounded-lg transition-all active:scale-95 shadow-sm"
                >
                  {editingRule ? 'บันทึกการแก้ไข' : 'เพิ่มเงื่อนไข'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}