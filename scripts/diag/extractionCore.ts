// ─────────────────────────────────────────────────────────────────────────────
//  Core ที่ diagnostic runner + model-comparison ใช้ร่วมกัน
//  (prompt + JSON parse อ่านของจริงจาก services/quoteExtraction.ts + ตัวเทียบ field)
// ─────────────────────────────────────────────────────────────────────────────
import type { DiagCase, ItemExpect } from './extractionCases.js';

// ─── prompt + JSON parse: อ่านของจริงจาก production ไม่ทำสำเนาแล้ว (เฟส C) ───
// เดิมไฟล์นี้ถือ "สำเนา" ของ prompt ไว้เอง เพราะ prompt ฝังอยู่กลาง handleEvent จน import ไม่ได้
// พอเฟส C ย้ายออกมาเป็น services/quoteExtraction.ts จึงเรียกของจริงได้ตรง ๆ
// ⇒ ด่านทุกตัวในโฟลเดอร์นี้วัด prompt ตัวเดียวกับที่บอทใช้จริง ไม่มีทาง drift ได้อีก
// (ตอนยุบสำเนาทิ้ง สำเนาต่างจากของจริงอยู่ 4 บรรทัด — เป็นช่องว่างท้ายบรรทัดที่ถูก editor ตัดไป)
export { buildExtractionPrompt, parseAiJson } from '../../services/quoteExtraction.js';

// ─── helpers การเทียบ ───
export const norm = (s: any) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
export const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));

export interface Check { field: string; ok: boolean; want: any; got: any; }

export function matchItem(actualItems: any[], exp: ItemExpect): { item: any | null; checks: Check[] } {
  const want = norm(exp.model_includes);
  const item = actualItems.find((it) => norm(it.model || it.product_code).includes(want)) || null;
  const checks: Check[] = [];
  checks.push({ field: `item[${exp.model_includes}] พบ`, ok: !!item, want: exp.model_includes, got: item ? (item.model ?? item.product_code) : '—ไม่พบ—' });
  if (!item) return { item, checks };

  if (exp.quantity !== undefined)
    checks.push({ field: `  qty`, ok: num(item.quantity) === exp.quantity, want: exp.quantity, got: item.quantity });
  if (exp.price_null)
    checks.push({ field: `  price=null`, ok: num(item.price) === null, want: null, got: item.price });
  if (exp.price !== undefined)
    checks.push({ field: `  price`, ok: num(item.price) === exp.price, want: exp.price, got: item.price });
  if (exp.discount_1 !== undefined)
    checks.push({ field: `  disc1`, ok: (num(item.discount_1) ?? 0) === exp.discount_1, want: exp.discount_1, got: item.discount_1 });
  if (exp.discount_2 !== undefined)
    checks.push({ field: `  disc2`, ok: (num(item.discount_2) ?? 0) === exp.discount_2, want: exp.discount_2, got: item.discount_2 });
  if (exp.discount_is_net !== undefined)
    checks.push({ field: `  net`, ok: !!item.discount_is_net === exp.discount_is_net, want: exp.discount_is_net, got: !!item.discount_is_net });
  return { item, checks };
}

export function evaluate(c: DiagCase, ai: any): Check[] {
  const checks: Check[] = [];
  const e = c.expect;
  const q = ai?.quotation_data || {};

  checks.push({ field: 'intent', ok: ai?.intent === e.intent, want: e.intent, got: ai?.intent });

  if (e.customer_includes !== undefined)
    checks.push({ field: 'customer_query', ok: norm(q.customer_query).includes(norm(e.customer_includes)), want: `⊇ ${e.customer_includes}`, got: q.customer_query });
  if (e.customer_null)
    checks.push({ field: 'customer_query=null', ok: q.customer_query == null || q.customer_query === '', want: null, got: q.customer_query });
  if (e.contact_includes !== undefined)
    checks.push({ field: 'contact_query', ok: norm(q.contact_query).includes(norm(e.contact_includes)), want: `⊇ ${e.contact_includes}`, got: q.contact_query });
  if (e.contact_null)
    checks.push({ field: 'contact_query=null', ok: q.contact_query == null || q.contact_query === '', want: null, got: q.contact_query });

  if (e.bill_discount_1 !== undefined)
    checks.push({ field: 'bill.disc1', ok: (num(q.discount_1) ?? 0) === e.bill_discount_1, want: e.bill_discount_1, got: q.discount_1 });
  if (e.bill_discount_2 !== undefined)
    checks.push({ field: 'bill.disc2', ok: (num(q.discount_2) ?? 0) === e.bill_discount_2, want: e.bill_discount_2, got: q.discount_2 });
  if (e.bill_is_net !== undefined)
    checks.push({ field: 'bill.net', ok: !!q.discount_is_net === e.bill_is_net, want: e.bill_is_net, got: !!q.discount_is_net });

  if (e.items) {
    const actualItems: any[] = Array.isArray(q.items) ? q.items : [];
    checks.push({ field: 'items.length', ok: actualItems.length === e.items.length, want: e.items.length, got: actualItems.length });
    for (const exp of e.items) checks.push(...matchItem(actualItems, exp).checks);
  }

  if (e.models_includes) {
    const models: string[] = (ai?.product_query?.models || ai?.product_query?.product_codes || []).map(norm);
    for (const m of e.models_includes)
      checks.push({ field: `models ⊇ ${m}`, ok: models.some((x) => x.includes(norm(m))), want: m, got: (ai?.product_query?.models || []).join(', ') });
  }

  return checks;
}
