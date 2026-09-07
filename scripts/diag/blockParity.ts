// ─────────────────────────────────────────────────────────────────────────────
//  ตรวจ "จุดบล็อกสินค้า" ทั้งหมดกับข้อมูลจริง — อ่านอย่างเดียว ไม่เขียน DB
//  รัน:  npm run diag:block-parity     (ต้องรันในคอนเทนเนอร์ที่ต่อ DB ได้)
//
//  ครอบคลุม:
//   1. ของเก่า (quotation_rules.is_locked) กับของใหม่ (product_block_rules) ต้องบล็อก
//      สินค้าชุดเดียวกันในส่วนที่เทียบกันได้ (กฎ 3 ระดับ) — นี่คือตัวเฝ้าระหว่าง soak
//      ว่าการย้ายตารางไม่ได้ทำให้สินค้าตัวไหน "หลุด" หรือ "โดนเกิน"
//      กฎระดับ model/ref เป็นของใหม่ที่ของเก่าทำไม่ได้ จึงแยกตรวจในข้อ 2
//   2. กฎระดับ model/ref ต้อง match สินค้าจริงได้ — กฎที่พิมพ์รหัสผิดจะไม่ match อะไรเลย
//      แล้วตายเงียบ ๆ ไม่มี error ให้เห็น
//   3. บรรทัดค่าขนส่งต้องไม่ถูกบล็อก — ค่าขนส่งมี internal_reference จริง กฎระดับ ref
//      จึงเผลอครอบมันได้ ถ้าโดน = ออกใบไม่ได้ทั้งใบ
//   4. ทุกกฎต้องมี warn_msg — ไม่มีแล้วเซลล์ได้แต่ข้อความ default ที่ไม่บอกเหตุผล
//
//  ให้รันซ้ำทุกครั้งที่แตะ services/rules/ · checkBlockedProducts · pdfGenerator
//  และทุกครั้งก่อน/หลัง migration ของกฎบล็อก
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  loadQuotationRules, loadProductBlockRules, findBlockingRule,
  selectRule, normalizeProductScope, blockWarnText
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
  const legacyRules = await loadQuotationRules();
  const legacyLocked = legacyRules.filter((r: any) => r.is_locked === true);
  const blockRules = await loadProductBlockRules();

  console.log(`quotation_rules ${legacyRules.length} แถว · ที่ยังตั้ง is_locked ${legacyLocked.length} แถว`);
  console.log(`product_block_rules ที่เปิดใช้ ${blockRules.length} แถว`);
  for (const r of blockRules) {
    console.log(`   #${r.id}  [${r.production ?? ''}|${r.brand ?? ''}|${r.series ?? ''}|${r.model ?? ''}|${r.internal_reference ?? ''}]`);
  }

  // ── 1. ของเก่า vs ของใหม่ ในส่วนที่เทียบกันได้ (กฎ 3 ระดับ) ────────────────
  // ของเก่าไม่มีทางบล็อกละเอียดกว่า series ได้ จึงต้องตัดกฎ model/ref ของใหม่ออกก่อนเทียบ
  // ไม่งั้นจะเจอ "ต่างกัน" ที่เกิดจากฟีเจอร์ใหม่ ไม่ใช่จากความผิดพลาด
  const blockRules3 = blockRules.filter(r => !r.model && !r.internal_reference);

  const { rows: scopes } = await client.query(`
    SELECT production, brand, series, count(*)::int AS n
      FROM products
     GROUP BY 1, 2, 3
  `);

  const mismatch: any[] = [];
  let legacyProducts = 0, nextProducts = 0;
  for (const s of scopes) {
    const scope = normalizeProductScope(s);
    const legacy = selectRule(legacyLocked as any, scope);
    const next = findBlockingRule(blockRules3, scope);
    if (legacy) legacyProducts += s.n;
    if (next) nextProducts += s.n;
    if (!!legacy !== !!next) {
      mismatch.push({ ...s, legacyRule: (legacy as any)?.id ?? null, nextRule: next?.id ?? null });
    }
  }

  console.log(`\nscope ที่มีสินค้าจริง ${scopes.length} แบบ`);
  ok('กฎ 3 ระดับของใหม่บล็อกชุดเดียวกับ is_locked เดิมทุก scope',
    mismatch.length === 0,
    mismatch.length ? `ต่างกัน ${mismatch.length} scope` : `${legacyProducts} สินค้า`);
  for (const m of mismatch.slice(0, 20)) {
    console.log(`     [${m.production}|${m.brand}|${m.series}] n=${m.n} เดิม=rule#${m.legacyRule} ใหม่=rule#${m.nextRule}`);
  }
  ok('จำนวนสินค้าที่ถูกบล็อกเท่าเดิม', legacyProducts === nextProducts,
    `เดิม ${legacyProducts} · ใหม่ ${nextProducts}`);

  // ── 2. กฎระดับ model/ref ต้อง match สินค้าจริง ──────────────────────────────
  const deep = blockRules.filter(r => r.model || r.internal_reference);
  console.log(`\nกฎระดับ model/ref ${deep.length} แถว`);
  for (const r of deep) {
    const { rows } = await client.query(
      `SELECT model, brand, series, production, internal_reference
         FROM products
        WHERE ($1::text IS NULL OR internal_reference = $1)
          AND ($2::text IS NULL OR model = $2)
        ORDER BY quantity_on_hand_unreserved DESC
        LIMIT 1`,
      [r.internal_reference ?? null, r.model ?? null]
    );
    const prod = rows[0];
    const label = `กฎ#${r.id} [${r.model ?? ''}|${r.internal_reference ?? ''}]`;
    if (!prod) {
      ok(`${label} หาสินค้าที่ตรงเจอ`, false, 'ไม่มีสินค้าตัวไหนตรงกับกฎนี้เลย = กฎตายเงียบ');
      continue;
    }
    const hit = findBlockingRule(blockRules, normalizeProductScope(prod));
    ok(`${label} บล็อก ${prod.model} ได้จริง`, hit !== null,
      hit ? `(ชนะโดยกฎ#${hit.id})` : 'ไม่ถูกบล็อก');
  }

  // ── 3. บรรทัดค่าขนส่งต้องไม่ถูกบล็อก ──────────────────────────────────────
  const cfg = await loadShippingFeeConfig();
  const feeModel = (cfg as any).productModel;
  const feeRef = (cfg as any).productInternalReference;
  console.log(`\nค่าขนส่ง: model="${feeModel}" ref="${feeRef}"`);

  if (!feeModel && !feeRef) {
    console.log('   (ยังไม่ตั้งค่าสินค้าค่าขนส่ง — ข้ามการตรวจ)');
  } else {
    const { rows } = await client.query(
      `SELECT model, model AS code, brand, series, production, internal_reference
         FROM products
        WHERE model = $1 OR internal_reference = $2
        ORDER BY quantity_on_hand_unreserved DESC
        LIMIT 1`,
      [feeModel || '', feeRef || '']
    );
    const prod = rows[0];
    ok('พบสินค้าค่าขนส่งใน products', !!prod, prod ? `[${prod.production}|${prod.brand}|${prod.series}]` : 'ไม่พบ');
    if (prod) {
      const feeRule = findBlockingRule(blockRules, normalizeProductScope(prod));
      ok('บรรทัดค่าขนส่งไม่ถูกกฎบล็อกครอบ (ถ้าโดน = ออกใบไม่ได้ทั้งใบ)',
        feeRule === null, feeRule ? `โดน rule#${feeRule.id}` : '');
      ok('isShippingFeeItem จับบรรทัดนี้ได้ (ตัวที่ด่านกลางกับ PDF ใช้ข้าม)',
        isShippingFeeItem({ model: prod.code, internal_reference: prod.internal_reference }, cfg));
    }
  }

  // ── 4. ทุกกฎต้องมีข้อความ ────────────────────────────────────────────────
  const noMsg = blockRules.filter(r => blockWarnText(r) === null);
  ok('ทุกกฎมี warn_msg (ไม่งั้นเซลล์ได้แต่ข้อความ default ที่ไม่บอกเหตุผล)',
    noMsg.length === 0, noMsg.length ? `ว่าง ${noMsg.length} แถว: ${noMsg.map(r => '#' + r.id).join(', ')}` : '');

  // ── 5. สินค้าที่ lookup ด้วย model ไม่เจอ = ทุกจุดปล่อยผ่าน ────────────────
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
