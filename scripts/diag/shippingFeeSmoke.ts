// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกฎค่าขนส่งอัตโนมัติ
//  รัน:  npm run diag:shipping-fee
//
//  ส่วนที่ 1-5 เป็น pure/read-only ส่วนที่ 6 เขียนใบทดสอบลง DB จริงแล้วลบทิ้ง
//  ⚠️ เขียน/ลบข้อมูลจริง — รันกับ dev DB เท่านั้น (สคริปต์ abort ถ้าชื่อ DB มีคำว่า prod)
//
//  ครอบคลุม: การอ่านเครดิตเทอม (เทียบค่าจริงทุกค่าในฐานข้อมูล) · การระบุบรรทัดค่าขนส่ง ·
//            ฐานยอดที่ใช้ตัดสิน · ขอบเกณฑ์ · shape ของ snapshot · round-trip ผ่าน
//            buildItemSnapshots · ผลต่อวันจัดส่ง · การกรองออกจากผลค้นหา ·
//            parity ระหว่างกฎฝั่ง LIFF กับฝั่ง server · การใส่/ถอด/ย้ายบรรทัดข้ามใบ PM+THT
//  ให้รันซ้ำทุกครั้งที่แตะ services/shippingFee.ts หรือกฎค่าขนส่งใน quote-edit.html
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { pool } from '../../config/db.js';
import {
  loadShippingFeeConfig, hasCreditTerms, isShippingFeeItem,
  goodsSubtotal, buildShippingFeeSnapshot, applyShippingFeeToQuoteGroup
} from '../../services/shippingFee.js';
import { buildItemSnapshots, resolveQuotationDeliveryDays } from '../../services/quotationService.js';
import { findProduct } from '../../services/productService.js';

const ok = (label: string, cond: boolean, extra = '') =>
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

const TAG = 'shipping-fee-diag';
const USER = 'Udiagship0001';
const USER_B = 'Udiagship0002';

if ((process.env.PG_DATABASE || '').toLowerCase().includes('prod')) {
  console.error('❌ ปฏิเสธการรัน: PG_DATABASE ดูเหมือน production — สคริปต์นี้เขียน/ลบข้อมูลจริง');
  process.exit(1);
}

// ── 1. config โหลดจาก DB จริง ───────────────────────────────────────────
const cfg = await loadShippingFeeConfig();
console.log(`   config: active=${cfg.isActive} threshold=${cfg.thresholdBeforeVat} price=${cfg.feePrice}` +
  ` qty=${cfg.feeQuantity} name="${cfg.defaultItemName}" ref=${cfg.productInternalReference}` +
  ` productId=${cfg.productId} model=${cfg.productModel}`);
ok('โหลด config ได้และผูกกับแถวสินค้าใน products สำเร็จ',
  cfg.productId !== null && cfg.productModel !== '',
  cfg.productId === null ? '← ยังไม่ได้รัน migration 2026-07-22_01_shipping_fee.sql' : '');

const cached = await loadShippingFeeConfig();
ok('เรียกครั้งที่ 2 มาจาก cache', cached === cfg);

// ── 2. เครดิตเทอม — เทียบกับค่าที่มีจริงในฐานข้อมูลทุกค่า ───────────────
//  ทุกค่าที่ไม่ใช่รูปแบบ "<เลข> Days" ถือว่าไม่มีเครดิต → เข้าเงื่อนไขค่าขนส่ง
const { rows: termRows } = await pool.query(
  `SELECT DISTINCT customer_payment_terms AS t FROM customers ORDER BY 1`
);
let creditCount = 0;
let noCreditCount = 0;
for (const row of termRows) {
  const isCredit = hasCreditTerms(row.t);
  if (isCredit) creditCount++; else noCreditCount++;
  console.log(`   ${(isCredit ? 'มีเครดิต' : 'ไม่มีเครดิต').padEnd(12)} ${JSON.stringify(row.t)}`);
}
ok('จำแนกเครดิตเทอมครบทุกค่าในฐานข้อมูล',
  termRows.length > 0, `${termRows.length} ค่า (มีเครดิต ${creditCount} / ไม่มี ${noCreditCount})`);

// เคสขอบที่ regex ต้องจัดการให้ถูก
ok('"30 Days" = มีเครดิต', hasCreditTerms('30 Days'));
ok('เว้นวรรคหน้า/หลังไม่มีผล', hasCreditTerms('  60 Days  '));
ok('พิมพ์เล็กก็ยังจับได้ ("5 days")', hasCreditTerms('5 days'));
ok('ไม่มีช่องว่างก็ยังจับได้ ("30days")', hasCreditTerms('30days'));
ok('null / "" / undefined = ไม่มีเครดิต',
  !hasCreditTerms(null) && !hasCreditTerms('') && !hasCreditTerms(undefined));
ok('"Cash" = ไม่มีเครดิต', !hasCreditTerms('Cash'));
ok('"เช็คล่วงหน้า30วัน" = ไม่มีเครดิต', !hasCreditTerms('เช็คล่วงหน้า30วัน'));
ok('"Immediate Payment" = ไม่มีเครดิต', !hasCreditTerms('Immediate Payment'));
ok('"Days" เปล่า ๆ = ไม่มีเครดิต', !hasCreditTerms('Days'));
ok('"Net 30 Days" = ไม่มีเครดิต (ต้องตรงทั้งสตริง)', !hasCreditTerms('Net 30 Days'));

// ── 3. ระบุบรรทัดค่าขนส่ง ───────────────────────────────────────────────
ok('จับได้จาก model', isShippingFeeItem({ model: cfg.productModel }, cfg));
ok('จับได้จาก product_code', isShippingFeeItem({ product_code: cfg.productModel }, cfg));
ok('จับได้จาก internal_reference', isShippingFeeItem({ internal_reference: cfg.productInternalReference }, cfg));
ok('สินค้าปกติไม่ถูกจับผิด', !isShippingFeeItem({ model: 'BH-02 112x200-220-1200W' }, cfg));
ok('item ว่าง/null ไม่ throw', !isShippingFeeItem({}, cfg) && !isShippingFeeItem(null, cfg));

// ── 4. ฐานยอดที่ใช้ตัดสิน — ต้องไม่นับค่าขนส่งเข้าไปในฐาน ────────────────
const feeLine = buildShippingFeeSnapshot(cfg);
const goods = [
  { model: 'A', price: 100, quantity: 5, discount_1: 10, discount_2: 0 }, // 450
  { model: 'B', price: 50, quantity: 2, discount_1: 0, discount_2: 0 }    // 100
];
ok('goodsSubtotal หลังหักส่วนลด', goodsSubtotal(goods, cfg) === 550, String(goodsSubtotal(goods, cfg)));
ok('goodsSubtotal ตัดบรรทัดค่าขนส่งออกจากฐาน',
  goodsSubtotal([...goods, feeLine], cfg) === 550,
  String(goodsSubtotal([...goods, feeLine], cfg)));
ok('ใบว่าง → 0', goodsSubtotal([], cfg) === 0 && goodsSubtotal(null, cfg) === 0);

// ขอบเกณฑ์ (กฎจริงคือ goods < threshold — 1000.00 พอดีต้องไม่โดน)
const under = goodsSubtotal([{ price: 999.99, quantity: 1 }], cfg);
const exact = goodsSubtotal([{ price: 1000, quantity: 1 }], cfg);
const over = goodsSubtotal([{ price: 1000.01, quantity: 1 }], cfg);
ok('999.99 < เกณฑ์ → คิดค่าขนส่ง', under < cfg.thresholdBeforeVat);
ok('1000.00 พอดี → ไม่คิด (เกณฑ์เป็น "น้อยกว่า" ไม่ใช่ "ไม่เกิน")', !(exact < cfg.thresholdBeforeVat));
ok('1000.01 → ไม่คิด', !(over < cfg.thresholdBeforeVat));

// ── 5. shape ของ snapshot ต้องตรงกับที่ buildItemSnapshots สร้าง ─────────
//  ถ้า shape ไม่ตรง บรรทัดค่าขนส่งจะหลุด index กับ snapshot ตัวอื่นตอนคำนวณวันจัดส่ง
const expectedKeys = ['internal_reference', 'product_id', 'model', 'name', 'sales_description',
  'price', 'quantity', 'discount_1', 'discount_2', 'remark', 'brand', 'series', 'production',
  'warranty_display', 'delivery_in_stock_days', 'delivery_out_of_stock_days', 'delivery_source', 'is_optional'];
ok('snapshot มี field ครบและไม่เกิน',
  JSON.stringify(Object.keys(feeLine)) === JSON.stringify(expectedKeys),
  Object.keys(feeLine).join(','));
ok('บรรทัดใหม่ใช้ค่าตั้งต้นจาก config',
  feeLine.name === cfg.defaultItemName && feeLine.price === cfg.feePrice && feeLine.quantity === cfg.feeQuantity);
ok('บรรทัดใหม่ถูกจับว่าเป็นค่าขนส่ง (round-trip)', isShippingFeeItem(feeLine, cfg));
ok('ไม่มีส่วนลดติดมา', feeLine.discount_1 === 0 && feeLine.discount_2 === 0);

const edited = buildShippingFeeSnapshot(cfg, { name: 'ค่าจัดส่งด่วน', price: 350 });
ok('ชื่อ/ราคาที่เซลล์แก้อยู่รอดเมื่อกฎรันซ้ำ',
  edited.name === 'ค่าจัดส่งด่วน' && edited.price === 350);
const zeroed = buildShippingFeeSnapshot(cfg, { name: '   ', price: 0 });
ok('ราคา 0 ที่เซลล์ตั้งเองต้องไม่ถูกดีดกลับเป็นค่าตั้งต้น', zeroed.price === 0);
ok('ชื่อว่าง/เว้นวรรคล้วน → ถอยไปใช้ค่าตั้งต้น', zeroed.name === cfg.defaultItemName);
const noPrice = buildShippingFeeSnapshot(cfg, { name: 'x' });
ok('บรรทัดเดิมที่ไม่มีราคา → ใช้ค่าตั้งต้น', noPrice.price === cfg.feePrice);

// ── 6. round-trip ผ่าน buildItemSnapshots + ผลต่อวันจัดส่ง/สต๊อก ─────────
//  เส้นทางจริง: LIFF ส่ง items กลับมา → PUT เรียก buildItemSnapshots → เขียนทับ item_details
//  ถ้าตรงนี้ไม่รักษาชื่อ/ราคา หรือไม่ปั๊มมาร์ก delivery_source ไว้ กฎจะพังเงียบทุกครั้งที่บันทึก
const rt = await buildItemSnapshots([
  { model: cfg.productModel, product_id: cfg.productId, name: 'ค่าจัดส่งด่วน', price: 350, quantity: 1 }
]);
ok('buildItemSnapshots: ชื่อที่เซลล์แก้ไม่ถูกชื่อ "ค่าบริการ" จาก products ทับ',
  rt[0]?.name === 'ค่าจัดส่งด่วน', `ได้ "${rt[0]?.name}"`);
ok('buildItemSnapshots: ราคาที่เซลล์แก้อยู่รอด', rt[0]?.price === 350);
ok('buildItemSnapshots: จำนวนถูกล็อกตาม config (เซลล์แก้ไม่ได้)',
  (await buildItemSnapshots([{ model: cfg.productModel, name: 'x', price: 200, quantity: 99 }]))[0]?.quantity === cfg.feeQuantity);
ok('buildItemSnapshots: ปั๊มมาร์ก delivery_source = shipping_fee', rt[0]?.delivery_source === 'shipping_fee');
ok('buildItemSnapshots: ส่วนลดถูกล็อกเป็น 0',
  (await buildItemSnapshots([{ model: cfg.productModel, name: 'x', price: 200, quantity: 1, discount_1: 50 }]))[0]?.discount_1 === 0);

// วันจัดส่ง: บรรทัดค่าขนส่ง (stock 0) ต้องไม่ลากทั้งใบไปเป็นเคสของขาด
const realSnap = { delivery_in_stock_days: 3, delivery_out_of_stock_days: 45, delivery_source: 'base' };
const withFee = resolveQuotationDeliveryDays(
  [{ quantity: 1, stock: 10 }, { quantity: 1, stock: 0 }],
  [realSnap, rt[0]]
);
ok('วันจัดส่ง: ค่าขนส่งไม่ดึงทั้งใบเป็น "ของไม่พอ"',
  withFee.all_in_stock === true && withFee.days === 3, JSON.stringify(withFee));
const withoutFee = resolveQuotationDeliveryDays([{ quantity: 1, stock: 10 }], [realSnap]);
ok('วันจัดส่ง: ผลเท่ากับตอนไม่มีบรรทัดค่าขนส่งเลย',
  withFee.days === withoutFee.days && withFee.all_in_stock === withoutFee.all_in_stock);
const realOut = resolveQuotationDeliveryDays(
  [{ quantity: 99, stock: 0 }, { quantity: 1, stock: 0 }],
  [realSnap, rt[0]]
);
ok('วันจัดส่ง: สินค้าจริงขาดสต๊อกยังคิด 45 วันตามเดิม',
  realOut.days === 45 && realOut.all_in_stock === false, JSON.stringify(realOut));

// สินค้าตัวนี้ต้องไม่โผล่ในตัวจับคู่ของ AI ทั้งผลที่เลือกแล้วและรายการตัวเลือก
const mentionsFee = (r: { product?: { model?: string }; candidates: { model?: string }[] }) =>
  r.product?.model === cfg.productModel ||
  r.candidates.some(c => c.model === cfg.productModel);

const foundByRef = await findProduct(cfg.productInternalReference);
const foundByName = await findProduct('ค่าบริการ');
const foundByModel = await findProduct(cfg.productModel);
ok('findProduct ไม่คืนค่าขนส่ง (ค้นด้วย internal_reference)',
  !mentionsFee(foundByRef), `product=${foundByRef.product?.model ?? '-'} candidates=${foundByRef.candidates.length}`);
ok('findProduct ไม่คืนค่าขนส่ง (ค้นด้วยชื่อ "ค่าบริการ")',
  !mentionsFee(foundByName), `product=${foundByName.product?.model ?? '-'} candidates=${foundByName.candidates.length}`);
ok('findProduct ไม่คืนค่าขนส่ง (ค้นด้วย model ตรงตัว)',
  !mentionsFee(foundByModel), `product=${foundByModel.product?.model ?? '-'} candidates=${foundByModel.candidates.length}`);

const { rows: liffSearch } = await pool.query(
  `SELECT p.model FROM products p
    WHERE (p.model ILIKE $1 OR p.name ILIKE $1 OR p.internal_reference ILIKE $1)
      AND (p.production IS NULL OR LOWER(REPLACE(p.production, ' ', '')) NOT LIKE '%buytosell%')
      AND p.is_system_item = false`,
  [`%${cfg.productInternalReference}%`]
);
ok('เงื่อนไขค้นหาของ /api/products/search กรองสินค้าตัวนี้ออก', liffSearch.length === 0);

// ── 7. กฎฝั่ง LIFF ต้องให้ผลตรงกับฝั่ง server ทุกเคส ────────────────────
//  liff_pages/quote-edit.html จำลองกฎนี้ไว้เพื่อโชว์บรรทัดทันทีระหว่างแก้ (ไม่มี bundler
//  จึง import ไม่ได้) ส่วนนี้ดึงฟังก์ชันจริงออกมาจากไฟล์ HTML แล้วรันเทียบกับ shippingFee.ts
//  ถ้าสองฝั่งเพี้ยนกัน เซลล์จะเห็นยอดบนหน้าจอไม่ตรงกับที่บันทึกจริง
console.log('\n── LIFF ↔ server rule parity ──');

const liffHtml = fs.readFileSync(
  path.join(process.cwd(), 'liff_pages', 'quote-edit.html'), 'utf8'
);
const liffScript = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(liffHtml)?.[1] ?? '';

/** ตัดตัวฟังก์ชันออกมาทั้งก้อนด้วยการนับวงเล็บปีกกา */
function grabFn(name: string): string {
  const start = liffScript.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`ไม่พบฟังก์ชัน ${name} ใน quote-edit.html`);
  let depth = 0;
  for (let j = liffScript.indexOf('{', start); j < liffScript.length; j++) {
    if (liffScript[j] === '{') depth++;
    else if (liffScript[j] === '}' && --depth === 0) return liffScript.slice(start, j + 1);
  }
  throw new Error(`อ่านฟังก์ชัน ${name} ไม่จบ`);
}

const liffSrc = ['calcItemTotal', 'calcQuoteTotal', 'parseCustomerMeta',
  'isShippingFeeItem', 'hasCreditTerms', 'recalcShippingFee'].map(grabFn).join('\n');

const liff = new Function(`
  let shippingFeeCfg = null, quotesData = [];
  ${liffSrc}
  return {
    setCfg: (c) => { shippingFeeCfg = c; },
    setQuotes: (q) => { quotesData = q; },
    getQuotes: () => quotesData,
    recalcShippingFee, isShippingFeeItem, hasCreditTerms
  };
`)();

liff.setCfg({
  is_active: cfg.isActive, threshold_before_vat: cfg.thresholdBeforeVat,
  fee_price: cfg.feePrice, fee_quantity: cfg.feeQuantity,
  default_item_name: cfg.defaultItemName, product_id: cfg.productId,
  product_model: cfg.productModel, internal_reference: cfg.productInternalReference
});

const parityTerms = [...termRows.map((r: any) => r.t),
  '30 Days', '  60 Days  ', '5 days', '30days', 'Days', 'Net 30 Days', '', null];
const termDiff = parityTerms.filter(t => liff.hasCreditTerms(t) !== hasCreditTerms(t));
ok('hasCreditTerms ตรงกันทุกค่า', termDiff.length === 0,
  `${parityTerms.length} ค่า${termDiff.length ? ' ต่าง: ' + JSON.stringify(termDiff) : ''}`);

ok('isShippingFeeItem ตรงกัน',
  [{ model: cfg.productModel }, { product_code: cfg.productModel },
   { internal_reference: cfg.productInternalReference }, { model: 'BH-02 112x200' }, {}]
    .every(p => liff.isShippingFeeItem(p) === isShippingFeeItem(p, cfg)));

const liffFees = (qs: any[]) => qs.flatMap((q: any) => q.items).filter((i: any) => isShippingFeeItem(i, cfg));
const liffRun = (quotes: any[]) => {
  liff.setQuotes(JSON.parse(JSON.stringify(quotes)));
  liff.recalcShippingFee();
  return liff.getQuotes();
};
const gItem = (price: number) => ({ model: 'X-1', price, quantity: 1, discount_1: 0, discount_2: 0 });
const boundQuote = (items: any[], terms = 'Cash', company = 'PM') => ({
  id: 'q' + items.length + company, customer_name: 'บริษัททดสอบ | คุณเอ',
  payment_terms: terms, quote_company: company, items
});

let liffRes = liffRun([boundQuote([gItem(500)])]);
ok('Cash + 500 → เติมบรรทัด', liffFees(liffRes).length === 1);
ok('  ราคา/จำนวนตรง config (ไม่ใช่ ฿0)',
  liffFees(liffRes)[0]?.price === cfg.feePrice && liffFees(liffRes)[0]?.quantity === cfg.feeQuantity,
  JSON.stringify({ price: liffFees(liffRes)[0]?.price, qty: liffFees(liffRes)[0]?.quantity }));
ok('1000.00 พอดี → ไม่เติม (ขอบเกณฑ์ตรงกับ server)',
  liffFees(liffRun([boundQuote([gItem(1000)])])).length === 0);
ok('999.99 → เติม', liffFees(liffRun([boundQuote([gItem(999.99)])])).length === 1);
ok('เครดิต 30 Days → ไม่เติม', liffFees(liffRun([boundQuote([gItem(500)], '30 Days')])).length === 0);
ok('ยังไม่ผูกลูกค้า → ไม่เติม',
  liffFees(liffRun([{ id: 'q1', customer_name: ' | ', payment_terms: '', items: [gItem(500)] }])).length === 0);
ok('ใบว่าง → ไม่เติม', liffFees(liffRun([boundQuote([])])).length === 0);
ok('ส่วนลดทำให้ยอดตกต่ำกว่าเกณฑ์ → เติม',
  liffFees(liffRun([boundQuote([{ model: 'X', price: 2000, quantity: 1, discount_1: 60, discount_2: 0 }])])).length === 1);

liffRes = liffRun([boundQuote([gItem(400)], 'Cash', 'THT'), boundQuote([gItem(400)], 'Cash', 'PM')]);
ok('PM+THT รวม 800 → บรรทัดเดียว', liffFees(liffRes).length === 1);
ok('  อยู่ในใบ PM ไม่ใช่ THT',
  liffRes[1].items.some((i: any) => isShippingFeeItem(i, cfg)) &&
  !liffRes[0].items.some((i: any) => isShippingFeeItem(i, cfg)));
ok('PM+THT รวม 1200 → ไม่เติม',
  liffFees(liffRun([boundQuote([gItem(600)], 'Cash', 'THT'), boundQuote([gItem(600)], 'Cash', 'PM')])).length === 0);

liffRes = liffRun([boundQuote([gItem(500), {
  model: cfg.productModel, internal_reference: cfg.productInternalReference,
  name: 'ค่าส่งด่วน', price: 400, quantity: 1, discount_1: 0, discount_2: 0
}])]);
ok('recalc ซ้ำแล้วชื่อ/ราคาที่เซลล์แก้ยังอยู่',
  liffFees(liffRes)[0]?.name === 'ค่าส่งด่วน' && liffFees(liffRes)[0]?.price === 400);
ok('  ไม่เกิดบรรทัดซ้ำ', liffFees(liffRes).length === 1);

// เติมแล้วรันซ้ำต้องนิ่ง — ถ้าฐานยอดเผลอนับค่าขนส่งด้วย บรรทัดจะเด้งเข้า-ออกไม่จบ
const settled = liffRun(liffRun([boundQuote([gItem(900)])]));
ok('เติมแล้วรันซ้ำ บรรทัดไม่แกว่ง', liffFees(settled).length === 1);
ok('  ฐานยอดตรงกับ goodsSubtotal ของ server', goodsSubtotal(settled[0].items, cfg) === 900);

// ── 8. end-to-end กับ DB จริง ───────────────────────────────────────────
console.log('\n── applyShippingFeeToQuoteGroup (เขียน DB จริง) ──');

/** สินค้าปลอมที่ไม่มีใน products → ไม่ไปโดนกฎอื่น และคุม PM/THT ได้ผ่าน production */
function goodsItem(price: number, production = 'Local') {
  return {
    model: 'DIAG-SHIPFEE-MODEL', name: 'สินค้าทดสอบค่าขนส่ง',
    price, quantity: 1, discount_1: 0, discount_2: 0, production
  };
}

async function insertDraft(opts: {
  userId?: string; status?: string; customerId?: number | null;
  paymentTerms?: string | null; items: any[]; createdAt?: string;
}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO quotations (user_id, status, total_sum, customer_id, customer_details, item_details, employee_details, created_at)
     VALUES ($1, $2, 0, $3, $4, $5, $6, $7) RETURNING id`,
    [
      opts.userId ?? USER,
      opts.status ?? 'draft',
      opts.customerId === undefined ? 9999001 : opts.customerId,
      JSON.stringify({ customer_name: 'DIAG ลูกค้าทดสอบ', payment_terms: opts.paymentTerms ?? 'Cash', diag_tag: TAG }),
      JSON.stringify(opts.items),
      JSON.stringify({ saleperson: 'Diag Sales', salesperson_id: 'DIAG01' }),
      opts.createdAt ?? '2099-12-01T00:00:00.000Z'
    ]
  );
  return rows[0].id;
}

async function readQuote(id: string): Promise<{ items: any[]; totalSum: number }> {
  const { rows } = await pool.query('SELECT item_details, total_sum FROM quotations WHERE id = $1', [id]);
  return {
    items: Array.isArray(rows[0]?.item_details) ? rows[0].item_details : [],
    totalSum: Number(rows[0]?.total_sum ?? 0)
  };
}

const feeLinesOf = (items: any[]) => items.filter(i => isShippingFeeItem(i, cfg));

async function teardown() {
  await pool.query(`DELETE FROM quotations WHERE customer_details->>'diag_tag' = $1`, [TAG]);
  await pool.query(`DELETE FROM salesperson WHERE user_id = ANY($1)`, [[USER, USER_B]]);
}

try {
  await teardown(); // เผื่อรอบก่อนค้าง
  for (const u of [USER, USER_B]) {
    await pool.query(
      `INSERT INTO salesperson (user_id, salesperson_id) VALUES ($1, 'DIAG01') ON CONFLICT (user_id) DO NOTHING`,
      [u]
    );
  }

  // 6.1 ลูกค้าไม่มีเครดิต + ยอดต่ำกว่าเกณฑ์ → ได้บรรทัดค่าขนส่ง
  let id = await insertDraft({ items: [goodsItem(500)], paymentTerms: 'Cash' });
  await applyShippingFeeToQuoteGroup(USER);
  let q = await readQuote(id);
  const added = feeLinesOf(q.items);
  ok('Cash + ยอด 500 → เติมบรรทัดค่าขนส่ง 1 บรรทัด', added.length === 1, `ได้ ${added.length}`);
  ok('  ค่าในบรรทัดตรงกับ config',
    added[0]?.price === cfg.feePrice && added[0]?.quantity === cfg.feeQuantity && added[0]?.name === cfg.defaultItemName);
  ok('  total_sum รวมค่าขนส่งแล้ว', q.totalSum === 500 + cfg.feePrice, String(q.totalSum));
  ok('  บรรทัดสินค้าเดิมยังอยู่ครบ', q.items.length === 2);

  // 6.2 ชื่อ/ราคาที่เซลล์แก้ต้องรอดเมื่อกฎรันซ้ำ
  const editedItems = q.items.map(i => isShippingFeeItem(i, cfg) ? { ...i, name: 'ค่าจัดส่งด่วน', price: 350 } : i);
  await pool.query('UPDATE quotations SET item_details = $1 WHERE id = $2', [JSON.stringify(editedItems), id]);
  await applyShippingFeeToQuoteGroup(USER);
  q = await readQuote(id);
  const kept = feeLinesOf(q.items)[0];
  ok('รันกฎซ้ำแล้วชื่อ/ราคาที่เซลล์แก้ยังอยู่',
    kept?.name === 'ค่าจัดส่งด่วน' && kept?.price === 350, JSON.stringify({ name: kept?.name, price: kept?.price }));
  ok('  ไม่เกิดบรรทัดซ้ำ', feeLinesOf(q.items).length === 1);

  // 6.3 ยอดขึ้นถึงเกณฑ์ → ถอดบรรทัดออกเอง
  const raised = q.items.filter(i => !isShippingFeeItem(i, cfg)).concat([goodsItem(600)]);
  await pool.query('UPDATE quotations SET item_details = $1 WHERE id = $2', [JSON.stringify(raised), id]);
  await applyShippingFeeToQuoteGroup(USER);
  q = await readQuote(id);
  ok('ยอดขึ้นเป็น 1100 → ถอดบรรทัดค่าขนส่งออกเอง', feeLinesOf(q.items).length === 0);
  ok('  total_sum กลับเป็นยอดสินค้าล้วน', q.totalSum === 1100, String(q.totalSum));

  // 6.4 ยอด 1000.00 พอดี → ยังไม่คิด (ขอบเกณฑ์)
  await pool.query('UPDATE quotations SET item_details = $1 WHERE id = $2',
    [JSON.stringify([goodsItem(1000)]), id]);
  await applyShippingFeeToQuoteGroup(USER);
  ok('ยอด 1000.00 พอดี → ไม่คิดค่าขนส่ง', feeLinesOf((await readQuote(id)).items).length === 0);

  // 6.5 ยอด 999.99 → คิด
  await pool.query('UPDATE quotations SET item_details = $1 WHERE id = $2',
    [JSON.stringify([goodsItem(999.99)]), id]);
  await applyShippingFeeToQuoteGroup(USER);
  ok('ยอด 999.99 → คิดค่าขนส่ง', feeLinesOf((await readQuote(id)).items).length === 1);
  await pool.query(`DELETE FROM quotations WHERE id = $1`, [id]);

  // 6.6 ลูกค้ามีเครดิต → ไม่คิดแม้ยอดต่ำ
  id = await insertDraft({ items: [goodsItem(500)], paymentTerms: '30 Days' });
  await applyShippingFeeToQuoteGroup(USER);
  ok('ลูกค้าเครดิต 30 Days + ยอด 500 → ไม่คิดค่าขนส่ง', feeLinesOf((await readQuote(id)).items).length === 0);
  await pool.query(`DELETE FROM quotations WHERE id = $1`, [id]);

  // 6.7 ยังไม่ผูกลูกค้า → ยังไม่ใส่
  id = await insertDraft({ items: [goodsItem(500)], status: 'pending_company', customerId: null, paymentTerms: '' });
  await applyShippingFeeToQuoteGroup(USER);
  ok('ร่างที่ยังไม่ผูกลูกค้า → ยังไม่ใส่ค่าขนส่ง', feeLinesOf((await readQuote(id)).items).length === 0);

  // 6.8 ผูกลูกค้าแล้ว (ใบเดิมกลายเป็น draft + มี customer_id) → ใส่ให้ทันที
  await pool.query(`UPDATE quotations SET status = 'draft', customer_id = 9999001 WHERE id = $1`, [id]);
  await applyShippingFeeToQuoteGroup(USER);
  ok('พอผูกลูกค้าแล้ว → เติมค่าขนส่งให้เอง', feeLinesOf((await readQuote(id)).items).length === 1);
  await pool.query(`DELETE FROM quotations WHERE id = $1`, [id]);

  // 6.9 ใบว่าง (ยอด 0) → ไม่ใส่
  id = await insertDraft({ items: [], paymentTerms: 'Cash' });
  await applyShippingFeeToQuoteGroup(USER);
  ok('ใบที่ไม่มีสินค้า → ไม่ใส่ค่าขนส่ง', feeLinesOf((await readQuote(id)).items).length === 0);
  await pool.query(`DELETE FROM quotations WHERE id = $1`, [id]);

  // 6.10 สองใบ PM + THT → ยอดรวมข้ามใบ และบรรทัดเดียวลงใบ PM
  //      ใบ THT สร้างก่อน (created_at เก่ากว่า) เพื่อพิสูจน์ว่า "PM ก่อน" ชนะลำดับเวลา
  const thtId = await insertDraft({
    items: [goodsItem(400, 'Import(PM)')], paymentTerms: 'Cash', createdAt: '2099-12-01T00:00:00.000Z'
  });
  const pmId = await insertDraft({
    items: [goodsItem(400, 'Local')], paymentTerms: 'Cash', createdAt: '2099-12-02T00:00:00.000Z'
  });
  await applyShippingFeeToQuoteGroup(USER);
  const thtQ = await readQuote(thtId);
  const pmQ = await readQuote(pmId);
  ok('PM+THT ยอดรวม 800 → มีบรรทัดค่าขนส่งรวมกันแค่ 1 บรรทัด',
    feeLinesOf(thtQ.items).length + feeLinesOf(pmQ.items).length === 1);
  ok('  บรรทัดอยู่ในใบ PM (ไม่ใช่ใบ THT ที่สร้างก่อน)',
    feeLinesOf(pmQ.items).length === 1 && feeLinesOf(thtQ.items).length === 0);

  // 6.11 ยอดรวมข้ามใบเกินเกณฑ์ → ไม่คิด แม้แต่ละใบจะต่ำกว่าเกณฑ์
  await pool.query('UPDATE quotations SET item_details = $1 WHERE id = $2',
    [JSON.stringify([goodsItem(600, 'Import(PM)')]), thtId]);
  await pool.query('UPDATE quotations SET item_details = $1 WHERE id = $2',
    [JSON.stringify([goodsItem(600, 'Local')]), pmId]);
  await applyShippingFeeToQuoteGroup(USER);
  ok('แต่ละใบ 600 (ต่ำกว่าเกณฑ์) แต่รวม 1200 → ไม่คิดค่าขนส่ง',
    feeLinesOf((await readQuote(thtId)).items).length + feeLinesOf((await readQuote(pmId)).items).length === 0);

  // 6.12 ไม่ยุ่งกับใบของพนักงานคนอื่น
  const otherId = await insertDraft({ userId: USER_B, items: [goodsItem(500)], paymentTerms: 'Cash' });
  await applyShippingFeeToQuoteGroup(USER);
  ok('ใบของพนักงานคนอื่นไม่ถูกแตะ', feeLinesOf((await readQuote(otherId)).items).length === 0);

  // 6.13 ใบที่ยืนยันแล้วต้องไม่ถูกแก้
  const confirmedId = await insertDraft({ items: [goodsItem(500)], paymentTerms: 'Cash' });
  await pool.query(`UPDATE quotations SET status = 'confirmed' WHERE id = $1`, [confirmedId]);
  await applyShippingFeeToQuoteGroup(USER);
  ok('ใบที่ยืนยันแล้วไม่ถูกเติมค่าขนส่งย้อนหลัง',
    feeLinesOf((await readQuote(confirmedId)).items).length === 0);

  // 6.14 userId ว่าง → ไม่ทำอะไร ไม่ throw
  await applyShippingFeeToQuoteGroup(null);
  await applyShippingFeeToQuoteGroup('');
  ok('userId ว่าง/null → ไม่ throw', true);
} finally {
  await teardown();
  await pool.end();
}
