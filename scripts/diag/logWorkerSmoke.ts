// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของ logworker (scripts/logworker/*)
//  รัน:  npm run diag:log-worker          (อ่านอย่างเดียว — ปลอดภัยบน production)
//
//  โจทย์ที่สคริปต์นี้เฝ้า:
//    (ก) ระดับความรุนแรงต้องมาจาก "สตรีม" ไม่ใช่คำในข้อความ — บรรทัด [queue] ที่มีคำว่า
//        failed=0 timedOut=0 เป็น log ปกติที่สุดของระบบ ห้ามกลายเป็น error
//    (ข) ตัวลบข้อมูลอ่อนไหวต้องตัด Bearer/password/token/secret/api_key ได้จริงทุกรูปแบบ
//        และต้อง "ไม่" ตัด userId/ip ซึ่ง พ.ร.บ. ม.26 บังคับให้ระบุตัวผู้ใช้บริการได้
//    (ค) บรรทัดต่อเนื่อง (stack trace / JSON หลายบรรทัด) ต้องรวมเข้าแถวเดียว ไม่แตกเป็นแถวละบรรทัด
//    (ง) ค่า env ที่อ่านไม่ออกต้องตกกลับเป็นค่าปลอดภัย ไม่ใช่ค่าที่ทำให้ตารางโตเงียบ ๆ
//    (จ) migration ขึ้นครบและ trigger ติดถูกตาราง — โดยเฉพาะ "ตารางต้องห้าม" ต้องสะอาด
//    (ฉ) worker ยังหายใจอยู่ (cursor ไม่ค้าง) และไม่มีความลับหลุดลง system_logs
//
//  ให้รันซ้ำทุกครั้งที่แตะ scripts/logworker/ หรือ migration ทั้ง 3 ไฟล์ของแผน log
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { parseLevel, parseDays, levelRank } from '../logworker/config.js';
import { splitTimestamp, isContinuation, parseEntry, detectLevel } from '../logworker/parseLine.js';
import { redact, redactObject } from '../logworker/redact.js';
import { thaiToday, shiftDay } from '../logworker/trafficDailyJob.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// ── 1. ระดับความรุนแรง — สตรีมคือตัวชี้ ไม่ใช่คำในข้อความ ──────────────────────
console.log('\n── 1. การตัดสินระดับความรุนแรง ──');
const QUEUE_LINE =
  '[queue] reqId=5f33bea9dd143f8e user=Uf667 type=postback waited=2ms processed=578ms ' +
  '[replied=144 timedOut=0 dropped=0 failed=0]';
ok('บรรทัด [queue] ที่มีคำว่า failed/timedOut แต่มาจาก stdout = info',
  detectLevel(QUEUE_LINE, 'stdout') === 'info', detectLevel(QUEUE_LINE, 'stdout'));
ok('บรรทัดเดียวกันถ้ามาจาก stderr = error (console.error)',
  detectLevel(QUEUE_LINE, 'stderr') === 'error');
ok('stderr ที่มี ⚠️ = warn ไม่ใช่ error (console.warn)',
  detectLevel('⚠️ pool ใกล้เต็ม', 'stderr') === 'warn');
ok('uncaughtException = fatal ไม่ว่ามาจากสตรีมไหน',
  detectLevel('uncaughtException: boom', 'stdout') === 'fatal' &&
  detectLevel('uncaughtException: boom', 'stderr') === 'fatal');
ok('ลำดับความรุนแรง fatal < error < warn < info < debug',
  levelRank('fatal') < levelRank('error') && levelRank('error') < levelRank('warn') &&
  levelRank('warn') < levelRank('info') && levelRank('info') < levelRank('debug'));

// ── 2. แยก timestamp ของ docker ──────────────────────────────────────────────
console.log('\n── 2. timestamp จาก docker logs ──');
const T = splitTimestamp('2026-09-03T05:20:06.328770686Z [sync] ▶ รอบ sync เริ่ม');
ok('แยก timestamp ระดับนาโนวินาทีออกจากเนื้อบรรทัดได้',
  T !== null && T.text.startsWith('[sync]'), T?.ts.toISOString() ?? 'null');
ok('เวลาที่ได้ตรงกับที่ docker ประทับ (ไม่ใช่เวลาที่ worker อ่านเจอ)',
  T !== null && T.ts.getTime() === Date.parse('2026-09-03T05:20:06.328Z'));
ok('บรรทัดที่ไม่มี timestamp ต้องคืน null ไม่ใช่เดาเวลาให้',
  splitTimestamp('ไม่มีเวลานำหน้า') === null || splitTimestamp('xyz') === null);

// ── 3. บรรทัดต่อเนื่อง ────────────────────────────────────────────────────────
console.log('\n── 3. บรรทัดต่อเนื่อง (stack trace / JSON หลายบรรทัด) ──');
ok('"    at Object.<anonymous>" = บรรทัดต่อเนื่อง', isContinuation('    at Object.<anonymous> (/app/index.ts:1)'));
ok('"]" เดี่ยว ๆ = บรรทัดต่อเนื่อง', isContinuation(']'));
ok('"}," = บรรทัดต่อเนื่อง', isContinuation('},'));
ok('บรรทัดปกติไม่ใช่บรรทัดต่อเนื่อง', !isContinuation('[sync] ▶ รอบ sync เริ่ม'));
ok('บรรทัดว่างไม่ใช่บรรทัดต่อเนื่อง (ไม่งั้นจะไปเกาะแถวก่อนหน้าเรื่อย ๆ)', !isContinuation(''));

// ── 4. แกะเนื้อบรรทัด ────────────────────────────────────────────────────────
console.log('\n── 4. แกะ source / request_id / JSON ──');
const e1 = parseEntry(QUEUE_LINE, 'stdout');
ok('อ่านชื่อโมดูลจากวงเล็บเหลี่ยมต้นบรรทัด', e1.source === 'queue', String(e1.source));
ok('อ่าน request_id จาก reqId=', e1.requestId === '5f33bea9dd143f8e', String(e1.requestId));
ok('ตัดวงเล็บเหลี่ยมออกจาก message แล้ว', !e1.message.startsWith('[queue]'));

const e2 = parseEntry(
  '{"level":"warn","source":"sync","event":"rebuild.slow","message":"ช้ากว่าปกติ","ms":9200}', 'stdout');
ok('บรรทัด JSON: อ่าน level จากฟิลด์ ไม่ใช่จากสตรีม', e2.level === 'warn', e2.level);
ok('บรรทัด JSON: อ่าน event ได้', e2.event === 'rebuild.slow', String(e2.event));
ok('บรรทัด JSON: ฟิลด์ที่เหลือไปอยู่ใน ctx', (e2.ctx as any)?.ms === 9200, JSON.stringify(e2.ctx));

const e3 = parseEntry('{"level":"ไม่มีระดับนี้","message":"x"}', 'stderr');
ok('บรรทัด JSON ที่ level เพี้ยน ตกกลับไปใช้สตรีมแทน', e3.level === 'error', e3.level);

// ── 5. ตัวลบข้อมูลอ่อนไหว ────────────────────────────────────────────────────
console.log('\n── 5. ตัวลบข้อมูลอ่อนไหว ──');
const SECRETS: [string, string][] = [
  ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'eyJhbGciOiJIUzI1NiJ9'],
  ['{"password":"ลับสุดยอด"}', 'ลับสุดยอด'],
  ["api_key='sk-live-1234567890'", 'sk-live-1234567890'],
  ['channel_secret=abcdef123456', 'abcdef123456'],
  ['GET /x?token=zzzzzz&a=1', 'zzzzzz'],
  ['replyToken: "abcdef1234567890"', 'abcdef1234567890'],
];
for (const [input, secret] of SECRETS) {
  const out = redact(input);
  ok(`ตัดออกได้: ${input.slice(0, 40)}`, !out.includes(secret), out);
}

const KEEP: [string, string][] = [
  ['user=U648e918245706186b0c1a7eae0b38579 ตอบแล้ว', 'U648e918245706186b0c1a7eae0b38579'],
  ['ip=203.0.113.9 เรียก /api/quotations', '203.0.113.9'],
  ['reqId=5f33bea9dd143f8e', '5f33bea9dd143f8e'],
];
for (const [input, keep] of KEEP) {
  ok(`ต้องไม่ตัด (พ.ร.บ. ม.26 ต้องระบุตัวผู้ใช้ได้): ${keep.slice(0, 20)}`,
    redact(input).includes(keep), redact(input));
}

const robj = redactObject({ user: 'U123', password_hash: '$2a$xx', nest: { token: 'zzz', ok: 1 } }) as any;
ok('redactObject: ตัด password_hash ในทุกชั้น', robj.password_hash === '***' && robj.nest.token === '***');
ok('redactObject: ไม่แตะค่าที่ไม่ใช่ความลับ', robj.user === 'U123' && robj.nest.ok === 1);

// ── 6. ค่าจาก env ที่อ่านไม่ออกต้องตกกลับเป็นค่าปลอดภัย ─────────────────────────
console.log('\n── 6. การตกกลับของค่าจาก env ──');
ok('SYSTEM_LOG_DB_LEVEL ที่พิมพ์ผิด ตกกลับเป็น warn ไม่ใช่ debug', parseLevel('wran') === 'warn');
ok('SYSTEM_LOG_DB_LEVEL ที่ไม่ได้ตั้ง ตกกลับเป็น warn', parseLevel(undefined) === 'warn');
ok('ตั้งค่าถูกต้องก็ต้องใช้ค่านั้น', parseLevel('ERROR') === 'error');
ok('จำนวนวันที่เป็น 0 ต้องตกกลับ ไม่ใช่ "ลบทุกแถวทันที"', parseDays('0', 90) === 90);
ok('จำนวนวันที่อ่านไม่ออกต้องตกกลับ', parseDays('เก้าสิบ', 90) === 90);
ok('จำนวนวันที่ถูกต้องต้องใช้ค่านั้น', parseDays('120', 90) === 120);

// ── 7. วันไทย ────────────────────────────────────────────────────────────────
console.log('\n── 7. การนับวันแบบไทย ──');
ok('เที่ยงคืนครึ่ง UTC ยังเป็น "วันถัดไป" ตามเวลาไทย (+7)',
  thaiToday(new Date('2026-09-02T18:00:00Z')) === '2026-09-03',
  thaiToday(new Date('2026-09-02T18:00:00Z')));
ok('เวลาไทย 06:59 ยังเป็นวันเดิม',
  thaiToday(new Date('2026-09-02T16:59:00Z')) === '2026-09-02');
ok('เลื่อนวันข้ามเดือนถูกต้อง', shiftDay('2026-09-01', -1) === '2026-08-31');

// ── 8. สถานะบน DB จริง ───────────────────────────────────────────────────────
async function dbChecks(): Promise<void> {
  console.log('\n── 8. migration และ trigger บน DB จริง ──');

  const { rows: missing } = await pool.query<{ t: string }>(
    `SELECT t FROM unnest(ARRAY['system_logs','log_worker_state','audit_logs','traffic_daily']) t
      WHERE to_regclass('public.' || t) IS NULL`);
  ok('ตารางของแผน log ขึ้นครบทั้ง 4 ตัว', missing.length === 0,
    missing.map(r => r.t).join(', ') || 'ครบ');
  if (missing.length > 0) {
    console.log('  → รัน migration ทั้ง 3 ไฟล์ก่อน แล้วรันสคริปต์นี้ใหม่');
    return;
  }

  const { rows: bad } = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE tg.tgname = 'trg_audit'
        AND c.relname IN ('quotations','quotation_counters','messages','products','customers',
                          'sale_orders','api_logs','system_logs','audit_logs')`);
  ok('🚫 ตารางต้องห้าม (ใบเสนอราคา/แชท/sync/log) ไม่มี trg_audit',
    bad.length === 0, bad.map(r => r.relname).join(', ') || 'สะอาด');

  const { rows: cnt } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_audit'`);
  ok('ตารางตั้งค่าติด trg_audit ครบ 11 ตัว', cnt[0].n === 11, `${cnt[0].n} ตัว`);

  const { rows: leak } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM system_logs
      WHERE message ~* '(bearer\\s+[a-z0-9]|password"?\\s*[:=]\\s*[^*]|api[_-]?key"?\\s*[:=]\\s*[^*])'`);
  ok('ไม่มีความลับหลุดลง system_logs', leak[0].n === 0, `พบ ${leak[0].n} แถว`);

  const { rows: st } = await pool.query<{ job: string; age_min: number | null; last_error: string | null }>(
    `SELECT job,
            round(extract(epoch FROM now() - last_ok_at) / 60)::int AS age_min,
            last_error
       FROM log_worker_state ORDER BY job`);
  console.log('\n   สถานะ logworker แต่ละงาน:');
  for (const s of st) {
    console.log(`     ${s.job.padEnd(28)} สำเร็จล่าสุด ` +
      (s.age_min === null ? 'ยังไม่เคยรัน' : `${s.age_min} นาทีที่แล้ว`) +
      (s.last_error ? `  ⚠️ ${s.last_error.slice(0, 80)}` : ''));
  }
  const stale = st.filter(s => s.age_min !== null && s.age_min > 15);
  ok('ไม่มีงานที่ค้างเกิน 15 นาที (ยังไม่เคยรัน = ยังไม่ได้เปิด worker ไม่นับว่าพัง)',
    stale.length === 0, stale.map(s => s.job).join(', ') || 'ปกติ');

  const { rows: pend } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE actor_type = 'pending' AND occurred_at < now() - interval '15 minutes'`);
  ok('ไม่มีแถว audit ที่ค้างเป็น pending เกิน 15 นาที', pend[0].n === 0, `${pend[0].n} แถว`);
}

dbChecks()
  .catch(err => { failures++; console.error('\n✗ FAIL  ตรวจ DB ไม่สำเร็จ:', err?.message ?? err); })
  .finally(async () => {
    await pool.end();
    console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ ไม่ผ่าน ${failures} ข้อ`);
    process.exit(failures === 0 ? 0 : 1);
  });
