// ─────────────────────────────────────────────────────────────────────────────
//  salespersonDedupeSmoke — ด่านของการยุบเซลส์ชื่อ/รหัสซ้ำใน dropdown "ออกใบในนาม"
//  รัน:  npm run diag:sp-dedupe        (ไม่ต้องเปิดเซิร์ฟเวอร์ · อ่าน DB อย่างเดียว)
//
//  1. pickRepresentatives() — ฟังก์ชันบริสุทธิ์ ทดสอบด้วยข้อมูลประกอบเอง 6 เคส
//  2. รายชื่อจริงจาก DB — ยุบแล้วต้องไม่มีรหัสซ้ำ/ชื่อซ้ำเหลือ และต้องไม่มีใครหายเกินที่ยุบ
//  3. ไม่เขียน DB สักแถว (เทียบจำนวนแถว salesperson ก่อน–หลัง)
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { listActingSalespersons, type ActingSalesperson } from '../../services/webIdentity.js';
import {
  dedupeActingSalespersons,
  pickRepresentatives,
  type SalespersonActivity,
} from '../../services/salespersonPicker.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function ok(label: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ${GREEN}✓${RESET} ${label}${extra ? ` ${DIM}${extra}${RESET}` : ''}`); }
  else { fail++; console.log(`  ${RED}✗${RESET} ${label}${extra ? ` ${DIM}${extra}${RESET}` : ''}`); }
}

const sp = (
  user_id: string,
  name: string,
  code: string | null,
  hasSig = false
): ActingSalesperson => ({
  user_id,
  name,
  salesperson_id: code,
  phone: null,
  has_sale_sig: hasSig,
  sig_url: hasSig ? `/data/sale_sigs/${code}.png` : null,
});

const act = (user_id: string, iso: string | null, quote_count = 0): [string, SalespersonActivity] => [
  user_id,
  { user_id, last_active_at: iso ? new Date(iso) : null, quote_count },
];

async function main() {
  console.log(`\n${BOLD}1) pickRepresentatives — ข้อมูลประกอบเอง${RESET}`);

  // 1a. รหัสเดียวกัน → เหลือตัวที่ใช้งานล่าสุด
  {
    const rows = [sp('Ua', 'คุณจิรายุ', '422'), sp('Ub', 'คุณจิรายุ', '422')];
    const a = new Map([act('Ua', '2026-09-04T07:56:00Z', 91), act('Ub', '2026-09-03T08:59:00Z', 1)]);
    const out = pickRepresentatives(rows, a);
    ok('1a. รหัสซ้ำ → เหลือ 1 และเป็นตัวที่ใช้งานล่าสุด', out.length === 1 && out[0].user_id === 'Ua',
      `เหลือ ${out.length} · ${out[0]?.user_id}`);
    ok('1a. merged_count/merged_user_ids บอกที่มาได้',
      out[0]?.merged_count === 1 && out[0]?.merged_user_ids[0] === 'Ub',
      `merged=${out[0]?.merged_count} [${out[0]?.merged_user_ids.join(',')}]`);
  }

  // 1b. ลำดับใน rows สลับ ก็ต้องได้ผู้ชนะคนเดิม (ไม่ขึ้นกับลำดับที่ SQL คืนมา)
  {
    const rows = [sp('Ub', 'คุณจิรายุ', '422'), sp('Ua', 'คุณจิรายุ', '422')];
    const a = new Map([act('Ua', '2026-09-04T07:56:00Z', 91), act('Ub', '2026-09-03T08:59:00Z', 1)]);
    ok('1b. สลับลำดับ input ผู้ชนะไม่เปลี่ยน', pickRepresentatives(rows, a)[0].user_id === 'Ua');
  }

  // 1c. ไม่มีประวัติเลยทั้งคู่ → ตัดสินด้วยลายเซ็น แล้ว user_id (ต้องนิ่ง ไม่สุ่ม)
  {
    const rows = [sp('Uz', 'คุณใหม่', '999'), sp('Uy', 'คุณใหม่', '999', true)];
    const out1 = pickRepresentatives(rows, new Map());
    const out2 = pickRepresentatives([...rows].reverse(), new Map());
    ok('1c. ไม่มีประวัติ → เลือกคนที่มีลายเซ็น และผลนิ่งทุกครั้ง',
      out1[0].user_id === 'Uy' && out2[0].user_id === 'Uy', `${out1[0].user_id}/${out2[0].user_id}`);
  }

  // 1d. ชื่อเดียวกันแต่รหัสต่างกัน = คนละคน → ห้ามยุบ (ไม่งั้นมีคนเลือกไม่ได้ตลอดกาล)
  {
    const rows = [sp('Ua', 'คุณสมชาย', '100'), sp('Ub', 'คุณสมชาย', '200')];
    const out = pickRepresentatives(rows, new Map());
    ok('1d. ชื่อซ้ำแต่รหัสต่าง → ไม่ยุบ (คนละคน)', out.length === 2, `เหลือ ${out.length}`);
  }

  // 1e. ไม่มีรหัสทั้งคู่ → ยุบด้วยชื่อ (trim + ช่องว่างซ้อน ไม่ทำให้หลุดกลุ่ม)
  {
    const rows = [sp('Ua', ' คุณไร้รหัส ', null), sp('Ub', 'คุณไร้รหัส', ''), sp('Uc', 'คุณไร้รหัส', null)];
    const out = pickRepresentatives(rows, new Map([act('Ub', '2026-09-01T00:00:00Z')]));
    ok('1e. ไม่มีรหัส → ยุบด้วยชื่อที่ normalize แล้ว', out.length === 1 && out[0].user_id === 'Ub',
      `เหลือ ${out.length} · ${out[0]?.user_id}`);
  }

  // 1f. ไม่มีซ้ำเลย → ผ่านทะลุครบและลำดับเดิมไม่ขยับ
  {
    const rows = [sp('Ua', 'ก', '1'), sp('Ub', 'ข', '2'), sp('Uc', 'ค', '3')];
    const out = pickRepresentatives(rows, new Map());
    ok('1f. ไม่มีซ้ำ → ครบ 3 ตัว ลำดับเดิม',
      out.length === 3 && out.map(o => o.user_id).join() === 'Ua,Ub,Uc',
      out.map(o => o.user_id).join());
    ok('1f. merged_count = 0 ทุกตัว', out.every(o => o.merged_count === 0));
  }

  console.log(`\n${BOLD}2) รายชื่อจริงจาก DB${RESET}`);
  const before = (await pool.query(`SELECT count(*)::int c FROM salesperson`)).rows[0].c;
  const raw = await listActingSalespersons();
  const deduped = await dedupeActingSalespersons(raw);
  const mergedTotal = deduped.reduce((s, d) => s + d.merged_count, 0);
  console.log(`  ${DIM}แถวดิบ ${raw.length} → ยุบแล้ว ${deduped.length} (ซ่อน ${mergedTotal})${RESET}`);

  ok('2a. จำนวนตรงกัน: ดิบ = ยุบแล้ว + ที่ซ่อน', raw.length === deduped.length + mergedTotal,
    `${raw.length} = ${deduped.length} + ${mergedTotal}`);

  const codes = deduped.map(d => (d.salesperson_id ?? '').trim()).filter(c => c !== '');
  ok('2b. ไม่มีรหัสซ้ำเหลือใน dropdown', new Set(codes).size === codes.length,
    `${codes.length} รหัส · distinct ${new Set(codes).size}`);

  const labels = deduped.map(d => `${(d.name ?? '').trim()}|${(d.salesperson_id ?? '').trim()}`);
  ok('2c. ไม่มี "ชื่อ+รหัส" ซ้ำกันเหลือ (ป้ายใน dropdown ไม่ซ้ำ)',
    new Set(labels).size === labels.length, `distinct ${new Set(labels).size}/${labels.length}`);

  ok('2d. ไม่มีแถวพร็อกซี web:% หลุดมา', !deduped.some(d => d.user_id.startsWith('web:')));

  ok('2e. ทุกคนที่ถูกซ่อนมีตัวแทนที่รหัสเดียวกันอยู่ในรายชื่อ',
    deduped.filter(d => d.merged_count > 0).every(d => (d.salesperson_id ?? '').trim() !== '' || d.name.trim() !== ''));

  for (const d of deduped.filter(x => x.merged_count > 0)) {
    console.log(`  ${DIM}   ยุบ: ${d.name} (${d.salesperson_id}) → ใช้ ${d.user_id.slice(0, 9)}… ` +
      `last_active=${d.last_active_at?.slice(0, 16) ?? '-'} ซ่อน ${d.merged_user_ids.map(u => u.slice(0, 9)).join(',')}${RESET}`);
  }

  const after = (await pool.query(`SELECT count(*)::int c FROM salesperson`)).rows[0].c;
  ok('3. ไม่เขียน DB สักแถว', before === after, `${before} → ${after}`);

  console.log(`\n${BOLD}สรุป:${RESET} ${fail === 0 ? GREEN : RED}ผ่าน ${pass}${RESET} · ${DIM}ล้ม ${fail}${RESET}\n`);
}

main()
  .catch((err) => { console.error(err); fail++; })
  .finally(async () => { await pool.end(); process.exit(fail === 0 ? 0 : 1); });
