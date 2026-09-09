// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของ "ตัวตนผู้เสนอราคา" บน PDF — เฟส B2 ของ docs/plan-web-quote-request.md
//  รัน:  npm run diag:pdf-issuer
//
//  โจทย์ของเฟสนี้คือเพิ่มทางแยกใน pdfGenerator.ts โดยที่ **ใบจาก LINE และใบเก่าทุกใบ
//  ต้องได้ HTML เดิมทุกตัวอักษร** — ด่านนี้จึงพิสูจน์สองอย่างพร้อมกัน:
//  ทางเดิมไม่ขยับ (เคส 1–2) และทางใหม่ทำสิ่งที่แผนสั่งจริง (เคส 3–4)
//
//  ครอบคลุม:
//   1. ไม่มี issuer_name → สตริงต้องเท่ากับ golden ของโค้ดก่อนแก้ ทุกตัวอักษร
//   2. มี issuer_name → ช่องกลาง (พนักงานขาย) ต้องยังเท่ากับ golden เป๊ะ
//   3. มี issuer_name → ช่องขวาได้ชื่อแอดมิน + สังกัดตามค่าย · เบอร์ดิบไม่ถูก normalize
//                       · ไม่มีเบอร์ = ไม่พิมพ์บรรทัดนั้นและต้องไม่มี '( เบอร์โทร )'
//   4. ไม่มีลายเซ็นแอดมิน → ช่องขวาไม่มีรูป และ **ห้ามถอยไปใช้ลายเซ็นเซลส์**
//   5. updateQuotationCustomerSnapshot ต้องไม่กิน 3 คีย์ทิ้ง (กับดัก §2.6)
//   5b. การเลือกเบอร์ให้อัตโนมัติ — 1 ชื่อ = 1 เบอร์ ที่มาจากใบล่าสุด ไม่ใช่ที่ใช้บ่อยสุด
//   6. ใบ LINE ต้องไม่มีคีย์ issuer_* ใน employee_details เลย (ไม่ใช่มีแล้วเป็น null)
//   7. แถวพร็อกซี web:% ต้องไม่โผล่ในทางที่ "ลิสต์คน" ทุกทาง (§2.3b)
//
//  ⚠️ เคส 5–7 สร้างแอดมิน/เซลส์/ใบชั่วคราวของตัวเองแล้วลบทิ้งเสมอ (finally)
//     ไม่แตะแถวของคนจริงแม้แต่แถวเดียว
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { buildSignatureBlocksHtml, formatPersonNameWithSuffix } from '../../pdfGenerator.js';
import {
  listOdooQuotationMakers,
  listActingSalespersons,
  getIssuerSnapshot,
  buildWebUserId,
} from '../../services/webIdentity.js';
import { updateQuotationCustomerSnapshot } from '../../services/quotationService.js';
import { listSalespersonsForAdmin, findDuplicateEmployeeCodeNames } from '../../db/repositories.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// ── golden: ถอดความจากโค้ดก่อนแก้ (pdfGenerator.ts บรรทัด 688–707 ของ commit b42c035) ──
// เขียนมือใหม่ทั้งก้อน ไม่ได้เรียกโค้ดที่กำลังทดสอบ ⇒ ถ้าใครจัด indent ใหม่หรือสลับบรรทัด
// ด่านนี้จะดังทันที · ห้ามแก้ golden เพื่อให้ผ่าน — ถ้าจะเปลี่ยนหน้ากระดาษต้องตั้งใจและแก้ที่นี่ด้วย
function legacyGolden(nameFormatted: string, phone: string, sig: string | null): string {
  const img = sig
    ? `<img src="${sig}" alt="ลายเซ็น" style="max-height: 50px; max-width: 180px; object-fit: contain; display: block; margin: 0 auto;" />`
    : '';
  const nm = nameFormatted === '' ? 'ชื่อพนักงานขาย' : nameFormatted;
  const ph = phone && phone !== '' ? `( ${phone} )` : '( เบอร์โทร )';
  return `<div class="sigs">
          <div class="sig">
            <div class="sig-space"></div>
            <div class="sig-line"></div>
            <div class="sig-name">ลูกค้า (ผู้มีอำนาจ)</div>
            <div class="sig-date">วันที่......./......./.......</div>
          </div>

          <div class="sig">
            <div class="sig-space">${img}</div>
            <div class="sig-line"></div>
            <div class="sig-name">( ${nm} )</div>
            <div style="color: #111; font-size: 11px;">${ph}</div>
            <div style="color: #111; font-size: 11px;">( พนักงานขาย )</div>
            <div class="sig-date">วันที่......./......./.......</div>
          </div>

          <div class="sig">
            <div class="sig-space">${img}</div>
            <div class="sig-line"></div>
            <div class="sig-name">( ${nm} )</div>
            <div style="color: #111; font-size: 11px;">${ph}</div>
            <div style="color: #111; font-size: 11px;">( ผู้เสนอราคา )</div>
            <div class="sig-date">วันที่......./......./.......</div>
          </div>
        </div>`;
}

/** ตัดเอาเฉพาะบล็อกช่องกลาง (พนักงานขาย) มาเทียบ */
function middleBlock(html: string): string {
  const parts = html.split('<div class="sig">');
  return parts[2] ?? '';
}
/** ตัดเอาเฉพาะบล็อกช่องขวา (ผู้เสนอราคา) มาเทียบ */
function rightBlock(html: string): string {
  const parts = html.split('<div class="sig">');
  return parts[3] ?? '';
}

const FAKE_SP_SIG = 'data:image/png;base64,U0FMRVM=';
const FAKE_ADMIN_SIG = 'data:image/png;base64,QURNSU4=';

// ── 1. ทางเดิมต้องไม่ขยับแม้แต่ไบต์เดียว ─────────────────────────────────────
{
  const cases: Array<[string, string, string | null]> = [
    ['สมชาย  ใจดี (PM)', '0-2451-6338-41', FAKE_SP_SIG],   // ครบทุกอย่าง
    ['สมชาย  ใจดี (PM)', '', null],                          // ไม่มีเบอร์ ไม่มีลายเซ็น
    ['', '', null],                                          // ไม่มีชื่อเลย → placeholder เดิม
  ];
  let allSame = true;
  for (const [nm, ph, sig] of cases) {
    const got = buildSignatureBlocksHtml({
      salespersonNameFormatted: nm,
      salespersonPhone: ph,
      sigBase64: sig,
      issuerNameFormatted: null,
      issuerPhone: null,
      issuerSigBase64: null,
    });
    const want = legacyGolden(nm, ph, sig);
    if (got !== want) {
      allSame = false;
      console.log(`   ต่างที่เคส name="${nm}" phone="${ph}" sig=${sig ? 'มี' : 'ไม่มี'}`);
      const i = [...got].findIndex((c, idx) => c !== want[idx]);
      console.log(`   ตำแหน่งแรกที่ต่าง: ${i}\n   got : ${JSON.stringify(got.slice(Math.max(0, i - 40), i + 40))}\n   want: ${JSON.stringify(want.slice(Math.max(0, i - 40), i + 40))}`);
    }
  }
  ok('1. ไม่มี issuer_name → HTML เท่ากับ golden ของโค้ดก่อนแก้ ทุกตัวอักษร (3 เคส)', allSame);
}

// ── 2. มี issuer_name แล้วช่องกลางต้องยังเป็นของเซลส์เหมือนเดิมเป๊ะ ───────────
{
  const withIssuer = buildSignatureBlocksHtml({
    salespersonNameFormatted: 'สมชาย  ใจดี (PM)',
    salespersonPhone: '081-111-1111',
    sigBase64: FAKE_SP_SIG,
    issuerNameFormatted: 'ยุพาทิพย์  ผลรัก (PM)',
    issuerPhone: '0-2451-6338-41',
    issuerSigBase64: FAKE_ADMIN_SIG,
  });
  const golden = legacyGolden('สมชาย  ใจดี (PM)', '081-111-1111', FAKE_SP_SIG);
  ok('2. มี issuer_name → ช่อง "พนักงานขาย" ยังเท่ากับ golden เป๊ะ (เปลี่ยนได้แค่ช่องขวา)',
     middleBlock(withIssuer) === middleBlock(golden));
  ok('2b. ช่องซ้าย (ลูกค้า) ไม่ขยับ',
     withIssuer.split('<div class="sig">')[1] === golden.split('<div class="sig">')[1]);
}

// ── 3. ช่องขวาของใบจากเว็บ ───────────────────────────────────────────────────
{
  // สังกัดห้อยตามค่ายของใบ ด้วยกติกาเดียวกับชื่อเซลส์ (ตัด คุณ → ลบวงเล็บเดิม → ห้อยใหม่)
  ok('3a. ห้อยสังกัด PM ให้ชื่อแอดมิน (ใบ QP-)',
     formatPersonNameWithSuffix('คุณยุพาทิพย์  ผลรัก (THT)', false) === 'ยุพาทิพย์  ผลรัก (PM)');
  ok('3b. ห้อยสังกัด THT ให้ชื่อแอดมิน (ใบ QT-)',
     formatPersonNameWithSuffix('ยุพาทิพย์  ผลรัก', true) === 'ยุพาทิพย์  ผลรัก (THT)');

  const raw = '0-2693-7005 Ext.315';
  const html = buildSignatureBlocksHtml({
    salespersonNameFormatted: 'สมชาย  ใจดี (PM)',
    salespersonPhone: '081-111-1111',
    sigBase64: FAKE_SP_SIG,
    issuerNameFormatted: 'ยุพาทิพย์  ผลรัก (PM)',
    issuerPhone: raw,
    issuerSigBase64: FAKE_ADMIN_SIG,
  });
  const right = rightBlock(html);
  ok('3c. ช่องขวาได้ชื่อแอดมิน ไม่ใช่ชื่อเซลส์', right.includes('( ยุพาทิพย์  ผลรัก (PM) )') && !right.includes('สมชาย'));
  ok('3d. เบอร์พิมพ์ดิบ ไม่ถูก normalize', right.includes(`( ${raw} )`), `"${raw}"`);
  ok('3e. เบอร์ไม่ถูกห้อยสังกัด', !right.includes(`${raw} (PM)`) && !right.includes(`${raw} (THT)`));
  ok('3f. ช่องขวาใช้ลายเซ็นแอดมิน ไม่ใช่ของเซลส์', right.includes(FAKE_ADMIN_SIG) && !right.includes(FAKE_SP_SIG));

  const noPhone = rightBlock(buildSignatureBlocksHtml({
    salespersonNameFormatted: 'สมชาย  ใจดี (PM)',
    salespersonPhone: '081-111-1111',
    sigBase64: FAKE_SP_SIG,
    issuerNameFormatted: 'ยุพาทิพย์  ผลรัก (PM)',
    issuerPhone: null,
    issuerSigBase64: FAKE_ADMIN_SIG,
  }));
  ok('3g. ไม่มีเบอร์ → ไม่มีสตริง "( เบอร์โทร )" บนกระดาษ', !noPhone.includes('( เบอร์โทร )'));
  ok('3h. ไม่มีเบอร์ → ไม่พิมพ์บรรทัดเบอร์เลย (เหลือ div ขนาด 11px แค่บรรทัด "( ผู้เสนอราคา )")',
     (noPhone.match(/font-size: 11px;/g) || []).length === 1);
  ok('3i. ไม่มีเบอร์ก็ยังมีชื่อและลายเซ็น', noPhone.includes('( ยุพาทิพย์  ผลรัก (PM) )') && noPhone.includes(FAKE_ADMIN_SIG));
}

// ── 4. ยังไม่อัปลายเซ็น = ออกใบได้ ห้ามถอยไปใช้ลายเซ็นเซลส์ ───────────────────
{
  const right = rightBlock(buildSignatureBlocksHtml({
    salespersonNameFormatted: 'สมชาย  ใจดี (PM)',
    salespersonPhone: '081-111-1111',
    sigBase64: FAKE_SP_SIG,
    issuerNameFormatted: 'ยุพาทิพย์  ผลรัก (PM)',
    issuerPhone: '0-2451-6338-41',
    issuerSigBase64: null,
  }));
  ok('4a. ไม่มีลายเซ็นแอดมิน → ช่องขวาไม่มีรูปเลย', !right.includes('<img'));
  ok('4b. **ห้ามถอยไปใช้ลายเซ็นเซลส์** (ลายเซ็นคนอื่นใต้ชื่อเรา ผิดร้ายแรงกว่าไม่มี)', !right.includes(FAKE_SP_SIG));
  ok('4c. ยังได้ชื่อและเบอร์ครบ ใบออกได้ปกติ',
     right.includes('( ยุพาทิพย์  ผลรัก (PM) )') && right.includes('( 0-2451-6338-41 )'));
}

// ── 5b. การเลือกเบอร์ให้อัตโนมัติจากข้อมูลจริง ───────────────────────────────
const makers = await listOdooQuotationMakers();
{
  ok('5b-1. ได้รายชื่อผู้จัดทำจาก Odoo', makers.length > 0, `${makers.length} ชื่อ`);
  ok('5b-2. ทุกรายการเป็นรูป { name, phone } และ 1 ชื่อ = 1 เบอร์',
     makers.every(m => typeof m.name === 'string' && m.name !== '' && (m.phone === null || typeof m.phone === 'string')));
  const dupNames = makers.length - new Set(makers.map(m => m.name)).size;
  ok('5b-3. ไม่มีชื่อซ้ำในรายการ (DISTINCT ON ทำงาน)', dupNames === 0, `ซ้ำ ${dupNames}`);
  ok('5b-4. ชื่อที่ไม่มีเบอร์ยังอยู่ในรายการ (LEFT JOIN ไม่ใช่ INNER)',
     makers.some(m => m.phone === null), `ไม่มีเบอร์ ${makers.filter(m => m.phone === null).length} ชื่อ`);
  ok('5b-5. เบอร์ไม่ถูก normalize — ยังมีรูปแบบดิบของ Odoo ปนอยู่',
     makers.some(m => (m.phone ?? '').includes('-')));

  // กติกาต้องเป็น "ล่าสุด" ไม่ใช่ "บ่อยสุด" — พิสูจน์กับข้อมูลจริงโดยไม่ผูกกับชื่อคนใดคนหนึ่ง
  const { rows: proof } = await pool.query(`
    WITH src AS (
      SELECT regexp_replace(btrim(employee_quotations), '\\s*\\([^)]*\\)\\s*$', '') AS name,
             NULLIF(btrim(COALESCE(employee_quotations_phone, '')), '')             AS phone,
             order_date
        FROM sale_orders
       WHERE invoice_status = 'invoiced'
         AND employee_quotations IS NOT NULL AND btrim(employee_quotations) <> ''
    ),
    agg AS (
      SELECT name, phone, max(order_date) AS last_used, count(*) AS n
        FROM src WHERE name <> '' AND phone IS NOT NULL GROUP BY 1, 2
    ),
    latest AS (SELECT DISTINCT ON (name) name, phone FROM agg ORDER BY name, last_used DESC NULLS LAST, n DESC, phone),
    most   AS (SELECT DISTINCT ON (name) name, phone FROM agg ORDER BY name, n DESC, last_used DESC NULLS LAST, phone)
    SELECT l.name, l.phone AS latest_phone, m.phone AS most_phone
      FROM latest l JOIN most m ON m.name = l.name
     WHERE l.phone <> m.phone
     ORDER BY l.name`);
  ok('5b-6. มีเคสจริงที่ "ล่าสุด" ต่างจาก "บ่อยสุด" ให้พิสูจน์ได้', proof.length > 0, `${proof.length} ชื่อ`);
  const wrong = proof.filter((r: any) => makers.find(m => m.name === r.name)?.phone !== r.latest_phone);
  ok('5b-7. ทุกเคสนั้นระบบเลือก "เบอร์ในใบล่าสุด" ไม่ใช่ "เบอร์ที่ใช้บ่อยสุด"',
     wrong.length === 0,
     wrong.length ? `พลาด: ${wrong.map((r: any) => r.name).join(', ')}` : `ตรวจแล้ว ${proof.length} ชื่อ`);
}

// ── 5 / 6 / 7. ต้องแตะ DB จริง ────────────────────────────────────────────────
let tmpAdminId: number | null = null;
let tmpProxyUserId: string | null = null;
const tmpQuoteIds: string[] = [];

try {
  const maker = makers.find(m => m.phone !== null) ?? makers[0];
  const insAdmin = await pool.query(
    `INSERT INTO admin_users (username, password_hash, name, role, employee_quotation_id, employee_quotation_phone, signature_key)
     VALUES ($1, 'diag-not-a-real-hash', 'DIAG ผู้เสนอราคา', 'subadmin', $2, $3, $4)
     RETURNING id`,
    [`diag_issuer_tmp_${Date.now()}`, maker.name, maker.phone, 'diag00sigkey']
  );
  tmpAdminId = insAdmin.rows[0].id;

  // แถวพร็อกซีของคู่ (แอดมิน × เซลส์) — สร้างตรง ๆ ไม่ผ่าน ensureWebProxy() เพื่อไม่ต้องพึ่งเซลส์จริง
  tmpProxyUserId = buildWebUserId(tmpAdminId as number, 'UdiagWebQuoteSmokeTmp');
  await pool.query(
    `INSERT INTO salesperson (user_id, name, status, phone, salesperson_id, employee_quotation_id)
     VALUES ($1, 'DIAG เซลส์ปลอม', 'active', '081-000-0000', 'DIAGX', $2)`,
    [tmpProxyUserId, maker.name]
  );

  // ── 5. updateQuotationCustomerSnapshot ต้องไม่กิน 3 คีย์ทิ้ง ────────────────
  const snap = await getIssuerSnapshot(tmpProxyUserId);
  ok('5a. getIssuerSnapshot คืนค่าให้ user_id ที่ขึ้นต้น web:', snap !== null && snap.issuer_name === maker.name);
  ok('5b. getIssuerSnapshot คืน null ให้ใบจาก LINE',
     (await getIssuerSnapshot('U0123456789abcdef0123456789abcdef')) === null);

  const insQuote = await pool.query(
    `INSERT INTO quotations (status, user_id, customer_details, item_details, total_sum, employee_details)
     VALUES ('draft', $1, '{}'::jsonb, '[]'::jsonb, 0, $2::jsonb) RETURNING id`,
    [tmpProxyUserId, JSON.stringify({ salesperson_id: 'DIAGX', saleperson: 'DIAG เซลส์ปลอม', sale_phone: '081-000-0000', ...(snap ?? {}) })]
  );
  tmpQuoteIds.push(insQuote.rows[0].id);

  await updateQuotationCustomerSnapshot(
    tmpQuoteIds,
    'DIAG บริษัททดสอบ | DIAG ผู้ติดต่อ',
    'draft',
    { user_id: tmpProxyUserId, name: 'DIAG เซลส์ปลอม', phone: '081-000-0000', salesperson_id: 'DIAGX' },
    null,
    null
  );
  const { rows: after } = await pool.query(`SELECT employee_details FROM quotations WHERE id = $1`, tmpQuoteIds);
  const ed = after[0]?.employee_details ?? {};
  ok('5c. หลัง updateQuotationCustomerSnapshot คีย์ issuer_name ยังอยู่ (กับดัก §2.6)', ed.issuer_name === maker.name, JSON.stringify(ed.issuer_name));
  ok('5d. คีย์ issuer_phone ยังอยู่และตรงกับที่โปรไฟล์เก็บไว้', ed.issuer_phone === maker.phone);
  ok('5e. คีย์ issuer_sig_key ยังอยู่', ed.issuer_sig_key === 'diag00sigkey');
  ok('5f. ฟิลด์เดิมของเซลส์ไม่ถูกกลบ', ed.saleperson === 'DIAG เซลส์ปลอม' && ed.salesperson_id === 'DIAGX');

  // ── 6. ใบ LINE ต้องไม่มีคีย์ issuer_* โผล่มาเลย ────────────────────────────
  const lineSnap = await getIssuerSnapshot('U0123456789abcdef0123456789abcdef');
  const lineEd = { salesperson_id: '123', saleperson: 'เซลส์ LINE', sale_phone: '081-2', ...(lineSnap ?? {}) };
  ok('6. ใบ LINE: employee_details ไม่มีคีย์ issuer_* เลย (ไม่ใช่มีแล้วเป็น null)',
     !('issuer_name' in lineEd) && !('issuer_phone' in lineEd) && !('issuer_sig_key' in lineEd),
     Object.keys(lineEd).join(','));

  // ── 7. แถวพร็อกซีต้องไม่โผล่ในทางที่ "ลิสต์คน" ทุกทาง ─────────────────────
  const acting = await listActingSalespersons();
  ok('7a. listActingSalespersons() ไม่เห็นแถวพร็อกซี', !acting.some(a => a.user_id === tmpProxyUserId));
  const adminList = await listSalespersonsForAdmin();
  ok('7b. หน้า "จัดการข้อมูลพนักงาน" ไม่เห็นแถวพร็อกซี', !adminList.some((r: any) => r.user_id === tmpProxyUserId));
  const dups = await findDuplicateEmployeeCodeNames('DIAGX', 'UsomeoneElse');
  ok('7c. คำเตือน "รหัสพนักงานซ้ำ" ไม่นับแถวพร็อกซี (พร็อกซีก๊อป salesperson_id มาจากเซลส์จริง)',
     !dups.includes('DIAG เซลส์ปลอม'), dups.join(', ') || '(ไม่มี)');
  const { rows: statRows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM salesperson WHERE user_id NOT LIKE 'web:%')::int AS shown,
            (SELECT COUNT(*) FROM salesperson)::int                                AS total`);
  ok('7d. ตัวเลขบนการ์ดแดชบอร์ดตรงกับจำนวนแถวในหน้าจัดการพนักงาน',
     statRows[0].shown === adminList.length && statRows[0].total > statRows[0].shown,
     `การ์ด ${statRows[0].shown} · ทั้งตาราง ${statRows[0].total}`);
} finally {
  // เก็บกวาดเสมอ แม้เคสข้างบนจะพัง — ห้ามทิ้งแถวปลอมไว้ในตารางจริง
  if (tmpQuoteIds.length) await pool.query(`DELETE FROM quotations WHERE id = ANY($1)`, [tmpQuoteIds]).catch(() => {});
  if (tmpProxyUserId) await pool.query(`DELETE FROM salesperson WHERE user_id = $1`, [tmpProxyUserId]).catch(() => {});
  if (tmpAdminId) await pool.query(`DELETE FROM admin_users WHERE id = $1`, [tmpAdminId]).catch(() => {});
}

console.log(failures === 0 ? '\nสรุป: ผ่านทั้งหมด' : `\nสรุป: ไม่ผ่าน ${failures} ข้อ`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
