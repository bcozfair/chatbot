/**
 * evalCustomerSearch — ชุดข้อสอบวัดความแม่นยำการค้นหาบริษัท
 *
 * Replay ข้อความจริงที่เซลส์เคยพิมพ์ (จากตาราง messages) ผ่าน findCustomerCandidates
 * แล้วเทียบกับบริษัทที่เคยยืนยันจริง (บรรทัด 🏢 ใน reply ของ draft ที่สำเร็จ)
 * — SELECT อย่างเดียว ไม่แตะข้อมูล ไม่ส่ง LINE
 *
 * วิธีใช้:
 *   npx tsx scripts/evalCustomerSearch.ts --mine          # สร้างชุดข้อสอบจากตาราง messages
 *   npx tsx scripts/evalCustomerSearch.ts                 # รันข้อสอบ (deterministic, ไม่เรียก AI — เร็ว/ฟรี)
 *   npx tsx scripts/evalCustomerSearch.ts --ai            # รันข้อสอบแบบ pipeline เต็มรวม AI (วัดของจริง)
 *   npx tsx scripts/evalCustomerSearch.ts --old           # รัน pipeline เดิม (DISABLE_NEW_SEARCH=1) ไว้เทียบ baseline
 *   npx tsx scripts/evalCustomerSearch.ts --limit 10      # รันแค่ N ข้อแรก
 *
 * Metrics:
 *   top-1 accuracy      อันดับ 1 คือเฉลย (ตัวเลขหลัก)
 *   top-3 accuracy      เฉลยติด 3 อันดับแรก (user แค่กดเลือก 1 ครั้ง)
 *   zero-candidate      หาไม่เจอเลย (เคส "ไม่พบชื่อบริษัทในระบบ")
 *   wrong-auto-select   ระบบมั่นใจผิดจนเลือกผิดอัตโนมัติ (ต้องเป็น 0)
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.join(__dirname, '..', 'data', 'eval', 'customer_search_cases.json');

const args = process.argv.slice(2);
const MODE_MINE = args.includes('--mine');
const MODE_AI = args.includes('--ai');
const MODE_OLD = args.includes('--old');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ต้องเซ็ต env ก่อน import service (kill-switches อ่านตอน runtime จึงเซ็ตก่อนก็พอ)
if (!MODE_AI) process.env.DISABLE_AI_MATCH = '1';
if (MODE_OLD) process.env.DISABLE_NEW_SEARCH = '1';

const { pool } = await import('../config/db.js');
const { findCustomerCandidates } = await import('../services/customerService.js');

interface EvalCase {
  id: string;
  source: 'mined' | 'pinned';
  note?: string;
  customerQuery: string;
  contactQuery: string;
  expected: string; // display_name ที่ถูกต้อง (ยืนยันจากประวัติจริง)
}

// ── เคสปักหมุดจาก failure clusters ที่วิเคราะห์จากตาราง messages (2026-07) ──
const PINNED_CASES: EvalCase[] = [
  { id: 'pin-1-dot-initial', source: 'pinned', note: 'cluster 1: จุดย่อตัวเดียว (7 msgs fail)', customerQuery: 'บริษัท ก.แสงทอง', contactQuery: 'คุณก้อย', expected: 'บริษัท ก.แสงทอง เอ็นจิเนียริ่ง จำกัด (สำนักงานใหญ่)' },
  { id: 'pin-2-spelling', source: 'pinned', note: 'cluster 2: สะกดต่าง แมส/แมช (6 msgs fail)', customerQuery: 'บ.เอ.เค.พลาสติกแมสชีนเนอรี่', contactQuery: 'คุณอั๋น', expected: 'บริษัท เอ.เค.พลาสติกแมชชินเนอรี่ จำกัด (สำนักงานใหญ่)' },
  { id: 'pin-3-spacing', source: 'pinned', note: 'cluster 3: เว้นวรรคต่าง', customerQuery: 'โคราชกรุ๊ป', contactQuery: 'คุณรจนา', expected: 'บริษัท โคราช กรุ๊ป วิศวกรรม จำกัด (สาขาที่ 00002)' },
  { id: 'pin-4-person-phone', source: 'pinned', note: 'cluster 4: ลูกค้าบุคคล+เบอร์ (5 msgs fail)', customerQuery: 'คุณโยธิน 06-3884-0005', contactQuery: '', expected: 'คุณ โยธิน  ปาทาน' },
  { id: 'pin-5a-contact-ku-jittipong', source: 'pinned', note: 'cluster 5: contact ชี้ขาด', customerQuery: 'บ.เคยู', contactQuery: 'คุณจิตติพงษ์', expected: 'บริษัท เคยู พลัส จำกัด (สำนักงานใหญ่)' },
  { id: 'pin-5b-contact-ku-thanet', source: 'pinned', note: 'cluster 5: เคยเลือกผิดเป็นสยามเคยู', customerQuery: 'บ.เคยู', contactQuery: 'คุณธเนศ', expected: 'บริษัท พีเคยู อินเตอร์เนชั่นแนล เทคโนโลยี จำกัด (สำนักงานใหญ่)' },
  { id: 'pin-5c-contact-ku-chao', source: 'pinned', note: 'cluster 5: contact ชี้ขาด', customerQuery: 'บ.เคยู', contactQuery: 'คุณเชาว์', expected: 'บริษัท เคยู ดีแม็ค จำกัด (สำนักงานใหญ่)' },
  { id: 'pin-6-exact-typed', source: 'pinned', note: 'cluster 6: พิมพ์ตรงเป๊ะแต่ AI เคยเลือกผิด', customerQuery: 'บริษัท ย่งฮง (ประเทศไทย) จำกัด (สำนักงานใหญ่)', contactQuery: 'คุณธนกร', expected: 'บริษัท ย่งฮง (ประเทศไทย) จำกัด (สำนักงานใหญ่)' },
  { id: 'pin-9-ref-fastpath', source: 'pinned', note: 'regression: reference fast-path ต้องยังทำงาน', customerQuery: 'A/35871 บ.ถิรเดช', contactQuery: 'คุณถิรเดช', expected: 'ห้างหุ้นส่วนจำกัด ถิรเดช โอภาสวัฒนกุล (สำนักงานใหญ่)' },
  // เคสจริง 2026-07-20: ลูกค้าแปะที่อยู่/เลขผู้เสียภาษี/สเปคสินค้ามาเต็ม → เลขสาขา "00005",
  // บ้านเลขที่ "600", ไปรษณีย์ "20230", แรงดัน "220" ถูกจับเป็นรหัสลูกค้า แล้ว fast-path
  // คืนบริษัทมั่ว 30 ตัว score เท่ากันหมด 0.1 โดยไม่เคยค้นชื่อ "ทีพีซีเอส" และไม่เคยเรียก AI
  { id: 'pin-10-noisy-address-block', source: 'pinned', note: 'regression: บล็อกที่อยู่/ภาษี/สินค้า ต้องไม่กลายเป็นรหัสลูกค้า',
    customerQuery: 'บริษัท ทีพีซีเอส จำกัด (มหาชน) สาขา\n00005\n     n600/49 ถ.สุขาภิบาล8 ต.หนองขาม\nอ.ศรีราชา จ.ชลบุรี 20230\nเล    ลขผู้เสียภาษี 0107537001447\nคุณอภิญญา\nเมลล์ aphinya@tpcspllc.com\nโทร 0962456842\n1. FP-108-1 220 V.U1BW\nPcs.\n2',
    contactQuery: 'คุณอภิญญา', expected: 'บริษัท ทีพีซีเอส จำกัด (มหาชน) (สาขาที่ 00005)' },
];

/** ดึงบรรทัดที่น่าจะเป็นชื่อบริษัท/ลูกค้า กับชื่อผู้ติดต่อ ออกจากข้อความดิบ (heuristic ตาม convention จริง) */
function extractQueries(content: string): { customerQuery: string; contactQuery: string } | null {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  let customer = '';
  let contact = '';
  for (const line of lines) {
    // ข้ามบรรทัดคำสั่ง/ส่วนลด/รายการสินค้า
    if (/^(เสนอราคา|สนอราคา|ขอใบเสนอราคา|ออกใบเสนอราคา)/.test(line) && line.length < 40) continue;
    if (/^ลด\s*\d/.test(line) || /ราคาโปร|net|=|ตัว$|ชิ้น$|เมตร$/i.test(line)) continue;
    if (/^[A-Za-z0-9/\-().,'" ]+$/.test(line)) continue; // product code ล้วน
    if (!contact && /^คุณ/.test(line) && line.length < 40) { contact = line; continue; }
    if (!customer && /(บริษัท|บ\.|หจก|ห้างหุ้นส่วน|จำกัด)/.test(line)) { customer = line; continue; }
  }
  if (!customer && contact) { customer = contact; }
  if (!customer) return null;
  return { customerQuery: customer, contactQuery: contact };
}

async function mineCases(): Promise<void> {
  const { rows } = await pool.query(`
    SELECT id, content, reply_content FROM messages
    WHERE type = 'text' AND reply_content LIKE '%ร่างใบเสนอราคา%'
    ORDER BY id`);

  const seen = new Map<string, EvalCase>();
  let skipped = 0;
  for (const row of rows) {
    const m = row.reply_content.match(/🏢 (.+)/);
    if (!m) { skipped++; continue; }
    const expected = m[1].trim();

    // validate เฉลยกับ customers_view — ต้อง resolve เป็น display_name จริง 1 รายการ
    const { rows: found } = await pool.query(
      `SELECT display_name FROM customers_view WHERE display_name = $1 LIMIT 2`, [expected]);
    if (found.length !== 1) { skipped++; continue; }

    const q = extractQueries(row.content);
    if (!q) { skipped++; continue; }

    const key = `${q.customerQuery}|${q.contactQuery}`;
    if (!seen.has(key)) {
      seen.set(key, {
        id: `mined-${row.id}`,
        source: 'mined',
        customerQuery: q.customerQuery,
        contactQuery: q.contactQuery,
        expected,
      });
    }
  }

  const cases = [...PINNED_CASES, ...Array.from(seen.values())];
  fs.mkdirSync(path.dirname(CASES_PATH), { recursive: true });
  fs.writeFileSync(CASES_PATH, JSON.stringify(cases, null, 2), 'utf8');
  console.log(`✅ mined ${seen.size} cases (+${PINNED_CASES.length} pinned, skipped ${skipped}) → ${CASES_PATH}`);
}

async function runEval(): Promise<void> {
  if (!fs.existsSync(CASES_PATH)) {
    console.error(`ไม่พบชุดข้อสอบ ${CASES_PATH} — รันด้วย --mine ก่อน`);
    process.exit(1);
  }
  const cases: EvalCase[] = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')).slice(0, LIMIT);
  const salespersonStub = { name: 'EVAL', branch_code: '' };

  let top1 = 0, top3 = 0, zero = 0, wrongAuto = 0;
  const failures: string[] = [];
  const latencies: number[] = [];

  for (const c of cases) {
    const t0 = Date.now();
    let candidates: any[] = [];
    try {
      candidates = await findCustomerCandidates(c.customerQuery, salespersonStub, c.contactQuery);
    } catch (err: any) {
      console.error(`  [${c.id}] ERROR: ${err.message}`);
    }
    latencies.push(Date.now() - t0);

    const collapse = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const names = candidates.map(r => (r.item?.display_name || '').trim());
    const rank = names.findIndex(n => collapse(n) === collapse(c.expected)) + 1; // 1-based, 0 = ไม่เจอ

    // จำลอง auto-select gate ของ processQuotationRequest (top<=0.05 && gap>0.05) + เคส 1 candidate
    const topScore = candidates[0]?.score ?? 99;
    const gap = (candidates[1]?.score ?? 99) - topScore;
    const wouldAutoSelect = candidates.length === 1 || (topScore <= 0.05 && gap > 0.05);

    if (rank === 1) top1++;
    if (rank >= 1 && rank <= 3) top3++;
    if (candidates.length === 0) zero++;
    const isWrongAuto = wouldAutoSelect && rank !== 1;
    if (isWrongAuto) wrongAuto++;

    const mark = rank === 1 ? '✅' : rank >= 1 && rank <= 3 ? '🟡' : '❌';
    const autoMark = wouldAutoSelect ? (rank === 1 ? ' [auto✓]' : ' [AUTO-WRONG⚠️]') : '';
    const line = `${mark}${autoMark} [${c.id}] "${c.customerQuery}"${c.contactQuery ? ` + "${c.contactQuery}"` : ''}\n     → got: ${names[0] || '(none)'}${rank > 1 ? ` | expected at #${rank || '∅'}: ${c.expected}` : rank === 0 ? ` | expected: ${c.expected} (NOT FOUND)` : ''}`;
    console.log(line);
    if (rank !== 1) failures.push(line);
  }

  const n = cases.length;
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(n, 1));
  const p95 = latencies.sort((a, b) => a - b)[Math.floor(n * 0.95)] ?? 0;
  console.log('\n══════════════ SUMMARY ══════════════');
  console.log(`mode              : ${MODE_OLD ? 'OLD pipeline' : 'NEW pipeline'} | AI ${MODE_AI ? 'ON' : 'OFF'}`);
  console.log(`cases             : ${n}`);
  console.log(`top-1 accuracy    : ${top1}/${n} (${(100 * top1 / n).toFixed(1)}%)`);
  console.log(`top-3 accuracy    : ${top3}/${n} (${(100 * top3 / n).toFixed(1)}%)`);
  console.log(`zero-candidate    : ${zero}/${n} (${(100 * zero / n).toFixed(1)}%)`);
  console.log(`wrong-auto-select : ${wrongAuto} ${wrongAuto > 0 ? '⚠️ ต้องเป็น 0!' : '✓'}`);
  console.log(`latency avg/p95   : ${avg}ms / ${p95}ms`);
}

try {
  if (MODE_MINE) await mineCases();
  else await runEval();
} finally {
  await pool.end();
}
