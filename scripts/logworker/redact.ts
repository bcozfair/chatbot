/**
 * ลบข้อมูลอ่อนไหวออกจากบรรทัด log ก่อนเขียนลง DB
 *
 * ทำไมเป็นเงื่อนไขบังคับ ไม่ใช่ของแถม:
 *   `docker logs` มีของที่ api_logs จงใจไม่เก็บ เช่น
 *     >>> PUT /api/admin/promotions/42 received! body: {...}
 *     >>> POST /api/admin/login received! username: admin
 *   และการเก็บ log นานขึ้น (90-120 วัน ตาม พ.ร.บ.คอมพิวเตอร์) แปลว่า PII ค้างนานขึ้นด้วย
 *   ซึ่งชนกับ PDPA โดยตรง ⇒ ต้องตัดของที่ไม่จำเป็นทิ้งตั้งแต่ตอนเขียน ไม่ใช่ตอนอ่าน
 *
 * หลักการ: ตัดเฉพาะ "ความลับ" (สิ่งที่ใช้สวมรอยได้) ไม่ตัด "ตัวระบุตัวตน" (userId/ip)
 *   เพราะ พ.ร.บ. ม.26 บังคับให้ระบุตัวผู้ใช้บริการได้ — ตัดทิ้งแล้ว log จะไร้ค่าตามกฎหมายทันที
 *   ส่วนการคุมไม่ให้คนทั่วไปเห็น ทำที่ชั้นสิทธิ์ (เปิดให้ role admin เท่านั้น) ไม่ใช่ที่นี่
 *
 * ฟังก์ชันในไฟล์นี้เป็นฟังก์ชันบริสุทธิ์ทั้งหมด — scripts/diag/logWorkerSmoke.ts เทสได้ตรง ๆ
 */

const MASK = '***';

/**
 * แต่ละกฎคือคู่ [รูปแบบ, ตัวแทน] · เรียงจากเฉพาะเจาะจงไปกว้าง
 * ทุกกฎมี global flag และถูกใช้ผ่าน String.replace ซึ่งรีเซ็ต lastIndex ให้เองทุกครั้ง
 */
const RULES: [RegExp, string][] = [
  // Authorization: Bearer <jwt> — ยาวและสวมรอยได้ทันที เป็นตัวที่ต้องตัดก่อนเพื่อน
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],

  // JWT ลอย ๆ ที่ไม่มีคำว่า Bearer นำหน้า (สามท่อนคั่นด้วยจุด ขึ้นต้นด้วย eyJ)
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, MASK],

  // คีย์:ค่า ทั้งใน JSON และในข้อความธรรมดา — ครอบ "x": "y" / x=y / x: y
  [/(["']?(?:password|passwd|pwd|pass|token|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|auth|signature|channel[_-]?secret|reply[_-]?token)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    `$1${MASK}`],

  // ค่า secret ที่โผล่มาในรูป query string
  [/([?&](?:token|key|secret|sig|signature)=)[^&\s]+/gi, `$1${MASK}`],
];

/**
 * ตัดความลับออกจากข้อความ
 *
 * ⚠️ ต้องเรียกกับ "ทุกบรรทัด" ที่จะเขียนลง DB รวมบรรทัดต่อเนื่องของ stack trace ด้วย —
 *   stack trace ของ error จาก axios/fetch มักมี header ของ request ติดมาเต็ม ๆ
 */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

/**
 * ตัดความลับใน object ที่จะเก็บลงคอลัมน์ ctx (jsonb)
 *
 * เดินลึกได้ไม่เกิน 4 ชั้น — ป้องกัน object ที่อ้างอิงวนและจำกัดต้นทุน CPU ของ worker
 * ชั้นที่ลึกกว่านั้นถูกแทนด้วยข้อความบอกตรง ๆ ไม่ใช่หายเงียบ
 */
const SECRET_KEY_RE =
  /^(?:password|passwd|pwd|pass|token|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|auth|signature|channel[_-]?secret|reply[_-]?token|password_hash)$/i;

export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[ลึกเกิน 4 ชั้น]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redactObject(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? MASK : redactObject(v, depth + 1);
  }
  return out;
}
