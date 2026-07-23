import { createChatCompletion } from '../config/clients.js';
import { pool } from '../config/db.js';
import {
  searchCustomersByReferencePatterns,
  searchCustomersByNamePatterns,
  getContactsByCustomerId,
  getCompanyAddressRows,
  getContactNamesByCustomerIds,
  getConfirmedQuotationCounts,
  findContactsWithCustomerByName,
} from '../db/repositories.js';
import Fuse from 'fuse.js';

// Kill-switches (safety valves — เซ็ต =1 เพื่อกลับไปใช้ pipeline เดิมเป๊ะโดยไม่ต้อง rollback code)
const isNewSearchDisabled = () => process.env.DISABLE_NEW_SEARCH === '1';
const isAiMatchDisabled = () => process.env.DISABLE_AI_MATCH === '1';

const STOP_WORDS = new Set([
  'บริษัท', 'จำกัด', 'มหาชน', 'หจก', 'บจก', 'ห้างหุ้นส่วน', 'สำนักงานใหญ่', 'สาขา',
  'แอนด์', 'and',
  'เซอร์วิส', 'service', 'services',
  'ซัพพลาย', 'supply', 'supplies',
  'อินเตอร์', 'inter',
  'เทรดดิ้ง', 'trading',
  'เอ็นจิเนียริ่ง', 'engineering',
  'ประเทศไทย', 'thailand',
  'กรุ๊ป', 'group',
  'ไทย', 'thai',
  'บิลดิ้ง', 'building',
  'มาเก็ตติ้ง', 'marketing',
  'โลจิสติกส์', 'logistics',
  'โซลูชั่น', 'solution', 'solutions',
  'คอนสตรัคชั่น', 'construction',
  'โฮลดิ้ง', 'holding', 'holdings',
  'แมเนจเม้นท์', 'management',
  'ซิสเต็ม', 'system', 'systems',
  'พาร์ท', 'part', 'parts',
  'ออโตเมชั่น', 'automation',
  'เทคโนโลยี', 'technology', 'technologies',
  'อุตสาหกรรม', 'industry', 'industries',
  'การค้า', 'trade',
  'สยาม', 'siam',
  'คอร์ปอเรชั่น', 'corporation', 'corp',
  'อินเตอร์เนชั่นแนล', 'international',
  'โปรดักส์', 'product', 'products',
  'เซ็นเตอร์', 'center', 'centre',
  'ดีเวลลอปเม้นท์', 'development',
  'ซิสเท็ม', 'จำหน่าย'
]);

export function cleanCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/(บริษัท|จำกัด|มหาชน|หจก\.|หจก|บจก\.|บจก|ห้างหุ้นส่วนจำกัด|สำนักงานใหญ่|สาขาที่\s*\d+|สาขา|^บ\.\s*|^บ\s+)/g, '')
    .replace(/[()\[\]{}.,\\/|:;!?^$*+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanContactName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    // "K"/"K." = คำนำหน้าเรียกบุคคล (= คุณ) ตัดออกเมื่อขึ้นต้นและมีชื่อตามหลัง เช่น "K นิว"/"K.นิว" → "นิว"
    .replace(/^\s*[Kk]\.?\s*(?=[ก-๙A-Za-z])/, '')
    .replace(/^(คุณ|นาย|นางสาว|นาง|นายแพทย์|แพทย์หญิง|ดร\.)/g, '')
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// Normalization core: token list เดียวใช้สร้างทั้ง SQL expression และ TS mirror
// เพื่อให้ norm(query) เทียบกับ norm(display_name) ได้แบบ byte-identical ทั้งสองฝั่ง
// ห้าม strip "ประเทศไทย" (แยก sibling เช่น ย่งฮง (ประเทศไทย) vs ย่งฮง เอ็นจิเนียริ่ง)
// ห้าม strip "คุณ" (ลูกค้าบุคคล เช่น "คุณ โยธิน ปาทาน")
// ═══════════════════════════════════════════════════════════════════════════
const NORM_TOKENS = [
  'ห้างหุ้นส่วนจำกัด',
  'ห้างหุ้นส่วน',
  'บริษัท',
  'หจก',
  'บจก',
  'บ\\.',
  'ร้าน',
  'จำกัด',
  'มหาชน',
  'สำนักงานใหญ่',
  'สาขาที่\\s*[0-9]+',
  'สาขา\\s*[0-9]*',
];
const NORM_PATTERN = NORM_TOKENS.join('|');
// ตัวอักษรที่เก็บไว้: เลข อังกฤษ ไทย — จุด/ช่องว่าง/วงเล็บ/ฯลฯ หายหมด
const NORM_STRIP_CLASS = '[^0-9a-zA-Zก-๙]+';

/** Normalize ชื่อบริษัทสำหรับเทียบข้าม จุด/ช่องว่าง/คำนำหน้า-ต่อท้าย — ใช้ทั้งฝั่ง query และฝั่งชื่อใน DB */
export function normalizeCompanyNameTS(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(new RegExp(NORM_PATTERN, 'g'), '')
    .replace(new RegExp(NORM_STRIP_CLASS, 'g'), '')
    // fold สระเสียงสั้น/ยาวที่คนไทยมักพิมพ์สลับกัน (ปิยะ↔ปียะ) ทำทั้งสองฝั่งจึงยัง symmetric
    .replace(/ี/g, 'ิ').replace(/ื/g, 'ึ').replace(/ู/g, 'ุ')
    .toLowerCase();
}

/** ลบเบอร์โทรออกจากข้อความก่อนนำไปค้นหาชื่อบริษัท (เช่น "คุณโยธิน 06-3884-0005") */
export function stripPhoneNumbers(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, ' ')
    .replace(/(?<!\d)\d{9,10}(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** เทียบชื่อแบบ raw exact: lower + ยุบช่องว่างซ้ำ (รองรับ DB ที่มี double space) */
export function collapseSpaces(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * แยกบรรทัด "บ.X คุณY" → { customer: "บ.X", contact: "คุณY" }
 * backstop ของ AI prompt rule (ลูกค้า+ผู้ติดต่อพิมพ์มาบรรทัดเดียว เช่น "บ.เคยู  คุณจิตติพงษ์")
 */
export function splitCustomerContact(raw: string): { customer: string; contact: string | null } {
  const trimmed = (raw || '').trim();
  const m = trimmed.match(/^(.+?)\s+((?:คุณ|[Kk]\.?\s?)[฀-๿a-zA-Z].*)$/i);
  if (m && m[1].trim()) {
    return { customer: m[1].trim(), contact: m[2].trim() };
  }
  return { customer: trimmed, contact: null };
}

/**
 * แตกชื่อผู้ติดต่อเป็นชิ้นส่วนสำหรับเทียบ: เต็ม / ไม่มีวงเล็บ / ชื่อเล่นในวงเล็บ / คำแรก
 * รองรับ "คุณ มิค"↔"คุณมิค" (ช่องว่างหลังคำนำหน้า), "คุณณัฐชา (พลอย)"↔"คุณพลอย" (alias),
 * "คุณธีรศักดิ์ จัดซื้อ 098..."↔"คุณธีรศักดิ์" (ตำแหน่ง/เบอร์ต่อท้าย)
 */
function contactNameParts(s: string | null | undefined): string[] {
  if (!s) return [];
  let t = s.replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, ' ');
  t = t.replace(/^\s*[Kk]\.?\s*(?=[ก-๙A-Za-z])/, '');            // "K"/"K." honorific → ตัดออก เหลือชื่อ
  t = t.replace(/^\s*(คุณ|นายแพทย์|แพทย์หญิง|นางสาว|นาย|นาง|ดร\.?)\s*/i, '');
  const aliasMatch = t.match(/\(([^)]+)\)/);
  const noParen = t.replace(/\([^)]*\)/g, ' ').trim();
  const firstWord = noParen.split(/\s+/)[0] || '';
  const clean = (x: string) => x.toLowerCase().replace(/[^0-9a-zA-Zก-๙]+/g, '');
  const parts = [clean(t), clean(noParen), aliasMatch ? clean(aliasMatch[1]) : '', clean(firstWord)];
  return Array.from(new Set(parts.filter(p => p.length >= 2)));
}

/** เทียบชื่อผู้ติดต่อสองฝั่งด้วยชิ้นส่วนทุกคู่: exact = ชิ้นใดชิ้นหนึ่งตรงกันเป๊ะ, partial = ซ้อนกันบางส่วน */
export function contactNamesMatch(a: string | null | undefined, b: string | null | undefined): { exact: boolean; partial: boolean } {
  const pa = contactNameParts(a);
  const pb = contactNameParts(b);
  let exact = false;
  let partial = false;
  for (const x of pa) {
    for (const y of pb) {
      if (x === y) exact = true;
      else if (x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x))) partial = true;
    }
  }
  return { exact, partial };
}

// ═══ Trigram similarity ฝั่ง JS (สูตรเดียวกับ pg_trgm: shared / union) ═══
function trigramsOf(s: string): Set<string> {
  const set = new Set<string>();
  if (!s) return set;
  const padded = `  ${s} `;
  for (let i = 0; i <= padded.length - 3; i++) set.add(padded.slice(i, i + 3));
  return set;
}

function trigramSimilarity(aSet: Set<string>, bSet: Set<string>): number {
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let shared = 0;
  const [small, large] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet];
  for (const t of small) if (large.has(t)) shared++;
  const union = aSet.size + bSet.size - shared;
  return union === 0 ? 0 : shared / union;
}

// ═══ In-memory cache ของชื่อบริษัททั้งหมด (normalize + trigram set คำนวณไว้ล่วงหน้า) ═══
// เหตุผล: การ normalize + similarity ทั้งตารางใน SQL ต่อ 1 ครั้งค้นหาช้าเกิน (วัดจริง >10s)
// และผู้ใช้ไม่ต้องการสร้าง index → โหลด 52k แถวมาไว้ในหน่วยความจำครั้งเดียว (TTL 10 นาที
// สอดคล้องกับข้อมูลที่เปลี่ยนเฉพาะตอน sync จาก Odoo) แล้ว match ฝั่ง JS เร็วระดับ ~100ms
const CUSTOMER_CACHE_TTL_MS = 10 * 60 * 1000;
let customerCache: { rows: any[]; loadedAt: number } | null = null;
let customerCacheLoading: Promise<any[]> | null = null;

async function loadCustomerSearchCache(): Promise<any[]> {
  if (customerCache && Date.now() - customerCache.loadedAt < CUSTOMER_CACHE_TTL_MS) {
    return customerCache.rows;
  }
  if (customerCacheLoading) return customerCacheLoading;

  customerCacheLoading = (async () => {
    const t0 = Date.now();
    // อ่านจาก customers_data_view (ไม่ใช่ customers ตรง ๆ) เพื่อให้ company search ครอบคลุม
    // บริษัท/ผู้ติดต่อจาก sale_orders ที่ gateway ไม่ส่ง (~1,100 บริษัทเพิ่ม) ด้วย — view เป็น superset
    // ครบทุกบริษัทของ customers + normalize ('null'->NULL) แล้ว. DISTINCT ON(company_id) คง grain เดิม
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (company_id)
        company_id AS id,
        TRIM(customer_name) AS display_name,
        TRIM(customer_reference) AS reference,
        TRIM(customer_sale_area) AS branch_code,
        TRIM(salesperson) AS salesperson
      FROM customers_data_view
      ORDER BY company_id, contact_id`);
    const cached = rows.map((r: any) => {
      const norm_name = normalizeCompanyNameTS(r.display_name);
      return { ...r, norm_name, trigrams: trigramsOf(norm_name) };
    });
    customerCache = { rows: cached, loadedAt: Date.now() };
    customerCacheLoading = null;
    console.log(`[customerSearchCache] loaded ${cached.length} companies in ${Date.now() - t0}ms`);
    return cached;
  })();
  return customerCacheLoading;
}

/** ล้าง cache (ใช้ในเทส/หลัง sync ข้อมูล) */
export function clearCustomerSearchCache(): void {
  customerCache = null;
  customerCacheLoading = null;
}

/**
 * searchCustomersNormalized — stage ค้นหาใหม่ (normalized + trigram)
 * เทียบชื่อแบบ normalize สองฝั่งด้วยกติกาเดียวกัน:
 *  - substring match ข้าม จุด/ช่องว่าง/คำนำหน้า-ต่อท้าย ("ก.แสงทอง" ↔ "ก แสงทอง", "โคราชกรุ๊ป" ↔ "โคราช กรุ๊ป")
 *  - trigram similarity รองรับสะกดต่าง ("แมสชีนเนอรี่" ↔ "แมชชินเนอรี่")
 * คืน rows: { id, display_name, reference, branch_code, salesperson, norm_name, max_sim, has_exact, has_substr }
 */
export async function searchCustomersNormalized(variants: string[]): Promise<any[]> {
  const t0 = Date.now();
  const queryNorms = Array.from(new Set(
    variants.map(v => normalizeCompanyNameTS(v)).filter(n => n.length >= 2)
  ));
  if (queryNorms.length === 0) return [];

  const queries = queryNorms.map(qn => ({ qn, trigrams: trigramsOf(qn) }));
  const rows = await loadCustomerSearchCache();

  const results: any[] = [];
  for (const r of rows) {
    if (!r.norm_name) continue;
    let has_exact = false;
    let has_substr = false;
    let max_sim = 0;
    let best_signal = 0; // สัญญาณรวม 0..1 = max(similarity, coverage ของ substring)
    for (const q of queries) {
      if (r.norm_name === q.qn) {
        has_exact = true; has_substr = true; max_sim = 1; best_signal = 1;
        break;
      }
      // substring match แบบถ่วงด้วย coverage (สัดส่วนความยาวที่ทับกัน) —
      // ห้ามให้ variant สั้นๆ เช่น "เอเค" แจกคะแนนเต็มแก่ทุกบริษัทที่มีคำนั้น
      if (r.norm_name.includes(q.qn)) {
        has_substr = true;
        best_signal = Math.max(best_signal, q.qn.length / r.norm_name.length);
      } else if (q.qn.includes(r.norm_name) && r.norm_name.length >= 5) {
        // reverse: คำค้นมีชื่อบริษัทอยู่ข้างใน — ต้องยาว ≥5 ตัวอักษร กันชื่อสั้นอย่าง "พีเค"/"เคส"
        // ไป match มั่วใน query ยาวๆ (เคยทำ auto-select ผิดบริษัทมาแล้ว)
        has_substr = true;
        best_signal = Math.max(best_signal, r.norm_name.length / q.qn.length);
      }
      const sim = trigramSimilarity(r.trigrams, q.trigrams);
      if (sim > max_sim) max_sim = sim;
      if (sim > best_signal) best_signal = sim;
    }
    if (has_exact || has_substr || max_sim >= 0.30) {
      const { trigrams, ...plain } = r;
      results.push({ ...plain, max_sim, has_exact, has_substr, best_signal });
    }
  }

  results.sort((a, b) =>
    Number(b.has_exact) - Number(a.has_exact) ||
    b.best_signal - a.best_signal
  );
  const limited = results.slice(0, 25);
  console.log(`[searchCustomersNormalized] ${limited.length}/${results.length} rows in ${Date.now() - t0}ms | norms: ${JSON.stringify(queryNorms)}`);
  return limited;
}

/**
 * แปลงผล searchCustomersNormalized เป็น score (ต่ำ = ดี):
 * norm-exact = 0.005 (ไม่ใช่ 0.0 — record ชื่อซ้ำกันจะ norm-exact พร้อมกันหลายแถว
 * ให้ evidence boost ขั้นถัดไปเป็นคนชี้ตัวจริงเป็น 0.0), ที่เหลือไล่ตาม best_signal → 0.02..0.33
 * มีแค่ตัวที่ evidence ชี้ขาด/AI ยืนยัน เท่านั้นที่ได้ 0.0 แล้วผ่าน auto-select gate (top<=0.05, gap>0.05)
 */
/**
 * คะแนนที่ให้ candidate ที่ "ตรงแค่ชื่อ" เมื่อมีตัวอื่นที่ "ตรงทั้งชื่อและผู้ติดต่อ"
 * ต้อง > 0.05 เพื่อให้ gap จากตัวชนะ (0.0) ผ่าน auto-select gate ที่ processQuotationRequest
 * (quotationService: topScore <= 0.05 && secondScore - topScore > 0.05)
 */
const NAME_ONLY_DEMOTED_SCORE = 0.06;

/** น้ำหนักหลักฐานตอนคะแนนเท่ากัน: ชื่อตรงเป๊ะทั้งบรรทัด > ผู้ติดต่อตรง > ชื่อตรงแบบ normalize */
const evidenceWeight = (c: any) =>
  (c.evidence?.isExactRaw ? 4 : 0) +
  ((c.evidence?.matchedContacts?.length ?? 0) > 0 ? 2 : 0) +
  (c.evidence?.isExactNorm ? 1 : 0);

/**
 * เรียง candidate: score ต่ำก่อน → หลักฐานแข็งกว่า → ความคล้ายของชื่อ (sim) สูงกว่า
 *
 * sim เป็นตัวตัดสินท้ายสุด สำหรับกรณีที่ boost ตรึงหลายตัวไว้ที่คะแนนเดียวกัน เช่น query "เอส.วี.เอส"
 * ทำให้ทั้ง "เอส.วี.เอส.การไฟฟ้า" (sim 41%) และ "เอส.วี.เอส. เอนจิเนียริ่ง" (sim 32%) ได้ 0.01 เท่ากัน
 * จาก boost "ชื่อมีคำค้นอยู่ข้างใน" — ตัวที่ sim สูงกว่าคือตัวที่ใกล้เคียงคำค้นจริงมากกว่า
 *
 * ปลอดภัยต่อ auto-select: คะแนนเท่ากัน = gap 0 ซึ่งไม่ผ่าน gate (ต้อง > 0.05) อยู่แล้ว
 * การเรียงนี้จึงมีผลแค่ลำดับที่ผู้ใช้/AI เห็น ไม่ทำให้ระบบเลือกอัตโนมัติผิด
 */
const compareCandidates = (a: any, b: any) =>
  ((a.score ?? 0) - (b.score ?? 0)) ||
  (evidenceWeight(b) - evidenceWeight(a)) ||
  ((b.evidence?.sim ?? 0) - (a.evidence?.sim ?? 0));

function normRowScore(row: any): number {
  if (row.has_exact) return 0.005;
  const signal = Math.min(Math.max(Number(row.best_signal) || 0, 0), 0.99);
  return 0.02 + (1 - signal) * 0.31;
}

function normRowToCandidate(row: any): any {
  return {
    id: row.id,
    display_name: row.display_name,
    reference: row.reference,
    branch_code: row.branch_code,
    salesperson: row.salesperson,
    cleanName: cleanCompanyName(row.display_name),
  };
}

export function formatLineLabel(text: string | null | undefined): string {
  if (!text) return '';
  // ลบเฉพาะคำนำหน้า "บริษัท" ออก แต่คง "(สำนักงานใหญ่)", "(ประเทศไทย)", สาขาฯ ไว้
  // เพื่อให้ label แยกแยะระหว่างบริษัทที่ชื่อคล้ายกันได้
  const trimmed = text
    .replace(/^บริษัท\s*/g, '')          // ลบ "บริษัท" นำหน้า
    .replace(/\s*จำกัด\s*\(มหาชน\)\s*$/, '') // ลบ "จำกัด (มหาชน)" ท้าย
    .replace(/\s*จำกัด\s*$/, '')           // ลบ "จำกัด" ท้าย
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed;
}


/**
 * buildDotInitialVariants
 * สร้าง search variant สำหรับชื่อที่ใช้จุดคั่นตัวย่อ เช่น "บ.เอ.เค.พลาสติก"
 * คืนค่า: ["เอ.เค.พลาสติก", "เอเคพลาสติก"]
 *
 * ใช้เฉพาะเมื่อ raw text มี pattern ตัวอักษรเดี่ยว+จุดติดกัน ≥ 2 ตัว
 * Flow เดิม (cleanCompanyName) ไม่ถูกแตะ — ทำงานแยกกัน
 */
function buildDotInitialVariants(rawText: string): string[] {
  if (!rawText) return [];

  // ตรวจว่ามีตัวอักษร+จุด ≥ 2 ตำแหน่งในข้อความ (ไม่ต้องติดกัน)
  // ❌ เดิม: /(?:[\u0E00-\u0E7Fa-zA-Z]\.){2,}/ ← ต้องติดกัน (ไม่ work กับ Thai syllable เช่น เอ.เค.)
  // ✅ ใหม่: นับ occurrences ทั้งหมด ≥ 2
  const dotMatches = rawText.match(/[\u0E00-\u0E7Fa-zA-Z]\./g);
  // ≥ 1 → รองรับทั้ง single-initial ("ก.แสงทอง") และ multi-initial ("เอ.เค.")
  // เดิมใช้ ≥ 2 ทำให้ single-initial ถูกค้นด้วย space ("ก แสงทอง") แล้วไม่เจอ record ที่เก็บเป็น dot
  if (!dotMatches || dotMatches.length < 1) return [];

  // ลบคำนำหน้า/ท้าย แต่คงจุดระหว่าง initials ไว้
  const stripped = rawText
    .replace(/^(\u0E1A\u0E23\u0E34\u0E29\u0E31\u0E17\s+|\u0E1A\.\s*|\u0E1A\u0E08\u0E01\.\s*|\u0E2B\u0E08\u0E01\.\s*|\u0E23\u0E49\u0E32\u0E19\s*|\u0E2B\u0E49\u0E32\u0E07\u0E2B\u0E38\u0E49\u0E19\u0E2A\u0E48\u0E27\u0E19\u0E08\u0E33\u0E01\u0E31\u0E14\s*)/i, '')
    .replace(/\s*(\u0E08\u0E33\u0E01\u0E31\u0E14(\s*\(\u0E21\u0E2B\u0E32\u0E0A\u0E19\))?\s*|\(\u0E2A\u0E33\u0E19\u0E31\u0E01\u0E07\u0E32\u0E19\u0E43\u0E2B\u0E0D\u0E48\)|\(\u0E2A\u0E32\u0E02\u0E32[^)]*\)|Co\.?,?\s*Ltd\.?|Ltd\.?)\s*$/i, '')
    .replace(/[()[\]{}\\/|:;!?^$*+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped || stripped.length < 2) return [];

  const variants: string[] = [];

  // Variant 1: dot-preserved full — "เอ.เค.พลาสติก" คงจุดไว้ทั้งหมด
  if (stripped !== rawText.trim()) {
    variants.push(stripped);
  }

  // Variant 2: compressed — ลบจุดออกโดยไม่ใส่ space → "เอเคพลาสติก"
  const compressed = stripped.replace(/\./g, '');
  if (compressed && compressed !== stripped && compressed.length >= 2) {
    variants.push(compressed);
  }

  // Variant 3: abbreviation prefix เท่านั้น — ตัดเฉพาะส่วน X.Y. ออกมา
  // เพื่อ match DB แม้ spelling ส่วนท้ายจะต่างกัน เช่น "แมสชีน" vs "แมชชิน"
  // "เอ.เค.พลาสติก" → abbrev = "เอ.เค" → ilike "%เอ.เค%" จะ match "เอ.เค.พลาสติกแมชชินเนอรี่"
  const abbrevMatch = stripped.match(/^((?:[\u0E00-\u0E7Fa-zA-Z]+\.)+)/);
  if (abbrevMatch) {
    const abbrev = abbrevMatch[1].replace(/\.$/, ''); // ตัด trailing dot
    if (abbrev && abbrev.length >= 2 && !variants.includes(abbrev)) {
      variants.push(abbrev);
    }
  }

  return variants;
}


// ═══════════════════════════════════════════════════════════════════════════
// Reference-code extraction
// เดิม regex หลวมมาก (ยอมรับเลขล้วน 3-8 หลักทุกที่ในข้อความ) → บ้านเลขที่ / รหัสไปรษณีย์ /
// เลขสาขา / แรงดันไฟ ถูกจับเป็น "รหัสลูกค้า" หมด แล้ว fast-path ยิง ILIKE '%600%' '%220%'
// ไปโดนบริษัทมั่ว 30 ตัว (เคสจริง: TPCS — ดูคอมเมนต์ที่ fast-path guard ด้านล่าง)
// ═══════════════════════════════════════════════════════════════════════════

/** บรรทัดที่มีคำบ่งชี้ที่อยู่ไทย → เลขในบรรทัดนี้คือบ้านเลขที่/ไปรษณีย์ ไม่ใช่รหัสลูกค้า */
const ADDRESS_HINT_RE = /(?:^|\s)(?:ถ\.|ต\.|อ\.|จ\.|ซ\.|ม\.|หมู่|ตำบล|อำเภอ|จังหวัด|ถนน|แขวง|เขต|ซอย)/;
/** บรรทัดที่เป็นคำว่า "สาขา"/"สาขาที่ N" ล้วนๆ → บรรทัดถัดไปที่เป็นเลขคือเลขสาขา */
const BRANCH_ONLY_LINE_RE = /^สาขา(?:ที่)?\s*\d*$/;

/** คำบ่งชี้ที่อยู่แบบเต็มคำ — เจอคำเดียวก็ชัดว่าเป็นบรรทัดที่อยู่ */
const ADDRESS_WORD_RE = /(?:หมู่บ้าน|หมู่ที่|ตำบล|อำเภอ|จังหวัด|ถนน|แขวง|เขต|ซอย|จ\.ม\.|รหัสไปรษณีย์)/;
/** ตัวย่อที่อยู่ — กำกวมกับตัวย่อชื่อบริษัท (เช่น หจก. "ต.อิเล็คทริค") จึงต้องเจอ ≥2 ตัวถึงจะฟันธง */
const ADDRESS_ABBR_RE = /(?:^|\s)(?:ถ|ต|อ|จ|ซ|ม)\./g;
/** หน่วยนับ/คำที่ไม่ใช่ชื่อบริษัทแน่ๆ */
const UNIT_WORDS = new Set(['pcs', 'pc', 'set', 'sets', 'ea', 'unit', 'units', 'อัน', 'ชิ้น', 'ตัว', 'ชุด', 'เส้น']);

/**
 * บรรทัดนี้ "มีโอกาสเป็นชื่อบริษัท" ไหม — ใช้กรองก่อนเอาไปค้นด้วยชื่อ
 * เดิมโยนทุกบรรทัดเข้า Fuse.js รวมบรรทัดที่อยู่/เบอร์/อีเมล/สเปคสินค้า/"2"/"Pcs"
 * → Fuse match มั่วแล้วแจก score ต่ำผิดปกติ (0.0028) ชนะสาขาจริงของบริษัทที่ถูก (0.005)
 * ทำให้ gap แคบจน auto-select ไม่ทำงาน และลิสต์ให้เซลส์เลือกมีขยะปน
 */
export function isLikelyCompanyNameLine(rawLine: string): boolean {
  const line = (rawLine || '').trim();
  if (!line) return false;

  if (line.includes('@')) return false;                       // อีเมล
  if (/ผู้เสียภาษี|\d{13}/.test(line)) return false;             // เลขผู้เสียภาษี
  // เบอร์ติดต่อ — ต้องมีตัวเลขตามหลัง (\b ใช้กับอักษรไทยไม่ได้ เพราะไทยไม่ใช่ \w)
  // และกันบริษัทที่ขึ้นต้นคล้ายกันอย่าง "โทรีไทย" ไม่ให้โดนตัด
  if (/^(?:โทร|เบอร์|แฟกซ์|มือถือ|tel|mobile|fax|phone)[\s.:\-]*\d/i.test(line)) return false;
  if (/^\d+[.)]\s/.test(line)) return false;                  // รายการสินค้า "1. FP-108-1 ..."
  if (UNIT_WORDS.has(line.toLowerCase().replace(/[^a-zก-๙]/g, ''))) return false;

  // ที่อยู่: คำเต็ม 1 คำ หรือ ตัวย่อ ≥2 ตัว (ตัวย่อตัวเดียวอาจเป็นชื่อบริษัท เช่น "ต.อิเล็คทริค")
  if (ADDRESS_WORD_RE.test(line)) return false;
  if ((line.match(ADDRESS_ABBR_RE) || []).length >= 2) return false;

  // ต้องมีตัวอักษรจริงอย่างน้อย 2 ตัว — กัน "2", "00005", "-"
  const letters = line.replace(/[^a-zA-Zก-๙]/g, '');
  if (letters.length < 2) return false;

  return true;
}

/**
 * สกัดรหัสลูกค้าจากข้อความแชท — รับเฉพาะรหัสที่ "แข็งแรงพอ" เท่านั้น
 * รับ:   A022914, A/35871, A011030(2), และเลขล้วน ≥5 หลักที่ยืนเดี่ยวเป็น token
 * ไม่รับ: เลขในบรรทัดที่อยู่, เลขสาขาที่ตามหลังคำว่า "สาขา", เลขผู้เสียภาษี 13 หลัก,
 *        แรงดันไฟ (เลขตามด้วย V), เลขล้วน <5 หลัก
 */
export function extractReferenceCodes(rawLines: string[]): string[] {
  const referenceCodes = new Set<string>();
  // ต้องมีตัวอักษรนำหน้าเสมอ เช่น A022914 / A-35871 / A/35871
  const strongRefRe = /\b[A-Z][\/-]?\d{3,8}(?:\(\d+\))?(?![a-zA-Z0-9])/gi;
  // token เลขล้วนที่ยืนเดี่ยว (เซลส์บางคนพิมพ์เฉพาะตัวเลขของรหัส)
  const bareNumRe = /^\d{5,8}(?:\(\d+\))?$/;

  const add = (raw: string) => {
    // "A011030(2)" = รหัส A011030 สาขา 2 — ต้องตัดวงเล็บทิ้ง ไม่ใช่ยุบเป็น "A0110302"
    const base = raw.replace(/\(\d+\)\s*$/, '').trim();
    const normRef = base.replace(/[\/\s-]/g, '').trim();
    const numOnly = base.replace(/[^0-9]/g, '');
    referenceCodes.add(raw);
    referenceCodes.add(base);
    referenceCodes.add(normRef);
    // numOnly ต้อง ≥5 หลัก — เลขสั้นกว่านั้น ILIKE แล้วชนมั่วทั้งตาราง
    if (numOnly.length >= 5) referenceCodes.add(numOnly);
  };

  let prevLineEndsWithBranchKw = false;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    const isBranchNumberLine = prevLineEndsWithBranchKw && /^\d{1,6}$/.test(line);
    prevLineEndsWithBranchKw = /สาขา\s*$/.test(line) || BRANCH_ONLY_LINE_RE.test(line);

    // ข้ามบรรทัดที่อยู่ และบรรทัดเลขสาขา
    if (ADDRESS_HINT_RE.test(line) || isBranchNumberLine) continue;

    // ตัดสิ่งที่ "ไม่มีวันเป็นรหัสลูกค้า" ออกก่อน match
    // (รหัสไปรษณีย์ไม่ต้องตัดตรงนี้ — อยู่ในบรรทัดที่อยู่ซึ่งถูกข้ามไปแล้ว
    //  และถ้าตัดเลข 5 หลักท้ายบรรทัดจะไปกินเคสเซลส์พิมพ์รหัสเลขล้วนมาบรรทัดเดียว)
    const cleaned = line
      .replace(/\d{13}/g, ' ')        // เลขผู้เสียภาษี
      .replace(/\d+\s*V\b/gi, ' ');   // แรงดันไฟ เช่น "220 V."

    const matches = cleaned.match(strongRefRe);
    if (matches) for (const m of matches) add(m);

    for (const word of cleaned.split(/\s+/).map(w => w.trim()).filter(Boolean)) {
      if (bareNumRe.test(word)) add(word);
    }
  }

  return Array.from(referenceCodes).filter(Boolean);
}


export async function findCustomerCandidates(customerQuery: string, salesperson: any, contactQuery?: string): Promise<any[]> {
  if (!customerQuery) return [];

  // Split query by newlines first
  const rawLines = customerQuery.split('\n').map(l => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return [];

  // เฉพาะบรรทัดที่มีโอกาสเป็นชื่อบริษัท — บรรทัดที่อยู่/เบอร์/อีเมล/สเปคสินค้า/"2"/"Pcs"
  // เคยหลุดเข้า Fuse.js แล้วแจก score ต่ำผิดปกติให้บริษัทที่ไม่เกี่ยวเลย
  const nameSearchLines = rawLines.filter(isLikelyCompanyNameLine);

  const refArray = extractReferenceCodes(rawLines);

  // --- Step A: ถ้ารู้รหัส Reference ลองค้นจากรหัสก่อนเป็นอันดับแรก (Fast-path) ---
  if (refArray.length > 0) {
    console.log('[findCustomerCandidates] extracted reference codes:', refArray);
    const refData = await searchCustomersByReferencePatterns(refArray, 30);

    if (refData && refData.length > 0) {
      // ═══ Fast-path guard: รหัสที่สกัดได้ต้องสอดคล้องกับ "ชื่อ" ที่เซลส์พิมพ์ด้วย ═══
      // เคสจริงที่พลาด (TPCS): ข้อความมีเลขสาขา/ที่อยู่/แรงดันไฟ → ref match บริษัทมั่ว 30 ตัว
      // คะแนนเท่ากันหมด 0.1 แล้ว return ทันที — ไม่เคยค้นชื่อ "ทีพีซีเอส" และไม่เคยเรียก AI เลย
      // ถ้าไม่มี candidate ตัวไหนชื่อพ้องกับที่เซลส์พิมพ์ → ถือว่ารหัสที่สกัดมาเป็นขยะ ตกไปใช้ flow ชื่อ+AI
      // รหัสตรงเป๊ะ = หลักฐานชี้ขาด ข้ามการเช็คชื่อไปเลย
      // (เซลส์มักพิมพ์ชื่อย่อที่ไม่ตรงกับชื่อเต็มใน DB เช่น "บ.ถิรเดช" ↔ "ถิรเดช โอภาสวัฒนกุล")
      const refMatchesExactly = (c: any) => {
        const refClean = (c.reference || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!refClean) return false;
        return refArray.some(r => r.toLowerCase().replace(/[^a-z0-9]/g, '') === refClean);
      };

      // เทียบระดับ "คำ" ไม่ใช่ทั้งก้อน — "บ.ถิรเดช" กับ "ถิรเดช โอภาสวัฒนกุล" ไม่มีฝั่งไหนครอบอีกฝั่ง
      // แต่แชร์คำว่า "ถิรเดช" ซึ่งคือตัวชี้ว่าเป็นบริษัทเดียวกัน
      const queryTokens = new Set(
        nameSearchLines.flatMap(l =>
          cleanCompanyName(stripPhoneNumbers(l))
            .split(/\s+/)
            .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
            .map(w => normalizeCompanyNameTS(w))
            .filter(w => w.length >= 3)));

      const nameAgrees = (displayName: string) => {
        const dn = normalizeCompanyNameTS(displayName);
        if (!dn) return false;
        for (const t of queryTokens) if (dn.includes(t)) return true;
        return false;
      };

      // เซลส์พิมพ์ชื่อบริษัทมาด้วย → ref match ต้องสอดคล้องกับชื่อ (หรือรหัสตรงเป๊ะ)
      // เซลส์พิมพ์มาแต่รหัสล้วน (ไม่มีชื่อให้เทียบ) → เชื่อรหัสได้ตามเดิม
      const agreeing = queryTokens.size > 0
        ? refData.filter((c: any) => refMatchesExactly(c) || nameAgrees(c.display_name))
        : refData;

      if (agreeing.length === 0) {
        console.log(`[findCustomerCandidates] ⚠️ Fast-path ทิ้ง ${refData.length} ผลลัพธ์: ไม่มีตัวไหนชื่อตรงกับที่เซลส์พิมพ์ → ใช้ flow ค้นด้วยชื่อ + AI แทน`);
      } else {
        console.log(`[findCustomerCandidates] Found ${agreeing.length}/${refData.length} candidates by reference codes (Fast-path, ชื่อสอดคล้อง)!`);

        const candidates = agreeing.map((c: any) => {
          const refLower = c.reference ? c.reference.toLowerCase().trim() : '';
          const refClean = refLower.replace(/[^a-z0-9]/g, '');

          let score = 0.5; // คะแนนเริ่มต้นสำหรับ match

          // เช็คว่าตรงเป๊ะในชุด normalized refs หรือไม่
          const isExact = refArray.some(r => {
            const cleanInput = r.toLowerCase().replace(/[^a-z0-9]/g, '');
            return cleanInput === refClean;
          });

          if (isExact) {
            score = 0.0; // ตรงเป๊ะ
          } else {
            // fuzzy (สาขา/เลขท้ายห้อย) ยอมเฉพาะรหัสที่จำเพาะพอ — มีตัวอักษรนำ หรือยาว ≥6
            // เลขสั้นๆ substring แล้วชนมั่วข้ามบริษัท
            const isFuzzy = refArray.some(r => {
              const cleanInput = r.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (!cleanInput) return false;
              const specific = /[a-z]/.test(cleanInput) || cleanInput.length >= 6;
              if (!specific) return false;
              return refClean.includes(cleanInput) || cleanInput.includes(refClean);
            });
            if (isFuzzy) {
              score = 0.1; // เป็นสาขา หรือมีเลขท้ายห้อย
            }
          }

          return {
            item: {
              ...c,
              cleanName: cleanCompanyName(c.display_name)
            },
            score
          };
        });

        candidates.sort((a: any, b: any) => a.score - b.score);
        console.log('[findCustomerCandidates] Fast-path by Reference results:', candidates.map((r: any) => `${r.item.display_name} (score: ${r.score})`));
        return candidates;
      }
    }
  }

  // --- Step B0 (ใหม่): ค้นหาแบบ normalized + trigram ก่อน (additive — ไม่แทนที่ flow เดิม) ---
  // เก็บผลไว้ merge เข้า resultsMap ตอนท้าย; ถ้าเจอชื่อตรงเป๊ะบริษัทเดียว → เลือกเลยไม่ต้องเรียก AI
  let normRows: any[] = [];
  const normVariantSet = new Set<string>();
  // แยก "บ.X คุณY" ที่พิมพ์มาบรรทัดเดียว: ใช้ส่วนบริษัทค้นหา และถ้าไม่มี contactQuery ให้ใช้ส่วน คุณY เป็นหลักฐาน
  let inferredContact = '';
  const customerLines = rawLines.map(l => {
    const { customer, contact } = splitCustomerContact(l);
    if (contact && !inferredContact) inferredContact = contact;
    return customer;
  });
  const effectiveContactQuery = (contactQuery || '').trim() || inferredContact;
  if (!isNewSearchDisabled()) {
    // ใช้เฉพาะส่วนบริษัทเป็น variant ค้นหา (ถ้า split ไม่เกิด customerLines[i] = ทั้งบรรทัดอยู่แล้ว) —
    // บรรทัดที่มี "คุณY" ปนจะสร้าง match ขยะจนเบียดตัวจริงหลุด limit
    // กรองบรรทัดที่ไม่มีทางเป็นชื่อบริษัท (ที่อยู่/เบอร์/อีเมล/สเปคสินค้า) ออกก่อนค้น
    const initialVariants: string[] = [];
    for (const line of customerLines.filter(isLikelyCompanyNameLine)) {
      const noPhone = stripPhoneNumbers(line);
      initialVariants.push(line, noPhone, cleanCompanyName(noPhone));
      initialVariants.push(...buildDotInitialVariants(noPhone));
    }
    normRows = await searchCustomersNormalized(initialVariants);
    initialVariants.forEach(v => { const n = normalizeCompanyNameTS(v); if (n) normVariantSet.add(n); });

    // Exact short-circuit: user พิมพ์ชื่อเต็มตรงเป๊ะกับ DB (เทียบแบบยุบช่องว่าง) และไม่มีบริษัทพี่น้อง
    // ที่ชื่อ normalize แล้วเหมือนกัน (กัน auto-pick record ซ้ำ/legacy เช่น ย่งฮง มี 2 record)
    // → พิสูจน์ได้ 100% เลือกเลย ประหยัด AI call ทั้งสองจุด — เคสกำกวมปล่อยให้ AI ตัดสินพร้อม evidence
    const rawExactRows = normRows.filter(r =>
      rawLines.some(l => collapseSpaces(l) === collapseSpaces(r.display_name))
    );
    const normExactCount = normRows.filter(r => r.has_exact).length;
    if (rawExactRows.length === 1 && normExactCount <= 1) {
      const chosen = { item: normRowToCandidate(rawExactRows[0]), score: 0.0 };
      console.log(`[findCustomerCandidates] ✅ Raw-exact short-circuit: "${chosen.item.display_name}"`);
      return [chosen];
    }
  }

  // --- Step B: ถ้าไม่พบรหัส Reference หรือหาจากรหัสไม่เจอ ค่อยค้นหาด้วยชื่อ ---
  const nameTerms = new Set<string>();
  const cleanedLines: string[] = [];

  // --- Pre-Search AI Normalizer (สกัดชื่อแกนกลางของบริษัทก่อนค้นหาจริง) ---
  let aiExtractedName = '';
  if (customerQuery && !isAiMatchDisabled()) {
    try {
      console.log(`[findCustomerCandidates] Invoking AI (Pre-Search) to extract Core Name from: "${customerQuery.replace(/\n/g, ' ')}"`);
      const response = await createChatCompletion({
        messages: [
          {
            role: 'user',
            content: `วิเคราะห์ชื่อบริษัทที่ส่งมา และสกัดเฉพาะ "ชื่อเรียกหลักแกนกลาง" (Core Name/Brand Name) ออกมาเพื่อนำไปค้นหาต่อ
กติกา:
- ลบคำนำหน้า/คำย่อ เช่น บ., บจก., หจก., บริษัท, ร้าน, ห้างหุ้นส่วนจำกัด ออกทั้งหมด
- ลบคำต่อท้าย เช่น จำกัด, (มหาชน), Co., Ltd., Ltd. ออกทั้งหมด
- ลบวงเล็บ เช่น (สำนักงานใหญ่), (สาขา...) ออก
- คงเหลือเฉพาะตัวสะกดชื่อหลัก เช่น "บ.เคยู พลัส" -> "เคยู พลัส", "บริษัท ย่งฮง (ประเทศไทย) จำกัด" -> "ย่งฮง", "KU group" -> "KU"

ชื่อบริษัทที่ต้องการวิเคราะห์: "${customerQuery.split('\n')[0]}"

ตอบเฉพาะชื่อแกนกลางที่สกัดได้เท่านั้น ห้ามเขียนอธิบายใดๆ`
          }
        ]
      });

      const extracted = (response.choices[0].message.content || '').trim();
      aiExtractedName = cleanCompanyName(extracted);
      if (aiExtractedName) {
        console.log(`[findCustomerCandidates] AI extracted Core Name: "${aiExtractedName}"`);
        cleanedLines.push(aiExtractedName);
        nameTerms.add(aiExtractedName);
      }

      // dot-initial variants จาก raw ก่อน clean (AI output ยังมีจุดอยู่)
      const aiDotVariants = buildDotInitialVariants(extracted);
      if (aiDotVariants.length > 0) {
        console.log(`[findCustomerCandidates] dot-variants from AI: ${JSON.stringify(aiDotVariants)}`);
        aiDotVariants.forEach(v => { if (!cleanedLines.includes(v)) cleanedLines.push(v); });
      }
    } catch (err) {
      console.error('[findCustomerCandidates] Pre-Search AI extraction error:', err);
    }
  }

  // ค้นหา normalized เพิ่มด้วยชื่อที่ AI สกัดได้ (เฉพาะเมื่อเป็น variant ใหม่ที่ยังไม่เคยค้น)
  if (!isNewSearchDisabled() && aiExtractedName) {
    const aiNorm = normalizeCompanyNameTS(aiExtractedName);
    if (aiNorm && !normVariantSet.has(aiNorm)) {
      normVariantSet.add(aiNorm);
      const extraRows = await searchCustomersNormalized([aiExtractedName]);
      const byId = new Map(normRows.map((r: any) => [r.id, r]));
      for (const r of extraRows) {
        const ex = byId.get(r.id);
        if (!ex || normRowScore(r) < normRowScore(ex)) byId.set(r.id, r);
      }
      normRows = Array.from(byId.values());
    }
  }

  for (const line of nameSearchLines) {
    const cleanLine = cleanCompanyName(line);
    if (cleanLine) {
      cleanedLines.push(cleanLine);
    }

    // dot-initial variants จาก raw line ก่อน cleanCompanyName ลบจุดออก
    const lineDotVariants = buildDotInitialVariants(line);
    if (lineDotVariants.length > 0) {
      lineDotVariants.forEach(v => { if (!cleanedLines.includes(v)) cleanedLines.push(v); });
    }

    const words = line.split(/\s+/).map(w => w.trim()).filter(Boolean);
    for (const word of words) {
      if (!word.match(/^[A-Z]?[\/-]?\d{3,8}(?:\(\d+\))?$/i)) {
        const cleanW = cleanCompanyName(word);
        if (cleanW && cleanW.length >= 2) { // ปรับความยาวขั้นต่ำเป็น 2
          if (!STOP_WORDS.has(cleanW.toLowerCase())) {
            nameTerms.add(cleanW);
          }
        }
      }
    }
  }

  console.log('[findCustomerCandidates] cleanedLines (phrases):', cleanedLines);
  console.log('[findCustomerCandidates] nameTerms (words):', Array.from(nameTerms));
  console.log('[findCustomerCandidates] salesperson.branch_code:', salesperson?.branch_code);

  const dbCustomersMap = new Map<any, any>();

  // 1. Query by cleaned lines (phrases match display_name — NO branch_code filter)
  if (cleanedLines.length > 0) {
    const phraseData = await searchCustomersByNamePatterns(cleanedLines, 30);
    console.log('[findCustomerCandidates] phraseData count:', phraseData.length);
    phraseData.forEach((c: any) => dbCustomersMap.set(c.id, c));
  }

  // 2. Query by individual name terms (words match display_name — NO branch_code filter)
  if (nameTerms.size > 0) {
    const nameArray = Array.from(nameTerms).filter(Boolean);
    const nameData = await searchCustomersByNamePatterns(nameArray, 50);
    console.log('[findCustomerCandidates] nameData count:', nameData.length);
    nameData.forEach((c: any) => {
      if (!dbCustomersMap.has(c.id)) {
        dbCustomersMap.set(c.id, c);
      }
    });
  }

  const dbCustomers = Array.from(dbCustomersMap.values());

  const candidates = dbCustomers.map(c => ({
    ...c,
    cleanName: cleanCompanyName(c.display_name)
  }));

  // ดึง abbrev prefix จาก cleanedLines (เช่น "เอ.เค") เพื่อใช้เป็น mandatory filter
  const abbrevPrefix = cleanedLines.find(v => /^[\u0E00-\u0E7Fa-zA-Z]+\.[\u0E00-\u0E7Fa-zA-Z]/.test(v) && !v.includes(' ') && v.length <= 10);

  // กรองเฉพาะ candidate ที่มี core keyword ของ AI (aiExtractedName) อยู่ในชื่อ
  const coreKeywords = aiExtractedName
    ? aiExtractedName.split(/\s+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
    : [];

  // ถ้ามี abbrevPrefix หรือ coreKeywords → กรอง candidates
  let filteredCandidates = candidates;
  if (abbrevPrefix || coreKeywords.length > 0) {
    const strict = candidates.filter(c => {
      const nameLower = (c.display_name || '').toLowerCase();
      // ต้องผ่าน abbrev check (ถ้ามี) เช่น ชื่อต้องมี "เอ.เค"
      const passAbbrev = abbrevPrefix ? nameLower.includes(abbrevPrefix.toLowerCase()) : true;
      // และต้องมี keyword อย่างน้อย 1 คำ (ถ้ามี) — ใช้ partial match เพื่อรองรับ spelling ต่างกัน
      const passKeyword = coreKeywords.length > 0
        ? coreKeywords.some(kw => {
            // partial match: ตัดจาก 4 ตัวแรกของ keyword เพื่อรองรับ "พลาสติก" vs "พลาสติก"
            const kwPartial = kw.slice(0, 4);
            return nameLower.includes(kwPartial.toLowerCase());
          })
        : true;
      return passAbbrev && passKeyword;
    });
    // fallback ถ้ากรองแล้วไม่เหลือเลย
    if (strict.length > 0) filteredCandidates = strict;
  }

  const fuse = new (Fuse as any)(filteredCandidates, {
    keys: ['cleanName', 'display_name', 'reference'],
    threshold: 0.35,
    includeScore: true
  });

  const resultsMap = new Map<any, any>();

  // Run Fuse search
  for (const cleanedLine of cleanedLines) {
    const results = fuse.search(cleanedLine);
    for (const r of results) {
      const existing = resultsMap.get(r.item.id);
      if (!existing || existing.score > r.score) {
        resultsMap.set(r.item.id, { item: r.item, score: r.score });
      }
    }
  }

  // Exact display_name / cleanName match boosting
  for (const c of filteredCandidates) {
    for (const line of rawLines) {
      const lineLower = line.toLowerCase().trim();
      // Exact display_name match
      if (c.display_name && c.display_name.toLowerCase() === lineLower) {
        resultsMap.set(c.id, { item: c, score: 0.0 });
      }
      // display_name contains the query or query contains display_name
      if (c.display_name && (c.display_name.toLowerCase().includes(lineLower) || lineLower.includes(c.display_name.toLowerCase()))) {
        const existing = resultsMap.get(c.id);
        if (!existing || existing.score > 0.01) {
          resultsMap.set(c.id, { item: c, score: 0.01 });
        }
      }
    }
    for (const cleanedLine of cleanedLines) {
      const cleanLower = cleanedLine.toLowerCase().trim();
      if (c.cleanName && c.cleanName.toLowerCase() === cleanLower) {
        resultsMap.set(c.id, { item: c, score: 0.0 });
      }
    }
  }

  // Merge ผลจาก stage ค้นหาใหม่ (B0) เข้า resultsMap ด้วย min(score) —
  // candidate จาก flow เดิมอยู่ครบทุกตัว stage ใหม่ทำได้แค่เพิ่ม/ปรับ score ให้ดีขึ้น
  if (!isNewSearchDisabled()) {
    for (const row of normRows) {
      const score = normRowScore(row);
      const existing = resultsMap.get(row.id);
      if (!existing || existing.score > score) {
        resultsMap.set(row.id, { item: normRowToCandidate(row), score });
      }
    }
  }

  console.log('[findCustomerCandidates] Final results before AI check:', Array.from(resultsMap.values()).map(r => `${r.item.display_name} (score: ${r.score})`));

  // Pool กว้าง 40 ตัวสำหรับคำนวณ evidence ก่อนคัดเหลือ 8 —
  // กันเคสที่ตัวถูก (เช่น พีเคยู กับ query "เคยู") สัญญาณชื่ออ่อนแต่ผู้ติดต่อตรง หลุดจากการ slice ก่อนเวลา
  // (evidence ถูก: contacts 1 query + เทียบใน memory — pool กว้างไม่มีผลต่อ latency อย่างมีนัย)
  let finalCandidates = Array.from(resultsMap.values())
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, 40);

  // ═══ Evidence stage: คำนวณหลักฐานเชิงข้อเท็จจริงต่อ candidate (deterministic) ═══
  if (finalCandidates.length > 0) {
    const normRowById = new Map(normRows.map((r: any) => [r.id, r]));
    const evidenceQueries = Array.from(normVariantSet).map(qn => ({ qn, trigrams: trigramsOf(qn) }));
    const ids = finalCandidates.map(c => c.item.id);

    // 1) ผู้ติดต่อของทุก candidate — query เดียว (แทน loop ต่อ candidate แบบเดิม)
    const contactsByCustomer = new Map<any, string[]>();
    const contactRows = await getContactNamesByCustomerIds(ids);
    for (const r of contactRows) {
      if (!contactsByCustomer.has(r.customer_id)) contactsByCustomer.set(r.customer_id, []);
      contactsByCustomer.get(r.customer_id)!.push(r.name);
    }

    // 2) ประวัติใบเสนอราคาที่เคยยืนยันจริงของแต่ละบริษัท
    const confirmedCounts = await getConfirmedQuotationCounts(ids);

    for (const c of finalCandidates) {
      const dn = c.item.display_name || '';
      const row = normRowById.get(c.item.id);
      const normName = row ? row.norm_name : normalizeCompanyNameTS(dn);
      let sim = row ? Number(row.max_sim) || 0 : 0;
      if (!row && evidenceQueries.length > 0) {
        const tg = trigramsOf(normName);
        for (const q of evidenceQueries) sim = Math.max(sim, trigramSimilarity(tg, q.trigrams));
      }
      // แยกระดับ exact: raw = พิมพ์ตรงทั้งบรรทัดรวมวงเล็บ/สาขา (แยก record ซ้ำอย่าง ย่งฮง 2 แถวได้)
      // norm = ตรงเมื่อตัดคำนำหน้า/สาขา/วงเล็บ (record ซ้ำจะ norm-exact พร้อมกันหลายตัว)
      const isExactRaw = rawLines.some(l => collapseSpaces(l) === collapseSpaces(dn));
      const isExactNorm = normName !== '' && normVariantSet.has(normName);
      const isExact = isExactRaw || isExactNorm;
      const allContacts = contactsByCustomer.get(c.item.id) || [];
      const matchedContacts = effectiveContactQuery
        ? allContacts.filter(n => contactNamesMatch(effectiveContactQuery, n).exact)
        : [];
      const partialContacts = effectiveContactQuery && matchedContacts.length === 0
        ? allContacts.filter(n => contactNamesMatch(effectiveContactQuery, n).partial)
        : [];
      const salespersonMatch = !!(salesperson?.name && c.item.salesperson &&
        String(c.item.salesperson).includes(String(salesperson.name)));
      c.evidence = {
        isExact,
        isExactRaw,
        isExactNorm,
        sim,
        matchedContacts,
        partialContacts,
        totalContacts: allContacts.length,
        sampleContacts: allContacts.slice(0, 5),
        salespersonMatch,
        confirmedCount: confirmedCounts.get(c.item.id) || 0,
      };
      c.contacts = allContacts;
    }

    // ═══ Deterministic evidence boost: หลักฐานชี้ขาดได้เพียงตัวเดียว → ดันขึ้นอันดับ 1 ═══
    // ต้องทำก่อน slice 8 ไม่งั้นตัวถูกที่สัญญาณชื่ออ่อน (เช่น พีเคยู กับ query "เคยู") โดนตัดทิ้งก่อน
    // ลำดับความแข็งของหลักฐาน: raw-exact (รวมสาขา/วงเล็บ) > norm-exact > contact ตรง
    // boost เป็น 0.0 โดยไม่ penalty ตัวอื่น → ยังไม่ auto-select (gap แคบ) แต่ขึ้นอันดับ 1 ของ picker/AI
    const rawExacts = finalCandidates.filter(c => c.evidence.isExactRaw);
    const normExacts = finalCandidates.filter(c => c.evidence.isExactNorm);
    const exactContacts = finalCandidates.filter(c => c.evidence.matchedContacts.length > 0);
    if (rawExacts.length === 1) {
      rawExacts[0].score = 0.0;
    } else if (rawExacts.length === 0 && normExacts.length === 1) {
      normExacts[0].score = 0.0;
    } else if (exactContacts.length === 1) {
      // contact ชี้ขาดได้แม้มี record ชื่อซ้ำหลายตัว (เช่น ย่งฮง 2 แถว — ผู้ติดต่ออยู่แถวเดียว)
      exactContacts[0].score = 0.0;
    }

    // ═══ "ชื่อตรง + ผู้ติดต่อตรง" ต้องชนะ "ชื่อตรงอย่างเดียว" ═══
    // record ชื่อซ้ำ (บริษัทเดียวกันหลายสาขา เช่น TPCS 3 สาขา) ได้ 0.0 พร้อมกันจาก cleanName-exact
    // การ boost ตัวที่ผู้ติดต่อตรงเป็น 0.0 จึงไม่มีผล — คะแนนเสมอกัน ไม่มีใครชนะ
    // ต้องถ่างคู่แข่งที่ "ตรงแค่ชื่อ" ออกไปให้เกิน auto-select gap ด้วย หลักฐาน 2 ชั้นจึงจะชี้ขาดได้จริง
    const nameAndContact = finalCandidates.filter(c =>
      c.evidence.isExact && c.evidence.matchedContacts.length > 0);
    if (nameAndContact.length === 1) {
      const winner = nameAndContact[0];
      winner.score = 0.0;
      for (const c of finalCandidates) {
        if (c === winner) continue;
        // ไม่ถ่างตัวที่หลักฐานแข็งพอกัน: มีผู้ติดต่อตรงด้วย หรือชื่อตรงเป๊ะทั้งบรรทัด (แข็งกว่า norm-exact)
        if (c.evidence.matchedContacts.length > 0 || c.evidence.isExactRaw) continue;
        if ((c.score ?? 1) < NAME_ONLY_DEMOTED_SCORE) c.score = NAME_ONLY_DEMOTED_SCORE;
      }
      console.log(`[findCustomerCandidates] ✅ ชื่อ+ผู้ติดต่อตรงตัวเดียว: "${winner.item.display_name}" → ถ่างคู่แข่งที่ตรงแค่ชื่อ`);
    }
    finalCandidates.sort(compareCandidates);

    // ═══ คัดกรองรายชื่อ: ตัดตัวที่สัญญาณต่ำและไม่มี evidence อื่นเลย ═══
    const curated = finalCandidates.filter(c =>
      (c.score ?? 1) <= 0.32 || c.evidence.isExact || c.evidence.matchedContacts.length > 0);
    if (curated.length > 0) finalCandidates = curated;
    finalCandidates = finalCandidates.slice(0, 8);
  }

  // ═══ AI selection: ผู้ตัดสินหลักเมื่อกำกวม — เห็น evidence ครบทุก candidate ใน prompt ═══
  let aiDecided = false;
  if (finalCandidates.length > 1 && customerQuery && !isAiMatchDisabled()) {
    try {
      console.log(`[AI-Customer] ══════════════════════════════════════`);
      console.log(`[AI-Customer] customerQuery : "${customerQuery}"`);
      console.log(`[AI-Customer] contactQuery  : "${effectiveContactQuery || '-'}"`);
      finalCandidates.forEach((c, i) => {
        const e = c.evidence || {};
        console.log(`  ${i + 1}. "${c.item.display_name}" | exact:${e.isExact ? 'Y' : 'N'} sim:${Math.round((e.sim || 0) * 100)}% contact:[${(e.matchedContacts || []).join(',')}] confirmed:${e.confirmedCount || 0}`);
      });

      const evidenceLines = finalCandidates.map((c, i) => {
        const e = c.evidence || {};
        const contactInfo = e.matchedContacts?.length
          ? `ผู้ติดต่อในระบบที่ตรงกับในแชท: [${e.matchedContacts.join(', ')}] ✓`
          : e.partialContacts?.length
            ? `ผู้ติดต่อในระบบที่ใกล้เคียง: [${e.partialContacts.join(', ')}]`
            : `ผู้ติดต่อที่ตรง: ไม่มี (บริษัทนี้มีผู้ติดต่อ ${e.totalContacts ?? 0} คน${e.sampleContacts?.length ? ` เช่น ${e.sampleContacts.join(', ')}` : ''})`;
        const exactLabel = e.isExactRaw
          ? 'ตรงเป๊ะทั้งบรรทัดรวมสาขา/วงเล็บ ✓✓'
          : e.isExactNorm ? 'ตรงเมื่อไม่นับคำนำหน้า/สาขา/วงเล็บ ✓' : 'ไม่';
        return `${i + 1}. "${c.item.display_name}" | รหัสลูกค้า: ${c.item.reference || '-'}
   - ชื่อตรงกับที่เซลส์พิมพ์: ${exactLabel} | ความคล้ายของชื่อ: ${Math.round((e.sim || 0) * 100)}%
   - ${contactInfo}
   - เซลส์เจ้าของลูกค้าตรงกับผู้ส่งข้อความ: ${e.salespersonMatch ? 'ใช่ ✓' : 'ไม่'} | เคยออกใบเสนอราคายืนยันแล้ว: ${e.confirmedCount || 0} ครั้ง`;
      }).join('\n');

      const response = await createChatCompletion({
        messages: [
          {
            role: 'user',
            content: `คุณคือผู้เชี่ยวชาญจับคู่ชื่อลูกค้าจากข้อความแชทของเซลส์ กับบริษัทในระบบ (Customer Matcher)

ข้อความแชทจากเซลส์:
"${customerQuery}"

ชื่อผู้ติดต่อที่เซลส์ระบุ: "${effectiveContactQuery || '-'}"

ตัวเลือกบริษัท พร้อมหลักฐานที่ระบบตรวจสอบมาแล้ว (ข้อเท็จจริง ไม่ใช่การเดา):
${evidenceLines}

กติกาการชั่งน้ำหนักหลักฐาน (เรียงตามความสำคัญ):
1. "ตรงเป๊ะทั้งบรรทัดรวมสาขา/วงเล็บ ✓✓" คือหลักฐานแข็งแรงที่สุด — ถ้ามีตัวเดียว ให้เลือกตัวนั้น
   (ระวัง record ชื่อซ้ำ: ถ้าหลายตัว "ตรงเมื่อไม่นับสาขา/วงเล็บ ✓" พร้อมกัน ให้ใช้ผู้ติดต่อ/สาขาที่เซลส์ระบุชี้ขาด)
2. "ผู้ติดต่อในระบบที่ตรงกับในแชท" แข็งแรงมาก — เซลส์มักพิมพ์ชื่อบริษัทย่อๆ แต่ชื่อผู้ติดต่อชี้บริษัทที่ถูกได้แม่นยำ
3. ความคล้ายของชื่อ (%) สูงกว่าอย่างมีนัยสำคัญ + ประวัติเคยออกใบเสนอราคา ช่วยยืนยัน
4. ระวัง: บริษัทชื่อคล้ายกันอาจเป็นคนละนิติบุคคล (เช่น "ย่งฮง (ประเทศไทย)" ≠ "ย่งฮง เอ็นจิเนียริ่ง") — ห้ามเลือกข้ามถ้าหลักฐานผู้ติดต่อ/ชื่อเป๊ะชี้อีกตัว
5. ถ้าหลักฐานขัดแย้งกันหรือไม่มีตัวไหนเด่นชัด → choice: 0 (ให้ user เลือกเอง ปลอดภัยกว่าเดา)

ตอบเป็น JSON เท่านั้น:
{"choice": <1-${finalCandidates.length} หรือ 0>, "confidence": "<high|medium|low>", "reason": "<สั้นๆ>"}

ความหมาย confidence:
- high = หลักฐานชี้ชัดตัวเดียว (ชื่อเป๊ะ หรือผู้ติดต่อตรง) → ระบบจะเลือกให้อัตโนมัติ
- medium = ค่อนข้างแน่ใจแต่มีตัวลุ้นอื่น
- low = ไม่แน่ใจ (ระบบจะให้ user เลือกเอง)`
          }
        ]
      });

      const rawAnswer = (response.choices[0].message.content || '').trim();
      console.log(`[AI-Customer] RAW response : ${rawAnswer}`);

      let choice = 0;
      let confidence = 'low';
      try {
        const jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          choice = parseInt(String(parsed.choice ?? 0), 10) || 0;
          confidence = String(parsed.confidence || 'medium').toLowerCase();
          console.log(`[AI-Customer] CHOICE : ${choice} | CONFIDENCE : ${confidence}`);
          console.log(`[AI-Customer] REASON : ${parsed.reason || '-'}`);
        }
      } catch {
        console.log('[AI-Customer] parse error — treat as choice 0');
      }
      console.log(`[AI-Customer] ══════════════════════════════════════`);

      const idx = choice - 1;
      if (idx >= 0 && idx < finalCandidates.length && confidence !== 'low') {
        aiDecided = true;
        const chosen = finalCandidates[idx];
        console.log(`[AI-Customer] ✅ chosen: ${chosen.item.display_name} (${confidence})`);
        finalCandidates.forEach((c, index) => {
          if (index === idx) {
            // high → 0.0 ผ่าน auto-select gate; medium → 0.04 (ขึ้นอันดับ 1 แต่ไม่บังคับ auto)
            c.score = confidence === 'high' ? 0.0 : Math.min(c.score ?? 0.04, 0.04);
          } else if (confidence === 'high' && !c.evidence?.isExact && !(c.evidence?.matchedContacts?.length > 0)) {
            // penalty เฉพาะเมื่อ AI มั่นใจสูง และตัวนั้นไม่มีหลักฐาน deterministic แข็ง (ชื่อเป๊ะ/ผู้ติดต่อตรง)
            // ถ้า penalty ตอน medium จะไปถ่าง gap จน auto-select ทั้งที่ AI เองยังไม่แน่ใจ (เคยพลาดเคสสาขาโคราช)
            c.score = Math.max(c.score ?? 0.3, 0.3);
          }
        });
      }
    } catch (err) {
      console.error('[findCustomerCandidates] AI selection error:', err);
    }
  }

  // (deterministic evidence boost ทำไปแล้วก่อน slice — ที่นี่ไม่ต้อง fallback ซ้ำ)

  // Sort สุดท้าย: score ต่ำก่อน; คะแนนเท่ากัน (เช่น record ชื่อซ้ำได้ 0.0 คู่กัน) ให้ตัวที่หลักฐานแข็งกว่าขึ้นก่อน
  // แล้วตัดสินด้วย sim เป็นด่านสุดท้าย (ดูคอมเมนต์ที่ compareCandidates)
  finalCandidates.sort(compareCandidates);
  console.log('[findCustomerCandidates] Final results after AI check:', finalCandidates.map(r => `${r.item.display_name} (score: ${r.score})`));

  return finalCandidates;
}

const normalizePhone = (phoneStr: string | null | undefined): string => {
  if (!phoneStr) return '';
  const digits = phoneStr.replace(/[^0-9]/g, '');
  if (digits.length >= 9) {
    return digits.slice(-9);
  }
  return digits;
};

export function cleanContactNameExtra(name: string | null | undefined): string {
  if (!name) return '';
  // 1. Remove phone numbers
  let cleaned = name.replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, '');
  // 1.5 "K"/"K." = คำนำหน้าเรียกบุคคล ตัดเฉพาะตอนขึ้นต้นและมีชื่อตามหลัง เช่น "K นิว" → "นิว"
  cleaned = cleaned.replace(/^\s*[Kk]\.?\s*(?=[ก-๙A-Za-z])/, '');
  // 2. Remove common title/position words
  const titles = [
    'คุณ', 'นาย', 'นางสาว', 'นาง', 'นายแพทย์', 'แพทย์หญิง', 'ดร.',
    'จัดซื้อ', 'จัดซื้อ/ประสานงาน', 'ประสานงาน', 'ฝ่ายจัดซื้อ',
    'วิศวกร', 'ช่าง', 'ธุรการ', 'บัญชี', 'การเงิน', 'HR'
  ];
  for (const t of titles) {
    cleaned = cleaned.replace(new RegExp(t, 'gi'), '');
  }
  // 3. Remove punctuation
  cleaned = cleaned.replace(/[()\[\]{}.,\\/|:;!?^$*+_-]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.trim();
}

export async function findContactCandidates(customerId: any, contactQuery: string): Promise<any[]> {
  const phoneRegex = /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g;
  const phoneMatches = contactQuery.match(phoneRegex) || [];
  const searchPhones = phoneMatches.map(p => normalizePhone(p)).filter(Boolean);

  const cleaned = cleanContactNameExtra(contactQuery);

  const dbContacts = await getContactsByCustomerId(customerId);

  if (!dbContacts || dbContacts.length === 0) {
    return [];
  }

  // Fetch company default address once
  let companyDefaultAddr: any = null;
  const companyRows = await getCompanyAddressRows(customerId);

  if (companyRows && companyRows.length > 0) {
    companyDefaultAddr = companyRows.find((r: any) => r.invoice_street && r.invoice_street.trim()) || 
                         companyRows.find((r: any) => r.invoice_state && r.invoice_state.trim()) || 
                         companyRows[0];
  }

  // Construct address_complete on JavaScript side for each contact
  const cleanState = (s: any) => String(s || '').replace(/\s*\(.*/, '').split(/\s+/)[0].trim();
  const cleanAddressField = (fieldVal: any, rawState: any, zip: any) => {
    if (!fieldVal) return '';
    const cleanZip = String(zip || '').trim();
    const cleanStateVal = String(rawState || '').replace(/\s*\(.*/, '').trim();
    const words = fieldVal.split(/[\s,]+/).map((w: any) => w.trim()).filter(Boolean);
    const filtered = words.filter((word: any) => {
      const wordLower = word.toLowerCase();
      if (cleanZip && wordLower === cleanZip.toLowerCase()) return false;
      if (['thailand', 'th', 'china', 'taiwan', 'malaysia', 'singapore', 'israel'].includes(wordLower)) return false;
      if (cleanStateVal) {
        const stateLower = cleanStateVal.toLowerCase();
        if (stateLower.includes(wordLower) || wordLower.includes(stateLower)) return false;
      }
      return true;
    });
    return filtered.join(' ');
  };

  const contactsWithAddr = dbContacts.map((c: any) => {
    const hasAddr = (c.invoice_street && c.invoice_street.trim()) || (c.invoice_state && c.invoice_state.trim());
    const target = hasAddr ? c : (companyDefaultAddr || c);

    const stateCleaned = cleanState(target.invoice_state);
    const districtCleaned = cleanAddressField(target.invoice_district, target.invoice_state, target.invoice_zip);
    const subDistrictCleaned = cleanAddressField(target.invoice_sub_district, target.invoice_state, target.invoice_zip);

    const addr = [
      target.invoice_street,
      districtCleaned,
      subDistrictCleaned,
      stateCleaned,
      target.invoice_zip
    ].map(s => String(s || '').trim()).filter(Boolean).join(' ');

    return {
      ...c,
      invoice_street: target.invoice_street,
      invoice_district: districtCleaned,
      invoice_sub_district: subDistrictCleaned,
      invoice_state: stateCleaned,
      invoice_zip: target.invoice_zip,
      address_complete: addr || '-'
    };
  });

  const candidates = contactsWithAddr.map((c: any) => ({
    ...c,
    cleanName: cleanContactName(c.name || '')
  }));

  // 1. Phone matching
  let phoneMatchedCandidates: any[] = [];
  if (searchPhones.length > 0) {
    phoneMatchedCandidates = candidates.filter((c: any) => {
      const dbMobile = normalizePhone(c.mobile);
      const dbPhone = normalizePhone(c.phone);
      return searchPhones.some(sp => (dbMobile && dbMobile === sp) || (dbPhone && dbPhone === sp));
    }).map((c: any) => ({ item: c, score: 0.0 }));
  }

  if (phoneMatchedCandidates.length > 0) {
    return phoneMatchedCandidates;
  }

  // 2. Name matching with Fuse.js
  if (!cleaned) {
    return contactsWithAddr.map((c: any) => ({ item: c, score: 0 }));
  }

  // 2.5 Deterministic pre-pass: เทียบแบบ normalize (ช่องว่างหลังคำนำหน้า / ชื่อเล่นในวงเล็บ / ตำแหน่งต่อท้าย)
  // "คุณ มิค"↔"คุณมิค" exact→0.0, "คุณณัฐชา (พลอย)"↔"คุณพลอย" exact ผ่าน alias→0.0, ซ้อนบางส่วน→0.1
  // hit แล้ว return เลย (ผ่าน auto-confirm threshold <0.45 เดิมใน resolveContactFlow) ไม่ hit → Fuse เดิม
  const prePass = candidates
    .map((c: any) => {
      const m = contactNamesMatch(contactQuery, c.name || '');
      if (m.exact) return { item: c, score: 0.0 };
      if (m.partial) return { item: c, score: 0.1 };
      return null;
    })
    .filter(Boolean) as any[];
  if (prePass.length > 0) {
    prePass.sort((a, b) => a.score - b.score);
    console.log(`[findContactCandidates] deterministic pre-pass hit: ${prePass.map(p => `${p.item.name} (${p.score})`).join(', ')}`);
    return prePass;
  }

  const fuse = new (Fuse as any)(candidates, {
    keys: ['cleanName', 'name'],
    threshold: 0.5,
    includeScore: true
  });

  return fuse.search(cleaned).map((r: any) => ({
    item: r.item,
    score: r.score
  }));
}

export async function findCustomerByContactName(contactQuery: string, salesperson: any): Promise<any[]> {
  const cleaned = cleanContactName(contactQuery);
  if (!cleaned) return [];

  let branchCodes: string[] | null = null;
  if (salesperson && salesperson.branch_code) {
    const codes = salesperson.branch_code.split(',').map((c: any) => c.trim()).filter(Boolean);
    if (codes.length > 0) branchCodes = codes;
  }

  const dbContacts = await findContactsWithCustomerByName(cleaned, branchCodes, 50);
  if (!dbContacts || dbContacts.length === 0) {
    return [];
  }

  const candidates = dbContacts
    .filter((c: any) => c.customers)
    .map((c: any) => ({
      ...c,
      cleanName: cleanContactName(c.name || '')
    }));

  const fuse = new (Fuse as any)(candidates, {
    keys: ['cleanName', 'name'],
    threshold: 0.45,
    includeScore: true
  });

  const results = fuse.search(cleaned);

  const customerMap = new Map<any, any>();
  results.forEach((r: any) => {
    const item = r.item;
    const score = r.score;
    const custId = item.customers.id;

    if (!customerMap.has(custId) || customerMap.get(custId).score > score) {
      customerMap.set(custId, {
        id: custId,
        display_name: item.customers.display_name,
        contact_name: item.name,
        score: score
      });
    }
  });

  return Array.from(customerMap.values()).sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
}
