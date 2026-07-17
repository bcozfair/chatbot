// ─────────────────────────────────────────────────────────────────────────────
//  Diagnostic runner — ทดสอบ "เฉพาะชั้น extraction (LLM)" แบบ isolated
//  ยิงเคสจริงเข้า prompt เดียวกับ production (mirror lineHandler.ts:1179-1256)
//  แล้วเทียบ field-by-field ว่าอะไรพัง — ไม่แตะ handler / ไม่แตะ DB
//
//  รัน:  npx tsx scripts/diag/runExtractionDiag.ts
//        npx tsx scripts/diag/runExtractionDiag.ts pos-start   (เจาะเคสเดียว)
//
//  ⚠️ PROMPT ด้านล่างคัดลอกจาก lineHandler เพื่อวินิจฉัย ถ้าแก้ prompt ใน handler
//     ต้อง sync ที่นี่ด้วย (ตั้งใจ duplicate เพื่อไม่ให้ diagnostic ไปแตะ production flow)
// ─────────────────────────────────────────────────────────────────────────────
import { openai } from '../../config/clients.js';
import { CASES, type DiagCase } from './extractionCases.js';
import { buildExtractionPrompt, parseAiJson, evaluate, type Check } from './extractionCore.js';

const MODEL = 'deepseek-v4-flash'; // ตรงกับ lineHandler.ts:1258

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YEL = '\x1b[33m', RESET = '\x1b[0m';

async function runOne(c: DiagCase) {
  let ai: any = null;
  let rawText = '';
  let error: string | null = null;
  const t0 = Date.now();
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: buildExtractionPrompt(c.message) }],
      response_format: { type: 'json_object' },
    });
    rawText = res.choices[0]?.message?.content || '';
    ai = parseAiJson(rawText);
  } catch (err: any) {
    error = err?.message || String(err);
  }
  const ms = Date.now() - t0;

  const checks = error ? [] : evaluate(c, ai);
  const failed = checks.filter((k) => !k.ok);
  const status = error ? `${RED}ERROR${RESET}` : failed.length === 0 ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;

  console.log(`\n${BOLD}[${c.id}]${RESET} ${DIM}(${c.category})${RESET} ${status} ${DIM}${ms}ms${RESET}`);
  console.log(`  ${DIM}${c.note}${RESET}`);
  console.log(`  ${DIM}msg:${RESET} ${c.message.replace(/\n/g, ' ⏎ ')}`);
  if (error) {
    console.log(`  ${RED}✖ API/parse error:${RESET} ${error}`);
    if (rawText) console.log(`  ${DIM}raw:${RESET} ${rawText.slice(0, 200)}`);
  } else {
    for (const k of checks) {
      const mark = k.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const detail = k.ok ? '' : `  ${DIM}want=${JSON.stringify(k.want)} got=${JSON.stringify(k.got)}${RESET}`;
      console.log(`    ${mark} ${k.field}${detail}`);
    }
  }
  return { c, ok: !error && failed.length === 0, error: !!error, checks, failed, ai, rawText };
}

async function main() {
  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.id === filter || c.category.startsWith(filter)) : CASES;
  if (cases.length === 0) {
    console.error(`ไม่พบเคส "${filter}" — id ที่มี: ${CASES.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`${BOLD}Extraction Diagnostic${RESET} — model=${YEL}${MODEL}${RESET} — ${cases.length} เคส`);

  const results = [];
  for (const c of cases) results.push(await runOne(c)); // sequential กัน rate-limit

  // ── สรุป ──
  const pass = results.filter((r) => r.ok).length;
  const errs = results.filter((r) => r.error).length;
  console.log(`\n${BOLD}══ สรุป ══${RESET}`);
  console.log(`  ${GREEN}PASS ${pass}${RESET} / ${RED}FAIL ${cases.length - pass - errs}${RESET} / ${YEL}ERROR ${errs}${RESET}  (จาก ${cases.length})`);

  // สรุปรายหมวด
  const byCat = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const g = byCat.get(r.c.category) || { pass: 0, total: 0 };
    g.total++; if (r.ok) g.pass++;
    byCat.set(r.c.category, g);
  }
  console.log(`\n  ${BOLD}รายหมวด:${RESET}`);
  for (const [cat, g] of [...byCat].sort()) {
    const bad = g.total - g.pass;
    const col = bad === 0 ? GREEN : RED;
    console.log(`    ${col}${cat}: ${g.pass}/${g.total}${RESET}`);
  }

  // รวมทุก field ที่ fail (ไล่หา pattern ความพัง)
  const failLines = results.filter((r) => !r.ok && !r.error);
  if (failLines.length) {
    console.log(`\n  ${BOLD}${RED}จุดที่พัง (field ที่ ✗):${RESET}`);
    for (const r of failLines)
      console.log(`    ${RED}✗${RESET} ${r.c.id}: ${r.failed.map((k) => k.field.trim()).join(', ')}`);
  }

  console.log('');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
