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
  findBlockingRule, findCompanyRule, invalidateRuleCache, selectRule, scopeSpecificity
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
  'warranty_display', 'delivery_in_stock_days', 'delivery_out_of_stock_days', 'is_optional'];
ok('snapshot มี field ครบและไม่เกิน (shape เดิมเป๊ะ)',
  JSON.stringify(Object.keys(s0)) === JSON.stringify(expectedKeys),
  Object.keys(s0).join(','));
ok('snapshot เติมข้อมูลสินค้าจาก DB', s0.model === prods[0].model && s0.quantity === 2);

await pool.end();
