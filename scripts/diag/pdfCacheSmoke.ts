// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของ cache PDF ใบเสนอราคา (services/pdfCache.ts)
//  รัน:  npm run diag:pdf-cache              (ทดสอบใบจริง 3 ใบ)
//        npm run diag:pdf-cache -- 5         (ระบุจำนวนใบ)
//  อ่านอย่างเดียว — ไม่เขียนอะไรลง DB และไม่แตะไฟล์ ปลอดภัยบน production
//
//  คำถามที่สคริปต์นี้ตอบ:
//    (ก) คีย์กันของที่ห้าม cache ออกได้ครบไหม (ใบร่าง / ไม่มี print_snapshot / ตรึงไม่ครบทุกบรรทัด)
//    (ข) คีย์นิ่งเมื่ออ่านแถวเดิมซ้ำ และเปลี่ยนทันทีเมื่อมีคอลัมน์ใดที่มีผลกับ PDF ขยับ
//    (ค) LRU / TTL / เพดานหน่วยความจำ / kill switch ทำงานจริง
//    (ง) ไฟล์ที่เสิร์ฟจาก cache มีเนื้อหาเท่ากับการเจนสดทุกไบต์ที่ผู้ใช้มองเห็น
//        — ข้อนี้คือหัวใจ ถ้าพังแปลว่าลูกค้าอาจได้เอกสารผิด
//
//  ⚠️ เทียบไบต์ดิบของ PDF ไม่ได้ — Chrome ฝัง /CreationDate กับ /ID ที่เปลี่ยนทุกครั้ง
//     จึงแกะ Flate stream ออกมา hash ทีละก้อนแล้วเรียง (เทคนิคเดียวกับ diag:pdf-render)
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import zlib from 'zlib';
import { pool } from '../../config/db.js';
import { enrichQuotationData } from '../../services/quotationService.js';
import { generateQuotationPDF, closePdfBrowser } from '../../pdfGenerator.js';
import {
  pdfCacheKey, getCachedPdf, setCachedPdf, isPrintFrozen,
  invalidatePdfCache, pdfCacheStats, __resetPdfCacheForTest,
} from '../../services/pdfCache.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** hash ของทุก Flate stream เรียงแล้ว = ทุกอย่างที่ผู้ใช้เห็นบนกระดาษ */
function contentHash(buf: Uint8Array): string {
  const b = Buffer.from(buf);
  const hashes: string[] = [];
  let pos = 0;
  for (;;) {
    const s = b.indexOf('stream', pos);
    if (s === -1) break;
    let start = s + 'stream'.length;
    if (b[start] === 0x0d) start++;
    if (b[start] === 0x0a) start++;
    const end = b.indexOf('endstream', start);
    if (end === -1) break;
    try {
      hashes.push(crypto.createHash('sha256')
        .update(zlib.inflateSync(b.subarray(start, end))).digest('hex').slice(0, 12));
    } catch { /* stream ที่ไม่ได้บีบด้วย Flate */ }
    pos = end + 'endstream'.length;
  }
  return hashes.sort().join(',');
}

const resetEnv = () => {
  delete process.env.PDF_CACHE_MAX_ENTRIES;
  delete process.env.PDF_CACHE_MAX_BYTES;
  delete process.env.PDF_CACHE_TTL_MS;
};

// ═══ ส่วน A · ตรรกะของคีย์และตัว cache (ไม่แตะ DB) ══════════════════════════
console.log('\n── A · ตรรกะคีย์ ──');
resetEnv();
__resetPdfCacheForTest();

const row = () => ({
  id: '11111111-2222-3333-4444-555555555555',
  quotation_no: 'QP-260101001',
  created_at: new Date('2026-01-01T03:00:00.000Z'),
  updated_at: new Date('2026-01-02T03:00:00.000Z'),
  customer_details: { customer_name: 'ลูกค้า ก', payment_terms: 'เครดิต 30 วัน' },
  employee_details: { saleperson: 'สมชาย', sale_phone: '0800000000' },
  item_details: [
    { model: 'A-1', name: 'สินค้า ก', price: 100, quantity: 1, delivery_source: 'stock' },
    { model: 'SHIP', name: 'ค่าขนส่ง', price: 500, quantity: 1, delivery_source: 'shipping_fee' },
  ],
  print_snapshot: { item_stock: [7, 0], frozen_at: '2026-01-01T03:00:00.000Z' },
  salesperson_id: 'S001',
  total_sum: '600.00',
  status: 'confirmed',
});

ok('ใบปกติ → ได้คีย์ sha256', /^[0-9a-f]{64}$/.test(pdfCacheKey(row()) || ''));

const draft = row(); draft.quotation_no = null as any;
ok('ใบร่าง (ไม่มีเลขที่) → ห้าม cache', pdfCacheKey(draft) === null);
const blank = row(); blank.quotation_no = '   ';
ok('เลขที่เป็นช่องว่าง → ห้าม cache', pdfCacheKey(blank) === null);

const noSnap = row(); noSnap.print_snapshot = null as any;
ok('ไม่มี print_snapshot → ห้าม cache', pdfCacheKey(noSnap) === null);

const badLen = row(); badLen.print_snapshot = { item_stock: [7], frozen_at: 'x' };
ok('item_stock ยาวไม่เท่า item_details → ห้าม cache', pdfCacheKey(badLen) === null);

const noSrc = row(); delete (noSrc.item_details[1] as any).delivery_source;
ok('มีบรรทัดที่ไม่มี delivery_source → ห้าม cache', pdfCacheKey(noSrc) === null);

const noItems = row(); noItems.item_details = [] as any; noItems.print_snapshot = { item_stock: [], frozen_at: 'x' };
ok('ไม่มีรายการสินค้า → ห้าม cache', pdfCacheKey(noItems) === null);

ok('แถวว่าง/null → ห้าม cache', pdfCacheKey(null) === null && pdfCacheKey(undefined) === null);

// คีย์ต้องขยับตามทุกคอลัมน์ที่ pdfGenerator อ่าน
const base = pdfCacheKey(row())!;
const bump = (mut: (r: any) => void) => { const r = row(); mut(r); return pdfCacheKey(r) !== base; };
ok('คีย์เดิมเมื่อแถวเหมือนเดิม', pdfCacheKey(row()) === base);
ok('ราคาเปลี่ยน → คีย์เปลี่ยน', bump(r => { r.item_details[0].price = 101; }));
ok('จำนวนเปลี่ยน → คีย์เปลี่ยน', bump(r => { r.item_details[0].quantity = 2; }));
ok('ชื่อลูกค้าเปลี่ยน → คีย์เปลี่ยน', bump(r => { r.customer_details.customer_name = 'ลูกค้า ข'; }));
ok('ชื่อผู้ขายเปลี่ยน → คีย์เปลี่ยน', bump(r => { r.employee_details.saleperson = 'สมหญิง'; }));
ok('รหัสผู้ขายเปลี่ยน (ลายเซ็นคนละคน) → คีย์เปลี่ยน', bump(r => { r.salesperson_id = 'S002'; }));
ok('เลขที่ใบเปลี่ยน (ค่าย PM/THT) → คีย์เปลี่ยน', bump(r => { r.quotation_no = 'QT-260101001'; }));
ok('วันที่ออกใบเปลี่ยน → คีย์เปลี่ยน', bump(r => { r.created_at = new Date('2026-01-05T03:00:00.000Z'); }));
ok('สต๊อกที่ตรึงไว้เปลี่ยน (backfill ไม่แตะ updated_at) → คีย์เปลี่ยน',
  bump(r => { r.print_snapshot.item_stock = [0, 0]; }));
ok('delivery_source เปลี่ยน → คีย์เปลี่ยน', bump(r => { r.item_details[1].delivery_source = 'stock'; }));
ok('delivery_terms เปลี่ยน → คีย์เปลี่ยน', bump(r => { (r as any).delivery_terms = { days: 14 }; }));
ok('delivery_days_override เปลี่ยน → คีย์เปลี่ยน', bump(r => { (r as any).delivery_days_override = 30; }));

// ═══ ส่วน B · พฤติกรรมของตัวเก็บ ═══════════════════════════════════════════
console.log('\n── B · LRU / TTL / เพดาน ──');
__resetPdfCacheForTest();
const k1 = 'k1', k2 = 'k2', k3 = 'k3', k4 = 'k4';
const buf = (n: number, size = 1024) => Buffer.alloc(size, n);

setCachedPdf(k1, buf(1));
const got = getCachedPdf(k1);
ok('เก็บแล้วอ่านได้ไบต์เดิม', !!got && got.equals(buf(1)));
ok('คีย์ที่ไม่เคยเก็บ → null', getCachedPdf('ไม่มีจริง') === null);
ok('คีย์ null → null และไม่พัง', getCachedPdf(null) === null);

process.env.PDF_CACHE_MAX_ENTRIES = '3';
__resetPdfCacheForTest();
setCachedPdf(k1, buf(1)); setCachedPdf(k2, buf(2)); setCachedPdf(k3, buf(3));
setCachedPdf(k4, buf(4));
ok('เกินเพดานจำนวน → ตัวเก่าสุดหลุด', getCachedPdf(k1) === null && pdfCacheStats().entries === 3);
ok('ตัวที่เหลืออยู่ครบ', !!getCachedPdf(k2) && !!getCachedPdf(k3) && !!getCachedPdf(k4));

__resetPdfCacheForTest();
setCachedPdf(k1, buf(1)); setCachedPdf(k2, buf(2)); setCachedPdf(k3, buf(3));
getCachedPdf(k1);                    // ใช้ k1 → ต้องรอด
setCachedPdf(k4, buf(4));
ok('LRU: ตัวที่เพิ่งถูกใช้รอด ตัวที่ไม่ได้ใช้หลุดแทน',
  !!getCachedPdf(k1) && getCachedPdf(k2) === null);

process.env.PDF_CACHE_MAX_BYTES = String(3 * 1024);
__resetPdfCacheForTest();
setCachedPdf(k1, buf(1)); setCachedPdf(k2, buf(2)); setCachedPdf(k3, buf(3)); setCachedPdf(k4, buf(4));
ok('เกินเพดานไบต์ → ไล่ทิ้งจนเข้าเกณฑ์', pdfCacheStats().bytes <= 3 * 1024);
__resetPdfCacheForTest();
setCachedPdf(k1, buf(1, 10 * 1024));
ok('ไฟล์เดียวใหญ่เกินโควตาทั้งก้อน → ไม่เก็บ', pdfCacheStats().entries === 0);
delete process.env.PDF_CACHE_MAX_BYTES;

process.env.PDF_CACHE_TTL_MS = '60';
__resetPdfCacheForTest();
setCachedPdf(k1, buf(1));
ok('ยังไม่หมดอายุ → hit', !!getCachedPdf(k1));
await sleep(90);
ok('หมดอายุแล้ว → miss และคืนหน่วยความจำ',
  getCachedPdf(k1) === null && pdfCacheStats().entries === 0 && pdfCacheStats().bytes === 0);
delete process.env.PDF_CACHE_TTL_MS;

process.env.PDF_CACHE_MAX_ENTRIES = '0';
__resetPdfCacheForTest();
setCachedPdf(k1, buf(1));
ok('kill switch (MAX_ENTRIES=0) → ไม่เก็บ ไม่คืนคีย์',
  pdfCacheStats().entries === 0 && getCachedPdf(k1) === null && pdfCacheKey(row()) === null);
resetEnv();

__resetPdfCacheForTest();
setCachedPdf(k1, buf(1)); setCachedPdf(k2, buf(2));
invalidatePdfCache('ทดสอบ');
ok('invalidatePdfCache ล้างเกลี้ยง (ใช้ตอนแก้ลายเซ็น)',
  pdfCacheStats().entries === 0 && pdfCacheStats().bytes === 0 && getCachedPdf(k1) === null);

ok('isPrintFrozen: items ยาวเท่า item_details → เก็บได้', isPrintFrozen(row(), [{}, {}]));
ok('isPrintFrozen: ยาวไม่เท่า → ห้ามเก็บ', !isPrintFrozen(row(), [{}]));
ok('isPrintFrozen: ไม่มี items → ห้ามเก็บ', !isPrintFrozen(row(), undefined));

// ═══ ส่วน C · ใบจริงบน production (อ่านอย่างเดียว) ═════════════════════════
const wanted = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) || 3);
console.log(`\n── C · ใบจริง ${wanted} ใบ ──`);
resetEnv();
__resetPdfCacheForTest();

const { rows: quotes } = await pool.query(
  `SELECT * FROM quotations
    WHERE quotation_no IS NOT NULL AND print_snapshot IS NOT NULL
    ORDER BY created_at DESC LIMIT $1`, [wanted]);
ok(`หาใบที่ออกเลขแล้วมาทดสอบได้ ${quotes.length}/${wanted} ใบ`, quotes.length > 0);

const keysSeen = new Map<string, string>();
for (const q of quotes) {
  const label = q.quotation_no;
  const key = pdfCacheKey(q);
  if (!key) { ok(`${label}: ได้คีย์`, false, '(ใบนี้ยัง cache ไม่ได้)'); continue; }

  // คีย์ต้องนิ่งเมื่ออ่านแถวเดิมใหม่จาก DB — jsonb/numeric/timestamp ต้อง serialize เหมือนเดิมทุกครั้ง
  const { rows: [again] } = await pool.query('SELECT * FROM quotations WHERE id = $1', [q.id]);
  ok(`${label}: คีย์นิ่งเมื่อ query ซ้ำ`, pdfCacheKey(again) === key);
  ok(`${label}: คีย์ไม่ชนกับใบอื่น`, !keysSeen.has(key), keysSeen.get(key) || '');
  keysSeen.set(key, label);

  // เดินเส้นทางเดียวกับ downloadPdfHandler ทุกขั้น
  const enriched = await enrichQuotationData(q);
  const fresh = Buffer.from(await generateQuotationPDF(enriched, enriched.quotation_no));
  ok(`${label}: freezePrintItems ตรึงค่าครบ (ผ่านด่านก่อนเก็บ)`, isPrintFrozen(q, enriched.items));
  setCachedPdf(key, fresh);

  const hit = getCachedPdf(key);
  ok(`${label}: hit คืนไบต์เดิมทั้งก้อน`, !!hit && hit.equals(fresh));

  // ★ ข้อสำคัญที่สุด: ไฟล์ที่เสิร์ฟจาก cache ต้องมีเนื้อหาเท่าการเจนสดรอบใหม่
  const again2 = await generateQuotationPDF(await enrichQuotationData(again), again.quotation_no);
  ok(`${label}: เนื้อหาที่ cache ไว้ = เนื้อหาที่เจนสด`, contentHash(hit!) === contentHash(again2));

  // แก้ใบ (เช่น revise/แก้ราคา) → คีย์ต้องเปลี่ยน = miss ไม่เสิร์ฟของเก่า
  const edited = { ...q, item_details: q.item_details.map((it: any, i: number) =>
    i === 0 ? { ...it, price: Number(it.price || 0) + 137.5 } : it) };
  const editedKey = pdfCacheKey(edited);
  ok(`${label}: แก้ราคา → คีย์เปลี่ยน จึงไม่ได้ของเก่า`,
    !!editedKey && editedKey !== key && getCachedPdf(editedKey) === null);
}

const stats = pdfCacheStats();
console.log(`\ncache: ${stats.entries} ใบ · ${(stats.bytes / 1024).toFixed(0)} kB · ` +
  `hit=${stats.hit} miss=${stats.miss} store=${stats.store} evict=${stats.evict} expire=${stats.expire}`);

console.log(failures === 0
  ? `\n✅ ผ่านทั้งหมด`
  : `\n❌ ไม่ผ่าน ${failures} ข้อ`);

await closePdfBrowser().catch(() => {});
await pool.end();
process.exit(failures === 0 ? 0 : 1);
