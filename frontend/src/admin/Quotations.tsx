import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { DateInput } from './DateInput';
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
  ChevronDown,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  History,
  RotateCcw
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
  /** เวลาที่ใบนี้ถูกส่งออกไฟล์นำเข้า Odoo ครั้งล่าสุด — null = ยังไม่เคยส่งออก */
  odoo_exported_at?: string | null;
  /** เวลาที่รอบ sync เห็นใบนี้อยู่ใน Odoo ครั้งแรก — null = ยังไม่เคยเห็น (ดู services/quotationOdooLink.ts) */
  odoo_imported_at?: string | null;
  /** id ของเอกสารในฐาน Odoo ตอนจับคู่ได้ — ไม่เปลี่ยนแม้ Odoo จะเปลี่ยนชื่อเอกสารภายหลัง */
  odoo_so_id?: number | null;
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

/** รูปแบบไฟล์นำเข้า Sale Order ของ Odoo — ตรงกับ query param `format` ของ endpoint export */
type ExportFormat = 'xlsx' | 'csv';

/** ตัวกรอง "สถานะการส่งออก Odoo" — ตรงกับ query param `exported` ของ backend */
type ExportedFilter = 'no' | 'yes' | 'all';

/**
 * บริษัทที่ส่งออก — ตรงกับ query param `company` ของ backend (ดูจากคำนำหน้าเลขที่ใบ)
 * 1 ครั้ง = 1 บริษัท เพราะ Odoo ของ PM กับ THT เป็นคนละระบบและใช้ชื่อภาษีคนละค่า
 */
type ExportCompany = 'QP' | 'QT';

const EXPORT_COMPANIES: { value: ExportCompany; company: string }[] = [
  { value: 'QP', company: 'PM' },
  { value: 'QT', company: 'THT' },
];

/** 1 ครั้งที่กดปุ่มส่งออก (GET /api/admin/quotations/export-batches) */
interface ExportBatch {
  id: string;
  exported_at: string;
  exported_by_username: string | null;
  format: string;
  quotation_count: number;
  row_count: number;
  /** ใบในชุดที่ยังนับว่า "ส่งออกแล้ว" — น้อยกว่า quotation_count แปลว่าถูกถอยไปบางส่วน */
  active_count: number;
  /** ตัวกรองที่ใช้ตอนกดส่งออก — ชุดที่ส่งออกก่อนแยก QP/QT จะไม่มีคีย์ company */
  filters?: { company?: string } | null;
}

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

/**
 * สถานะ Odoo ของใบเสนอราคา — 3 ขั้นเรียงตามลำดับที่เกิดจริง และเดินหน้าทางเดียว
 *   ยังไม่ส่งออก → รอนำเข้า (ส่งออกไฟล์แล้วแต่ยังไม่เห็นใน Odoo) → นำเข้า Odoo แล้ว
 * อ่านจาก snapshot ในตาราง quotations ไม่ใช่ join สดกับ sale_orders — Odoo เปลี่ยนชื่อเอกสาร
 * ตอนยืนยัน/ออกบิล เลข Q* จึงหายไปจากฝั่งนั้นได้ ถ้า join สดสถานะจะเด้งกลับเองทั้งที่สำเร็จแล้ว
 */
type OdooStage = 'imported' | 'pending' | 'not_exported';

const ODOO_STAGE_STYLES: Record<OdooStage, { bg: string; text: string; dot: string; label: string; hint: string }> = {
  imported: {
    bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500',
    label: 'นำเข้า Odoo แล้ว', hint: 'พบใบนี้เป็นเอกสารในระบบ Odoo แล้ว',
  },
  pending: {
    bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700', dot: 'bg-amber-400',
    label: 'รอนำเข้า', hint: 'ส่งออกไฟล์แล้วแต่ยังไม่พบใบนี้ใน Odoo — อาจยังไม่ได้อัปโหลด หรืออัปโหลดไม่สำเร็จ',
  },
  not_exported: {
    bg: 'bg-slate-50 border-slate-200', text: 'text-slate-500', dot: 'bg-slate-300',
    label: 'ยังไม่ส่งออก', hint: 'ยังไม่เคยอยู่ในไฟล์นำเข้า Odoo',
  },
};

function getOdooStage(quote: Quotation): OdooStage {
  if (quote.odoo_imported_at) return 'imported';
  if (quote.odoo_exported_at) return 'pending';
  return 'not_exported';
}

function formatNumber(num: number) {
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ปัก Asia/Bangkok ไว้เสมอ ไม่ใช้ TimeZone ของเบราว์เซอร์ — ต้องตรงกับตัวกรองวันที่ฝั่ง SQL
// ที่ตีความเป็นวันตามเวลาไทย ไม่งั้นเครื่องที่ตั้งโซนอื่นจะเห็น "วันที่ในตารางไม่ตรงกับช่วงที่กรอง"
function formatDate(dateStr: string) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok',
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
  // ตั้งต้น 'no' — งานหลักของหน้านี้คือหยิบ "ใบใหม่ที่ยังไม่ได้นำเข้า Odoo" ไปส่งออก
  // อยากดูใบเก่าให้สลับตัวกรองเป็น "ส่งออกแล้ว" หรือ "ทั้งหมด"
  const [exportedFilter, setExportedFilter] = useState<ExportedFilter>('no');
  const [sortBy, setSortBy] = useState('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Export state (เมนูเลือกรูปแบบไฟล์นำเข้า Odoo)
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exportMenuRef = React.useRef<HTMLDivElement>(null);

  // ประวัติการส่งออก + การถอยเครื่องหมาย
  const [historyOpen, setHistoryOpen] = useState(false);
  const [batches, setBatches] = useState<ExportBatch[]>([]);
  const [isLoadingBatches, setIsLoadingBatches] = useState(false);
  const [unmarkingId, setUnmarkingId] = useState<string | null>(null);

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
      params.set('exported', exportedFilter);
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
  }, [token, searchQuery, statusFilter, dateFrom, dateTo, exportedFilter, currentPage, pageSize, sortBy, sortOrder]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchQuotations();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchQuotations]);

  // ปิดเมนูส่งออกเมื่อคลิกนอกกล่อง
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [exportMenuOpen]);

  // ส่งออกไฟล์นำเข้า Sale Order ของ Odoo — ใช้ตัวกรองชุดเดียวกับที่เห็นบนหน้าจอ
  // ตัวกรอง "การส่งออก" ตั้งต้นเป็น "ยังไม่ส่งออก" ใบที่ลงไฟล์ไปแล้วจึงไม่ถูกส่งซ้ำ
  // (backend มาร์ก odoo_exported_at ให้ตอนสร้างไฟล์สำเร็จ)
  //
  // ได้ทีละบริษัท: ไฟล์มีเฉพาะใบที่เลขที่ขึ้นต้นด้วย company ที่เลือก ใบของอีกบริษัท
  // และใบที่เลขที่ไม่ขึ้นต้นด้วย QP/QT จะไม่ลงไฟล์และไม่ถูกมาร์กว่าส่งออกแล้ว
  const handleExportOdoo = async (format: ExportFormat, company: ExportCompany) => {
    setExportMenuOpen(false);
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      params.set('company', company);
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      params.set('exported', exportedFilter);
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      params.set('format', format);

      const response = await fetch(`/api/admin/quotations/export?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) throw new Error('ไม่สามารถส่งออกข้อมูลได้');

      // จำนวนใบนับจากไฟล์เองไม่ได้ (1 ใบ = หลายแถว) backend จึงส่งมาทาง header
      const exportedCount = Number(response.headers.get('X-Export-Quotation-Count') ?? '0');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // ต้องได้ชื่อเดียวกับ Content-Disposition ฝั่ง backend — attribute นี้เป็นตัวชนะเวลาเบราว์เซอร์เซฟไฟล์
      // ล็อกโซนไทยไว้ ไม่งั้นเครื่องที่ตั้งโซนอื่นจะได้วันที่คนละวันกับชื่อไฟล์ฝั่ง server
      const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
      a.download = `salechatbot_quotation_${company}_${stamp}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      showToast(exportedCount > 0
        ? `ส่งออก ${company} ${exportedCount} ใบเป็นไฟล์ ${format === 'xlsx' ? 'Excel' : 'CSV'} สำเร็จ — ใบเหล่านี้ถูกทำเครื่องหมายว่าส่งออกแล้ว`
        : `ไม่มีใบ ${company} ใหม่ให้ส่งออก (ทุกใบตามตัวกรองนี้ถูกส่งออกไปแล้ว)`);

      // ใบที่เพิ่งดาวน์โหลดถูกมาร์กไปแล้ว ถ้าไม่โหลดใหม่หน้าจอจะแสดงสถานะเก่าที่ไม่จริง
      fetchQuotations();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการส่งออกข้อมูล';
      setError(errorMessage);
    } finally {
      setIsExporting(false);
    }
  };

  // ถอยเครื่องหมาย "ส่งออกแล้ว" ของใบเดียว — ใช้ตอนนำเข้า Odoo ไม่ผ่าน ใบจะกลับเข้าคิวรอบถัดไป
  const handleUnmarkExport = async (quote: Quotation) => {
    if (!window.confirm(`ยกเลิกเครื่องหมาย "ส่งออกแล้ว" ของใบ ${quote.quotation_no || quote.id}?\nใบนี้จะกลับมาอยู่ในชุดที่ส่งออกครั้งถัดไป`)) return;
    setUnmarkingId(quote.id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/quotations/${quote.id}/unmark-export`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('ไม่สามารถยกเลิกเครื่องหมายส่งออกได้');
      showToast('ยกเลิกเครื่องหมายส่งออกแล้ว');
      fetchQuotations();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการยกเลิกเครื่องหมายส่งออก');
    } finally {
      setUnmarkingId(null);
    }
  };

  const fetchBatches = useCallback(async () => {
    setIsLoadingBatches(true);
    try {
      const response = await fetch('/api/admin/quotations/export-batches?limit=50', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('ไม่สามารถดึงประวัติการส่งออกได้');
      const result: { data: ExportBatch[] } = await response.json();
      setBatches(result.data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการโหลดประวัติการส่งออก');
    } finally {
      setIsLoadingBatches(false);
    }
  }, [token]);

  const openHistory = () => {
    setExportMenuOpen(false);
    setHistoryOpen(true);
    fetchBatches();
  };

  // ถอยทั้งชุด — ใช้ตอนไฟล์ทั้งไฟล์นำเข้า Odoo ไม่ผ่าน
  const handleUnmarkBatch = async (batch: ExportBatch) => {
    if (!window.confirm(`ยกเลิกเครื่องหมายส่งออกของทั้งชุด (${batch.active_count} ใบ)?\nใบทั้งหมดในชุดนี้จะกลับมาอยู่ในชุดที่ส่งออกครั้งถัดไป`)) return;
    setUnmarkingId(batch.id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/quotations/export-batches/${batch.id}/unmark`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('ไม่สามารถยกเลิกเครื่องหมายส่งออกของชุดนี้ได้');
      const result: { reverted: number } = await response.json();
      showToast(`ยกเลิกเครื่องหมายส่งออกแล้ว ${result.reverted} ใบ`);
      fetchBatches();
      fetchQuotations();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการยกเลิกเครื่องหมายส่งออก');
    } finally {
      setUnmarkingId(null);
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
            <div className="relative w-full sm:w-auto" ref={exportMenuRef}>
              <button
                onClick={() => setExportMenuOpen(open => !open)}
                disabled={isExporting}
                className="w-full flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#009032] hover:bg-[#007b2b] disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl shadow-sm transition-all active:scale-95 flex-shrink-0"
              >
                {isExporting
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <FileSpreadsheet className="w-4 h-4" />}
                <span className="hidden sm:inline">ส่งออก Odoo</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {exportMenuOpen && (
                <div className="absolute right-0 top-full mt-2 z-30 w-[19rem] bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden">
                  {/* 1 ครั้ง = 1 บริษัท — Odoo ของ PM กับ THT เป็นคนละระบบ ไฟล์จึงรวมกันไม่ได้ */}
                  {EXPORT_COMPANIES.map(({ value, company }) => (
                    <div key={value} className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
                      <div className="flex items-baseline gap-1.5 flex-1 min-w-0">
                        <span className="px-1.5 py-0.5 rounded-md bg-[#009032]/10 text-[#009032] text-xs font-extrabold tracking-wide">
                          {value}
                        </span>
                        <span className="text-sm font-bold text-slate-800 truncate">{company}</span>
                      </div>
                      <button
                        onClick={() => handleExportOdoo('xlsx', value)}
                        title={`ส่งออก ${value} (${company}) เป็น Excel`}
                        className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 hover:border-[#009032] hover:text-[#009032] hover:bg-[#009032]/5 transition-colors"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        Excel
                      </button>
                      <button
                        onClick={() => handleExportOdoo('csv', value)}
                        title={`ส่งออก ${value} (${company}) เป็น CSV`}
                        className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 hover:border-[#009032] hover:text-[#009032] hover:bg-[#009032]/5 transition-colors"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        CSV
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={openHistory}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <History className="w-4 h-4 text-slate-400" />
                    ประวัติการส่งออก
                  </button>
                  <p className="px-3 py-2 text-[11px] leading-snug text-slate-500 border-t border-slate-100 bg-slate-50">
                    ส่งออกตามตัวกรองบนหน้าจอ (ตั้งต้น: เฉพาะใบที่ยังไม่เคยส่ง) ใบที่อยู่ในไฟล์จะถูกทำเครื่องหมายว่าส่งแล้วทันที
                    · เลขที่ที่ไม่ขึ้นต้นด้วย QP/QT จะไม่อยู่ในไฟล์
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 pt-4 border-t border-slate-100">
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

          {/* Export Status Filter — ตั้งต้น "ยังไม่ส่งออก" เพื่อให้กดส่งออกได้เลยโดยไม่ซ้ำ */}
          <div className="relative">
            <select
              id="quotation-exported-filter"
              value={exportedFilter}
              onChange={(e) => { setExportedFilter(e.target.value as ExportedFilter); setCurrentPage(1); }}
              className="w-full bg-white border border-slate-200 focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 focus:outline-none rounded-xl px-4 py-2.5 text-sm text-slate-800 transition-all appearance-none cursor-pointer"
            >
              <option value="no">ยังไม่ส่งออก Odoo</option>
              <option value="yes">ส่งออก Odoo แล้ว</option>
              <option value="all">การส่งออกทั้งหมด</option>
            </select>
            <FileSpreadsheet className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>

          {/* Date From */}
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 z-10 pointer-events-none" />
            <DateInput
              value={dateFrom}
              onChange={(v) => { setDateFrom(v); setCurrentPage(1); }}
              aria-label="กรองตั้งแต่วันที่"
              className="w-full bg-white border border-slate-200 focus-within:border-[#009032] focus-within:ring-2 focus-within:ring-[#009032]/10 focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 focus:outline-none rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 transition-all"
            />
          </div>

          {/* Date To */}
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 z-10 pointer-events-none" />
            <DateInput
              value={dateTo}
              onChange={(v) => { setDateTo(v); setCurrentPage(1); }}
              aria-label="กรองถึงวันที่"
              className="w-full bg-white border border-slate-200 focus-within:border-[#009032] focus-within:ring-2 focus-within:ring-[#009032]/10 focus:border-[#009032] focus:ring-2 focus:ring-[#009032]/10 focus:outline-none rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 transition-all"
            />
          </div>
        </div>

        {/* Clear Filters */}
        {(searchQuery || statusFilter || dateFrom || dateTo || exportedFilter !== 'no') && (
          <button
            onClick={() => {
              setSearchQuery('');
              setStatusFilter('');
              setDateFrom('');
              setDateTo('');
              // กลับไปค่าตั้งต้น 'no' ไม่ใช่ 'all' — "ล้างตัวกรอง" ต้องได้สภาพเดียวกับตอนเปิดหน้า
              setExportedFilter('no');
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
                  <th
                    onClick={() => handleSort('odoo_exported_at')}
                    className="px-4 py-3 text-center cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    สถานะ Odoo {renderSortIcon('odoo_exported_at')}
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

                        {/* Odoo status: ยังไม่ส่งออก → รอนำเข้า → นำเข้า Odoo แล้ว */}
                        <td className="px-4 py-2.5 text-center">
                          {(() => {
                            const stage = getOdooStage(quote);
                            const st = ODOO_STAGE_STYLES[stage];
                            return (
                              <div className="flex flex-col items-center gap-0.5" title={st.hint}>
                                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold tracking-wider border ${st.bg} ${st.text}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                                  {st.label}
                                </span>
                                {stage === 'imported' && (
                                  <span className="text-[10px] text-slate-400">{formatDate(quote.odoo_imported_at as string)}</span>
                                )}
                                {stage === 'pending' && (
                                  <span className="text-[10px] text-slate-400">ส่งออก {formatDate(quote.odoo_exported_at as string)}</span>
                                )}
                              </div>
                            );
                          })()}
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-2">
                            {quote.quotation_no && (
                              <a
                                href={`/download-pdf/${quote.id}/${encodeURIComponent(quote.quotation_no)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-2 bg-white hover:bg-emerald-50 text-slate-500 hover:text-emerald-600 border border-slate-200 hover:border-emerald-200 rounded-xl transition-all active:scale-95 shadow-sm"
                                title="ดาวน์โหลด PDF"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Download className="w-4 h-4" />
                              </a>
                            )}
                            {quote.odoo_exported_at && (
                              <button
                                type="button"
                                disabled={unmarkingId === quote.id}
                                className="p-2 bg-white hover:bg-amber-50 text-slate-500 hover:text-amber-600 border border-slate-200 hover:border-amber-200 rounded-xl transition-all active:scale-95 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
                                title="ยกเลิกเครื่องหมายส่งออก (ให้ส่งออกใหม่ได้)"
                                onClick={(e) => { e.stopPropagation(); handleUnmarkExport(quote); }}
                              >
                                {unmarkingId === quote.id
                                  ? <Loader2 className="w-4 h-4 animate-spin" />
                                  : <RotateCcw className="w-4 h-4" />}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded Row: Items Detail */}
                      {isExpanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={7} className="px-4 py-2.5">
                            <div className="text-[11px] space-y-2 border-l-2 border-[#009032]/30 pl-3">
                              {/* label กับค่าอยู่บรรทัดเดียวกันและตัดขึ้นบรรทัดใหม่เองเมื่อจอแคบ — ข้อมูลครบเท่าเดิมแต่เตี้ยลงครึ่งหนึ่ง */}
                              <div className="flex flex-wrap gap-x-5 gap-y-1">
                                <div>
                                  <span className="text-slate-400 font-semibold mr-1.5">รหัสลูกค้า:</span>
                                  <p className="text-slate-700 inline font-medium">{quote.customer_code || '-'}</p>
                                </div>
                                <div>
                                  <span className="text-slate-400 font-semibold mr-1.5">เลขภาษี:</span>
                                  <p className="text-slate-700 inline font-medium">{quote.customer_tax_id || '-'}</p>
                                </div>
                                <div>
                                  <span className="text-slate-400 font-semibold mr-1.5">โทรศัพท์:</span>
                                  <p className="text-slate-700 inline font-medium">{quote.contact_phone || '-'}</p>
                                </div>
                                <div>
                                  <span className="text-slate-400 font-semibold mr-1.5">อีเมล:</span>
                                  <p className="text-slate-700 inline font-medium">{quote.contact_email || '-'}</p>
                                </div>
                              </div>

                              {quote.items && quote.items.length > 0 && (
                                <div>
                                  {/* หัวคอลัมน์ของตารางบอกอยู่แล้วว่าเป็นรายการสินค้า — ซ่อนหัวข้อซ้ำเพื่อประหยัดบรรทัด */}
                                  <span className="text-slate-400 font-semibold hidden mb-1">รายการสินค้า:</span>
                                  <table className="w-full text-left text-[11px] tabular-nums border-collapse">
                                    <thead>
                                      <tr className="text-slate-400 border-b border-slate-200">
                                        <th className="pb-1 pr-3">รุ่น</th>
                                        <th className="pb-1 pr-3">ชื่อ</th>
                                        <th className="pb-1 pr-3 text-right">จำนวน</th>
                                        <th className="pb-1 pr-3 text-right">ราคา</th>
                                        <th className="pb-1 pr-3 text-right">ส่วนลด</th>
                                        <th className="pb-1 text-right">รวม</th>
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
                                          <tr key={idx} className="border-b border-slate-100/70 hover:bg-white/70 transition-colors">
                                            <td className="py-0.5 pr-3 font-mono text-slate-700">{item.model || item.product_code || '-'}</td>
                                            {/* ตัดชื่อยาวด้วย … กันดันแถวเป็น 2 บรรทัด — ชื่อเต็มยังอ่านได้จาก tooltip */}
                                            <td className="py-0.5 pr-3 text-slate-600">
                                              <span className="block max-w-[24rem] truncate" title={item.name || ''}>{item.name || '-'}</span>
                                            </td>
                                            <td className="py-0.5 pr-3 text-right text-slate-700">{qty}</td>
                                            <td className="py-0.5 pr-3 text-right text-slate-700">฿{formatNumber(price)}</td>
                                            <td className="py-0.5 pr-3 text-right text-slate-700">{discountDisplay}</td>
                                            <td className="py-0.5 text-right text-slate-700 font-semibold">฿{formatNumber(itemTotal)}</td>
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

      {/* ── Export History Modal ── */}
      {historyOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/40 flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
          onClick={() => setHistoryOpen(false)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-3xl my-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-100">
              <History className="w-5 h-5 text-[#009032]" />
              <h3 className="text-base font-bold text-slate-900">ประวัติการส่งออก Odoo</h3>
              <div className="flex-1" />
              <button
                onClick={() => setHistoryOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                title="ปิด"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isLoadingBatches && (
              <div className="p-10 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-7 h-7 text-[#009032] animate-spin" />
                <p className="text-slate-500 text-sm font-medium">กำลังโหลดประวัติ...</p>
              </div>
            )}

            {!isLoadingBatches && batches.length === 0 && (
              <div className="p-10 text-center text-slate-500 flex flex-col items-center gap-2">
                <FileSpreadsheet className="w-9 h-9 text-slate-300" />
                <p className="font-bold">ยังไม่มีประวัติการส่งออก</p>
              </div>
            )}

            {!isLoadingBatches && batches.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider">
                      <th className="px-4 py-3">เวลา</th>
                      <th className="px-4 py-3">ผู้ส่งออก</th>
                      <th className="px-4 py-3 text-center">บริษัท</th>
                      <th className="px-4 py-3 text-center">ไฟล์</th>
                      <th className="px-4 py-3 text-right">จำนวนใบ</th>
                      <th className="px-4 py-3 text-center">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {batches.map((batch) => (
                      <tr key={batch.id} className="hover:bg-slate-50/40 transition-colors">
                        <td className="px-4 py-2.5 text-slate-700">{formatDate(batch.exported_at)}</td>
                        <td className="px-4 py-2.5 text-slate-700">{batch.exported_by_username || '-'}</td>
                        {/* ชุดที่ส่งออกก่อนแยก QP/QT ไม่มีคีย์นี้ — ตอนนั้นไฟล์เดียวมีทั้งสองบริษัทปนกัน */}
                        <td className="px-4 py-2.5 text-center text-slate-700 font-semibold">
                          {batch.filters?.company || '-'}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border bg-slate-50 border-slate-200 text-slate-600">
                            {batch.format}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-800">
                          {batch.active_count}
                          {/* ต่างจาก quotation_count แปลว่าบางใบถูกถอยเครื่องหมายไปแล้ว */}
                          {batch.active_count !== batch.quotation_count && (
                            <span className="text-slate-400"> / {batch.quotation_count}</span>
                          )}
                          <span className="block text-[10px] text-slate-400">{batch.row_count} แถว</span>
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <button
                            type="button"
                            disabled={batch.active_count === 0 || unmarkingId === batch.id}
                            onClick={() => handleUnmarkBatch(batch)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-white hover:bg-amber-50 text-slate-600 hover:text-amber-700 border border-slate-200 hover:border-amber-200 rounded-xl text-xs font-semibold transition-all active:scale-95 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
                            title="ยกเลิกเครื่องหมายส่งออกของทั้งชุด"
                          >
                            {unmarkingId === batch.id
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <RotateCcw className="w-3.5 h-3.5" />}
                            ยกเลิกทั้งชุด
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="px-5 py-3 text-[11px] leading-snug text-slate-500 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
              "ยกเลิกทั้งชุด" ใช้ตอนไฟล์ทั้งไฟล์นำเข้า Odoo ไม่ผ่าน — ใบทั้งหมดในชุดจะกลับมาอยู่ในชุดที่ส่งออกครั้งถัดไป
            </p>
          </div>
        </div>
      )}
    </div>
  );
};