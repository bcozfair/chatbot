import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  FileText,
  Search,
  Download,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Filter,
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  Calendar,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown
} from 'lucide-react';

interface QuotationItem {
  model?: string;
  product_code?: string;
  name?: string;
  quantity?: number;
  price?: number;
  discount_1?: number;
  discount_2?: number;
  stock?: number;
}

interface Quotation {
  id: string;
  quotation_no: string | null;
  status: string;
  customer_name: string;
  company_name?: string;
  customer_id: number | null;
  contact_id: number | null;
  customer_code: string;
  customer_tax_id: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  contact_address: string;
  salesperson_name: string;
  salesperson_phone: string;
  salesperson_employee_code: string | null;
  total_sum: number;
  items: QuotationItem[];
  user_id: string;
  created_at: string;
  updated_at: string;
  customer_details?: {
    customer_name: string;
    customer_code: string;
    customer_tax_id: string;
    contact_name: string;
    phone: string;
    email: string;
    address: string;
    payment_terms: string;
    revise_from: string | null;
    custom_meta: string;
  };
  item_details?: Record<string, unknown>[];
  salesperson_id?: string | null;
  employee_details?: {
    salesperson_id: string | null;
    saleperson: string;
    sale_phone: string;
  };
}

interface QuotationListResponse {
  data: Quotation[];
  total: number;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

// Status color mapping
const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700', label: 'ร่าง' },
  pending_company: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', label: 'รอเลือกบริษัท' },
  pending_contact: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', label: 'รอเลือกผู้ติดต่อ' },
  confirmed: { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', label: 'ยืนยันแล้ว' },
  cancelled: { bg: 'bg-red-50 border-red-200', text: 'text-red-500', label: 'ยกเลิก' },
};

function getStatusStyle(status: string) {
  return STATUS_STYLES[status] || { bg: 'bg-slate-50 border-slate-200', text: 'text-slate-600', label: status };
}

function formatNumber(num: number) {
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString('th-TH', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const Quotations: React.FC = () => {
  const { token } = useAuth();

  // Data state
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
    setCurrentPage(1);
  };

  const renderSortIcon = (field: string) => {
    if (sortBy !== field) {
      return <ArrowUpDown className="w-3.5 h-3.5 text-slate-300 ml-1.5 inline-block" />;
    }
    return sortOrder === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-[#009032] ml-1.5 inline-block font-bold" />
      : <ArrowDown className="w-3.5 h-3.5 text-[#009032] ml-1.5 inline-block font-bold" />;
  };

  // Expanded row (show items detail)
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchQuotations = useCallback(async (resetPage = false) => {
    setIsLoading(true);
    setError(null);

    const pageIndex = resetPage ? 1 : currentPage;
    if (resetPage) setCurrentPage(1);

    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      params.set('limit', String(pageSize));
      params.set('offset', String((pageIndex - 1) * pageSize));

      const response = await fetch(`/api/admin/quotations?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) throw new Error('ไม่สามารถดึงข้อมูลใบเสนอราคาได้');

      const result: QuotationListResponse = await response.json();
      setQuotations(result.data);
      setTotal(result.total);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
      console.error(err);
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [token, searchQuery, statusFilter, dateFrom, dateTo, currentPage, pageSize, sortBy, sortOrder]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchQuotations();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchQuotations]);

  const handleExportCSV = async () => {
    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);

      const response = await fetch(`/api/admin/quotations/export?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) throw new Error('ไม่สามารถส่งออกข้อมูลได้');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quotations_export_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      showToast('ส่งออกข้อมูล CSV สำเร็จเรียบร้อย');
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการส่งออกข้อมูล';
      setError(errorMessage);
    }
  };

  const showToast = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // Pagination derived values
  const totalItems = total;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const rangeStart = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, totalItems);

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
      {/* Success Toast */}
      {successMsg && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 bg-white border border-slate-200 border-l-4 border-l-[#009032] p-4 rounded-2xl shadow-xl shadow-slate-200/50 text-slate-800 text-sm animate-fade-in">
          <CheckCircle2 className="w-5 h-5 text-[#009032]" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Compact single-row header + filters */}
      <div className="bg-white border border-slate-200 rounded-2xl px-5 py-3.5 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 flex-shrink-0">
            <FileText className="w-5 h-5 text-[#009032]" />
            <h2 className="text-base font-bold text-slate-900 whitespace-nowrap">ประวัติใบเสนอราคา</h2>
            <span className="text-xs text-slate-400 hidden lg:inline">
              ค้นหา ดูข้อมูล และส่งออกใบเสนอราคาทั้งหมดในระบบ
            </span>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              onClick={handleExportCSV}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#009032] hover:bg-[#007b2b] text-white text-sm font-bold rounded-xl shadow-sm transition-all active:scale-95 flex-shrink-0"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span className="hidden sm:inline">ส่งออก CSV</span>
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-4 border-t border-slate-100">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              id="quotation-search-input"
              type="text"
              placeholder="ค้นหาเลขที่, ชื่อลูกค้า, ชื่อพนักงาน..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              className="w-full bg-white border border-slate-200 focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 focus:outline-none rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 transition-all"
            />
          </div>

          {/* Status Filter */}
          <div className="relative">
            <select
              id="quotation-status-filter"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
              className="w-full bg-white border border-slate-200 focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 focus:outline-none rounded-xl px-4 py-2.5 text-sm text-slate-800 transition-all appearance-none cursor-pointer"
            >
              <option value="">สถานะทั้งหมด</option>
              <option value="draft">ร่าง</option>
              <option value="pending_company">รอเลือกบริษัท</option>
              <option value="pending_contact">รอเลือกผู้ติดต่อ</option>
              <option value="confirmed">ยืนยันแล้ว</option>
              <option value="cancelled">ยกเลิก</option>
            </select>
            <Filter className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>

          {/* Date From */}
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setCurrentPage(1); }}
              className="w-full bg-white border border-slate-200 focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 focus:outline-none rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 transition-all"
            />
          </div>

          {/* Date To */}
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setCurrentPage(1); }}
              className="w-full bg-white border border-slate-200 focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 focus:outline-none rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 transition-all"
            />
          </div>
        </div>

        {/* Clear Filters */}
        {(searchQuery || statusFilter || dateFrom || dateTo) && (
          <button
            onClick={() => {
              setSearchQuery('');
              setStatusFilter('');
              setDateFrom('');
              setDateTo('');
              setCurrentPage(1);
            }}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-600 transition-colors font-semibold"
          >
            <X className="w-3.5 h-3.5" />
            ล้างตัวกรองทั้งหมด
          </button>
        )}
      </div>

      {/* Error Alert */}
      {error && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-100 p-4 rounded-2xl text-red-800 text-sm shadow-sm">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-7 h-7 text-[#009032] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังค้นหาข้อมูล...</p>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && quotations.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm text-slate-500 flex flex-col items-center justify-center gap-2">
          <FileText className="w-9 h-9 text-slate-300" />
          <p className="font-bold">ไม่พบรายการใบเสนอราคา</p>
          <p className="text-xs">ลองปรับเปลี่ยนตัวกรองหรือค้นหาด้วยคำอื่น</p>
        </div>
      )}

      {/* Table Section */}
      {!isLoading && !error && quotations.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider select-none">
                  <th 
                    onClick={() => handleSort('created_at')}
                    className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    เลขที่ / วันที่ {renderSortIcon('created_at')}
                  </th>
                  <th 
                    onClick={() => handleSort('customer_name')}
                    className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    ลูกค้า {renderSortIcon('customer_name')}
                  </th>
                  <th 
                    onClick={() => handleSort('salesperson_name')}
                    className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    พนักงานขาย {renderSortIcon('salesperson_name')}
                  </th>
                  <th 
                    onClick={() => handleSort('total_sum')}
                    className="px-4 py-3 text-right cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    ยอดรวม {renderSortIcon('total_sum')}
                  </th>
                  <th 
                    onClick={() => handleSort('status')}
                    className="px-4 py-3 text-center cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    สถานะ {renderSortIcon('status')}
                  </th>
                  <th className="px-4 py-3 text-center">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {quotations.map((quote) => {
                  const statusStyle = getStatusStyle(quote.status);
                  const isExpanded = expandedId === quote.id;

                  return (
                    <React.Fragment key={quote.id}>
                      <tr
                        className="hover:bg-slate-50/40 transition-colors cursor-pointer"
                        onClick={() => setExpandedId(isExpanded ? null : quote.id)}
                      >
                        {/* Quotation No / Date */}
                        <td className="px-4 py-2.5">
                          <div className="flex flex-col">
                            <span className="font-mono font-bold text-slate-900 text-sm">
                              {quote.quotation_no || '-'}
                            </span>
                            <span className="text-[10px] text-slate-400 mt-0.5">
                              {formatDate(quote.created_at)}
                            </span>
                          </div>
                        </td>

                        {/* Customer */}
                        <td className="px-4 py-2.5">
                          <div className="flex flex-col">
                            <span className="font-semibold text-slate-800 text-sm">
                              {quote.company_name || (quote.customer_name || '')}
                            </span>
                            {quote.contact_name && quote.contact_name !== '-' && (
                              <span className="text-xs text-slate-500">
                                ติดต่อ: {quote.contact_name}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Salesperson */}
                        <td className="px-4 py-2.5">
                          <span className="text-slate-700 text-sm">
                            {quote.salesperson_name || '-'}
                          </span>
                        </td>

                        {/* Total */}
                        <td className="px-4 py-2.5 text-right">
                          <span className="font-mono font-semibold text-slate-900 text-sm">
                            ฿{formatNumber(quote.total_sum || 0)}
                          </span>
                        </td>

                        {/* Status */}
                        <td className="px-4 py-2.5 text-center">
                          <span className={`inline-flex items-center px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${statusStyle.bg} ${statusStyle.text}`}>
                            {statusStyle.label}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-2">
                            {quote.quotation_no && (
                              <a
                                href={`/download-pdf/${quote.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-2 bg-white hover:bg-emerald-50 text-slate-500 hover:text-emerald-600 border border-slate-200 hover:border-emerald-200 rounded-xl transition-all active:scale-95 shadow-sm"
                                title="ดาวน์โหลด PDF"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Download className="w-4 h-4" />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded Row: Items Detail */}
                      {isExpanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={6} className="px-4 py-3">
                            <div className="text-xs space-y-3">
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                <div>
                                  <span className="text-slate-400 font-semibold">รหัสลูกค้า:</span>
                                  <p className="text-slate-700">{quote.customer_code || '-'}</p>
                                </div>
                                <div>
                                  <span className="text-slate-400 font-semibold">เลขภาษี:</span>
                                  <p className="text-slate-700">{quote.customer_tax_id || '-'}</p>
                                </div>
                                <div>
                                  <span className="text-slate-400 font-semibold">โทรศัพท์:</span>
                                  <p className="text-slate-700">{quote.contact_phone || '-'}</p>
                                </div>
                                <div>
                                  <span className="text-slate-400 font-semibold">อีเมล:</span>
                                  <p className="text-slate-700">{quote.contact_email || '-'}</p>
                                </div>
                              </div>

                              {quote.items && quote.items.length > 0 && (
                                <div>
                                  <span className="text-slate-400 font-semibold block mb-1">รายการสินค้า:</span>
                                  <table className="w-full text-left text-[11px] border-collapse">
                                    <thead>
                                      <tr className="text-slate-400 border-b border-slate-200">
                                        <th className="py-1 pr-2">รุ่น</th>
                                        <th className="py-1 pr-2">ชื่อ</th>
                                        <th className="py-1 pr-2 text-right">จำนวน</th>
                                        <th className="py-1 pr-2 text-right">ราคา</th>
                                        <th className="py-1 pr-2 text-right">ส่วนลด</th>
                                        <th className="py-1 text-right">รวม</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {quote.items.map((item, idx) => {
                                        const qty = Number(item.quantity) || 0;
                                        const price = Number(item.price) || 0;
                                        const disc1 = Number(item.discount_1) || 0;
                                        const disc2 = Number(item.discount_2) || 0;
                                        const discountedPrice = price * (1 - disc1 / 100) * (1 - disc2 / 100);
                                        const itemTotal = qty * discountedPrice;

                                        let discountDisplay = '0%';
                                        if (disc1 > 0 && disc2 > 0) {
                                          discountDisplay = `${disc1}%, ${disc2}%`;
                                        } else if (disc1 > 0) {
                                          discountDisplay = `${disc1}%`;
                                        }

                                        return (
                                          <tr key={idx} className="border-b border-slate-100">
                                            <td className="py-1 pr-2 font-mono text-slate-700">{item.model || item.product_code || '-'}</td>
                                            <td className="py-1 pr-2 text-slate-600">{item.name || '-'}</td>
                                            <td className="py-1 pr-2 text-right text-slate-700">{qty}</td>
                                            <td className="py-1 pr-2 text-right text-slate-700">฿{formatNumber(price)}</td>
                                            <td className="py-1 pr-2 text-right text-slate-700">{discountDisplay}</td>
                                            <td className="py-1 text-right text-slate-700 font-semibold">฿{formatNumber(itemTotal)}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
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
    </div>
  );
};