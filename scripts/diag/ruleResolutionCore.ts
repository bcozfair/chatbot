// ─────────────────────────────────────────────────────────────────────────────
//  Core ที่ ruleResolutionDiff ใช้ — เก็บ matcher เก่าไว้เทียบกับ engine ใหม่
//
//  ⚠️ legacyMatch() ด้านล่างคัดลอกมาจาก quotationService.ts:551-575 (ก่อน refactor Phase 0a)
//     แบบ verbatim ตั้งใจ duplicate เพื่อไม่ให้ diagnostic ไปแตะ production
//     ถ้าจะลบสคริปต์นี้ทิ้งเมื่อ Phase 0 จบแล้ว ให้ลบทั้งไฟล์ ไม่ต้อง sync อะไร
// ─────────────────────────────────────────────────────────────────────────────
import type { ProductScope } from '../../services/rules/types.js';
import type { QuotationRuleOutcome } from '../../services/rules/quotationRules.js';

/**
 * matcher เดิม: Array.find() = "แถวแรกที่ match ชนะ"
 * ผลลัพธ์จึงขึ้นกับลำดับ physical row ที่ Postgres คืนมา (query เดิมไม่มี ORDER BY)
 */
export function legacyMatch(rules: any[], scope: ProductScope): any | null {
  const prodBrand = scope.brand;
  const prodSeries = scope.series;
  const prodProduction = scope.production;
  const clean = (s: string) => s.replace(/\s+/g, '').toLowerCase();

  return rules.find(r => {
    if (r.production) {
      // sentinel เดิม — ถูกตัดออกจาก production แล้วใน Phase 0a แต่คงไว้ที่นี่เพื่อให้เทียบตรงกับของเก่าจริง ๆ
      // ถ้ารายงานโผล่ความต่างจากบรรทัดนี้ แปลว่ายังมีกฏ '__NULL__' ค้างใน DB (Phase 1 จะ DELETE ทิ้ง)
      if (r.production === '__NULL__') {
        if (prodProduction !== '') return false;
      } else {
        const rp = clean(r.production);
        const ip = clean(prodProduction);
        const isImportMatch = (rp === 'import' && ip.startsWith('import'));
        const isExactMatch = (rp === ip);
        if (!isExactMatch && !isImportMatch) return false;
      }
    }
    if (r.brand && r.brand.trim().toLowerCase() !== prodBrand) return false;
    if (r.series && r.series.trim().toLowerCase() !== prodSeries) return false;
    return true;
  }) || null;
}

/** แปลงกฏดิบเป็น outcome แบบเดียวกับที่ engine ใหม่คืน เพื่อให้เทียบกันได้ตรง field */
export function outcomeOf(rule: any | null): QuotationRuleOutcome {
  if (!rule) {
    return {
      warranty_years: 1,
      warranty_unit: 'year',
      warranty_display: '1 ปี',
      is_locked: false,
      delivery_in_stock_days: 3,
      delivery_out_of_stock_days: 7,
      quote_company: null,
      matched_rule_id: null
    };
  }
  const unit = (rule.warranty_unit || 'year') as 'year' | 'month';
  return {
    warranty_years: rule.warranty_years,
    warranty_unit: unit,
    warranty_display: unit === 'month' ? `${rule.warranty_years} เดือน` : `${rule.warranty_years} ปี`,
    is_locked: !!rule.is_locked,
    delivery_in_stock_days: rule.delivery_in_stock_days,
    delivery_out_of_stock_days: rule.delivery_out_of_stock_days,
    quote_company: rule.quote_company ?? null,
    matched_rule_id: rule.id
  };
}

/** คืนรายชื่อ field ที่ค่าต่างกัน — ว่าง = เหมือนกันทุกประการ */
export function diffOutcome(a: QuotationRuleOutcome, b: QuotationRuleOutcome): string[] {
  const fields: Array<keyof QuotationRuleOutcome> = [
    'warranty_years', 'warranty_unit', 'warranty_display', 'is_locked',
    'delivery_in_stock_days', 'delivery_out_of_stock_days', 'quote_company', 'matched_rule_id'
  ];
  return fields.filter(f => a[f] !== b[f]).map(f => `${f}: ${a[f]} → ${b[f]}`);
}

/** สลับลำดับ array แบบ deterministic ตาม seed (mulberry32) — จำลองลำดับแถวที่ Postgres อาจคืนมา */
export function shuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
