import { useMemo, useState } from 'react';

/**
 * การเรียงลำดับของตารางที่ "โหลดข้อมูลมาครบแล้ว" (ไม่ได้แบ่งหน้าจาก server)
 *
 * ⚠️ ห้ามเอาไปใช้กับตารางที่แบ่งหน้าจาก server — การเรียงเฉพาะแถวในหน้าที่เปิดอยู่
 *   ให้ลำดับที่ผิดโดยที่หน้าจอดูเหมือนถูก (แถวที่ช้าที่สุดจริง ๆ อาจอยู่หน้า 7)
 *   ตารางแบบนั้นต้องส่ง sort/dir ไปให้ SQL เรียงให้ เช่นตารางรายการใน ApiLogs
 */

export type SortDir = 'asc' | 'desc';

/** ค่าที่เอาไปเทียบของแต่ละคอลัมน์ — null = ไม่มีค่า ถูกดันไปท้ายเสมอไม่ว่าเรียงทางไหน */
export type SortAccessors<T> = Record<string, (row: T) => string | number | null>;

function compare(a: string | number | null, b: string | number | null): number {
  // "ไม่มีค่า" ไม่ใช่ "ค่าน้อยสุด" — ดันไปท้ายทั้งสองทิศ (ตรงกับ NULLS LAST ฝั่ง SQL)
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // เทียบแบบไทย — ชื่อ endpoint ผสมไทย/อังกฤษ localeCompare ให้ลำดับที่คนอ่านคาดเดาได้
  return String(a).localeCompare(String(b), 'th', { numeric: true });
}

export function useTableSort<T>(
  rows: T[],
  accessors: SortAccessors<T>,
  initial: { col: string; dir: SortDir },
) {
  const [col, setCol] = useState(initial.col);
  const [dir, setDir] = useState<SortDir>(initial.dir);

  const sorted = useMemo(() => {
    const get = accessors[col];
    if (!get) return rows;
    // คัดลอกก่อนเรียงเสมอ — .sort() แก้อาร์เรย์เดิมในที่ ซึ่งจะไปแก้ state ที่ React ถืออยู่
    const out = [...rows].sort((a, b) => compare(get(a), get(b)));
    return dir === 'asc' ? out : out.reverse();
  }, [rows, accessors, col, dir]);

  /**
   * กดหัวคอลัมน์เดิม = สลับทิศ · กดคอลัมน์ใหม่ = เริ่มด้วยทิศที่ "มีประโยชน์ที่สุด"
   * ตัวเลขเริ่มจากมากไปน้อย (คนกดดูอันดับสูงสุด) ตัวอักษรเริ่มจาก ก→ฮ
   */
  const toggle = (next: string, numeric = true) => {
    if (next === col) { setDir(d => (d === 'asc' ? 'desc' : 'asc')); return; }
    setCol(next);
    setDir(numeric ? 'desc' : 'asc');
  };

  return { sorted, col, dir, toggle };
}
