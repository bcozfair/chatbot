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

  return (
    <button
      id="admin-theme-toggle-btn"
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={label}
      aria-label={label}
      className={
        className ??
        'flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-[var(--brand-fg)] hover:bg-[var(--brand)]/10 transition-all active:scale-[0.95] shrink-0'
      }
    >
      {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
};
