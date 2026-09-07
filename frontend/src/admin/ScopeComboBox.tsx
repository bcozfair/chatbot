// ─────────────────────────────────────────────────────────────────────────────
//  Dropdown แบบพิมพ์ค้นหาสำหรับค่าขอบเขต (ฝ่ายผลิต / ยี่ห้อ / ซีรีส์)
//
//  ย้ายออกมาจาก QuotationRules.tsx ตอนทำหน้ากฎบล็อกสินค้า — สองหน้านั้นใช้ตัวเดียวกัน
//  ถ้าก๊อปไว้สองที่ ทุกการแก้ต้องแก้สองที่ตลอดไป
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useRef } from 'react';
import { X, ChevronDown } from 'lucide-react';

export function ScopeComboBox({
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
          ? 'border-[var(--brand-fg)] bg-card ring-2 ring-[var(--brand-fg)]/10'
          : value
            ? 'border-slate-300 bg-card'
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
        <div className="absolute z-50 mt-1 w-full bg-card border border-slate-200 rounded-xl shadow-lg overflow-hidden">
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
                    ? 'bg-emerald-50 text-[var(--brand-fg)] font-semibold'
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
