// ─────────────────────────────────────────────────────────────────────────────
//  Backfill quotations.delivery_terms ให้ใบที่ยืนยันไปแล้วก่อนระบบมีคอลัมน์นี้
//
//  รัน:  npm run backfill:delivery-terms                     (dry-run — แค่รายงาน ไม่เขียน)
//        npm run backfill:delivery-terms -- --apply          (เขียนจริง)
//        npm run backfill:delivery-terms -- --include-exported   (รวมใบที่ export ไปแล้วด้วย)
//
//  ⚠️⚠️ ค่าที่ได้เป็นการ "สร้างขึ้นใหม่จากสต๊อกวันที่รันสคริปต์" ไม่ใช่ข้อเท็จจริงของวันออกใบ
//
//      ประเภทการส่ง (In_stock. / Make to order.) ตัดสินจาก "ของพอไหม" ซึ่งไม่มีเก็บไว้ที่ไหนเลย
//      — item_details เก็บแค่ delivery_in_stock_days กับ delivery_out_of_stock_days ไว้ทั้งคู่
//      ตัวเลือกว่าจะหยิบตัวไหนมาใช้มาจาก products.quantity_on_hand_unreserved ตอน render เสมอ
//
//      ใบที่ตอนออกของไม่พอแต่วันนี้ของเข้าแล้ว จะถูกตรึงเป็น In_stock. ทั้งที่ตอนนั้นเป็น
//      Make to order. (เคยวัดแล้วห่างกันได้ถึง 3 วัน vs 180 วัน) เจ้าของงานรับทราบและอนุมัติ
//      ให้ใช้ค่านี้แล้ว เพราะดีกว่าปล่อยช่อง delivery_name/delivery_time ว่างในไฟล์นำเข้า Odoo
//
//      ทุกแถวที่สคริปต์นี้เขียนจะมี "backfilled": true ติดไว้ใน jsonb เพื่อให้แยกออกทีหลังว่า
//      ค่าไหนตรึงมาจากตอนยืนยันจริง (เชื่อถือได้) ค่าไหนมาจากสคริปต์นี้ (ประมาณเอา)
//
//  ปลอดภัย: UPDATE เฉพาะแถวที่ delivery_terms IS NULL เท่านั้น (มีเงื่อนไขซ้ำใน WHERE ของ UPDATE
//  ด้วย กันชนกับการยืนยันใบที่เกิดขึ้นระหว่างสคริปต์ทำงาน) จึง idempotent — รันซ้ำได้ไม่ทับของเดิม
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../config/db.js';
import { resolveQuotationDeliveryDays } from '../services/quotationService.js';
import { resolveDeliveryTerms, deliveryDisplayText } from '../utils/deliveryTerms.js';

const APPLY = process.argv.includes('--apply');
const INCLUDE_EXPORTED = process.argv.includes('--include-exported');

// ขอบเขต = "ใบที่มีเลขที่ใบเสนอราคาแล้ว" ซึ่งเป็นเงื่อนไขเดียวกับค่าตั้งต้นของ endpoint export
// (index.ts: GET /api/admin/quotations/export) ไม่ใช่ status='confirmed'
//
// จงใจไม่กรอง status เพราะใบที่ถูกยกเลิกทีหลัง (revision) ก็ยังมีเลขที่ใบและยังลงไฟล์ export
// ตามกติกาปัจจุบัน — ถ้ากรองทิ้งจะเหลือช่องว่างในไฟล์ทั้งที่ backfill ได้
const conditions = [
  'delivery_terms IS NULL',
  "quotation_no IS NOT NULL AND TRIM(quotation_no) <> ''",
  "jsonb_typeof(item_details) = 'array' AND jsonb_array_length(item_details) > 0",
];
// ค่าตั้งต้นแตะเฉพาะใบที่ยังไม่ได้ส่งออก — ใบที่ export ไปแล้วไม่ได้ประโยชน์จากค่านี้ในไฟล์
// (ได้แค่ทำให้ PDF ที่พิมพ์ซ้ำนิ่งขึ้น) จึงไม่ไปแตะโดยไม่จำเป็น
if (!INCLUDE_EXPORTED) conditions.push('odoo_exported_at IS NULL');

const { rows: quotes } = await pool.query(
  `SELECT id, quotation_no, status, item_details, delivery_days_override, delivery_type_override
     FROM quotations
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC`
);

console.log(`โหมด: ${APPLY ? '🔴 เขียนจริง (--apply)' : '🟢 dry-run (ไม่เขียน)'}` +
  `${INCLUDE_EXPORTED ? ' · รวมใบที่ export แล้ว' : ' · เฉพาะใบที่ยังไม่ export'}`);
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
const byType: Record<string, number> = {};

for (const q of quotes as any[]) {
  const snapshots = q.item_details as any[];
  // items ที่ resolveQuotationDeliveryDays ต้องใช้: quantity + stock (เรียงตรง index กับ snapshot)
  // สร้างจาก item_details ตรง ๆ แทนการเรียก enrichQuotationData() ซึ่งยิงหลาย query ต่อใบ
  const items = snapshots.map(it => ({
    quantity: it.quantity,
    stock: stockMap[it.model || it.internal_reference] ?? 0,
  }));

  const summary = resolveQuotationDeliveryDays(items, snapshots);
  const terms = {
    ...resolveDeliveryTerms({
      delivery_days_auto: summary.days,
      delivery_all_in_stock: summary.all_in_stock,
      delivery_days_override: q.delivery_days_override,
      delivery_type_override: q.delivery_type_override,
    }),
    // ธงบอกว่าค่านี้ประมาณจากสต๊อกวันที่ backfill ไม่ใช่ค่าที่ตรึงตอนยืนยันใบจริง
    backfilled: true,
  };

  byType[terms.type] = (byType[terms.type] || 0) + 1;
  console.log(`${q.quotation_no}  →  ${deliveryDisplayText(terms).padEnd(34)}${q.status !== 'confirmed' ? `  [${q.status}]` : ''}`);

  if (!APPLY) continue;

  const upd = await pool.query(
    `UPDATE quotations SET delivery_terms = $1::jsonb
      WHERE id = $2 AND delivery_terms IS NULL`,
    [JSON.stringify(terms), q.id]
  );
  if (upd.rowCount === 1) written++;
  else skipped++;  // มีคนยืนยัน/backfill ใบนี้แทรกระหว่างสคริปต์ทำงาน — ของเขาใหม่กว่า ปล่อยไว้
}

console.log('\n── สรุป ──');
Object.entries(byType).forEach(([type, n]) => console.log(`  ${type.padEnd(14)} ${n} ใบ`));
console.log(APPLY
  ? `\n✅ เขียนแล้ว ${written} ใบ${skipped ? ` · ข้าม ${skipped} ใบ (มีค่าอยู่แล้วตอนจะเขียน)` : ''}`
  : `\n(dry-run — ยังไม่เขียนอะไร ใส่ --apply เพื่อเขียนจริง)`);

await pool.end();
