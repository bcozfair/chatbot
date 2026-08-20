// ─────────────────────────────────────────────────────────────────────────────
//  Eval / Regression harness ของแผน A (expression index บน products)
//
//  พิสูจน์ 2 อย่าง โดยยิง SQL "ตัวเดียวกับที่โค้ดใช้จริง" ทุกตัวอักษร:
//    1) ความแม่นยำ — ผลลัพธ์ทุก stage ต้องเท่าเดิม "เป๊ะ" (ทั้งชุดแถวและลำดับ)
//    2) ความเร็ว   — วัดเวลาจริงเทียบ baseline
//
//  วิธี: ก๊อป public.products เป็นฝาแฝด 2 ชุดใน schema perf_lab
//    perf_lab.p_base = index เท่าที่ prod มีวันนี้         (ก่อน)
//    perf_lab.p_opt  = index เดิม + expression index 4 ตัว (หลัง)
//  ข้อมูลถูก freeze พร้อมกัน → ความต่างใด ๆ มาจาก index/SQL เท่านั้น ไม่ใช่ sync
//
//  รัน:  npx tsx scripts/diag/searchIndexEval.ts
//  (ต้องรัน scripts/diag/searchIndexEval.setup.sql ก่อน)
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';

const BASE = 'perf_lab.p_base';
const OPT  = 'perf_lab.p_opt';

// ── helper: คัดลอกมาจาก services/productService.ts แบบตัวต่อตัว ───────────────
function normalize(text: string = ''): string {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[\s,،\(\)]/g, '')
    .replace(/[^a-z0-9\u0E00-\u0E7F\/\-\.\+]/g, '');
}
function extractLongestNumber(text: string): string {
  const nums = String(text).match(/\d{3,}/g) || [];
  if (nums.length === 0) return '';
  return nums.sort((a, b) => b.length - a.length)[0] ?? '';
}
function extractTextPart(qNorm: string): string {
  return qNorm.replace(/\d+/g, '').replace(/^[-\/\.]+|[-\/\.]+$/g, '') || '';
}

// ── SQL: คัดลอกจาก productService.ts เปลี่ยนแค่ชื่อตาราง + คืน id/score พอ ────
const NORM_MODEL = `LOWER(REGEXP_REPLACE(COALESCE(model, ''), '[\\s,\\(\\)]', '', 'g'))`;
const NORM_NAME  = `LOWER(REGEXP_REPLACE(COALESCE(name,  ''), '[\\s,\\(\\)]', '', 'g'))`;
// stage 2 ในโค้ดจริงเขียน COALESCE(name, '') แบบ 1 ช่องว่าง — ต้องตรงเป๊ะเพื่อให้ planner จับ index
const NORM_NAME2 = `LOWER(REGEXP_REPLACE(COALESCE(name, ''), '[\\s,\\(\\)]', '', 'g'))`;

const sqlStage1 = (t: string) => `
  SELECT product_template_id, quantity_on_hand_unreserved
  FROM ${t}
  WHERE is_system_item = false
    AND ( ${NORM_MODEL} = $1 OR ${NORM_NAME} = $1 )
  ORDER BY quantity_on_hand_unreserved DESC
  LIMIT 1`;

const sqlStage13 = (t: string, conds: string) => `
  SELECT product_template_id, quantity_on_hand_unreserved
  FROM ${t}
  WHERE ${conds}
    AND production NOT ILIKE '%buytosell%'
    AND is_system_item = false
  ORDER BY quantity_on_hand_unreserved DESC
  LIMIT 10`;

const sqlStage15 = (t: string) => `
  SELECT product_template_id, quantity_on_hand_unreserved
  FROM ${t}
  WHERE ( ${NORM_MODEL} LIKE $1 OR ${NORM_NAME} LIKE $1 )
    AND production NOT ILIKE '%buytosell%'
    AND is_system_item = false
  ORDER BY quantity_on_hand_unreserved DESC
  LIMIT 10`;

const sqlStage17 = (t: string) => `
  SELECT product_template_id,
    GREATEST( similarity(${NORM_MODEL}, $2), similarity(${NORM_NAME}, $2) ) AS _score
  FROM ${t}
  WHERE ( ${NORM_MODEL} LIKE $1 OR ${NORM_NAME} LIKE $1 )
    AND production NOT ILIKE '%buytosell%'
    AND is_system_item = false
  ORDER BY _score DESC
  LIMIT 5`;

const sqlStage2 = (t: string) => `
  SELECT product_template_id,
    GREATEST( similarity(${NORM_MODEL}, $1), similarity(${NORM_NAME2}, $1) ) AS _score
  FROM ${t}
  WHERE production NOT ILIKE '%buytosell%'
    AND is_system_item = false
    AND GREATEST( similarity(${NORM_MODEL}, $1), similarity(${NORM_NAME2}, $1) ) > 0.25
  ORDER BY _score DESC
  LIMIT 8`;

// ★ stage 2 ฉบับแก้ — เติมเงื่อนไข % ที่ใช้ index ได้ "เพิ่ม" โดยคงของเดิมไว้ครบ
const sqlStage2New = (t: string) => `
  SELECT product_template_id,
    GREATEST( similarity(${NORM_MODEL}, $1), similarity(${NORM_NAME2}, $1) ) AS _score
  FROM ${t}
  WHERE production NOT ILIKE '%buytosell%'
    AND is_system_item = false
    AND ( ${NORM_MODEL} % $1 OR ${NORM_NAME2} % $1 )
    AND GREATEST( similarity(${NORM_MODEL}, $1), similarity(${NORM_NAME2}, $1) ) > 0.25
  ORDER BY _score DESC
  LIMIT 8`;

// ── utility ──────────────────────────────────────────────────────────────────
type Row = { product_template_id: number; _score?: string | number };
const ids = (rows: Row[]) => rows.map(r => r.product_template_id).join(',');
const idSet = (rows: Row[]) => new Set(rows.map(r => r.product_template_id));
const setEq = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every(x => b.has(x));

async function timed(client: any, sql: string, params: any[]): Promise<{ rows: Row[]; ms: number }> {
  const t0 = process.hrtime.bigint();
  const { rows } = await client.query(sql, params);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { rows, ms };
}

const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

// ── โหลด corpus จากประวัติจริง ────────────────────────────────────────────────
async function buildCorpus(): Promise<{ q: string; src: string }[]> {
  const out: { q: string; src: string }[] = [];
  const seen = new Set<string>();
  const add = (q: string, src: string) => {
    const k = q.trim();
    if (!k || k.length < 2 || seen.has(k.toLowerCase())) return;
    seen.add(k.toLowerCase());
    out.push({ q: k, src });
  };

  // A) รุ่นที่เคยออกใบเสนอราคาจริง — ของจริงที่ "ต้องหาเจอ"
  const a = await pool.query(
    `SELECT DISTINCT it->>'model' AS m
     FROM quotations q, jsonb_array_elements(q.item_details) it
     WHERE q.item_details IS NOT NULL AND it->>'model' IS NOT NULL AND it->>'model' <> ''`);
  a.rows.forEach((r: any) => add(r.m, 'quoted'));

  // B) บรรทัดรหัสสินค้าที่เซลส์พิมพ์เข้ามาจริงในแชท (รวมพิมพ์ผิด/รูปแบบแปลก)
  const b = await pool.query(
    `SELECT content FROM messages WHERE content IS NOT NULL AND content <> ''`);
  for (const r of b.rows as any[]) {
    for (const rawLine of String(r.content).split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line) continue;
      line = line.replace(/^\**\s*\d+\s*[\.\)]\s*/, '');          // ตัดเลขข้อ "1." "2)"
      line = line.replace(/\s*[=:]\s*\d+(\.\d+)?\s*$/, '');       // ตัด "= 2"
      line = line.replace(/\s*จำนวน\s*\d+.*$/, '');
      line = line.replace(/\s*\d+\s*(ตัว|ชิ้น|อัน|ชุด|เส้น|ม\.|เมตร)\s*$/, '');
      line = line.replace(/[.\s]+$/, '').trim();
      if (!line || line.length < 3 || line.length > 60) continue;
      if (/^(ลด|เสนอราคา|ออกใบเสนอราคา|ยืนยัน)/.test(line)) continue;
      if (/[\u0E00-\u0E7F]/.test(line)) continue;                 // ข้ามบรรทัดภาษาไทย (ชื่อลูกค้า)
      if (!/\d/.test(line) && !/-/.test(line)) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9\-\.\/+()\s%*]*$/.test(line)) continue;
      add(line, 'chat');
    }
  }

  // C) กลายพันธุ์จากรุ่นจริง — บังคับให้ตกลง stage fuzzy (ที่ index กระทบมากสุด)
  const models = a.rows.map((r: any) => String(r.m)).filter(m => m.length >= 6);
  for (let i = 0; i < models.length; i += 3) {          // เอา 1 ใน 3 พอ ไม่ให้ corpus บวมเกิน
    const m = models[i]!;
    add(m.slice(0, -1), 'mutate:truncate');             // พิมพ์ตกท้าย
    add(m.replace(/[-\/\.]/g, ''), 'mutate:nosep');      // ลืมขีด
    add(m.slice(0, 3) + ' ' + m.slice(3), 'mutate:space'); // เคาะวรรคเกิน
    if (m.length > 5) {
      const k = Math.floor(m.length / 2);
      add(m.slice(0, k) + m[k + 1] + m[k] + m.slice(k + 2), 'mutate:swap'); // สลับตัวอักษร
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
const all = await buildCorpus();
// สุ่มแบบ stratified (กระจายทุกแหล่งเท่า ๆ กัน, deterministic ไม่ใช้ random) — ตั้ง EVAL_LIMIT=0 เพื่อรันทั้งหมด
const LIMIT = process.env.EVAL_LIMIT === undefined ? 500 : Number(process.env.EVAL_LIMIT);
let corpus = all;
if (LIMIT > 0 && all.length > LIMIT) {
  const bySrc = new Map<string, { q: string; src: string }[]>();
  for (const c of all) { if (!bySrc.has(c.src)) bySrc.set(c.src, []); bySrc.get(c.src)!.push(c); }
  // round-robin ทีละแหล่ง เพื่อให้ทุกแหล่งได้โควตาเท่ากันจริง ไม่ใช่แหล่งแรกกินหมด
  const per = Math.ceil(LIMIT / bySrc.size);
  const picked: { q: string; src: string }[][] = [];
  for (const [, list] of bySrc) {
    const step = Math.max(1, Math.floor(list.length / per));
    const take: { q: string; src: string }[] = [];
    for (let k = 0; k < list.length && take.length < per; k += step) take.push(list[k]!);
    picked.push(take);
  }
  corpus = [];
  for (let r = 0; corpus.length < LIMIT; r++) {
    let any = false;
    for (const take of picked) if (take[r]) { corpus.push(take[r]!); any = true; if (corpus.length >= LIMIT) break; }
    if (!any) break;
  }
}
console.log(`corpus = ${corpus.length}/${all.length} คำค้น  (${['quoted','chat','mutate:truncate','mutate:nosep','mutate:space','mutate:swap']
  .map(s => `${s}:${corpus.filter(c => c.src === s).length}`).join('  ')})`);

const cBase = await pool.connect();
const cOpt  = await pool.connect();
await cOpt.query(`SELECT set_limit(0.25)`);            // ให้ % ครอบ 0.25 (หลวมกว่า > 0.25 = superset)
const limOpt = (await cOpt.query(`SELECT show_limit() AS l`)).rows[0].l;
const limBase = (await cBase.query(`SELECT show_limit() AS l`)).rows[0].l;
console.log(`pg_trgm threshold: base=${limBase}  opt=${limOpt}\n`);

type Stat = { n: number; mismatchOrder: number; mismatchSet: number; tBase: number[]; tOpt: number[] };
const mk = (): Stat => ({ n: 0, mismatchOrder: 0, mismatchSet: 0, tBase: [], tOpt: [] });
const stats: Record<string, Stat> = { s1: mk(), s13: mk(), s15: mk(), s17: mk(), s2: mk(), s2rw: mk() };
const problems: string[] = [];
// นับเคสที่ % ที่ threshold 0.3 (ค่า default) จะ "ตัดแถวหาย" → ความเสี่ยงถ้าลืม set_limit
let riskyIfDefaultLimit = 0;
let riskyChecked = 0;
// สองการวัดนี้ยิง Seq Scan เพิ่มอีก ~1.9 วิ/คำค้น — เก็บแค่ตัวอย่างแรกก็สรุปได้แล้ว
const DEEP_N = Number(process.env.EVAL_DEEP_N ?? 60);
const slow: { q: string; len: number; ms: number; base: number; rows: number }[] = [];

// warm-up: ยิงทุก stage บนทั้งสองตารางก่อน 3 รอบ ไม่บันทึกผล
// (ไม่งั้นคำค้นแรก ๆ จะกินเวลา cold buffer ของตารางทั้งใบไปคนเดียว ทำให้ตัวเลขบิดเบือน)
for (const w of ['ttm-007w-r-a', 'cma-001', 'pmv205np220']) {
  await cBase.query(sqlStage1(BASE), [w]);  await cOpt.query(sqlStage1(OPT), [w]);
  await cBase.query(sqlStage15(BASE), ['%220%']); await cOpt.query(sqlStage15(OPT), ['%220%']);
  await cBase.query(sqlStage2(BASE), [w]);  await cOpt.query(sqlStage2New(OPT), [w]);
}
console.log('warm-up เสร็จ — เริ่มวัดจริง\n');

let i = 0;
for (const { q, src } of corpus) {
  i++;
  const qNorm = normalize(q);
  if (!qNorm) continue;

  // ── stage 1 ──
  {
    const st = stats.s1!;
    const b = await timed(cBase, sqlStage1(BASE), [qNorm]);
    const o = await timed(cOpt,  sqlStage1(OPT),  [qNorm]);
    st.n++; st.tBase.push(b.ms); st.tOpt.push(o.ms);
    if (ids(b.rows) !== ids(o.rows)) {
      st.mismatchOrder++;
      if (!setEq(idSet(b.rows), idSet(o.rows))) { st.mismatchSet++; problems.push(`S1  [${src}] "${q}" base=${ids(b.rows)} opt=${ids(o.rows)}`); }
    }
  }

  // ── stage 1.3 ──
  {
    const rawTokens = q.split(/\s+/).filter(Boolean);
    const tokens = rawTokens.filter(t => t.length >= 2 || /\d/.test(t));
    if (tokens.length >= 2) {
      const conds = tokens.map((_, idx) => `(model ILIKE $${idx + 1} OR name ILIKE $${idx + 1})`).join(' AND ');
      const vals = tokens.map(t => `%${t}%`);
      const st = stats.s13!;
      const b = await timed(cBase, sqlStage13(BASE, conds), vals);
      const o = await timed(cOpt,  sqlStage13(OPT,  conds), vals);
      st.n++; st.tBase.push(b.ms); st.tOpt.push(o.ms);
      if (ids(b.rows) !== ids(o.rows)) {
        st.mismatchOrder++;
        if (!setEq(idSet(b.rows), idSet(o.rows))) { st.mismatchSet++; problems.push(`S1.3 [${src}] "${q}"`); }
      }
    }
  }

  const numericCode = extractLongestNumber(q);
  const textPart = extractTextPart(qNorm);

  // ── stage 1.5 ──
  if (numericCode) {
    const st = stats.s15!;
    const b = await timed(cBase, sqlStage15(BASE), [`%${numericCode}%`]);
    const o = await timed(cOpt,  sqlStage15(OPT),  [`%${numericCode}%`]);
    st.n++; st.tBase.push(b.ms); st.tOpt.push(o.ms);
    if (ids(b.rows) !== ids(o.rows)) {
      st.mismatchOrder++;
      if (!setEq(idSet(b.rows), idSet(o.rows))) { st.mismatchSet++; problems.push(`S1.5 [${src}] "${q}" num=${numericCode}`); }
    }
  }

  // ── stage 1.7 ──
  if (numericCode && textPart && textPart.length >= 2) {
    const st = stats.s17!;
    const b = await timed(cBase, sqlStage17(BASE), [`%${numericCode}%`, textPart]);
    const o = await timed(cOpt,  sqlStage17(OPT),  [`%${numericCode}%`, textPart]);
    st.n++; st.tBase.push(b.ms); st.tOpt.push(o.ms);
    if (ids(b.rows) !== ids(o.rows)) {
      st.mismatchOrder++;
      if (!setEq(idSet(b.rows), idSet(o.rows))) { st.mismatchSet++; problems.push(`S1.7 [${src}] "${q}"`); }
    }
  }

  // ── stage 2: ของเดิม(base) vs ของเดิม(opt) vs ฉบับแก้(opt) ──
  {
    const st = stats.s2!, st2 = stats.s2rw!;
    const b  = await timed(cBase, sqlStage2(BASE),    [qNorm]);
    const rw = await timed(cOpt,  sqlStage2New(OPT),  [qNorm]);
    const o  = i <= DEEP_N ? await timed(cOpt, sqlStage2(OPT), [qNorm]) : null;
    if (o) { st.n++; st.tBase.push(b.ms); st.tOpt.push(o.ms); }
    st2.n++; st2.tBase.push(b.ms); st2.tOpt.push(rw.ms);
    slow.push({ q: qNorm, len: qNorm.length, ms: rw.ms, base: b.ms, rows: b.rows.length });
    if (o && ids(b.rows) !== ids(o.rows)) {
      st.mismatchOrder++;
      if (!setEq(idSet(b.rows), idSet(o.rows))) { st.mismatchSet++; problems.push(`S2 idx [${src}] "${q}"`); }
    }
    if (ids(b.rows) !== ids(rw.rows)) {
      st2.mismatchOrder++;
      if (!setEq(idSet(b.rows), idSet(rw.rows))) {
        st2.mismatchSet++;
        problems.push(`S2 rewrite [${src}] "${q}"\n     base=${ids(b.rows)}\n     new =${ids(rw.rows)}`);
      }
    }
    // ทดสอบความเสี่ยง: ถ้า threshold ยังเป็น 0.3 (ลืม set_limit) จะหายแถวไหม
    if (b.rows.length && i <= DEEP_N) {
      riskyChecked++;
      await cBase.query(`SELECT set_limit(0.3)`);
      const risky = await cBase.query(sqlStage2New(BASE), [qNorm]);
      if (ids(risky.rows) !== ids(b.rows)) riskyIfDefaultLimit++;
    }
  }

  if (i % 50 === 0) { console.log(`  ...${i}/${corpus.length}`); }
}

// ── รายงาน ───────────────────────────────────────────────────────────────────
const label: Record<string, string> = {
  s1: 'Stage 1   exact', s13: 'Stage 1.3 multi-token', s15: 'Stage 1.5 numeric LIKE',
  s17: 'Stage 1.7 split fuzzy', s2: 'Stage 2   (index อย่างเดียว)', s2rw: 'Stage 2   (index + แก้ SQL)',
};
console.log(`\n${'stage'.padEnd(30)} ${'n'.padStart(5)} ${'ต่างชุดแถว'.padStart(11)} ${'ต่างลำดับ'.padStart(10)} ${'ก่อน p50'.padStart(10)} ${'หลัง p50'.padStart(10)} ${'ก่อน p95'.padStart(10)} ${'หลัง p95'.padStart(10)}`);
console.log('-'.repeat(105));
let hardFail = 0;
for (const k of Object.keys(stats)) {
  const s = stats[k]!;
  if (!s.n) continue;
  hardFail += s.mismatchSet;
  console.log(
    `${label[k]!.padEnd(30)} ${String(s.n).padStart(5)} ${String(s.mismatchSet).padStart(11)} ${String(s.mismatchOrder).padStart(10)} ` +
    `${pct(s.tBase, 50).toFixed(2).padStart(10)} ${pct(s.tOpt, 50).toFixed(2).padStart(10)} ` +
    `${pct(s.tBase, 95).toFixed(2).padStart(10)} ${pct(s.tOpt, 95).toFixed(2).padStart(10)}`);
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const totBase = sum(Object.values(stats).filter((_, idx) => idx < 5).flatMap(s => s.tBase));
const totOpt  = sum(Object.values(stats).filter((_, idx) => idx < 5).flatMap(s => s.tOpt));
console.log(`\nเวลารวมทุก query (stage 1–2 ของเดิม): ก่อน ${(totBase / 1000).toFixed(1)}s → หลัง ${(totOpt / 1000).toFixed(1)}s  (${(totBase / totOpt).toFixed(1)}× เร็วขึ้น)`);
console.log(`ถ้าลืม set_limit(0.25) แล้วใช้ค่า default 0.3 → stage 2 ให้ผลต่างจากเดิม ${riskyIfDefaultLimit}/${riskyChecked} เคส (${(100*riskyIfDefaultLimit/Math.max(1,riskyChecked)).toFixed(1)}%)`);

// ── เจาะเคสที่ stage 2 ฉบับแก้ยังช้า ──
slow.sort((a, b) => b.ms - a.ms);
console.log(`\nStage 2 ฉบับแก้ — 10 เคสช้าสุด (ดูว่าความยาว query สั้นเกิน 3 ตัวอักษรทำให้ trigram ใช้ index ไม่ได้ไหม):`);
console.log(`   ${'query'.padEnd(28)} ${'ยาว'.padStart(4)} ${'แถว'.padStart(4)} ${'ก่อน ms'.padStart(9)} ${'หลัง ms'.padStart(9)}`);
for (const r of slow.slice(0, 10))
  console.log(`   ${r.q.slice(0, 28).padEnd(28)} ${String(r.len).padStart(4)} ${String(r.rows).padStart(4)} ${r.base.toFixed(1).padStart(9)} ${r.ms.toFixed(1).padStart(9)}`);
const byLen = (lo: number, hi: number) => slow.filter(r => r.len >= lo && r.len <= hi);
console.log(`\n   แยกตามความยาว query (stage 2 ฉบับแก้):`);
for (const [lo, hi] of [[1, 2], [3, 4], [5, 8], [9, 12], [13, 99]] as [number, number][]) {
  const g = byLen(lo, hi);
  if (!g.length) continue;
  console.log(`     ยาว ${String(lo).padStart(2)}-${String(hi).padEnd(2)}  n=${String(g.length).padStart(4)}  ก่อน p50=${pct(g.map(x => x.base), 50).toFixed(1).padStart(7)}ms  หลัง p50=${pct(g.map(x => x.ms), 50).toFixed(1).padStart(7)}ms  หลัง p95=${pct(g.map(x => x.ms), 95).toFixed(1).padStart(7)}ms`);
}

if (problems.length) {
  console.log(`\n⚠️ รายละเอียดเคสที่ "ชุดแถวต่างกัน" (${problems.length} เคส, แสดง 25 แรก):`);
  problems.slice(0, 25).forEach(p => console.log('   ' + p));
}

cBase.release(); cOpt.release();
await pool.end();
console.log(hardFail === 0 ? '\n✅ REGRESSION PASS — ทุก stage คืนชุดสินค้าเดิมครบถ้วน' : `\n❌ REGRESSION FAIL — ต่างกัน ${hardFail} เคส`);
process.exitCode = hardFail === 0 ? 0 : 1;  // ห้ามใช้ process.exit() — มันตัด stdout ที่ยังค้างใน pipe ทิ้ง
