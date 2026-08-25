// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกฎ "ระงับบริษัทที่ไม่มีคำสั่งซื้อมานาน" (credit hold)
//  รัน:  npm run diag:credit-hold
//
//  ✅ อ่านอย่างเดียวทั้งไฟล์ — ไม่เขียน/ไม่ลบอะไรเลย รันกับ production ได้
//
//  ⚠️ last_order_at ไม่ใช่ "วันสั่งซื้อล่าสุด" ตามชื่อ — คือวันบิลล่าสุดของนิติบุคคล และมีค่า
//     เฉพาะลูกค้าเครดิต/เช็คล่วงหน้า (NULL = ไม่เข้าข่ายตรวจ) นิยามเต็มอยู่หัว
//     services/creditHoldService.ts
//
//  ครอบคลุม:
//   1. เกณฑ์โหลดจาก DB ได้และ shape ถูก
//   2. ★ parity: last_order_at ที่คำนวณไว้ใน customers_data_build ต้องตรงกับการคำนวณสด
//      ด้วย db/companyIdentity.ts — นี่คือด่านกันนิยาม "นิติบุคคลเดียวกัน" แตกเป็นสองที่
//      (เทียบทั้งวันบิลและสถานะเครดิต ซึ่งขยายนิติบุคคลด้วยคีย์ชุดเดียวกัน)
//   3. กติกา 3 เคส: ไม่เข้าข่าย = ผ่าน · บิลในเกณฑ์ = ผ่าน · บิลเกินเกณฑ์ = บล็อก
//   4. การขยายนิติบุคคลมีผลจริง (บริษัทที่ซื้อ/ถือเครดิตใต้รหัสสาขาอื่นต้องไม่ถูกนับว่าเงียบ)
//   5. checkCreditHold ประกอบ mode + เกณฑ์ถูกต้อง เทียบกับ SQL ที่คำนวณแยกอิสระ
//   6. findCreditHeldCompanyIds (ยกชุด) ให้คำตอบเดียวกับ checkCreditHold (ทีละราย)
//   7. index ของด่านตรวจยังมี INCLUDE (last_order_at) — กันคนเผลอลบออกแล้วด่านช้าลงเงียบ ๆ
//   8. ค่า customer_payment_terms ทุกค่าใน DB ต้องจัดกลุ่มได้ — ค่าใหม่ที่ Odoo เพิ่มมาแล้ว
//      ไม่เข้าทั้งสองรูปแบบ จะทำให้ลูกค้ากลุ่มนั้นหลุดด่านโดยไม่มีใครรู้
//   9. ลูกค้าเครดิตที่มีใบออกบิลจริง ต้องได้วันที่เสมอ (กันเงื่อนไขเครดิตเขียนกลับด้าน)
//  10. ใบ invoice_status='no' ต้องไม่เคยกลายเป็น last_order_at ของใคร
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

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'ไม่เข้าข่ายตรวจ');

/**
 * "บริษัทนี้เป็นลูกค้าเครดิต/เช็คล่วงหน้าหรือไม่" — ต้องตรงกับ own_credit ใน
 * migrations/schema.sql ทุกอักขระ ถ้าสองที่นี้ไม่ตรงกัน ข้อ 2 (parity) จะแดง
 */
const CREDIT_TERMS_SQL = (col: string) =>
  `(${col} ~ '^[0-9]+ Days$' OR ${col} LIKE 'เช็คล่วงหน้า%')`;

/** ใบที่นับว่า "เป็นเงินแล้ว" — ต้องตรงกับ so_last ใน migrations/schema.sql */
const BILLED_SQL = (alias: string) =>
  `${alias}.invoice_status IN ('invoiced', 'to invoice')`;

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
   -- แยก NULL ออกเป็น 3 สาเหตุ เพื่อให้แน่ใจว่าทุกสาเหตุถูกทดสอบจริง ไม่ใช่สุ่มโดนแต่ Cash
   -- (Cash เป็น 80% ของกลุ่ม NULL ถ้าไม่แยก อีกสองสาเหตุจะไม่เคยถูกแตะเลย)
   (SELECT DISTINCT company_id, last_order_at, 'cash'
      FROM public.customers_data_view c
     WHERE company_id > 0 AND last_order_at IS NULL
       AND NOT ${CREDIT_TERMS_SQL('customer_payment_terms')}
     ORDER BY company_id LIMIT 8)
   UNION ALL
   (SELECT DISTINCT company_id, last_order_at, 'never'
      FROM public.customers_data_view c
     WHERE company_id > 0 AND last_order_at IS NULL
       AND ${CREDIT_TERMS_SQL('customer_payment_terms')}
       AND NOT EXISTS (SELECT 1 FROM public.sale_orders s WHERE s.contact_id = c.contact_id)
     ORDER BY company_id LIMIT 8)
   UNION ALL
   (SELECT DISTINCT company_id, last_order_at, 'nobill'
      FROM public.customers_data_view c
     WHERE company_id > 0 AND last_order_at IS NULL
       AND ${CREDIT_TERMS_SQL('customer_payment_terms')}
       AND EXISTS (SELECT 1 FROM public.sale_orders s WHERE s.contact_id = c.contact_id)
     ORDER BY company_id LIMIT 8)`,
  [MONTHS]
);
const GROUPS = ['recent', 'dormant', 'cash', 'never', 'nobill'] as const;
const GROUP_LABEL: Record<string, string> = {
  recent: 'บิลยังใหม่',
  dormant: 'บิลเกินเกณฑ์',
  cash: 'ไม่ใช่เครดิต',
  never: 'เครดิต·ไม่เคยมีใบ',
  nobill: 'เครดิต·ไม่เคยมีบิล',
};
console.log(`   ตัวอย่างที่ใช้ทดสอบ ${sample.length} บริษัท (` +
  GROUPS.map(g => `${GROUP_LABEL[g]} ${sample.filter(r => r.grp === g).length}`).join(' · ') + ')');
ok('มีตัวอย่างครบทุกกลุ่มในฐานข้อมูลจริง',
  GROUPS.every(g => sample.some(r => r.grp === g)),
  GROUPS.filter(g => !sample.some(r => r.grp === g)).map(g => `ขาด ${GROUP_LABEL[g]}`).join(', '));

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
    SELECT DISTINCT t.contact_id, t.customer_payment_terms
      FROM public.customers_data_view t, me
     WHERE t.company_id = $1 OR ${matchesKeysSql('t', 'me')}
  )
  -- ไม่ใช่ลูกค้าเครดิต → NULL (CASE ครอบ max ทั้งก้อน) · เครดิตแต่ไม่มีใบที่ออกบิล → max() คืน NULL เอง
  SELECT CASE WHEN bool_or(${CREDIT_TERMS_SQL('sib.customer_payment_terms')})
              THEN max(s.order_date) END AS d
    FROM sib
    LEFT JOIN public.sale_orders s
      ON s.contact_id = sib.contact_id AND ${BILLED_SQL('s')}`;

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
ok('ไม่เข้าข่ายตรวจ → ไม่เข้าเกณฑ์ (dormant เป็น NULL ไม่ใช่ true)',
  Number(r3.never_flagged) === 0,
  `last_order_at เป็น NULL ${r3.never_null} ราย = ไม่ใช่เครดิต + ไม่เคยซื้อ + ไม่เคยมีบิล`);
ok('บิลล่าสุดเกินเกณฑ์ → เข้าเกณฑ์ทุกราย', Number(r3.old_but_passed) === 0);
ok('บิลล่าสุดในเกณฑ์ → ไม่เข้าเกณฑ์ทุกราย', Number(r3.recent_but_flagged) === 0);

// ── 4. การขยายนิติบุคคลมีผลจริง ─────────────────────────────────────────
// เทียบ "ดูแค่ company_id ตัวเอง" กับ "ค่าที่ประกาศใน view" — ต้องมีบริษัทที่ต่างกัน
// ถ้าวันไหนตัวเลขนี้เป็น 0 แปลว่าการขยายนิติบุคคลหลุดหายไปจากนิยาม view
//
// ⚠️ ข้อนี้เทียบ "คำนวณสดจาก sale_orders" กับ "ค่าที่แช่ไว้ใน view" ซึ่งเป็นข้อมูลคนละเวลา
//    view ถูก rebuild รอบละ 10 นาที ระหว่างนั้น sale_orders วิ่งไปก่อนได้ ใบสั่งซื้อที่เข้ามา
//    หลัง refreshed_at จึงยังไม่อยู่ใน view เป็นเรื่องปกติ ไม่ใช่ตรรกะพัง
//    → ตัดบริษัทที่ใบล่าสุด "ใหม่กว่า refreshed_at" ออกจากข้อ impossible แล้วรายงานแยก
//    (บั๊กจริงของนิยามจะให้ own.d เก่ากว่า refreshed_at เสมอ จึงยังจับได้อยู่)
//    เคส 2026-08-21: query วิเคราะห์ค้างใน DB ถือ AccessShareLock → refresh ล้ม 30 นาที
//    → ข้อนี้ fail 12 ราย ทั้งที่โค้ดไม่ได้ผิดอะไรเลย
const { rows: expRows } = await pool.query(
  `WITH st AS (SELECT refreshed_at FROM public.customers_data_view_state WHERE id = 1),
   own AS (
     -- "ถ้าดูแค่รหัสบริษัทตัวเอง จะได้ค่าอะไร" — ทั้งวันบิลและสถานะเครดิตไม่ขยายนิติบุคคล
     SELECT c.company_id,
            CASE WHEN bool_or(${CREDIT_TERMS_SQL('c.customer_payment_terms')})
                 THEN max(s.order_date) END AS d
       FROM public.customers_data_view c
       LEFT JOIN public.sale_orders s
         ON s.contact_id = c.contact_id AND ${BILLED_SQL('s')}
      WHERE c.company_id > 0
      GROUP BY c.company_id
   ),
   ent AS (
     SELECT company_id, max(last_order_at) AS d
       FROM public.customers_data_view WHERE company_id > 0 GROUP BY company_id
   )
   SELECT count(*) FILTER (WHERE ent.d > own.d OR (own.d IS NULL AND ent.d IS NOT NULL)) AS rescued,
          count(*) FILTER (WHERE own.d IS NOT NULL AND ent.d < own.d
                             AND own.d <= st.refreshed_at)                               AS impossible,
          count(*) FILTER (WHERE own.d IS NOT NULL AND ent.d < own.d
                             AND own.d >  st.refreshed_at)                               AS stale,
          max(round(extract(epoch FROM now() - st.refreshed_at) / 60))::int              AS refresh_age_min
     FROM own JOIN ent USING (company_id) CROSS JOIN st`
);
ok('การขยายนิติบุคคลช่วยบริษัทที่ซื้อ/ถือเครดิตใต้รหัสสาขาอื่นไว้ได้',
  Number(expRows[0].rescued) > 0, `${expRows[0].rescued} บริษัท`);
ok('ค่าในนิติบุคคลต้องไม่เก่ากว่าค่าของรหัสตัวเอง (ตรรกะกลับด้าน)',
  Number(expRows[0].impossible) === 0);
if (Number(expRows[0].stale) > 0) {
  console.log(
    `      ⓘ view ตามหลัง sale_orders อยู่ ${expRows[0].stale} บริษัท ` +
      `(rebuild ล่าสุดเมื่อ ${expRows[0].refresh_age_min} นาทีที่แล้ว) — ปกติถ้าเพิ่งมีใบเข้ามา ` +
      `แต่ถ้าเกิน 10 นาทีให้ดู log "refresh customers_data_view ล้มเหลว"`
  );
}

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

// ── 8. ค่า customer_payment_terms ทุกค่าต้องจัดกลุ่มได้ ─────────────────
// นี่คือข้อที่กันความพังแบบเงียบที่สุดของกฎนี้: วันหนึ่ง Odoo เพิ่มเงื่อนไขใหม่ที่ไม่เข้า
// ทั้ง '^[0-9]+ Days$' และ 'เช็คล่วงหน้า%' (เช่น '2 Months' / 'เครดิต 30 วัน') ลูกค้ากลุ่มนั้น
// จะกลายเป็น "ไม่ใช่เครดิต" แล้วหลุดด่านทันทีโดยไม่มี error ให้เห็นสักบรรทัด
// ⚠️ ห้ามลบข้อนี้ และห้ามแก้ให้ผ่านด้วยการต่อ pattern มั่ว ๆ — ต้องดูค่าที่โผล่มาก่อน
//    แล้วตัดสินกับผู้ใช้ว่านับเป็นเครดิตไหม จากนั้นแก้ที่ migrations/schema.sql เป็นหลัก
const { rows: termRows } = await pool.query(
  `SELECT customer_payment_terms AS t, count(DISTINCT company_id)::int AS n
     FROM public.customers_data_view
    WHERE customer_payment_terms IS NOT NULL
      AND NOT ${CREDIT_TERMS_SQL('customer_payment_terms')}
      AND customer_payment_terms NOT IN ('Cash', 'Immediate Payment')
    GROUP BY 1 ORDER BY 2 DESC`
);
for (const r of termRows) {
  console.log(`      ✗ พบเงื่อนไขการชำระเงินที่ยังไม่ได้จัดกลุ่ม: "${r.t}" (${r.n} บริษัท)`);
}
ok('เงื่อนไขการชำระเงินทุกค่าใน DB จัดกลุ่มได้ครบ', termRows.length === 0);

// ── 9. ลูกค้าเครดิตที่มีใบออกบิลจริง ต้องได้วันที่เสมอ ──────────────────
// กันเงื่อนไขเครดิตเขียนกลับด้าน (เช่นลืม COALESCE ให้ bool_or แล้ว NULL กลืนทั้งฐาน)
// ซึ่งจะทำให้ด่าน "ไม่บล็อกใครเลย" อย่างเงียบสนิท — ผ่านทุกเทสต์อื่นได้หมด
const { rows: missRows } = await pool.query(
  `SELECT count(*)::int AS n
     FROM public.customers_data_view c
    WHERE c.last_order_at IS NULL
      AND ${CREDIT_TERMS_SQL('c.customer_payment_terms')}
      AND EXISTS (SELECT 1 FROM public.sale_orders s
                   WHERE s.contact_id = c.contact_id AND ${BILLED_SQL('s')})`
);
ok('ลูกค้าเครดิตที่มีใบออกบิลแล้ว ต้องมี last_order_at ทุกราย',
  Number(missRows[0].n) === 0,
  Number(missRows[0].n) ? `← ขาด ${missRows[0].n} แถว เงื่อนไขเครดิตน่าจะกลับด้าน` : '');

// ── 10. ใบ 'no' ต้องไม่เคยกลายเป็น last_order_at ของใคร ─────────────────
// เงื่อนไข NOT EXISTS ตัดเคสบังเอิญ: ใบที่ออกบิลของบริษัทอื่นที่มี order_date ตรงกันเป๊ะ
const { rows: noRows } = await pool.query(
  `SELECT count(*)::int AS n
     FROM public.customers_data_view c
     JOIN public.sale_orders s ON s.contact_id = c.contact_id
    WHERE s.invoice_status = 'no' AND c.last_order_at = s.order_date
      AND NOT EXISTS (SELECT 1 FROM public.sale_orders b
                       WHERE ${BILLED_SQL('b')} AND b.order_date = s.order_date)`
);
ok("ใบที่ยังไม่วางบิล (invoice_status='no') ไม่ถูกนับเป็นวันซื้อล่าสุด",
  Number(noRows[0].n) === 0);

// ── ขอบเขตที่ด่านดูแลอยู่จริง (ข้อมูลประกอบ ไม่ตัดสินผ่าน/ไม่ผ่าน) ──────
const { rows: scopeRows } = await pool.query(
  `SELECT count(*)::int                                                          AS total,
          count(*) FILTER (WHERE d IS NOT NULL)::int                             AS in_scope,
          count(*) FILTER (WHERE d < now() - make_interval(months => $1::int))::int AS flagged
     FROM (SELECT company_id, max(last_order_at) AS d
             FROM public.customers_data_view WHERE company_id > 0 GROUP BY company_id) x`,
  [MONTHS]
);
const sc = scopeRows[0];
console.log(
  `   ขอบเขต: ${sc.total} บริษัท → อยู่ในขอบเขตตรวจ ${sc.in_scope} (ลูกค้าเครดิตที่มีบิลแล้ว) ` +
    `→ เข้าเกณฑ์ ${sc.flagged}`
);

await pool.end();

console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
