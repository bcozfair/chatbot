// ─────────────────────────────────────────────────────────────────────────────
//  Rule engine — type กลางที่ทุก rule type ใช้ร่วมกัน
//  scope ของกฏคือ (production, brand, series) เหมือนกันทุกตาราง
// ─────────────────────────────────────────────────────────────────────────────
export type { DbExecutor } from '../../config/db.js';

/** ส่วน scope ของกฏหนึ่งแถว — field ว่าง/null = wildcard (match ทุกค่า) */
export interface ScopeKey {
  production?: string | null;
  brand?: string | null;
  series?: string | null;
}

/** scope ของสินค้าที่ normalize แล้ว (trim + lowercase) — ค่าที่ไม่มีเป็น '' ไม่ใช่ null */
export interface ProductScope {
  production: string;
  brand: string;
  series: string;
}

/** กฏหนึ่งแถวที่ engine เรียงลำดับได้ — priority ยังไม่มีในตาราง (เพิ่ม Phase 1) จึงเป็น optional */
export interface ScopedRule extends ScopeKey {
  id: number;
  priority?: number | null;
}
