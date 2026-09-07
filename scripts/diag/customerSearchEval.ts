// ─────────────────────────────────────────────────────────────────────────────
//  ชุดตรวจการค้นหาลูกค้า — ใช้ก่อน/หลังแก้ findCustomerCandidates ทุกครั้ง
//
//  ตอบคำถามเดียว: "แก้แล้วลูกค้าที่ระบบเลือกให้ ยังเป็นคนเดิมไหม"
//
//  วิธีที่ทำให้ตัวเลขเชื่อได้:
//   1. ไม่ commit สำเนาโค้ดแช่แข็ง — สร้างสำเนาทดสอบจาก services/customerService.ts
//      ตอนรัน แล้วลบทิ้งเมื่อจบ สำเนาจึงตรงกับ production เสมอ ถ้าโครงสร้างต้นทาง
//      เปลี่ยนจนแปลงไม่ได้ จะโยน error ทันที (ดีกว่าเงียบ ๆ แล้วทดสอบโค้ดผิดตัว)
//      สิ่งเดียวที่สำเนาต่างจากของจริง = แขวนหัว LLM ได้ + เปิดช่องดู cache
//   2. จำคำตอบ LLM ไว้ในดิสก์ตาม prompt — รันซ้ำได้ผลเดิมและไม่เสียเงินเพิ่ม
//      ความต่างที่เห็นจึงมาจากโค้ดล้วน ๆ ไม่ใช่ความสุ่มของโมเดล
//   3. รันเรียงทีละเคส ไม่ขนาน — ไม่งั้นตัวเลขเวลาใช้ไม่ได้
//
//  ชุดข้อมูล (data/eval/):
//    customer_search_cases.json     เคสที่มีเฉลย — รวมเคสที่เคยพบปัญหาทั้งหมด
//    customer_search_corpus.json    คำค้นจริงจากแชท สกัดด้วย prompt production
//    customer_search_baseline.json  ผลลัพธ์ที่ถือว่าถูก ไว้เทียบครั้งต่อไป
//
//  รัน:
//    npm run diag:customer-search -- --save     บันทึก baseline (ตอนที่ของยังดีอยู่)
//    npm run diag:customer-search               เทียบกับ baseline
//    npm run diag:customer-search -- --refresh-corpus   ดูดคำค้นจริงชุดใหม่
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../../config/db.js';
import { createChatCompletion } from '../../config/clients.js';
import { getSalespersonByUserId } from '../../db/repositories.js';
import { buildExtractionPrompt, parseAiJson } from './extractionCore.js';

const ARGV = process.argv.slice(2);
const SAVE = ARGV.includes('--save');
const REFRESH_CORPUS = ARGV.includes('--refresh-corpus');
const N = Number(process.env.EVAL_N || 300);
const DAYS = Number(process.env.EVAL_DAYS || 30);

const SRC = resolve('services/customerService.ts');
const GEN = resolve('services/__customerServiceEval.gen.ts');
const DIR = 'data/eval';
const GRADED = `${DIR}/customer_search_cases.json`;
const CORPUS = `${DIR}/customer_search_corpus.json`;
const BASELINE = `${DIR}/customer_search_baseline.json`;
const LLM_CACHE = `${DIR}/customer_search_llm_cache.json`;

const ESC = String.fromCharCode(27);
const G = ESC + '[32m', R = ESC + '[31m', Y = ESC + '[33m';
const D = ESC + '[2m', B = ESC + '[1m', X = ESC + '[0m';

const pct = (a: number[], p: number) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil(a.length * p) - 1)] : 0;

/**
 * ชื่อลูกค้าบาง record ใน DB มี NBSP (U+00A0) คั่นแทนช่องว่างปกติ ตาเปล่าเหมือนกันเป๊ะ
 * แต่เทียบสตริงตรง ๆ ไม่ตรง — ถ้าไม่รวบช่องว่างก่อน ชุดทดสอบจะรายงาน "ผิด" หลอก ๆ
 * ทั้งที่ค้นเจอบริษัทถูกตัวแล้ว (\s ของ JS ครอบ U+00A0 อยู่แล้ว)
 */
const sameName = (a: string, b: string) =>
  String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();

// ─────────────────────────────────────────────────────────────────────────────
//  1. สร้างสำเนาทดสอบจากโค้ด production ปัจจุบัน
// ─────────────────────────────────────────────────────────────────────────────
const IMPORT_LINE = "import { createChatCompletion } from '../config/clients.js';";
const CLEAR_FN = [
  'export function clearCustomerSearchCache(): void {',
  '  customerCacheGen++;',
  '  customerCache = null;',
  '  customerCacheLoading = null;',
  '}',
].join('\n');

const HOOK_LLM = `
// ─── [EVAL ONLY] แขวนหัว LLM ได้ มีเฉพาะในสำเนาทดสอบ ไม่มีใน production ───
let __evalLlmFn: any = null;
export function __setEvalLlm(fn: any) { __evalLlmFn = fn; }
const __evalLlmCall = (a: any) => (__evalLlmFn ? __evalLlmFn(a) : createChatCompletion(a));`;

const HOOK_CACHE = `
/** [EVAL ONLY] ทำให้ cache หมดอายุโดยไม่ทิ้งข้อมูล — จำลองสถานการณ์ TTL หมด */
export function __expireCustomerCache(ageMs = 11 * 60 * 1000): void {
  if (customerCache) customerCache.loadedAt = Date.now() - ageMs;
}
/** [EVAL ONLY] เรียก loader ตรง ๆ — วัดเฉพาะต้นทุน cache ไม่ปนเวลา search/LLM */
export function __loadCache(): Promise<any[]> { return loadCustomerSearchCache(); }
/** [EVAL ONLY] สถานะ cache ปัจจุบัน */
export function __cacheState() {
  return {
    has: !!customerCache,
    rows: customerCache?.rows.length ?? 0,
    ageMs: customerCache ? Date.now() - customerCache.loadedAt : -1,
    loading: !!customerCacheLoading,
  };
}`;

function generateEvalModule(): void {
  let s = readFileSync(SRC, 'utf8');
  const need = (needle: string, want: number, label: string) => {
    const got = s.split(needle).length - 1;
    if (got !== want) {
      throw new Error(
        `โครงสร้าง services/customerService.ts เปลี่ยนไป: "${label}" เจอ ${got} ที่ ต้องเจอ ${want} ที่\n` +
        '→ แก้ตัวแปลงใน scripts/diag/customerSearchEval.ts ให้ตรงก่อน แล้วค่อยรันใหม่\n' +
        '  (ตั้งใจให้พังดัง ๆ ตรงนี้ ดีกว่าปล่อยผ่านแล้วไปทดสอบโค้ดผิดตัว)');
    }
  };

  need(IMPORT_LINE, 1, 'import createChatCompletion');
  s = s.replace(IMPORT_LINE, IMPORT_LINE + HOOK_LLM);

  // แขวนหัวทั้ง Pre-Search และ AI-Customer — prompt ไม่ถูกแตะแม้แต่ตัวอักษรเดียว
  need('await createChatCompletion({', 2, 'จุดเรียก LLM');
  s = s.split('await createChatCompletion({').join('await __evalLlmCall({');

  need(CLEAR_FN, 1, 'clearCustomerSearchCache');
  s = s.replace(CLEAR_FN, CLEAR_FN + '\n' + HOOK_CACHE);

  writeFileSync(GEN, s);
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. จำคำตอบ LLM ลงดิสก์ — รันซ้ำได้ผลเดิมและไม่เสียเงินเพิ่ม
// ─────────────────────────────────────────────────────────────────────────────
type LlmCache = Record<string, string>;
let llmCache: LlmCache = existsSync(LLM_CACHE) ? JSON.parse(readFileSync(LLM_CACHE, 'utf8')) : {};
let llmReal = 0, llmReplay = 0;

const llmKey = (args: any) => createHash('sha1').update(JSON.stringify(args.messages)).digest('hex');

async function memoLlm(args: any): Promise<any> {
  const key = llmKey(args);
  const hit = llmCache[key];
  if (hit !== undefined) { llmReplay++; return { choices: [{ message: { content: hit } }] }; }
  const res: any = await createChatCompletion(args);
  llmCache[key] = res.choices?.[0]?.message?.content ?? '';
  llmReal++;
  return res;
}

const saveLlmCache = () => writeFileSync(LLM_CACHE, JSON.stringify(llmCache));

// ─────────────────────────────────────────────────────────────────────────────
//  3. ชุดทดสอบ
// ─────────────────────────────────────────────────────────────────────────────
type Sp = { name: string; branch_code: string };
type Case = {
  id: string; source: string; customerQuery: string; contactQuery: string;
  salesperson: Sp; expected?: string;
};
const NO_SP: Sp = { name: 'EVAL', branch_code: '' };

/** ดูดคำค้นจริงจากแชท แล้วสกัดด้วย prompt เดียวกับ production */
async function mineCorpus(): Promise<Case[]> {
  const { rows } = await pool.query<{ content: string; user_id: string }>(
    `SELECT content, user_id FROM (
       SELECT DISTINCT ON (content) content, user_id, created_at
         FROM messages
        WHERE created_at > now() - ($1 || ' days')::interval
          AND type = 'text' AND content IS NOT NULL
          AND length(content) BETWEEN 12 AND 1200
          AND (content ILIKE '%เสนอราคา%' OR content ~ '\\n')
        ORDER BY content, created_at DESC
     ) t ORDER BY created_at DESC LIMIT $2`, [DAYS, N]);
  console.log(D + `ดูดข้อความจริง ${rows.length} ข้อความ (${DAYS} วันล่าสุด) — สกัดด้วย LLM...` + X);

  // เก็บชื่อ/สาขาของพนักงานขาย ไม่เก็บ LINE user id ลงไฟล์ (เป็นตัวระบุตัวบุคคล)
  const spCache = new Map<string, Sp>();
  const resolveSp = async (uid: string): Promise<Sp> => {
    if (!uid) return NO_SP;
    if (!spCache.has(uid)) {
      const sp: any = await getSalespersonByUserId(uid);
      spCache.set(uid, sp ? { name: sp.name, branch_code: sp.branch_code || '' } : NO_SP);
    }
    return spCache.get(uid)!;
  };

  const mined: Case[] = [];
  const queue = rows.map((r, i) => ({ ...r, i }));
  let done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      try {
        const res: any = await createChatCompletion({
          messages: [{ role: 'user', content: buildExtractionPrompt(job.content) }],
        });
        const j = parseAiJson(res.choices[0].message.content || '');
        const cq = String(j?.quotation_data?.customer_query || '').trim();
        const ct = String(j?.quotation_data?.contact_query || '').trim();
        if (cq && cq !== 'null') {
          mined.push({
            id: 'corpus-' + job.i, source: 'corpus', customerQuery: cq,
            contactQuery: ct === 'null' ? '' : ct,
            salesperson: await resolveSp(job.user_id),
          });
        }
      } catch { /* ข้อความที่สกัดไม่ได้ = ไม่ใช่คำขอใบเสนอราคา ข้ามไป */ }
      if (++done % 25 === 0) console.log(D + `  สกัดแล้ว ${done}/${rows.length}` + X);
    }
  }));
  mined.sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
  mkdirSync(dirname(CORPUS), { recursive: true });
  writeFileSync(CORPUS, JSON.stringify(mined, null, 1));
  console.log(D + `สกัดได้ ${mined.length} เคสที่มีชื่อลูกค้า → เก็บไว้ที่ ${CORPUS}` + X);
  return mined;
}

async function buildCases(): Promise<Case[]> {
  const cases: Case[] = [];

  if (existsSync(GRADED)) {
    const graded = JSON.parse(readFileSync(GRADED, 'utf8'));
    for (const g of graded) {
      cases.push({
        id: g.id, source: 'graded:' + g.source, customerQuery: g.customerQuery,
        contactQuery: g.contactQuery || '', salesperson: NO_SP, expected: g.expected,
      });
    }
    console.log(D + `เคสที่มีเฉลย (รวมเคสที่เคยพบปัญหา): ${graded.length}` + X);
  } else {
    console.log(Y + `ไม่พบ ${GRADED} — ข้ามเคสที่มีเฉลย` + X);
  }

  const mined = (!REFRESH_CORPUS && existsSync(CORPUS))
    ? JSON.parse(readFileSync(CORPUS, 'utf8')) as Case[]
    : await mineCorpus();
  if (!REFRESH_CORPUS && existsSync(CORPUS)) {
    console.log(D + `คำค้นจริงที่สกัดไว้แล้ว: ${mined.length} เคส ${D}(--refresh-corpus เพื่อดูดชุดใหม่)` + X);
  }

  // คำค้นซ้ำไม่ให้ข้อมูลเพิ่ม แต่ทำให้ตัวเลขเวลาเอียง
  const uniq = new Map<string, Case>();
  for (const c of [...cases, ...mined]) {
    const k = c.customerQuery + ' ' + c.contactQuery;
    if (!uniq.has(k)) uniq.set(k, c);
  }
  const list = [...uniq.values()];

  // id ซ้ำ = ตอนเทียบเฉลย/baseline จะไปหยิบผลของอีกเคสมาเทียบ แล้วรายงานว่าพัง
  // ทั้งที่ของจริงไม่ได้พัง (เคยเกิดจริง: ไฟล์เฉลยมี id "mined-29" อยู่ก่อนแล้ว
  // ชนกับคำค้นที่ดูดมาใหม่ซึ่งตั้งชื่อชุดเดียวกัน ความถูกต้องร่วงจาก 94% เหลือ 74% หลอก ๆ)
  const dup = [...new Set(list.map(c => c.id).filter((id, i, a) => a.indexOf(id) !== i))];
  if (dup.length) {
    throw new Error('id ซ้ำในชุดทดสอบ: ' + dup.slice(0, 10).join(', ') +
      '\n→ ต้องแก้ให้ไม่ซ้ำก่อน ไม่งั้นผลเทียบเชื่อไม่ได้');
  }
  return list;
}

// ─────────────────────────────────────────────────────────────────────────────
//  4. รันชุดทดสอบ
// ─────────────────────────────────────────────────────────────────────────────
type Row = { id: string; top1: string; fp: string; n: number; ms: number };

async function runAll(cases: Case[], find: any): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const t0 = Date.now();
    let rs: any[] = [];
    try { rs = await find(c.customerQuery, c.salesperson, c.contactQuery); } catch { rs = []; }
    out.push({
      id: c.id,
      top1: rs[0]?.item?.display_name || '',
      // ลายนิ้วมือ = ทุกตัวเลือกพร้อมคะแนน ตามลำดับที่ส่งกลับ — ละเอียดกว่าดูแค่อันดับ 1
      fp: rs.map(r => r.item?.id + ':' + Number(r.score).toFixed(9)).join('|'),
      n: rs.length,
      ms: Date.now() - t0,
    });
    if ((i + 1) % 50 === 0) {
      console.log(D + `  ${i + 1}/${cases.length}` + X);
      saveLlmCache();   // กันงานหายถ้ารันค้างกลางทาง
    }
  }
  return out;
}

function reportGraded(cases: Case[], rows: Row[]) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const graded = cases.filter(c => c.expected);
  let ok = 0;
  const wrong: string[] = [];
  for (const c of graded) {
    const got = byId.get(c.id)?.top1 || '';
    if (sameName(got, c.expected!)) ok++;
    else if (wrong.length < 8) wrong.push(`  ${D}[${c.id}] "${c.customerQuery.replace(/\n/g, ' ').slice(0, 46)}"${X}\n` +
      `      ควรได้ : ${c.expected}\n      ได้จริง : ${got || '(ไม่เจอ)'}`);
  }
  console.log(`   ${graded.length ? (ok === graded.length ? G : Y) : D}${ok}/${graded.length}` +
    (graded.length ? ` = ${(ok / graded.length * 100).toFixed(1)}%` : '') + X);
  if (wrong.length) { console.log(Y + '   เคสที่ยังผิด:' + X); wrong.forEach(w => console.log(w)); }
  return { ok, total: graded.length };
}

// ─────────────────────────────────────────────────────────────────────────────
//  5. ตรวจ cache ค้นหาลูกค้า (พฤติกรรม refresh-ahead)
// ─────────────────────────────────────────────────────────────────────────────
async function checkCache(m: any): Promise<boolean> {
  console.log('\n' + B + '==== cache ค้นหาลูกค้า ====' + X);
  const rowsHash = (rows: any[]) => createHash('sha1')
    .update(rows.map((r: any) => r.id + '' + r.display_name + '' + r.norm_name).join(''))
    .digest('hex').slice(0, 16);
  const settle = async () => {
    for (let i = 0; i < 60 && m.__cacheState().loading; i++) await new Promise(r => setTimeout(r, 200));
  };
  const line = (label: string, pass: boolean, detail: string) => {
    console.log(`   ${pass ? G + 'ผ่าน' : R + 'ไม่ผ่าน'}${X}  ${label.padEnd(38)} ${D}${detail}${X}`);
    return pass;
  };

  m.clearCustomerSearchCache();
  let t = Date.now(); await m.__loadCache(); const cold = Date.now() - t;
  t = Date.now(); await m.__loadCache(); const warm = Date.now() - t;

  m.__expireCustomerCache();                       // อายุ 11 นาที > TTL 10 นาที
  t = Date.now(); const stale = await m.__loadCache(); const expired = Date.now() - t;
  const during = m.__cacheState();
  const staleHash = rowsHash(stale);
  await settle();
  const after = m.__cacheState();
  const freshHash = rowsHash(await m.__loadCache());

  // ── sync เสร็จแล้วสั่งโหลดใหม่ (แทนล้างทิ้ง) — คนที่ค้นหาระหว่างนั้นต้องไม่ถูกบล็อก ──
  const reloading = m.reloadCustomerSearchCache();   // = สิ่งที่ syncService ทำหลัง rebuild เสร็จ
  t = Date.now(); const servedDuringReload = await m.__loadCache(); const duringReload = Date.now() - t;
  await reloading; await settle();
  const afterReload = m.__cacheState();

  // ── โหลดที่ค้างอยู่จาก snapshot ก่อน rebuild ต้องไม่ทับข้อมูลใหม่ ──
  // จำลอง: TTL หมด → มีคนค้นหา → เริ่มโหลดเบื้องหลัง → sync ล้าง cache กลางคัน
  // ถ้าไม่มีตัวนับรุ่น ผลของโหลดที่ค้างจะไปนั่งใน cache ต่อ = เสิร์ฟข้อมูลก่อน rebuild ยาวจน TTL หมด
  m.__expireCustomerCache();
  await m.__loadCache();
  m.clearCustomerSearchCache();
  await new Promise(r => setTimeout(r, 2500));
  const staleWon = m.__cacheState().has;

  // ── ทางถอยเมื่อโหลดใหม่หลัง sync ไม่สำเร็จ: clear ต้องยังบังคับโหลดใหม่แบบบล็อก ──
  m.clearCustomerSearchCache();
  t = Date.now(); await m.__loadCache(); const afterClear = Date.now() - t;

  m.__expireCustomerCache(2 * 60 * 60 * 1000);     // เก่า 2 ชม. > เพดาน 1 ชม.
  t = Date.now(); await m.__loadCache(); const tooStale = Date.now() - t;

  const r = [
    line('โหลดครั้งแรก (cache ว่าง) ต้องรอ', cold > 200, `${cold} ms`),
    line('cache ยังสด ต้องไม่เสียเวลา', warm < 50, `${warm} ms`),
    line('TTL หมด ต้องคืนของเดิมทันที', expired < 50, `${expired} ms · ประหยัดได้ ~${cold} ms`),
    line('TTL หมด ต้องเริ่มโหลดเบื้องหลัง', during.loading === true && !after.loading && after.ageMs < 30000,
      `กำลังโหลด=${during.loading} → เสร็จแล้วอายุ ${Math.round(after.ageMs / 1000)}s แถว ${after.rows}`),
    line('ของที่คืนตอนค้าง ต้องตรงกับของใหม่', staleHash === freshHash, `${staleHash} · ${freshHash}`),
    line('sync โหลดใหม่ ต้องไม่บล็อกคนค้นหา', duringReload < 50, `${duringReload} ms · ประหยัดได้ ~${cold} ms`),
    line('ระหว่าง sync โหลดใหม่ ต้องมีของให้ใช้', servedDuringReload.length > 0, `${servedDuringReload.length} แถว`),
    line('โหลดเสร็จแล้ว cache ต้องเป็นชุดใหม่', afterReload.rows > 0 && afterReload.ageMs < 30000,
      `${afterReload.rows} แถว อายุ ${Math.round(afterReload.ageMs / 1000)}s`),
    line('โหลดที่ตกรุ่น ต้องไม่ทับของใหม่', !staleWon, staleWon ? 'ทับแล้ว' : 'cache ว่างตามที่ควร'),
    line('ทางถอย clear ต้องบล็อกโหลดใหม่', afterClear > 200, `${afterClear} ms`),
    line('เก่าเกินเพดาน 1 ชม. ต้องไม่ถูกคืน', tooStale > 200, `${tooStale} ms`),
  ];
  const pass = r.every(Boolean);
  if (!r[4]) console.log(Y + '   (ถ้ามี sync เข้ากลางการทดสอบ ข้อ "ของที่คืนตอนค้าง" ต่างได้เป็นปกติ)' + X);
  return pass;
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(B + 'ชุดตรวจการค้นหาลูกค้า' + X + '  ' + D +
    (SAVE ? 'โหมดบันทึก baseline' : 'โหมดเทียบกับ baseline') + X);

  generateEvalModule();
  const m: any = await import(pathToFileURL(GEN).href);
  m.__setEvalLlm(memoLlm);
  console.log(D + 'สร้างสำเนาทดสอบจาก services/customerService.ts ปัจจุบันแล้ว' + X);

  const cases = await buildCases();
  console.log(B + `ชุดทดสอบรวม ${cases.length} เคส` + X + ' ' + D +
    `(มีเฉลย ${cases.filter(c => c.expected).length} · คำค้นจริง ${cases.filter(c => !c.expected).length})` + X + '\n');

  const rows = await runAll(cases, m.findCustomerCandidates);
  saveLlmCache();
  console.log(D + `LLM: ยิงจริง ${llmReal} ครั้ง · เล่นซ้ำจากที่จำไว้ ${llmReplay} ครั้ง` + X);

  const ms = rows.map(r => r.ms);
  let pass = true;

  console.log('\n' + B + '1) ความถูกต้องเทียบเฉลย' + X);
  const graded = reportGraded(cases, rows);

  console.log('\n' + B + '2) เทียบกับ baseline' + X);
  if (SAVE) {
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify({
      savedAt: new Date().toISOString(),
      graded, p50: pct(ms, .5), p95: pct(ms, .95),
      rows: rows.map(r => ({ id: r.id, top1: r.top1, fp: r.fp, n: r.n })),
    }, null, 1));
    console.log(`   ${G}บันทึกแล้ว${X} ${D}${BASELINE} (${rows.length} เคส)${X}`);
  } else if (!existsSync(BASELINE)) {
    console.log(`   ${Y}ยังไม่มี baseline — รันด้วย --save ก่อนหนึ่งครั้งตอนที่ของยังดีอยู่${X}`);
  } else {
    const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const bm = new Map<string, any>(base.rows.map((r: any) => [r.id, r]));
    let missing = 0, fpDiff = 0, top1Diff = 0;
    const ex: string[] = [];
    for (const r of rows) {
      const b = bm.get(r.id);
      if (!b) { missing++; continue; }
      if (b.fp !== r.fp) fpDiff++;
      if (!sameName(b.top1, r.top1)) {
        top1Diff++;
        const c = cases.find(x => x.id === r.id)!;
        if (ex.length < 10) ex.push(`  ${D}[${r.id}] "${c.customerQuery.replace(/\n/g, ' ').slice(0, 46)}"${X}\n` +
          `      baseline : ${b.top1 || '(ไม่เจอ)'}\n      ตอนนี้   : ${r.top1 || '(ไม่เจอ)'}`);
      }
    }
    console.log(`   ${D}baseline บันทึกเมื่อ ${base.savedAt}${X}`);
    console.log(`   ${D}ลำดับ/คะแนนขยับ                ${fpDiff}/${rows.length}${X}`);
    console.log(`   ${top1Diff === 0 ? G : R}อันดับ 1 เปลี่ยน (ร้ายแรงสุด)   ${top1Diff}/${rows.length}${X}`);
    if (missing) console.log(`   ${Y}ไม่มีใน baseline ${missing} เคส (ชุดข้อมูลเปลี่ยน)${X}`);
    if (ex.length) { console.log(Y + '   เคสที่อันดับ 1 เปลี่ยน:' + X); ex.forEach(e => console.log(e)); }
    if (base.graded && graded.total && graded.ok < base.graded.ok) {
      console.log(`   ${R}ความถูกต้องลดลง: baseline ${base.graded.ok} → ตอนนี้ ${graded.ok}${X}`);
      pass = false;
    }
    if (top1Diff > 0) pass = false;
    console.log(`   ${D}เวลา baseline p50 ${base.p50} ms p95 ${base.p95} ms${X}`);
  }

  console.log(`   ${D}เวลาตอนนี้   p50 ${pct(ms, .5)} ms p95 ${pct(ms, .95)} ms${X}`);

  if (!await checkCache(m)) pass = false;

  console.log('\n' + B + '==== สรุป ====' + X);
  console.log('   ' + (pass ? G + 'ผ่าน — การค้นหาลูกค้ายังทำงานเหมือนเดิม'
    : R + 'ไม่ผ่าน — ดูรายละเอียดข้างบน (ถ้าเปลี่ยนโดยตั้งใจ ให้รันด้วย --save เพื่อรับ baseline ใหม่)') + X);
  if (!pass) process.exitCode = 1;
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (existsSync(GEN)) unlinkSync(GEN);   // สำเนาทดสอบเป็นของชั่วคราว ไม่ทิ้งไว้ในซอร์ส
    await pool.end();
  });
