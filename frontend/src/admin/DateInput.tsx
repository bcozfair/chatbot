import React from 'react';

/**
 * ช่องเลือกวันที่ที่ "แสดงผลเป็น dd/mm/yyyy เสมอ" ทุกเบราว์เซอร์
 *
 * native <input type="date"> จะโชว์รูปแบบตาม locale ของ OS/เบราว์เซอร์ (บางเครื่องเป็น mm/dd/yyyy)
 * และบังคับด้วย CSS ไม่ได้ — จึงวางเทคนิค overlay: native input โปร่งใสทับด้านบน (ยังได้ปฏิทิน/คีย์บอร์ด/
 * accessibility ครบ) แล้วมี layer ข้อความ dd/mm/yyyy ที่เรา format เองอยู่ด้านล่าง
 *
 * value/onChange ยังคุยกันด้วย ISO 'yyyy-mm-dd' (หรือ '') เหมือน native เดิม — API ไม่ต้องแก้
 * className คุมกรอบ/พื้นหลัง/padding ใส่ที่กล่องนอกกล่องเดียว (native ทับแบบโปร่งใสไม่มีกรอบ)
 * โฟกัสจึงใช้ focus-within บนกล่องนอกได้ตรง ๆ
 */
export interface DateInputProps {
  value: string; // ISO 'yyyy-mm-dd' หรือ ''
  onChange: (isoDate: string) => void;
  className?: string;
  /** ข้อความตอนยังไม่เลือกวัน */
  placeholder?: string;
  min?: string;
  max?: string;
  'aria-label'?: string;
}

/** 'yyyy-mm-dd' → 'dd/mm/yyyy' (คืน '' ถ้า format ไม่ครบ ไม่พยายามเดา) */
function isoToDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

export const DateInput: React.FC<DateInputProps> = ({
  value,
  onChange,
  className = '',
  placeholder = 'วว/ดด/ปปปป',
  min,
  max,
  'aria-label': ariaLabel,
}) => {
  const display = isoToDisplay(value);

  return (
    // กล่องนอก = กล่องที่มีสไตล์จริง (กรอบ/พื้นหลัง/padding มาจาก className ของผู้เรียก) + relative ให้ input ทับได้
    <div className={`${className} relative flex items-center whitespace-nowrap`}>
      <span className={display ? '' : 'text-slate-400'}>{display || placeholder}</span>

      {/* native input จริง วางทับเต็มกล่อง โปร่งใสทั้งตัวอักษร/พื้นหลัง — ได้ปฏิทิน/คีย์บอร์ด/โฟกัส
          แต่มองไม่เห็นตัวเลขของมัน; ซ่อน datetime-edit + ขยาย picker-indicator ให้คลิกทั้งกล่องเปิดปฏิทิน */}
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer rounded-[inherit] border-0 bg-transparent p-0 text-transparent focus:outline-none [color-scheme:light] [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:m-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-datetime-edit]:opacity-0"
      />
    </div>
  );
};
