import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Truck,
  Save,
  RotateCcw,
  ChevronRight,
} from 'lucide-react';

const BRAND = '#009032';

interface ShippingFeeConfig {
  id: number;
  is_active: boolean;
  threshold_before_vat: string | number;
  fee_price: string | number;
  fee_quantity: string | number;
  default_item_name: string;
  product_internal_reference: string;
  updated_at: string;
  // มาจากการ join แถวสินค้าใน products (ข้อมูลที่ใช้ map กลับ Odoo — อ่านอย่างเดียว)
  product_template_id: number | null;
  model: string | null;
  product_name: string | null;
  product_group: string | null;
  product_category: string | null;
  product_sub_category: string | null;
}

/** ค่าที่กรอกในฟอร์ม — เก็บเป็น string เพื่อให้ลบทั้งช่องแล้วพิมพ์ใหม่ได้ */
interface FormState {
  is_active: boolean;
  threshold_before_vat: string;
  fee_price: string;
  fee_quantity: string;
  default_item_name: string;
}

function toForm(cfg: ShippingFeeConfig): FormState {
  return {
    is_active: cfg.is_active,
    threshold_before_vat: String(Number(cfg.threshold_before_vat)),
    fee_price: String(Number(cfg.fee_price)),
    fee_quantity: String(Number(cfg.fee_quantity)),
    default_item_name: cfg.default_item_name,
  };
}

export const ShippingFee: React.FC = () => {
  const { token } = useAuth();
  const [config, setConfig] = useState<ShippingFeeConfig | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');

  // setState ทุกตัวต้องอยู่หลัง await — เรียกแบบ sync ใน effect จะทำให้ render ซ้อนกัน
  // (กฎ react-hooks/set-state-in-effect)
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('/api/admin/shipping-fee-config', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await resp.json();
        if (cancelled) return;
        if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
        setConfig(body);
        setForm(toForm(body));
        setError('');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'โหลดค่าตั้งค่าไม่สำเร็จ');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const isDirty =
    !!config && !!form && JSON.stringify(form) !== JSON.stringify(toForm(config));

  const handleSave = async () => {
    if (!form) return;
    setIsSaving(true);
    setError('');
    setSavedAt('');
    try {
      const resp = await fetch('/api/admin/shipping-fee-config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          is_active: form.is_active,
          threshold_before_vat: form.threshold_before_vat,
          fee_price: form.fee_price,
          fee_quantity: form.fee_quantity,
          default_item_name: form.default_item_name,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      setConfig(body);
      setForm(toForm(body));
      setSavedAt(new Date().toLocaleTimeString('th-TH'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: BRAND }} />
      </div>
    );
  }

  if (!config || !form) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <div className="font-bold">โหลดค่าตั้งค่าค่าขนส่งไม่ได้</div>
            <div className="mt-1">{error || 'ไม่พบข้อมูล'}</div>
          </div>
        </div>
      </div>
    );
  }

  const numberField = (
    label: string,
    field: 'threshold_before_vat' | 'fee_price' | 'fee_quantity',
    hint: string,
    unit: string,
  ) => (
    <div>
      <label className="block text-xs font-bold text-slate-600 mb-1.5">{label}</label>
      <div className="relative">
        <input
          type="number"
          min={0}
          step="any"
          value={form[field]}
          onChange={(e) => setForm({ ...form, [field]: e.target.value })}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-12 text-sm focus:outline-none focus:ring-2"
          style={{ ['--tw-ring-color' as string]: BRAND }}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
          {unit}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{hint}</p>
    </div>
  );

  return (
    <div className="max-w-3xl space-y-3">
      {/* อธิบายกฎให้แอดมินเข้าใจก่อนแก้ตัวเลข — ย่อสั้นเก็บใจความหลัก */}
      <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'rgba(0, 144, 50, 0.10)' }}
        >
          <Truck className="h-4 w-4" style={{ color: BRAND }} />
        </div>
        <div className="text-[13px] leading-relaxed text-slate-600">
          <span className="font-bold text-slate-900">ค่าขนส่งอัตโนมัติ</span> — เพิ่มรายการให้เองเมื่อ
          <b> ลูกค้าไม่มีเครดิต</b> (เทอมไม่ใช่ “<span className="font-mono">xx Days</span>” เช่น Cash /
          เช็คล่วงหน้า / ไม่ระบุ) และ <b>ยอดก่อน VAT หลังส่วนลด รวมทุกใบ</b> ต่ำกว่าเกณฑ์ และถอดออกเองเมื่อถึงเกณฑ์
          · เซลล์แก้ได้แค่ <b>ชื่อรายการ</b> กับ <b>ราคา</b> จำนวนถูกล็อก
        </div>
      </div>

      {/* ฟอร์มค่าคงที่ */}
      <div className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3.5">
        <label className="flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300"
            style={{ accentColor: BRAND }}
          />
          <span className="text-sm font-bold text-slate-800">เปิดใช้งานกฎค่าขนส่ง</span>
          <span className="text-[11px] text-slate-500">
            (ปิด = ระบบจะไม่เพิ่มรายการค่าขนส่งให้ใบใหม่ และถอดออกจากใบร่างที่ยังไม่ยืนยัน)
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          {numberField(
            'เกณฑ์ยอดก่อน VAT',
            'threshold_before_vat',
            'ยอดที่ “ต่ำกว่า” ค่านี้จึงคิดค่าขนส่ง — ยอดเท่ากับค่านี้พอดีจะไม่คิด',
            'บาท',
          )}
          {numberField('ราคาค่าขนส่ง', 'fee_price', 'ราคาต่อหน่วยตั้งต้น — เซลล์ปรับรายใบได้', 'บาท')}
          {numberField('จำนวน', 'fee_quantity', 'ล็อกไว้ เซลล์แก้ไม่ได้', 'หน่วย')}
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-600 mb-1.5">
            ชื่อรายการตั้งต้น
          </label>
          <input
            type="text"
            value={form.default_item_name}
            onChange={(e) => setForm({ ...form, default_item_name: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2"
            style={{ ['--tw-ring-color' as string]: BRAND }}
          />
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            ชื่อที่จะแสดงในใบเสนอราคาและ PDF — ใช้ตอนสร้างรายการใหม่เท่านั้น
            ใบที่เซลล์ตั้งชื่อเองไว้แล้วจะไม่ถูกเปลี่ยนย้อนหลัง
          </p>
        </div>
      </div>

      {/* ข้อมูล Odoo — อ่านอย่างเดียว แก้ผ่านตาราง products/migration เท่านั้น
          กรณี map ไม่เจอ = คำเตือนสำคัญ โชว์เต็มเสมอ; ปกติยุบเป็น disclosure ประหยัดที่ */}
      {config.product_template_id === null ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            ไม่พบสินค้าที่ <span className="font-mono">{config.product_internal_reference}</span> ในตาราง
            products — กฎจะไม่ทำงานจนกว่าจะรัน migration
          </span>
        </div>
      ) : (
        <details className="group rounded-xl border border-slate-200 bg-slate-50 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer items-center gap-1.5 px-3.5 py-2.5 text-xs font-bold text-slate-600 select-none">
            <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform group-open:rotate-90" />
            ข้อมูลที่ใช้ map กลับ Odoo (แก้ที่นี่ไม่ได้)
          </summary>
          <dl className="grid gap-x-6 gap-y-1.5 px-3.5 pb-3 text-xs sm:grid-cols-2">
            {[
              ['Internal Reference', config.product_internal_reference],
              ['Name (Odoo)', config.product_name],
              ['Model', config.model],
              ['Product Group', config.product_group],
              ['Product Category', config.product_category],
              ['Product Sub Category', config.product_sub_category],
            ].map(([label, value]) => (
              <div key={label as string} className="flex justify-between gap-3 border-b border-slate-200 py-1">
                <dt className="text-slate-500">{label}</dt>
                <dd className="font-mono text-slate-800 text-right break-all">{value || '-'}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {savedAt && !isDirty && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>บันทึกแล้วเมื่อ {savedAt} — มีผลกับใบที่บันทึก/ยืนยันหลังจากนี้ทันที</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
          style={{ backgroundColor: BRAND }}
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          บันทึก
        </button>
        <button
          type="button"
          onClick={() => setForm(toForm(config))}
          disabled={!isDirty || isSaving}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw className="w-4 h-4" />
          ย้อนกลับ
        </button>
        {isDirty && (
          <span className="text-xs font-bold text-amber-600">⚠️ ยังไม่ได้บันทึก</span>
        )}
      </div>
    </div>
  );
};
