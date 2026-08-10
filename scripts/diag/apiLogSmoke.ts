// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของระบบบันทึกการเรียก API (ตาราง api_logs)
//  รัน:  npm run diag:api-log            (อ่านอย่างเดียว — ปลอดภัยบน production)
//        npm run diag:api-log -- --write (เพิ่มการทดสอบ insert/delete ใน transaction ที่ ROLLBACK เสมอ)
//
//  โจทย์ที่สคริปต์นี้เฝ้า:
//    (ก) การเก็บ log ต้องไม่ทำให้ระบบช้าลง → มี benchmark วัดต้นทุนต่อ request จริง ๆ ไม่ใช่แค่อ้าง
//    (ข) buffer ต้องไม่โตไม่จำกัดจนกิน memory จน process ตาย
//    (ค) UNNEST 13 คอลัมน์ต้องไม่สลับตำแหน่งกัน (เคสพลาดที่พบบ่อยที่สุดของ UNNEST หลายคอลัมน์)
//    (ง) ค่า retention ที่อ่านไม่ออกต้องตกกลับเป็นค่าตั้งต้น ไม่ใช่ 0 ซึ่งแปลว่า "ลบทุกแถวทันที"
//    (จ) ตัวลบของเก่าต้องทำงานจริง — ไม่มีแถวที่เก่ากว่า retention ค้างอยู่
//    (ฉ) สัญญาณ "pool ไม่พอ" ต้องไม่ขึ้นตอน pool ว่าง — สัญญาณเตือนที่ผิดแพงกว่าไม่มีสัญญาณ
//
//  ให้รันซ้ำทุกครั้งที่แตะ config/apiLogger.ts, services/apiLogService.ts
//  หรือฟังก์ชันกลุ่ม api_logs ใน db/repositories.ts
// ─────────────────────────────────────────────────────────────────────────────
import { pool, withTransaction, POOL_MAX } from '../../config/db.js';
import {
  insertApiLogRows,
  deleteApiLogsOlderThan,
  type ApiLogInsertRow,
} from '../../db/repositories.js';
import {
  shouldSkipLogging,
  extractLineUserId,
  apiLogMiddleware,
  dbWaitingSignal,
} from '../../config/apiLogger.js';
import {
  parseRetentionDays,
  enqueueApiLog,
  getApiLogMetrics,
} from '../../services/apiLogService.js';

const WRITE_MODE = process.argv.includes('--write');

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// ── 1. shouldSkipLogging — ต้อง log ทุก API/หน้า และข้ามไฟล์ static ────────────
console.log('\n── 1. ตัวกรอง static ──');
const MUST_LOG: [string, string][] = [
  ['GET', '/'],
  ['GET', '/admin'],
  ['GET', '/admin.html'],
  ['POST', '/api/quotations'],
  ['POST', '/callback'],
  ['GET', '/liff/register'],
  ['GET', '/liff/product-search'],
  ['GET', '/download-pdf/8f14e45f-ceea-467a-9a3e-1b2c3d4e5f60/QP-2026-0001'],
  ['GET', '/api/ไม่มีจริง'],
];
const MUST_SKIP: [string, string][] = [
  ['GET', '/assets/main-D0JoRKUl.js'],
  ['GET', '/assets/main-DDw11ZB8.css'],
  ['GET', '/favicon.ico'],
  ['GET', '/logo.png'],
  ['GET', '/icons.svg'],
  ['GET', '/data/sale_sigs/123.png'],
  ['OPTIONS', '/api/quotations'],
];
for (const [m, p] of MUST_LOG) ok(`log: ${m} ${p}`, !shouldSkipLogging(m, p));
for (const [m, p] of MUST_SKIP) ok(`ข้าม: ${m} ${p}`, shouldSkipLogging(m, p));

// ── 2. extractLineUserId — ครบทุกทางที่ userId เดินทางเข้ามาในระบบนี้ ─────────
console.log('\n── 2. หา LINE userId ──');
const U = 'U1234567890abcdef1234567890abcdef';
ok('webhook events[0].source.userId',
  extractLineUserId({ events: [{ source: { userId: U } }] }, {}, {}) === U);
ok('webhook groupId (แชทกลุ่ม)',
  extractLineUserId({ events: [{ source: { groupId: 'G999' } }] }, {}, {}) === 'G999');
ok('body.userId', extractLineUserId({ userId: U }, {}, {}) === U);
ok('body.user_id', extractLineUserId({ user_id: U }, {}, {}) === U);
ok('query.userId', extractLineUserId(undefined, { userId: U }, {}) === U);
ok('params.userId', extractLineUserId(undefined, {}, { userId: U }) === U);
ok('override ชนะทุกตัว', extractLineUserId({ userId: U }, {}, {}, 'UOVERRIDE') === 'UOVERRIDE');
ok('ไม่เจอ → null', extractLineUserId({}, {}, {}) === null);
ok('body ว่าง → null', extractLineUserId(undefined, undefined, undefined) === null);
ok('ค่าที่ไม่ใช่สตริง → null', extractLineUserId({ userId: 12345 }, {}, {}) === null);
ok('สตริงเว้นวรรคล้วน → null', extractLineUserId({ userId: '   ' }, {}, {}) === null);

// ── 3. parseRetentionDays — ค่าเพี้ยนต้องไม่กลายเป็น 0 (= ลบทุกแถวทันที) ──────
console.log('\n── 3. จำนวนวันที่เก็บ ──');
ok('undefined → 30', parseRetentionDays(undefined) === 30);
ok("'' → 30", parseRetentionDays('') === 30);
ok("'abc' → 30", parseRetentionDays('abc') === 30);
ok("'0' → 30 (ไม่ใช่ 0)", parseRetentionDays('0') === 30);
ok("'-5' → 30", parseRetentionDays('-5') === 30);
ok("'7' → 7", parseRetentionDays('7') === 7);
ok("'30.9' → 30 (ปัดลง)", parseRetentionDays('30.9') === 30);
ok("'99999' → 3650 (เพดาน)", parseRetentionDays('99999') === 3650);

// ── 4. dbWaitingSignal — สัญญาณ "pool ไม่พอ" ต้องไม่ขึ้นตอน pool ว่าง ──────────
console.log('\n── 4. สัญญาณ pool ไม่พอ ──');
const sig = (waiting: number, total: number, idle: number) =>
  dbWaitingSignal({ waiting, total, idle, max: POOL_MAX });

ok('ไม่มีใครรอ → 0', sig(0, POOL_MAX, 0) === 0);
ok('มีคนรอ แต่ pool ยังไม่เต็ม → 0 (เคสสัญญาณปลอมที่เจอจริง 70/70 แถว)', sig(1, 1, 1) === 0);
ok('มีคนรอ pool เต็ม แต่ยังมีตัวว่าง → 0', sig(3, POOL_MAX, 2) === 0);
ok('มีคนรอ pool เต็ม ไม่มีตัวว่าง → รายงานตามจริง', sig(3, POOL_MAX, 0) === 3);
ok('total เกินเพดาน (ไม่ควรเกิด แต่ต้องไม่กลบ) → รายงาน', sig(5, POOL_MAX + 1, 0) === 5);

// พิสูจน์กับ pool จริง ไม่ใช่แค่ truth table — ยิง query พร้อมกันในหนึ่ง tick แล้วอ่านค่าทันที
// คือลำดับเดียวกับที่ res.on('finish') อ่าน pool ตอน request จบ (จุดที่เกิดสัญญาณปลอม)
await pool.query('SELECT 1');                     // อุ่นให้มี client ว่างอยู่ใน pool ก่อน
const probes = [pool.query('SELECT 1'), pool.query('SELECT 1'), pool.query('SELECT 1')];
const live = {
  waiting: pool.waitingCount, total: pool.totalCount, idle: pool.idleCount, max: POOL_MAX,
};
const liveSignal = dbWaitingSignal(live);
await Promise.all(probes);

const poolIsIdle = live.total < POOL_MAX;
ok('ทำสัญญาณปลอมซ้ำได้จริง (waitingCount > 0 ทั้งที่ pool ว่าง)',
  live.waiting > 0 && poolIsIdle,
  `waiting=${live.waiting} total=${live.total}/${POOL_MAX} idle=${live.idle}`);
ok('ของเดิมจะบันทึกเป็น "pool ไม่พอ"', live.waiting > 0, `ค่าดิบ = ${live.waiting}`);
ok('ของใหม่บันทึก 0', liveSignal === 0, `ได้ ${liveSignal}`);

// ── 5. ต้นทุนต่อ request — ข้อกำหนดคือ "การเก็บ log ต้องไม่ทำให้ระบบช้าลง" ────
// วัดเส้นทางจริงทั้งเส้น: middleware ขาเข้า → res.on('finish') → สร้างแถว → enqueue
//
// ⚠️ ต้องรัน "ก่อน" การทดสอบ buffer ล้น และจำนวนรอบต้องน้อยกว่าเพดาน buffer
//    ไม่งั้นจะไปวัดเส้นทาง drop ที่มี console.warn ทุก 100 ครั้ง ซึ่งกลบต้นทุนจริงจนหมด
//    (เคยวัดได้ 19.59 µs เพราะเหตุนี้ ทั้งที่เส้นทางจริงถูกกว่านั้นสิบเท่า)
console.log('\n── 5. ต้นทุนต่อ request ──');
// 200 อุ่นเครื่อง + 400×10 รอบ = 4,200 ครั้ง ต้องต่ำกว่าเพดาน buffer (5,000) เสมอ
// ไม่งั้นจะไปวัดเส้นทาง drop ที่มี console.warn ทุก 100 ครั้ง ซึ่งกลบต้นทุนจริงจนหมด
const N = 400;
// mock req/res: ใช้ any ตรงนี้โดยตั้งใจ เพราะสร้างวัตถุขั้นต่ำแทนที่จะยก Express มาทั้งก้อน
function makePair(): { req: any; res: any; fire: () => void } {
  const handlers: (() => void)[] = [];
  const res: any = {
    statusCode: 200,
    setHeader() { /* no-op */ },
    getHeader() { return '512'; },
    on(_ev: string, fn: () => void) { handlers.push(fn); },
  };
  const req: any = {
    method: 'POST', path: '/api/quotation/abc-123', body: { userId: U }, query: {}, params: {},
    route: { path: '/api/quotation/:id' },
  };
  return { req, res, fire: () => { for (const h of handlers) h(); } };
}
/**
 * วัดซ้ำหลายรอบแล้วเอา "ค่าต่ำสุด" ไม่ใช่ค่าเฉลี่ย
 * เครื่องที่รัน production อยู่มี CPU contention ตลอดเวลา ค่าเฉลี่ยจึงวัด noise ของเครื่องมากกว่าวัดโค้ด
 * (วัดจริงเคยเห็นค่าเฉลี่ยแกว่งระหว่าง 8-30 µs ขณะที่ค่าต่ำสุดนิ่งอยู่ที่ ~6 µs)
 */
function bestOf(fn: () => void, rounds = 10): number {
  for (let i = 0; i < 200; i++) fn();                 // อุ่นเครื่องให้ JIT compile ก่อน
  let min = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) fn();
    const us = Number(process.hrtime.bigint() - t) / 1000 / N;
    if (us < min) min = us;
  }
  return min;
}

const mockOnly = bestOf(() => { const p = makePair(); p.fire(); });
const fullPath = bestOf(() => {
  const p = makePair();
  apiLogMiddleware(p.req, p.res, () => { /* next */ });
  p.fire();
});
const perReqUs = fullPath - mockOnly;                  // หักต้นทุนการสร้าง mock ออก
// ค่าอ้างอิงงานที่รู้ต้นทุนแน่ ๆ — ไว้ให้คนอ่านรู้ว่าตอนวัดเครื่องว่างหรือไม่
const refUs = bestOf(() => { JSON.parse('{"a":1,"b":"xyz","c":[1,2,3]}'); });

// เพดาน 20 µs คือ "ตัวจับ regression" ไม่ใช่เป้าหมายประสิทธิภาพ — ของจริงวัดได้ ~5 µs บนเครื่องที่รัน
// production อยู่ (บนเครื่องว่างจะราว 1.3 µs) ถ้าวันหน้ามีคนเพิ่มการเก็บ request body เข้ามา
// ตัวเลขจะกระโดดไปหลักสิบถึงร้อย µs และข้อนี้จะจับได้ทันที
ok('ต้นทุน < 20 µs/request (ตัวจับ regression)', perReqUs < 20, `วัดได้ ${perReqUs.toFixed(2)} µs`);
console.log(
  `   เทียบเคียง: JSON.parse ก้อนเล็ก = ${refUs.toFixed(2)} µs บนเครื่องเดียวกัน` +
  ` (ยิ่งสูง = ตอนวัดเครื่องยิ่งไม่ว่าง) · อัตราส่วน ${(perReqUs / refUs).toFixed(1)} เท่า`);
console.log(
  `   ที่ 5,000 req/วัน = ${(perReqUs * 5000 / 1000).toFixed(0)} ms/วัน รวมทั้งวัน`);

// ── 6. buffer ต้องมีเพดาน ไม่โตไม่จำกัดจนกิน memory ──────────────────────────
console.log('\n── 6. เพดาน buffer ──');
const sampleRow = (): ApiLogInsertRow => ({
  createdAt: new Date(), requestId: 'aabbccddeeff0011', method: 'GET',
  route: '/api/x', path: '/api/x', statusCode: 200, durationMs: 1,
  respBytes: null, adminUserId: null, lineUserId: null,
  inflight: 1, dbWaiting: 0, queueWaitedMs: null,
});
// เติมจากที่ค้างอยู่จริงหลัง benchmark ให้ทะลุเพดานพอดี 1 แถว (ไม่ผูกกับจำนวนรอบ benchmark)
const MAX_BUFFER = 5_000;
const before = getApiLogMetrics();
ok('benchmark ทำให้แถวเข้า buffer จริง (ไม่ได้ตกทาง drop)',
  before.buffered > 0 && before.droppedOverflow === 0,
  `buffered=${before.buffered} dropped=${before.droppedOverflow}`);
for (let i = before.buffered; i < MAX_BUFFER + 1; i++) enqueueApiLog(sampleRow());
const afterOverflow = getApiLogMetrics();
ok('buffer หยุดที่ 5000', afterOverflow.buffered === MAX_BUFFER, `ได้ ${afterOverflow.buffered}`);
ok('นับแถวที่ทิ้ง = 1', afterOverflow.droppedOverflow === 1, `ได้ ${afterOverflow.droppedOverflow}`);

// ── 7. ตรวจ DB (อ่านอย่างเดียว) ───────────────────────────────────────────────
console.log('\n── 7. สถานะตารางใน DB ──');
try {
  const t = await pool.query(`SELECT to_regclass('public.api_logs') AS t`);
  ok('ตาราง api_logs มีอยู่จริง', t.rows[0].t !== null);

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'api_logs' ORDER BY 1`);
  const names = idx.rows.map((r: any) => r.indexname);
  ok('index ครบ (pkey + created_at + request_id)',
    names.includes('api_logs_pkey') &&
    names.includes('idx_api_logs_created_at') &&
    names.includes('idx_api_logs_request_id'),
    names.join(', '));

  const opts = await pool.query(
    `SELECT reloptions FROM pg_class WHERE relname = 'api_logs'`);
  const reloptions: string[] = opts.rows[0]?.reloptions ?? [];
  ok('ตั้ง autovacuum ถี่กว่าค่า default',
    reloptions.some(o => o.startsWith('autovacuum_vacuum_scale_factor=')),
    reloptions.join(', ') || '(ไม่มี)');

  const stat = await pool.query(`
    SELECT count(*)::int AS rows,
           pg_size_pretty(pg_total_relation_size('public.api_logs')) AS size,
           min(created_at) AS oldest,
           max(created_at) AS newest
      FROM public.api_logs`);
  const s = stat.rows[0];
  console.log(`   ขนาด ${s.size} · ${s.rows.toLocaleString()} แถว · เก่าสุด ${s.oldest ?? '-'} · ใหม่สุด ${s.newest ?? '-'}`);

  // ตัวลบของเก่าทำงานจริงไหม — เผื่อ 2 วันให้ตัวลบตามเก็บทัน
  const days = parseRetentionDays(process.env.API_LOG_RETENTION_DAYS);
  if (s.rows > 0) {
    const old = await pool.query(
      `SELECT count(*)::int AS n FROM public.api_logs
        WHERE created_at < CURRENT_TIMESTAMP - (($1::int + 2) * INTERVAL '1 day')`, [days]);
    ok(`ไม่มีแถวเก่ากว่า ${days}+2 วัน (retention ทำงาน)`, old.rows[0].n === 0,
      `เจอ ${old.rows[0].n} แถว`);
  } else {
    console.log('   (ตารางยังว่าง — ข้ามการตรวจ retention)');
  }

  // index ต้อง "รองรับรูป query ของหน้ารายการได้" — ตรวจด้วยการปิด Seq Scan แล้วดูว่า planner
  // ใช้ idx_api_logs_created_at ได้จริงและ "ไม่ต้องมี Sort" (= index เรียงตรงกับ ORDER BY อยู่แล้ว)
  //
  // ที่ไม่ assert ว่า "planner ต้องเลือก index" ตรง ๆ เพราะตอนตารางยังเล็ก Seq Scan เร็วกว่าจริง
  // และ planner ก็ถูกแล้วที่เลือกมัน → assert แบบนั้นจะ fail แบบไร้สาระตอนตารางว่าง
  // สิ่งที่ต้องเฝ้าคือ "index ยังตรงกับ query อยู่ไหม" ซึ่งพังได้จริงถ้ามีคนแก้ ORDER BY
  // หรือลบคอลัมน์ id ออกจาก index
  await withTransaction(async (client) => {
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = await client.query(`
      EXPLAIN SELECT id, created_at, method, path, status_code, duration_ms
        FROM public.api_logs
       WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '7 day'
       ORDER BY created_at DESC, id DESC LIMIT 50`);
    const planText = plan.rows.map((r: any) => r['QUERY PLAN']).join(' | ');
    ok('index รองรับ query ของหน้ารายการ', /idx_api_logs_created_at/.test(planText), planText.slice(0, 90));
    ok('ไม่ต้อง Sort (index เรียงตรงกับ ORDER BY อยู่แล้ว)', !/Sort/.test(planText));
  });
} catch (err: any) {
  failures++;
  console.log('✗ FAIL  ตรวจ DB ล้มเหลว:', err?.message ?? err);
}

// ── 8. insert/delete จริง (--write) — ทำใน transaction แล้ว ROLLBACK เสมอ ─────
if (WRITE_MODE) {
  console.log('\n── 8. insert/delete จริง (ROLLBACK ทุกกรณี) ──');
  try {
    await withTransaction(async (client) => {
      const now = new Date();
      // 3 แถวเก่า (100 วัน) สำหรับทดสอบตัวลบ + 1 แถวใหม่ที่ต้องรอด
      const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
      const rows: ApiLogInsertRow[] = [
        { createdAt: old, requestId: 'ffffffffffffff01', method: 'POST',
          route: '/api/quotation/:id', path: '/api/quotation/abc-123', statusCode: 200,
          durationMs: 142, respBytes: 812, adminUserId: null, lineUserId: U,
          inflight: 3, dbWaiting: 0, queueWaitedMs: null },
        // แถวที่ทุกช่อง nullable เป็น NULL — พิสูจน์ว่า UNNEST ไม่ทำ NULL หล่นตำแหน่ง
        { createdAt: old, requestId: 'ffffffffffffff02', method: 'GET',
          route: null, path: '/api/ไม่มีจริง', statusCode: 404,
          durationMs: 2, respBytes: null, adminUserId: null, lineUserId: null,
          inflight: null, dbWaiting: null, queueWaitedMs: null },
        // ค่าไทย + อักขระพิเศษ + แถว TASK ของ webhook
        { createdAt: old, requestId: 'ffffffffffffff03', method: 'TASK',
          route: '/callback (async)', path: '/callback (async)', statusCode: 504,
          durationMs: 48000, respBytes: null, adminUserId: 7, lineUserId: U,
          inflight: 12, dbWaiting: 2, queueWaitedMs: 31000 },
        { createdAt: now, requestId: 'ffffffffffffff04', method: 'GET',
          route: '/api/products/search', path: '/api/products/search', statusCode: 200,
          durationMs: 33, respBytes: 4096, adminUserId: null, lineUserId: null,
          inflight: 1, dbWaiting: 0, queueWaitedMs: null },
      ];
      await insertApiLogRows(client, rows);

      const back = await client.query(
        `SELECT * FROM api_logs WHERE request_id LIKE 'ffffffffffff%' ORDER BY request_id`);
      ok('insert ครบ 4 แถว', back.rowCount === 4, `ได้ ${back.rowCount}`);

      // เทียบทีละฟิลด์ — จุดประสงค์คือจับกรณี UNNEST สลับคอลัมน์
      const a = back.rows[0], b = back.rows[1], c = back.rows[2];
      ok('แถว 1: ทุกคอลัมน์ตรงตำแหน่ง',
        a.method === 'POST' && a.route === '/api/quotation/:id' &&
        a.path === '/api/quotation/abc-123' && a.status_code === 200 &&
        a.duration_ms === 142 && a.resp_bytes === 812 &&
        a.line_user_id === U && a.inflight === 3 && a.db_waiting === 0 &&
        a.queue_waited_ms === null && a.admin_user_id === null,
        JSON.stringify({ m: a.method, r: a.route, s: a.status_code, d: a.duration_ms }));
      ok('แถว 2: NULL ไม่หล่นตำแหน่ง',
        b.route === null && b.resp_bytes === null && b.inflight === null &&
        b.db_waiting === null && b.status_code === 404 && b.path === '/api/ไม่มีจริง');
      ok('แถว 3: TASK + queue_waited_ms',
        c.method === 'TASK' && c.queue_waited_ms === 31000 &&
        c.duration_ms === 48000 && c.admin_user_id === 7 && c.db_waiting === 2);
      ok('id เดินเลขให้อัตโนมัติ', typeof a.id === 'string' || typeof a.id === 'number');
      ok('created_at ถูกบันทึกตรงเวลาที่ส่งไป',
        Math.abs(new Date(a.created_at).getTime() - old.getTime()) < 1000);

      // ลบของเก่ากว่า 30 วัน แต่จำกัดทีละ 2 แถว → รอบแรกต้องได้พอดี 2 (พิสูจน์ว่า LIMIT ทำงาน
      // ไม่ใช่กวาดทั้งหมดในคำสั่งเดียวจนเสี่ยงชน statement_timeout)
      const firstBatch = await deleteApiLogsOlderThan(client, 30, 2);
      ok('รอบแรกลบได้ตาม limit พอดี 2', firstBatch === 2, `ลบไป ${firstBatch}`);

      // รอบสองเหลือแถวเก่าอีก 1 → ลบได้ 1 แล้วหยุด (ตัวเลข < limit = สัญญาณว่าหมดแล้ว)
      const secondBatch = await deleteApiLogsOlderThan(client, 30, 2);
      ok('รอบสองลบแถวเก่าที่เหลือ 1 แถว', secondBatch === 1, `ลบไป ${secondBatch}`);

      // แถวใหม่ต้องไม่ถูกแตะ — พิสูจน์ว่าเงื่อนไขวันที่คัดถูกจริง ไม่ใช่ลบทุกอย่างที่เจอ
      const survived = await client.query(
        `SELECT request_id FROM api_logs WHERE request_id LIKE 'ffffffffffff%'`);
      ok('แถวใหม่รอด ไม่ถูกลบตามไปด้วย',
        survived.rowCount === 1 && survived.rows[0].request_id === 'ffffffffffffff04',
        `เหลือ ${survived.rowCount} แถว`);

      throw new Error('__ROLLBACK__');               // ตั้งใจให้ transaction ถอยกลับเสมอ
    });
  } catch (err: any) {
    if (err?.message !== '__ROLLBACK__') {
      failures++;
      console.log('✗ FAIL  ทดสอบ write ล้มเหลว:', err?.message ?? err);
    }
  }

  const left = await pool.query(
    `SELECT count(*)::int AS n FROM api_logs WHERE request_id LIKE 'ffffffffffff%'`);
  ok('ROLLBACK สะอาด ไม่เหลือแถวทดสอบ', left.rows[0].n === 0, `เหลือ ${left.rows[0].n}`);
} else {
  console.log('\n(ข้ามข้อ 8 — ใส่ --write เพื่อทดสอบ insert/delete จริงแบบ ROLLBACK)');
}

console.log(`\n${failures === 0 ? '✓ ผ่านทั้งหมด' : `✗ ล้มเหลว ${failures} ข้อ`}`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
