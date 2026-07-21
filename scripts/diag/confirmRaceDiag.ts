// ─────────────────────────────────────────────────────────────────────────────
//  Reproduce บั๊ก concurrency ตอนยืนยันใบเสนอราคา (แย่ง quotation / เลขซ้ำ / ใบค้าง)
//  รัน:  npm run diag:confirm-race       (ต้องเปิดเซิร์ฟเวอร์ npm run dev ไว้ก่อน)
//
//  ให้รัน "ก่อน" แก้เฟส D เพื่อเห็นบั๊กเป็นตัวเลข แล้วรันซ้ำ "หลัง" แก้เพื่อยืนยันว่าหาย
//  โหมดทดสอบ:
//    A = ยิงยืนยัน 50 ใบพร้อมกัน            → ก่อนแก้: มี HTTP 500 (เลขซ้ำชน unique index)
//    B = ยิงใบเดียวกัน 5 ครั้งพร้อมกัน ×10  → ก่อนแก้: ผลไม่ idempotent
//    C = ยืนยันใบของคนอื่น (userId ผิด)     → ก่อนแก้: 200 (ยืนยันใบคนอื่นได้!) / หลังแก้: 403
//
//  หมายเหตุ: โหมด PUT-vs-confirm race ต้องใช้ "สินค้าจริง" ใน products (ไม่งั้น PUT ตกที่
//  422 validateAndPrepareItems ก่อนถึง UPDATE) จึงทดสอบด้วยมือตามขั้นตอนในแผน (เฟส E)
//  ⚠️ เขียน/ลบข้อมูลจริง — รันกับ dev DB เท่านั้น (สคริปต์จะ abort ถ้าชื่อ DB มีคำว่า prod)
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';

const TAG = 'confirm-race';        // ใบโหมด A/B — คาดหวังว่าถูก confirm ครบ
const TAG_C = 'confirm-race-c';    // ใบโหมด C — ตั้งใจให้โดน 403 ค้างเป็น draft จึงแยกออกจากการตรวจ A2
const PORT = process.env.PORT || 3011;
const BASE = process.env.APP_URL || `http://localhost:${PORT}`;
const USERS = Array.from({ length: 10 }, (_, i) => `Udiagtest${String(i + 1).padStart(4, '0')}`);

type ConfirmResp = { status: number; body: any };

async function confirm(quoteId: string, userId: string): Promise<ConfirmResp> {
  try {
    const resp = await fetch(`${BASE}/api/quotation/${quoteId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const body = await resp.json().catch(() => ({}));
    return { status: resp.status, body };
  } catch (err: any) {
    return { status: 0, body: { error: err?.message || String(err) } };
  }
}

/** INSERT ใบ draft 1 ใบ (snapshot ครบเพื่อให้ enrich short-circuit) คืน id */
async function insertDraft(userId: string, tag: string = TAG): Promise<string> {
  const item = {
    model: 'DIAG-TEST-MODEL',        // ไม่มีใน products → ข้ามเช็คราคาขั้นต่ำ (minPrice=0)
    name: 'สินค้าทดสอบ diag',
    price: 1000,
    quantity: 1,
    discount_1: 0,
    discount_2: 0,
    production: 'Local',             // ไม่ใช่ Import(PM) → prefix = QP
  };
  const customer = { customer_name: 'DIAG ลูกค้าทดสอบ', diag_tag: tag };
  const employee = { name: 'Diag Sales', salesperson_id: 'DIAG01' };
  // created_at เดือนปลอม 2099-12 → เลขที่ออกเป็น key 'QP:9912' ไม่ไปดัน counter เดือนจริง
  const { rows } = await pool.query(
    `INSERT INTO quotations (user_id, status, total_sum, customer_details, item_details, employee_details, created_at)
     VALUES ($1, 'draft', $2, $3, $4, $5, '2099-12-01T00:00:00.000Z') RETURNING id`,
    [userId, 1000, JSON.stringify(customer), JSON.stringify([item]), JSON.stringify(employee)]
  );
  return rows[0].id;
}

async function setup() {
  // salesperson ต้องมีก่อน เพราะ quotations.user_id เป็น FK → salesperson(user_id)
  for (const u of USERS) {
    await pool.query(
      `INSERT INTO salesperson (user_id, salesperson_id) VALUES ($1, 'DIAG01')
       ON CONFLICT (user_id) DO NOTHING`,
      [u]
    );
  }
  const modeA: string[] = [];
  const modeB: string[] = [];
  const modeC: string[] = [];
  for (let i = 0; i < 50; i++) modeA.push(await insertDraft(USERS[i % USERS.length]));
  for (let i = 0; i < 10; i++) modeB.push(await insertDraft(USERS[i % USERS.length]));
  for (let i = 0; i < 2; i++) modeC.push(await insertDraft(USERS[0], TAG_C));
  return { modeA, modeB, modeC };
}

async function teardown() {
  await pool.query(`DELETE FROM quotations WHERE customer_details->>'diag_tag' LIKE 'confirm-race%'`);
  await pool.query(`DELETE FROM salesperson WHERE user_id = ANY($1)`, [USERS]);
  // ลบ counter เดือนปลอมที่ diag สร้างขึ้น เพื่อไม่ให้ค้างในตาราง
  await pool.query(`DELETE FROM quotation_counters WHERE counter_key = 'QP:9912'`);
}

function summarize(label: string, results: ConfirmResp[]) {
  const byStatus: Record<number, number> = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`  ${label}: ` + Object.entries(byStatus).map(([s, n]) => `HTTP ${s}×${n}`).join(', '));
  const err500 = results.filter(r => r.status === 500);
  if (err500.length) console.log(`    ⚠️ 500 ตัวอย่าง: ${err500[0].body?.error || '-'}`);
}

async function assertResults() {
  console.log('\n── ผลตรวจ (SQL) ──');
  // A1: เลขซ้ำ — ตรวจทุกใบ (A/B/C) ไม่ควรมีเลขซ้ำเลย
  const dup = await pool.query(
    `SELECT quotation_no, count(*) AS n FROM quotations
      WHERE customer_details->>'diag_tag' LIKE 'confirm-race%' AND quotation_no IS NOT NULL
      GROUP BY quotation_no HAVING count(*) > 1`
  );
  console.log(`  A1 เลขซ้ำ: ${dup.rowCount} คู่ ${dup.rowCount === 0 ? '✓' : '✗ FAIL'}`);

  // A2: ใบค้าง — ตรวจเฉพาะ A/B (tag = TAG) เพราะ C ตั้งใจให้โดน 403 ค้างเป็น draft
  const stuck = await pool.query(
    `SELECT id, status, quotation_no FROM quotations
      WHERE customer_details->>'diag_tag' = $1
        AND (status <> 'confirmed' OR quotation_no IS NULL)`,
    [TAG]
  );
  console.log(`  A2 ใบค้าง A/B (ไม่ confirmed หรือไม่มีเลข): ${stuck.rowCount} ใบ ${stuck.rowCount === 0 ? '✓' : '✗ FAIL'}`);

  // C: ใบโหมด C ต้องยังเป็น draft ทั้งหมด (โดน 403) = ยืนยันว่า ownership กันได้จริง
  const cStuck = await pool.query(
    `SELECT count(*) AS n FROM quotations
      WHERE customer_details->>'diag_tag' = $1 AND status = 'draft'`,
    [TAG_C]
  );
  console.log(`  C ใบที่ถูกกันไว้ (ยัง draft): ${cStuck.rows[0].n} ใบ ${Number(cStuck.rows[0].n) === 2 ? '✓' : '✗ FAIL'}`);
}

async function main() {
  if ((process.env.PG_DATABASE || '').toLowerCase().includes('prod')) {
    console.error('❌ ปฏิเสธการรัน: PG_DATABASE ดูเหมือน production — สคริปต์นี้เขียน/ลบข้อมูลจริง');
    process.exit(1);
  }
  console.log(`🎯 target: ${BASE}  (DB: ${process.env.PG_DATABASE})`);

  console.log('\n[setup] เตรียม salesperson + ใบ draft ...');
  const { modeA, modeB, modeC } = await setup();
  console.log(`  สร้างใบ draft: A=${modeA.length}, B=${modeB.length}, C=${modeC.length}`);

  try {
    console.log('\n[A] ยืนยัน 50 ใบพร้อมกัน (เลขซ้ำ / pool ตัน)');
    summarize('A', await Promise.all(modeA.map((id, i) => confirm(id, USERS[i % USERS.length]))));

    console.log('\n[B] ยืนยันใบเดียวกัน 5 ครั้งพร้อมกัน × 10 ใบ (idempotency)');
    for (let i = 0; i < modeB.length; i++) {
      const id = modeB[i];
      const owner = USERS[i % USERS.length];
      const res = await Promise.all(Array.from({ length: 5 }, () => confirm(id, owner)));
      const nos = new Set(res.map(r => r.body?.quotation_no).filter(Boolean));
      const okCount = res.filter(r => r.status === 200).length;
      const pass = nos.size <= 1 && okCount === 5;
      console.log(`  ใบ ${i + 1}: success ${okCount}/5, เลขไม่ซ้ำแบบ=${nos.size} ${pass ? '✓' : '✗'}`);
    }

    console.log('\n[C] ยืนยันใบของ user0001 ด้วย userId ผิด (ownership)');
    for (const id of modeC) {
      const res = await confirm(id, USERS[1]); // user0002 ยืนยันใบของ user0001
      const verdict = res.status === 403 ? '✓ 403 (กันได้)' : `✗ HTTP ${res.status} (ยังยืนยันใบคนอื่นได้)`;
      console.log(`  ใบ ${id.slice(0, 8)}…: ${verdict}`);
    }

    await assertResults();
  } finally {
    console.log('\n[teardown] ลบข้อมูลทดสอบ ...');
    await teardown();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  try { await teardown(); await pool.end(); } catch {}
  process.exit(1);
});
