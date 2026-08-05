// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของ "วันที่ต้องเป็นวันไทยเสมอ" — ทั้งฝั่ง SQL และฝั่ง Node
//  รัน:  npm run diag:date-filter
//
//  read-only ทั้งหมด — ทดสอบเงื่อนไขกับแถวสมมติที่สร้างจาก VALUES ไม่แตะตาราง quotations
//
//  โจทย์ที่สคริปต์นี้เฝ้า: ผลลัพธ์ต้องไม่ขึ้นกับ TimeZone ของ DB หรือของโปรเซส
//    (ก) SQL — เดิมใช้ `$1::date AT TIME ZONE 'Asia/Bangkok'` (ไม่มี ::timestamp) ซึ่ง PostgreSQL เลือก
//        overload timezone(text, timestamptz) → ขอบล่างเลื่อนตาม session TimeZone: ถูกบนเครื่อง dev
//        ที่ตั้งโซนไทย แต่บน production (docker postgres = UTC) ไปตกที่ 14:00 น. → ใบช่วงเช้าหายเงียบ ๆ
//    (ข) Node — `new Date().getDate()/getMonth()` อ่านตาม TZ ของโปรเซส (prod เคยเป็น UTC)
//        → วันที่บนหัว PDF และงวด yymm ของเลขใบเสนอราคาเลื่อนไปวันก่อนหน้าช่วง 00:00–07:00 น.
//
//  ครอบคลุม: ชนิดที่ PostgreSQL resolve ได้ต้องเป็น timestamptz ทั้งสองฝั่ง ·
//            ขอบล่าง = 00:00 น. ไทยของ dateFrom · ขอบบนรวมทั้งวันของ dateTo ·
//            กรองวันเดียว (from = to) ได้ทั้งวันครบ 24 ชม. · ผลไม่เปลี่ยนตาม TimeZone ของ session ·
//            utils/thaiTime ให้ค่าเดิมทุก TZ ของโปรเซส · ปฏิเสธ Invalid Date
//  ให้รันซ้ำทุกครั้งที่แตะเงื่อนไขวันที่ใน db/repositories.ts, utils/thaiTime.ts
//  หรือ endpoint quotations list/export
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  createdAtFromThaiDayCondition,
  createdAtToThaiDayCondition,
} from '../../db/repositories.js';
import { thaiDateDMY, thaiYearMonth, thaiDateParts } from '../../utils/thaiTime.js';
import { allocateQuotationNo } from '../../services/quotationService.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

// ── 0. ฝั่ง Node: utils/thaiTime ต้องไม่ขึ้นกับ TZ ของโปรเซส (ไม่แตะ DB) ────
// เลือก 02:00 น. ไทยของ 1 ม.ค. = 31 ธ.ค. 19:00 UTC → ข้ามทั้งวัน เดือน และปี เมื่ออ่านแบบ UTC
// เคสเดียวจึงจับได้ทั้งบั๊กวันที่บนหัว PDF และบั๊กงวด yymm ของเลขใบเสนอราคา
// ปีอนาคต (2031) ตั้งใจเลือกให้ counter งวดนี้ไม่มีวันชนกับ traffic จริงในข้อ 4
const ORIGINAL_TZ = process.env.TZ;
const EDGE = new Date('2031-01-01T02:00:00+07:00');
const EDGE_PERIOD = '3101';
const naiveDays = new Set<number>();
try {
  for (const tz of ['Asia/Bangkok', 'UTC', 'America/New_York']) {
    process.env.TZ = tz;
    naiveDays.add(EDGE.getDate()); // ตัวคุม — ค่าที่ "ไม่ปัก TZ" ต้องแกว่งตามโซน
    ok(`[TZ=${tz}] thaiDateDMY ได้วันไทย 01/01/2031`, thaiDateDMY(EDGE) === '01/01/2031',
      `(ได้ ${thaiDateDMY(EDGE)})`);
    ok(`[TZ=${tz}] thaiYearMonth ได้งวด ${EDGE_PERIOD} (ไม่ตกไปเดือน ธ.ค. ปีก่อน)`,
      thaiYearMonth(EDGE) === EDGE_PERIOD, `(ได้ ${thaiYearMonth(EDGE)})`);
  }
} finally {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
}
// ถ้าตัวคุมไม่แกว่งเลย = Node รุ่นนี้ไม่รับการเปลี่ยน TZ กลางคัน → ข้อสอบข้างบนกลายเป็นข้อสอบเปล่า
ok('ตัวคุม: เวลาแบบไม่ปัก TZ แกว่งตามโซนจริง (ยืนยันว่าการทดสอบมีผลจริง)',
  naiveDays.size > 1, `(วันที่ที่อ่านได้: ${[...naiveDays].join(', ')})`);

ok('thaiDateParts ปฏิเสธ Invalid Date แทนที่จะคืนค่าเพี้ยน',
  (() => { try { thaiDateParts(new Date('ไม่ใช่วันที่')); return false; } catch { return true; } })());

// TimeZone ที่เอามาลอง — Asia/Bangkok = เครื่อง dev, UTC = docker postgres ตั้งต้น,
// America/New_York = ฝั่งลบ (กันกรณีแก้แล้วยังเหลือการพึ่ง offset อยู่)
const SESSION_ZONES = ['Asia/Bangkok', 'UTC', 'America/New_York'];

// แถวสมมติรอบขอบเขตของวันที่ 2026-08-05 ตามเวลาไทย + ค่าที่ควรได้เมื่อกรอง 05/08 → 05/08
const SAMPLES: Array<{ label: string; at: string; expected: boolean }> = [
  { label: '04/08 23:59:59 น.', at: '2026-08-04 23:59:59+07', expected: false },
  { label: '05/08 00:00:00 น. (ขอบล่างพอดี)', at: '2026-08-05 00:00:00+07', expected: true },
  { label: '05/08 00:30:00 น.', at: '2026-08-05 00:30:00+07', expected: true },
  { label: '05/08 09:30:00 น.', at: '2026-08-05 09:30:00+07', expected: true },
  { label: '05/08 13:59:59 น. (ก่อนจุดที่บั๊กเดิมตัดทิ้ง)', at: '2026-08-05 13:59:59+07', expected: true },
  { label: '05/08 14:00:01 น.', at: '2026-08-05 14:00:01+07', expected: true },
  { label: '05/08 23:59:59 น. (ขอบบนพอดี)', at: '2026-08-05 23:59:59+07', expected: true },
  { label: '06/08 00:00:00 น. (วันถัดไป)', at: '2026-08-06 00:00:00+07', expected: false },
];

const DATE_FROM = '2026-08-05';
const DATE_TO = '2026-08-05';

const client = await pool.connect();
try {
  // ── 1. ชนิดที่ PostgreSQL resolve ได้ ต้องเป็น timestamptz ทั้งสองฝั่ง ──────
  //    ถ้าใครเผลอถอด ::timestamp ออก ฝั่ง from จะกลายเป็น 'timestamp without time zone' ทันที
  const { rows: types } = await client.query(`
    SELECT pg_typeof(($1::date)::timestamp AT TIME ZONE 'Asia/Bangkok')::text AS from_type,
           pg_typeof((($1::date)::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok')::text AS to_type,
           pg_typeof($1::date AT TIME ZONE 'Asia/Bangkok')::text AS naive_type
  `, [DATE_FROM]);
  ok('ขอบล่าง resolve เป็น timestamptz', types[0].from_type === 'timestamp with time zone',
    `(ได้ ${types[0].from_type})`);
  ok('ขอบบน resolve เป็น timestamptz', types[0].to_type === 'timestamp with time zone',
    `(ได้ ${types[0].to_type})`);
  ok('ยืนยันว่าแบบไม่มี ::timestamp คือกับดักจริง (resolve เป็น timestamp เปล่า)',
    types[0].naive_type === 'timestamp without time zone', `(ได้ ${types[0].naive_type})`);

  // เงื่อนไขที่เอามาทดสอบ = ตัวเดียวกับที่ endpoint ใช้จริง (import มา ไม่ได้ก๊อป SQL มาวาง)
  const where = `${createdAtFromThaiDayCondition(2)} AND ${createdAtToThaiDayCondition(3)}`;
  const sql = `
    SELECT q.label, (${where}) AS matched
      FROM unnest($1::text[], $4::timestamptz[]) AS q(label, created_at)
     ORDER BY q.created_at`;

  for (const zone of SESSION_ZONES) {
    await client.query(`SET TIME ZONE '${zone}'`);

    // ── 2. ขอบเขตที่คำนวณได้ ต้องเป็นเที่ยงคืนไทยเป๊ะ ไม่ว่า session จะโซนไหน ──
    const { rows: bounds } = await client.query(`
      SELECT ((($1::date)::timestamp AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')::text AS lo,
             (((($2::date)::timestamp + INTERVAL '1 day') AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')::text AS hi
    `, [DATE_FROM, DATE_TO]);
    ok(`[${zone}] ขอบล่าง = 00:00 น. ของ ${DATE_FROM} ตามเวลาไทย`,
      bounds[0].lo === '2026-08-05 00:00:00', `(ได้ ${bounds[0].lo})`);
    ok(`[${zone}] ขอบบน = 00:00 น. ของวันถัดจาก ${DATE_TO} ตามเวลาไทย`,
      bounds[0].hi === '2026-08-06 00:00:00', `(ได้ ${bounds[0].hi})`);

    // ── 3. ผลการกรองรายแถว ต้องตรงกับที่คาดทุกโซน ────────────────────────
    const { rows } = await client.query(sql, [
      SAMPLES.map((s) => s.label), DATE_FROM, DATE_TO, SAMPLES.map((s) => s.at),
    ]);
    const wrong = rows.filter((r: any) => {
      const expected = SAMPLES.find((s) => s.label === r.label)!.expected;
      return r.matched !== expected;
    });
    ok(`[${zone}] กรอง ${DATE_FROM} → ${DATE_TO} ได้ครบทั้งวันและไม่กินวันข้างเคียง`,
      wrong.length === 0,
      wrong.length ? `(ผิด: ${wrong.map((r: any) => r.label).join(', ')})` : `(${rows.length} แถว)`);
  }
  // ── 4. เส้นทางจริง: allocateQuotationNo ต้องอิงเดือนแบบไทย ────────────────
  //    ตรวจถึงตัวฟังก์ชันที่ใช้งานจริง ไม่ใช่แค่ helper — กันการเผลอถอย quotationService
  //    กลับไปใช้ getMonth() แล้วด่านยังเขียวเพราะเทสไปจับแต่ utils
  //    เขียน quotation_counters จริงแต่ ROLLBACK ทิ้งทั้งหมด (งวด 3101 ไม่ชนของจริงอยู่แล้ว)
  await client.query('BEGIN');
  try {
    process.env.TZ = 'UTC'; // จำลอง production ที่ไม่ได้ตั้ง TZ
    const quoteNo = await allocateQuotationNo(
      { id: 'diag', customer_name: 'ลูกค้าทดสอบ', items: [], created_at: EDGE.toISOString() },
      client);
    ok(`allocateQuotationNo ใช้งวดไทย ${EDGE_PERIOD} แม้โปรเซสเป็น UTC`,
      quoteNo.startsWith(`QP-${EDGE_PERIOD}`), `(ได้ ${quoteNo})`);
  } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
    await client.query('ROLLBACK'); // ห้ามเปลี่ยนเป็น COMMIT — จะทิ้ง counter ปลอมไว้ใน DB
  }
} finally {
  // คืนค่า TimeZone ก่อนปล่อย connection กลับ pool — SET TIME ZONE ติดไปกับ session
  await client.query('RESET TIME ZONE');
  client.release();
}

console.log(failures === 0 ? '\nผ่านทั้งหมด' : `\nไม่ผ่าน ${failures} ข้อ`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
