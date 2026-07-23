// ─────────────────────────────────────────────────────────────────────────────
//  Backfill contact ที่มีใน sale_orders แต่ไม่มีใน customers (ลูกค้า/ผู้ติดต่อ "หาย")
//  ใช้เป็น Tier-2 หลังจากทำ full re-sync (npm run sync:customers -- --full) แล้ว
//  เพื่อเก็บเศษที่ customer feed ไม่ได้ส่งออกมา (มักเป็นบุคคลธรรมดา/บริษัทที่ feed ไม่ emit)
//
//  รัน:  npm run backfill:contacts               (dry-run — แค่รายงาน ไม่เขียน)
//        npm run backfill:contacts -- --apply    (เขียนจริง)
//
//  ปลอดภัย: INSERT ... ON CONFLICT DO NOTHING เท่านั้น — ไม่ UPDATE/DELETE แถวเดิม
//  จึง idempotent และไม่ทำลายข้อมูลลูกค้าที่มีอยู่ (รันซ้ำได้)
//
//  ⚠️ sale_orders.company_id = บริษัทผู้ขาย ไม่ใช่ลูกค้า → resolve company_id 2 ชั้น:
//    (4a) ถ้า customer_tax_id ตรงกับบริษัทที่มีใน customers → ใช้ company_id จริงของบริษัทนั้น
//         (contact จะโผล่ใน contacts_view ใต้บริษัทที่ถูกต้อง)
//    (4b) หาไม่ได้ (บุคคลธรรมดา / บริษัทที่ feed ไม่เคยส่ง) → company_id = contact_id
//         (partner id เป็น id space เดียวกัน + unique → ปลอดภัยจากการชน company_id จริง)
//  ทุกแถว mark source_name='saleorder_backfill' เพื่อให้ระบุ/ลบทีหลังได้ และ real sync
//  ในอนาคตจะเขียนทับ marker เป็นค่าจริงเองเมื่อ (company_id, contact_id) ตรงกัน
//
//  Cleanup (รันเมื่อ real sync มาเติมของจริงแล้ว ต้องการลบแถวสังเคราะห์ที่ซ้ำ):
//    DELETE FROM customers t WHERE t.source_name='saleorder_backfill'
//      AND EXISTS (SELECT 1 FROM customers r WHERE r.contact_id=t.contact_id
//                    AND r.company_id<>t.company_id AND r.source_name IS DISTINCT FROM 'saleorder_backfill');
//
//  หมายเหตุ: ใช้ pool เฉพาะของตัวเอง (ไม่ใช่ config/db.ts) เพราะ pool หลักตั้ง
//  query_timeout=15s ฝั่ง client ซึ่งตัด query maintenance ที่กินเวลานาน
// ─────────────────────────────────────────────────────────────────────────────
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const APPLY = process.argv.includes('--apply');

const pool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : undefined,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  statement_timeout: 300000, // 5 นาที — งาน maintenance ตารางใหญ่
  // ตั้งใจไม่ตั้ง query_timeout เพื่อไม่ให้ query ยาว ๆ โดนตัดที่ 15s เหมือน pool หลัก
});

// orphan (by contact_id) + map tax_id→company_id (aggregate ครั้งเดียว) แล้ว LEFT JOIN
// ใช้ hash join แทน correlated subquery ต่อแถว จึงเร็วพอสำหรับ sale_orders 366k แถว
const SOURCE_CTE = `
  WITH orphan AS (
    SELECT DISTINCT contact_id FROM sale_orders WHERE contact_id > 0
    EXCEPT
    SELECT DISTINCT contact_id FROM customers WHERE contact_id > 0
  ),
  tax_map AS (
    SELECT customer_tax_id, MIN(company_id) AS company_id
    FROM customers
    WHERE customer_tax_id IS NOT NULL AND btrim(customer_tax_id) <> ''
    GROUP BY customer_tax_id
  ),
  src AS (
    SELECT DISTINCT ON (so.contact_id)
      COALESCE(tm.company_id, so.contact_id) AS company_id,
      so.contact_id,
      so.customer_name, so.customer_reference, so.customer_tax_id,
      so.contact_name, so.contact_mobile, so.contact_phone, so.customer_sale_area, so.salesperson
    FROM sale_orders so
    JOIN orphan o ON o.contact_id = so.contact_id
    LEFT JOIN tax_map tm
      ON so.customer_tax_id IS NOT NULL AND btrim(so.customer_tax_id) <> ''
     AND tm.customer_tax_id = so.customer_tax_id
    ORDER BY so.contact_id, so.order_date DESC NULLS LAST
  )
`;

async function main() {
  console.log(`โหมด: ${APPLY ? '🟢 APPLY (เขียนจริง)' : '🟡 DRY-RUN (แค่รายงาน ใส่ --apply เพื่อเขียน)'}  DB=${process.env.PG_DATABASE}\n`);

  const { rows: summary } = await pool.query(`
    ${SOURCE_CTE}
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE company_id <> contact_id)::int AS resolved_by_tax,
           COUNT(*) FILTER (WHERE company_id =  contact_id)::int AS synthetic
    FROM src`);
  const s = summary[0];
  console.log(`จะเพิ่ม contact ทั้งหมด: ${s.total}`);
  console.log(`  - ผูกกับบริษัทจริง (match tax_id): ${s.resolved_by_tax}`);
  console.log(`  - ใช้ company_id = contact_id (บุคคล/บริษัทที่ feed ไม่ส่ง): ${s.synthetic}`);

  const { rows: sample } = await pool.query(`
    ${SOURCE_CTE}
    SELECT company_id, contact_id, customer_tax_id, customer_name, contact_name,
           (company_id = contact_id) AS synthetic
    FROM src LIMIT 10`);
  console.log('\nตัวอย่าง 10 แถวแรก:');
  for (const r of sample) {
    console.log(`  company_id=${r.company_id}${r.synthetic ? ' (synthetic)' : ''} contact_id=${r.contact_id} cust="${r.customer_name}" contact="${r.contact_name}"`);
  }

  if (!APPLY) {
    console.log('\n🟡 DRY-RUN: ไม่ได้เขียนอะไร — รันซ้ำด้วย -- --apply เพื่อเขียนจริง');
    return;
  }

  const res = await pool.query(`
    ${SOURCE_CTE}
    INSERT INTO customers (
      company_id, contact_id, customer_name, customer_reference, customer_tax_id,
      contact_name, contact_mobile, contact_phone, customer_sale_area, salesperson,
      source_name, created_at, updated_at)
    SELECT
      company_id, contact_id, customer_name, customer_reference, customer_tax_id,
      contact_name, contact_mobile, contact_phone, customer_sale_area, salesperson,
      'saleorder_backfill', NOW(), NOW()
    FROM src
    ON CONFLICT (company_id, contact_id) DO NOTHING`);
  console.log(`\n✅ เขียนแล้ว: เพิ่ม ${res.rowCount} แถว (ON CONFLICT DO NOTHING — แถวที่มีอยู่แล้วถูกข้าม)`);
  const { rows: after } = await pool.query(`SELECT COUNT(*)::int n FROM customers WHERE source_name='saleorder_backfill'`);
  console.log(`   รวมแถว backfill ในตารางตอนนี้: ${after[0].n}`);
}

main()
  .catch((err) => { console.error('❌ backfill failed:', err?.message || err); process.exitCode = 1; })
  .finally(() => pool.end());
