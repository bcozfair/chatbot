// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของกฎ "ชื่อบริษัทต้องมาจากแถวเดียวกับรหัสลูกค้า/เลขภาษี"
//  รัน:  npm run diag:company-name
//
//  ⚠️ ข้อ 3–4 สร้างใบเสนอราคาชั่วคราวของตัวเอง (status='draft', user_id = NULL) แล้วลบทิ้งเสมอ
//     — ไม่แตะใบของเซลส์ ไม่แตะตารางลูกค้า · ส่วนข้อ 1–2 อ่านอย่างเดียว
//
//  ── ที่มา ──
//  รายชื่อผู้ติดต่อค้นข้ามนิติบุคคล (getRelatedContactsByCustomerId) การกดเลือกผู้ติดต่อ
//  จึงเป็นการเลือกบริษัทไปในตัว ใบต้องย้ายไปผูกบริษัทของคนที่เลือก แต่ "ชื่อบริษัท" เดิม
//  ถูกคัดลอกมาจากชื่อที่เซลส์ค้นตอนแรก ทำให้ชื่อกับรหัสเป็นคนละบริษัทได้
//  เคสจริง 2026-08-21 (QT-260805193): ค้น "บริษัท โปรต้าวัน" (A/35080) กดปุ่ม "คุณเอกชัย"
//  ที่อยู่ใต้ "บริษัท เอ.เอ็น.เอ็น. เทรดดิ้ง" (A/32533) → ใบได้ชื่อโปรต้าวัน คู่รหัส A/32533
//
//  ครอบคลุม:
//   1. หาคู่บริษัทพี่น้องที่ "ชื่อคนซ้ำกันข้ามนิติบุคคล" จากข้อมูลจริง = เคสที่ทำให้พลาดได้
//   2. audit ใบทั้งระบบ: ชื่อบริษัทใน snapshot ต้องตรงกับชื่อของคู่ (customer_id, contact_id)
//   3. updateQuotationCustomerSnapshot — ป้อนชื่อบริษัทผิดเข้าไป ต้องถูกแก้เป็นชื่อจริง
//   4. insertDraftQuotations — ป้อนชื่อบริษัทผิดเข้าไป ต้องถูกแก้เป็นชื่อจริง
//
//  ให้รันซ้ำทุกครั้งที่แตะ companyNameOfRow, updateQuotationCustomerSnapshot,
//  insertDraftQuotations หรือ handlers/lineHandler.ts §select_contact
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  updateQuotationCustomerSnapshot,
  insertDraftQuotations,
  companyNameOfRow,
} from '../../services/quotationService.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// ── 1. หาเคสจริง: ผู้ติดต่อชื่อเดียวกันอยู่ใต้สองนิติบุคคลที่ "ชื่อบริษัทต่างกัน" ────────
// ORDER BY แบบคงที่ (ไม่ random) เพื่อให้รันซ้ำได้ผลเดิม เทียบก่อน/หลังแก้โค้ดได้
const { rows: pairs } = await pool.query(
  `SELECT a.company_id AS a_id, a.contact_id AS a_contact,
          a.customer_name AS a_name, a.customer_reference AS a_ref,
          b.company_id AS b_id, b.customer_name AS b_name, b.customer_reference AS b_ref,
          a.contact_name
     FROM public.customers_data_view a
     JOIN public.customers_data_view b
       ON b.customer_tax_id = a.customer_tax_id
      AND b.company_id <> a.company_id
      AND btrim(b.contact_name) = btrim(a.contact_name)
      AND btrim(b.customer_name) <> btrim(a.customer_name)
    WHERE a.contact_id > 0
      AND NULLIF(btrim(a.customer_tax_id), '') IS NOT NULL
      AND NULLIF(btrim(a.contact_name), '') IS NOT NULL
      AND lower(btrim(a.contact_name)) <> 'none'
      AND NULLIF(btrim(a.customer_name), '') IS NOT NULL
    ORDER BY a.company_id, a.contact_id, b.company_id
    LIMIT 5`
);

ok(
  'มีเคสจริงให้ทดสอบ (ผู้ติดต่อชื่อซ้ำข้ามนิติบุคคลที่ชื่อบริษัทต่างกัน)',
  pairs.length > 0,
  `พบ ${pairs.length} คู่`
);
for (const p of pairs) {
  console.log(
    `   "${p.contact_name}" → ${p.a_name} (${p.a_ref}) | ${p.b_name} (${p.b_ref})`
  );
}

// ── 2. audit ใบทั้งระบบ ────────────────────────────────────────────────────
// ใบที่ผูกคู่ (customer_id, contact_id) ไว้แล้ว ชื่อใน snapshot ต้องตรงกับชื่อของคู่นั้น
//
// ยกเว้นใบที่ Odoo แก้ชื่อบริษัททีหลัง — snapshot ของใบที่ยืนยันแล้วต้องคงเดิมตามหลัก
// snapshot จึงนับเฉพาะใบที่ "รหัสลูกค้าตรงแต่ชื่อไม่ตรง" ว่าเป็นการสะกดที่เปลี่ยนไป
// ส่วนที่ผิดจริงคือใบที่ชื่อไปตรงกับ *บริษัทอื่น* ที่ไม่ใช่บริษัทที่ใบผูกอยู่
const { rows: audit } = await pool.query(
  `SELECT q.quotation_no, q.created_at, q.customer_id, q.contact_id,
          q.customer_details->>'customer_name' AS snap_name,
          q.customer_details->>'customer_code' AS snap_code,
          v.customer_name AS true_name, v.customer_reference AS true_ref,
          EXISTS (SELECT 1 FROM public.customers_data_view o
                   WHERE btrim(o.customer_name) = btrim(q.customer_details->>'customer_name')
                     AND o.company_id <> q.customer_id) AS name_is_another_company
     FROM public.quotations q
     JOIN public.customers_data_view v
       ON v.company_id = q.customer_id AND v.contact_id = q.contact_id
    WHERE q.contact_id IS NOT NULL
      AND NULLIF(btrim(coalesce(q.customer_details->>'customer_name','')), '') IS NOT NULL
      AND btrim(q.customer_details->>'customer_name') IS DISTINCT FROM btrim(v.customer_name)
    ORDER BY q.created_at`
);

const crossCompany = audit.filter((r: any) => r.name_is_another_company);
const renamed = audit.filter((r: any) => !r.name_is_another_company);

ok(
  'ไม่มีใบที่ชื่อบริษัทเป็นของ "บริษัทอื่น" ที่ใบไม่ได้ผูกอยู่',
  crossCompany.length === 0,
  `เจอ ${crossCompany.length} ใบ`
);
for (const r of crossCompany) {
  console.log(
    `   ✗ ${r.quotation_no} (${String(r.created_at).slice(0, 10)}) snapshot="${r.snap_name}" (${r.snap_code}) แต่ผูกกับ "${r.true_name}" (${r.true_ref})`
  );
}
if (renamed.length > 0) {
  console.log(`   ℹ️  ${renamed.length} ใบชื่อต่างจากปัจจุบันแต่รหัสยังเป็นบริษัทเดียวกัน (Odoo แก้สะกดทีหลัง — snapshot ถูกต้องตามหลักการ):`);
  for (const r of renamed) {
    console.log(`      ${r.quotation_no} "${r.snap_name}" → ปัจจุบัน "${r.true_name}" (${r.true_ref})`);
  }
}

// ── 3–4. ทดสอบตัวเขียน snapshot ด้วยใบชั่วคราว ────────────────────────────
if (pairs.length === 0) {
  console.log('\n⏭  ข้ามข้อ 3–4: ไม่มีเคสจริงให้ทดสอบ');
} else {
  const c = pairs[0];
  const salesperson = { salesperson_id: null, name: '', phone: '' };
  const tempIds: string[] = [];

  try {
    // ── 3. updateQuotationCustomerSnapshot ──
    // จำลอง select_contact: ใบถูกผูกกับบริษัท a แต่ชื่อที่ไหลมาเป็นชื่อบริษัทอื่น
    const ins = await pool.query(
      `INSERT INTO quotations (status, customer_details, item_details, total_sum)
       VALUES ('draft', '{}'::jsonb, '[]'::jsonb, 0) RETURNING id`
    );
    const tempId = ins.rows[0].id;
    tempIds.push(tempId);

    await updateQuotationCustomerSnapshot(
      [tempId],
      `${c.b_name} | ${c.contact_name}`,   // ชื่อบริษัท b (ผิด) คู่กับ id ของบริษัท a
      'draft',
      salesperson,
      c.a_id,
      c.a_contact
    );

    const { rows: after } = await pool.query(
      `SELECT customer_details->>'customer_name' AS name,
              customer_details->>'customer_code' AS code
         FROM quotations WHERE id = $1`,
      [tempId]
    );
    ok(
      'updateQuotationCustomerSnapshot แก้ชื่อบริษัทให้ตรงกับ customer_id ที่ผูกจริง',
      String(after[0].name || '').trim() === String(c.a_name).trim(),
      `ป้อน "${c.b_name}" → ได้ "${after[0].name}" (คาด "${c.a_name}")`
    );
    ok(
      'updateQuotationCustomerSnapshot ให้รหัสลูกค้าของบริษัทเดียวกับชื่อ',
      String(after[0].code || '').trim() === String(c.a_ref || '').trim(),
      `รหัส="${after[0].code}" (คาด "${c.a_ref}")`
    );

    // ── 4. insertDraftQuotations ──
    // user_id = null → DELETE ร่างเดิม (`WHERE user_id = NULL`) ไม่ตรงแถวไหนเลย และ FK
    // quotations_user_id_fkey ยอมรับ NULL — ใบทดสอบจึงไม่ไปทับร่างของเซลส์คนใด
    const inserted = await insertDraftQuotations(
      null as any,
      `${c.b_name} | ${c.contact_name}`,
      [{ product_code: '__diag_company_name__', quantity: 1, price: 0 }],
      'draft',
      c.a_id,
      c.a_contact
    );
    const insRows = inserted || [];
    for (const q of insRows) tempIds.push(q.id);

    ok('insertDraftQuotations สร้างใบทดสอบได้', insRows.length > 0);
    if (insRows.length > 0) {
      const { rows: insAfter } = await pool.query(
        `SELECT customer_details->>'customer_name' AS name,
                customer_details->>'customer_code' AS code
           FROM quotations WHERE id = ANY($1)`,
        [insRows.map((q: any) => q.id)]
      );
      ok(
        'insertDraftQuotations แก้ชื่อบริษัทให้ตรงกับ customer_id ที่ผูกจริง',
        insAfter.every((r: any) => String(r.name || '').trim() === String(c.a_name).trim()),
        `ป้อน "${c.b_name}" → ได้ "${insAfter[0]?.name}"`
      );
      ok(
        'insertDraftQuotations ให้รหัสลูกค้าของบริษัทเดียวกับชื่อ',
        insAfter.every((r: any) => String(r.code || '').trim() === String(c.a_ref || '').trim())
      );
    }

    // ── helper ตรง ๆ: ขอบเขตของกฎ ──
    ok(
      'companyNameOfRow เลือกชื่อจากแถวที่ให้รหัส ไม่ใช่ชื่อที่ส่งเข้ามา',
      companyNameOfRow({ customer_name: c.a_name }, c.b_name) === c.a_name
    );
    ok(
      'companyNameOfRow คงชื่อเดิมเมื่อแถวไม่มีชื่อ (ไม่ล้างทิ้ง)',
      companyNameOfRow({ customer_name: '  ' }, c.b_name) === c.b_name &&
        companyNameOfRow(null, c.b_name) === c.b_name
    );
  } finally {
    if (tempIds.length > 0) {
      await pool.query('DELETE FROM quotations WHERE id = ANY($1)', [tempIds]);
      console.log(`   🧹 ลบใบชั่วคราว ${tempIds.length} ใบแล้ว`);
    }
  }
}

console.log(`\n${failures === 0 ? '✅ ผ่านทั้งหมด' : `❌ ล้มเหลว ${failures} ข้อ`}`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
