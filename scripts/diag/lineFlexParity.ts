// ─────────────────────────────────────────────────────────────────────────────
//  lineFlexParity — ด่าน "ยิงข้อความจริงใน LINE 3 เคส" ของเฟส C แบบ *จำลอง*
//  (docs/plan-web-quote-request.md §6.0 → "ด่าน LINE จริงของเฟส C")
//
//  แผนกำหนดให้เฟส C ต้องยิงข้อความจริงเข้าบอทก่อนย้ายและหลังย้ายแล้วผลต้องเหมือนกันเป๊ะ
//  ซึ่งบนเครื่อง dev ทำไม่ได้ฟรี ๆ (ต้องสลับ webhook = บอท production เงียบ)
//  ⇒ ด่านนี้จำลองแทน โดย **เรียก handleEvent ตัวจริง** ด้วย event ที่มีรูปร่างเดียวกับที่
//  index.ts ส่งเข้าไปตอนรับ webhook แล้วดัก "ข้อความที่จะถูกยิงกลับ LINE" ด้วย
//  createCaptureClient() (ช่องฉีดของเฟส A) แทนการยิงออกจริง
//
//  ⚠️ สิ่งที่ด่านนี้ *ไม่* ครอบ (ยังต้องยิงจริงที่ server ตอน deploy):
//     LINE SDK เอง · reply token จริง · การเรนเดอร์ Flex บนมือถือ · webhook signature
//     ด่านนี้พิสูจน์ได้แค่ว่า "ก้อน JSON ที่จะส่งให้ LINE" เหมือนเดิมทุกตัวอักษร
//     — ซึ่งเป็นสิ่งเดียวที่การย้ายโค้ดในเฟส C มีสิทธิ์ทำพัง
//
//  รัน:  npm run diag:line-parity              เทียบกับ golden (ค่าปริยาย)
//        npm run diag:line-parity -- --save    บันทึก golden ใหม่ (ทำ "ก่อนย้าย" เท่านั้น)
//        npm run diag:line-parity -- --print   ดูผลดิบที่ normalize แล้ว
//
//  ผลข้างเคียง: สร้างแถว salesperson/messages/quotations ของ user ทดสอบ แล้วลบทิ้งใน finally
//               (user id ทดสอบเป็นค่าคงที่ ไม่ชนกับเซลส์จริง — ตรวจซ้ำก่อนลบทุกครั้ง)
//  ค่าใช้จ่าย : LLM ~4-8 call (สกัด 3 + AI pick รุ่นกำกวม)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import { pool } from '../../config/db.js';
import { handleEvent } from '../../handlers/lineHandler.js';
import { createCaptureClient } from '../../services/chatChannel.js';
import { buildExtractionPrompt } from '../../services/quoteExtraction.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YEL = '\x1b[33m', RESET = '\x1b[0m';

const SAVE = process.argv.includes('--save');
const PRINT = process.argv.includes('--print');
const GOLDEN_PATH = path.join(process.cwd(), 'scripts', 'diag', 'fixtures', 'lineFlexParity.golden.json');
const PROMPT_GOLDEN_PATH = path.join(process.cwd(), 'scripts', 'diag', 'fixtures', 'extractionPrompt.golden.txt');

// LINE user id = 'U' + hex 32 ตัว — ปลอมให้เข้ารูปเดิมเป๊ะ เพื่อไม่ให้หลุดเข้าเส้นทาง web: ของแผนนี้
const TEST_USER = 'U' + 'd1a9' + '0'.repeat(28);

interface Case { key: string; title: string; text: string; }

// 3 เคสตามแผน = 3 ทางออกของ slots (resolved / กำกวมมี candidate / พิมพ์ผิดไม่มี candidate)
// รุ่นที่ใช้เลือกจากพฤติกรรมจริงของ findProduct บนฐาน dev:
//   KR-Q50NW  → stage1 exact       (resolved)
//   KM-09N    → candidates 3 ตัว   (กำกวม → ปุ่มเลือกรุ่น + แถว pending_product)
//   ZZQWXYP   → ไม่มี candidate เลย (พิมพ์ผิด → รายงาน + ปุ่มค้นหาสินค้า)
const CASES: Case[] = [
  {
    key: 'case1_resolved',
    title: 'รุ่นถูกทุกตัว → การ์ดสรุป/เลือกบริษัท',
    text: 'เสนอราคา\nบริษัท สยามเพาเวอร์ เทคโนโลยี จำกัด\nคุณนรินทร์\nKR-Q50NW = 2 ตัว\nลด 30%',
  },
  {
    key: 'case2_ambiguous',
    title: 'รุ่นกำกวม → ปุ่มกดเลือกรุ่น (pending_product)',
    text: 'เสนอราคา\nบริษัท สยามเพาเวอร์ เทคโนโลยี จำกัด\nคุณนรินทร์\nKM-09N = 2 ตัว\nลด 30%',
  },
  {
    key: 'case3_typo',
    title: 'รุ่นพิมพ์ผิด → รายงาน + ปุ่มค้นหาสินค้า',
    text: 'เสนอราคา\nบริษัท สยามเพาเวอร์ เทคโนโลยี จำกัด\nคุณนรินทร์\nZZQWXYP = 2 ตัว\nลด 30%',
  },
];

/**
 * ตัด \r ทิ้งก่อนเทียบเสมอ — git ตั้ง `* text=auto` ไว้ ⇒ ไฟล์ golden ถูกเก็บเป็น LF ในรีโป
 * แต่ตอน checkout บน Windows กลายเป็น CRLF · ถ้าเทียบดิบ ๆ ด่านจะล้มทั้งที่โค้ดไม่ได้เปลี่ยน
 * (ฝั่งที่สร้างสดจาก JSON.stringify เป็น \n เสมอ ไม่ว่าเครื่องไหน)
 * ที่ยังจับได้ครบคือช่องว่างทุกตัวที่มีความหมาย — เว้นวรรคท้ายบรรทัด/ย่อหน้า/บรรทัดว่าง
 */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

/**
 * ลบ "ค่าที่เปลี่ยนทุกครั้งโดยธรรมชาติ" ออกก่อนเทียบ — ไม่ใช่การผ่อนเกณฑ์
 * (uuid ของใบ / เลขที่ใบ / วันที่ / เวลา) ที่เหลือต้องตรงทุกตัวอักษร
 */
function normalize(value: any): string {
  let s = JSON.stringify(value, null, 2);
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  s = s.replace(/Q[A-Z]-\d{6,}/g, '<quotation_no>');
  s = s.replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, '<date>');
  s = s.replace(/\d{1,2} [ก-๙.]+ \d{4}/g, '<date_th>');
  return s;
}

async function cleanupUser(): Promise<void> {
  // เงื่อนไข user_id ตายตัวและเป็น id ทดสอบเท่านั้น — ไม่มีทางลบข้อมูลเซลส์จริง
  await pool.query('DELETE FROM quotations WHERE user_id = $1', [TEST_USER]);
  await pool.query('DELETE FROM messages WHERE user_id = $1', [TEST_USER]);
}

async function main() {
  if (!TEST_USER.match(/^U[0-9a-f]{32}$/)) {
    console.error(`${RED}TEST_USER ไม่เข้ารูป LINE user id${RESET}`);
    process.exit(1);
  }

  console.log(`${BOLD}ด่านจำลอง LINE 3 เคส (เฟส C)${RESET}  user=${DIM}${TEST_USER}${RESET}`);
  console.log(`${DIM}golden: ${GOLDEN_PATH}${RESET}\n`);

  // ── เคส 0: prompt ต้องเหมือนก่อนย้ายทุกตัวอักษร (รวมช่องว่างท้ายบรรทัด) ──
  // golden ถอดมาจากซอร์สของ handleEvent ก่อนเฟส C ย้ายโค้ด ด้วยการ eval เฉพาะ template literal
  // ⇒ ถ้าใครไป "จัดย่อหน้าให้สวย" ในไฟล์ service วันหลัง ด่านนี้จะล้มทันที
  let promptOk = true;
  if (!SAVE) {
    const want = lf(fs.readFileSync(PROMPT_GOLDEN_PATH, 'utf8'));
    const got = lf(buildExtractionPrompt('<<CONTENT>>', '<<HISTORY>>'));
    promptOk = want === got;
    if (promptOk) {
      console.log(`${GREEN}✓${RESET} prompt เหมือนก่อนย้ายทุกตัวอักษร (${got.length} ตัวอักษร)`);
    } else {
      console.log(`${RED}✗${RESET} prompt ต่างจากก่อนย้าย — ${want.length} → ${got.length} ตัวอักษร`);
      const wl = want.split('\n'), gl = got.split('\n');
      for (let i = 0, shown = 0; i < Math.max(wl.length, gl.length) && shown < 8; i++) {
        if (wl[i] !== gl[i]) {
          console.log(`   ${DIM}บรรทัด ${i + 1}${RESET}\n   ${RED}- ${JSON.stringify(wl[i])}${RESET}\n   ${GREEN}+ ${JSON.stringify(gl[i])}${RESET}`);
          shown++;
        }
      }
    }
    console.log('');
  }

  const captured: Record<string, string> = {};
  try {
    await pool.query(
      `INSERT INTO salesperson (user_id, name, status, phone, salesperson_id, branch)
       VALUES ($1, 'DIAG เฟส C (ลบอัตโนมัติ)', 'active', '000-000-0000', 'DIAGC', 'สำนักงานใหญ่')
       ON CONFLICT (user_id) DO UPDATE SET status = 'active'`,
      [TEST_USER]
    );

    for (const c of CASES) {
      // ล้างประวัติแชทก่อนทุกเคส — historyContext เป็นส่วนหนึ่งของ prompt
      // ถ้าไม่ล้าง เคสหลังจะเห็นเคสก่อนหน้าแล้วผลไม่ซ้ำเดิม (= เทียบ golden ไม่ได้)
      await cleanupUser();

      const cap = createCaptureClient();
      const t0 = Date.now();
      await handleEvent(
        {
          type: 'message',
          replyToken: `diag-${c.key}`,
          source: { type: 'user', userId: TEST_USER },
          message: { id: `diag-msg-${c.key}`, type: 'text', text: c.text },
        },
        { client: cap.client }
      );
      const ms = Date.now() - t0;
      captured[c.key] = normalize(cap.captured);
      const kinds = cap.captured.map((m: any) => m.type).join(',') || '(ว่าง)';
      console.log(`  ${DIM}${ms}ms${RESET} ${c.key} — ${c.title}  → ${kinds}`);
    }
  } finally {
    await cleanupUser();
    await pool.query('DELETE FROM salesperson WHERE user_id = $1', [TEST_USER]);
  }

  if (PRINT) {
    for (const c of CASES) console.log(`\n${BOLD}── ${c.key} ──${RESET}\n${captured[c.key]}`);
  }

  if (SAVE) {
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(captured, null, 2), 'utf8');
    console.log(`\n${YEL}บันทึก golden ใหม่แล้ว${RESET} — ${GOLDEN_PATH}`);
    console.log(`${DIM}(ต้องทำ "ก่อนย้าย" เท่านั้น · หลังย้ายให้รันโดยไม่ใส่ --save)${RESET}`);
    await pool.end();
    return;
  }

  if (!fs.existsSync(GOLDEN_PATH)) {
    console.error(`\n${RED}ไม่พบ golden${RESET} — รัน --save บนโค้ดก่อนย้ายก่อน`);
    await pool.end();
    process.exit(1);
  }

  const golden = JSON.parse(lf(fs.readFileSync(GOLDEN_PATH, 'utf8')));
  let pass = 0, fail = 0;
  for (const c of CASES) {
    const want = golden[c.key];
    const got = captured[c.key];
    if (want === undefined) {
      console.log(`\n${RED}✗${RESET} ${c.key} — golden ไม่มีเคสนี้`);
      fail++;
      continue;
    }
    if (want === got) {
      console.log(`\n${GREEN}✓${RESET} ${c.key} — เหมือน golden ทุกตัวอักษร (${got.length} ตัวอักษร)`);
      pass++;
      continue;
    }
    fail++;
    console.log(`\n${RED}✗${RESET} ${c.key} — ต่างจาก golden`);
    const wl = want.split('\n'), gl = got.split('\n');
    let shown = 0;
    for (let i = 0; i < Math.max(wl.length, gl.length) && shown < 12; i++) {
      if (wl[i] !== gl[i]) {
        console.log(`   ${DIM}บรรทัด ${i + 1}${RESET}\n   ${RED}- ${wl[i] ?? '(ไม่มี)'}${RESET}\n   ${GREEN}+ ${gl[i] ?? '(ไม่มี)'}${RESET}`);
        shown++;
      }
    }
  }

  if (!promptOk) fail++; else pass++;
  console.log(`\n${BOLD}สรุป:${RESET} ${GREEN}ผ่าน ${pass}${RESET} · ${fail > 0 ? RED : DIM}ล้ม ${fail}${RESET} ${DIM}(prompt 1 + เคส ${CASES.length})${RESET}`);
  if (fail > 0) {
    console.log(`${DIM}หมายเหตุ: LLM ไม่ deterministic 100% — ถ้าต่างกันให้รันซ้ำ 1 รอบก่อนสรุปว่าโค้ดพัง${RESET}`);
  }
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${RED}ด่านล้มเหลว:${RESET}`, e);
  try { await cleanupUser(); await pool.query('DELETE FROM salesperson WHERE user_id = $1', [TEST_USER]); } catch {}
  await pool.end();
  process.exit(1);
});
