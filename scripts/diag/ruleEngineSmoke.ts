// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของ rule engine + สูตรราคา — อ่านอย่างเดียว ไม่เขียน DB
//  รัน:  npx tsx scripts/diag/ruleEngineSmoke.ts
//
//  ครอบคลุม: สูตรราคา · scope matching + ลำดับตัดสิน · cache/invalidate ·
//            resolve กับสินค้าจริง · shape ของ snapshot
//  ให้รันซ้ำทุกครั้งที่แตะ services/rules/ หรือ utils/pricing.ts
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  loadQuotationRules, resolveQuotationRule, normalizeProductScope,
  findBlockingRule, findCompanyRule, invalidateRuleCache, selectRule, scopeSpecificity,
  resolveDeliveryOutOfStockDays, QUOTATION_RULE_DEFAULTS
} from '../../services/rules/index.js';
import { buildItemSnapshots } from '../../services/quotationService.js';
import { calcNetPrice, round2, sumLineTotals, calcVat, calcGrandTotal } from '../../utils/pricing.js';

const ok = (label: string, cond: boolean, extra = '') =>
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

// ── 1. pricing (pure) ──────────────────────────────────────────────────
ok('calcNetPrice ไม่ปัดเศษ', calcNetPrice(100, 20, 3) === 100 * 0.8 * 0.97, String(calcNetPrice(100, 20, 3)));
ok('calcNetPrice รับ string ได้', calcNetPrice('100' as any, '20' as any, 0) === 80);
ok('round2', round2(77.6789) === 77.68);
ok('sumLineTotals รองรับ qty', sumLineTotals([{ price: 100, discount_1: 10, discount_2: 0, qty: 2 }]) === 180);
ok('calcVat 7%', calcVat(1000) === 70);
ok('calcGrandTotal', calcGrandTotal(1000) === 1070);

// ── 2. scope matching (pure) ───────────────────────────────────────────
type TestRule = { id: number; production?: string; brand?: string; series?: string };

const scope = normalizeProductScope({ production: 'Import(PM)', brand: 'ACME', series: 'X1' });
ok("wildcard ว่าง match ทุกอย่าง", selectRule<TestRule>([{ id: 1 }], scope)?.id === 1);
ok("'import' prefix-match 'Import(PM)'", selectRule([{ id: 2, production: 'Import' }], scope)?.id === 2);
ok("production ไม่ตรง = ไม่ match", selectRule([{ id: 3, production: 'Local' }], scope) === null);
ok('series ชนะ production+brand', selectRule(
  [{ id: 10, production: 'Import', brand: 'ACME' }, { id: 11, series: 'X1' }], scope)?.id === 11);
ok('exact ชนะ prefix', selectRule(
  [{ id: 20, production: 'Import' }, { id: 21, production: 'Import(PM)' }], scope)?.id === 21);
ok('ลำดับ array ไม่มีผล (deterministic)', selectRule(
  [{ id: 21, production: 'Import(PM)' }, { id: 20, production: 'Import' }], scope)?.id === 21);
ok('specificity bitmask', scopeSpecificity({ series: 's' }) === 4 && scopeSpecificity({ production: 'p', brand: 'b' }) === 3);

// ── 2b. tier วันจัดส่งตามจำนวน (pure) ───────────────────────────────────
const tierOutcome = {
  ...QUOTATION_RULE_DEFAULTS,
  delivery_out_of_stock_days: 7,
  delivery_qty_tiers: [
    { min_qty: 100, days: 60 }, { min_qty: 50, days: 45 },
    { min_qty: 20, days: 30 }, { min_qty: 10, days: 20 }
  ]
};
const tierDays = (qty: number) => resolveDeliveryOutOfStockDays(tierOutcome, qty).days;
ok('qty 1 → ใช้ค่า base', tierDays(1) === 7);
ok('qty 9 → ยังเป็น base', tierDays(9) === 7);
ok('qty 10 พอดี → เข้า tier แรก (ขอบเขตที่ยืนยันกับฝ่ายขาย)', tierDays(10) === 20, `ได้ ${tierDays(10)}`);
ok('qty 19 → ยังอยู่ tier 10', tierDays(19) === 20);
ok('qty 20 → tier 20', tierDays(20) === 30);
ok('qty 50 → tier 50', tierDays(50) === 45);
ok('qty 99 → ยังอยู่ tier 50', tierDays(99) === 45);
ok('qty 100 → tier 100', tierDays(100) === 60);
ok('qty 5000 → ยังเป็น tier สูงสุด', tierDays(5000) === 60);
ok('source บอกที่มาถูก', resolveDeliveryOutOfStockDays(tierOutcome, 50).source === 'qty_50'
  && resolveDeliveryOutOfStockDays(tierOutcome, 5).source === 'base');
ok('กฏที่ไม่มี tier → ใช้ base เสมอ',
  resolveDeliveryOutOfStockDays({ ...QUOTATION_RULE_DEFAULTS, delivery_out_of_stock_days: 150 }, 9999).days === 150);
ok('tier ที่กรอกบางขั้น → ขั้นที่เว้นว่างถูกข้าม', (() => {
  const partial = { ...QUOTATION_RULE_DEFAULTS, delivery_out_of_stock_days: 7, delivery_qty_tiers: [{ min_qty: 100, days: 60 }] };
  return resolveDeliveryOutOfStockDays(partial, 50).days === 7
      && resolveDeliveryOutOfStockDays(partial, 100).days === 60;
})());

// ── 3. engine + DB ─────────────────────────────────────────────────────
const rules = await loadQuotationRules();
ok('loadQuotationRules คืนกฏ', rules.length > 0, `${rules.length} แถว`);

const t0 = Date.now();
const cached = await loadQuotationRules();
ok('เรียกครั้งที่ 2 มาจาก cache', cached === rules && Date.now() - t0 < 5);

invalidateRuleCache('quotation_rules');
const reloaded = await loadQuotationRules();
ok('invalidateRuleCache บังคับโหลดใหม่', reloaded !== rules && reloaded.length === rules.length);

const { rows: prods } = await pool.query(
  `SELECT model, brand, series, production FROM products
   WHERE production IS NOT NULL AND brand IS NOT NULL LIMIT 3`
);
for (const p of prods) {
  const out = resolveQuotationRule(reloaded, normalizeProductScope(p));
  console.log(`   ${p.model} [${p.production} > ${p.brand} > ${p.series || '-'}]`,
    `→ rule#${out.matched_rule_id ?? 'default'} warranty=${out.warranty_display} in=${out.delivery_in_stock_days} out=${out.delivery_out_of_stock_days} locked=${out.is_locked}`);
}
ok('resolveQuotationRule ทำงานกับสินค้าจริง', prods.length > 0);
ok('findBlockingRule / findCompanyRule เรียกได้', (() => {
  const s = normalizeProductScope(prods[0]);
  findBlockingRule(reloaded, s); findCompanyRule(reloaded, s); return true;
})());

// ── 4. buildItemSnapshots กับสินค้าจริง ─────────────────────────────────
const snaps = await buildItemSnapshots([
  { model: prods[0].model, price: 100, quantity: 2, discount_1: 10, discount_2: 0 }
]);
const s0 = snaps[0];
const expectedKeys = ['internal_reference', 'product_id', 'model', 'name', 'sales_description',
  'price', 'quantity', 'discount_1', 'discount_2', 'remark', 'brand', 'series', 'production',
  'warranty_display', 'delivery_in_stock_days', 'delivery_out_of_stock_days', 'delivery_source', 'is_optional'];
ok('snapshot มี field ครบและไม่เกิน',
  JSON.stringify(Object.keys(s0)) === JSON.stringify(expectedKeys),
  Object.keys(s0).join(','));
ok('snapshot เติมข้อมูลสินค้าจาก DB', s0.model === prods[0].model && s0.quantity === 2);

// ── 5. end-to-end กับข้อมูล seed จริง: สินค้า Production 3 (tier 20/30/45/60) ──
const { rows: p3 } = await pool.query(
  `SELECT model FROM products WHERE production = 'Production 3(PM)' AND series = 'PE' LIMIT 1`
);
if (p3.length === 0) {
  console.log('✗ FAIL  ไม่พบสินค้า Production 3 series PE สำหรับทดสอบ tier');
} else {
  const model = p3[0].model;
  const byQty = async (qty: number) => (await buildItemSnapshots([{ model, price: 100, quantity: qty }]))[0];
  const [q9, q10, q50, q150] = await Promise.all([byQty(9), byQty(10), byQty(50), byQty(150)]);
  console.log(`   ทดสอบกับสินค้าจริง ${model} (Production 3 > PE)`);
  ok('  qty 9   → 7 วัน (base)', q9.delivery_out_of_stock_days === 7 && q9.delivery_source === 'base', `ได้ ${q9.delivery_out_of_stock_days}`);
  ok('  qty 10  → 20 วัน (tier)', q10.delivery_out_of_stock_days === 20 && q10.delivery_source === 'qty_10', `ได้ ${q10.delivery_out_of_stock_days}`);
  ok('  qty 50  → 45 วัน', q50.delivery_out_of_stock_days === 45, `ได้ ${q50.delivery_out_of_stock_days}`);
  ok('  qty 150 → 60 วัน', q150.delivery_out_of_stock_days === 60, `ได้ ${q150.delivery_out_of_stock_days}`);
  ok('  มีสต็อกยังเป็น 3 วันทุกจำนวน', q150.delivery_in_stock_days === 3);
}

// สินค้า Import ต้องไม่ถูกกระทบเลย (ไม่ได้กรอก tier)
const { rows: imp } = await pool.query(
  `SELECT p.model, r.delivery_out_of_stock_days AS expected
   FROM products p JOIN quotation_rules r
     ON r.production = 'Import(PM)' AND LOWER(r.brand) = LOWER(p.brand)
   WHERE p.production = 'Import(PM)' LIMIT 1`
);
if (imp.length > 0) {
  const impSnap = (await buildItemSnapshots([{ model: imp[0].model, price: 100, quantity: 500 }]))[0];
  ok(`Import (${imp[0].model}) qty 500 → ไม่เปลี่ยน (${imp[0].expected} วัน)`,
    impSnap.delivery_out_of_stock_days === imp[0].expected && impSnap.delivery_source === 'base',
    `ได้ ${impSnap.delivery_out_of_stock_days}`);
}

await pool.end();
