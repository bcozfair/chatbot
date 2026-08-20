// ─────────────────────────────────────────────────────────────────────────────
//  Cache ไฟล์ PDF ใบเสนอราคาที่ออกเลขแล้ว (in-memory, LRU + TTL)
//
//  ทำไมถึง cache ได้: ตั้งแต่มี print_snapshot ใบที่ออกเลขแล้วเจน PDF จากแถว quotations
//  แถวเดียวล้วน ๆ — freezePrintItems() ใน pdfGenerator แทนสต๊อกสดด้วย print_snapshot.item_stock
//  และแทน is_shipping_fee สดด้วย delivery_source ใน item_details, ชื่อ/เบอร์ผู้ขายอ่านจาก
//  employee_details, ค่าย PM/THT อ่านจาก prefix ของ quotation_no
//  ⇒ input เดียวที่อยู่นอกแถวคือไฟล์ลายเซ็นใน data/sale_sigs
//     ทุก endpoint ที่อัปโหลด/ลบลายเซ็นจึงต้องเรียก invalidatePdfCache()
//
//  คีย์ = sha256 ของทั้งแถว ไม่ใช่ updated_at เพราะสคริปต์ backfill (backfillPrintSnapshot,
//  backfillDeliveryTerms) แก้คอลัมน์ที่มีผลกับหน้าตา PDF โดยไม่แตะ updated_at
//
//  ห้ามย้ายไปเก็บบนดิสก์หรือ DB: แก้ template ใน pdfGenerator.ts แล้ว PDF เปลี่ยนแต่คีย์ไม่เปลี่ยน
//  เก็บใน memory จึงล้างตัวเองทุกครั้งที่ deploy = กันพลาดในตัว
//
//  ปิดทั้งหมดด้วย PDF_CACHE_MAX_ENTRIES=0
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';

// 200 ใบ ≈ 25 MB (ขนาดเฉลี่ยจริง 126 kB/ใบ)
//
// จาก log จริง 10 วัน (1,555 คำขอ / 443 ใบ) เพดาน 100 กับ 200 ให้ hit rate เท่ากันเป๊ะ (63.8%)
// แต่ soak test เจอจุดอ่อนของ LRU: ถ้ามีใครไล่โหลดใบเรียงเป็นวงจนเกินเพดาน ทุกใบจะถูกไล่ทิ้ง
// พอดีก่อนถูกเรียกซ้ำ ⇒ hit 0% (ทดสอบแล้ว: 50 ใบ = hit 100%, 150 ใบด้วยเพดาน 100 = hit 0%)
// 200 จึงเป็นค่าเผื่อไว้กันเคสนั้น โดยจ่ายเพิ่มแค่ 12 MB — ใบที่เคยถูกโหลดจริงทั้งหมดมี 443 ใบ (54 MB)
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  pdf: Buffer;
  storedAt: number;
}

// Map รักษาลำดับการใส่ไว้ให้เอง — delete+set = ดันขึ้นท้ายแถว, คีย์ตัวแรก = ตัวที่ถูกใช้นานสุด
const store = new Map<string, CacheEntry>();
let bytesHeld = 0;
const counters = { hit: 0, miss: 0, skip: 0, store: 0, evict: 0, expire: 0 };

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function maxEntries(): number { return envNum('PDF_CACHE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES); }
function maxBytes(): number { return envNum('PDF_CACHE_MAX_BYTES', DEFAULT_MAX_BYTES); }

function ttlMs(): number {
  // TTL เป็นแค่ตัวคุมอายุ ไม่ใช่ kill switch — ตั้ง 0 หรือค่าพังจะถอยไปใช้ค่า default
  // อยากปิด cache ให้ใช้ PDF_CACHE_MAX_ENTRIES=0
  const n = envNum('PDF_CACHE_TTL_MS', DEFAULT_TTL_MS);
  return n > 0 ? n : DEFAULT_TTL_MS;
}

function drop(key: string): void {
  const entry = store.get(key);
  if (!entry) return;
  bytesHeld -= entry.pdf.length;
  store.delete(key);
}

/**
 * คีย์ cache ของใบนี้ — คืน null แปลว่า "ห้าม cache" ให้เจนสดทุกครั้ง
 *
 * เงื่อนไขทั้งหมดตรวจจากแถวดิบก่อน enrich จึงไม่มี query เพิ่มแม้แต่ครั้งเดียว
 * และต้องตรงกับเงื่อนไขที่ freezePrintItems() ใช้ตัดสินว่าจะตรึงค่าให้หรือไม่ — ไม่ตรึง = ห้าม cache
 */
export function pdfCacheKey(quoteRow: any): string | null {
  if (maxEntries() <= 0 || !quoteRow) return null;

  // ใบร่างยังแก้ได้เรื่อย ๆ และไม่มี print_snapshot — เจนสดเสมอ (จากสถิติจริงไม่มีใครโหลดใบร่างอยู่แล้ว)
  if (!String(quoteRow.quotation_no || '').trim()) return null;

  const items = quoteRow.item_details;
  if (!Array.isArray(items) || items.length === 0) return null;

  // สต๊อกต้องถูกตรึงครบทุกบรรทัด ไม่งั้น PDF ยังขึ้นกับตาราง products
  const frozenStock = quoteRow.print_snapshot?.item_stock;
  if (!Array.isArray(frozenStock) || frozenStock.length !== items.length) return null;

  // และ is_shipping_fee ต้องถูกตรึงครบทุกบรรทัด ไม่งั้น PDF ยังขึ้นกับ config ค่าขนส่ง
  if (items.some((it: any) => !it || it.delivery_source === undefined)) return null;

  return crypto.createHash('sha256').update(JSON.stringify(quoteRow)).digest('hex');
}

/**
 * ด่านสุดท้ายก่อนเก็บ: freezePrintItems() จะตรึงค่าให้ก็ต่อเมื่อ items หลัง enrich
 * ยาวเท่ากับ item_details — ยาวไม่เท่ากันเมื่อไรแปลว่ามีค่าสดหลุดเข้า PDF ห้ามเก็บ
 */
export function isPrintFrozen(quoteRow: any, enrichedItems: any): boolean {
  return Array.isArray(enrichedItems)
    && Array.isArray(quoteRow?.item_details)
    && enrichedItems.length === quoteRow.item_details.length;
}

export function getCachedPdf(key: string | null): Buffer | null {
  if (!key || maxEntries() <= 0) { counters.skip++; return null; }

  const entry = store.get(key);
  if (!entry) { counters.miss++; return null; }

  if (Date.now() - entry.storedAt >= ttlMs()) {
    drop(key);
    counters.expire++;
    counters.miss++;
    return null;
  }

  // ดันขึ้นท้ายแถวเพื่อให้รอดจากการ evict รอบถัดไป
  store.delete(key);
  store.set(key, entry);
  counters.hit++;
  return entry.pdf;
}

export function setCachedPdf(key: string | null, pdf: Buffer): void {
  const cap = maxEntries();
  if (!key || cap <= 0 || !pdf?.length) return;

  const limitBytes = maxBytes();
  if (pdf.length > limitBytes) return;   // ใบเดียวใหญ่เกินโควตาทั้งก้อน — ไม่คุ้มเก็บ

  drop(key);
  store.set(key, { pdf, storedAt: Date.now() });
  bytesHeld += pdf.length;
  counters.store++;

  // เกินเพดานจำนวนหรือเพดานหน่วยความจำ → ทิ้งตัวที่ถูกใช้นานสุดทีละตัวจนกลับเข้าเกณฑ์
  while (store.size > cap || bytesHeld > limitBytes) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    drop(oldest);
    counters.evict++;
  }
}

/**
 * ล้าง cache ทั้งหมด — เรียกเมื่อมีอะไรที่อยู่ "นอกแถว quotations" เปลี่ยน
 * ตอนนี้มีอย่างเดียวคือไฟล์ลายเซ็น (อัปโหลด/ลบ) ซึ่งนาน ๆ ครั้งจึงล้างยกกระดานได้ ไม่ต้องแยกรายใบ
 */
export function invalidatePdfCache(reason?: string): void {
  const cleared = store.size;
  store.clear();
  bytesHeld = 0;
  if (cleared > 0) console.log(`[pdfCache] ล้าง cache ${cleared} ใบ${reason ? ` (${reason})` : ''}`);
}

/** ตัวเลขสำหรับ diag/สคริปต์ทดสอบ ไม่ได้ผูกกับ endpoint ใด */
export function pdfCacheStats() {
  return { entries: store.size, bytes: bytesHeld, ...counters };
}

/** ใช้ในสคริปต์ทดสอบเท่านั้น — โปรดักชันล้าง cache ด้วยการ restart หรือ invalidatePdfCache() */
export function __resetPdfCacheForTest(): void {
  store.clear();
  bytesHeld = 0;
  for (const k of Object.keys(counters)) (counters as any)[k] = 0;
}
