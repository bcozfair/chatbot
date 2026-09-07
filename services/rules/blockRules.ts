// ─────────────────────────────────────────────────────────────────────────────
//  กฎบล็อกสินค้า — จุดเดียวที่ query ตาราง product_block_rules เพื่อใช้ตัดสิน
//  (หน้าแอดมิน CRUD ยัง query ตรงเองได้ เพราะเป็นการอ่าน/เขียนเพื่อแสดงผล ไม่ใช่การตัดสินกฎ)
//
//  แยกออกจาก quotation_rules โดยตั้งใจ — ดู docs/plan-product-block-rules.md §0
//  ถ้าเอา model/internal_reference ไปใส่ใน quotation_rules แถว "บล็อกสินค้าตัวนี้" จะกลาย
//  เป็นแถวจำเพาะที่สุดของสินค้านั้น แล้วไปทับ warranty/วันจัดส่งของ brand ด้วยค่า default
// ─────────────────────────────────────────────────────────────────────────────
import { pool, type DbExecutor } from '../../config/db.js';
import { loadCached } from './cache.js';
import { selectRule } from './scopeMatch.js';
import type { ProductScope, ScopedRule } from './types.js';

export interface ProductBlockRule extends ScopedRule {
  warn_msg: string;
  is_active: boolean;
}

/**
 * ORDER BY ที่สะท้อนลำดับตัดสินของ engine (specificity DESC → id ASC)
 * ไม่ได้ใช้ตัดสินจริง (engine เรียงเองอีกที) แต่กันไว้เผื่อมีใครเผลอ query ตรงแล้วใช้ค่าแรก
 */
const RULES_ORDER_BY = `
  ORDER BY (CASE WHEN internal_reference IS NOT NULL THEN 16 ELSE 0 END
          + CASE WHEN model IS NOT NULL THEN 8 ELSE 0 END
          + CASE WHEN series IS NOT NULL THEN 4 ELSE 0 END
          + CASE WHEN brand IS NOT NULL THEN 2 ELSE 0 END
          + CASE WHEN production IS NOT NULL THEN 1 ELSE 0 END) DESC, id ASC
`;

/**
 * โหลดกฎบล็อกที่เปิดใช้อยู่ (cached)
 *
 * กรอง is_active ที่ SQL ไม่ใช่ในหน่วยความจำ — กฎที่ปิดไว้ไม่ควรกินที่ใน cache
 * และผู้เรียกทุกคนจะได้ชุดเดียวกันเสมอโดยไม่ต้องจำว่าต้อง filter เอง
 */
export async function loadProductBlockRules(exec: DbExecutor = pool): Promise<ProductBlockRule[]> {
  return await loadCached<ProductBlockRule>('product_block_rules', async () => {
    const res = await exec.query(
      `SELECT * FROM product_block_rules WHERE is_active = true ${RULES_ORDER_BY}`
    );
    return (res.rows || []) as ProductBlockRule[];
  });
}

/**
 * หากฎที่บล็อกสินค้านี้ — ไม่มีกฎไหนครอบ = null
 *
 * ทุกแถวในตารางนี้คือกฎบล็อกอยู่แล้ว จึงไม่ต้อง filter อะไรก่อน match
 * (ต่างจาก findBlockingRule เดิมที่ต้อง filter is_locked ออกจากกฎรวมก่อน)
 */
export function findBlockingRule(rules: ProductBlockRule[], scope: ProductScope): ProductBlockRule | null {
  return selectRule(rules, scope);
}

/**
 * ข้อความที่แอดมินกรอกไว้ — DB บังคับ NOT NULL + ห้ามว่างอยู่แล้ว
 * แต่ยังกันไว้อีกชั้นเผื่อแถวเก่า/ข้อมูลจากที่อื่น: ว่าง = null ให้ผู้เรียกเติม default เอง
 */
export function blockWarnText(rule: ProductBlockRule): string | null {
  const t = String(rule?.warn_msg ?? '').trim();
  return t === '' ? null : t;
}
