import React from 'react';

const BRAND = 'var(--brand-fg)';

interface SettingToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** คำอธิบายสั้นต่อท้ายชื่อ — บอกว่าปิดแล้วเกิดอะไรขึ้น */
  hint?: React.ReactNode;
  disabled?: boolean;
}

/**
 * สวิตช์เปิด/ปิดของหน้าตั้งค่า — ใช้ร่วมกันทุกหน้าเพื่อให้หน้าตาและพฤติกรรมเหมือนกันหมด
 * กดได้ทั้งแถบ (ชื่อ + คำอธิบาย) ไม่ใช่แค่ตัวสวิตช์
 */
export const SettingToggle: React.FC<SettingToggleProps> = ({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className="group flex w-full items-start gap-2.5 text-left focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
  >
    <span
      className="relative mt-px inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-offset-2"
      style={{
        backgroundColor: checked ? 'var(--brand)' : 'var(--c-line-strong)',
        ['--tw-ring-color' as string]: BRAND,
      }}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-card shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </span>
    <span className="text-sm">
      <span className="font-bold text-slate-800">{label}</span>
      {hint && <span className="ml-2 text-[11px] font-normal text-slate-500">{hint}</span>}
    </span>
  </button>
);
