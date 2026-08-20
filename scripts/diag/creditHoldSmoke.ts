// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกฎ "ระงับบริษัทที่ไม่มีคำสั่งซื้อมานาน" (credit hold)
//  รัน:  npm run diag:credit-hold
//
//  ✅ อ่านอย่างเดียวทั้งไฟล์ — ไม่เขียน/ไม่ลบอะไรเลย รันกับ production ได้
//
//  ครอบคลุม:
//   1. เกณฑ์โหลดจาก DB ได้และ shape ถูก
//   2. ★ parity: last_order_at ที่คำนวณไว้ใน customers_data_build ต้องตรงกับการคำนวณสด
//      ด้วย db/companyIdentity.ts — นี่คือด่านกันนิยาม "นิติบุคคลเดียวกัน" แตกเป็นสองที่
//   3. กติกา 3 เคส: ไม่เคยซื้อ = ผ่าน · ซื้อในเกณฑ์ = ผ่าน · เงียบเกินเกณฑ์ = บล็อก
//   4. การขยายนิติบุคคลมีผลจริง (บริษัทที่ซื้อใต้รหัสสาขาอื่นต้องไม่ถูกนับว่าเงียบ)
//   5. checkCreditHold ประกอบ mode + เกณฑ์ถูกต้อง เทียบกับ SQL ที่คำนวณแยกอิสระ
//   6. findCreditHeldCompanyIds (ยกชุด) ให้คำตอบเดียวกับ checkCreditHold (ทีละราย)
//   7. index ของด่านตรวจยังมี INCLUDE (last_order_at) — กันคนเผลอลบออกแล้วด่านช้าลงเงียบ ๆ
//
//  ให้รันซ้ำทุกครั้งที่แตะ services/creditHoldService.ts, นิยาม last_order_at ใน
//  migrations/schema.sql หรือ db/companyIdentity.ts
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { companyKeysSql, matchesKeysSql } from '../../db/companyIdentity.js';
import {
  loadCreditPolicy,
  checkCreditHold,
  findCreditHeldCompanyIds,
} from '../../services/creditHoldService.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'ไม่เคยซื้อ');

// ── 1. เกณฑ์ปัจจุบัน ────────────────────────────────────────────────────
const policy = await loadCreditPolicy();
console.log(`   policy: mode=${policy.mode} dormant_months=${policy.dormant_months}`);
ok(
  'โหลดเกณฑ์จาก DB ได้และค่าอยู่ในช่วงที่ใช้ได้',
  ['off', 'warn', 'block'].includes(policy.mode) &&
    Number.isInteger(policy.dormant_months) &&
    policy.dormant_months > 0
);

const MONTHS = policy.dormant_months;

// ── เลือกบริษัทตัวอย่างจากข้อมูลจริง คละ 3 กลุ่ม ────────────────────────
// ORDER BY company_id (ไม่ใช่ random) เพื่อให้รันซ้ำได้ผลเดิม เทียบผลก่อน/หลังแก้โค้ดได้
const { rows: sample } = await pool.query(
  `(SELECT DISTINCT company_id, last_order_at, 'recent' AS grp
      FROM public.customers_data_view
     WHERE company_id > 0 AND last_order_at >= now() - make_interval(months => $1::int)
     ORDER BY company_id LIMIT 15)
   UNION ALL
   (SELECT DISTINCT company_id, last_order_at, 'dormant'
      FROM public.customers_data_view
     WHERE company_id > 0 AND last_order_at < now() - make_interval(months => $1::int)
     ORDER BY company_id LIMIT 15)
   UNION ALL
   (SELECT DISTINCT company_id, last_order_at, 'never'
      FROM public.customers_data_view
     WHERE company_id > 0 AND last_order_at IS NULL
     ORDER BY company_id LIMIT 10)`,
  [MONTHS]
);
console.log(`   ตัวอย่างที่ใช้ทดสอบ ${sample.length} บริษัท` +
  ` (recent/dormant/never = ${sample.filter(r => r.grp === 'recent').length}/` +
  `${sample.filter(r => r.grp === 'dormant').length}/${sample.filter(r => r.grp === 'never').length})`);
ok('มีตัวอย่างครบทั้ง 3 กลุ่มในฐานข้อมูลจริง',
  ['recent', 'dormant', 'never'].every(g => sample.some(r => r.grp === g)));

// ── 2. ★ parity: ค่าที่ precompute ไว้ ต้องตรงกับการคำนวณสดด้วย companyIdentity ──
//
// ถ้าเทสต์ข้อนี้แดง แปลว่านิยาม "นิติบุคคลเดียวกัน" ใน view (migrations/schema.sql)
// กับใน db/companyIdentity.ts ไม่ตรงกันแล้ว — ด่านตรวจกับป้ายเตือนจะเริ่มให้คำตอบคนละอย่าง
// ห้ามแก้เทสต์ให้ผ่าน ต้องไปแก้ให้สองที่นั้นตรงกัน
const LIVE_SQL = `
  WITH me AS (
    SELECT ${companyKeysSql('m')}
      FROM public.customers_data_view m
     WHERE m.company_id = $1
  ),
  sib AS (
    SELECT DISTINCT t.contact_id
      FROM public.customers_data_view t, me
     WHERE t.company_id = $1 OR ${matchesKeysSql('t', 'me')}
  )
  SELECT max(s.order_date) AS d
    FROM sib
    LEFT JOIN public.sale_orders s ON s.contact_id = sib.contact_id`;

let parityChecked = 0;
let parityMismatch = 0;
for (const row of sample) {
  const { rows } = await pool.query(LIVE_SQL, [row.company_id]);
  const live: Date | null = rows[0]?.d ?? null;
  const stored: Date | null = row.last_order_at ?? null;
  const same = (live?.getTime() ?? null) === (stored?.getTime() ?? null);
  parityChecked++;
  if (!same) {
    parityMismatch++;
    console.log(
      `      ✗ company_id=${row.company_id} view=${iso(stored)} แต่คำนวณสด=${iso(live)}`
    );
  }
}
ok(
  `★ parity นิยามนิติบุคคล: view ตรงกับ companyIdentity ทุกราย (${parityChecked} บริษัท)`,
  parityMismatch === 0,
  parityMismatch ? `← ไม่ตรง ${parityMismatch} ราย` : ''
);

// ── 3. กติกา 3 เคส (ระดับ SQL — ไม่ขึ้นกับ mode) ────────────────────────
const { rows: ruleRows } = await pool.query(
  `SELECT count(*) FILTER (WHERE dormant IS NULL AND last_order_at IS NULL)          AS never_null,
          count(*) FILTER (WHERE dormant IS TRUE  AND last_order_at IS NULL)          AS never_flagged,
          count(*) FILTER (WHERE dormant IS FALSE AND last_order_at <  cutoff)        AS old_but_passed,
          count(*) FILTER (WHERE dormant IS TRUE  AND last_order_at >= cutoff)        AS recent_but_flagged
     FROM (
       SELECT max(last_order_at) AS last_order_at,
              max(last_order_at) < now() - make_interval(months => $1::int) AS dormant,
              now() - make_interval(months => $1::int)                      AS cutoff
         FROM public.customers_data_view
        WHERE company_id > 0
        GROUP BY company_id
     ) x`,
  [MONTHS]
);
const r3 = ruleRows[0];
ok('ไม่เคยซื้อ → ไม่เข้าเกณฑ์ (dormant เป็น NULL ไม่ใช่ true)',
  Number(r3.never_flagged) === 0, `never ทั้งหมด ${r3.never_null} ราย`);
ok('ซื้อล่าสุดเกินเกณฑ์ → เข้าเกณฑ์ทุกราย', Number(r3.old_but_passed) === 0);
ok('ซื้อล่าสุดในเกณฑ์ → ไม่เข้าเกณฑ์ทุกราย', Number(r3.recent_but_flagged) === 0);

// ── 4. การขยายนิติบุคคลมีผลจริง ─────────────────────────────────────────
// เทียบ "ดูแค่ company_id ตัวเอง" กับ "ค่าที่ประกาศใน view" — ต้องมีบริษัทที่ต่างกัน
// ถ้าวันไหนตัวเลขนี้เป็น 0 แปลว่าการขยายนิติบุคคลหลุดหายไปจากนิยาม view
const { rows: expRows } = await pool.query(
  `WITH own AS (
     SELECT c.company_id, max(s.order_date) AS d
       FROM public.customers_data_view c
       LEFT JOIN public.sale_orders s ON s.contact_id = c.contact_id
      WHERE c.company_id > 0
      GROUP BY c.company_id
   ),
   ent AS (
     SELECT company_id, max(last_order_at) AS d
       FROM public.customers_data_view WHERE company_id > 0 GROUP BY company_id
   )
   SELECT count(*) FILTER (WHERE ent.d > own.d OR (own.d IS NULL AND ent.d IS NOT NULL)) AS rescued,
          count(*) FILTER (WHERE own.d IS NOT NULL AND ent.d < own.d)                    AS impossible
     FROM own JOIN ent USING (company_id)`
);
ok('การขยายนิติบุคคลช่วยบริษัทที่ซื้อใต้รหัสสาขาอื่นไว้ได้',
  Number(expRows[0].rescued) > 0, `${expRows[0].rescued} บริษัท`);
ok('ค่าในนิติบุคคลต้องไม่เก่ากว่าค่าของรหัสตัวเอง (ตรรกะกลับด้าน)',
  Number(expRows[0].impossible) === 0);

// ── 5. checkCreditHold ประกอบ mode + เกณฑ์ถูกต้อง ───────────────────────
// ยืนยันได้ทุก mode: held ต้องเท่ากับ (mode เป็น block) AND (SQL บอกว่าเงียบเกินเกณฑ์)
let holdMismatch = 0;
for (const row of sample) {
  const result = await checkCreditHold(row.company_id);
  // grp มาจาก query เดียวกับที่ Postgres ใช้ตัดสิน (make_interval) จึงเป็น oracle ที่เชื่อได้
  // — อย่าคำนวณเดือนเป็นมิลลิวินาทีฝั่ง JS มาเทียบ เพราะเดือนยาวไม่เท่ากันจะเพี้ยนที่ขอบ
  const expectHeld = policy.mode === 'block' && row.grp === 'dormant';

  if (result.held !== expectHeld) {
    holdMismatch++;
    console.log(
      `      ✗ company_id=${row.company_id} grp=${row.grp} ซื้อล่าสุด=${iso(row.last_order_at ?? null)} ` +
        `held=${result.held} แต่ควรเป็น ${expectHeld} (mode=${policy.mode})`
    );
  }
}
ok(`checkCreditHold ตรงกับ (mode=block AND เข้าเกณฑ์) ทุกราย [mode ปัจจุบัน=${policy.mode}]`,
  holdMismatch === 0);

if (policy.mode !== 'block') {
  console.log('   ℹ️  mode ไม่ใช่ block → ข้อ 5 ยืนยันว่า "ไม่บล็อกใครเลย" ' +
    '(ตรรกะฝั่งบล็อกถูกครอบด้วยข้อ 3 ที่ตรวจ SQL ตัวเดียวกันอยู่แล้ว)');
}

// ── 6. ยกชุด vs ทีละราย ต้องได้คำตอบเดียวกัน ────────────────────────────
const ids = sample.map((r: any) => Number(r.company_id));
const batch = await findCreditHeldCompanyIds(ids);
let batchMismatch = 0;
for (const id of ids) {
  const single = (await checkCreditHold(id)).held;
  if (single !== batch.has(id)) {
    batchMismatch++;
    console.log(`      ✗ company_id=${id} ทีละราย=${single} ยกชุด=${batch.has(id)}`);
  }
}
ok('findCreditHeldCompanyIds (ยกชุด) = checkCreditHold (ทีละราย)', batchMismatch === 0);

// ── 7. index ของด่านตรวจต้องมี INCLUDE (last_order_at) ──────────────────
// ตรวจจาก catalog ไม่ใช่จาก EXPLAIN โดยตั้งใจ — บนฐานทดสอบที่มีไม่กี่แถว planner จะเลือก
// seq scan เสมอเพราะถูกกว่าจริง ๆ เทสต์ที่ดูแผน query จึงแดงทั้งที่ index ถูกต้อง
// สิ่งที่ต้องกันคือ "มีคนลบ INCLUDE ออก" (สร้างที่ scripts/sync/refreshCustomerDirectory.ts
// และ migrations/schema.sql) ซึ่งดูจาก catalog ได้ตรงกว่าและไม่ขึ้นกับขนาดข้อมูล
const { rows: inclRows } = await pool.query(
  `SELECT a.attname
     FROM pg_index i
     JOIN pg_class c     ON c.oid = i.indexrelid
     JOIN pg_attribute a ON a.attrelid = i.indexrelid AND a.attnum > i.indnkeyatts
    WHERE c.relname = 'idx_cdv_company'`
);
const included = inclRows.map((r: { attname: string }) => r.attname);
ok('idx_cdv_company มี INCLUDE (last_order_at) — ด่านตรวจอ่านจบใน index',
  included.includes('last_order_at'),
  included.includes('last_order_at')
    ? `included = [${included.join(', ')}]`
    : '← index ถูกสร้างใหม่โดยโค้ดที่ยังไม่มี INCLUDE ' +
      '(รอบ sync สร้าง index ทับทุกครั้งที่ rebuild — ถ้า container ที่รันอยู่ยังเป็นเวอร์ชันเก่า ' +
      'จะขึ้นแบบนี้จนกว่าจะ deploy ใหม่) · ด่านยังทำงานถูกต้อง แค่ต้องแตะ heap เพิ่ม');

// แผน query จริงเป็นข้อมูลประกอบ ไม่ตัดสินผ่าน/ไม่ผ่าน (ขึ้นกับขนาดตาราง ณ ตอนรัน)
const { rows: planRows } = await pool.query(
  `EXPLAIN (FORMAT JSON)
   SELECT max(last_order_at) FROM public.customers_data_view WHERE company_id = $1`,
  [ids[0] ?? 1]
);
const planText = JSON.stringify(planRows[0]['QUERY PLAN']);
console.log(`   แผน query ของด่านตรวจ: ${planText.includes('Index Only Scan') ? 'Index Only Scan ✔' : 'ไม่ใช่ index-only (ปกติถ้าตารางเล็ก)'}`);

await pool.end();

console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
