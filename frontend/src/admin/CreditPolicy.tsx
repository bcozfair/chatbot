import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { SettingToggle } from './SettingToggle';
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  Save,
  RotateCcw,
} from 'lucide-react';

const BRAND = '#009032';

/** ตรงกับ CHECK ของตาราง quotation_credit_policy — เคยมี 'warn' ปลดออกแล้ว 2026-08-25 */
type CreditPolicyMode = 'off' | 'block';

interface CreditPolicy {
  mode: CreditPolicyMode;
  dormant_months: number;
}

/** ค่าที่กรอกในฟอร์ม — เดือนเก็บเป็น string เพื่อให้ลบทั้งช่องแล้วพิมพ์ใหม่ได้ */
interface FormState {
  mode: CreditPolicyMode;
  dormant_months: string;
}

function toForm(p: CreditPolicy): FormState {
  return { mode: p.mode, dormant_months: String(p.dormant_months) };
}

export const CreditPolicy: React.FC = () => {
  const { token } = useAuth();
  const [policy, setPolicy] = useState<CreditPolicy | null>(null);
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
        const resp = await fetch('/api/admin/credit-policy', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await resp.json();
        if (cancelled) return;
        if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
        setPolicy(body);
        setForm(toForm(body));
        setError('');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'โหลดเกณฑ์เครดิตไม่สำเร็จ');
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
    !!policy && !!form && JSON.stringify(form) !== JSON.stringify(toForm(policy));

  const handleSave = async () => {
    if (!form) return;
    setIsSaving(true);
    setError('');
    setSavedAt('');
    try {
      const resp = await fetch('/api/admin/credit-policy', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: form.mode,
          dormant_months: Number(form.dormant_months),
        }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `เซิร์ฟเวอร์ตอบรหัส ${resp.status}`);
      setPolicy(body);
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

  if (!policy || !form) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <div>
            <div className="font-bold">โหลดเกณฑ์เครดิตไม่ได้</div>
            <div className="mt-1">{error || 'ไม่พบข้อมูล'}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    // ทั้งหน้าเป็นการ์ดใบเดียว: แถบคำอธิบาย → เนื้อฟอร์ม → แถบปุ่ม
    // h-full ให้การ์ดสูงเท่าคอลัมน์ เพราะหน้าตั้งค่าวางสองหน้านี้ซ้าย-ขวา
    <div className="flex h-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      {/* อธิบายกฎให้แอดมินเข้าใจก่อนแก้ตัวเลข */}
      <div className="flex items-start gap-3 border-b border-slate-100 bg-slate-50/60 p-3.5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'rgba(0, 144, 50, 0.10)' }}
        >
          <ShieldAlert className="h-4 w-4" style={{ color: BRAND }} />
        </div>
        <div className="text-[13px] leading-relaxed text-slate-600">
          <span className="font-bold text-slate-900">ระงับบริษัทที่ไม่มีคำสั่งซื้อมานาน</span> —
          ตรวจเฉพาะ <b>ลูกค้าเครดิตและเช็คล่วงหน้า</b> เท่านั้น (Cash และลูกค้าที่ไม่ได้ระบุเงื่อนไข
          การชำระเงินใน Odoo ไม่ถูกบล็อก) · นับเฉพาะใบที่ <b>ออกบิลแล้วหรือรอออกบิล</b> —
          ใบที่ยกเลิกหรือยังไม่ถึงคิววางบิลไม่นับ · <b>ลูกค้าที่ยังไม่เคยมีบิลเลยไม่ถูกบล็อก</b>
          (ลูกค้าใหม่ต้องเสนอราคาได้) · นับรวมทุกรหัสบริษัทที่เป็นนิติบุคคลเดียวกัน —
          ทั้งวันที่บิลและเงื่อนไขเครดิต ใช้ค่าของทั้งกลุ่มร่วมกัน
        </div>
      </div>

      {/* flex-1 = เนื้อฟอร์มยืดเติมความสูงที่เหลือ แถบปุ่มของสองคอลัมน์จึงอยู่ระดับเดียวกัน */}
      <div className="flex-1 space-y-3.5 p-3.5">
        <SettingToggle
          checked={form.mode === 'block'}
          onChange={(next) => setForm({ ...form, mode: next ? 'block' : 'off' })}
          label="เปิดใช้งานกฎระงับบริษัทที่เงียบนาน"
          hint="(เปิด = ห้ามออกใบเสนอราคาตั้งแต่ตอนผูกบริษัทเข้าใบ · ปิด = ไม่ตรวจเลย ระบบทำงานเหมือนก่อนมีกฎนี้)"
        />

        <div>
          <label className="block text-xs font-bold text-slate-600 mb-1.5">
            เกณฑ์ระยะเวลาที่ถือว่า “เงียบ”
          </label>
          <div className="relative max-w-[200px]">
            <input
              type="number"
              min={1}
              max={240}
              step={1}
              value={form.dormant_months}
              onChange={(e) => setForm({ ...form, dormant_months: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-14 text-sm focus:outline-none focus:ring-2"
              style={{ ['--tw-ring-color' as string]: BRAND }}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
              เดือน
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            ไม่มีใบที่ออกบิล “นานกว่า” ค่านี้จึงเข้าเกณฑ์ (12 = 1 ปี) — เปลี่ยนแล้วมีผลทันที
            ไม่ต้องรอรอบ sync
          </p>
        </div>

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
      </div>

      {/* แถบปุ่มติดขอบล่างการ์ด */}
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-3.5 py-3">
        {isDirty && (
          <span className="mr-auto text-xs font-bold text-amber-600">⚠️ ยังไม่ได้บันทึก</span>
        )}
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
          onClick={() => setForm(toForm(policy))}
          disabled={!isDirty || isSaving}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw className="w-4 h-4" />
          ย้อนกลับ
        </button>
      </div>
    </div>
  );
};
