// ─────────────────────────────────────────────────────────────────────────────
//  Diagnostic — เทียบ matcher เก่า (Array.find, ไม่ deterministic) กับ rule engine ใหม่
//  ไม่แก้ข้อมูลใด ๆ อ่านอย่างเดียว
//
//  รัน:  npx tsx scripts/diag/ruleResolutionDiff.ts domain      (default)
//        npx tsx scripts/diag/ruleResolutionDiff.ts ambiguity
//        npx tsx scripts/diag/ruleResolutionDiff.ts replay
//
//  domain    — ทุก (production, brand, series) ที่มีจริงใน products เทียบผลลัพธ์
//              รายงานจำนวน triple ที่ต่าง + จำนวนสินค้าที่กระทบ (ถ่วงด้วย COUNT)
//  ambiguity — รัน matcher เก่าซ้ำ 50 รอบด้วยลำดับกฏที่สลับ seed ต่างกัน
//              triple ไหนได้ผลไม่คงที่ = วันนี้ระบบไม่ deterministic อยู่แล้ว
//  replay    — ดึงใบเสนอราคาล่าสุด 1,000 ใบ คำนวณใหม่ทั้งสอง matcher
//              เทียบกับค่าที่ freeze ไว้ใน item_details
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { normalizeProductScope, selectRule, explainMatch } from '../../services/rules/scopeMatch.js';
import { resolveQuotationRule } from '../../services/rules/quotationRules.js';
import { legacyMatch, outcomeOf, diffOutcome, shuffle } from './ruleResolutionCore.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YEL = '\x1b[33m', RESET = '\x1b[0m';

const SHUFFLE_ROUNDS = 50;
const REPLAY_LIMIT = 1000;

interface DomainRow { production: string; brand: string; series: string; count: number }

async function loadRules(): Promise<any[]> {
  const res = await pool.query('SELECT * FROM quotation_rules');
  return res.rows || [];
}

async function loadDomain(): Promise<DomainRow[]> {
  const res = await pool.query(`
    SELECT COALESCE(production, '') AS production,
           COALESCE(brand, '')      AS brand,
           COALESCE(series, '')     AS series,
           COUNT(*)::int            AS count
    FROM products
    GROUP BY 1, 2, 3
    ORDER BY count DESC
  `);
  return res.rows as DomainRow[];
}

const scopeLabel = (r: DomainRow) =>
  `${r.production || '(ว่าง)'} > ${r.brand || '(ว่าง)'} > ${r.series || '(ว่าง)'}`;

const ruleLabel = (r: any) =>
  r ? `#${r.id} [${r.production || '*'} > ${r.brand || '*'} > ${r.series || '*'}]` : '(ไม่มีกฏ)';

// ── mode: domain ─────────────────────────────────────────────────────────────
async function runDomain() {
  const rules = await loadRules();
  const domain = await loadDomain();

  console.log(`${BOLD}Rule Resolution Diff — mode=domain${RESET}`);
  console.log(`${DIM}กฏใน quotation_rules: ${rules.length} แถว · scope ที่มีสินค้าจริง: ${domain.length} แบบ${RESET}\n`);

  let diffTriples = 0;
  let diffProducts = 0;
  let totalProducts = 0;
  const fieldCounter = new Map<string, number>();

  for (const row of domain) {
    totalProducts += row.count;
    const scope = normalizeProductScope(row);

    const oldOutcome = outcomeOf(legacyMatch(rules, scope));
    const newOutcome = resolveQuotationRule(rules as any, scope);
    const changed = diffOutcome(oldOutcome, newOutcome);
    if (changed.length === 0) continue;

    diffTriples++;
    diffProducts += row.count;
    for (const c of changed) {
      const field = c.split(':')[0];
      fieldCounter.set(field, (fieldCounter.get(field) || 0) + 1);
    }

    const oldRule = legacyMatch(rules, scope);
    const newRule = selectRule(rules as any, scope);
    console.log(`${YEL}▲${RESET} ${BOLD}${scopeLabel(row)}${RESET} ${DIM}(${row.count} สินค้า)${RESET}`);
    console.log(`    เก่า: ${ruleLabel(oldRule)}`);
    console.log(`    ใหม่: ${ruleLabel(newRule)}`);
    for (const c of changed) console.log(`    ${DIM}·${RESET} ${c}`);

    const candidates = explainMatch(rules as any, scope);
    if (candidates.length > 1) {
      console.log(`    ${DIM}กฏที่ match ทั้งหมด (เรียงตามลำดับใหม่): ${candidates
        .map(c => `${ruleLabel(c.rule)} spec=${c.specificity}`)
        .join(' | ')}${RESET}`);
    }
    console.log('');
  }

  console.log(`${BOLD}══ สรุป ══${RESET}`);
  if (diffTriples === 0) {
    console.log(`  ${GREEN}ไม่มี scope ใดเปลี่ยนผลลัพธ์${RESET} — engine ใหม่ให้ค่าเท่าเดิมทุกกรณี`);
  } else {
    console.log(`  ${YEL}scope ที่เปลี่ยน: ${diffTriples}/${domain.length}${RESET}`);
    console.log(`  ${YEL}สินค้าที่กระทบ: ${diffProducts}/${totalProducts}${RESET} (${((diffProducts / totalProducts) * 100).toFixed(2)}%)`);
    console.log(`  field ที่เปลี่ยน:`);
    for (const [field, n] of [...fieldCounter.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    · ${field}: ${n} scope`);
    }
    console.log(`\n  ${DIM}เกณฑ์ผ่าน: ทุกแถวข้างบนต้องอธิบายได้ว่าค่าใหม่ถูกต้องกว่า (กฏที่จำเพาะกว่าชนะ)${RESET}`);
  }
}

// ── mode: ambiguity ──────────────────────────────────────────────────────────
async function runAmbiguity() {
  const rules = await loadRules();
  const domain = await loadDomain();

  console.log(`${BOLD}Rule Resolution Diff — mode=ambiguity${RESET}`);
  console.log(`${DIM}รัน matcher เก่า ${SHUFFLE_ROUNDS} รอบต่อ scope ด้วยลำดับกฏที่สลับ${RESET}\n`);

  let unstable = 0;
  let unstableProducts = 0;
  let totalProducts = 0;

  for (const row of domain) {
    totalProducts += row.count;
    const scope = normalizeProductScope(row);

    const seen = new Map<string, number>();
    for (let seed = 1; seed <= SHUFFLE_ROUNDS; seed++) {
      const matched = legacyMatch(shuffle(rules, seed), scope);
      const key = matched ? String(matched.id) : 'none';
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    if (seen.size <= 1) continue;

    unstable++;
    unstableProducts += row.count;
    const winner = selectRule(rules as any, scope);
    console.log(`${RED}⚠${RESET} ${BOLD}${scopeLabel(row)}${RESET} ${DIM}(${row.count} สินค้า)${RESET}`);
    console.log(`    ผลจาก matcher เก่าไม่คงที่: ${[...seen.entries()]
      .map(([id, n]) => `rule ${id} × ${n}`)
      .join(', ')}`);
    console.log(`    engine ใหม่เลือกเสมอ: ${ruleLabel(winner)}\n`);
  }

  console.log(`${BOLD}══ สรุป ══${RESET}`);
  if (unstable === 0) {
    console.log(`  ${GREEN}ไม่พบ scope ที่ผลลัพธ์ขึ้นกับลำดับแถว${RESET}`);
  } else {
    console.log(`  ${RED}scope ที่วันนี้ไม่ deterministic: ${unstable}/${domain.length}${RESET}`);
    console.log(`  ${RED}สินค้าที่อยู่ในความเสี่ยงนี้: ${unstableProducts}/${totalProducts}${RESET}`);
    console.log(`\n  ${DIM}แถวเหล่านี้พลิกผลได้เองหลัง UPDATE/VACUUM โดยไม่มีใครแก้กฏ${RESET}`);
    console.log(`  ${DIM}engine ใหม่ไม่ได้สร้างความเสี่ยงใหม่ แต่ทำให้ความเสี่ยงเดิมนิ่ง${RESET}`);
  }
}

// ── mode: replay ─────────────────────────────────────────────────────────────
async function runReplay() {
  const rules = await loadRules();

  const res = await pool.query(`
    SELECT id, quotation_no, created_at, item_details
    FROM quotations
    WHERE item_details IS NOT NULL
    ORDER BY created_at DESC
    LIMIT $1
  `, [REPLAY_LIMIT]);
  const quotes = res.rows || [];

  console.log(`${BOLD}Rule Resolution Diff — mode=replay${RESET}`);
  console.log(`${DIM}ใบเสนอราคาที่ตรวจ: ${quotes.length} ใบ${RESET}\n`);

  let itemsChecked = 0;
  let orderingDiff = 0;        // เก่า vs ใหม่ ต่างกัน = ผลจากการเปลี่ยน ordering
  let ruleEditedDiff = 0;      // เก่ากับใหม่ตรงกัน แต่ไม่ตรง snapshot = กฏถูกแก้หลังใบถูกสร้าง
  const affectedQuotes = new Set<string>();

  for (const q of quotes) {
    const items = Array.isArray(q.item_details) ? q.item_details : [];
    for (const item of items) {
      itemsChecked++;
      const scope = normalizeProductScope(item);

      const oldOutcome = outcomeOf(legacyMatch(rules, scope));
      const newOutcome = resolveQuotationRule(rules as any, scope);

      const frozenWarranty = item.warranty_display ?? null;
      const frozenIn = item.delivery_in_stock_days ?? null;
      const frozenOut = item.delivery_out_of_stock_days ?? null;

      const matchesFrozen = (o: typeof oldOutcome) =>
        (frozenWarranty === null || o.warranty_display === frozenWarranty) &&
        (frozenIn === null || o.delivery_in_stock_days === frozenIn) &&
        (frozenOut === null || o.delivery_out_of_stock_days === frozenOut);

      const changed = diffOutcome(oldOutcome, newOutcome);

      if (changed.length > 0) {
        orderingDiff++;
        affectedQuotes.add(q.quotation_no || q.id);
        console.log(`${YEL}▲ ordering${RESET} ${q.quotation_no || q.id} ${DIM}${item.model || item.internal_reference}${RESET}`);
        console.log(`    snapshot: ${frozenWarranty} / in ${frozenIn} / out ${frozenOut}`);
        for (const c of changed) console.log(`    ${DIM}·${RESET} ${c}`);
      } else if (!matchesFrozen(newOutcome)) {
        ruleEditedDiff++;
        affectedQuotes.add(q.quotation_no || q.id);
        console.log(`${DIM}▽ rule-edited${RESET} ${q.quotation_no || q.id} ${DIM}${item.model || item.internal_reference}${RESET}`);
        console.log(`    ${DIM}snapshot: ${frozenWarranty} / in ${frozenIn} / out ${frozenOut}`);
        console.log(`    คำนวณใหม่: ${newOutcome.warranty_display} / in ${newOutcome.delivery_in_stock_days} / out ${newOutcome.delivery_out_of_stock_days}${RESET}`);
      }
    }
  }

  console.log(`\n${BOLD}══ สรุป ══${RESET}`);
  console.log(`  รายการที่ตรวจ: ${itemsChecked} จาก ${quotes.length} ใบ`);
  console.log(`  ${orderingDiff === 0 ? GREEN : YEL}ต่างเพราะเปลี่ยน ordering: ${orderingDiff}${RESET} ${DIM}(นี่คือผลจาก Phase 0)${RESET}`);
  console.log(`  ${DIM}ต่างเพราะกฏถูกแก้หลังใบถูกสร้าง: ${ruleEditedDiff} (ไม่เกี่ยวกับ Phase 0)${RESET}`);
  console.log(`  ใบที่กระทบรวม: ${affectedQuotes.size}`);
  console.log(`\n  ${DIM}หมายเหตุ: ใบที่ออก PDF จาก snapshot จะไม่เปลี่ยนอยู่แล้ว — รายการนี้บอกว่าใบไหน${RESET}`);
  console.log(`  ${DIM}จะได้ค่าต่างออกไปถ้าถูกคำนวณใหม่ (เช่นหลุดเข้า fallback path ของ pdfGenerator)${RESET}`);
}

async function main() {
  const mode = (process.argv[2] || 'domain').toLowerCase();
  try {
    if (mode === 'domain') await runDomain();
    else if (mode === 'ambiguity') await runAmbiguity();
    else if (mode === 'replay') await runReplay();
    else {
      console.error(`ไม่รู้จัก mode "${mode}" — ใช้ได้: domain | ambiguity | replay`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
