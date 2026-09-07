// ─────────────────────────────────────────────────────────────────────────────
//  Eval หลัง deploy แผน A — พิสูจน์ว่าการค้นหาสินค้ายัง "ถูกต้องเหมือนเดิม"
//
//  ไม่ต้องสร้างตารางฝาแฝดใน perf_lab แล้ว เพราะ index ขึ้น public.products จริงไปแล้ว
//  จึงเทียบได้บน "ตารางเดียวกัน ข้อมูลชุดเดียวกัน วินาทีเดียวกัน":
//    ของเดิม = stage 2 ก่อนแก้ (ไม่มีด่าน %)         → Seq Scan ทั้งตาราง
//    ของใหม่ = stage 2 ที่ deploy อยู่จริง (มีด่าน %) → Bitmap Index Scan
//  ผลต่างใด ๆ จึงมาจากด่าน % เท่านั้น ซึ่งเป็น logic เดียวที่แผน A เปลี่ยน
//
//  ★ วัดที่ "ชุดผลลัพธ์เต็มก่อนตัด LIMIT 8" ไม่ใช่ผลหลังตัด
//    เพราะ ORDER BY _score DESC LIMIT 8 ไม่มีตัวตัดสินเมื่อคะแนนเท่ากัน — ของเดิม
//    ก็สุ่มเอาอยู่แล้วว่าแถวไหนใน 8 ที่นั่งสุดท้าย เทียบผลหลัง LIMIT จึงจับได้แต่
//    ความกำกวมที่มีมาแต่เดิม ไม่ใช่ความเพี้ยนจากแผน A
//    ชุดเต็ม = ตัวชี้ขาดจริง: ถ้าเท่ากันทุกคำค้น แปลว่าด่าน % ไม่เคยตัดแถวไหนทิ้ง
//
//  corpus = ประวัติแชท + ใบเสนอราคา ย้อนหลัง 7 วัน (ปรับด้วย EVAL_DAYS)
//  รัน:  docker compose exec -T app npx tsx scripts/diag/searchPostDeployEval.ts
//
//  ⚠️ ทุก query เป็น transaction สั้น ๆ ไม่เปิดค้าง เพราะ transaction ยาวจะบล็อก
//     CREATE INDEX CONCURRENTLY ของคนอื่นที่รออยู่ที่ wait_event = virtualxid
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { findProduct } from '../../services/productService.js';

const DAYS  = Number(process.env.EVAL_DAYS ?? 7);
const LIMIT = process.env.EVAL_LIMIT === undefined ? 0 : Number(process.env.EVAL_LIMIT);
const E2E_N = Number(process.env.EVAL_E2E_N ?? 25);   // ⚠️ findProduct() อาจเรียก LLM — ตั้งน้อย ๆ พอให้รู้ว่าไม่ error

// ── normalize: คัดลอกจาก services/productService.ts แบบตัวต่อตัว ──────────────
function normalize(text: string = ''): string {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[\s,،\(\)]/g, '')
    .replace(/[^a-z0-9฀-๿\/\-\.\+]/g, '');
}

// ── SQL: ก๊อปเงื่อนไขจากโค้ดจริง ต่างกันแค่ท่อนด่าน % ─────────────────────────
const SCORE = `GREATEST(
    similarity(LOWER(REGEXP_REPLACE(COALESCE(model, ''), '[\\s,\\(\\)]', '', 'g')), $1),
    similarity(LOWER(REGEXP_REPLACE(COALESCE(name, ''),  '[\\s,\\(\\)]', '', 'g')), $1))`;
const PREFILTER = `
      AND (
        LOWER(REGEXP_REPLACE(COALESCE(model, ''), '[\\s,\\(\\)]', '', 'g')) % $1
        OR LOWER(REGEXP_REPLACE(COALESCE(name, ''), '[\\s,\\(\\)]', '', 'g')) % $1
      )`;

// คืนแถวเดียว: จำนวนแถวที่ผ่านเกณฑ์ + ลายนิ้วมือ md5 ของ (id:คะแนน) ทั้งชุด
//   → เทียบ n กับ h เท่ากับเทียบ "ชุดผลลัพธ์เต็ม" ทีละแถวโดยไม่ต้องดึงข้อมูลกลับมา
// พร้อมบอกว่าที่นั่งสุดท้ายของ LIMIT 8 มีแถวคะแนนเท่ากันแย่งกันกี่แถว
const probe = (withPrefilter: boolean) => `
  WITH s AS (
    SELECT product_template_id AS id, ${SCORE} AS sc
    FROM products
    WHERE production NOT ILIKE '%buytosell%'
      AND is_system_item = false${withPrefilter ? PREFILTER : ''}
  ), f AS (
    SELECT id, round(sc::numeric, 9) AS sc FROM s WHERE sc > 0.25
  ), cut AS (
    SELECT sc FROM f ORDER BY sc DESC, id OFFSET 7 LIMIT 1
  )
  SELECT (SELECT count(*)::int FROM f)                                                  AS n_all,
         (SELECT md5(string_agg(id::text || ':' || sc::text, ',' ORDER BY id)) FROM f)   AS h_all,
         (SELECT string_agg(id::text, ',' ORDER BY sc DESC, id)
            FROM (SELECT id, sc FROM f ORDER BY sc DESC, id LIMIT 8) t)                  AS top8,
         (SELECT count(*)::int FROM f WHERE sc >  (SELECT sc FROM cut))                  AS n_above_cut,
         (SELECT count(*)::int FROM f WHERE sc =  (SELECT sc FROM cut))                  AS n_at_cut`;

const SQL_OLD = probe(false);   // ก่อนแผน A
const SQL_NEW = probe(true);    // ที่ deploy อยู่จริงตอนนี้

type Probe = { n_all: number; h_all: string | null; top8: string | null; n_above_cut: number; n_at_cut: number };

const pct = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

// ── corpus จากของจริงย้อนหลัง N วัน ──────────────────────────────────────────
async function buildCorpus(): Promise<{ q: string; src: string }[]> {
  const out: { q: string; src: string }[] = [];
  const seen = new Set<string>();
  const add = (q: string, src: string) => {
    const k = q.trim();
    if (!k || k.length < 2 || seen.has(k.toLowerCase())) return;
    seen.add(k.toLowerCase());
    out.push({ q: k, src });
  };

  // A) รุ่นที่ออกใบเสนอราคาจริงใน N วันนี้ — ของจริงที่ "ต้องหาเจอ"
  const a = await pool.query(
    `SELECT DISTINCT it->>'model' AS m
     FROM quotations q, jsonb_array_elements(q.item_details) it
     WHERE q.created_at > now() - ($1 || ' days')::interval
       AND q.item_details IS NOT NULL AND it->>'model' IS NOT NULL AND it->>'model' <> ''`,
    [String(DAYS)]);
  a.rows.forEach((r: any) => add(r.m, 'quoted'));

  // B) บรรทัดที่เซลส์พิมพ์เข้ามาจริงในแชท N วันนี้ (รวมพิมพ์ผิด/รูปแบบแปลก)
  const b = await pool.query(
    `SELECT content FROM messages
     WHERE created_at > now() - ($1 || ' days')::interval
       AND content IS NOT NULL AND content <> ''`,
    [String(DAYS)]);
  for (const r of b.rows as any[]) {
    for (const rawLine of String(r.content).split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line) continue;
      line = line.replace(/^\**\s*\d+\s*[\.\)]\s*/, '');
      line = line.replace(/\s*[=:]\s*\d+(\.\d+)?\s*$/, '');
      line = line.replace(/\s*จำนวน\s*\d+.*$/, '');
      line = line.replace(/\s*\d+\s*(ตัว|ชิ้น|อัน|ชุด|เส้น|ม\.|เมตร)\s*$/, '');
      line = line.replace(/[.\s]+$/, '').trim();
      if (!line || line.length < 3 || line.length > 60) continue;
      if (/^(ลด|เสนอราคา|ออกใบเสนอราคา|ยืนยัน)/.test(line)) continue;
      if (/[฀-๿]/.test(line)) continue;
      if (!/\d/.test(line) && !/-/.test(line)) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9\-\.\/+()\s%*]*$/.test(line)) continue;
      add(line, 'chat');
    }
  }

  // C) กลายพันธุ์จากรุ่นจริง — บังคับให้ตกลง stage 2 ซึ่งเป็นจุดเดียวที่ logic เปลี่ยน
  const models = a.rows.map((r: any) => String(r.m)).filter((m: string) => m.length >= 6);
  for (const m of models) {
    add(m.slice(0, -1), 'mutate:truncate');
    add(m.replace(/[-\/\.]/g, ''), 'mutate:nosep');
    add(m.slice(0, 3) + ' ' + m.slice(3), 'mutate:space');
    const k = Math.floor(m.length / 2);
    add(m.slice(0, k) + m[k + 1] + m[k] + m.slice(k + 2), 'mutate:swap');
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
const all = await buildCorpus();
const corpus = LIMIT > 0 ? all.slice(0, LIMIT) : all;
const srcs = [...new Set(corpus.map(c => c.src))];
console.log(`corpus = ${corpus.length} คำค้น จากของจริงย้อนหลัง ${DAYS} วัน  (${srcs.map(s => `${s}:${corpus.filter(c => c.src === s).length}`).join('  ')})`);

const cOld = await pool.connect();
const cNew = await pool.connect();

let checked = 0;
let diffFullSet = 0;          // ★ ตัวชี้ขาด — ต้องเป็น 0
let diffTop8 = 0;             // ต่างหลังตัด LIMIT 8
let diffTop8Tie = 0;          //   ในนั้น เป็นเพราะคะแนนเท่ากันแย่งที่นั่งสุดท้าย
let ambiguousByDesign = 0;    // เคสที่ LIMIT 8 กำกวมมาแต่เดิม (ของเดิมก็สุ่มเอา)
let riskyDefault = 0, riskyChecked = 0;
const tOld: number[] = [], tNew: number[] = [];
const problems: string[] = [];
const slow: { q: string; len: number; old: number; nw: number; rows: number }[] = [];

// warm-up ให้ buffer ร้อนก่อน ไม่งั้นคำค้นแรกกินเวลา cold read ไปคนเดียว
for (const w of ['pmv205np220', 'cma-001', 'ttm-007w-r-a']) {
  await cOld.query(SQL_OLD, [w]);
  await cNew.query(SQL_NEW, [w]);
}
console.log('warm-up เสร็จ — เริ่มเทียบผลจริง\n');

let i = 0;
for (const { q, src } of corpus) {
  i++;
  const qNorm = normalize(q);
  if (!qNorm) continue;

  const t0 = process.hrtime.bigint();
  const o = (await cOld.query<Probe>(SQL_OLD, [qNorm])).rows[0]!;
  const msOld = Number(process.hrtime.bigint() - t0) / 1e6;

  // จำลองโค้ดที่ deploy อยู่เป๊ะ ๆ: transaction สั้น + SET LOCAL 0.25
  const t1 = process.hrtime.bigint();
  await cNew.query('BEGIN');
  await cNew.query(`SET LOCAL pg_trgm.similarity_threshold = 0.25`);
  const n = (await cNew.query<Probe>(SQL_NEW, [qNorm])).rows[0]!;
  await cNew.query('COMMIT');
  const msNew = Number(process.hrtime.bigint() - t1) / 1e6;

  checked++; tOld.push(msOld); tNew.push(msNew);
  slow.push({ q: qNorm, len: qNorm.length, old: msOld, nw: msNew, rows: o.n_all });

  // ★ ตัวชี้ขาด: ชุดผลลัพธ์เต็ม (id + คะแนน ทุกแถว) ต้องเหมือนกันเป๊ะ
  if (o.n_all !== n.n_all || o.h_all !== n.h_all) {
    diffFullSet++;
    problems.push(`[${src}] "${q}" (norm=${qNorm}) ชุดเต็มต่างกัน: เดิม n=${o.n_all} h=${o.h_all} / ใหม่ n=${n.n_all} h=${n.h_all}`);
  }

  // หลังตัด LIMIT 8 — ต่างได้ถ้าคะแนนเท่ากันแย่งที่นั่งสุดท้าย (ของเดิมก็กำกวมอยู่แล้ว)
  const slots = 8 - o.n_above_cut;
  if (o.n_all >= 8 && o.n_at_cut > slots) ambiguousByDesign++;
  if ((o.top8 ?? '') !== (n.top8 ?? '')) {
    diffTop8++;
    if (o.n_at_cut > slots) diffTop8Tie++;
    else problems.push(`[${src}] "${q}" top8 ต่างโดยไม่ได้เกิดจาก tie: เดิม=${o.top8} ใหม่=${n.top8}`);
  }

  // ความเสี่ยงถ้าลืม SET LOCAL: ปล่อย threshold ตาม default 0.3 (นอก transaction)
  if (o.n_all > 0) {
    riskyChecked++;
    const risky = (await cNew.query<Probe>(SQL_NEW, [qNorm])).rows[0]!;
    if (risky.n_all !== o.n_all || risky.h_all !== o.h_all) riskyDefault++;
  }

  if (i % 100 === 0) console.log(`  ...${i}/${corpus.length}  (ชุดเต็มต่างกันสะสม ${diffFullSet})`);
}

// ── ชั้นที่ 2: ยิง findProduct() ตัวจริงที่ deploy อยู่ end-to-end ─────────────
console.log(`\nยิง findProduct() ตัวจริง end-to-end ${Math.min(E2E_N, corpus.length)} คำค้น...`);
const e2e: number[] = [];
let e2eFound = 0, e2eErr = 0;
const e2eErrs: string[] = [];
for (const { q } of corpus.slice(0, E2E_N)) {
  const t0 = process.hrtime.bigint();
  try {
    const r: any = await findProduct(q);
    if (r && r.product) e2eFound++;
  } catch (e: any) {
    e2eErr++;
    if (e2eErrs.length < 5) e2eErrs.push(`"${q}" → ${e?.message ?? e}`);
  }
  e2e.push(Number(process.hrtime.bigint() - t0) / 1e6);
}

// ── รายงาน ───────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(80)}`);
console.log(`ความถูกต้อง — stage 2 (จุดเดียวที่ logic เปลี่ยน) บนตารางจริงตัวเดียวกัน`);
console.log(`${'='.repeat(80)}`);
console.log(`  คำค้นที่เทียบ                        ${checked}`);
console.log(`  ★ ชุดผลลัพธ์เต็มต่างกัน                ${diffFullSet}   ← ตัวชี้ขาด ต้องเป็น 0`);
console.log(`     (เทียบ id + คะแนนทุกแถวที่ผ่าน > 0.25 ด้วยลายนิ้วมือ md5)`);
console.log(`  หลังตัด LIMIT 8 ต่างกัน                ${diffTop8}`);
console.log(`     ในนั้น เกิดจากคะแนนเท่ากันแย่งที่นั่งท้าย  ${diffTop8Tie}`);
console.log(`  เคสที่ LIMIT 8 กำกวมมาแต่เดิม           ${ambiguousByDesign}/${checked}  (ของเดิมก็เลือกไม่แน่นอนอยู่แล้ว)`);
console.log(`  ถ้าลืม SET LOCAL แล้วใช้ default 0.3     ผลเพี้ยน ${riskyDefault}/${riskyChecked} เคส (${(100 * riskyDefault / Math.max(1, riskyChecked)).toFixed(1)}%)`);

console.log(`\nความเร็ว stage 2 (นับทั้งชุดเต็ม ไม่ตัด LIMIT — หนักกว่าของจริง)`);
console.log(`  ก่อน (Seq Scan)  p50 ${pct(tOld, 50).toFixed(1)} ms   p95 ${pct(tOld, 95).toFixed(1)} ms   รวม ${(sum(tOld) / 1000).toFixed(1)} s`);
console.log(`  หลัง (มีด่าน %)  p50 ${pct(tNew, 50).toFixed(1)} ms   p95 ${pct(tNew, 95).toFixed(1)} ms   รวม ${(sum(tNew) / 1000).toFixed(1)} s`);
console.log(`  เร็วขึ้น ${(sum(tOld) / Math.max(1, sum(tNew))).toFixed(1)}×`);

console.log(`\nfindProduct() ตัวจริงที่ deploy อยู่ (ครบทุก stage)`);
console.log(`  n=${e2e.length}  หาเจอ ${e2eFound}  error ${e2eErr}`);
console.log(`  p50 ${pct(e2e, 50).toFixed(0)} ms   p95 ${pct(e2e, 95).toFixed(0)} ms   สูงสุด ${Math.max(...e2e, 0).toFixed(0)} ms`);
e2eErrs.forEach(e => console.log(`  ⚠️ ${e}`));

slow.sort((a, b) => b.nw - a.nw);
console.log(`\nstage 2 หลังแก้ — 8 เคสช้าสุด`);
console.log(`   ${'query'.padEnd(26)} ${'ยาว'.padStart(4)} ${'แถวผ่าน'.padStart(8)} ${'ก่อน ms'.padStart(9)} ${'หลัง ms'.padStart(9)}`);
for (const r of slow.slice(0, 8))
  console.log(`   ${r.q.slice(0, 26).padEnd(26)} ${String(r.len).padStart(4)} ${String(r.rows).padStart(8)} ${r.old.toFixed(1).padStart(9)} ${r.nw.toFixed(1).padStart(9)}`);

if (problems.length) {
  console.log(`\n⚠️ เคสที่ผลไม่ตรง (${problems.length} เคส แสดง 25 แรก):`);
  problems.slice(0, 25).forEach(p => console.log('   ' + p));
}

cOld.release(); cNew.release();
await pool.end();
const fail = diffFullSet + e2eErr + problems.length;
console.log(fail === 0
  ? `\n✅ PASS — ชุดผลลัพธ์เต็มเหมือนเดิมทุกคำค้น (${checked} เคส) ด่าน % ไม่เคยตัดแถวไหนทิ้ง และ findProduct() ทำงานปกติไม่มี error`
  : `\n❌ FAIL — มีปัญหา ${fail} จุด`);
process.exitCode = fail === 0 ? 0 : 1;   // ห้ามใช้ process.exit() — มันตัด stdout ที่ค้างใน pipe ทิ้ง
