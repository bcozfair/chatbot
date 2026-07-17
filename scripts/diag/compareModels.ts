// ─────────────────────────────────────────────────────────────────────────────
//  Model comparison — วัด latency + reliability + correctness ของหลายโมเดล
//  บน corpus เดียวกัน (prompt เดียวกับ production) รันหลายรอบเพื่อจับ flakiness
//
//  รัน:  npx tsx scripts/diag/compareModels.ts
//        REPEATS=3 npx tsx scripts/diag/compareModels.ts deepseek-chat deepseek-reasoner
//
//  metric:
//   - error/empty rate  = % ครั้งที่คืน content ว่าง หรือ parse JSON ไม่ได้ (= failure mode จริงใน production)
//   - latency p50/p95/max
//   - logic-pass rate    = % ของครั้งที่ parse ได้ แล้วสกัดถูกทุก field (เทียบ correctness ข้ามโมเดล)
// ─────────────────────────────────────────────────────────────────────────────
import { openai } from '../../config/clients.js';
import { CASES } from './extractionCases.js';
import { buildExtractionPrompt, parseAiJson, evaluate } from './extractionCore.js';

const MODELS = process.argv.slice(2).filter(Boolean);
const MODEL_LIST = MODELS.length ? MODELS : ['deepseek-v4-flash', 'deepseek-chat'];
const REPEATS = Number(process.env.REPEATS || 2);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YEL = '\x1b[33m', CYA = '\x1b[36m', RESET = '\x1b[0m';

interface CallResult {
  model: string;
  caseId: string;
  ms: number;
  failed: boolean;     // content ว่าง หรือ parse ไม่ได้ (failure mode ที่ทำให้ prod ตกไป UNCLEAR)
  reason?: string;
  logicPass?: boolean; // parse ได้ แล้ว field ครบถูก
}

// spec รูปแบบ "deepseek-v4-flash+nothink" → ปิด thinking mode (deepseek แบบใหม่ default = thinking)
//            "deepseek-v4-flash+think"   → เปิด thinking mode ชัดเจน
function parseSpec(spec: string): { model: string; extra: Record<string, any> } {
  const [model, flag] = spec.split('+');
  if (flag === 'nothink') return { model, extra: { thinking: { type: 'disabled' } } };
  if (flag === 'think') return { model, extra: { thinking: { type: 'enabled' } } };
  return { model, extra: {} };
}

async function oneCall(spec: string, c: (typeof CASES)[number]): Promise<CallResult> {
  const t0 = Date.now();
  const { model, extra } = parseSpec(spec);
  try {
    const res = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: buildExtractionPrompt(c.message) }],
      response_format: { type: 'json_object' },
      max_tokens: 8192,
      ...extra,
    } as any);
    const raw = res.choices[0]?.message?.content || '';
    const ms = Date.now() - t0;
    if (!raw.trim()) return { model: spec, caseId: c.id, ms, failed: true, reason: 'empty-content' };
    let ai: any;
    try { ai = parseAiJson(raw); }
    catch { return { model: spec, caseId: c.id, ms, failed: true, reason: 'json-parse' }; }
    const failedChecks = evaluate(c, ai).filter((k) => !k.ok);
    return { model: spec, caseId: c.id, ms, failed: false, logicPass: failedChecks.length === 0 };
  } catch (err: any) {
    return { model: spec, caseId: c.id, ms: Date.now() - t0, failed: true, reason: `api:${err?.status || err?.message || err}` };
  }
}

// concurrency pool ง่ายๆ
async function runPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]);
    }
  });
  await Promise.all(workers);
  return out;
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

async function main() {
  const jobs: { model: string; c: (typeof CASES)[number] }[] = [];
  for (const model of MODEL_LIST)
    for (let r = 0; r < REPEATS; r++)
      for (const c of CASES) jobs.push({ model, c });

  console.log(`${BOLD}Model Comparison${RESET} — models=[${YEL}${MODEL_LIST.join(', ')}${RESET}] × ${CASES.length} เคส × ${REPEATS} รอบ = ${jobs.length} calls (concurrency ${CONCURRENCY})`);
  console.log(`${DIM}กำลังรัน... อาจใช้เวลาสักครู่${RESET}\n`);

  const t0 = Date.now();
  let done = 0;
  const results = await runPool(jobs, CONCURRENCY, async (j) => {
    const r = await oneCall(j.model, j.c);
    done++;
    if (done % 10 === 0 || done === jobs.length) process.stdout.write(`\r${DIM}  ${done}/${jobs.length} เสร็จ${RESET}   `);
    return r;
  });
  console.log(`\n${DIM}รวมเวลา ${(Date.now() - t0) / 1000}s${RESET}\n`);

  // ── aggregate per model ──
  console.log(`${BOLD}${'โมเดล'.padEnd(22)} calls  ${RED}fail%${RESET}   ${CYA}lat avg${RESET}   p50    p95    max    ${GREEN}logic-pass%${RESET}${RESET}`);
  console.log(DIM + '─'.repeat(84) + RESET);

  const perModel: Record<string, CallResult[]> = {};
  for (const r of results) (perModel[r.model] ||= []).push(r);

  for (const model of MODEL_LIST) {
    const rs = perModel[model] || [];
    const fails = rs.filter((r) => r.failed);
    const oks = rs.filter((r) => !r.failed);
    const lats = rs.map((r) => r.ms);
    const logicPass = oks.filter((r) => r.logicPass).length;
    const failRate = rs.length ? (fails.length / rs.length) * 100 : 0;
    const logicRate = oks.length ? (logicPass / oks.length) * 100 : 0;
    const failCol = failRate === 0 ? GREEN : failRate < 3 ? YEL : RED;

    console.log(
      `${model.padEnd(22)} ${String(rs.length).padStart(4)}  ` +
      `${failCol}${(failRate.toFixed(1) + '%').padStart(6)}${RESET}  ` +
      `${CYA}${(avg(lats) + 'ms').padStart(7)}${RESET}  ` +
      `${(pct(lats, 50) + '').padStart(5)}  ${(pct(lats, 95) + '').padStart(5)}  ${(Math.max(...lats, 0) + '').padStart(5)}  ` +
      `${GREEN}${(logicRate.toFixed(1) + '%').padStart(9)}${RESET}`
    );
  }

  // ── รายละเอียด failure ต่อโมเดล ──
  for (const model of MODEL_LIST) {
    const fails = (perModel[model] || []).filter((r) => r.failed);
    if (!fails.length) continue;
    const byReason = new Map<string, string[]>();
    for (const f of fails) {
      const key = f.reason || 'unknown';
      if (!byReason.has(key)) byReason.set(key, []);
      byReason.get(key)!.push(f.caseId);
    }
    console.log(`\n  ${RED}✖ ${model} — fail ${fails.length} ครั้ง:${RESET}`);
    for (const [reason, ids] of byReason)
      console.log(`    ${DIM}${reason}${RESET} ×${ids.length}: ${ids.join(', ')}`);
  }

  // ── logic-fail (parse ได้ แต่สกัดผิด) ต่อโมเดล ──
  for (const model of MODEL_LIST) {
    const wrong = (perModel[model] || []).filter((r) => !r.failed && !r.logicPass);
    if (!wrong.length) continue;
    const ids = [...new Set(wrong.map((r) => r.caseId))];
    console.log(`\n  ${YEL}△ ${model} — สกัดผิด (logic) ${wrong.length} ครั้ง ที่เคส:${RESET} ${ids.join(', ')}`);
  }

  console.log('');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
