// Barrel export ของ rule engine — ผู้ใช้งานภายนอกควร import จากที่นี่ที่เดียว
export type { ProductScope, ScopeKey, ScopedRule } from './types.js';
export {
  normalizeProductScope,
  ruleMatchesScope,
  scopeSpecificity,
  productionMatchKind,
  selectRule,
  explainMatch
} from './scopeMatch.js';
export { invalidateRuleCache, type RuleCacheKey } from './cache.js';
export {
  loadQuotationRules,
  resolveQuotationRule,
  resolveDeliveryOutOfStockDays,
  findBlockingRule,
  findCompanyRule,
  buildBlockedMessage,
  buildBlockedPdfMessage,
  QUOTATION_RULE_DEFAULTS,
  DELIVERY_QTY_BREAKPOINTS,
  type QuotationRule,
  type QuotationRuleOutcome,
  type DeliveryQtyTier
} from './quotationRules.js';
