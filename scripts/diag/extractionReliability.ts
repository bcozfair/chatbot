// ─────────────────────────────────────────────────────────────────────────────
//  extractionReliability — วัดว่า "retry ชั้นสกัดคำสั่ง" คุ้มไหม ด้วยการยิงวัดเอง
//  แทนการนั่งรอ log (log ปัจจุบันไม่ทิ้งร่องรอยตอน retry สำเร็จ จึงวัดย้อนหลังไม่ได้)
//
//  รัน:  npm run diag:extraction-reliability
//        npm run diag:extraction-reliability -- --dry-run          (ดูว่าจะยิงกี่ call ก่อนจ่ายเงิน)
//        npm run diag:extraction-reliability -- --messages 30 --rounds 5 --concurrency 3
//
//  ผลข้างเคียง: ไม่มี — อ่าน messages อย่างเดียว (SELECT) · ไม่เขียน DB · ไม่เรียก lineClient
//  ค่าใช้จ่าย: LLM messages × rounds call (default 30 × 5 = 150) ของ deepseek-v4-flash
//
//  ยิงด้วย createChatCompletion() ตัวเดียวกับ production และ params เดียวกันเป๊ะ
//  (response_format json_object · max_tokens 8192 · temperature 0 · thinking disabled)
//  ⚠️ prompt ใช้ mirror จาก extractionCore.ts — ถ้าแก้ prompt ใน lineHandler ต้อง sync ที่นั่นด้วย
//  ⚠️ ยิงด้วย historyContext = '' (ข้อความสดใหม่ ไม่มีประวัติแชทนำหน้า) prompt จึงสั้นกว่าของจริง
//     เล็กน้อย ⇒ latency ที่วัดได้เป็น "ขอบล่าง" ของจริงจะช้ากว่านี้นิดหน่อยเมื่อมีประวัติยาว
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { createChatCompletion, LLM_MODEL } from '../../config/clients.js';
import { buildExtractionPrompt, parseAiJson } from './extractionCore.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YEL = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
const MSG_LIMIT = Math.max(1, arg('messages', 30));
const ROUNDS = Math.max(1, arg('rounds', 5));
const CONCURRENCY = Math.max(1, Math.min(3, arg('concurrency', 3)));   // เพดาน 3 กัน rate-limit
const DRY_RUN = process.argv.includes('--dry-run');

// ตรงกับ lineHandler.ts:1555
const MAX_EXTRACTION_ATTEMPTS = 3;

type CallStatus = 'ok' | 'empty' | 'parse_error' | 'api_error';
interface CallResult { msgId: number; round: number; status: CallStatus; ms: number; detail?: string; }

/** ยิง 1 call ด้วย params เดียวกับ production (lineHandler.ts:1586-1599) */
async function runOne(msgId: number, content: string, round: number): Promise<CallResult> {
  const t0 = Date.now();
  try {
    const response = await createChatCompletion({
      messages: [{ role: 'user', content: buildExtractionPrompt(content) }],
      response_format: { type: 'json_object' },
      max_tokens: 8192,
    });
    const raw = response.choices[0]?.message?.content || '';
    if (!raw.trim()) return { msgId, round, status: 'empty', ms: Date.now() - t0 };
    try {
      parseAiJson(raw);
      return { msgId, round, status: 'ok', ms: Date.now() - t0 };
    } catch (e: any) {
      return { msgId, round, status: 'parse_error', ms: Date.now() - t0, detail: raw.slice(0, 120) };
    }
  } catch (e: any) {
    return { msgId, round, status: 'api_error', ms: Date.now() - t0, detail: e?.message || String(e) };
  }
}

/** worker pool ง่าย ๆ — จำกัดจำนวน call พร้อมกัน */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * เดินลูป retry ตัวจริง (lineHandler.ts:1584-1605) บนลำดับผลลัพธ์ที่ยิงได้จริง
 * ผลแต่ละ call เป็น trial อิสระ จึงเอามาต่อกันเป็น "รอบการสกัด" ได้ตามความหมายของลูป:
 *   attempt 1 พลาด → กิน call ถัดไปเป็น attempt 2 → พลาดอีก → attempt 3
 *   สำเร็จเมื่อไหร่ก็จบรอบนั้น แล้วเริ่มรอบใหม่ด้วย call ที่เหลือ
 */
function walkRetryLoop(statuses: CallStatus[]) {
  const runs: { succeededAt: number | null; used: number }[] = [];
  let i = 0;
  while (i < statuses.length) {
    let succeededAt: number | null = null;
    let used = 0;
    for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS && i < statuses.length; attempt++) {
      const s = statuses[i++];
      used++;
      if (s === 'ok') { succeededAt = attempt; break; }
    }
    // รอบที่ call หมดก่อนครบ 3 attempt และยังไม่สำเร็จ → ตัดทิ้ง สรุปไม่ได้
    if (succeededAt === null && used < MAX_EXTRACTION_ATTEMPTS) break;
    runs.push({ succeededAt, used });
  }
  return runs;
}

const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};
const share = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(2)}%` : '—');

async function main() {
  console.log(`${BOLD}Extraction Reliability${RESET} — model=${YEL}${LLM_MODEL}${RESET}`);

  // ── ดึงข้อความจริงที่เคยผ่านเส้นทาง extraction ──
  // type='text' คือเส้นทางเดียวที่เข้าลูปสกัด (postback/image ไม่ผ่าน)
  // ตัดแถวที่ content เป็นข้อความของบอทเองที่เซลส์ก๊อป/ส่งต่อกลับเข้ามา (ตรงกับ reply_content
  // ของแถวไหนก็ตาม เช่น "📝 บันทึกร่างใบเสนอราคาแล้ว (รหัส: …)") — ไม่ใช่คำสั่งขายจริง
  const { rows } = await pool.query(
    `SELECT id, content, created_at
       FROM messages m
      WHERE m.type = 'text' AND m.content IS NOT NULL AND btrim(m.content) <> ''
        AND NOT EXISTS (SELECT 1 FROM messages b WHERE b.reply_content = m.content)
      ORDER BY m.created_at DESC
      LIMIT $1`,
    [MSG_LIMIT]
  );
  if (!rows.length) {
    console.error(`${RED}ไม่พบข้อความ type='text' ใน messages${RESET}`);
    process.exit(1);
  }

  const totalCalls = rows.length * ROUNDS;
  console.log(`${DIM}ข้อความ ${rows.length} รายการ (ล่าสุด ${rows[rows.length - 1].created_at.toISOString().slice(0, 10)} → ${rows[0].created_at.toISOString().slice(0, 10)}) × ${ROUNDS} รอบ = ${CYAN}${totalCalls} call${RESET}${DIM} · concurrency ${CONCURRENCY}${RESET}`);

  if (DRY_RUN) {
    console.log(`\n${YEL}--dry-run: ไม่ยิง LLM${RESET} — ข้อความที่จะใช้:`);
    for (const r of rows) console.log(`  ${DIM}#${r.id}${RESET} ${String(r.content).replace(/\n/g, ' ⏎ ').slice(0, 90)}`);
    console.log('');
    return;
  }

  // ── ยิงจริง ──
  const jobs: { msgId: number; content: string; round: number }[] = [];
  for (let round = 1; round <= ROUNDS; round++)
    for (const r of rows) jobs.push({ msgId: r.id, content: String(r.content), round });

  let done = 0;
  const results = await runPool(jobs, CONCURRENCY, async (j) => {
    const res = await runOne(j.msgId, j.content, j.round);
    done++;
    if (done % 10 === 0 || done === jobs.length) process.stdout.write(`\r${DIM}  ยิงแล้ว ${done}/${jobs.length}${RESET}   `);
    return res;
  });
  process.stdout.write('\n');

  // ── สถิติระดับ call ──
  const n = results.length;
  const count = (s: CallStatus) => results.filter((r) => r.status === s).length;
  const nOk = count('ok'), nEmpty = count('empty'), nParse = count('parse_error'), nApi = count('api_error');
  const nFail = n - nOk;
  const lat = results.map((r) => r.ms);

  // ── เดินลูป retry ตัวจริงต่อข้อความ (เรียงตาม round เพื่อคงลำดับเวลา) ──
  const runs: { succeededAt: number | null }[] = [];
  for (const r of rows) {
    const seq = results
      .filter((x) => x.msgId === r.id)
      .sort((a, b) => a.round - b.round)
      .map((x) => x.status);
    runs.push(...walkRetryLoop(seq));
  }
  const nRuns = runs.length;
  const at = (k: number) => runs.filter((x) => x.succeededAt === k).length;
  const allFailed = runs.filter((x) => x.succeededAt === null).length;

  // ── ค่าคาดการณ์เชิงวิเคราะห์จากอัตราพลาดต่อ call (trial อิสระ) ──
  const p = nFail / n;
  const expectAll3 = Math.pow(p, MAX_EXTRACTION_ATTEMPTS);

  console.log(`\n${BOLD}══ ระดับ call (${n} call) ══${RESET}`);
  console.log(`  ${GREEN}ok           ${nOk.toString().padStart(4)}  ${share(nOk, n).padStart(7)}${RESET}`);
  console.log(`  ${nEmpty ? RED : DIM}empty content${nEmpty.toString().padStart(4)}  ${share(nEmpty, n).padStart(7)}${RESET}  ${DIM}โมเดลคืนสตริงว่าง${RESET}`);
  console.log(`  ${nParse ? RED : DIM}parse ไม่ได้ ${nParse.toString().padStart(5)}  ${share(nParse, n).padStart(7)}${RESET}  ${DIM}แม้ผ่าน fallback หา { } แล้ว${RESET}`);
  console.log(`  ${nApi ? RED : DIM}api error    ${nApi.toString().padStart(4)}  ${share(nApi, n).padStart(7)}${RESET}  ${DIM}SDK/network${RESET}`);
  console.log(`  ${BOLD}พลาดรวม (= อัตราพลาดของ attempt 1) ${nFail} ${share(nFail, n)}${RESET}`);

  console.log(`\n${BOLD}══ ลูป retry (${nRuns} รอบสกัด, สูงสุด ${MAX_EXTRACTION_ATTEMPTS} attempt) ══${RESET}`);
  console.log(`  สำเร็จที่ attempt 1   ${at(1).toString().padStart(4)}  ${share(at(1), nRuns).padStart(7)}`);
  console.log(`  ${at(2) ? GREEN : DIM}กู้ได้ที่ attempt 2   ${at(2).toString().padStart(4)}  ${share(at(2), nRuns).padStart(7)}${RESET}  ${DIM}← ชั้นที่ 2 คุ้มไหม${RESET}`);
  console.log(`  ${at(3) ? GREEN : DIM}กู้ได้ที่ attempt 3   ${at(3).toString().padStart(4)}  ${share(at(3), nRuns).padStart(7)}${RESET}  ${DIM}← ชั้นที่ 3 คุ้มไหม${RESET}`);
  console.log(`  ${allFailed ? RED : GREEN}พลาดครบทุก attempt  ${allFailed.toString().padStart(4)}  ${share(allFailed, nRuns).padStart(7)}${RESET}  ${DIM}เทียบ 0.07% ที่วัดจาก DB${RESET}`);
  console.log(`  ${DIM}ค่าคาดการณ์จากอัตราพลาดต่อ call: พลาดครบ 3 = ${(expectAll3 * 100).toFixed(4)}%${RESET}`);

  console.log(`\n${BOLD}══ latency ต่อ 1 call ══${RESET}`);
  console.log(`  p50 ${pct(lat, 0.5)}ms · p95 ${pct(lat, 0.95)}ms · max ${pct(lat, 1)}ms`);
  const overTimeout = lat.filter((x) => x > 20_000).length;
  console.log(`  ${overTimeout ? RED : GREEN}เกิน timeout 20,000ms ที่ C.2 จะตั้ง: ${overTimeout} call (${share(overTimeout, n)})${RESET}`);

  // ── สรุปเป็นคำแนะนำ ──
  console.log(`\n${BOLD}══ อ่านผล ══${RESET}`);
  if (nFail === 0) {
    console.log(`  ${YEL}ไม่มี call ไหนพลาดเลยใน ${n} call${RESET} — ที่โหลดปกติ retry แทบไม่มีของให้กู้`);
    console.log(`  ${DIM}⇒ อย่าเพิ่งสรุปว่า retry ไร้ประโยชน์: มันมีไว้กัน failure mode ตอนโมเดล/เครือข่ายแกว่ง`);
    console.log(`     ซึ่งไม่โผล่ในกลุ่มตัวอย่างขนาดนี้ ⇒ เก็บ MAX_EXTRACTION_ATTEMPTS=3 ไว้ แล้วให้ deadline`);
    console.log(`     ของ C.2 เป็นตัวคุมแทน (มีเวลาก็ retry, ไม่มีก็หยุด) ตรงกับที่แผนเลือกไว้${RESET}`);
  } else if (at(2) + at(3) > 0) {
    console.log(`  ${GREEN}retry กู้ได้จริง${RESET} ${at(2)} รอบที่ attempt 2 และ ${at(3)} รอบที่ attempt 3`);
    console.log(`  ${DIM}⇒ ชั้นที่ 3 ${at(3) > 0 ? 'มีของให้กู้ — เก็บไว้' : 'ยังไม่เห็นว่ากู้อะไรได้ แต่ราคาถูก (จ่ายเฉพาะตอนพลาด) — เก็บไว้'}${RESET}`);
  } else {
    console.log(`  ${RED}มี call พลาด ${share(nFail, n)} แต่ retry ไม่เคยกู้สำเร็จ${RESET} — ความพลาดอาจไม่ flaky แต่เป็นระบบ`);
    console.log(`  ${DIM}⇒ ดู detail ด้านล่างก่อนตัดสินใจว่าจะ retry ต่อไหม${RESET}`);
  }

  const bad = results.filter((r) => r.status !== 'ok');
  if (bad.length) {
    console.log(`\n  ${BOLD}เคสที่พลาด:${RESET}`);
    for (const b of bad.slice(0, 20))
      console.log(`    ${RED}✗${RESET} msg#${b.msgId} round ${b.round} ${b.status} ${DIM}${b.detail || ''}${RESET}`);
    if (bad.length > 20) console.log(`    ${DIM}… อีก ${bad.length - 20} รายการ${RESET}`);
  }
  console.log('');
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
