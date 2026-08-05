// ─────────────────────────────────────────────────────────────────────────────
//  loadProbe — วัด "เพดานจริง" ของเครื่องนี้ เพื่อตอบว่า maxConcurrency ควรเป็นเท่าไหร่
//  โดยไม่ต้องรอ log จาก prod และไม่ต้อง deploy อะไรทั้งสิ้น
//
//  queueSim ตอบไม่ได้ 2 เรื่องเพราะมันจำลองแค่ "เวลา": CPU contention กับ pool ของ DB
//  สคริปต์นี้วัดสองเรื่องนั้นด้วยของจริง — โค้ดจริง · DB จริง · เครื่องจริง
//
//  รัน:  npm run diag:load-probe                    (ครบทั้ง 3 โหมด)
//        npm run diag:load-probe -- --mode cpu      (เฉพาะ CPU — ไม่แตะ DB เลยหลัง warmup)
//        npm run diag:load-probe -- --mode db       (เฉพาะ DB + pool)
//        npm run diag:load-probe -- --ops 60 --max-concurrency 48
//
//  ⚠️ อ่านอย่างเดียว (SELECT) ไม่เขียน ไม่เรียก LLM ไม่เรียก LINE
//  ⚠️ แต่ "กินทรัพยากรจริง" — โหมด db ยิง query เข้า DB ตัวเดียวกับที่ prod ใช้อยู่
//     ถ้ารันในเวลาทำงานจะไปแย่งกับเซลส์จริง ให้ใช้ --ops น้อย ๆ หรือรันนอกเวลาทำงาน
//
//  สิ่งที่จะได้: ตารางกวาดค่า concurrency แล้วดูว่า "หัวเข่า" (จุดที่ latency พุ่งแต่ throughput
//  ไม่เพิ่มแล้ว) อยู่ตรงไหน — จุดนั้นคือเพดานจริงของเครื่อง ไม่ใช่เลขที่เดาเอา
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { searchCustomersNormalized } from '../../services/customerService.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', BOLD = '\x1b[1m', YEL = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

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

const MODE = argStr('mode', 'all') as 'all' | 'cpu' | 'db' | 'mixed';
const OPS = Math.max(4, arg('ops', 40));                       // จำนวน op ต่อระดับ concurrency
const MAX_CONC = Math.max(1, arg('max-concurrency', 48));
const LEVELS = [1, 2, 4, 8, 12, 16, 24, 32, 40, 48].filter((c) => c <= MAX_CONC);

// คำค้นจริงที่เซลส์ใช้ — หมุนเวียนกันไปไม่ให้ผลถูก cache ของ Postgres บิด
const COMPANY_QUERIES = [
  'บริษัท ทองดี แมชชีนเนอรี่', 'บ.ช.ไพบูลย์วิศวกรรม', 'ซีซีแอล ลาเบิล', 'บ.เคอาร์เค ซัพพลาย',
  'บ.เจมินี ยูนิเวอร์แซล', 'จันทบุรีผลิตผลเครื่องดื่ม', 'บ.ไพลอตอินโนเวชั่น', 'บ.มิลลิเมด',
];
const PRODUCT_QUERIES = ['vpm-06', 'PS-02N1-25', 'motor', 'SI18', 'TCM-94N', 'HP-03', 'DCM-001N', 'PE-2700'];

// query สินค้า — ตัวเดียวกับ GET /api/products/search (index.ts) หลังใส่ index ของส่วน A แล้ว
const PRODUCT_SQL = `
  SELECT p.model AS code, p.name, p.sales_price AS price, p.production,
         p.quantity_on_hand_unreserved AS stock, p.internal_reference, p.brand,
         sr.is_active AS stock_rule_active
    FROM products p
    LEFT JOIN product_stock_rules sr ON p.internal_reference = sr.internal_reference
   WHERE (p.model ILIKE $1 OR p.name ILIKE $1 OR p.internal_reference ILIKE $1
          OR p.brand ILIKE $1 OR p.product_template_id::text = $2)
     AND (p.production IS NULL OR LOWER(REPLACE(p.production, ' ', '')) NOT LIKE '%buytosell%')
     AND p.is_system_item = false
   ORDER BY p.quantity_on_hand_unreserved DESC
   LIMIT 150`;

// ── ปิดเสียง log ของโค้ด production ระหว่างวัด (searchCustomersNormalized log ทุกครั้งที่เรียก) ──
const realLog = console.log;
const mute = () => { console.log = () => {}; };
const unmute = () => { console.log = realLog; };

/**
 * วัด event loop lag เอง: ตั้ง timer ทุก 20ms แล้วดูว่ามันมาสายไปเท่าไหร่
 * (perf_hooks.monitorEventLoopDelay เก็บ sample ไม่ได้เลยในสคริปต์นี้ — คืน count 0)
 * "สาย 500ms" = ช่วงนั้น event loop ถูกงาน synchronous ยึดไว้ 500ms ไม่มีใครได้คิว
 */
function startLagSampler(intervalMs = 20) {
  const lags: number[] = [];
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const lag = Number(now - last) / 1e6 - intervalMs;
    lags.push(Math.max(0, lag));
    last = now;
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      return lags;
    },
  };
}

const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};

interface LevelResult {
  conc: number; ops: number; wallMs: number; thr: number;
  p50: number; p95: number; max: number;
  loopMean: number; loopP95: number; loopMax: number;
  poolWaitMax: number; poolTotalMax: number; errors: number; errSample: string;
}

/** รัน op N ครั้งที่ concurrency ที่กำหนด แล้ววัดทุกอย่าง */
async function runLevel(conc: number, op: (i: number) => Promise<void>): Promise<LevelResult> {
  const lat: number[] = [];
  let errors = 0, errSample = '';
  let poolWaitMax = 0, poolTotalMax = 0;

  const poolSampler = setInterval(() => {
    if (pool.waitingCount > poolWaitMax) poolWaitMax = pool.waitingCount;
    if (pool.totalCount > poolTotalMax) poolTotalMax = pool.totalCount;
  }, 20);
  poolSampler.unref?.();

  const lagSampler = startLagSampler();
  const t0 = Date.now();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(conc, OPS) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= OPS) return;
      const s = Date.now();
      try {
        await op(i);
        lat.push(Date.now() - s);
      } catch (e: any) {
        errors++;
        if (!errSample) errSample = e?.message || String(e);
      }
    }
  }));
  const wallMs = Date.now() - t0;
  const lags = lagSampler.stop();
  clearInterval(poolSampler);

  return {
    conc, ops: OPS, wallMs, thr: Math.round((OPS / wallMs) * 1000 * 10) / 10,
    p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: pct(lat, 1),
    loopMean: pct(lags, 0.5), loopP95: pct(lags, 0.95), loopMax: pct(lags, 1),
    poolWaitMax, poolTotalMax, errors, errSample,
  };
}

function printTable(title: string, note: string, results: LevelResult[]) {
  console.log(`\n${BOLD}══ ${title} ══${RESET}`);
  console.log(`${DIM}${note}${RESET}`);
  console.log(`${DIM}  conc   ops/s   p50     p95     max   │ event loop ถูกบล็อก   │ pool      │ error${RESET}`);
  console.log(`${DIM}                                        │  p50    p95    max    │ wait tot  │${RESET}`);
  let best = 0;
  for (const r of results) if (r.thr > best) best = r.thr;
  for (const r of results) {
    // "หัวเข่า" = ระดับที่ throughput ยังอยู่ใน 95% ของค่าดีที่สุด
    const good = r.thr >= best * 0.95;
    const col = r.errors ? RED : good ? GREEN : YEL;
    console.log(
      `${col}  ${String(r.conc).padStart(4)}  ${String(r.thr).padStart(6)}  ` +
      `${String(r.p50).padStart(5)}ms ${String(r.p95).padStart(5)}ms ${String(r.max).padStart(5)}ms │ ` +
      `${String(r.loopMean).padStart(5)}ms ${String(r.loopP95).padStart(5)}ms ${String(r.loopMax).padStart(5)}ms │ ` +
      `${String(r.poolWaitMax).padStart(4)} ${String(r.poolTotalMax).padStart(3)} │ ` +
      `${r.errors ? `${r.errors} ${r.errSample.slice(0, 40)}` : '-'}${RESET}`
    );
  }
}

/** ระดับที่ throughput สูงสุดโดยยังไม่มี error — คือเพดานที่ใช้ได้จริง */
function knee(results: LevelResult[]): LevelResult {
  const clean = results.filter((r) => r.errors === 0);
  const pool = clean.length ? clean : results;
  return pool.reduce((a, b) => (b.thr > a.thr ? b : a));
}

async function main() {
  console.log(`${BOLD}Load Probe${RESET} — วัดเพดานจริงของเครื่องนี้ ${DIM}(read-only)${RESET}`);
  console.log(`${DIM}ระดับ concurrency: ${LEVELS.join(', ')} · ${OPS} op ต่อระดับ · pool max=${(pool as any).options?.max ?? '?'}${RESET}`);
  console.log(`${YEL}⚠️ โหมด db/mixed ยิง query จริงเข้า DB ตัวที่ prod ใช้อยู่ — ถ้าอยู่ในเวลาทำงานจะไปแย่งกับเซลส์${RESET}`);

  const out: Record<string, LevelResult[]> = {};

  // ── warmup: โหลด customer cache ก่อน แล้ววัดต้นทุนของมันแยกต่างหาก ──
  // (การโหลดนี้เกิดจริงทุกครั้งที่ cache หมดอายุ/ถูกล้างหลัง sync — เป็น blocker ที่มองข้ามไม่ได้)
  if (MODE === 'all' || MODE === 'cpu' || MODE === 'mixed') {
    const lagWarm = startLagSampler();
    const t0 = Date.now();
    mute();
    await searchCustomersNormalized(['warmup ครั้งแรก โหลด cache']);
    unmute();
    const warmMs = Date.now() - t0;
    const warmLags = lagWarm.stop();
    console.log(`\n${BOLD}══ ต้นทุนการโหลด customer cache (เกิดทุกครั้งที่ cache ถูกล้าง) ══${RESET}`);
    console.log(`  โหลด + คำนวณ trigram ทั้งตาราง: ${warmMs > 500 ? RED : GREEN}${warmMs}ms${RESET}`);
    console.log(`  event loop ถูกบล็อกยาวสุดระหว่างนั้น: ${RED}${pct(warmLags, 1)}ms${RESET}`);
    console.log(`  ${DIM}ช่วงที่ถูกบล็อก ไม่มี event ไหนคืบหน้าได้เลย รวมถึงคนที่กำลังจะตอบสำเร็จ${RESET}`);
  }

  // ── โหมด cpu: ค้นลูกค้าล้วน (หลัง warmup แล้วไม่แตะ DB เลย เป็นงาน JS ล้วน) ──
  if (MODE === 'all' || MODE === 'cpu') {
    const res: LevelResult[] = [];
    for (const c of LEVELS) {
      mute();
      res.push(await runLevel(c, async (i) => {
        await searchCustomersNormalized([COMPANY_QUERIES[i % COMPANY_QUERIES.length]]);
      }));
      unmute();
    }
    out.cpu = res;
    printTable('CPU ล้วน — ค้นหาลูกค้า (searchCustomersNormalized)',
      'วนลูป synchronous ทั้งตาราง ~53k แถวต่อ 1 คำค้น — ไม่แตะ DB หลัง cache โหลดแล้ว', res);
  }

  // ── โหมด db: ค้นสินค้าล้วน (งาน I/O ล้วน วัด pool + DB) ──
  if (MODE === 'all' || MODE === 'db') {
    const res: LevelResult[] = [];
    for (const c of LEVELS) {
      res.push(await runLevel(c, async (i) => {
        const q = PRODUCT_QUERIES[i % PRODUCT_QUERIES.length];
        await pool.query(PRODUCT_SQL, [`%${q}%`, q]);
      }));
    }
    out.db = res;
    printTable('DB ล้วน — ค้นหาสินค้า (query เดียวกับ /api/products/search)',
      `งาน I/O ล้วน · pool max=${(pool as any).options?.max ?? 40} · connectionTimeoutMillis=5000`, res);
  }

  // ── โหมด mixed: ใกล้เคียงงานจริงของ handler 1 event (ค้นลูกค้า + ค้นสินค้า) ──
  if (MODE === 'all' || MODE === 'mixed') {
    const res: LevelResult[] = [];
    for (const c of LEVELS) {
      mute();
      res.push(await runLevel(c, async (i) => {
        const q = PRODUCT_QUERIES[i % PRODUCT_QUERIES.length];
        await searchCustomersNormalized([COMPANY_QUERIES[i % COMPANY_QUERIES.length]]);
        await pool.query(PRODUCT_SQL, [`%${q}%`, q]);
      }));
      unmute();
    }
    out.mixed = res;
    printTable('ผสม — ใกล้เคียง handler 1 event (ค้นลูกค้า + ค้นสินค้า)',
      'ไม่รวมเวลารอ LLM (~1.8s) ซึ่งเป็นการรอเฉย ๆ ไม่กินทั้ง CPU และ connection', res);
  }

  // ── สรุปเป็นคำตอบ ──
  console.log(`\n${BOLD}══ อ่านผล ══${RESET}`);
  if (out.cpu) {
    const k = knee(out.cpu);
    const one = out.cpu[0];
    console.log(`${BOLD}CPU:${RESET} throughput สูงสุด ${CYAN}${k.thr} op/s ที่ concurrency ${k.conc}${RESET}` +
      ` ${DIM}(ที่ concurrency 1 ได้ ${one.thr} op/s)${RESET}`);
    console.log(`  ${DIM}งาน JS แบบบล็อกไม่ได้ประโยชน์จาก concurrency เลย — Node มีเธรดเดียว การเพิ่มสล็อต`);
    console.log(`  แค่ย้ายที่ต่อคิวจาก "คิว webhook" มาเป็น "คิว event loop" ⇒ ถ้า throughput แทบไม่ขยับ`);
    console.log(`  ตามระดับ นั่นแปลว่า ${BOLD}maxConcurrency ไม่ใช่ตัวแปรที่ควรไปจูน${RESET}${DIM} ตัวที่ควรแก้คือ`);
    console.log(`  ทำให้ลูป 53k แถวถูกลงหรือหั่นเป็นชิ้น ๆ ให้ event loop หายใจได้${RESET}`);
  }
  if (out.db) {
    const k = knee(out.db);
    const failed = out.db.filter((r) => r.errors > 0);
    console.log(`${BOLD}DB:${RESET} throughput สูงสุด ${CYAN}${k.thr} op/s ที่ concurrency ${k.conc}${RESET}`);
    if (failed.length)
      console.log(`  ${RED}เริ่มมี error ที่ concurrency ${failed[0].conc}${RESET} ${DIM}(${failed[0].errSample.slice(0, 60)})${RESET}`);
    else
      console.log(`  ${GREEN}ไม่มี error เลยจนถึง concurrency ${LEVELS[LEVELS.length - 1]}${RESET} ${DIM}— pool ${(pool as any).options?.max ?? 40} ยังไม่ใช่คอขวดที่ระดับนี้${RESET}`);
    console.log(`  ${DIM}pool.waitingCount สูงสุดที่เห็น: ${Math.max(...out.db.map((r) => r.poolWaitMax))} ${RESET}` +
      `${DIM}(>0 = มี query ต่อคิวรอ connection)${RESET}`);
  }
  if (out.mixed) {
    const k = knee(out.mixed);
    console.log(`${BOLD}ผสม:${RESET} throughput สูงสุด ${CYAN}${k.thr} op/s ที่ concurrency ${k.conc}${RESET}`);
    console.log(`  ${DIM}⇒ เพดานงาน "ที่ไม่ใช่การรอ LLM" ของเครื่องนี้คือราว ${k.thr} event/s`);
    console.log(`     ป้อนเลขนี้กลับเข้า queueSim ผ่าน --p50/--p95 เพื่อดูว่ารองรับกี่คนพร้อมกัน${RESET}`);
  }
  console.log('');
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => { unmute(); console.error(e); await pool.end().catch(() => {}); process.exit(1); });
