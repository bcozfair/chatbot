import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Save, RotateCcw } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
//  ท้ายฟอร์มตั้งค่าที่ "แก้แล้วกดบันทึก" — แถบสถานะ + แถบปุ่ม
//
//  ที่มา: CreditPolicy.tsx กับ ShippingFee.tsx ถือโค้ดก้อนนี้คนละสำเนา ยาว 42 บรรทัด
//  และเหมือนกัน **ทุกตัวอักษร** ต่างกันแค่ชื่อตัวแปรที่ส่งให้ปุ่มย้อนกลับ (policy / config)
//  สำเนาไม่เคยพังตอนที่ก๊อป มันพังตอนที่ตัวจริงถูกปรับปรุงแล้วสำเนาไม่ได้ตามไป
//  — เช่นวันที่มีคนเปลี่ยนคำว่า "ยังไม่ได้บันทึก" หรือแก้สีเตือน แล้วแก้ไปหน้าเดียว
//
//  ⚠️ ทำไมเป็น 2 component ไม่ใช่ตัวเดียว: ในหน้าจริง แถบสถานะอยู่ **ในตัวการ์ด**
//     ส่วนแถบปุ่มอยู่ **นอกการ์ด** (ติดขอบล่าง) มี `</div>` ของการ์ดคั่นกลาง
//     component เดียวจึงครอบทั้งก้อนไม่ได้ — ไม่ใช่การแบ่งเพื่อความสวยงาม
//
//  ⚠️ ประโยค "มีผลกับใบที่บันทึก/ยืนยันหลังจากนี้ทันที" ฝังไว้ในนี้ ไม่ได้ทำเป็น prop
//     เพราะผู้ใช้ทั้งสองรายพูดประโยคเดียวกันจริง ๆ — prop ที่ยังไม่มีใครใช้คือการเดาว่า
//     หน้าถัดไปจะต้องการอะไร วันที่มีหน้าที่สามซึ่งความหมายไม่ตรง ค่อยเพิ่ม prop ตอนนั้น
//     (สิ่งที่ห้ามทำคือก๊อปไฟล์นี้ไปแก้ประโยค ซึ่งพาเรากลับไปที่เดิม)
// ─────────────────────────────────────────────────────────────────────────────

interface StatusProps {
  /** ข้อความ error — ว่าง = ไม่มี */
  error: string;
  /** เวลาที่บันทึกสำเร็จล่าสุด (จัดรูปแบบมาแล้ว) — ว่าง = ยังไม่เคยบันทึกในรอบนี้ */
  savedAt: string;
  /** มีการแก้ที่ยังไม่ได้บันทึกไหม — ใช้ซ่อนข้อความ "บันทึกแล้ว" ที่ล้าสมัยไปแล้ว */
  isDirty: boolean;
}

/** แถบสถานะท้ายเนื้อการ์ด — error และ "บันทึกแล้วเมื่อ …" */
export const SettingsStatus: React.FC<StatusProps> = ({ error, savedAt, isDirty }) => (
  <>
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
  </>
);

interface SaveBarProps {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  /** คืนฟอร์มกลับเป็นค่าที่โหลดมา — หน้าเป็นคนรู้ว่า "ค่าที่โหลดมา" คืออะไร */
  onReset: () => void;
}

/** แถบปุ่มติดขอบล่างการ์ด — ป้ายเตือนยังไม่บันทึก + บันทึก + ย้อนกลับ */
export const SettingsSaveBar: React.FC<SaveBarProps> = ({ isDirty, isSaving, onSave, onReset }) => (
  <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-3.5 py-3">
    {isDirty && (
      <span className="mr-auto text-xs font-bold text-amber-600">⚠️ ยังไม่ได้บันทึก</span>
    )}
    <button
      type="button"
      onClick={onSave}
      disabled={!isDirty || isSaving}
      className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
      style={{ backgroundColor: 'var(--brand)' }}
    >
      {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
      บันทึก
    </button>
    <button
      type="button"
      onClick={onReset}
      disabled={!isDirty || isSaving}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <RotateCcw className="w-4 h-4" />
      ย้อนกลับ
    </button>
  </div>
);
