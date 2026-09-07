// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกฎบล็อกสินค้า (product_block_rules) — อ่านอย่างเดียว ไม่เขียน DB
//  รัน:  npm run diag:block-rule      (ต้องรันในคอนเทนเนอร์ที่ต่อ DB ได้)
//
//  โจทย์ที่สคริปต์นี้เฝ้า:
//   (ก) ถ้อยคำต้องมาจาก buildViolationDisplay ที่เดียว — ก่อนหน้านี้มี 3 ฟอร์แมตต่างกัน
//       (ด่านกลาง / API /blocked / PDF) เซลล์เลยเห็นข้อความไม่เหมือนกันในแต่ละจุด
//   (ข) ต้องรายงานครบทุกบรรทัด — ของเดิม return ทันทีที่เจอตัวแรก ใส่มา 3 ตัวเห็นแค่ตัวเดียว
//       เซลล์ต้องแก้แล้วกดใหม่ซ้ำ ๆ กว่าจะรู้ว่าติดกี่ตัว
//   (ค) รหัสสินค้าต้องเป็นรหัสจริง — ของเดิม violation.model เป็น '-' เสมอ
//   (ง) บรรทัดค่าขนส่งต้องถูกข้าม — มี internal_reference จริง กฎระดับ ref จึงครอบมันได้
//       ถ้าโดน = ออกใบไม่ได้ทั้งใบ ทั้งที่ PDF ข้ามบรรทัดนี้อยู่แล้ว
//   (จ) การ์ดสรุปต้องซ่อนปุ่มยืนยันเมื่อมีสินค้าถูกระงับ — เดิมปุ่มยังโผล่ กดแล้วเด้งแน่นอน
//   (ฉ) สินค้าที่ model ติดช่องว่างหัว/ท้ายจาก Odoo ต้องถูกบล็อกเหมือนกัน — เคยหลุดจริง
//       ด่านกลาง trim รหัสก่อนไป WHERE model = ANY() ที่ไม่ trim → ไม่เจอแถว → ปล่อยผ่านเงียบ ๆ
//       (เจอตอนตรวจหลัง deploy 2026-09-07 · หลุด 3 ตัว รวมตัวที่ตั้งกฎระดับ ref ไว้เจาะจง)
//
//  ให้รันซ้ำทุกครั้งที่แตะ blockRules.ts · checkBlockedProducts · buildViolationDisplay
//  · flexTemplates · pdfGenerator   คู่กับ npm run diag:block-parity
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  loadProductBlockRules, findBlockingRule, blockWarnText, normalizeProductScope
} from '../../services/rules/index.js';
import {
  checkBlockedProducts, buildViolationDisplay, validateQuotationItems, enrichQuotationData
} from '../../services/quotationService.js';
import { loadShippingFeeConfig } from '../../services/shippingFee.js';
import { getQuotationSummaryMessage } from '../../utils/flexTemplates.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const client = await pool.connect();
await client.query(`SET statement_timeout = '60s'`);

try {
  const rules = await loadProductBlockRules();
  if (rules.length === 0) {
    console.log('✗ FAIL  ไม่มีกฎบล็อกในระบบเลย — รัน migration เฟส 2 ก่อน');
    process.exit(1);
  }

  // ── หาสินค้าที่ถูกบล็อกจริง 2 ตัว + สินค้าปกติ 1 ตัว ────────────────────────
  const { rows: candidates } = await client.query(`
    SELECT DISTINCT ON (model)
           model, model AS code, name, brand, series, production, internal_reference,
           product_template_id AS product_id
      FROM products
     WHERE model IS NOT NULL AND btrim(model) <> ''
     ORDER BY model, quantity_on_hand_unreserved DESC
     LIMIT 4000
  `);

  const blocked: any[] = [];
  const normal: any[] = [];
  for (const p of candidates) {
    const hit = findBlockingRule(rules, normalizeProductScope(p));
    if (hit && blocked.length < 3) blocked.push({ ...p, rule: hit });
    else if (!hit && normal.length < 1) normal.push(p);
    if (blocked.length >= 3 && normal.length >= 1) break;
  }

  ok('หาสินค้าที่ถูกบล็อกมาทดสอบได้อย่างน้อย 2 ตัว', blocked.length >= 2,
    blocked.map(b => b.model).join(', '));
  ok('หาสินค้าปกติมาทดสอบได้', normal.length >= 1, normal[0]?.model ?? '');
  if (blocked.length < 2 || normal.length < 1) throw new Error('ข้อมูลไม่พอสำหรับทดสอบ');

  // shape เดียวกับ snapshot ที่ buildItemSnapshots สร้าง — มี scope ครบ 5 ช่อง
  // ⚠️ ด่าน PDF (เส้นทาง fallback) match จาก field ใน item ตรง ๆ ไม่ได้ query products
  //    item ที่ scope ไม่ครบจึงไม่มีวันติดกฎที่จุดนั้น (ด่านกลางไม่มีปัญหานี้ เพราะ lookup จาก DB)
  const toItem = (p: any) => ({
    product_code: p.model, model: p.model, name: p.name,
    brand: p.brand, series: p.series, production: p.production,
    internal_reference: p.internal_reference,
    product_id: p.product_id, product_template_id: p.product_id,
    price: 1000, quantity: 1, discount_1: 0, discount_2: 0
  });

  // บรรทัดค่าขนส่งจริงตามที่ตั้งค่าไว้ — ต้องถูกข้ามทุกกรณี
  const feeCfg = await loadShippingFeeConfig();
  const feeItem = {
    model: (feeCfg as any).productModel,
    product_code: (feeCfg as any).productModel,
    internal_reference: (feeCfg as any).productInternalReference,
    name: 'ค่าขนส่ง', price: 500, quantity: 1, is_shipping_fee: true
  };

  const items = [toItem(blocked[0]), toItem(normal[0]), toItem(blocked[1]), feeItem];

  // ── (ข)(ค) รายงานครบทุกบรรทัด พร้อมรหัสจริง ──────────────────────────────
  const found = await checkBlockedProducts(items);
  ok('รายงานครบทุกบรรทัดที่ถูกบล็อก (ไม่ใช่ตัวแรกตัวเดียว)', found.length === 2,
    `ได้ ${found.length} รายการ`);
  ok('violation.model เป็นรหัสสินค้าจริง ไม่ใช่ "-"',
    found.every(v => v.model && v.model !== '-'),
    found.map(v => v.model).join(', '));
  ok('รหัสที่รายงานตรงกับสินค้าที่ใส่เข้าไป',
    found.map(v => v.model).sort().join('|') === [blocked[0].model, blocked[1].model].sort().join('|'));
  ok('สินค้าปกติไม่ถูกรายงาน', !found.some(v => v.model === normal[0].model));
  ok('บรรทัดค่าขนส่งถูกข้าม', !found.some(v => v.model === feeItem.model));
  ok('warn_msg มาจากที่แอดมินกรอกไว้ใน DB',
    found.every(v => v.warn_msg && v.warn_msg.trim() !== ''),
    found[0]?.warn_msg ?? '');

  // ── (ก) ถ้อยคำเดียวกันทุกจุด ─────────────────────────────────────────────
  const target = blocked[0];
  const expected = `❌ ระงับการเสนอราคา รายการ ${target.model}: ${blockWarnText(target.rule)}`;

  // 1) ด่านกลาง (validateQuotationItems → buildViolationDisplay)
  const { violations } = await validateQuotationItems([toItem(target)], { stage: 'draft' });
  const gateMsg = violations.find(v => v.type === 'BLOCKED')?.display_message;
  ok('ด่านกลางให้ข้อความตาม template', gateMsg === expected, gateMsg ?? '(ไม่มี BLOCKED)');

  // 2) API GET /api/products/:code/blocked — ประกอบด้วยชิ้นส่วนเดียวกับที่ endpoint ใช้
  const apiRule = findBlockingRule(rules, normalizeProductScope(target));
  const apiMsg = apiRule ? buildViolationDisplay({
    type: 'BLOCKED', model: target.model, warn_msg: blockWarnText(apiRule) ?? undefined
  }) : null;
  ok('API /blocked ให้ข้อความเดียวกับด่านกลาง', apiMsg === expected, apiMsg ?? '(null)');

  // 3) PDF fail-safe — เส้นทาง fallback (ไม่มี snapshot) ต้อง throw ข้อความเดียวกัน
  const { generateQuotationPDF, closePdfBrowser } = await import('../../pdfGenerator.js');
  let pdfMsg: string | null = null;
  try {
    // ไม่ส่ง item_details = เส้นทาง fallback ที่คำนวณกฎสด ซึ่งเป็นจุดที่ด่าน PDF อยู่
    await generateQuotationPDF(
      { id: 0, quotation_no: 'DIAG-BLOCK', customer_name: 'ทดสอบ', items: [toItem(target)] } as any
    );
  } catch (err: any) {
    pdfMsg = String(err?.message ?? '');
  } finally {
    await closePdfBrowser().catch(() => {});
  }
  ok('PDF fail-safe ให้ข้อความเดียวกับด่านกลาง', pdfMsg === expected, pdfMsg ?? '(ไม่ throw)');

  // ── (จ) การ์ดสรุปต้องซ่อนปุ่มยืนยัน ──────────────────────────────────────
  const { rows: quoteRows } = await client.query(
    `SELECT * FROM quotations ORDER BY id DESC LIMIT 1`
  );
  if (quoteRows.length === 0) {
    console.log('   (ไม่มีใบเสนอราคาในระบบ — ข้ามการตรวจการ์ดสรุป)');
  } else {
    const base = await enrichQuotationData(quoteRows[0]);
    const withBlocked = { ...base, items: [{ ...toItem(target), stock: 10 }] };
    const flex = await getQuotationSummaryMessage([withBlocked]);
    const json = JSON.stringify(flex);
    ok('การ์ดสรุปบอกว่ามีรายการถูกระงับ', json.includes('ระงับการเสนอราคา'));
    ok('การ์ดสรุปซ่อนปุ่มยืนยันเมื่อมีสินค้าถูกระงับ',
      !json.includes('ยืนยันออกใบเสนอราคา'));

    // ของปกติต้องยังมีปุ่มอยู่ ไม่งั้นแปลว่าซ่อนผิดเคส
    const withNormal = { ...base, items: [{ ...toItem(normal[0]), price: 999999, stock: 10 }] };
    const flexOk = JSON.stringify(await getQuotationSummaryMessage([withNormal]));
    ok('สินค้าปกติยังมีปุ่มยืนยันตามเดิม', flexOk.includes('ยืนยันออกใบเสนอราคา'));
  }

  // ── (ฉ) model ที่ติดช่องว่างหัว/ท้าย ต้องตัดสินเหมือนกันทั้งเทียบแบบดิบและแบบ trim ──
  const { rows: wsRows } = await client.query(`
    SELECT DISTINCT ON (btrim(model))
           model AS raw_model, btrim(model) AS model, name,
           brand, series, production, internal_reference
      FROM products
     WHERE model IS NOT NULL AND model <> btrim(model)
     ORDER BY btrim(model), quantity_on_hand_unreserved DESC
  `);
  if (wsRows.length === 0) {
    console.log('   (ไม่มีสินค้าที่ model ติดช่องว่าง — ข้ามข้อ (ฉ))');
  } else {
    let wsBad = 0;
    for (const p of wsRows) {
      const want = !!findBlockingRule(rules, normalizeProductScope(p));
      for (const code of [p.raw_model, p.model]) {
        const got = (await checkBlockedProducts([{ product_code: code, quantity: 1 }])).length > 0;
        if (got !== want) {
          wsBad++;
          console.log(`     ✗ [${code}] ควรได้ ${want ? 'บล็อก' : 'ผ่าน'} แต่ด่านกลางให้ ${got ? 'บล็อก' : 'ผ่าน'}`);
        }
      }
    }
    ok(`model ติดช่องว่าง ${wsRows.length} ตัว ด่านกลางตัดสินตรงกับกฎทั้งแบบดิบและแบบ trim`, wsBad === 0);
  }

  console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ ไม่ผ่าน ${failures} ข้อ`);
} finally {
  client.release();
  await pool.end();
}

process.exit(failures === 0 ? 0 : 1);
