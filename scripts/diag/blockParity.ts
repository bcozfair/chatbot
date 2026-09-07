// ─────────────────────────────────────────────────────────────────────────────
//  ตรวจความสอดคล้องของ "จุดบล็อกสินค้า" ทั้งหมด กับข้อมูลจริง — อ่านอย่างเดียว ไม่เขียน DB
//  รัน:  npm run diag:block-parity     (ต้องรันในคอนเทนเนอร์ที่ต่อ DB ได้)
//
//  ครอบคลุม:
//   1. ด่านกลาง (findBlockingRule — filter-then-match) กับ PDF fail-safe
//      (resolveQuotationRule().is_locked — resolve-then-check) ต้องให้ผลตรงกันทุก scope
//      สองวิธีนี้ต่างกันโดยตั้งใจ (ดู quotationRules.ts:149) — สคริปต์นี้คือตัวเฝ้าว่า
//      ชุดกฎที่ใช้จริง "ยังไม่" ตกลงไปในกรณีที่ทั้งสองให้คำตอบต่างกัน
//   2. บรรทัดค่าขนส่งต้องไม่ถูกบล็อก — PDF ข้ามบรรทัดนี้เสมอ แต่ด่านกลางไม่ข้าม
//      ถ้าวันไหนกฎครอบมันขึ้นมา = ออกใบไม่ได้ทั้งใบโดยที่ PDF ไม่รู้เรื่อง
//   3. สรุปความครอบคลุมของกฎ (กี่ scope / กี่สินค้า) ไว้เทียบก่อน-หลังย้ายไป product_block_rules
//
//  ให้รันซ้ำทุกครั้งที่แตะ services/rules/ · getBlockedProductError · pdfGenerator
//  และทุกครั้งก่อน/หลัง migration ของกฎบล็อก
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  loadQuotationRules, resolveQuotationRule, findBlockingRule, normalizeProductScope
} from '../../services/rules/index.js';
import { loadShippingFeeConfig, isShippingFeeItem } from '../../services/shippingFee.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const client = await pool.connect();
// query วิเคราะห์ต้องมี timeout เสมอ — ตัวค้างตัวเดียวบล็อก rebuild customers_data_view ทั้งระบบ
await client.query(`SET statement_timeout = '60s'`);

try {
  const rules = await loadQuotationRules();
  const locked = rules.filter((r: any) => r.is_locked === true);
  console.log(`กฎทั้งหมด ${rules.length} แถว · ที่ตั้ง is_locked ${locked.length} แถว`);
  for (const r of locked) {
    console.log(`   #${r.id}  production="${r.production ?? ''}" brand="${r.brand ?? ''}" series="${r.series ?? ''}"`);
  }

  // ── 1. parity ระหว่างด่านกลางกับ PDF fail-safe ────────────────────────────
  const { rows: scopes } = await client.query(`
    SELECT production, brand, series, count(*)::int AS n
      FROM products
     GROUP BY 1, 2, 3
  `);

  const mismatch: any[] = [];
  let gateScopes = 0, gateProducts = 0;
  for (const s of scopes) {
    const scope = normalizeProductScope(s);
    const gate = findBlockingRule(rules, scope);
    const outcome = resolveQuotationRule(rules, scope);
    if (gate) { gateScopes++; gateProducts += s.n; }
    if (!!gate !== !!outcome.is_locked) {
      mismatch.push({ ...s, gateRule: gate?.id ?? null, pdfRule: outcome.matched_rule_id ?? null });
    }
  }

  console.log(`\nscope ที่มีสินค้าจริง ${scopes.length} แบบ`);
  ok('ด่านกลาง (findBlockingRule) กับ PDF (resolve.is_locked) ให้ผลตรงกันทุก scope',
    mismatch.length === 0,
    mismatch.length ? `ต่างกัน ${mismatch.length} scope` : '');
  for (const m of mismatch.slice(0, 20)) {
    console.log(`     [${m.production}|${m.brand}|${m.series}] n=${m.n} gate=rule#${m.gateRule} pdf=rule#${m.pdfRule}`);
  }
  console.log(`   ความครอบคลุมของกฎบล็อก: ${gateScopes} scope = ${gateProducts} สินค้า`);

  // ── 2. บรรทัดค่าขนส่งต้องไม่ถูกบล็อก ──────────────────────────────────────
  const cfg = await loadShippingFeeConfig();
  const feeModel = (cfg as any).productModel;
  const feeRef = (cfg as any).productInternalReference;
  console.log(`\nค่าขนส่ง: model="${feeModel}" ref="${feeRef}"`);

  if (!feeModel && !feeRef) {
    console.log('   (ยังไม่ตั้งค่าสินค้าค่าขนส่ง — ข้ามการตรวจ)');
  } else {
    const { rows } = await client.query(
      `SELECT model AS code, brand, series, production, internal_reference
         FROM products
        WHERE model = $1 OR internal_reference = $2
        ORDER BY quantity_on_hand_unreserved DESC
        LIMIT 1`,
      [feeModel || '', feeRef || '']
    );
    const prod = rows[0];
    ok('พบสินค้าค่าขนส่งใน products', !!prod, prod ? `[${prod.production}|${prod.brand}|${prod.series}]` : 'ไม่พบ');
    if (prod) {
      const feeRule = findBlockingRule(rules, normalizeProductScope(prod));
      ok('บรรทัดค่าขนส่งไม่ถูกกฎบล็อกครอบ (ถ้าโดน = ออกใบไม่ได้ทั้งใบ ทั้งที่ PDF ข้ามบรรทัดนี้)',
        feeRule === null, feeRule ? `โดน rule#${feeRule.id}` : '');
      ok('isShippingFeeItem จับบรรทัดนี้ได้ (ตัวที่ PDF ใช้ข้าม)',
        isShippingFeeItem({ model: prod.code, internal_reference: prod.internal_reference }, cfg));
    }
  }

  // ── 3. สินค้าที่ lookup ด้วย model ไม่เจอ = ทุกจุดปล่อยผ่าน ────────────────
  const { rows: noModel } = await client.query(
    `SELECT count(*)::int AS n FROM products WHERE model IS NULL OR btrim(model) = ''`
  );
  console.log(`\nสินค้าที่ model ว่าง/NULL: ${noModel[0].n} แถว`);
  console.log('   (ทุกจุดบล็อก lookup ด้วย model → แถวพวกนี้ปล่อยผ่านเสมอ — ตั้งใจบันทึกไว้ ไม่ใช่ FAIL)');

  console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ ไม่ผ่าน ${failures} ข้อ`);
} finally {
  client.release();
  await pool.end();
}

process.exit(failures === 0 ? 0 : 1);
