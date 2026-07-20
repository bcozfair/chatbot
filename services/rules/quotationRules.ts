// ─────────────────────────────────────────────────────────────────────────────
//  ตัว resolve กฏจากตาราง quotation_rules — จุดเดียวที่ query ตารางนี้เพื่อใช้งาน
//  (หน้าแอดมิน CRUD ยัง query ตรงเองได้ เพราะเป็นการอ่าน/เขียนเพื่อแสดงผล ไม่ใช่การตัดสินกฏ)
// ─────────────────────────────────────────────────────────────────────────────
import { pool, type DbExecutor } from '../../config/db.js';
import { loadCached } from './cache.js';
import { selectRule } from './scopeMatch.js';
import type { ProductScope, ScopedRule } from './types.js';

/** จุดตัดจำนวนของ tier วันจัดส่ง — เรียงจากมากไปน้อยเพื่อให้ไล่หาตัวแรกที่เข้าเงื่อนไขได้เลย */
export const DELIVERY_QTY_BREAKPOINTS = [100, 50, 20, 10] as const;

export type DeliveryQtyColumn =
  | 'delivery_days_qty_10'
  | 'delivery_days_qty_20'
  | 'delivery_days_qty_50'
  | 'delivery_days_qty_100';

export const DELIVERY_QTY_COLUMNS: Record<number, DeliveryQtyColumn> = {
  10: 'delivery_days_qty_10',
  20: 'delivery_days_qty_20',
  50: 'delivery_days_qty_50',
  100: 'delivery_days_qty_100'
};

export interface QuotationRule extends ScopedRule {
  warranty_years: number;
  warranty_unit: 'year' | 'month';
  is_locked: boolean;
  delivery_in_stock_days: number;
  delivery_out_of_stock_days: number;
  quote_company: 'PM' | 'THT' | null;
  delivery_days_qty_10: number | null;
  delivery_days_qty_20: number | null;
  delivery_days_qty_50: number | null;
  delivery_days_qty_100: number | null;
}

/** tier หนึ่งขั้น — `สั่ง >= min_qty ชิ้น แล้วสต็อกไม่พอ ให้ใช้ days วัน` */
export interface DeliveryQtyTier {
  min_qty: number;
  days: number;
}

export interface QuotationRuleOutcome {
  warranty_years: number;
  warranty_unit: 'year' | 'month';
  warranty_display: string;
  is_locked: boolean;
  delivery_in_stock_days: number;
  delivery_out_of_stock_days: number;
  quote_company: 'PM' | 'THT' | null;
  matched_rule_id: number | null;
  /** tier ที่กรอกไว้ เรียง min_qty จากมากไปน้อย — ว่าง = กฏนี้ไม่ใช้ tier */
  delivery_qty_tiers: DeliveryQtyTier[];
}

/** ค่าเริ่มต้นเมื่อไม่มีกฏใด match — ตรงกับค่าที่ hardcode อยู่เดิมทุกจุด (warranty 1 ปี, in 3 วัน, out 7 วัน) */
export const QUOTATION_RULE_DEFAULTS: QuotationRuleOutcome = {
  warranty_years: 1,
  warranty_unit: 'year',
  warranty_display: '1 ปี',
  is_locked: false,
  delivery_in_stock_days: 3,
  delivery_out_of_stock_days: 7,
  quote_company: null,
  matched_rule_id: null,
  delivery_qty_tiers: []
};

/**
 * ORDER BY ที่สะท้อนลำดับตัดสินของ engine (specificity DESC → id ASC)
 * ไม่ได้ใช้ตัดสินจริง (engine เรียงเองอีกที) แต่กันไว้เผื่อมีใครเผลอ query ตรงแล้วใช้ค่าแรก
 */
const RULES_ORDER_BY = `
  ORDER BY (CASE WHEN series IS NOT NULL THEN 4 ELSE 0 END
          + CASE WHEN brand IS NOT NULL THEN 2 ELSE 0 END
          + CASE WHEN production IS NOT NULL THEN 1 ELSE 0 END) DESC, id ASC
`;

/** โหลดกฏทั้งหมด (cached) — ทุกจุดที่เคย SELECT * FROM quotation_rules ต้องมาผ่านตัวนี้ */
export async function loadQuotationRules(exec: DbExecutor = pool): Promise<QuotationRule[]> {
  return await loadCached<QuotationRule>('quotation_rules', async () => {
    const res = await exec.query(`SELECT * FROM quotation_rules ${RULES_ORDER_BY}`);
    return (res.rows || []) as QuotationRule[];
  });
}

function warrantyDisplayOf(years: number, unit: 'year' | 'month'): string {
  return unit === 'month' ? `${years} เดือน` : `${years} ปี`;
}

/** ดึง tier ที่กรอกไว้จริงออกมา เรียง min_qty มาก→น้อย (ช่องที่เว้นว่างถูกข้าม) */
function tiersOf(rule: QuotationRule): DeliveryQtyTier[] {
  const tiers: DeliveryQtyTier[] = [];
  for (const minQty of DELIVERY_QTY_BREAKPOINTS) {
    const days = rule[DELIVERY_QTY_COLUMNS[minQty]];
    if (days !== null && days !== undefined) tiers.push({ min_qty: minQty, days: Number(days) });
  }
  return tiers;
}

/** แปลงกฏที่ชนะ (หรือไม่มีเลย) เป็นค่าที่เอาไปใช้ได้ตรง ๆ */
export function resolveQuotationRule(rules: QuotationRule[], scope: ProductScope): QuotationRuleOutcome {
  const rule = selectRule(rules, scope);
  if (!rule) return { ...QUOTATION_RULE_DEFAULTS };

  const warrantyYears = rule.warranty_years;
  const warrantyUnit = (rule.warranty_unit || 'year') as 'year' | 'month';

  return {
    warranty_years: warrantyYears,
    warranty_unit: warrantyUnit,
    warranty_display: warrantyDisplayOf(warrantyYears, warrantyUnit),
    is_locked: !!rule.is_locked,
    delivery_in_stock_days: rule.delivery_in_stock_days,
    delivery_out_of_stock_days: rule.delivery_out_of_stock_days,
    quote_company: rule.quote_company ?? null,
    matched_rule_id: rule.id,
    delivery_qty_tiers: tiersOf(rule)
  };
}

/**
 * วันจัดส่งเมื่อ "สต็อกไม่พอ" โดยคิดจากจำนวนที่สั่งของรายการนั้น
 *
 * ไล่ tier จากจุดตัดมากไปน้อย เจอตัวแรกที่ `qty >= min_qty` ชนะ
 * ไม่เข้า tier ไหนเลย (หรือกฏไม่ได้กรอก tier) → ใช้ delivery_out_of_stock_days เดิม
 *
 * ⚠️ ใช้กับกรณีสต็อกไม่พอเท่านั้น — ถ้าของพอส่ง ผู้เรียกต้องใช้ delivery_in_stock_days
 * ไม่ว่าจะสั่งกี่ชิ้นก็ตาม (ยืนยันกับฝ่ายขายแล้ว)
 */
export function resolveDeliveryOutOfStockDays(
  outcome: QuotationRuleOutcome,
  qty: number
): { days: number; source: string } {
  const quantity = Number(qty) || 0;
  for (const tier of outcome.delivery_qty_tiers) {
    if (quantity >= tier.min_qty) {
      return { days: tier.days, source: `qty_${tier.min_qty}` };
    }
  }
  return { days: outcome.delivery_out_of_stock_days, source: 'base' };
}

/**
 * หากฏที่บล็อกสินค้านี้
 *
 * ⚠️ ตั้งใจ filter is_locked ก่อนแล้วค่อย match — ไม่ใช่ resolve จากชุดเต็มแล้วดูว่าตัวชนะ locked ไหม
 * สองแบบให้ผลต่างกัน เช่น rule A {production:'Import', is_locked:true} + rule B {production:'Import',
 * brand:'ACME', series:'X', is_locked:false} → สินค้า ACME X ถูกบล็อกในแบบแรก แต่ไม่ถูกบล็อกในแบบที่สอง
 * การเปลี่ยนเป็นแบบที่สองเป็น product decision ที่ต้องตัดสินใจแยก — Phase 0 คงพฤติกรรมเดิม
 */
export function findBlockingRule(rules: QuotationRule[], scope: ProductScope): QuotationRule | null {
  return selectRule(rules.filter(r => r.is_locked === true), scope);
}

/**
 * หากฏที่กำหนดค่าย (PM/THT) — filter quote_company ก่อนแล้วค่อย match ตามพฤติกรรมเดิม
 */
export function findCompanyRule(rules: QuotationRule[], scope: ProductScope): QuotationRule | null {
  return selectRule(rules.filter(r => r.quote_company != null), scope);
}

function scopeLabel(rule: QuotationRule): string {
  return `${rule.production || ''} > ${rule.brand || ''} > ${rule.series || ''}`;
}

/** ข้อความบล็อกที่ส่งกลับทาง LINE / API — รูปแบบเดิมเป๊ะ */
export function buildBlockedMessage(rule: QuotationRule, productCode: string): string {
  return `❌ ระงับการเสนอราคา\n${productCode}\nเงื่อนไข: ${scopeLabel(rule)}\nกรุณาติดต่อแอดมิน`;
}

/** ข้อความบล็อกตอนสร้าง PDF — รูปแบบต่างจากตัวบน (รหัสสินค้าอยู่บรรทัดเดียวกัน) จึงแยกฟังก์ชัน */
export function buildBlockedPdfMessage(rule: QuotationRule, productCode: string): string {
  return `❌ ระงับการเสนอราคาสินค้า ${productCode}\nเงื่อนไข: ${scopeLabel(rule)}\nกรุณาติดต่อแอดมิน`;
}
