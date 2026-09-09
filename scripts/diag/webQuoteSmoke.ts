// ─────────────────────────────────────────────────────────────────────────────
//  webQuoteSmoke — ด่านของเฟส D (docs/plan-web-quote-request.md §9.0 ข้อ 1–4)
//  รัน:  npm run diag:web-quote        (ต้องเปิดเซิร์ฟเวอร์ npm run dev ไว้ก่อน — ใช้ในข้อ 3)
//
//  1. extractQuoteFromText() ด้วยข้อความจริง → slots ครบ 3 แบบ เรียงตามที่พิมพ์
//     และเรียกได้โดยไม่ส่ง remainingMs/checkpoint                                    [เฟส C]
//  2. proposeFromText() ต้อง **ไม่เขียน quotations** และ **ไม่ลบร่างที่ค้างอยู่**      [เฟส D]
//  3. createDraft() → PUT /api/quotation/:id → confirm ครบวงจรด้วย webUserId          [เฟส D]
//  4. reviseQuotation() — ใบที่ยืนยันแล้ว → ได้ร่าง revision · เลขที่ไม่มีจริง → ปฏิเสธ [เฟส D]
//
//  ⚠️ เขียนข้อมูลจริงลง DB (salesperson · admin_users · quotations ของ user ทดสอบ)
//     แล้วลบทิ้งใน finally ทุกกรณี — user/แอดมินทดสอบเป็นค่าคงที่ที่ไม่ชนของจริง
//  ค่าใช้จ่าย: LLM ~2-4 call (ข้อ 1 และข้อ 2 อย่างละรอบ)
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { extractQuoteFromText, buildResolvedItem } from '../../services/quoteExtraction.js';
import { validateQuotationItems } from '../../services/quotationService.js';
import {
  proposeFromText,
  createDraft,
  reviseQuotation,
  resolveWebUserId,
  WebQuoteError,
} from '../../services/webQuoteService.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

const PORT = process.env.PORT || 3011;
const BASE = process.env.APP_URL || `http://localhost:${PORT}`;

// LINE user id = 'U' + hex 32 ตัว — ให้เข้ารูปเดิมเป๊ะ จะได้ไม่หลุดเข้าเส้นทาง web: ของแผนนี้เอง
const TEST_SP_USER = 'U' + 'd2b8' + '0'.repeat(28);
const TEST_ADMIN_USERNAME = 'diag_webquote_tmp';
const TEST_MAKER = 'DIAG ผู้จัดทำ (ลบอัตโนมัติ)';

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ${GREEN}✓${RESET} ${label}${extra ? ` ${DIM}${extra}${RESET}` : ''}`); }
  else { fail++; console.log(`  ${RED}✗${RESET} ${label}${extra ? ` ${DIM}${extra}${RESET}` : ''}`); }
}

/** ข้อความทดสอบชุดเดียวกับด่านเฟส C — 3 บรรทัดสินค้า = 3 ทางออกของ slots */
const SAMPLE_TEXT = [
  'เสนอราคา',
  'บริษัท สยามเพาเวอร์ เทคโนโลยี จำกัด',
  'คุณนรินทร์',
  'KR-Q50NW = 2 ตัว',   // stage1 exact      → resolved
  'KM-09N = 2 ตัว',     // candidates หลายตัว → กำกวม
  'ZZQWXYP = 2 ตัว',    // ไม่มี candidate    → พิมพ์ผิด
  'ลด 30%',
].join('\n');

const slotModel = (s: any): string =>
  String(s?.itemForDb?.model ?? s?.item?.model ?? s?.item?.product_code ?? '').toUpperCase();

// ── setup / teardown ─────────────────────────────────────────────────────────

let adminId = 0;
let webUserId = '';

async function setup() {
  await pool.query(
    `INSERT INTO salesperson (user_id, name, status, phone, salesperson_id, branch)
     VALUES ($1, 'DIAG เฟส D (ลบอัตโนมัติ)', 'active', '000-000-0000', 'DIAGD', 'สำนักงานใหญ่')
     ON CONFLICT (user_id) DO UPDATE SET status = 'active'`,
    [TEST_SP_USER]
  );

  const { rows } = await pool.query(
    `INSERT INTO admin_users (username, password_hash, name, role, employee_quotation_id)
     VALUES ($1, 'x-diag-not-a-login', 'DIAG แอดมินทดสอบ (ลบอัตโนมัติ)', 'admin', $2)
     ON CONFLICT (username) DO UPDATE SET employee_quotation_id = EXCLUDED.employee_quotation_id
     RETURNING id`,
    [TEST_ADMIN_USERNAME, TEST_MAKER]
  );
  adminId = rows[0].id;
}

async function teardown() {
  // ลบใบของ user ทดสอบทั้งฝั่ง LINE-shaped และฝั่งพร็อกซี ก่อนลบแถวเจ้าของ (FK)
  const users = [TEST_SP_USER, webUserId].filter(Boolean);
  for (const u of users) {
    await pool.query('DELETE FROM quotations WHERE user_id = $1', [u]).catch(() => {});
    await pool.query('DELETE FROM messages WHERE user_id = $1', [u]).catch(() => {});
  }
  await pool.query("DELETE FROM salesperson WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query('DELETE FROM admin_users WHERE username = $1', [TEST_ADMIN_USERNAME]).catch(() => {});
}

/** หา (บริษัท × ผู้ติดต่อ) จริงที่ผ่านด่านลูกค้า (ไม่ติด blacklist / ไม่ติดเครดิต) */
async function pickCustomerContact(): Promise<{ customerId: number; contactId: number; name: string }> {
  const { rows } = await pool.query(`
    SELECT company_id, contact_id, customer_name, contact_name
      FROM customers_data_view
     WHERE contact_id > 0 AND company_id > 0
       AND customer_name IS NOT NULL AND contact_name IS NOT NULL
     ORDER BY contact_id DESC
     LIMIT 15
  `);
  for (const r of rows) {
    const { violations } = await validateQuotationItems([], {
      stage: 'draft', customerId: r.company_id, contactId: r.contact_id
    });
    if (violations.length === 0) {
      return { customerId: r.company_id, contactId: r.contact_id, name: `${r.customer_name} | ${r.contact_name}` };
    }
  }
  throw new Error('หาลูกค้าที่ผ่านด่าน blacklist/เครดิตไม่ได้เลยใน 15 แถวแรก — ตรวจข้อมูล dev ก่อน');
}

/** หาสินค้าจริงที่ผ่านด่านกฎกับลูกค้ารายนั้น (สต๊อก · MOQ · ราคาขั้นต่ำ · บล็อก) */
async function pickProduct(cust: { customerId: number; contactId: number; name: string }): Promise<any> {
  const { rows } = await pool.query(`
    SELECT * FROM products
     WHERE sales_price > 0 AND quantity_on_hand_unreserved > 5
     ORDER BY quantity_on_hand_unreserved DESC
     LIMIT 10
  `);
  for (const p of rows) {
    const { itemForDb } = buildResolvedItem(p, { quantity: 1 }, {});
    const { violations } = await validateQuotationItems([itemForDb], {
      stage: 'draft', customerName: cust.name.split(' | ')[0], customerId: cust.customerId, contactId: cust.contactId
    });
    if (violations.length === 0) return p;
  }
  throw new Error('หาสินค้าที่ผ่านด่านกฎไม่ได้เลยใน 10 แถวแรก — ตรวจข้อมูล dev ก่อน');
}

async function serverIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/shipping-fee/config`, { method: 'GET' });
    return r.status < 500;
  } catch { return false; }
}

// ── ด่าน ─────────────────────────────────────────────────────────────────────

/** ข้อ 1 — extractQuoteFromText() คืน slots ครบ 3 แบบ เรียงตามที่พิมพ์ (เฟส C) */
async function case1() {
  console.log(`\n${BOLD}1) extractQuoteFromText — slots 3 แบบ เรียงตามที่พิมพ์${RESET}`);
  // จงใจไม่ส่ง remainingMs/checkpoint — ต้องทำงานได้โดยไม่ต้องปลอม deadline ของ LINE
  const r = await extractQuoteFromText({ userId: TEST_SP_USER, text: SAMPLE_TEXT });

  ok('intent = QUOTATION', r.intent === 'QUOTATION', `ได้ ${r.intent}`);
  const slots = r.slots ?? [];
  ok('ได้ slots ครบ 3 รายการ', slots.length === 3, `ได้ ${slots.length}`);
  if (slots.length !== 3) return;

  ok('เรียงตามลำดับที่พิมพ์', slotModel(slots[0]).includes('KR-Q50NW') && slotModel(slots[2]).includes('ZZQWXYP'),
    `[${slots.map(slotModel).join(', ')}]`);
  ok('slot 1 = resolved', slots[0].resolved === true);
  ok('slot 2 = กำกวม (ไม่ resolved แต่มี candidates)',
    slots[1].resolved === false && (slots[1].candidates?.length ?? 0) > 0,
    `candidates=${slots[1].candidates?.length ?? 0}`);
  ok('slot 3 = พิมพ์ผิด (ไม่ resolved และไม่มี candidates)',
    slots[2].resolved === false && (slots[2].candidates?.length ?? 0) === 0);
}

/** ข้อ 2 — proposeFromText ต้องไม่เขียน quotations และไม่ลบร่างที่ค้างอยู่ */
async function case2() {
  console.log(`\n${BOLD}2) proposeFromText — ไม่เขียน quotations · ไม่ลบร่างที่ค้าง${RESET}`);
  webUserId = await resolveWebUserId(adminId, TEST_SP_USER);
  ok('ensureWebProxy คืน web:<admin>:<sp>', webUserId === `web:${adminId}:${TEST_SP_USER}`, webUserId);

  // ร่างค้าง 1 ใบที่ "ต้องรอด" — นี่คือของที่ deletePendingQuotations จะกวาดทิ้งถ้าเผลอเรียก
  const { rows: seeded } = await pool.query(
    `INSERT INTO quotations (user_id, status, total_sum, customer_details, item_details, employee_details)
     VALUES ($1, 'draft', 0, '{"customer_name":"DIAG ร่างที่ต้องรอด"}', '[]', '{}')
     RETURNING id`,
    [webUserId]
  );
  const survivorId = seeded[0].id;

  const before = Number((await pool.query('SELECT COUNT(*)::int AS n FROM quotations WHERE user_id = $1', [webUserId])).rows[0].n);
  const proposed = await proposeFromText({ adminId, spUserId: TEST_SP_USER, text: SAMPLE_TEXT });
  const after = Number((await pool.query('SELECT COUNT(*)::int AS n FROM quotations WHERE user_id = $1', [webUserId])).rows[0].n);

  ok('ไม่มีใบใหม่ถูกเขียน', before === after, `ก่อน ${before} → หลัง ${after}`);
  const alive = Number((await pool.query(
    "SELECT COUNT(*)::int AS n FROM quotations WHERE id = $1 AND status = 'draft'", [survivorId]
  )).rows[0].n);
  ok('ร่างที่ค้างอยู่ยังอยู่ครบ (ไม่เรียก deletePendingQuotations)', alive === 1);

  ok('คืน slots ให้ฟอร์มเรนเดอร์', (proposed.slots?.length ?? 0) === 3, `ได้ ${proposed.slots?.length ?? 0}`);
  ok('นับ slot ที่ยังไม่ resolve ให้', proposed.unresolved_count === 2, `ได้ ${proposed.unresolved_count}`);
  ok('คืน customer_candidates มาให้เคาะ', Array.isArray(proposed.customer_candidates),
    `${proposed.customer_candidates.length} ตัว`);

  await pool.query('DELETE FROM quotations WHERE id = $1', [survivorId]);
}

/** ข้อ 3 — createDraft → PUT → confirm ครบวงจรด้วย webUserId */
async function case3(): Promise<string | null> {
  console.log(`\n${BOLD}3) createDraft → PUT /api/quotation/:id → confirm${RESET}`);
  const cust = await pickCustomerContact();
  const product = await pickProduct(cust);
  console.log(`  ${DIM}ลูกค้า: ${cust.name} · สินค้า: ${product.model}${RESET}`);

  const draft = await createDraft({
    adminId,
    spUserId: TEST_SP_USER,
    customerId: cust.customerId,
    contactId: cust.contactId,
    items: [{ product_template_id: product.product_template_id, quantity: 2 }],
  });
  ok('createDraft คืนใบร่าง', (draft.quotes?.length ?? 0) > 0, `${draft.quotes?.length ?? 0} ใบ`);
  ok('ใบเป็นของ webUserId', draft.web_user_id === webUserId, draft.web_user_id);
  if (!draft.quotes?.length) return null;

  const quote = draft.quotes[0];
  const ownerRow = (await pool.query('SELECT user_id, status FROM quotations WHERE id = $1', [quote.id])).rows[0];
  ok('แถวใน DB ถูกผูกกับ web:% และเป็น draft',
    ownerRow?.user_id === webUserId && ownerRow?.status === 'draft', `${ownerRow?.user_id} / ${ownerRow?.status}`);

  // ── ต่อด้วย endpoint เดิมที่ตรวจสิทธิ์จาก userId ใน body (ขั้น 8′) ──
  const putResp = await fetch(`${BASE}/api/quotation/${quote.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: quote.items, total_sum: quote.total_sum, userId: webUserId }),
  });
  ok('PUT /api/quotation/:id ด้วย webUserId → 200', putResp.status === 200, `HTTP ${putResp.status}`);

  const wrongResp = await fetch(`${BASE}/api/quotation/${quote.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: quote.items, userId: TEST_SP_USER }),
  });
  ok('PUT ด้วย userId ของคนอื่น → 403', wrongResp.status === 403, `HTTP ${wrongResp.status}`);

  const confirmResp = await fetch(`${BASE}/api/quotation/${quote.id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: webUserId }),
  });
  const confirmBody: any = await confirmResp.json().catch(() => ({}));
  ok('confirm ด้วย webUserId → 200', confirmResp.status === 200, `HTTP ${confirmResp.status}`);

  const confirmed = (await pool.query('SELECT status, quotation_no FROM quotations WHERE id = $1', [quote.id])).rows[0];
  ok('ใบถูกยืนยันและได้เลขที่จริง',
    confirmed?.status === 'confirmed' && !!confirmed?.quotation_no,
    `${confirmed?.status} / ${confirmed?.quotation_no ?? '(ไม่มีเลข)'}`);

  return confirmed?.quotation_no ?? confirmBody?.quotation_no ?? null;
}

/** ข้อ 4 — reviseQuotation: ใบที่ยืนยันแล้วได้ร่าง · เลขที่ใช้ไม่ได้ต้องถูกปฏิเสธ */
async function case4(quotationNo: string | null) {
  console.log(`\n${BOLD}4) reviseQuotation${RESET}`);
  if (!quotationNo) {
    fail++;
    console.log(`  ${RED}✗${RESET} ข้ามข้อ 4 — ข้อ 3 ไม่ได้เลขที่ใบมาให้ revise`);
    return;
  }

  const revised = await reviseQuotation({ adminId, spUserId: TEST_SP_USER, quotationNo });
  ok('ใบที่ยืนยันแล้ว → ได้ร่าง revision', !!revised.draft_quote_id, revised.draft_quote_id);
  ok('ร่างอ้างเลขที่ใบต้นทางถูกต้อง', revised.revise_from === quotationNo, revised.revise_from);

  const draftRow = (await pool.query(
    'SELECT user_id, status, quotation_no FROM quotations WHERE id = $1', [revised.draft_quote_id]
  )).rows[0];
  ok('ร่างเป็นของ webUserId และยังไม่มีเลขที่',
    draftRow?.user_id === webUserId && draftRow?.status === 'draft' && !draftRow?.quotation_no,
    `${draftRow?.status} / ${draftRow?.quotation_no ?? '(ไม่มีเลข)'}`);

  // ร่าง (ยังไม่มีเลขที่) ไม่มีทางถูกอ้างถึงได้เลย — ไม่มีเลขให้พิมพ์ ⇒ ต้องตอบ "ไม่พบ" ไม่ใช่ 500
  let code = '';
  try { await reviseQuotation({ adminId, spUserId: TEST_SP_USER, quotationNo: 'QP-999999999' }); }
  catch (e: any) { code = e instanceof WebQuoteError ? e.code : `(${e?.name}) ${e?.message}`; }
  ok('เลขที่ไม่มีในระบบ → QUOTATION_NOT_FOUND', code === 'QUOTATION_NOT_FOUND', code || '(ไม่ throw)');

  let blankCode = '';
  try { await reviseQuotation({ adminId, spUserId: TEST_SP_USER, quotationNo: '  ' }); }
  catch (e: any) { blankCode = e instanceof WebQuoteError ? e.code : `(${e?.name}) ${e?.message}`; }
  ok('ไม่ส่งเลขที่ → BAD_REQUEST', blankCode === 'BAD_REQUEST', blankCode || '(ไม่ throw)');

  console.log(`  ${DIM}หมายเหตุ: กิ่ง QUOTATION_NOT_CONFIRMED เป็นด่านกันเหนียวที่ยกมาจาก`);
  console.log(`  handleQuotationEditRequest() — ผ่านทางค้นด้วยเลขที่จะไปไม่ถึง เพราะใบร่างไม่มีเลข${RESET}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}webQuoteSmoke — ด่านเฟส D${RESET} ${DIM}(${BASE})${RESET}`);

  if (!(await serverIsUp())) {
    console.error(`\n${RED}เซิร์ฟเวอร์ไม่ตอบที่ ${BASE}${RESET} — ข้อ 3 ต้องยิง HTTP จริง`);
    console.error(`${DIM}เปิด npm run dev ไว้อีกหน้าต่างก่อนแล้วรันใหม่${RESET}`);
    await pool.end();
    process.exit(1);
  }

  try {
    await setup();
    await case1();
    await case2();
    const quotationNo = await case3();
    await case4(quotationNo);
  } finally {
    await teardown();
  }

  console.log(`\n${BOLD}สรุป:${RESET} ${GREEN}ผ่าน ${pass}${RESET} · ${fail > 0 ? RED : DIM}ล้ม ${fail}${RESET}`);
  if (fail > 0) {
    console.log(`${DIM}หมายเหตุ: ข้อ 1–2 พึ่ง LLM ซึ่งไม่ deterministic 100% — ถ้าล้มให้รันซ้ำ 1 รอบก่อนสรุปว่าโค้ดพัง${RESET}`);
  }
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\n${RED}ด่านล้มเหลว:${RESET}`, e);
  try { await teardown(); } catch { /* teardown ล้มเองก็ยังต้องปิด pool */ }
  await pool.end();
  process.exit(1);
});
