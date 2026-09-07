// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกลไก "กันส่งออกซ้ำ" ของ export Odoo
//  รัน:  npm run diag:export-tracking
//        npm run diag:export-tracking -- --limit 50
//        npm run diag:export-tracking -- --company qt   (ตั้งต้น qp)
//
//  ⚠️ สคริปต์นี้ "เขียน" DB จริง (ต่างจาก diag:odoo-export ที่ read-only ล้วน) แต่ทำงานทั้งหมด
//     ในทรานแซกชันเดียวแล้ว ROLLBACK ตอนจบเสมอ — รวมถึงตอน assert ไม่ผ่านหรือ throw
//     จึงไม่ทิ้งร่องรอยลง DB ห้ามเปลี่ยนเป็น COMMIT เด็ดขาด
//
//  ครอบคลุม: จองใบ (claim) ได้เฉพาะใบที่ยังไม่ถูกมาร์ก · จองซ้ำครั้งที่สองได้ 0 ใบ (= กันส่งออกซ้ำ)
//            ใบไม่มีรายการสินค้าไม่ถูกมาร์กและไม่ลงไฟล์ · exported=yes/all ยังส่งซ้ำได้
//            ใบของอีกบริษัท/เลขไม่ขึ้นต้น QP-QT ไม่ถูกมาร์กและไม่ลงไฟล์
//            จำนวนใน log/batch ตรงกับใบที่ลงไฟล์จริง · un-mark รายใบและทั้งชุดคืนสถานะครบ
//  ให้รันซ้ำทุกครั้งที่แตะ endpoint export, ตัวกรอง exported หรือฟังก์ชัน claim/unmark ใน repositories
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  claimQuotationsForExport,
  insertExportBatch,
  insertExportLogRows,
  unmarkQuotationExport,
  unmarkExportBatch,
  exportedFilterCondition,
  parseExportedFilter,
} from '../../db/repositories.js';
import {
  buildOdooSaleOrderRows,
  selectExportableQuotes,
  loadOdooExportConfig,
  parseExportCompany,
  resolveExportCompany,
} from '../../services/odooSaleOrderExport.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const limit = Math.max(1, Number(argValue('limit', '30')) || 30);
// บริษัทที่จำลองการกดส่งออก — ชุดทดสอบยังดึงใบมาปนทั้ง QP/QT เพื่อพิสูจน์ว่าใบของอีกบริษัทไม่ถูกมาร์ก
const company = parseExportCompany(argValue('company', 'qp'));
if (!company) {
  console.log('✗ FAIL  --company รับได้แค่ qp หรือ qt');
  await pool.end();
  process.exit(1);
}

// ── 0. เงื่อนไข WHERE ของตัวกรอง (ตรวจแบบ pure ไม่แตะ DB) ────────────────
ok('exported=no  → กรองเฉพาะใบที่ยังไม่มี odoo_exported_at',
  exportedFilterCondition('no') === 'q.odoo_exported_at IS NULL');
ok('exported=yes → กรองเฉพาะใบที่มี odoo_exported_at แล้ว',
  exportedFilterCondition('yes') === 'q.odoo_exported_at IS NOT NULL');
ok('exported=all → ไม่ใส่เงื่อนไข', exportedFilterCondition('all') === '');
ok('exported=pending → ส่งออกแล้วแต่ยังไม่เห็นใน Odoo (ต้องมีทั้งสองเงื่อนไข ไม่งั้นใบที่ยังไม่ส่งออกติดมาด้วย)',
  exportedFilterCondition('pending') === 'q.odoo_exported_at IS NOT NULL AND q.odoo_imported_at IS NULL');
ok('exported=imported → กรองเฉพาะใบที่มี odoo_imported_at แล้ว',
  exportedFilterCondition('imported') === 'q.odoo_imported_at IS NOT NULL');
ok('param ที่ไม่รู้จักตกเป็นค่า fallback ที่ผู้เรียกกำหนด',
  parseExportedFilter('อะไรก็ไม่รู้', 'no') === 'no' && parseExportedFilter(undefined, 'all') === 'all');
ok('param ที่ถูกต้องถูกรับตามนั้น (ไม่แคร์ตัวพิมพ์/ช่องว่าง)',
  parseExportedFilter(' YES ', 'no') === 'yes');

const client = await pool.connect();
try {
  await client.query('BEGIN');

  const config = loadOdooExportConfig();

  // ── 1. เตรียมชุดทดสอบ: ใบจริงที่มีเลขที่ใบเสนอราคา ────────────────────
  // ล้างเครื่องหมายของชุดนี้ก่อน (ยัง ROLLBACK อยู่ดี) เพื่อให้จุดตั้งต้นเหมือนกันทุกครั้งที่รัน
  // ไม่งั้นผลจะผันไปตามว่าแอดมินเพิ่งกดส่งออกอะไรไปบ้าง
  const { rows: sample } = await client.query(
    `SELECT q.id, q.quotation_no, q.item_details
       FROM quotations q
      WHERE q.quotation_no IS NOT NULL AND TRIM(q.quotation_no) <> ''
      ORDER BY q.created_at DESC
      LIMIT $1`, [limit]);

  if (sample.length === 0) {
    console.log('⚠️  ไม่มีใบเสนอราคาที่มีเลขที่ให้ตรวจ — ใส่ข้อมูลทดสอบก่อน');
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
    process.exit(0);
  }

  const sampleIds = sample.map((r: any) => String(r.id));
  await client.query(
    `UPDATE quotations SET odoo_exported_at = NULL WHERE id = ANY($1::uuid[])`, [sampleIds]);

  const exportable = selectExportableQuotes(sample, company);
  // ใบที่ตกรอบมี 2 เหตุ: ไม่มีรายการสินค้า กับเป็นของอีกบริษัท/เลขไม่ขึ้นต้นด้วย QP-QT
  const withoutItems = sample.filter((q: any) =>
    !Array.isArray(q.item_details) || q.item_details.length === 0).length;
  const otherCompany = sample.length - exportable.length - withoutItems;
  console.log(`   ชุดทดสอบ ${sample.length} ใบ (บริษัท ${company} ที่ลงไฟล์ได้ ${exportable.length} ใบ, ` +
    `ไม่มีรายการสินค้า ${withoutItems} ใบ, คนละบริษัท/ไม่มีคำนำหน้า ${otherCompany} ใบ)`);

  if (exportable.length === 0) {
    console.log(`⚠️  ไม่มีใบ ${company} ที่มีรายการสินค้าในชุดทดสอบ — เพิ่ม --limit หรือสลับ --company`);
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
    process.exit(0);
  }

  // ── 2. รอบแรก: จองใบทั้งหมดที่ลงไฟล์ได้ ───────────────────────────────
  const claimed1 = await claimQuotationsForExport(client, exportable.map((q: any) => String(q.id)), true);
  ok('รอบแรกจองได้ครบทุกใบที่ลงไฟล์ได้', claimed1.length === exportable.length,
    `(ได้ ${claimed1.length} / คาด ${exportable.length})`);

  const claimedSet = new Set(claimed1);
  const emitted = exportable.filter((q: any) => claimedSet.has(String(q.id)));
  const rows = buildOdooSaleOrderRows(emitted, config, company);
  ok('ทุกใบที่จองได้ลงไฟล์จริง (มีอย่างน้อย 1 แถวต่อใบ)', rows.length >= emitted.length,
    `(${rows.length} แถว / ${emitted.length} ใบ)`);
  ok(`ทุกใบที่จองได้เป็นบริษัท ${company}`,
    emitted.every((q: any) => resolveExportCompany(q.quotation_no) === company));
  ok(`ทุกแถวใช้ชื่อภาษีของบริษัท ${company}`,
    rows.every(r => r.tax_id === config.taxByCompany[company]),
    `("${config.taxByCompany[company]}")`);

  // ── 2.1 ใบของอีกบริษัท/ไม่มีคำนำหน้าต้องไม่ถูกมาร์ก ───────────────────
  // เหตุผลเดียวกับใบที่ไม่มีรายการสินค้า: มาร์กใบที่ไม่ได้อยู่ในไฟล์ = ใบนั้นหายจาก export ตลอดกาล
  const foreignIds = sample
    .filter((q: any) => Array.isArray(q.item_details) && q.item_details.length > 0
      && resolveExportCompany(q.quotation_no) !== company)
    .map((q: any) => String(q.id));
  if (foreignIds.length > 0) {
    const { rows: foreignNull } = await client.query(
      `SELECT COUNT(*)::int AS n FROM quotations WHERE id = ANY($1::uuid[]) AND odoo_exported_at IS NULL`,
      [foreignIds]);
    ok('ใบของอีกบริษัท/ไม่มีคำนำหน้า ไม่ถูกมาร์กว่าส่งออกแล้ว', foreignNull[0].n === foreignIds.length,
      `(ยังไม่ถูกมาร์ก ${foreignNull[0].n} / ${foreignIds.length})`);
  } else {
    console.log('   ℹ️  ชุดทดสอบไม่มีใบของอีกบริษัท — ข้ามการตรวจข้อนี้ (เพิ่ม --limit ให้เห็นทั้งสองบริษัท)');
  }

  // ── 3. ใบไม่มีรายการสินค้าต้องไม่ถูกมาร์ก ─────────────────────────────
  // ถ้าเผลอมาร์ก ใบพวกนี้จะหายจาก export ตลอดกาลทั้งที่ไม่เคยอยู่ในไฟล์เลยสักครั้ง
  if (withoutItems > 0) {
    const emptyIds = sample
      .filter((q: any) => !Array.isArray(q.item_details) || q.item_details.length === 0)
      .map((q: any) => String(q.id));
    const { rows: stillNull } = await client.query(
      `SELECT COUNT(*)::int AS n FROM quotations WHERE id = ANY($1::uuid[]) AND odoo_exported_at IS NULL`,
      [emptyIds]);
    ok('ใบที่ไม่มีรายการสินค้าไม่ถูกมาร์กว่าส่งออกแล้ว', stillNull[0].n === emptyIds.length,
      `(ยังไม่ถูกมาร์ก ${stillNull[0].n} / ${emptyIds.length})`);
  } else {
    console.log('   ℹ️  ชุดทดสอบไม่มีใบที่ไม่มีรายการสินค้า — ข้ามการตรวจข้อนี้');
  }

  // ── 4. บันทึกประวัติแล้วเทียบจำนวน ────────────────────────────────────
  const batchId = await insertExportBatch(client, {
    adminId: null, adminUsername: 'diag:export-tracking', format: 'xlsx',
    quotationCount: emitted.length, rowCount: rows.length,
    filters: { company, exported: 'no', source: 'diag' },
  });
  await insertExportLogRows(client, batchId, emitted.map((q: any) => ({
    id: String(q.id), quotation_no: q.quotation_no ?? null,
  })));

  const { rows: logCount } = await client.query(
    `SELECT COUNT(*)::int AS n FROM quotation_export_log WHERE batch_id = $1::uuid`, [batchId]);
  ok('จำนวนแถวใน log = จำนวนใบที่ลงไฟล์', logCount[0].n === emitted.length,
    `(log ${logCount[0].n} / ใบ ${emitted.length})`);

  const { rows: batchRow } = await client.query(
    `SELECT quotation_count, row_count FROM quotation_export_batches WHERE id = $1::uuid`, [batchId]);
  ok('ตัวเลขในหัวชุดตรงกับที่ลงไฟล์จริง',
    batchRow[0].quotation_count === emitted.length && batchRow[0].row_count === rows.length,
    `(${batchRow[0].quotation_count} ใบ / ${batchRow[0].row_count} แถว)`);

  // ── 5. รอบสอง: กดส่งออกซ้ำทันที = ต้องไม่ได้ใบไหนเลย ← หัวใจของฟีเจอร์ ──
  const claimed2 = await claimQuotationsForExport(client, exportable.map((q: any) => String(q.id)), true);
  ok('จองรอบสองด้วย exported=no ได้ 0 ใบ (กันส่งออกซ้ำ)', claimed2.length === 0,
    `(ได้ ${claimed2.length} ใบ)`);
  ok('ไฟล์รอบสองว่างเปล่า', buildOdooSaleOrderRows(
    exportable.filter((q: any) => new Set(claimed2).has(String(q.id))), config, company).length === 0);

  // ── 6. exported=yes/all ยังส่งซ้ำได้ (ทางออกฉุกเฉินต้องใช้งานได้จริง) ──
  const claimed3 = await claimQuotationsForExport(client, exportable.map((q: any) => String(q.id)), false);
  ok('จองแบบไม่ใส่ guard (exported=yes/all) ได้ใบเดิมครบ ส่งซ้ำได้',
    claimed3.length === exportable.length, `(ได้ ${claimed3.length} / คาด ${exportable.length})`);

  // ── 7. un-mark รายใบ ──────────────────────────────────────────────────
  const oneId = String(emitted[0].id);
  const unmarked = await unmarkQuotationExport(client, oneId);
  ok('un-mark รายใบคืนค่า true', unmarked);

  const { rows: afterOne } = await client.query(
    `SELECT odoo_exported_at FROM quotations WHERE id = $1::uuid`, [oneId]);
  ok('ใบที่ถูก un-mark กลับเป็นยังไม่ส่งออก', afterOne[0].odoo_exported_at === null);

  const { rows: revertedLog } = await client.query(
    `SELECT COUNT(*)::int AS n FROM quotation_export_log
      WHERE quotation_id = $1::uuid AND reverted_at IS NOT NULL`, [oneId]);
  ok('log ของใบนั้นถูกประทับ reverted_at (ไม่ถูกลบทิ้ง)', revertedLog[0].n > 0);

  ok('un-mark ซ้ำใบเดิมคืนค่า false (ไม่ถูกมาร์กอยู่แล้ว)',
    (await unmarkQuotationExport(client, oneId)) === false);

  // ใบที่ถูก un-mark ต้องกลับเข้าคิว exported=no
  const { rows: backInQueue } = await client.query(
    `SELECT COUNT(*)::int AS n FROM quotations q WHERE q.id = $1::uuid AND ${exportedFilterCondition('no')}`,
    [oneId]);
  ok('ใบที่ถูก un-mark กลับมาอยู่ในตัวกรอง "ยังไม่ส่งออก"', backInQueue[0].n === 1);

  // ── 8. un-mark ทั้งชุด ────────────────────────────────────────────────
  const revertedCount = await unmarkExportBatch(client, batchId);
  // ใบแรกถูกถอยไปแล้วในข้อ 7 จึงเหลือให้ถอยอีก emitted.length - 1
  ok('un-mark ทั้งชุดถอยใบที่เหลือครบ', revertedCount === emitted.length - 1,
    `(ถอย ${revertedCount} / คาด ${emitted.length - 1})`);

  const { rows: allNull } = await client.query(
    `SELECT COUNT(*)::int AS n FROM quotations
      WHERE id = ANY($1::uuid[]) AND odoo_exported_at IS NOT NULL`,
    [emitted.map((q: any) => String(q.id))]);
  ok('ไม่เหลือใบไหนในชุดที่ยังถูกมาร์กว่าส่งออกแล้ว', allNull[0].n === 0, `(เหลือ ${allNull[0].n} ใบ)`);

  ok('un-mark ทั้งชุดซ้ำได้ 0 ใบ (idempotent)',
    (await unmarkExportBatch(client, batchId)) === 0);
} finally {
  // ROLLBACK เสมอ — สคริปต์นี้ต้องไม่ทิ้งอะไรไว้ใน DB
  await client.query('ROLLBACK');
  client.release();
}

console.log(failures === 0 ? '\nผ่านทั้งหมด' : `\nไม่ผ่าน ${failures} ข้อ`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
