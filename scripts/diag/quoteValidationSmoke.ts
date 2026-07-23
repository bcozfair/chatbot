// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของด่านตรวจกฎรวม — ส่วน pure (ถ้อยคำ) ไม่แตะ DB
//  รัน:  npx tsx scripts/diag/quoteValidationSmoke.ts
//  ให้รันซ้ำทุกครั้งที่แตะ validateQuotationItems / buildViolationDisplay
// ─────────────────────────────────────────────────────────────────────────────
import { buildViolationDisplay, buildViolationText } from '../../services/quotationService.js';

let failures = 0;
const ok = (label: string, cond: boolean) => { if (!cond) failures++; console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`); };

ok('OUT_OF_STOCK ใส่ warn_msg', buildViolationDisplay({ type: 'OUT_OF_STOCK', model: 'ECOM0010', warn_msg: 'ของว่างขายได้ 1 ชิ้น ไม่พอกับจำนวนที่สั่ง 2 ชิ้น' }).includes('ECOM0010') && buildViolationDisplay({ type: 'OUT_OF_STOCK', model: 'ECOM0010', warn_msg: 'ของว่างขายได้ 1 ชิ้น ไม่พอกับจำนวนที่สั่ง 2 ชิ้น' }).includes('ไม่พอกับจำนวนที่สั่ง'));
ok('OUT_OF_STOCK optional note', buildViolationDisplay({ type: 'OUT_OF_STOCK', model: 'X', is_optional: true, linked_to_model: 'Y' }).includes('สินค้าเสริมของ Y'));
ok('MIN_PRICE โชว์ราคา', buildViolationDisplay({ type: 'MIN_PRICE_VIOLATION', model: 'X', price: 80, min_price: 100 }).includes('80.00') && buildViolationDisplay({ type: 'MIN_PRICE_VIOLATION', model: 'X', price: 80, min_price: 100 }).includes('100.00'));
ok('MOQ fallback', buildViolationDisplay({ type: 'MOQ_VIOLATION', model: 'X', min_order_qty: 10, qty: 3 }).includes('10') );
ok('BLOCKED ใช้ warn_msg', buildViolationDisplay({ type: 'BLOCKED', model: 'X', warn_msg: '❌ ระงับ X' }) === '❌ ระงับ X');
ok('SYSTEM_ERROR', buildViolationDisplay({ type: 'SYSTEM_ERROR', model: '-' }).includes('ตรวจสอบกฎไม่สำเร็จ'));
ok('buildViolationText ว่าง = ""', buildViolationText([]) === '');
ok('buildViolationText รวมหลายรายการ', buildViolationText([{ type: 'OUT_OF_STOCK', model: 'A', display_message: 'msgA' }, { type: 'MOQ_VIOLATION', model: 'B', display_message: 'msgB' }]).includes('msgA') );

// ── integration (แตะ DB): ECOM0010 ของว่าง 1 สั่ง 2 ต้องได้ OUT_OF_STOCK พร้อม display_message ──
import { validateQuotationItems } from '../../services/quotationService.js';
import { pool } from '../../config/db.js';
{
  const r = await validateQuotationItems(
    [{ product_id: 16543, product_template_id: 16543, model: 'ECOM0010', quantity: 2, price: 100 }],
    { stage: 'save' }
  );
  const stockV = r.violations.find(v => v.type === 'OUT_OF_STOCK');
  ok('validate: ECOM0010 สั่ง 2 → OUT_OF_STOCK', !!stockV);
  ok('validate: มี display_message พร้อมโชว์', !!stockV && stockV.display_message.includes('ECOM0010'));
}
{
  // parity: display_message เท่ากันไม่ว่าเรียกจาก stage ไหน (draft/save/confirm ใช้ชุดกฎเดียวกัน)
  const base = [{ product_id: 16543, product_template_id: 16543, model: 'ECOM0010', quantity: 2, price: 100 }];
  const a = await validateQuotationItems(base, { stage: 'draft' });
  const b = await validateQuotationItems(base, { stage: 'confirm' });
  const msgA = a.violations.find(v => v.type === 'OUT_OF_STOCK')?.display_message;
  const msgB = b.violations.find(v => v.type === 'OUT_OF_STOCK')?.display_message;
  ok('parity: draft vs confirm ข้อความ OUT_OF_STOCK ตรงกัน', !!msgA && msgA === msgB);
}
await pool.end();

console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
