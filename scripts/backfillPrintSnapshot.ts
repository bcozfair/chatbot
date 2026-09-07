// ─────────────────────────────────────────────────────────────────────────────
//  Backfill quotations.print_snapshot ให้ใบที่ออกเลขไปแล้วก่อนระบบมีคอลัมน์นี้
//
//  รัน:  npm run backfill:print-snapshot                (dry-run — แค่รายงาน ไม่เขียน)
//        npm run backfill:print-snapshot -- --apply     (เขียนจริง)
//
//  ⚠️⚠️ ค่าที่ได้เป็นสต๊อก "วันที่รันสคริปต์" ไม่ใช่สต๊อก ณ วันออกใบ
//
//      สต๊อกไม่เคยถูกเก็บลงใบเลย (ตรวจแล้ว 0 จาก 679 ใบมีคีย์ stock ใน item_details)
//      pdfGenerator อ่านจาก products.quantity_on_hand_unreserved สดทุกครั้งที่เจน
//
//      แต่นี่คือสต๊อกชุดเดียวกับที่ scripts/backfillDeliveryTerms.ts ใช้ตัดสิน In_stock. /
//      Make to order. ไปแล้ว การตรึงตรงนี้จึงทำให้ทั้งสองก้อนสอดคล้องกันถาวร
//      ถ้าปล่อยไว้ บรรทัด "(*** สินค้าคงเหลือ N pcs. ***)" จะค่อย ๆ ขัดกับกำหนดส่งที่ตรึงไว้
//
//      ทุกแถวที่สคริปต์นี้เขียนจะมี "backfilled": true ติดไว้ เพื่อแยกออกทีหลังว่าค่าไหน
//      ตรึงมาจากตอนยืนยันจริง (เชื่อถือได้) ค่าไหนมาจากสคริปต์นี้ (ประมาณเอา)
//
//  ปลอดภัย: UPDATE เฉพาะแถวที่ print_snapshot IS NULL (มีเงื่อนไขซ้ำใน WHERE ของ UPDATE ด้วย
//  กันชนกับการยืนยันใบที่เกิดขึ้นระหว่างสคริปต์ทำงาน) จึง idempotent — รันซ้ำได้ไม่ทับของเดิม
//
//  ย้อนกลับ: UPDATE quotations SET print_snapshot = NULL
//              WHERE print_snapshot->>'backfilled' = 'true';
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../config/db.js';

const APPLY = process.argv.includes('--apply');

// ขอบเขต = "ใบที่มีเลขที่แล้ว" — เกณฑ์เดียวกับที่ pdfGenerator ใช้ตัดสินว่าใบไหนต้องนิ่ง
// และเป็นเกณฑ์เดียวกับ backfillDeliveryTerms.ts เพื่อให้สองก้อนครอบใบชุดเดียวกันเป๊ะ
const { rows: quotes } = await pool.query(
  `SELECT id, quotation_no, status, item_details
     FROM quotations
    WHERE print_snapshot IS NULL
      AND quotation_no IS NOT NULL AND TRIM(quotation_no) <> ''
      AND jsonb_typeof(item_details) = 'array' AND jsonb_array_length(item_details) > 0
    ORDER BY created_at DESC`
);

console.log(`โหมด: ${APPLY ? '🔴 เขียนจริง (--apply)' : '🟢 dry-run (ไม่เขียน)'}`);
console.log(`ใบที่เข้าเงื่อนไข: ${quotes.length} ใบ\n`);

if (quotes.length === 0) {
  console.log('ไม่มีใบที่ต้อง backfill');
  await pool.end();
  process.exit(0);
}

// ดึงสต๊อกของทุก model ครั้งเดียว — กติกาเดียวกับ enrichQuotationData (หลายแถวชื่อซ้ำ = เอาค่ามากสุด)
const models = Array.from(new Set(
  quotes.flatMap((q: any) => (q.item_details as any[])
    .map(it => it.model || it.internal_reference)
    .filter(Boolean))
));
const stockMap: Record<string, number> = {};
if (models.length > 0) {
  const { rows } = await pool.query(
    'SELECT model AS code, quantity_on_hand_unreserved AS stock FROM products WHERE model = ANY($1)',
    [models]
  );
  rows.forEach((p: any) => {
    const s = p.stock !== undefined && p.stock !== null ? Number(p.stock) : 0;
    if (stockMap[p.code] === undefined || s > stockMap[p.code]) stockMap[p.code] = s;
  });
}
console.log(`ดึงสต๊อกของสินค้า ${models.length} รุ่น (พบในตาราง products ${Object.keys(stockMap).length} รุ่น)\n`);

let written = 0;
let skipped = 0;
let quotesWithWarning = 0;

for (const q of quotes as any[]) {
  const snapshots = q.item_details as any[];
  // เรียงตรง index กับ item_details — ตัวเดียวกับที่ enrichQuotationData สร้าง legacyItems
  const itemStock = snapshots.map(it => stockMap[it.model || it.internal_reference] ?? 0);

  // นับใบที่จะมีคำเตือน "สินค้าคงเหลือ" ติดอยู่ถาวรหลังตรึง — ค่าขนส่งไม่นับ (ไม่แสดงคำเตือน)
  const willWarn = snapshots.some((it, i) =>
    it.delivery_source !== 'shipping_fee' && (Number(it.quantity) || 0) > itemStock[i]);
  if (willWarn) quotesWithWarning++;

  const printSnapshot = { item_stock: itemStock, backfilled: true };

  console.log(`${q.quotation_no}  →  [${itemStock.join(', ')}]` +
    `${willWarn ? '  ⚠️ มีคำเตือนสต๊อก' : ''}${q.status !== 'confirmed' ? `  [${q.status}]` : ''}`);

  if (!APPLY) continue;

  const upd = await pool.query(
    `UPDATE quotations SET print_snapshot = $1::jsonb
      WHERE id = $2 AND print_snapshot IS NULL`,
    [JSON.stringify(printSnapshot), q.id]
  );
  if (upd.rowCount === 1) written++;
  else skipped++;  // มีคนยืนยัน/backfill ใบนี้แทรกระหว่างสคริปต์ทำงาน — ของเขาใหม่กว่า ปล่อยไว้
}

console.log('\n── สรุป ──');
console.log(`  ใบที่จะมีคำเตือน "สินค้าคงเหลือ" ติดถาวร: ${quotesWithWarning} ใบ`);
console.log(APPLY
  ? `\n✅ เขียนแล้ว ${written} ใบ${skipped ? ` · ข้าม ${skipped} ใบ (มีค่าอยู่แล้วตอนจะเขียน)` : ''}`
  : `\n(dry-run — ยังไม่เขียนอะไร ใส่ --apply เพื่อเขียนจริง)`);

await pool.end();
