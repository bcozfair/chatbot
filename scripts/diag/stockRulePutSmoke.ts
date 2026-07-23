// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test: PUT /api/quotation/:id ต้องตรวจสต็อก "ทุกบรรทัด" ไม่ใช่แค่สินค้าที่พึ่งเพิ่ม
//  รัน:  npx tsx scripts/diag/stockRulePutSmoke.ts   (แตะ DB จริง — อ่านอย่างเดียว)
//
//  เคส: ECOM0010 (ของว่าง 1) อยู่ในร่างแล้ว ผู้ใช้เพิ่มจำนวนเป็น 2 แล้วกดบันทึก
//  เดิม endpoint validate เฉพาะ newItems (สินค้าที่ไม่อยู่ในใบเดิม) → รายการเดิมที่เพิ่มจำนวนหลุด
//  พิสูจน์ว่าต้องส่ง resultItems (ทุกบรรทัด) เข้า checkStockRules เหมือน checkMinSalesPrice
// ─────────────────────────────────────────────────────────────────────────────
import { checkStockRules } from '../../services/productService.js';
import { pool } from '../../config/db.js';

const PID = 16543; // ECOM0010, active stock rule, unreserved = 1

// mimic index.ts PUT handler: existing items already in the quote, plus what the client submits
function selectItemsForStockCheck(existingItemIds: number[], submitted: any[]) {
  const newItems = submitted.filter(i => i.product_id && !existingItemIds.includes(i.product_id));
  // resultItems = old items (echoed back by client) + new items — this is what save persists
  const resultItems = submitted;
  return { newItems, resultItems };
}

async function main() {
  let failures = 0;
  const ok = (label: string, cond: boolean) => {
    if (!cond) failures++;
    console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`);
  };

  // Scenario: ECOM0010 already in draft (qty 1), user bumps to qty 2 and saves.
  const existingItemIds = [PID];
  const submitted = [{ product_id: PID, model: 'ECOM0010', quantity: 2 }];
  const { newItems, resultItems } = selectItemsForStockCheck(existingItemIds, submitted);

  // OLD behavior: only newItems checked → existing line skipped → LEAK
  const oldWay = await checkStockRules(newItems);
  ok('OLD (newItems-only) leaks the qty bump — 0 violations', oldWay.length === 0);

  // FIXED behavior: check all resultItems → qty 2 vs available 1 → BLOCK
  const fixedWay = await checkStockRules(resultItems);
  ok('FIXED (resultItems) blocks the qty bump — 1 violation', fixedWay.length === 1);

  console.log(failures === 0 ? '\n✅ scenario proven' : `\n❌ FAIL ${failures}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
