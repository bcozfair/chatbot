// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกฎระงับเสนอราคาเมื่อสต็อกไม่พอ — ส่วนตรรกะ pure ไม่แตะ DB
//  รัน:  npx tsx scripts/diag/stockRuleSmoke.ts
//
//  ครอบคลุม: การตัดสิน block/ไม่ block เทียบ "ของว่างขายได้จริง (unreserved)" กับ
//            "จำนวนที่สั่ง" — จุดที่เดิมเช็คแค่ actual_quantity <= 0 (มี/ไม่มี) ทำให้
//            สั่ง 2 ชิ้นแต่มีของ 1 ชิ้นหลุดกฎ
//  ให้รันซ้ำทุกครั้งที่แตะ checkStockRules / evaluateStockViolation ใน productService.ts
// ─────────────────────────────────────────────────────────────────────────────
import { evaluateStockViolation } from '../../services/productService.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// rule = ของว่างขายได้ (unreserved) ตามจำนวนที่ระบุ
const rule = (unreserved: number) => ({
  model: 'ECOM0010',
  name: 'Solid State Relay',
  available: unreserved,
});

// ── กรณีบั๊กตัวจริง: มีของ 1 ชิ้น สั่ง 2 ชิ้น → ต้องบล็อก ──────────────────
ok('สั่ง 2 มีของ 1 → บล็อก (บั๊กเดิมหลุด)',
  evaluateStockViolation({ quantity: 2 }, rule(1)) !== null);

// ── ของพอดี: มี 2 สั่ง 2 → ไม่บล็อก ────────────────────────────────────
ok('สั่ง 2 มีของ 2 (พอดี) → ไม่บล็อก',
  evaluateStockViolation({ quantity: 2 }, rule(2)) === null);

// ── ของเกิน: มี 5 สั่ง 2 → ไม่บล็อก ────────────────────────────────────
ok('สั่ง 2 มีของ 5 → ไม่บล็อก',
  evaluateStockViolation({ quantity: 2 }, rule(5)) === null);

// ── ของหมดสนิท: มี 0 สั่งเท่าไหร่ก็บล็อก ────────────────────────────────
ok('สั่ง 1 มีของ 0 → บล็อก',
  evaluateStockViolation({ quantity: 1 }, rule(0)) !== null);

// ── ของว่างติดลบ (ถูกจองเกิน): มี -3 สั่ง 1 → บล็อก ─────────────────────
ok('สั่ง 1 มีของ -3 (จองเกิน) → บล็อก',
  evaluateStockViolation({ quantity: 1 }, rule(-3)) !== null);

// ── qty ไม่ระบุ = ถือว่า 1 ── สอดคล้องกับ checkMinOrderQty ที่ default qty=1
ok('ไม่ระบุ qty มีของ 0 → บล็อก (default qty=1)',
  evaluateStockViolation({}, rule(0)) !== null);
ok('ไม่ระบุ qty มีของ 1 → ไม่บล็อก (default qty=1)',
  evaluateStockViolation({}, rule(1)) === null);

// ── รูป violation ต้องมี fields ที่ผู้เรียกใช้ ──────────────────────────
const v = evaluateStockViolation({ quantity: 2 }, rule(1));
ok('violation มี type=OUT_OF_STOCK', v?.type === 'OUT_OF_STOCK');
ok('violation มี model', v?.model === 'ECOM0010');

console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ FAIL ${failures} รายการ`);
process.exit(failures === 0 ? 0 : 1);
