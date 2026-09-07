/**
 * เวลาโซนไทย — จุดเดียวของระบบที่แปลง Date เป็น "วัน/เวลาแบบไทย"
 *
 * ทำไมต้องมีไฟล์นี้: `new Date().getDate()/getMonth()/getFullYear()` อ่านตาม TimeZone ของโปรเซส
 * ซึ่งบน production เป็น UTC → ช่วง 00:00–07:00 น. ไทยจะได้ "วันก่อนหน้า" เงียบ ๆ
 * (วันที่บนหัว PDF เพี้ยน, งวด yymm ของเลขใบเสนอราคาข้ามเดือนแล้วติดถาวร)
 * โค้ดที่ต้องการวันแบบไทยต้องเรียกผ่านที่นี่เท่านั้น ห้ามพึ่ง TZ ของโปรเซส
 *
 * ใช้ locale 'en-GB' ไม่ใช่ 'th-TH' — th-TH ใช้ปฏิทินพุทธเป็นค่าตั้งต้น จะได้ปี 2569 แทน 2026
 * (ถ้าต้องการ พ.ศ. ให้แปลงที่ชั้นแสดงผล ไม่ใช่ที่นี่)
 */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const THAI_PARTS_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok',
  hour12: false,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export interface ThaiDateParts {
  /** ปี ค.ศ. 4 หลัก */
  year: string;
  /** เดือน 01–12 */
  month: string;
  /** วัน 01–31 */
  day: string;
  /** ชั่วโมง 00–23 */
  hour: string;
  /** นาที 00–59 */
  minute: string;
  /** วันในสัปดาห์ 0=อาทิตย์ … 6=เสาร์ */
  weekday: number;
}

/**
 * ส่วนประกอบวัน/เวลาของ `at` ตามเวลาไทย (ค่าเลขศูนย์นำครบทุกช่อง เทียบเป็นสตริงได้ตรง ๆ)
 * โยน error เมื่อได้ Date ที่ไม่ถูกต้อง — ดีกว่าปล่อยให้ค่าเพี้ยนไหลไปลง DB/เอกสาร
 */
export function thaiDateParts(at: Date = new Date()): ThaiDateParts {
  if (Number.isNaN(at.getTime())) {
    throw new Error('[thaiDateParts] ได้ Date ที่ไม่ถูกต้อง (Invalid Date)');
  }
  const parts = THAI_PARTS_FORMAT.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  let hour = get('hour');
  if (hour === '24') hour = '00'; // Intl อาจคืน 24 ตอนเที่ยงคืน
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** วันที่แบบไทยรูปแบบ 'dd/mm/yyyy' (ปี ค.ศ.) — ใช้บนเอกสาร PDF */
export function thaiDateDMY(at: Date = new Date()): string {
  const { year, month, day } = thaiDateParts(at);
  return `${day}/${month}/${year}`;
}

/** งวด 'yymm' ตามวันไทย — ใช้เป็นคีย์เดือนของเลขที่ใบเสนอราคา */
export function thaiYearMonth(at: Date = new Date()): string {
  const { year, month } = thaiDateParts(at);
  return `${year.slice(-2)}${month}`;
}

/**
 * เวลาไทยรูปแบบ 'HH:MM:SS' — ใช้เป็นหมุดเวลาบน log (รอบ sync เริ่ม/จบ, ตำแหน่ง cursor)
 * มี formatter แยกจาก THAI_PARTS_FORMAT เพราะต้องการวินาที ซึ่ง thaiDateParts ไม่ได้ใช้
 */
const THAI_CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function thaiClock(at: Date = new Date()): string {
  if (Number.isNaN(at.getTime())) {
    throw new Error('[thaiClock] ได้ Date ที่ไม่ถูกต้อง (Invalid Date)');
  }
  return THAI_CLOCK_FORMAT.format(at).replace(/^24:/, '00:'); // Intl อาจคืน 24 ตอนเที่ยงคืน
}
