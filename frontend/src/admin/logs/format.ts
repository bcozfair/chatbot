/**
 * ตัวช่วยแสดงผลร่วมของ 3 หน้าใหม่ในกลุ่ม "บันทึกและรายงาน"
 *
 * ⚠️ ไฟล์นี้ "คัดลอก" มาจาก ApiLogs.tsx โดยตั้งใจ ไม่ได้ import ข้ามไป
 *   ApiLogs.tsx ใช้งานได้ดีอยู่แล้วและเป็นหน้าที่คนใช้ทุกวัน · การรีแฟกเตอร์เพื่อ "ไม่ให้โค้ดซ้ำ"
 *   คือการไปแตะของที่ทำงานอยู่เพื่อความสวยของโค้ด ซึ่งไม่มีใครได้อะไรกลับมา
 *   ถ้าวันหน้าอยากรวมจริง ๆ ค่อยทำตอนที่มีเหตุผลอื่นต้องแตะไฟล์นั้นอยู่แล้ว
 */

/** ข้อความ error จาก catch — catch ให้ unknown เสมอ ห้ามใช้ any (กติกา lint ของ frontend) */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * ปัก Asia/Bangkok ไว้เสมอ ไม่ใช้ TimeZone ของเบราว์เซอร์
 * ต้องตรงกับตัวกรองวันที่ฝั่ง SQL ที่ตีความเป็นวันตามเวลาไทย
 * ไม่งั้นเครื่องที่ตั้งโซนอื่นจะเห็นวันในตารางไม่ตรงกับช่วงที่กรอง
 */
export function formatDateTime(s: string | null): string {
  if (!s) return '-';
  return new Date(s).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function formatDate(s: string | null): string {
  if (!s) return '-';
  return new Date(`${s}T00:00:00+07:00`).toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', year: '2-digit', month: 'short', day: 'numeric',
  });
}

/** เวลาสัมพัทธ์สำหรับอ่านเร็ว ๆ — เวลาเต็มอยู่ใน tooltip ของทุกจุดที่ใช้ค่านี้ */
export function relativeTime(s: string | null): string {
  if (!s) return '-';
  const diff = Date.now() - new Date(s).getTime();
  if (diff < 0) return 'อีกสักครู่';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'เมื่อครู่';
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชั่วโมงที่แล้ว`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} วันที่แล้ว` : formatDate(s.slice(0, 10));
}

export function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} วิ`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} วิ`;
  return `${ms} ms`;
}

export function formatBytes(b: number | string | null): string {
  if (b === null || b === undefined) return '-';
  const n = typeof b === 'string' ? Number(b) : b;
  if (!Number.isFinite(n)) return '-';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function formatNumber(n: number | null): string {
  return n === null || n === undefined ? '-' : n.toLocaleString('th-TH');
}

/**
 * ระดับความรุนแรง — สีชุดเดียวใช้ร่วมกันทั้ง 3 หน้า
 *
 * ⚠️ ทุกที่ที่ใช้สีต้องมี "ข้อความกำกับ" ด้วยเสมอ ห้ามสื่อความหมายด้วยสีอย่างเดียว
 *   (WCAG 1.4.1 — คนตาบอดสีประมาณ 8% ของผู้ชายต้องอ่านออกเท่ากัน)
 *   ค่าที่คืนจึงมี label มาให้ในตัว ไม่ใช่แค่ className
 */
export interface LevelStyle {
  label: string;
  cls: string;
  dot: string;
}

const LEVEL_STYLES: Record<string, LevelStyle> = {
  fatal: { label: 'ร้ายแรง', cls: 'bg-red-100 border-red-300 text-red-800',        dot: 'bg-red-600' },
  error: { label: 'ผิดพลาด', cls: 'bg-red-50 border-red-200 text-red-700',         dot: 'bg-red-500' },
  warn:  { label: 'เตือน',   cls: 'bg-amber-50 border-amber-200 text-amber-700',   dot: 'bg-amber-500' },
  info:  { label: 'ข้อมูล',  cls: 'bg-blue-50 border-blue-200 text-blue-700',      dot: 'bg-blue-500' },
  debug: { label: 'ดีบัก',   cls: 'bg-slate-50 border-slate-200 text-slate-600',   dot: 'bg-slate-400' },
};

export function levelStyle(level: string): LevelStyle {
  return LEVEL_STYLES[level] ?? { label: level, cls: 'bg-slate-50 border-slate-200 text-slate-600', dot: 'bg-slate-400' };
}

/** ที่มาของ "ชื่อคนทำ" — ต้องแสดงให้เห็นเสมอ ตัวเลขและชื่อต้องไม่โกหกว่ารู้แน่กว่าที่รู้จริง */
export interface ActorStyle {
  label: string;
  hint: string;
  cls: string;
}

export function actorStyle(actorType: string, actorSource: string | null): ActorStyle {
  if (actorType === 'admin' && actorSource === 'direct') {
    return { label: 'ยืนยันแล้ว', hint: 'แอปบอกชื่อผู้ทำมาโดยตรง — แม่นยำ 100%',
             cls: 'bg-emerald-50 border-emerald-200 text-emerald-700' };
  }
  if (actorType === 'admin' && actorSource === 'correlated') {
    return { label: 'จับคู่จากเวลา', hint: 'หาจาก request ของแอดมินที่ครอบเวลาที่แก้พอดี — แม่นสูงแต่ไม่ใช่ 100%',
             cls: 'bg-sky-50 border-sky-200 text-sky-700' };
  }
  if (actorType === 'pending') {
    return { label: 'กำลังหา', hint: 'logworker ยังไม่ได้ประมวลผลแถวนี้ (ปกติใช้เวลาไม่เกิน 1 นาที)',
             cls: 'bg-slate-50 border-slate-200 text-slate-500' };
  }
  if (actorType === 'ambiguous') {
    return { label: 'แยกไม่ออก', hint: 'ช่วงเวลานั้นมีแอดมินมากกว่า 1 คนยิงคำสั่งเขียนพร้อมกัน',
             cls: 'bg-amber-50 border-amber-200 text-amber-700' };
  }
  return { label: 'ไม่ทราบ', hint: 'ไม่พบ request ของแอดมินที่ครอบเวลานี้ — น่าจะแก้จาก psql หรือ script ตรง ๆ',
           cls: 'bg-slate-100 border-slate-300 text-slate-600' };
}

/** ชื่อภาษาไทยของชนิดข้อมูลที่ถูกแก้ — ไม่มีในรายการก็แสดงชื่อดิบ ไม่ใช่ซ่อน */
const ENTITY_LABELS: Record<string, string> = {
  promotion: 'โปรโมชันส่วนลด',
  quotation_rule: 'เงื่อนไขใบเสนอราคา',
  optional_link: 'สินค้าพ่วงเสริม',
  stock_rule: 'กฎระงับเมื่อหมดสต็อก',
  moq_rule: 'ขั้นต่ำสั่งซื้อ',
  shipping_fee: 'ค่าขนส่ง',
  credit_policy: 'นโยบายเครดิต',
  blacklist: 'บัญชีห้ามเสนอราคา',
  admin_user: 'ผู้ใช้งานระบบ',
  salesperson: 'ข้อมูลพนักงาน',
  sync_setting: 'ตั้งค่าการ sync',
  traffic: 'รายงานการใช้งาน',
  audit_log: 'บันทึกการแก้ไข',
  system_log: 'บันทึกระบบ',
};

export function entityLabel(t: string | null): string {
  if (!t) return '-';
  return ENTITY_LABELS[t] ?? t;
}

const OP_LABELS: Record<string, string> = {
  insert: 'เพิ่ม', update: 'แก้ไข', delete: 'ลบ', view: 'เข้าดู', export: 'ส่งออก',
};

/** 'promotion.update' → 'แก้ไข โปรโมชันส่วนลด' — ผู้ใช้ไม่ควรต้องอ่านชื่อตารางในระบบ */
export function actionLabel(action: string): string {
  const dot = action.lastIndexOf('.');
  if (dot < 0) return action;
  const op = OP_LABELS[action.slice(dot + 1)];
  const ent = ENTITY_LABELS[action.slice(0, dot)];
  return op && ent ? `${op}${ent}` : action;
}

/** แสดงค่าใน before/after ให้อ่านออก — null ต้องเห็นชัดว่า "ว่าง" ไม่ใช่หายไป */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '(ว่าง)';
  if (typeof v === 'boolean') return v ? 'ใช่' : 'ไม่ใช่';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s === '' ? '(ว่าง)' : s;
}

/** ส่วนต่างเป็นเปอร์เซ็นต์เทียบช่วงก่อนหน้า — ช่วงก่อนหน้าเป็น 0 คือ "เทียบไม่ได้" ไม่ใช่ +∞ */
export function delta(now: number, before: number): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (before === 0) return { text: now === 0 ? '—' : 'ใหม่', dir: 'flat' };
  const pct = ((now - before) / before) * 100;
  if (Math.abs(pct) < 0.5) return { text: '±0%', dir: 'flat' };
  return { text: `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`, dir: pct > 0 ? 'up' : 'down' };
}

export const inputCls =
  'w-full bg-card border border-slate-200 focus:border-[var(--brand-fg)] focus:ring-2 focus:ring-[var(--brand-fg)]/10' +
  ' focus:outline-none rounded-xl px-4 py-2.5 text-sm text-slate-800 transition-all';

export const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];

/**
 * ดาวน์โหลด CSV จาก endpoint ที่ต้องมี Authorization header
 *
 * ⚠️ ใช้ <a href> ตรง ๆ ไม่ได้ — เบราว์เซอร์ไม่ได้แนบ Bearer token ไปกับการนำทางปกติ
 *   ผู้ใช้จะได้ไฟล์ที่มีข้อความ 401 อยู่ข้างในแทนข้อมูล ซึ่งดูเผิน ๆ เหมือนดาวน์โหลดสำเร็จ
 *   จึงต้อง fetch เอง แล้วค่อยสร้างลิงก์ชั่วคราวจาก blob
 */
export async function downloadCsv(url: string, token: string | null, filename: string): Promise<void> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // คืน memory ทันที — blob ของไฟล์ 50,000 แถวไม่ใช่ของเล็ก และผู้ใช้กดส่งออกซ้ำได้เรื่อย ๆ
  URL.revokeObjectURL(href);
}
