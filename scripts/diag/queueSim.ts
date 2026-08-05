// ─────────────────────────────────────────────────────────────────────────────
//  queueSim — จำลองโหลดเข้า KeyedTaskQueue "ตัวจริงตัวเดียวกับ prod"
//  (services/webhookQueue.ts) เพื่อจูน deadline / maxConcurrency ก่อนแตะโค้ดจริง
//
//  รัน:  npm run diag:queue-sim
//        npm run diag:queue-sim -- --n 100 --pattern burst
//        npm run diag:queue-sim -- --pattern poisson --rate 8 --n 200
//        npm run diag:queue-sim -- --slow 2        (จำลองตอน sync แย่ง CPU: handler ช้า 2 เท่า)
//        npm run diag:queue-sim -- --concurrency 6 --margin 12000
//
//  ไม่มีผลข้างเคียงใด ๆ: ไม่มี HTTP · ไม่มี DB · ไม่มี LLM · ไม่แตะ LINE
//
//  เทียบ 2 โหมดด้วย event ชุดเดียวกันเป๊ะ (seed เดียวกัน):
//    legacy   = ของปัจจุบัน — setTimeout 25s เริ่มนับตอน "ถูกดึงออกจากคิว" ไม่นับเวลารอคิว
//    deadline = ของ C.1    — นาฬิกาเริ่มที่ receivedAt, timeout = งบที่เหลือ, DROP ถ้าหมดงบก่อนเริ่ม
//
//  ผลลัพธ์แยกตามสิ่งที่ "ผู้ใช้เห็นจริง" ไม่ใช่สิ่งที่โค้ดคิดว่าสำเร็จ:
//    delivered          เสร็จภายในงบ (TTL − margin) → ได้คำตอบแน่นอน
//    riskyReply         เสร็จที่ total ระหว่างงบ ถึง TTL → ได้คำตอบก็ต่อเมื่อ network + เวลาที่
//                       replyMessage เองใช้ ไม่กินเกิน margin — sim ไม่ได้จำลองสองอย่างนี้
//                       จึงฟันธงไม่ได้ ใช้ตัวเลขนี้จูน SAFETY_MARGIN_MS
//    lateReply          ทำงานจนเสร็จ แต่ total เกิน TTL → token ตายแน่ ผู้ใช้เงียบ (failure mode ของ legacy)
//    timedOut           handler ถูกตัดกลางคัน
//    droppedBeforeStart ทิ้งตั้งแต่ยังไม่เริ่ม เพราะรอคิวจนหมดงบ (มีเฉพาะโหมด deadline)
//
//  ⚠️ ข้อจำกัดของ sim: จำลอง "เวลา" อย่างเดียว ไม่ได้จำลอง CPU contention — งานผีที่ C-3 พูดถึง
//     (handler ที่ timeout แล้วยังรันกิน CPU ต่อ) จึงไม่ปรากฏในตัวเลขนี้ ของจริงจะแย่กว่าที่เห็น
//
//  ⚠️ distribution ของ handler เป็น "สมมติฐาน" (LLM p50 ~2s + DB/PDF) ไม่ใช่ค่าที่วัดจาก prod
//     พอ C.5 มี log `[queue] processed` จริงแล้ว ให้ป้อนกลับเข้ามาผ่าน --p50/--p95/--p99/--max
// ─────────────────────────────────────────────────────────────────────────────
import { KeyedTaskQueue, replyBudget, REPLY_TOKEN_TTL_MS, SAFETY_MARGIN_MS } from '../../services/webhookQueue.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YEL = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

// ── args ──
function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cfg = {
  pattern: argStr('pattern', 'burst') as 'burst' | 'poisson',
  n: arg('n', 100),                        // จำนวน event
  rate: arg('rate', 8),                    // event/วินาที (เฉพาะ poisson)
  users: arg('users', 0),                  // 0 = ทุก event คนละ user
  concurrency: arg('concurrency', 12),     // ต้องตรงกับ new KeyedTaskQueue(12) ใน index.ts
  ttl: arg('ttl', REPLY_TOKEN_TTL_MS),     // อายุ replyToken นับจากรับ webhook
  margin: arg('margin', SAFETY_MARGIN_MS), // SAFETY_MARGIN_MS ของ C.1
  legacyTimeout: arg('legacy-timeout', 25_000), // index.ts เดิม
  slow: arg('slow', 1),                    // ตัวคูณความช้าของ handler
  speed: arg('speed', 20),                 // บีบเวลาให้รันจบไว (บัญชีเวลาทั้งหมดเป็น "ms เสมือน")
  seed: arg('seed', 42),
  // distribution ของเวลาประมวลผล handler (ms) — inverse-CDF แบบ piecewise linear
  p50: arg('p50', 2_500),
  p95: arg('p95', 6_000),
  p99: arg('p99', 12_000),
  max: arg('max', 25_000),
};
const BUDGET = cfg.ttl - cfg.margin;

// ── PRNG แบบมี seed: รันซ้ำได้ผลเดิม และสองโหมดได้ event ชุดเดียวกันเป๊ะ ──
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// inverse-CDF: แปลง u∈[0,1) เป็นเวลาประมวลผล ตาม anchor ที่ตั้งไว้
const ANCHORS: [number, number][] = [
  [0.00, Math.round(cfg.p50 * 0.35)],
  [0.50, cfg.p50],
  [0.95, cfg.p95],
  [0.99, cfg.p99],
  [1.00, cfg.max],
];
function sampleDuration(u: number): number {
  for (let i = 1; i < ANCHORS.length; i++) {
    const [q0, v0] = ANCHORS[i - 1], [q1, v1] = ANCHORS[i];
    if (u <= q1) return Math.round(v0 + ((u - q0) / (q1 - q0)) * (v1 - v0));
  }
  return cfg.max;
}

interface EventPlan { id: number; key: string; arrival: number; duration: number; }

function buildPlan(): EventPlan[] {
  const rnd = mulberry32(cfg.seed);
  const plan: EventPlan[] = [];
  let t = 0;
  for (let i = 0; i < cfg.n; i++) {
    if (cfg.pattern === 'poisson') t += -Math.log(1 - rnd()) / cfg.rate * 1000;
    const key = cfg.users > 0 ? `U${i % cfg.users}` : `U${i}`;
    plan.push({ id: i, key, arrival: Math.round(t), duration: Math.round(sampleDuration(rnd()) * cfg.slow) });
  }
  return plan;
}

type Outcome = 'delivered' | 'riskyReply' | 'lateReply' | 'timedOut' | 'droppedBeforeStart';
interface Rec { id: number; waited: number; processed: number; total: number; outcome: Outcome; }

async function runMode(mode: 'legacy' | 'deadline', plan: EventPlan[]) {
  const q = new KeyedTaskQueue(cfg.concurrency);
  const t0 = Date.now();
  const vnow = () => (Date.now() - t0) * cfg.speed;                       // เวลาเสมือน (ms)
  const sleepV = (v: number) => new Promise((r) => setTimeout(r, Math.max(0, v / cfg.speed)));
  const recs: Rec[] = [];
  let maxActive = 0;

  await Promise.all(plan.map((ev) => new Promise<void>((pushed) => {
    setTimeout(() => {
      const receivedAt = vnow();                    // ◀ นาฬิกาเริ่มตรงนี้ (C.1)
      q.push(ev.key, async () => {
        if (q.activeCount > maxActive) maxActive = q.activeCount;
        const startedAt = vnow();
        // ใช้ตัวคำนวณงบ "ตัวเดียวกับ index.ts" ป้อนเวลาเสมือนเข้าไป
        const { waited, remaining, expired } = replyBudget(receivedAt, startedAt, BUDGET);

        let limit: number;
        if (mode === 'deadline') {
          if (expired) {
            recs.push({ id: ev.id, waited, processed: 0, total: waited, outcome: 'droppedBeforeStart' });
            return;
          }
          limit = remaining;
        } else {
          limit = cfg.legacyTimeout;                // ของเดิม: คงที่ ไม่สนว่ารอคิวมานานแค่ไหน
        }

        const ran = Math.min(ev.duration, limit);
        await sleepV(ran);
        const processed = vnow() - startedAt;
        const total = vnow() - receivedAt;
        const outcome: Outcome = ev.duration > limit ? 'timedOut'
          : total <= BUDGET ? 'delivered'
          : total <= cfg.ttl ? 'riskyReply' : 'lateReply';
        recs.push({ id: ev.id, waited, processed, total, outcome });
      });
      pushed();
    }, ev.arrival / cfg.speed);
  })));

  await q.drain(600_000);
  return { recs, maxActive, wallMs: Date.now() - t0 };
}

// ── สถิติ ──
const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};
const share = (n: number, total: number) => `${((n / total) * 100).toFixed(1)}%`;

function report(label: string, r: Awaited<ReturnType<typeof runMode>>) {
  const { recs, maxActive } = r;
  const n = recs.length;
  const by = (o: Outcome) => recs.filter((x) => x.outcome === o);
  const delivered = by('delivered'), risky = by('riskyReply'), late = by('lateReply');
  const timedOut = by('timedOut'), dropped = by('droppedBeforeStart');
  const waits = recs.map((x) => x.waited);
  const totals = recs.map((x) => x.total);
  const overBudget = recs.filter((x) => x.total > BUDGET).length;
  // เวลาที่เผาไปกับงานที่ผู้ใช้ไม่ได้คำตอบ (late + timeout) — CPU ที่แย่งจากคนที่ยังตอบทัน
  const wasted = [...late, ...timedOut].reduce((s, x) => s + x.processed, 0);

  const okCol = delivered.length === n ? GREEN : RED;
  console.log(`\n${BOLD}── ${label} ──${RESET}  ${DIM}(${n} event)${RESET}`);
  console.log(`  ${okCol}delivered          ${delivered.length.toString().padStart(4)}  ${share(delivered.length, n).padStart(6)}${RESET}  ${DIM}เสร็จภายในงบ → ได้คำตอบแน่นอน${RESET}`);
  console.log(`  ${risky.length ? YEL : DIM}riskyReply         ${risky.length.toString().padStart(4)}  ${share(risky.length, n).padStart(6)}${RESET}  ${DIM}total ${BUDGET}–${cfg.ttl}ms → ชิดขอบ token ฟันธงไม่ได้${RESET}`);
  console.log(`  ${late.length ? RED : DIM}lateReply          ${late.length.toString().padStart(4)}  ${share(late.length, n).padStart(6)}${RESET}  ${DIM}ตอบเสร็จแต่ token ตายแน่ → เงียบ${RESET}`);
  console.log(`  ${timedOut.length ? YEL : DIM}timedOut           ${timedOut.length.toString().padStart(4)}  ${share(timedOut.length, n).padStart(6)}${RESET}  ${DIM}handler ถูกตัด${RESET}`);
  console.log(`  ${dropped.length ? YEL : DIM}droppedBeforeStart ${dropped.length.toString().padStart(4)}  ${share(dropped.length, n).padStart(6)}${RESET}  ${DIM}ทิ้งตั้งแต่ยังไม่เริ่ม${RESET}`);
  console.log(`  ${DIM}────${RESET}`);
  console.log(`  total > งบ ${BUDGET}ms : ${overBudget > 0 ? RED : GREEN}${overBudget} (${share(overBudget, n)})${RESET}`);
  console.log(`  เวลารอคิว   p50 ${pct(waits, 0.5)}ms · p95 ${pct(waits, 0.95)}ms · max ${pct(waits, 1)}ms`);
  console.log(`  total       p50 ${pct(totals, 0.5)}ms · p95 ${pct(totals, 0.95)}ms · max ${pct(totals, 1)}ms`);
  console.log(`  activeCount สูงสุด ${maxActive}/${cfg.concurrency}`);
  console.log(`  ${DIM}เวลาที่เผาทิ้งกับงานที่ตอบไม่ถึงผู้ใช้: ${(wasted / 1000).toFixed(1)}s${RESET}`);
  return { delivered: delivered.length, risky: risky.length, late: late.length, timedOut: timedOut.length, dropped: dropped.length, overBudget, n };
}

async function main() {
  console.log(`${BOLD}Queue Simulation${RESET} — คิวตัวจริงจาก services/webhookQueue.ts`);
  console.log(`${DIM}pattern=${cfg.pattern}${cfg.pattern === 'poisson' ? ` rate=${cfg.rate}/s` : ''} n=${cfg.n} users=${cfg.users || 'ทุกคนคนละ key'} concurrency=${cfg.concurrency}${RESET}`);
  console.log(`${DIM}handler p50=${cfg.p50} p95=${cfg.p95} p99=${cfg.p99} max=${cfg.max} ms${cfg.slow !== 1 ? ` ×${cfg.slow} (slow)` : ''} · seed=${cfg.seed} · speed=${cfg.speed}×${RESET}`);
  console.log(`${DIM}replyToken TTL=${cfg.ttl}ms · margin=${cfg.margin}ms → ${CYAN}BUDGET=${BUDGET}ms${RESET}`);

  const plan = buildPlan();
  const legacy = await runMode('legacy', plan);
  const deadline = await runMode('deadline', plan);

  const a = report(`legacy — timeout คงที่ ${cfg.legacyTimeout}ms เริ่มนับตอน dequeue (ของปัจจุบัน)`, legacy);
  const b = report(`deadline — นับจาก receivedAt, งบ ${BUDGET}ms (C.1)`, deadline);

  console.log(`\n${BOLD}══ เทียบ ══${RESET}`);
  const silentA = a.late + a.timedOut, silentB = b.late + b.timedOut + b.dropped;
  console.log(`  ได้คำตอบแน่นอน : legacy ${a.delivered} (${share(a.delivered, a.n)})  →  deadline ${b.delivered} (${share(b.delivered, b.n)})`);
  console.log(`  ชิดขอบ token   : legacy ${a.risky} (${share(a.risky, a.n)})  →  deadline ${b.risky} (${share(b.risky, b.n)})`);
  console.log(`  เงียบแน่นอน    : legacy ${silentA} (${share(silentA, a.n)})  →  deadline ${silentB} (${share(silentB, b.n)})`);
  console.log(`\n  ${DIM}อ่านตัวเลขนี้อย่างไร: deadline ไม่ได้ทำให้เร็วขึ้น มันแค่ "ตัดสินใจแทน" ว่างานที่จะเกินงบ`);
  console.log(`  ให้ทิ้งตั้งแต่ยังไม่เริ่ม แทนที่จะเผา CPU แล้วไปตายทีหลัง ⇒ ตัวเลข "เงียบ" ของ deadline`);
  console.log(`  จึงอาจ ${BOLD}มากกว่า${RESET}${DIM} legacy ในการนับหัวดิบ ๆ แต่กับ ${a.risky} เคสที่ legacy ตอบแบบชิดขอบนั้น`);
  console.log(`  sim ไม่ได้จำลอง network + เวลาที่ replyMessage ใช้ จึงไม่ใช่ชัยชนะของ legacy`);
  console.log(`  และ sim ไม่ได้จำลอง CPU contention ด้วย ⇒ ประโยชน์ของ deadline (คืน CPU/slot ให้คน`);
  console.log(`  ที่ยังตอบทัน) ถูกตัดออกจากตัวเลขนี้ทั้งหมด ของจริงจะดีกว่าที่เห็น${RESET}`);

  if (a.risky > 0)
    console.log(`\n  ${YEL}⓵ margin ${cfg.margin}ms: มี ${a.risky} เคส (${share(a.risky, a.n)}) ที่ตกในช่วง ${BUDGET}–${cfg.ttl}ms${RESET} ${DIM}— ลอง --margin เพื่อดูว่าตัดทิ้งมากไปไหม${RESET}`);
  if (b.dropped > 0)
    console.log(`  ${YEL}⓶ droppedBeforeStart ${share(b.dropped, b.n)} — คิวยาวเกินงบ${RESET} ${DIM}ลอง --concurrency ดูได้ แต่ระวัง: sim ไม่มี CPU contention`);
  if (b.dropped > 0)
    console.log(`     การเพิ่มสล็อตจึงดู "ดีขึ้น" เสมอ ทั้งที่บนเครื่อง 4 cores ของจริงจะช้าลงต่อชิ้น`);
  if (b.dropped > 0)
    console.log(`     ให้จำลองด้วย --concurrency N คู่กับ --slow (ตัวคูณความช้าต่อชิ้น) ถึงจะได้ภาพจริง${RESET}`);

  if (b.delivered === b.n) {
    console.log(`\n  ${GREEN}✔ ที่โหลดนี้ ทุก event เสร็จภายในงบ ${BUDGET}ms${RESET}`);
  } else {
    console.log(`\n  ${RED}✖ ที่โหลดนี้ มี ${share(b.n - b.delivered, b.n)} ที่ไม่เสร็จภายในงบแม้ใช้ deadline${RESET} ${DIM}— ต้องลด latency ต่อ (ส่วน B)${RESET}`);
  }
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
