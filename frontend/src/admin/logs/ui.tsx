import React from 'react';
import { AlertCircle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { formatMs, formatNumber, inputCls, PAGE_SIZE_OPTIONS, thCls } from './format';

/**
 * ชิ้นส่วนหน้าตาที่ใช้ร่วมกันทั้งกลุ่ม "บันทึกและรายงาน"
 *
 * ทำไมต้องมี: ก่อนหน้านี้ 4 หน้าต่างคนต่างเขียนกล่องตัวกรอง / กล่อง error / แถบแบ่งหน้า
 * ของตัวเอง ด้วยคลาสที่ใกล้เคียงแต่ไม่เท่ากัน (บ้าง p-4 บ้าง p-5, ปุ่มเปลี่ยนหน้าเป็นเลขหน้าบ้าง
 * เป็นลูกศรอย่างเดียวบ้าง) พอสลับแท็บดูทีละหน้าจะรู้สึกว่าเป็นคนละระบบ ทั้งที่เป็นเรื่องเดียวกัน
 * ไฟล์นี้จึงเป็นที่เดียวที่ตัดสินว่าองค์ประกอบเหล่านั้นหน้าตายังไง
 *
 * ⚠️ ไฟล์นี้ export ได้เฉพาะคอมโพเนนต์ — ค่าคงที่/คลาสไปไว้ที่ format.ts
 *    (react-refresh/only-export-components)
 */

/* ── ตัวกรอง ─────────────────────────────────────────────────────────────── */

/** การ์ดครอบตัวกรองทั้งชุด */
export const FilterCard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="bg-card border border-slate-200 rounded-2xl px-4 py-3.5 space-y-3">{children}</div>
);

/** แถวของช่องกรอง — ช่องที่ยาวไม่พอจะตกบรรทัดเองโดยยังชิดฐานเดียวกัน */
export const FilterRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-wrap items-end gap-2.5">{children}</div>
);

/**
 * ช่องกรอง 1 ช่อง = ป้ายกำกับ + ตัวควบคุม
 * ป้ายอยู่ "เหนือ" ช่องเสมอ ไม่ใช้ placeholder แทนป้าย — placeholder หายไปตอนพิมพ์
 * แล้วผู้ใช้จะจำไม่ได้ว่าค่าที่ค้างอยู่ในช่องนั้นคือตัวกรองอะไร
 */
export const FilterField: React.FC<{
  label: string;
  /** กินพื้นที่ว่างที่เหลือในแถว — ใช้กับช่องค้นหาช่องเดียวต่อแถว */
  grow?: boolean;
  /** ความกว้าง (คลาส tailwind) — ช่องวันที่/dropdown ที่ไม่ควรหดจนอ่านไม่ออก */
  width?: string;
  children: React.ReactNode;
}> = ({ label, grow, width = 'w-40', children }) => (
  <div className={grow ? 'flex-1 min-w-56' : width}>
    <label className="block text-[11px] font-medium text-slate-500 mb-1">{label}</label>
    {children}
  </div>
);

/** ช่องค้นหาพร้อมไอคอนแว่น — รูปแบบเดียวกันทุกหน้า (ทุกหน้ากด / เพื่อโฟกัสได้เหมือนกัน) */
export const SearchField = React.forwardRef<HTMLInputElement, {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}>(({ value, onChange, placeholder }, ref) => (
  <div className="relative">
    <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
    <input
      ref={ref}
      className={inputCls + ' pl-10'}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  </div>
));
SearchField.displayName = 'SearchField';

/** dropdown ที่หน้าตาเท่ากับ input ช่องอื่น (ลูกศรของ native select แต่ละ OS ไม่เหมือนกัน) */
export const SelectField: React.FC<{
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  'aria-label'?: string;
}> = ({ value, onChange, children, 'aria-label': ariaLabel }) => (
  <select
    aria-label={ariaLabel}
    className={inputCls + ' appearance-none cursor-pointer pr-9'}
    value={value}
    onChange={(e) => onChange(e.target.value)}
  >
    {children}
  </select>
);

/** ช่องติ๊ก 1 บรรทัด — ใช้กับตัวกรองแบบเปิด/ปิด เช่น "เฉพาะที่ช้า" */
export const CheckField: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}> = ({ checked, onChange, label, hint }) => (
  <label
    className="inline-flex items-center gap-2 h-[42px] text-xs text-slate-600 cursor-pointer select-none
               border border-slate-200 rounded-xl px-3 hover:border-slate-300 transition-colors"
    title={hint}
  >
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="rounded border-slate-300 accent-[var(--brand)]"
    />
    {label}
  </label>
);

/**
 * แถวล่างของการ์ดตัวกรอง — ชิปบอกว่ากรองอะไรค้างอยู่ + ปุ่มล้าง + จำนวนผลลัพธ์
 *
 * ชิปสำคัญกว่าที่คิด: ตัวกรองขั้นสูงถูกพับไว้ ถ้าไม่มีอะไรบอกว่ายังกรองค้างอยู่
 * ผู้ใช้จะเห็นตารางว่างแล้วเข้าใจว่า "ไม่มีข้อมูล" ทั้งที่จริงคือกรองแคบเกินไป
 */
export const FilterFooter: React.FC<{
  children?: React.ReactNode;
  onReset?: () => void;
  loading?: boolean;
  total?: number;
  unit?: string;
}> = ({ children, onReset, loading, total, unit = 'รายการ' }) => (
  <div className="flex flex-wrap items-center gap-2 text-xs border-t border-slate-100 pt-3">
    {children}
    {onReset && (
      <button onClick={onReset} className="text-slate-400 hover:text-slate-600 underline underline-offset-2">
        ล้างตัวกรอง
      </button>
    )}
    <span className="ml-auto text-slate-500 tabular-nums">
      {loading ? 'กำลังโหลด…' : total === undefined ? '' : formatNumber(total) + ' ' + unit}
    </span>
  </div>
);

/** ชิปตัวกรองที่ค้างอยู่ — กดที่ตัวชิปเพื่อเอาเงื่อนไขนั้นออก */
export const FilterChip: React.FC<{ label: string; value: string; onRemove: () => void }> = ({
  label, value, onRemove,
}) => (
  <button
    onClick={onRemove}
    title={'เอาตัวกรอง ' + label + ' ออก'}
    className="inline-flex items-center gap-1.5 max-w-64 px-2 py-1 rounded-lg border transition-opacity hover:opacity-80"
    style={{ backgroundColor: 'var(--brand-soft)', borderColor: 'var(--brand-border)', color: 'var(--brand-fg)' }}
  >
    <span className="opacity-70 shrink-0">{label}</span>
    <span className="font-medium truncate">{value}</span>
    <X className="w-3 h-3 shrink-0 opacity-70" />
  </button>
);

/* ── สถานะของหน้า ────────────────────────────────────────────────────────── */

export const ErrorBox: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => (
  <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-2">
    <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-red-800">โหลดข้อมูลไม่สำเร็จ</div>
      <div className="text-xs text-red-600 mt-0.5 break-words">{message}</div>
    </div>
    {onRetry && (
      <button
        onClick={onRetry}
        className="px-3 py-1.5 rounded-lg bg-card border border-red-200 text-sm text-red-700 shrink-0"
      >
        ลองใหม่
      </button>
    )}
  </div>
);

/**
 * ไม่มีข้อมูล — ต้องบอก "ทำไมถึงว่าง" ด้วยเสมอ ไม่ใช่แค่คำว่าไม่พบข้อมูล
 * ตารางว่างเพราะไม่มีเหตุการณ์จริง กับว่างเพราะกรองแคบไป ต้องแยกออกจากกันให้ได้
 */
export const EmptyState: React.FC<{
  icon: React.ElementType;
  title: string;
  hint?: React.ReactNode;
}> = ({ icon: Icon, title, hint }) => (
  <div className="py-16 text-center px-6">
    <Icon className="w-9 h-9 text-slate-300 mx-auto" />
    <div className="mt-2 text-sm text-slate-500">{title}</div>
    {hint && <div className="mt-1 text-xs text-slate-400 max-w-md mx-auto">{hint}</div>}
  </div>
);

/** โครงกระดูกตอนโหลดครั้งแรก — กันหน้ากระโดดตอนข้อมูลมาถึง */
export const SkeletonRows: React.FC<{ rows?: number }> = ({ rows = 8 }) => (
  <div className="divide-y divide-slate-100">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="px-4 py-3 animate-pulse flex items-center gap-4">
        <div className="h-3.5 w-28 bg-slate-200 rounded" />
        <div className="h-3.5 flex-1 bg-slate-100 rounded" />
        <div className="h-3.5 w-16 bg-slate-100 rounded" />
      </div>
    ))}
  </div>
);

/* ── ตาราง ──────────────────────────────────────────────────────────────── */

/** การ์ดครอบผลลัพธ์ — หัวข้อ (ถ้ามี) + เนื้อ + แถบแบ่งหน้า อยู่ในกรอบเดียวกันเสมอ */
export const TableCard: React.FC<{
  title?: string;
  hint?: string;
  action?: React.ReactNode;
  /** ใช้ตอนวางในกริดที่ต้องการให้การ์ดสูงเท่ากัน (h-full) — ปกติไม่ต้องส่ง */
  className?: string;
  children: React.ReactNode;
}> = ({ title, hint, action, className = '', children }) => (
  <div className={`bg-card border border-slate-200 rounded-2xl overflow-hidden ${className}`}>
    {title && (
      <div className="px-4 py-3 border-b border-slate-100 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {hint && <p className="text-xs text-slate-400 mt-0.5">{hint}</p>}
        </div>
        {action}
      </div>
    )}
    {children}
  </div>
);

/**
 * หัวคอลัมน์ที่กดเพื่อเรียงลำดับได้
 *
 * ลูกศรของคอลัมน์ที่ "ไม่ได้เรียงอยู่" จะจางมากแต่ยังอยู่ ไม่ได้ซ่อนจนโผล่ตอน hover เท่านั้น
 * — บนจอสัมผัสไม่มี hover ถ้าซ่อนไว้ผู้ใช้จะไม่มีทางรู้เลยว่าหัวตารางกดได้
 */
export const SortHeader: React.FC<{
  label: string;
  /** คีย์ของคอลัมน์นี้ — ต้องตรงกับคีย์ใน accessors หรือรายชื่อขาวฝั่ง SQL */
  col: string;
  active: string;
  dir: 'asc' | 'desc';
  onSort: (col: string) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
  title?: string;
}> = ({ label, col, active, dir, onSort, align = 'left', className = '', title }) => {
  const on = active === col;
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <th className={`${thCls} p-0 ${className}`} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        onClick={() => onSort(col)}
        title={title ?? `เรียงตาม ${label}`}
        className={`w-full flex items-center gap-1 px-3 py-2.5 ${justify}
                    hover:text-slate-700 transition-colors focus:outline-none
                    focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand-fg)]`}
        style={on ? { color: 'var(--brand-fg)' } : undefined}
      >
        <span className="truncate">{label}</span>
        {on
          ? (dir === 'asc' ? <ArrowUp className="w-3 h-3 shrink-0" /> : <ArrowDown className="w-3 h-3 shrink-0" />)
          : <ArrowDown className="w-3 h-3 shrink-0 opacity-25" />}
      </button>
    </th>
  );
};

/**
 * สลับทิศการเรียงเวลาของหน้าที่แสดงผลเป็น "รายการ" ไม่ใช่ตาราง (บันทึกการแก้ไข / บันทึกระบบ)
 *
 * สองหน้านั้นไม่มีหัวคอลัมน์ให้กด เพราะแต่ละแถวเป็นข้อความยาวไม่เท่ากัน ไม่ได้แบ่งเป็นช่อง
 * สิ่งเดียวที่เรียงแล้วมีความหมายจริงคือเวลา จึงให้ปุ่มเดียวแทนหัวคอลัมน์ทั้งแถว
 * และต้องเรียงที่ SQL เพราะทั้งสองหน้าแบ่งหน้าจาก server เหมือนกัน
 */
export const TimeSortToggle: React.FC<{
  dir: 'asc' | 'desc';
  onChange: (dir: 'asc' | 'desc') => void;
}> = ({ dir, onChange }) => (
  <button
    onClick={() => onChange(dir === 'desc' ? 'asc' : 'desc')}
    title="สลับลำดับเวลาของทั้งรายการ"
    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200
               text-slate-500 hover:text-slate-700 hover:border-slate-300 transition-colors"
  >
    {dir === 'desc' ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
    {dir === 'desc' ? 'ใหม่ → เก่า' : 'เก่า → ใหม่'}
  </button>
);

/** กล่องเลื่อนแนวนอนของตาราง — ตารางกว้างต้องเลื่อนในกล่องตัวเอง ห้ามดันทั้งหน้าให้เลื่อน */
export const TableScroll: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="overflow-x-auto">{children}</div>
);

/* ── แบ่งหน้า ────────────────────────────────────────────────────────────── */

function pageWindow(total: number, current: number): (number | 'gap')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | 'gap')[] = [1];
  if (current > 3) out.push('gap');
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) out.push(i);
  if (current < total - 2) out.push('gap');
  out.push(total);
  return out;
}

/**
 * แถบแบ่งหน้าแบบเดียวของทั้งกลุ่ม
 * ซ้าย = กำลังดูช่วงไหนของทั้งหมด (ตัวเลขนี้สำคัญกว่าปุ่ม — คนใช้ดูว่าเหลืออีกเท่าไร)
 * ขวา = ปุ่มเดินหน้าถอยหลัง + เลขหน้า
 */
export const Pagination: React.FC<{
  page: number;
  pages: number;
  size: number;
  total: number;
  unit?: string;
  onPage: (p: number) => void;
  onSize: (s: number) => void;
}> = ({ page, pages, size, total, unit = 'รายการ', onPage, onSize }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-slate-100">
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span className="tabular-nums">
        {total === 0 ? 0 : (page - 1) * size + 1}–{Math.min(page * size, total)} จาก {formatNumber(total)} {unit}
      </span>
      <select
        aria-label="จำนวนต่อหน้า"
        className="bg-card border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-600 cursor-pointer"
        value={size}
        onChange={(e) => onSize(Number(e.target.value))}
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n} ต่อหน้า</option>
        ))}
      </select>
    </div>

    <div className="flex items-center gap-1">
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="หน้าก่อนหน้า"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      {pageWindow(pages, page).map((p, i) =>
        p === 'gap' ? (
          <span key={'gap' + i} className="px-1.5 text-slate-300">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onPage(p)}
            aria-current={p === page ? 'page' : undefined}
            className={`min-w-8 h-8 px-1.5 rounded-lg text-xs tabular-nums transition-colors ${
              p === page ? 'text-white font-semibold' : 'text-slate-600 hover:bg-slate-100'
            }`}
            style={p === page ? { background: 'var(--brand)' } : undefined}
          >
            {p}
          </button>
        )
      )}
      <button
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="หน้าถัดไป"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  </div>
);

/* ── ป้ายค่าในตาราง ──────────────────────────────────────────────────────── */

function statusTone(code: number): { cls: string; dot: string } {
  if (code >= 500) return { cls: 'bg-red-50 border-red-200 text-red-700', dot: 'bg-red-500' };
  if (code >= 400) return { cls: 'bg-amber-50 border-amber-200 text-amber-700', dot: 'bg-amber-500' };
  if (code >= 300) return { cls: 'bg-blue-50 border-blue-200 text-blue-700', dot: 'bg-blue-400' };
  return { cls: 'bg-emerald-50 border-emerald-200 text-emerald-700', dot: 'bg-emerald-500' };
}

/**
 * รหัสสถานะ HTTP — มีจุดสีนำหน้า แต่ "ตัวเลขคือของจริง" สีเป็นแค่ตัวช่วย
 * (WCAG 1.4.1 ห้ามสื่อความหมายด้วยสีอย่างเดียว)
 */
export const StatusPill: React.FC<{ code: number }> = ({ code }) => {
  const t = statusTone(code);
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-xs tabular-nums ${t.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
      {code}
    </span>
  );
};

/** method ของ request — ความกว้างคงที่เพื่อให้ path ของทุกแถวเริ่มตรงกัน */
export const MethodTag: React.FC<{ method: string }> = ({ method }) => (
  <span className="inline-block w-11 shrink-0 font-mono text-[11px] font-semibold text-slate-400 uppercase">
    {method}
  </span>
);

/** เวลาที่ใช้ — ยิ่งช้ายิ่งเข้ม เพื่อให้กวาดตาหาแถวที่ช้าได้โดยไม่ต้องอ่านตัวเลขทุกแถว */
export const Duration: React.FC<{ ms: number }> = ({ ms }) => {
  const cls =
    ms >= 10_000 ? 'text-red-600 font-semibold'
      : ms >= 3_000 ? 'text-amber-600 font-medium'
        : ms >= 1_000 ? 'text-slate-700'
          : 'text-slate-500';
  return <span className={'tabular-nums ' + cls}>{formatMs(ms)}</span>;
};

/* ── การ์ดตัวเลขสรุป ─────────────────────────────────────────────────────── */

export const StatTile: React.FC<{
  label: string;
  value: string;
  sub?: React.ReactNode;
  danger?: boolean;
}> = ({ label, value, sub, danger }) => (
  <div className={`bg-card rounded-2xl border p-3.5 ${danger ? 'border-red-200' : 'border-slate-200'}`}>
    <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{label}</div>
    <div className={`text-2xl font-semibold mt-1 tabular-nums ${danger ? 'text-red-600' : 'text-slate-800'}`}>
      {value}
    </div>
    {sub && <div className={`text-[11px] mt-1 ${danger ? 'text-red-500' : 'text-slate-400'}`}>{sub}</div>}
  </div>
);
