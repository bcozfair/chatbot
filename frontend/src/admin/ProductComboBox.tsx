// ─────────────────────────────────────────────────────────────────────────────
//  ช่องเลือกสินค้าแบบพิมพ์ค้นหา — ใช้ร่วมกันระหว่างหน้ากฎ MOQ กับหน้ากฎบล็อกสินค้า
//
//  ย้ายออกมาจาก ProductMoqRules.tsx ตอนทำหน้ากฎบล็อก (แผน §5.1)
//  ถ้าก๊อปเป็นตัวที่สองไว้ในไฟล์ใหม่ ทุกการแก้ต้องแก้สองที่ตลอดไป
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Loader2 } from 'lucide-react';

export interface ProductSearchResult {
  product_id: number;
  model: string;
  name: string;
  price: number;
  internal_reference?: string;
}

export interface ProductPick {
  id: number;
  model: string;
  name: string;
  internal_reference?: string;
}

interface ProductComboBoxProps {
  label: string;
  placeholder: string;
  value: ProductPick | null;
  onChange: (val: ProductPick | null) => void;
  error?: boolean;
  disabled?: boolean;
}

export const ProductComboBox: React.FC<ProductComboBoxProps> = ({
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
              ? 'border-[var(--brand-fg)] bg-card ring-2 ring-[var(--brand-fg)]/10 shadow-sm'
              : error
              ? 'border-red-300 bg-red-50/10'
              : value
              ? 'border-slate-300 bg-card'
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
          <div className="absolute z-50 mt-1.5 w-full bg-card border border-slate-200 rounded-xl shadow-xl max-h-56 overflow-y-auto divide-y divide-slate-100">
            {isLoading ? (
              <div className="p-4 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 text-[var(--brand-fg)] animate-spin" />
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
