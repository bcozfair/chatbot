// ─────────────────────────────────────────────────────────────────────────────
//  Pure matching + specificity — ไม่แตะ DB ไม่มี side effect
//  แทนที่ matcher ที่เคย copy-paste อยู่ 5 จุด
//  (quotationService.ts x2, index.ts x2, pdfGenerator.ts x1)
// ─────────────────────────────────────────────────────────────────────────────
import type { ProductScope, ScopeKey } from './types.js';

/** trim + lowercase — ใช้กับ brand/series (คงพฤติกรรมเดิม: ไม่ตัดช่องว่างกลางคำ) */
const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** ตัดช่องว่างทั้งหมด + lowercase — ใช้กับ production เท่านั้น (คงพฤติกรรมเดิม) */
const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/**
 * แปลงข้อมูลสินค้า (แถวจาก products หรือ item ใน snapshot) เป็น scope ที่ normalize แล้ว
 */
export function normalizeProductScope(src: any): ProductScope {
  return {
    production: norm(src?.production),
    brand: norm(src?.brand),
    series: norm(src?.series)
  };
}

/**
 * กฏ match สินค้าหรือไม่
 * Semantics: field ว่างในกฏ = wildcard · 'import' prefix-match 'import*' · นอกนั้น exact
 */
export function ruleMatchesScope(rule: ScopeKey, scope: ProductScope): boolean {
  if (rule.production) {
    const rp = clean(rule.production);
    const ip = clean(scope.production);
    const isImportMatch = (rp === 'import' && ip.startsWith('import'));
    if (rp !== ip && !isImportMatch) return false;
  }
  if (rule.brand && norm(rule.brand) !== scope.brand) return false;
  if (rule.series && norm(rule.series) !== scope.series) return false;
  return true;
}

/**
 * ความจำเพาะของกฏเป็น bitmask 0..7
 * series=4, brand=2, production=1 เพราะ series ⊂ brand ⊂ production
 * ดังนั้นกฏที่ระบุ {series} (=4) ต้องชนะกฏที่ระบุ {production, brand} (=3)
 */
export function scopeSpecificity(rule: ScopeKey): number {
  return (rule.series ? 4 : 0) + (rule.brand ? 2 : 0) + (rule.production ? 1 : 0);
}

/**
 * ชนิดการ match ของ production: 2 = exact, 1 = prefix (กฏ 'import' เจอสินค้า 'Import(PM)'), 0 = wildcard
 * ใช้เป็นตัวตัดสินรองจาก specificity — exact ต้องชนะ prefix
 */
export function productionMatchKind(rule: ScopeKey, scope: ProductScope): 0 | 1 | 2 {
  if (!rule.production) return 0;
  const rp = clean(rule.production);
  const ip = clean(scope.production);
  if (rp === ip) return 2;
  if (rp === 'import' && ip.startsWith('import')) return 1;
  return 0;
}

/**
 * ลำดับตัดสิน: priority DESC → specificity DESC → productionMatchKind DESC → id ASC
 * (priority ยังไม่มีในตารางช่วง Phase 0 → อ่านได้ 0 ทุกแถว = ตกไปใช้ specificity)
 */
function compareRules(a: any, b: any, scope: ProductScope): number {
  const pa = Number(a?.priority ?? 0);
  const pb = Number(b?.priority ?? 0);
  if (pa !== pb) return pb - pa;

  const sa = scopeSpecificity(a);
  const sb = scopeSpecificity(b);
  if (sa !== sb) return sb - sa;

  const ka = productionMatchKind(a, scope);
  const kb = productionMatchKind(b, scope);
  if (ka !== kb) return kb - ka;

  return Number(a?.id ?? 0) - Number(b?.id ?? 0);
}

/**
 * เลือกกฏที่ชนะแบบ deterministic — ไม่ขึ้นกับลำดับแถวที่ Postgres คืนมา
 */
export function selectRule<T extends ScopeKey>(rules: T[], scope: ProductScope): T | null {
  if (!rules || rules.length === 0) return null;
  const matched = rules.filter(r => ruleMatchesScope(r, scope));
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0];
  return matched.slice().sort((a, b) => compareRules(a, b, scope))[0];
}

/**
 * เหมือน selectRule แต่คืนทุกกฏที่ match พร้อมคะแนน — ใช้ในสคริปต์ diagnostic เพื่ออธิบายว่าทำไมตัวไหนชนะ
 */
export function explainMatch<T extends ScopeKey>(
  rules: T[],
  scope: ProductScope
): Array<{ rule: T; specificity: number; rank: number }> {
  const matched = (rules || []).filter(r => ruleMatchesScope(r, scope));
  return matched
    .slice()
    .sort((a, b) => compareRules(a, b, scope))
    .map((rule, idx) => ({ rule, specificity: scopeSpecificity(rule), rank: idx + 1 }));
}
