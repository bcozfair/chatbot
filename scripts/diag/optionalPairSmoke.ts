// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกฎคู่สินค้าหลัก-สินค้าเสริม (optional pairing) — อ่านอย่างเดียว ไม่เขียน DB
//  รัน:  npm run diag:optional-pair   (npx tsx scripts/diag/optionalPairSmoke.ts)
//
//  ครอบคลุม: expandOptionalProducts พ่วงสินค้าเสริมที่จำนวนเท่าสินค้าหลัก · de-dupe ·
//            resolveOptionalProductsFor คืนชุดเดียวกับ expand + สัญญาฟิลด์ครบ
//  ให้รันซ้ำทุกครั้งที่แตะ logic สินค้าพ่วง (productService.ts expand/resolve, client mirror)
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  expandOptionalProducts,
  resolveOptionalProductsFor,
  getProductByInternalRef
} from '../../services/productService.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// ── หาคู่พ่วงจริงจาก product_optional_links ที่ resolve ได้ทั้ง 2 ฝั่ง ──────────
const { rows: linkRows } = await pool.query(
  `SELECT trigger_product_id, optional_product_id
   FROM product_optional_links
   WHERE is_active = true`
);

let mainProduct: any = null;
let optProduct: any = null;
for (const link of linkRows) {
  const trig = await getProductByInternalRef(link.trigger_product_id);
  const opt = await getProductByInternalRef(link.optional_product_id);
  if (trig && trig.product_template_id && opt && opt.product_template_id) {
    mainProduct = trig;
    optProduct = opt;
    break;
  }
}

if (!mainProduct || !optProduct) {
  console.log('⚠️  SKIP: ไม่พบคู่พ่วงที่ resolve สินค้าได้ทั้ง 2 ฝั่งใน product_optional_links');
  await pool.end();
  process.exit(0);
}

console.log(`   คู่ทดสอบ: หลัก ${mainProduct.model} [${mainProduct.internal_reference}] → เสริม ${optProduct.model} [${optProduct.internal_reference}]`);

const N = 7; // จำนวนสินค้าหลักที่สั่ง — สินค้าเสริมต้องได้เท่านี้
const mainItem = {
  product_id: mainProduct.product_template_id,
  model: mainProduct.model,
  quantity: N,
  qty: N,
  price: mainProduct.sales_price,
};

// ── 1. expand พ่วงสินค้าเสริมที่จำนวนเท่าสินค้าหลัก ─────────────────────────────
const expanded = await expandOptionalProducts([mainItem]);
ok('expand คืนสินค้าหลัก + เสริม (2 บรรทัด)', expanded.length === 2, `ได้ ${expanded.length}`);
ok('บรรทัดแรกคือสินค้าหลัก', expanded[0] && expanded[0].product_id === mainProduct.product_template_id);

const optLine = expanded[1];
ok('บรรทัดที่สองคือสินค้าเสริมที่ผูกไว้', !!optLine && optLine.product_id === optProduct.product_template_id, `ได้ ${optLine && optLine.product_id}`);
ok('สินค้าเสริม qty เท่าสินค้าหลัก', !!optLine && (optLine.quantity === N || optLine.qty === N), `ได้ ${optLine && (optLine.quantity ?? optLine.qty)}/${N}`);
ok('สินค้าเสริมมี is_optional:true', !!optLine && optLine.is_optional === true);
ok('สินค้าเสริม linked_to_product_id = สินค้าหลัก', !!optLine && optLine.linked_to_product_id === mainProduct.product_template_id, `ได้ ${optLine && optLine.linked_to_product_id}`);

// ── 2. de-dupe: สินค้าเสริมที่สั่งเองอยู่แล้ว → ไม่พ่วงซ้ำ ───────────────────────
const withOptOrdered = await expandOptionalProducts([
  mainItem,
  { product_id: optProduct.product_template_id, model: optProduct.model, quantity: 3, qty: 3, price: optProduct.sales_price }
]);
const optCount = withOptOrdered.filter(
  (i: any) => i.product_id === optProduct.product_template_id
).length;
ok('de-dupe: สินค้าเสริมมีสำเนาเดียว (ไม่พ่วงซ้ำ)', optCount === 1, `ได้ ${optCount} สำเนา`);
ok('de-dupe: จำนวนบรรทัดรวม = 2 (หลัก + เสริมที่สั่งเอง)', withOptOrdered.length === 2, `ได้ ${withOptOrdered.length}`);

// ── 3. resolveOptionalProductsFor คืนชุดเดียวกับ expand + สัญญาฟิลด์ครบ ─────────
const resolved = await resolveOptionalProductsFor(mainProduct);
const resolvedIds = resolved.map((r: any) => r.product_id).sort();
const expandIds = expanded.filter((i: any) => i.is_optional).map((i: any) => i.product_id).sort();
ok('resolveOptionalProductsFor คืนชุด product_id เดียวกับ expand',
  JSON.stringify(resolvedIds) === JSON.stringify(expandIds),
  `resolve=[${resolvedIds}] expand=[${expandIds}]`);

const contractKeys = ['product_id', 'model', 'name', 'price', 'stock', 'internal_reference', 'brand'];
const r0 = resolved[0] || {};
ok('resolveOptionalProductsFor มีฟิลด์ตามสัญญา (product_id/model/name/price/stock/internal_reference/brand)',
  contractKeys.every((k) => k in r0));

console.log(failures === 0 ? '\n✅ optional pairing ผ่านทุกข้อ' : `\n❌ optional pairing ล้มเหลว ${failures} ข้อ`);

await pool.end();
process.exit(failures);
