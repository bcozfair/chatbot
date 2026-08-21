// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกฎ "ผู้ติดต่อที่ให้เลือก ต้องเป็นของบริษัทที่เซลส์เลือกมาก่อนเสมอ"
//  รัน:  npm run diag:contact-scope
//
//  ✅ อ่านอย่างเดียวทั้งไฟล์ — ไม่เขียน/ไม่ลบอะไรเลย รันกับ production ได้
//
//  ── ที่มา ──
//  getRelatedContactsByCustomerId ดึงผู้ติดต่อของทุก company_id ในนิติบุคคลเดียวกัน (กันทางตัน
//  ตอนคนที่ต้องการอยู่ใต้รหัสสาขาอื่น) แต่เดิมมันขยายทุกครั้งแม้บริษัทที่เซลส์เลือกจะมีคนคนนั้น
//  อยู่แล้ว → ปุ่มชื่อซ้ำจากคนละบริษัทโผล่มาให้กดผิด
//  เคสจริง 2026-08-21 (QT-260805193): ค้น "บริษัท โปรต้าวัน" (มี "คุณเอกชัย" อยู่แล้ว) แต่ได้
//  ปุ่ม "คุณเอกชัย" ของ "บริษัท เอ.เอ็น.เอ็น. เทรดดิ้ง" (เลขภาษีเดียวกัน) มาด้วย แล้วกดผิดใบ
//
//  ครอบคลุม:
//   1. ★ บริษัทที่มีผู้ติดต่อของตัวเอง — รายชื่อที่ให้เลือกต้องไม่มีคนของบริษัทอื่นปนเลย
//      (ยิงกับบริษัทตัวอย่างจากข้อมูลจริงหลายราย ไม่ใช่เคสเดียว)
//   2. ★ กันทางตัน: บริษัทที่ไม่มีผู้ติดต่อของตัวเอง ต้องยังได้ผู้ติดต่อของพี่น้องเหมือนเดิม
//   3. ★ พิมพ์ชื่อคนที่มีเฉพาะในบริษัทพี่น้อง — แยก 2 กรณีให้ชัด:
//        บริษัทที่ค้นตอบได้เอง → ต้องได้ของบริษัทนั้นล้วน (นี่คือเจตนาของกฎ)
//        บริษัทที่ค้นตอบไม่ได้เลย → ต้องได้ของพี่น้อง ห้ามตัน
//   4. เคสจริงของ QT-260805193 — ต้องเหลือปุ่มเดียวและเป็นของบริษัทที่เซลส์ค้น
//   5. ปริมาณผลกระทบทั้งระบบ (รายงานตัวเลข ไม่ใช่เกณฑ์ผ่าน/ไม่ผ่าน)
//
//  ให้รันซ้ำทุกครั้งที่แตะ preferAnchorCompany, findContactCandidates
//  หรือ getRelatedContactsByCustomerId
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { findContactCandidates } from '../../services/customerService.js';
import { getRelatedContactsByCustomerId } from '../../db/repositories.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const otherCompanies = (list: any[], anchor: any) =>
  list.filter((c: any) => String(c.item.company_id) !== String(anchor));

// ── 1. บริษัทที่มีผู้ติดต่อของตัวเอง + มีพี่น้องที่มีผู้ติดต่อด้วย ────────────────────
// นี่คือกลุ่มที่เดิมได้ปุ่มปน (วัดได้ 4,284 จาก 4,946 บริษัทที่มีพี่น้อง)
const { rows: mixed } = await pool.query(
  `WITH comp AS (
     SELECT DISTINCT ON (company_id) company_id, btrim(customer_name) AS nm,
            NULLIF(btrim(customer_tax_id),'') AS tax
       FROM public.customers_data_view WHERE customer_name IS NOT NULL
      ORDER BY company_id, contact_id),
   own AS (
     SELECT company_id, count(*) FILTER (WHERE contact_id > 0) AS n_own
       FROM public.customers_data_view GROUP BY company_id),
   g AS (
     SELECT c.company_id, c.nm, c.tax, coalesce(o.n_own,0) AS n_own
       FROM comp c LEFT JOIN own o ON o.company_id = c.company_id
      WHERE c.tax IS NOT NULL),
   grp AS (
     SELECT tax, sum(n_own) AS tot FROM g GROUP BY tax HAVING count(*) > 1)
   SELECT g.company_id, g.nm, g.n_own, grp.tot - g.n_own AS n_sibling
     FROM g JOIN grp ON grp.tax = g.tax
    WHERE g.n_own > 0 AND grp.tot - g.n_own > 0
    ORDER BY g.company_id
    LIMIT 12`
);

console.log(`── 1. บริษัทที่มีผู้ติดต่อเอง + มีพี่น้องที่มีผู้ติดต่อ (ตัวอย่าง ${mixed.length} ราย) ──`);
let leaked = 0;
for (const c of mixed) {
  const before = await getRelatedContactsByCustomerId(c.company_id);
  const after = await findContactCandidates(c.company_id, '');
  const strays = otherCompanies(after, c.company_id);
  if (strays.length > 0) leaked++;
  const beforeStray = before.filter((r: any) => String(r.company_id) !== String(c.company_id)).length;
  console.log(
    `   ${strays.length === 0 ? '✓' : '✗'} ${String(c.nm).slice(0, 45)} — เดิม ${before.length} คน (ของบริษัทอื่น ${beforeStray}) → ตอนนี้ ${after.length} คน (ของบริษัทอื่น ${strays.length})`
  );
}
ok('ไม่มีผู้ติดต่อของบริษัทอื่นหลุดเข้ารายการเลย', leaked === 0, `หลุด ${leaked}/${mixed.length} ราย`);

// ── 2. กันทางตัน: บริษัทที่ไม่มีผู้ติดต่อของตัวเอง ────────────────────────────────
const { rows: rescue } = await pool.query(
  `WITH comp AS (
     SELECT DISTINCT ON (company_id) company_id, btrim(customer_name) AS nm,
            NULLIF(btrim(customer_tax_id),'') AS tax
       FROM public.customers_data_view WHERE customer_name IS NOT NULL
      ORDER BY company_id, contact_id),
   own AS (
     SELECT company_id, count(*) FILTER (WHERE contact_id > 0) AS n_own
       FROM public.customers_data_view GROUP BY company_id),
   g AS (
     SELECT c.company_id, c.nm, c.tax, coalesce(o.n_own,0) AS n_own
       FROM comp c LEFT JOIN own o ON o.company_id = c.company_id
      WHERE c.tax IS NOT NULL),
   grp AS (SELECT tax, sum(n_own) AS tot FROM g GROUP BY tax HAVING count(*) > 1)
   SELECT g.company_id, g.nm, grp.tot AS n_sibling
     FROM g JOIN grp ON grp.tax = g.tax
    WHERE g.n_own = 0 AND grp.tot > 0
    ORDER BY g.company_id
    LIMIT 8`
);

console.log(`\n── 2. กันทางตัน: บริษัทที่ไม่มีผู้ติดต่อของตัวเอง (ตัวอย่าง ${rescue.length} ราย) ──`);
let deadEnds = 0;
for (const c of rescue) {
  const after = await findContactCandidates(c.company_id, '');
  if (after.length === 0) deadEnds++;
  console.log(`   ${after.length > 0 ? '✓' : '✗'} ${String(c.nm).slice(0, 45)} — ได้ผู้ติดต่อจากพี่น้อง ${after.length} คน`);
}
ok('บริษัทที่ไม่มีผู้ติดต่อเอง ยังได้รายชื่อจากพี่น้อง (ไม่ตัน)', deadEnds === 0, `ตัน ${deadEnds}/${rescue.length} ราย`);

// ── 3. พิมพ์ชื่อคนที่มีเฉพาะในบริษัทพี่น้อง ──────────────────────────────────
// กฎคือ "บริษัทที่เซลส์เลือกมาก่อน" ไม่ใช่ "ต้องคืนคนของพี่น้องเสมอ" — การเทียบชื่อเป็นแบบ
// ยืดหยุ่น (contactNamesMatch/Fuse) ชื่อที่เขียนต่างกันจึงนับเป็นคนเดียวกันได้ เช่นเซลส์พิมพ์
// "คุณวีระพล" แล้วบริษัทที่ค้นมี "คุณวีระพล โอกกระโทก Mb." อยู่แล้ว = ตอบได้เอง
// ไม่ต้องไปหยิบ "คุณวีระพล" ของบริษัทอื่นที่บังเอิญเลขภาษีชนกันมาให้เลือกด้วย
//
// จึงตรวจแยก 2 กรณีตามที่เกิดจริงในแต่ละเคส แทนที่จะบังคับว่าต้องเจอพี่น้องทุกครั้ง
const { rows: onlySibling } = await pool.query(
  `WITH comp AS (
     SELECT DISTINCT ON (company_id) company_id, btrim(customer_name) AS nm,
            NULLIF(btrim(customer_tax_id),'') AS tax
       FROM public.customers_data_view WHERE customer_name IS NOT NULL
      ORDER BY company_id, contact_id)
   SELECT a.company_id AS anchor_id, a.nm AS anchor_nm,
          b.company_id AS sib_id, b.nm AS sib_nm, t.contact_name
     FROM comp a
     JOIN comp b ON b.tax = a.tax AND b.company_id <> a.company_id
     JOIN public.customers_data_view t ON t.company_id = b.company_id AND t.contact_id > 0
    WHERE a.tax IS NOT NULL
      AND NULLIF(btrim(t.contact_name),'') IS NOT NULL
      AND lower(btrim(t.contact_name)) <> 'none'
      AND EXISTS (SELECT 1 FROM public.customers_data_view x
                   WHERE x.company_id = a.company_id AND x.contact_id > 0)
      AND NOT EXISTS (SELECT 1 FROM public.customers_data_view y
                       WHERE y.company_id = a.company_id
                         AND btrim(y.contact_name) = btrim(t.contact_name))
    ORDER BY a.company_id, b.company_id, t.contact_id
    LIMIT 20`
);

console.log(`\n── 3. พิมพ์ชื่อคนที่มีเฉพาะในบริษัทพี่น้อง (ตัวอย่าง ${onlySibling.length} ราย) ──`);
let leakedOnQuery = 0;   // บริษัทที่ค้นตอบได้เอง แต่ยังมีคนของบริษัทอื่นปน
let deadEndOnQuery = 0;  // บริษัทที่ค้นตอบไม่ได้ แล้วไม่ได้ของพี่น้องมาเลย
let nAnswered = 0, nRescued = 0;
for (const c of onlySibling) {
  const res = await findContactCandidates(c.anchor_id, c.contact_name);
  const anchorHits = res.filter((r: any) => String(r.item.company_id) === String(c.anchor_id));
  const strays = otherCompanies(res, c.anchor_id);

  if (anchorHits.length > 0) {
    nAnswered++;
    if (strays.length > 0) leakedOnQuery++;
    console.log(
      `   ${strays.length === 0 ? '✓' : '✗'} [บริษัทที่ค้นตอบได้เอง] "${c.contact_name}" ใต้ ${String(c.anchor_nm).slice(0, 28)} → ได้ "${anchorHits[0].item.name}" ของบริษัทเดียวกัน (คนของบริษัทอื่นที่ปนมา ${strays.length})`
    );
  } else {
    nRescued++;
    const found = res.some((r: any) => String(r.item.company_id) === String(c.sib_id));
    if (!found) deadEndOnQuery++;
    console.log(
      `   ${found ? '✓' : '✗'} [บริษัทที่ค้นตอบไม่ได้] "${c.contact_name}" ใต้ ${String(c.anchor_nm).slice(0, 28)} → ${found ? 'ได้คนของ ' + String(c.sib_nm).slice(0, 28) : 'ตัน!'} (${res.length} ตัวเลือก)`
    );
  }
}
ok(
  'บริษัทที่ค้นตอบได้เอง → ไม่มีคนของบริษัทอื่นปนเข้ามา',
  leakedOnQuery === 0,
  `${nAnswered} เคส · ปน ${leakedOnQuery}`
);
ok(
  'บริษัทที่ค้นตอบไม่ได้ → ยังได้คนของพี่น้อง (ไม่ตัน)',
  deadEndOnQuery === 0,
  `${nRescued} เคส · ตัน ${deadEndOnQuery}`
);

// ── 4. เคสจริงของ QT-260805193 ────────────────────────────────────────────
const { rows: anchorRow } = await pool.query(
  `SELECT company_id, customer_name FROM public.customers_data_view
    WHERE btrim(customer_reference) = 'A/35080' ORDER BY company_id, contact_id LIMIT 1`
);
console.log('\n── 4. เคสจริง QT-260805193 ──');
if (anchorRow.length === 0) {
  console.log('   ⏭  ไม่พบบริษัท A/35080 ในฐานข้อมูลแล้ว — ข้าม');
} else {
  const anchorId = anchorRow[0].company_id;
  const before = await getRelatedContactsByCustomerId(anchorId);
  const after = await findContactCandidates(anchorId, '');
  console.log(`   บริษัทที่เซลส์ค้น: ${anchorRow[0].customer_name} (${anchorId})`);
  for (const r of before) {
    console.log(`     เดิมมีปุ่ม: "${r.name}" · company_id=${r.company_id}${String(r.company_id) === String(anchorId) ? '' : '  ← คนละบริษัท'}`);
  }
  for (const r of after) {
    console.log(`     ตอนนี้เหลือ: "${r.item.name}" · company_id=${r.item.company_id}`);
  }
  ok(
    'เหลือเฉพาะผู้ติดต่อของบริษัทที่เซลส์ค้น (A/35080)',
    after.length > 0 && otherCompanies(after, anchorId).length === 0,
    `เดิม ${before.length} ปุ่ม → ${after.length} ปุ่ม`
  );
}

// ── 5. ปริมาณผลกระทบทั้งระบบ ──────────────────────────────────────────────
const { rows: impact } = await pool.query(
  `WITH comp AS (
     SELECT DISTINCT ON (company_id) company_id, NULLIF(btrim(customer_tax_id),'') AS tax
       FROM public.customers_data_view WHERE customer_name IS NOT NULL
      ORDER BY company_id, contact_id),
   own AS (
     SELECT company_id, count(*) FILTER (WHERE contact_id > 0) AS n_own
       FROM public.customers_data_view GROUP BY company_id),
   g AS (
     SELECT c.company_id, c.tax, coalesce(o.n_own,0) AS n_own
       FROM comp c LEFT JOIN own o ON o.company_id = c.company_id WHERE c.tax IS NOT NULL),
   grp AS (SELECT tax, sum(n_own) AS tot FROM g GROUP BY tax HAVING count(*) > 1)
   SELECT count(*) AS with_siblings,
          count(*) FILTER (WHERE g.n_own > 0 AND grp.tot - g.n_own > 0) AS cleaned_up,
          count(*) FILTER (WHERE g.n_own = 0 AND grp.tot > 0)           AS still_rescued
     FROM g JOIN grp ON grp.tax = g.tax`
);
const i = impact[0];
console.log(
  `\n── 5. ผลกระทบทั้งระบบ ──\n   บริษัทที่มีพี่น้อง ${i.with_siblings} ราย · รายการสะอาดขึ้น ${i.cleaned_up} ราย · ยังพึ่งการขยายอยู่ ${i.still_rescued} ราย`
);

console.log(`\n${failures === 0 ? '✅ ผ่านทั้งหมด' : `❌ ล้มเหลว ${failures} ข้อ`}`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
