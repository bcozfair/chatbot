// ─────────────────────────────────────────────────────────────────────────────
//  หน้าแอดมิน "กฎบล็อกสินค้า" — ระงับการเสนอราคาได้ 5 ระดับ
//  production > brand > series > model > internal_reference
//
//  แทนที่สวิตช์ "ระงับการเสนอราคา" เดิมในหน้าเงื่อนไขหลัก ซึ่งทำได้แค่ระดับ series
//  ดู docs/plan-product-block-rules.md §5
//
//  กฎที่จำเพาะกว่าชนะเสมอ (ref > model > series > brand > production) — ตรงกับ engine
//  ฝั่งเซิร์ฟเวอร์ที่ services/rules/scopeMatch.ts
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  Plus, Search, Edit2, Trash2, X, Loader2, CheckCircle2, AlertTriangle,
  ShieldBan, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight
} from 'lucide-react';
import { PageHeader } from './PageHeader';
import { ProductComboBox, type ProductPick } from './ProductComboBox';
import { ScopeComboBox } from './ScopeComboBox';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

interface BlockRule {
  id: number;
  production: string | null;
  brand: string | null;
  series: string | null;
  model: string | null;
  internal_reference: string | null;
  warn_msg: string;
  is_active: boolean;
  specificity: number;
  product_name: string | null;
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

/** ระดับของกฎ — เรียงจากกว้างไปแคบ ตรงกับ bitmask ของ engine */
type Level = 'production' | 'brand' | 'series' | 'model' | 'internal_reference';

const LEVELS: { key: Level; label: string; hint: string }[] = [
  { key: 'production',         label: 'ฝ่ายผลิต',   hint: 'บล็อกทั้งกลุ่มผลิต' },
  { key: 'brand',              label: 'ยี่ห้อ',      hint: 'บล็อกทั้งยี่ห้อ (ระบุฝ่ายผลิตด้วยก็ได้)' },
  { key: 'series',             label: 'ซีรีส์',      hint: 'บล็อกทั้งซีรีส์' },
  { key: 'model',              label: 'รุ่น',        hint: 'บล็อกเฉพาะรุ่นนี้' },
  { key: 'internal_reference', label: 'รหัสสินค้า',  hint: 'บล็อกเฉพาะรหัสอ้างอิงนี้ (แคบที่สุด)' }
];

const EMPTY_RELATIONS: ProductRelation[] = [];

/** ระดับของกฎที่มีอยู่แล้ว = ช่องที่แคบที่สุดที่กรอกไว้ */
function levelOf(rule: BlockRule): Level {
  if (rule.internal_reference) return 'internal_reference';
  if (rule.model) return 'model';
  if (rule.series) return 'series';
  if (rule.brand) return 'brand';
  return 'production';
}

function scopeTextOf(rule: BlockRule): string {
  if (rule.internal_reference) return rule.internal_reference;
  if (rule.model) return rule.model;
  return [rule.production, rule.brand, rule.series].filter(Boolean).join(' › ');
}

const LEVEL_BADGE: Record<Level, string> = {
  production:         'bg-slate-100 border-slate-200 text-slate-600',
  brand:              'bg-sky-50 border-sky-200 text-sky-700',
  series:             'bg-indigo-50 border-indigo-200 text-indigo-700',
  model:              'bg-amber-50 border-amber-200 text-amber-700',
  internal_reference: 'bg-red-50 border-red-200 text-red-700'
};

export const BlockRules: React.FC = () => {
  const { token } = useAuth();
  const [rules, setRules] = useState<BlockRule[]>([]);
  const [options, setOptions] = useState<RuleOptions>({ productions: [], brands: [], series: [], relations: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const [sortField, setSortField] = useState<string>('specificity');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [ruleToDelete, setRuleToDelete] = useState<BlockRule | null>(null);
  const [editingRule, setEditingRule] = useState<BlockRule | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ── ฟอร์ม ────────────────────────────────────────────────────────────────
  const [level, setLevel] = useState<Level>('production');
  const [production, setProduction] = useState('');
  const [brand, setBrand] = useState('');
  const [series, setSeries] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<ProductPick | null>(null);
  const [warnMsg, setWarnMsg] = useState('');
  const [isActive, setIsActive] = useState(true);

  const relations = options.relations || EMPTY_RELATIONS;

  const availableBrands = React.useMemo(() => {
    if (!production) return options.brands;
    return Array.from(new Set(
      relations.filter(r => r.production === production && r.brand).map(r => r.brand as string)
    )).sort();
  }, [production, options.brands, relations]);

  const availableSeries = React.useMemo(() => {
    let filtered = relations;
    if (production) filtered = filtered.filter(r => r.production === production);
    if (brand) filtered = filtered.filter(r => r.brand === brand);
    return Array.from(new Set(filtered.filter(r => r.series).map(r => r.series as string))).sort();
  }, [production, brand, relations]);

  const fetchRules = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [rulesRes, optionsRes] = await Promise.all([
        fetch('/api/admin/block-rules', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/admin/quotation-rules/options', { headers: { Authorization: `Bearer ${token}` } })
      ]);
      if (!rulesRes.ok) throw new Error('ไม่สามารถโหลดกฎบล็อกสินค้าได้');
      setRules(await rulesRes.json());
      // ตัวเลือก dropdown ล้มไม่เป็นไร — ตารางยังดูได้ แค่สร้างกฎใหม่ไม่สะดวก
      if (optionsRes.ok) setOptions(await optionsRes.json());
    } catch (err: unknown) {
      console.error('Fetch block rules error:', err);
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการโหลดข้อมูล');
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      const timer = setTimeout(() => { fetchRules(); }, 0);
      return () => clearTimeout(timer);
    }
  }, [token, fetchRules]);

  const showToast = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  const handleSort = (field: string) => {
    if (sortField === field) setSortDirection(p => (p === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDirection('desc'); }
    setCurrentPage(1);
  };

  const renderSortIcon = (field: string) => {
    if (sortField !== field) return <ArrowUpDown className="w-3.5 h-3.5 text-slate-300 ml-1.5 inline-block" />;
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-[var(--brand-fg)] ml-1.5 inline-block font-bold" />
      : <ArrowDown className="w-3.5 h-3.5 text-[var(--brand-fg)] ml-1.5 inline-block font-bold" />;
  };

  const resetForm = () => {
    setLevel('production');
    setProduction(''); setBrand(''); setSeries('');
    setSelectedProduct(null);
    setWarnMsg('');
    setIsActive(true);
    setFormError(null);
  };

  const handleCreateOpen = () => {
    setEditingRule(null);
    resetForm();
    setIsModalOpen(true);
  };

  const handleEditOpen = (rule: BlockRule) => {
    setEditingRule(rule);
    setFormError(null);
    setLevel(levelOf(rule));
    setProduction(rule.production || '');
    setBrand(rule.brand || '');
    setSeries(rule.series || '');
    setSelectedProduct(
      rule.model || rule.internal_reference
        ? {
            id: 0,
            model: rule.model || '',
            name: rule.product_name || '',
            internal_reference: rule.internal_reference || undefined
          }
        : null
    );
    setWarnMsg(rule.warn_msg);
    setIsActive(rule.is_active);
    setIsModalOpen(true);
  };

  /** payload ตามระดับที่เลือก — ช่องที่ไม่เกี่ยวต้องส่งค่าว่างเสมอ ไม่งั้นกฎจะแคบกว่าที่แอดมินตั้งใจ */
  const buildScopePayload = () => {
    switch (level) {
      case 'production':         return { production, brand: '', series: '', model: '', internal_reference: '' };
      case 'brand':              return { production, brand, series: '', model: '', internal_reference: '' };
      case 'series':             return { production, brand, series, model: '', internal_reference: '' };
      case 'model':              return { production: '', brand: '', series: '', model: selectedProduct?.model ?? '', internal_reference: '' };
      case 'internal_reference': return { production: '', brand: '', series: '', model: '', internal_reference: selectedProduct?.internal_reference ?? '' };
    }
  };

  const validateForm = (): string | null => {
    if (!warnMsg.trim()) return 'กรุณากรอกข้อความแจ้งเซลล์ — เซลล์เห็นข้อความนี้ที่เดียวเมื่อสินค้าถูกระงับ';
    if (level === 'production' && !production) return 'กรุณาเลือกฝ่ายผลิต';
    if (level === 'brand' && !brand) return 'กรุณาเลือกยี่ห้อ';
    if (level === 'series' && !series) return 'กรุณาเลือกซีรีส์';
    if (level === 'model' && !selectedProduct?.model) return 'กรุณาเลือกสินค้า';
    if (level === 'internal_reference') {
      const ref = selectedProduct?.internal_reference;
      if (!ref || !ref.trim() || ref === 'N/A') return 'สินค้านี้ไม่มีรหัสอ้างอิงภายในที่ใช้ได้ เลือกระดับ "รุ่น" แทน';
    }
    return null;
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = validateForm();
    if (invalid) { setFormError(invalid); return; }

    setFormError(null);
    setIsSaving(true);
    try {
      const url = editingRule ? `/api/admin/block-rules/${editingRule.id}` : '/api/admin/block-rules';
      const response = await fetch(url, {
        method: editingRule ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...buildScopePayload(), warn_msg: warnMsg.trim(), is_active: isActive })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'เกิดข้อผิดพลาดในการบันทึกข้อมูล');

      setIsModalOpen(false);
      showToast(editingRule ? 'แก้ไขกฎบล็อกสำเร็จ' : 'สร้างกฎบล็อกสินค้าสำเร็จ');
      fetchRules();
    } catch (err: unknown) {
      console.error('Save block rule error:', err);
      setFormError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการบันทึกข้อมูล');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!ruleToDelete) return;
    setIsSaving(true);
    try {
      const response = await fetch(`/api/admin/block-rules/${ruleToDelete.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'ไม่สามารถลบกฎนี้ได้');
      }
      setIsDeleteConfirmOpen(false);
      setRuleToDelete(null);
      showToast('ลบกฎบล็อกสินค้าสำเร็จ');
      fetchRules();
    } catch (err: unknown) {
      console.error('Delete block rule error:', err);
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการลบข้อมูล');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleActive = async (rule: BlockRule) => {
    try {
      const response = await fetch(`/api/admin/block-rules/${rule.id}/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_active: !rule.is_active })
      });
      if (!response.ok) throw new Error('ไม่สามารถแก้ไขสถานะการใช้งานได้');
      setRules(prev => prev.map(r => (r.id === rule.id ? { ...r, is_active: !r.is_active } : r)));
      showToast(`${rule.is_active ? 'ปิด' : 'เปิด'}กฎบล็อก "${scopeTextOf(rule)}" แล้ว`);
    } catch (err: unknown) {
      console.error('Toggle active block rule error:', err);
      setError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการแก้ไขสถานะ');
    }
  };

  const filteredRules = rules.filter(rule => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return [rule.production, rule.brand, rule.series, rule.model, rule.internal_reference,
            rule.warn_msg, rule.product_name]
      .some(v => (v || '').toLowerCase().includes(q));
  });

  const sortedRules = [...filteredRules].sort((a, b) => {
    let aVal: string | number = '';
    let bVal: string | number = '';
    if (sortField === 'specificity') { aVal = a.specificity; bVal = b.specificity; }
    else if (sortField === 'scope')  { aVal = scopeTextOf(a); bVal = scopeTextOf(b); }
    else if (sortField === 'warn_msg') { aVal = a.warn_msg; bVal = b.warn_msg; }
    else if (sortField === 'is_active') { aVal = a.is_active ? 1 : 0; bVal = b.is_active ? 1 : 0; }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    // เท่ากันให้เรียงตาม id เพื่อให้ลำดับนิ่ง ไม่สลับไปมาทุกครั้งที่ re-render
    if (aVal === bVal) return a.id - b.id;
    return sortDirection === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });

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
      {successMsg && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-xl transition-all border animate-fade-in bg-emerald-50 border-emerald-200 text-emerald-800">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
          <span className="text-sm font-semibold">{successMsg}</span>
        </div>
      )}

      <PageHeader
        icon={ShieldBan}
        title="กฎบล็อกสินค้า"
        description="ระงับการเสนอราคาได้ตั้งแต่ระดับฝ่ายผลิตจนถึงรายรหัสสินค้า"
      >
        <div className="relative flex-1 sm:w-60">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="ค้นหา..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 hover:border-slate-300 focus:border-[var(--brand-fg)] focus:bg-card rounded-xl outline-none transition-all"
          />
        </div>
        <button
          onClick={handleCreateOpen}
          className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[var(--brand)] hover:bg-[var(--brand-hover)] text-white text-sm font-bold rounded-xl shadow-sm transition-all active:scale-95 flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">สร้างกฎใหม่</span>
        </button>
      </PageHeader>

      {isLoading ? (
        <div className="bg-card border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-7 h-7 text-[var(--brand-fg)] animate-spin" />
          <p className="text-slate-500 text-sm font-medium">กำลังโหลดกฎบล็อกสินค้า...</p>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-8 text-center text-red-800 shadow-sm flex flex-col items-center justify-center gap-2">
          <AlertTriangle className="w-9 h-9 text-red-600" />
          <p className="font-bold">เกิดข้อผิดพลาดในการดึงข้อมูล</p>
          <p className="text-sm text-red-600">{error}</p>
        </div>
      ) : sortedRules.length === 0 ? (
        <div className="bg-card border border-slate-200 rounded-2xl p-10 text-center shadow-sm text-slate-500 flex flex-col items-center justify-center gap-2">
          <ShieldBan className="w-9 h-9 text-slate-300" />
          <p className="font-bold">ยังไม่มีกฎบล็อกสินค้า</p>
          <p className="text-xs">สินค้าที่ไม่มีกฎในตารางนี้จะเสนอราคาได้ตามปกติทุกตัว</p>
        </div>
      ) : (
        <div className="bg-card border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] font-semibold uppercase tracking-wider select-none">
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors w-32" onClick={() => handleSort('specificity')}>
                    ระดับ {renderSortIcon('specificity')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors" onClick={() => handleSort('scope')}>
                    ขอบเขต {renderSortIcon('scope')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors text-center" onClick={() => handleSort('warn_msg')}>
                    ข้อความแจ้งเซลล์ {renderSortIcon('warn_msg')}
                  </th>
                  <th className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors text-center w-28" onClick={() => handleSort('is_active')}>
                    สถานะ {renderSortIcon('is_active')}
                  </th>
                  <th className="px-4 py-3 text-center w-20">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                {paginatedRules.map(rule => {
                  const lv = levelOf(rule);
                  return (
                    <tr key={rule.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center px-2.5 py-0.5 border rounded-full text-[11px] font-bold whitespace-nowrap ${LEVEL_BADGE[lv]}`}>
                          {LEVELS.find(l => l.key === lv)?.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <div className="font-semibold text-slate-900 text-[13px] font-mono">{scopeTextOf(rule)}</div>
                        {rule.product_name && (
                          <div className="text-[11px] text-slate-500 line-clamp-1">{rule.product_name}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span
                          className="inline-block px-2 py-0.5 bg-yellow-50 border border-yellow-200 text-yellow-800 text-[11px] font-semibold rounded-full max-w-[260px] truncate"
                          title={rule.warn_msg}
                        >
                          {rule.warn_msg}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          onClick={() => handleToggleActive(rule)}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-all ${
                            rule.is_active
                              ? 'bg-red-50 border-red-200 text-red-700'
                              : 'bg-slate-50 border-slate-200 text-slate-400'
                          }`}
                        >
                          {rule.is_active ? 'บล็อกอยู่' : 'ปิดไว้'}
                        </button>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => handleEditOpen(rule)}
                            className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-900 rounded-lg transition-colors"
                            title="แก้ไขกฎบล็อก"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => { setRuleToDelete(rule); setIsDeleteConfirmOpen(true); }}
                            className="p-1.5 hover:bg-red-50 text-slate-500 hover:text-red-600 rounded-lg transition-colors"
                            title="ลบกฎบล็อก"
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
                  onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                  className="h-7 px-2 rounded-lg border border-slate-200 bg-card text-xs font-semibold outline-none focus:border-[var(--brand-fg)]"
                >
                  {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
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
                    className={`w-7 h-7 flex items-center justify-center rounded-lg text-xs font-bold transition-colors ${
                      p === safePage
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

      {/* ── ฟอร์มสร้าง/แก้ไข ── */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-slate-200 w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
              <div>
                <h3 className="font-bold text-slate-900 text-sm">
                  {editingRule ? 'แก้ไขกฎบล็อกสินค้า' : 'สร้างกฎบล็อกสินค้าใหม่'}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">กฎที่จำเพาะกว่าชนะเสมอ (รหัสสินค้า &gt; รุ่น &gt; ซีรีส์ &gt; ยี่ห้อ &gt; ฝ่ายผลิต)</p>
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

                {/* เลือกระดับก่อน แล้วช่องกรอกค่อยแตกตามระดับ — กันแอดมินกรอกช่องที่ไม่มีผล */}
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">ระดับของกฎ</label>
                  <div className="grid grid-cols-5 gap-1">
                    {LEVELS.map(l => (
                      <button
                        key={l.key}
                        type="button"
                        onClick={() => { setLevel(l.key); setFormError(null); }}
                        className={`px-2 py-2 rounded-lg text-[11px] font-bold border transition-all ${
                          level === l.key
                            ? 'bg-[var(--brand)] border-[var(--brand)] text-white shadow-sm'
                            : 'bg-slate-50 border-slate-200 text-slate-600 hover:border-slate-300'
                        }`}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400">{LEVELS.find(l => l.key === level)?.hint}</p>
                </div>

                {(level === 'production' || level === 'brand' || level === 'series') && (
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                        ฝ่ายผลิต{level === 'production' ? ' *' : ''}
                      </label>
                      <ScopeComboBox
                        options={options.productions}
                        value={production}
                        onChange={val => {
                          setProduction(val);
                          setBrand(''); setSeries('');
                        }}
                        placeholder={level === 'production' ? 'เลือกฝ่ายผลิต' : 'ทุกฝ่ายผลิต'}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                        ยี่ห้อ{level === 'brand' ? ' *' : ''}
                      </label>
                      <ScopeComboBox
                        options={availableBrands}
                        value={brand}
                        onChange={val => { setBrand(val); setSeries(''); }}
                        placeholder={level === 'production' ? '— ไม่ใช้ —' : 'ทุกยี่ห้อ'}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                        ซีรีส์{level === 'series' ? ' *' : ''}
                      </label>
                      <ScopeComboBox
                        options={availableSeries}
                        value={series}
                        onChange={setSeries}
                        placeholder={level === 'series' ? 'เลือกซีรีส์' : '— ไม่ใช้ —'}
                      />
                    </div>
                  </div>
                )}

                {(level === 'model' || level === 'internal_reference') && (
                  <ProductComboBox
                    label={level === 'model' ? 'เลือกสินค้า (เก็บเป็นรุ่น)' : 'เลือกสินค้า (เก็บเป็นรหัสอ้างอิง)'}
                    placeholder="เลือกสินค้าเป้าหมาย..."
                    value={selectedProduct}
                    onChange={setSelectedProduct}
                    error={!!formError && !selectedProduct}
                  />
                )}

                <div className="space-y-1.5">
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">
                    ข้อความแจ้งเซลล์ *
                  </label>
                  <input
                    type="text"
                    value={warnMsg}
                    onChange={e => setWarnMsg(e.target.value)}
                    placeholder="เช่น สินค้ากลุ่มนี้ต้องเช็คราคากับแอดมินก่อนทุกครั้ง"
                    className="w-full h-9 px-3 bg-card border border-slate-200 focus:border-[var(--brand-fg)] rounded-xl text-sm text-slate-800 outline-none transition-all focus:ring-2 focus:ring-[var(--brand-fg)]/10"
                  />
                  <p className="text-[10px] text-slate-400">
                    เซลล์จะเห็น: <span className="font-mono">❌ ระงับการเสนอราคา รายการ &lt;รหัสสินค้า&gt;: {warnMsg.trim() || '<ข้อความนี้>'}</span>
                  </p>
                </div>

                <label className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all bg-slate-50 border-slate-200 hover:border-slate-300">
                  <div>
                    <p className="text-xs font-bold text-slate-700">เปิดใช้กฎนี้</p>
                    <p className="text-[10px] text-slate-400">ปิดไว้ = เก็บกฎไว้แต่ยังเสนอราคาสินค้ากลุ่มนี้ได้</p>
                  </div>
                  <div className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors ${isActive ? 'bg-red-500' : 'bg-slate-300'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 bg-card rounded-full shadow-sm transition-all ${isActive ? 'left-4' : 'left-0.5'}`} />
                    <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="sr-only" />
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
                  className="px-5 py-2 text-xs font-bold text-white bg-[var(--brand)] hover:bg-[var(--brand-hover)] rounded-lg transition-all active:scale-95 shadow-sm flex items-center gap-1.5"
                >
                  {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                  {editingRule ? 'บันทึกการแก้ไข' : 'บันทึกข้อมูล'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── ยืนยันการลบ ── */}
      {isDeleteConfirmOpen && ruleToDelete && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-slate-200 w-full max-w-sm shadow-2xl">
            <div className="p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3">
                <Trash2 className="w-6 h-6 text-red-500" />
              </div>
              <h3 className="font-bold text-slate-900 text-sm">ยืนยันการลบกฎบล็อก</h3>
              <p className="text-xs text-slate-500 mt-1">
                ต้องการลบกฎของ <span className="font-bold text-slate-800">"{scopeTextOf(ruleToDelete)}"</span> หรือไม่?
                สินค้าในขอบเขตนี้จะกลับมาเสนอราคาได้ตามปกติทันที
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
