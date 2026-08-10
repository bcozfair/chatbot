// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของการเจน PDF ใบเสนอราคา
//  รัน:  npm run diag:pdf-render                 (หยิบใบล่าสุดที่มีเลขที่มาทดสอบ)
//        npm run diag:pdf-render -- <quoteId>    (ระบุใบเอง)
//  อ่านอย่างเดียว — ไม่เขียนอะไรลง DB ปลอดภัยบน production
//
//  โจทย์ที่สคริปต์นี้เฝ้า — ทั้งหมดมาจากการเปลี่ยน waitUntil ของ pdfGenerator:
//    (ก) ฟอนต์ต้องถูกฝังครบ · ถ้า document.fonts.ready ไม่ทำงาน Chrome จะพิมพ์ด้วยฟอนต์ fallback
//        ของเครื่อง (Garuda/Loma จาก fonts-thai-tlwg) แล้ว PDF เพี้ยนแบบเงียบ ๆ ไม่มี error ให้จับ
//        นี่คือความเสี่ยงหลักของการเลิกใช้ networkidle0 และเป็นเหตุผลที่ต้องมีไฟล์นี้
//    (ข) ผลลัพธ์ต้องนิ่ง · เจนใบเดิมซ้ำต้องได้เนื้อหาเดียวกันทุกรอบ ไม่ใช่แข่งกับการโหลดฟอนต์
//    (ค) เวลาต้องไม่ถอยกลับ · จับกรณีมีคนเปลี่ยน waitUntil กลับเป็น networkidle0 (ซึ่งเพิ่ม ~1.4 วิ/ใบ)
//
//  ⚠️ เทียบ "ไบต์ดิบ" ของ PDF ไม่ได้ — Chrome ฝัง /CreationDate กับ /ID ที่เปลี่ยนทุกครั้ง
//     จึงต้องแกะ stream ที่บีบด้วย Flate ออกมา hash ทีละก้อนแล้วเรียง (= คำสั่งวาดบนหน้ากระดาษ
//     กับไฟล์ฟอนต์ที่ฝัง) ซึ่งเป็นทุกอย่างที่ผู้ใช้เห็นจริง
//
//  ให้รันซ้ำทุกครั้งที่แตะ pdfGenerator.ts
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import zlib from 'zlib';
import puppeteer from 'puppeteer';
import { pool } from '../../config/db.js';
import { enrichQuotationData } from '../../services/quotationService.js';
import { generateQuotationPDF, closePdfBrowser } from '../../pdfGenerator.js';

/** รอบอุ่นเครื่อง 1 รอบ (จ่ายค่า launch Chrome) แล้ววัดจริง 5 รอบ */
const WARMUP = 1;
const RUNS = 5;

/**
 * ─── ทำไมไม่ใช้ตัวเลขเพดานตายตัว ────────────────────────────────────────────────
 *
 * เครื่อง prod เป็น 4 core ที่แชร์กับโปรเจกต์อื่น เคยเห็น load average แตะ 7.65 ตอนนั้นการเจน
 * ใบเดียวกันด้วยโค้ดที่ถูกต้องกินตั้งแต่ 654 ถึง 2,062 ms ⇒ เพดานตายตัวจะ fail แบบสุ่ม
 * จนไม่มีใครเชื่อผลอีก แต่ถ้าตั้งหลวมพอจะไม่ fail มันก็สูงกว่าพื้นของ networkidle0 (~1,930 ms)
 * ไปแล้ว = จับสิ่งที่ต้องจับไม่ได้
 *
 * จึงวัด "พื้นของ networkidle0 บนเครื่องนี้ ณ ตอนรัน" เอาเองด้วยหน้าเปล่า แล้วเทียบ:
 * หน้าเปล่าคือปริมาณงานที่น้อยที่สุดเท่าที่เป็นไปได้ ถ้าการเจนใบเสนอราคาเต็มใบ (ซึ่งทำงาน
 * มากกว่าอย่างแน่นอน) ยังเร็วกว่าหน้าเปล่าที่รอแบบ networkidle0 ก็แปลว่าไม่ได้รอแบบนั้นแล้วแน่นอน
 * เกณฑ์นี้ปรับตามภาระเครื่องได้เอง เพราะทั้งสองฝั่งเจอภาระชุดเดียวกัน
 */
async function measureNetworkIdleFloor(): Promise<number> {
  const browser = await puppeteer.launch({
    headless: 'new' as any,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const t0 = Date.now();
    await page.setContent('<!doctype html><html><body>x</body></html>',
      { waitUntil: 'networkidle0' as any });
    const ms = Date.now() - t0;
    await page.close();
    return ms;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** ฟอนต์ที่ต้องเห็นใน PDF — ชื่อใน /BaseFont มี prefix ของ subset นำหน้า เช่น AAAAAA+Sarabun-Bold */
const REQUIRED_FONTS = ['Sarabun-Regular', 'Sarabun-Bold'];

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/** hash ของทุก Flate stream เรียงแล้ว — ตัดผลของลำดับ object ที่สลับได้ระหว่างรอบ */
function contentHashes(buf: Uint8Array): { hashes: string[]; undecodable: number } {
  const b = Buffer.from(buf);
  const hashes: string[] = [];
  let pos = 0;
  let undecodable = 0;
  for (;;) {
    const s = b.indexOf('stream', pos);
    if (s === -1) break;
    let start = s + 'stream'.length;
    if (b[start] === 0x0d) start++;          // CR
    if (b[start] === 0x0a) start++;          // LF
    const end = b.indexOf('endstream', start);
    if (end === -1) break;
    try {
      hashes.push(crypto.createHash('sha256')
        .update(zlib.inflateSync(b.subarray(start, end))).digest('hex').slice(0, 12));
    } catch {
      undecodable++;                          // stream ที่ไม่ได้บีบด้วย Flate — ไม่ใช่ความผิดพลาด
    }
    pos = end + 'endstream'.length;
  }
  return { hashes: hashes.sort(), undecodable };
}

/** ชื่อฟอนต์ใน /BaseFont มี prefix ของ subset นำหน้า (AAAAAA+Sarabun-Bold) — ตัดทิ้งก่อนค่อย dedupe */
const embeddedFonts = (buf: Uint8Array): string[] =>
  [...new Set((Buffer.from(buf).toString('latin1')
    .match(/\/BaseFont\s*\/[A-Za-z0-9]*\+?[A-Za-z0-9\-]+/g) ?? [])
    .map(s => s.replace(/^\/BaseFont\s*\/(?:[A-Z]{6}\+)?/, '')))].sort();

// ── หาใบที่จะใช้ทดสอบ ─────────────────────────────────────────────────────────
const argId = process.argv.slice(2).find(a => !a.startsWith('-'));
const picked = argId
  ? await pool.query('SELECT * FROM quotations WHERE id = $1', [argId])
  : await pool.query(
      `SELECT * FROM quotations WHERE quotation_no IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`);

const quote = picked.rows[0];
if (!quote) {
  console.log('✗ FAIL  ไม่พบใบเสนอราคาที่จะใช้ทดสอบ');
  await pool.end();
  process.exit(1);
}
console.log(`\nใบที่ใช้ทดสอบ: ${quote.quotation_no ?? 'DRAFT'} (${quote.id})`);

const enriched = await enrichQuotationData(quote);
const quoteNo = enriched.quotation_no || 'DRAFT';

// ── เจนจริง ───────────────────────────────────────────────────────────────────
for (let i = 0; i < WARMUP; i++) await generateQuotationPDF(enriched, quoteNo);

const times: number[] = [];
const contentSets = new Set<string>();
let last: { bytes: number; fonts: string[]; streams: number; undecodable: number } | null = null;

for (let i = 0; i < RUNS; i++) {
  const t0 = Date.now();
  const buf = await generateQuotationPDF(enriched, quoteNo);
  times.push(Date.now() - t0);
  const { hashes, undecodable } = contentHashes(buf);
  contentSets.add(hashes.join(','));
  last = { bytes: buf.length, fonts: embeddedFonts(buf), streams: hashes.length, undecodable };
}

console.log(`\n── ผล (${RUNS} รอบ หลังอุ่นเครื่อง ${WARMUP} รอบ) ──`);
console.log(`เวลา: ${times.join(' / ')} ms (เร็วสุด ${Math.min(...times)})` +
            ` · ขนาด ${last!.bytes} ไบต์ · ${last!.streams} stream`);
console.log(`ฟอนต์ที่ฝัง: ${last!.fonts.join(', ') || '(ไม่มี)'}`);

console.log('\n── ตรวจ ──');
for (const f of REQUIRED_FONTS) {
  ok(`ฝังฟอนต์ ${f}`, last!.fonts.includes(f),
     last!.fonts.includes(f) ? '' : '← ฟอนต์ไม่ทันโหลด PDF จะเพี้ยน');
}
ok('เนื้อหานิ่งทุกรอบ', contentSets.size === 1, `ได้ ${contentSets.size} แบบใน ${RUNS} รอบ`);
ok('ทุก stream แกะได้', last!.undecodable === 0, `แกะไม่ออก ${last!.undecodable}`);
const fastest = Math.min(...times);
const floor = await measureNetworkIdleFloor();
ok(`เร็วกว่าพื้นของ networkidle0 บนเครื่องนี้ (${floor}ms กับหน้าเปล่า)`, fastest < floor,
   fastest < floor
     ? `เร็วสุด ${fastest}ms`
     : `เร็วสุด ${fastest}ms ← เจนเต็มใบยังช้ากว่าหน้าเปล่า แปลว่ายังรอแบบ networkidle0 อยู่`);

console.log(`\n${failures === 0 ? '✓ ผ่านทั้งหมด' : `✗ ล้มเหลว ${failures} ข้อ`}`);
await closePdfBrowser();
await pool.end();
process.exit(failures === 0 ? 0 : 1);
