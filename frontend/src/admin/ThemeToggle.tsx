import React, { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

/**
 * ปุ่มสลับธีมมืด/สว่าง — ใช้ซ้ำได้ทุกที่ วางตรงไหนก็ได้
 *
 * ตัวธีมจริงอยู่ใน index.css: เซ็ต data-theme บน <html> แล้วตัวแปรสีทั้งชุด
 * จะสลับให้เอง คอมโพเนนต์อื่นไม่ต้องรู้เรื่องธีมเลย
 *
 * ค่าเริ่มต้นคือธีมมืด · จำค่าที่เลือกไว้ใน localStorage
 * (ตัวเซ็ตธีมตอนโหลดหน้าอยู่ใน <head> ของ admin.html/index.html
 *  เพื่อไม่ให้จอวาบขาวก่อน React จะทำงาน)
 */
type Theme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'admin-theme';

/** อ่านธีมที่เลือกไว้ — localStorage พังได้ในโหมดส่วนตัว จึงต้องกัน throw */
function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** รางสวิตช์ — สัดส่วนล้อ SettingToggle ของหน้าตั้งค่า แต่ใหญ่ขึ้นเล็กน้อยให้ใส่ไอคอนได้
    เขียวจาง + ขอบ ทำให้เห็นว่าเป็นปุ่มทั้งธีมมืดและสว่าง */
const BASE_CLASS =
  'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border ' +
  'border-[var(--brand-fg)]/30 bg-[var(--brand-fg)]/10 ' +
  'hover:border-[var(--brand-fg)]/55 hover:bg-[var(--brand-fg)]/20 ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-fg)]/50';

/** className ที่ส่งเข้ามาเป็นส่วนเสริม (เช่นตำแหน่ง) ไม่ทับสไตล์พื้นฐาน */
export const ThemeToggle: React.FC<{ className?: string }> = ({ className }) => {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // เก็บไม่ได้ก็ปล่อย — ธีมยังสลับได้ในหน้านี้ แค่ไม่จำข้ามรอบ
    }
  }, [theme]);

  const isDark = theme === 'dark';
  const label = isDark ? 'สลับเป็นธีมสว่าง' : 'สลับเป็นธีมมืด';

  // aria-checked ผูกกับ "ธีมสว่าง" ให้ตรงกับที่ตาเห็น: ติ๊กถูก = ปุ่มเลื่อนไปขวา
  return (
    <button
      id="admin-theme-toggle-btn"
      type="button"
      role="switch"
      aria-checked={!isDark}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={label}
      aria-label={label}
      className={className ? `${BASE_CLASS} ${className}` : BASE_CLASS}
    >
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-card text-[var(--brand-fg)] shadow transition-transform ${
          isDark ? 'translate-x-[2px]' : 'translate-x-[20px]'
        }`}
      >
        {isDark ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
      </span>
    </button>
  );
};
