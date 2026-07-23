// ─────────────────────────────────────────────────────────────────────────────
//  ตรวจ contact ที่มีใน sale_orders แต่ไม่มีใน customers (ลูกค้า/ผู้ติดต่อ "หาย")
//  รัน:  npm run diag:orphan-contacts
//        npm run diag:orphan-contacts -- --limit 40
//
//  read-only ทั้งหมด — SELECT อย่างเดียว ไม่เขียน/ไม่แก้อะไรลง DB
//
//  ⚠️ สำคัญ: sale_orders.company_id = บริษัทผู้ขาย (res.company มีแค่ค่า 1/2) ไม่ใช่ลูกค้า
//     คีย์ที่เชื่อม sale_orders ↔ customers ได้จริงคือ contact_id (res_partner id) เท่านั้น
//     + customer_tax_id เป็น fallback หา company — จึงวัด "ลูกค้าหาย" ด้วย contact_id ล้วน
//
//  ให้รัน "ก่อน" แก้เพื่อเห็น gap เป็นตัวเลข แล้วรันซ้ำ "หลัง" full re-sync / backfill เพื่อยืนยันว่าลด
//  ใช้เป็น guard ประจำหลัง sync ด้วย: ถ้าเลขไม่เป็น 0 แปลว่า customer sync ยังกวาดไม่ครบ
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const sampleLimit = Math.max(1, Number(argValue('limit', '20')) || 20);

// ตารางใหญ่ (sale_orders ~366k แถว) — ขยาย timeout เฉพาะ session นี้ และใช้ EXCEPT (hash) แทน NOT EXISTS per-row
const client = await pool.connect();
try {
  await client.query(`SET statement_timeout = '90s'`);
  const q = async (sql: string, params: any[] = []) => (await client.query(sql, params)).rows;

  console.log('=== ตรวจ contact ที่หายจาก customers (วัดด้วย contact_id) ===\n');

  const soDistinct = (await q(`SELECT COUNT(*)::int n FROM (SELECT DISTINCT contact_id FROM sale_orders WHERE contact_id>0) t`))[0].n;
  const cuDistinct = (await q(`SELECT COUNT(*)::int n FROM (SELECT DISTINCT contact_id FROM customers WHERE contact_id>0) t`))[0].n;
  const gap = (await q(`SELECT COUNT(*)::int n FROM (
      SELECT DISTINCT contact_id FROM sale_orders WHERE contact_id>0
      EXCEPT SELECT DISTINCT contact_id FROM customers WHERE contact_id>0) t`))[0].n;

  console.log(`contact_id ใน sale_orders (distinct): ${soDistinct}`);
  console.log(`contact_id ใน customers   (distinct): ${cuDistinct}`);
  console.log(`>> GAP: contact_id มีใน sale_orders แต่ไม่มีใน customers = ${gap}\n`);

  console.log('── แยกสาเหตุ (ด้วย customer_tax_id) ──');
  const buckets = await q(`
    WITH orphan AS (
      SELECT DISTINCT contact_id FROM sale_orders WHERE contact_id>0
      EXCEPT SELECT DISTINCT contact_id FROM customers WHERE contact_id>0)
    SELECT CASE
             WHEN so.customer_tax_id IS NULL OR btrim(so.customer_tax_id)='' THEN 'no_tax_id (มักเป็นบุคคล/ข้อมูลไม่ครบ)'
             WHEN EXISTS (SELECT 1 FROM customers c WHERE c.customer_tax_id = so.customer_tax_id) THEN 'บริษัทมีใน customers แล้ว แต่ contact หาย'
             ELSE 'ทั้งบริษัทไม่มีใน customers' END AS bucket,
           COUNT(DISTINCT so.contact_id)::int AS contacts
    FROM sale_orders so JOIN orphan o ON o.contact_id = so.contact_id
    GROUP BY 1 ORDER BY 2 DESC`);
  for (const r of buckets) console.log(`  ${r.contacts}\t${r.bucket}`);

  const indiv = await q(`
    WITH orphan AS (
      SELECT DISTINCT contact_id FROM sale_orders WHERE contact_id>0
      EXCEPT SELECT DISTINCT contact_id FROM customers WHERE contact_id>0)
    SELECT (btrim(so.customer_name)=btrim(so.contact_name)) AS individual, COUNT(DISTINCT so.contact_id)::int AS contacts
    FROM sale_orders so JOIN orphan o ON o.contact_id=so.contact_id
    WHERE so.customer_name IS NOT NULL AND so.contact_name IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
  console.log('\n── บุคคลธรรมดา (customer_name == contact_name) ──');
  for (const r of indiv) console.log(`  ${r.contacts}\tindividual=${r.individual}`);

  console.log('\n── ช่วง contact_id (ทดสอบว่าเป็น "ข้อมูลใหม่หลัง sync" หรือ "รูโหว่กระจาย") ──');
  const cuRange = (await q(`SELECT MIN(contact_id) mn, MAX(contact_id) mx FROM customers WHERE contact_id>0`))[0];
  const orRange = (await q(`SELECT MIN(contact_id) mn, MAX(contact_id) mx FROM (
      SELECT DISTINCT contact_id FROM sale_orders WHERE contact_id>0
      EXCEPT SELECT DISTINCT contact_id FROM customers WHERE contact_id>0) t`))[0];
  const above = (await q(`SELECT COUNT(*)::int n FROM (
      SELECT DISTINCT contact_id FROM sale_orders WHERE contact_id>0
      EXCEPT SELECT DISTINCT contact_id FROM customers WHERE contact_id>0) t WHERE contact_id > $1`, [cuRange.mx]))[0].n;
  console.log(`  customers contact_id: ${cuRange.mn}..${cuRange.mx} | orphan: ${orRange.mn}..${orRange.mx}`);
  console.log(`  orphan ที่ contact_id > customers.max = ${above}/${gap} (ถ้าน้อย = รูโหว่กระจายจากการกวาดไม่จบ ไม่ใช่แค่ข้อมูลใหม่)`);

  const backfilled = (await q(`SELECT COUNT(*)::int n FROM customers WHERE source_name='saleorder_backfill'`))[0].n;
  console.log(`\nแถวที่ backfill ไว้ (source_name='saleorder_backfill'): ${backfilled}`);

  console.log('\n── sync_state (ดูสุขภาพ customer sync) ──');
  const ss = await q(`SELECT resource, sync_mode, records_synced, last_status, last_run_at,
      left(coalesce(last_error,''),90) AS last_error FROM sync_state ORDER BY resource`);
  for (const r of ss) console.log('  ' + JSON.stringify(r));

  console.log(`\n── ตัวอย่าง orphan สูงสุด ${sampleLimit} ราย ──`);
  const samp = await q(`
    WITH orphan AS (
      SELECT DISTINCT contact_id FROM sale_orders WHERE contact_id>0
      EXCEPT SELECT DISTINCT contact_id FROM customers WHERE contact_id>0)
    SELECT DISTINCT ON (so.contact_id) so.contact_id, so.customer_name, so.contact_name, so.customer_tax_id, so.order_date
    FROM sale_orders so JOIN orphan o ON o.contact_id=so.contact_id
    ORDER BY so.contact_id, so.order_date DESC NULLS LAST
    LIMIT $1`, [sampleLimit]);
  for (const r of samp) console.log(`  contact_id=${r.contact_id} tax=${r.customer_tax_id || '-'} cust="${r.customer_name}" contact="${r.contact_name}"`);
} catch (err: any) {
  console.error('❌ diagnostic failed:', err?.message || err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
