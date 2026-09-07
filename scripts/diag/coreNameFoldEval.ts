// ─────────────────────────────────────────────────────────────────────────────
//  เฟส 1 ของงาน "ยุบ Pre-Search AI call เข้าไปใน extraction" (แผน ข)
//
//  คำถามที่ต้องตอบก่อนแตะ production:
//    1. เติม field "customer_core_name" ลงใน schema ของ extraction แล้ว
//       field เดิม "พัง" หรือไม่  ← ข้อนี้สำคัญที่สุด
//    2. ชื่อแกนกลางที่ได้ เทียบเท่ากับที่ Pre-Search call เดิมให้หรือไม่
//    3. ประหยัดเวลาได้จริงเท่าไหร่
//
//  วิธีวัดที่ยุติธรรม: LLM ไม่ deterministic 100% แม้ temperature=0 ดังนั้น
//  ต้องรู้ "พื้นความไม่นิ่งของตัวมันเอง" ก่อน จึงยิง prompt เดิมซ้ำ 2 ครั้ง
//  (old-A / old-B) เพื่อวัดว่าตัวเดิมเทียบกับตัวเดิมยังต่างกันกี่ % — ถ้า
//  ตัวใหม่ต่างไม่เกินพื้นนี้ แปลว่าความต่างมาจาก noise ไม่ใช่จากการแก้ prompt
//
//  รัน:  EVAL_N=60 npx tsx scripts/diag/coreNameFoldEval.ts
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import { createChatCompletion } from '../../config/clients.js';
import { buildExtractionPrompt, parseAiJson } from './extractionCore.js';
import { cleanCompanyName } from '../../services/customerService.js';

const N = Number(process.env.EVAL_N || 60);
const DAYS = Number(process.env.EVAL_DAYS || 7);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

// ── prompt ใหม่ = prompt เดิม + field เดียว + กฎเดียว (คัดลอกกติกามาจาก Pre-Search เป๊ะ) ──
// วางไว้ "นอก" quotation_data ตั้งใจ — รอบแรกวางไว้ข้างใน customer_query แล้วโมเดล
// ไปจัดเรียง customer_query ใหม่ให้เข้ากับกฎ (รหัสลูกค้าย้ายมาขึ้นหน้า) = ของเดิมพัง 10%
const CORE_FIELD = `          "customer_core_name": "ชื่อเรียกหลักแกนกลางของลูกค้า (ดูกฎข้อ 16) หรือ null",`;
const CORE_RULE = `        16. การสกัด "customer_core_name" (field ใหม่ อยู่ระดับบนสุด ไม่ได้อยู่ใน quotation_data):
           *** ข้อบังคับสูงสุด: การสกัด field นี้ ห้ามทำให้ค่าของ field อื่นเปลี่ยนไปจากเดิมแม้แต่ตัวอักษรเดียว
               โดยเฉพาะ "customer_query" ให้สกัดตามกฎเดิมทุกประการ ห้ามจัดเรียงคำใหม่ ห้ามสลับตำแหน่งรหัสลูกค้า
               ให้คิดว่า field นี้เป็นงานแยกที่ทำ "หลังจาก" สกัด quotation_data เสร็จแล้ว ***
           - ตั้งต้นจากค่า customer_query ที่สกัดได้ แล้วสกัดเฉพาะชื่อเรียกหลักแกนกลาง (Core Name/Brand Name)
           - ลบคำนำหน้า/คำย่อ เช่น บ., บจก., หจก., บริษัท, ร้าน, ห้างหุ้นส่วนจำกัด ออกทั้งหมด
           - ลบคำต่อท้าย เช่น จำกัด, (มหาชน), Co., Ltd., Ltd. ออกทั้งหมด
           - ลบวงเล็บ เช่น (สำนักงานใหญ่), (สาขา...) ออก
           - คงเหลือเฉพาะตัวสะกดชื่อหลัก เช่น "บ.เคยู พลัส" -> "เคยู พลัส", "บริษัท ย่งฮง (ประเทศไทย) จำกัด" -> "ย่งฮง", "KU group" -> "KU"
           - หาก customer_query มีแต่รหัสอ้างอิงลูกค้าโดยไม่มีชื่อบริษัท (เช่น "A003661(2)", "A/33681") ให้คืนค่ารหัสนั้นทั้งก้อนตามเดิม ห้ามคืน null
           - หาก customer_query เป็น null ให้ customer_core_name เป็น null ด้วย`;

function buildNewPrompt(content: string, historyContext = ''): string {
  const base = buildExtractionPrompt(content, historyContext);
  const anchor = `          "product_query": {`;
  if (!base.includes(anchor)) throw new Error('หา anchor product_query ไม่เจอ — prompt เปลี่ยนไปแล้ว');
  let out = base.replace(anchor, `${CORE_FIELD}\n${anchor}`);
  const ruleAnchor = `\n        *** กฎเหล็ก:`;
  if (!out.includes(ruleAnchor)) throw new Error('หา anchor กฎเหล็ก ไม่เจอ — prompt เปลี่ยนไปแล้ว');
  out = out.replace(ruleAnchor, `\n${CORE_RULE}\n${ruleAnchor}`);
  return out;
}

// ── Pre-Search prompt เดิม คัดลอกจาก services/customerService.ts:806-822 เป๊ะ ──
function buildPreSearchPrompt(customerQuery: string): string {
  return `วิเคราะห์ชื่อบริษัทที่ส่งมา และสกัดเฉพาะ "ชื่อเรียกหลักแกนกลาง" (Core Name/Brand Name) ออกมาเพื่อนำไปค้นหาต่อ
กติกา:
- ลบคำนำหน้า/คำย่อ เช่น บ., บจก., หจก., บริษัท, ร้าน, ห้างหุ้นส่วนจำกัด ออกทั้งหมด
- ลบคำต่อท้าย เช่น จำกัด, (มหาชน), Co., Ltd., Ltd. ออกทั้งหมด
- ลบวงเล็บ เช่น (สำนักงานใหญ่), (สาขา...) ออก
- คงเหลือเฉพาะตัวสะกดชื่อหลัก เช่น "บ.เคยู พลัส" -> "เคยู พลัส", "บริษัท ย่งฮง (ประเทศไทย) จำกัด" -> "ย่งฮง", "KU group" -> "KU"

ชื่อบริษัทที่ต้องการวิเคราะห์: "${customerQuery.split('\n')[0]}"

ตอบเฉพาะชื่อแกนกลางที่สกัดได้เท่านั้น ห้ามเขียนอธิบายใดๆ`;
}

async function callJson(prompt: string): Promise<{ json: any; ms: number }> {
  const t0 = Date.now();
  const r: any = await createChatCompletion({
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' }, max_tokens: 8192,
  });
  return { json: parseAiJson(r.choices[0]?.message?.content || ''), ms: Date.now() - t0 };
}
async function callText(prompt: string): Promise<{ text: string; ms: number }> {
  const t0 = Date.now();
  const r: any = await createChatCompletion({ messages: [{ role: 'user', content: prompt }] });
  return { text: (r.choices[0]?.message?.content || '').trim(), ms: Date.now() - t0 };
}

const stripCore = (j: any) => {
  const c = JSON.parse(JSON.stringify(j ?? null));
  if (c && typeof c === 'object') delete c.customer_core_name;
  if (c?.quotation_data) delete c.quotation_data.customer_core_name;
  return c;
};
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

async function pool_<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array(items.length) as R[];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const c = i++; out[c] = await fn(items[c], c); }
  }));
  return out;
}
const pct = (a: number[], p: number) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : 0;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

async function main() {
  const { rows } = await pool.query<{ content: string }>(
    `SELECT DISTINCT ON (content) content
       FROM messages
      WHERE created_at > now() - ($1 || ' days')::interval
        AND type = 'text' AND content IS NOT NULL AND length(content) BETWEEN 12 AND 1200
        AND (content ILIKE '%เสนอราคา%' OR content ~ '\\n')
      ORDER BY content, created_at DESC
      LIMIT $2`, [DAYS, N]);
  const corpus = rows.map(r => r.content);
  console.log(`${B}เฟส 1 — วัดผลก่อนแก้ production${X}`);
  console.log(`ข้อความจริงย้อนหลัง ${DAYS} วัน: ${corpus.length} ข้อความ · 5 LLM call/ข้อความ = ${corpus.length * 5} calls\n`);

  type Row = { i: number; oldA: any; oldB: any; nw: any; core_pre: string; core_pre2: string; msOldExt: number; msPre: number; msNew: number; err?: string };
  let done = 0;
  const res = await pool_(corpus, CONCURRENCY, async (content, i): Promise<Row> => {
    try {
      const [a, b, n] = await Promise.all([
        callJson(buildExtractionPrompt(content)),
        callJson(buildExtractionPrompt(content)),
        callJson(buildNewPrompt(content)),
      ]);
      const cq = a.json?.quotation_data?.customer_query;
      let pre = { text: '', ms: 0 }, pre2 = { text: '', ms: 0 };
      // ยิง Pre-Search 2 ครั้ง เพื่อรู้ว่า "เป้าที่เราเทียบด้วย" มันนิ่งแค่ไหน
      if (cq && String(cq).trim()) {
        [pre, pre2] = await Promise.all([
          callText(buildPreSearchPrompt(String(cq))),
          callText(buildPreSearchPrompt(String(cq))),
        ]);
      }
      done++; process.stdout.write(`\r${D}  ${done}/${corpus.length}${X}   `);
      return { i, oldA: a.json, oldB: b.json, nw: n.json, core_pre: pre.text, core_pre2: pre2.text, msOldExt: a.ms, msPre: pre.ms, msNew: n.ms };
    } catch (e: any) {
      done++;
      return { i, oldA: null, oldB: null, nw: null, core_pre: '', core_pre2: '', msOldExt: 0, msPre: 0, msNew: 0, err: e?.message || String(e) };
    }
  });
  console.log('\n');

  const ok = res.filter(r => !r.err);
  const errs = res.filter(r => r.err);

  // พื้นความไม่นิ่งของ prompt เดิม (old-A vs old-B)
  const noise = ok.filter(r => !same(r.oldA, r.oldB));
  // ตัวใหม่ vs ตัวเดิม (ตัด field ใหม่ออกก่อน)
  const drift = ok.filter(r => !same(stripCore(r.nw), r.oldA));
  // ตัวใหม่ต่างจากทั้ง A และ B = ต่างจริง ไม่ใช่ noise
  const driftReal = ok.filter(r => !same(stripCore(r.nw), r.oldA) && !same(stripCore(r.nw), r.oldB));
  // intent เปลี่ยน = ร้ายแรงที่สุด
  const intentChanged = ok.filter(r => r.nw?.intent !== r.oldA?.intent && r.oldA?.intent === r.oldB?.intent);

  const withCq = ok.filter(r => r.core_pre);
  const cc = (v: any) => cleanCompanyName(v == null ? '' : String(v));
  // พื้น noise ของ Pre-Search เอง: ยิง prompt เดิมซ้ำ 2 ครั้งแล้วยังได้คนละคำตอบกี่ %
  const preNoise = withCq.filter(r => cc(r.core_pre) !== cc(r.core_pre2));
  // ตัวใหม่ "ตรง" = ตรงกับคำตอบใดคำตอบหนึ่งของ Pre-Search (เพราะเป้ามันสั่นเอง)
  const coreMatch = withCq.filter(r => cc(r.nw?.customer_core_name) === cc(r.core_pre) || cc(r.nw?.customer_core_name) === cc(r.core_pre2));

  console.log(`${B}1) ของเดิมพังไหม — เทียบ JSON ทุก field ยกเว้น field ใหม่${X}`);
  console.log(`   ข้อความที่วัดได้                 ${ok.length}${errs.length ? `  (${R}error ${errs.length}${X})` : ''}`);
  console.log(`   ${D}พื้นความไม่นิ่งของ prompt เดิมเอง (A≠B)   ${noise.length}/${ok.length} = ${(100 * noise.length / ok.length).toFixed(1)}%${X}`);
  console.log(`   prompt ใหม่ ≠ prompt เดิม(A)         ${drift.length}/${ok.length} = ${(100 * drift.length / ok.length).toFixed(1)}%`);
  const badCol = driftReal.length <= noise.length ? G : R;
  console.log(`   ★ ต่างจริง (≠ ทั้ง A และ B)          ${badCol}${driftReal.length}/${ok.length} = ${(100 * driftReal.length / ok.length).toFixed(1)}%${X}`);
  console.log(`   ★ intent เปลี่ยน (ร้ายแรงสุด)         ${intentChanged.length ? R : G}${intentChanged.length}${X}`);

  console.log(`\n${B}2) ชื่อแกนกลางเทียบเท่าของเดิมไหม (หลังผ่าน cleanCompanyName)${X}`);
  console.log(`   ข้อความที่มี customer_query        ${withCq.length}`);
  console.log(`   ${D}พื้นความไม่นิ่งของ Pre-Search เอง   ${preNoise.length}/${withCq.length} = ${withCq.length ? (100 * preNoise.length / withCq.length).toFixed(1) : '-'}%${X}`);
  console.log(`   ตรงกับ Pre-Search เดิม            ${coreMatch.length === withCq.length ? G : Y}${coreMatch.length}/${withCq.length} = ${withCq.length ? (100 * coreMatch.length / withCq.length).toFixed(1) : '-'}%${X}`);
  console.log(`   ${D}(นับว่าตรง ถ้าตรงกับคำตอบใดคำตอบหนึ่งของ Pre-Search — เพราะตัวมันเองยังตอบไม่เหมือนกัน)${X}`);

  const oldTotal = ok.map(r => r.msOldExt + r.msPre);
  const newTotal = ok.map(r => r.msNew);
  console.log(`\n${B}3) เวลาที่ประหยัดได้ (เฉพาะข้อความที่มีชื่อลูกค้า)${X}`);
  const w = ok.filter(r => r.msPre > 0);
  console.log(`   เดิม (extraction + Pre-Search)   p50 ${pct(w.map(r => r.msOldExt + r.msPre), 50)} ms   รวม ${(sum(w.map(r => r.msOldExt + r.msPre)) / 1000).toFixed(1)} s`);
  console.log(`   ใหม่ (extraction อย่างเดียว)      p50 ${pct(w.map(r => r.msNew), 50)} ms   รวม ${(sum(w.map(r => r.msNew)) / 1000).toFixed(1)} s`);
  console.log(`   ${D}Pre-Search call ที่ตัดทิ้งได้     p50 ${pct(w.map(r => r.msPre), 50)} ms · เฉลี่ย ${Math.round(sum(w.map(r => r.msPre)) / (w.length || 1))} ms${X}`);
  console.log(`   ${D}ทุกข้อความรวมกัน: เดิม ${(sum(oldTotal) / 1000).toFixed(1)}s → ใหม่ ${(sum(newTotal) / 1000).toFixed(1)}s${X}`);

  if (driftReal.length) {
    console.log(`\n${Y}ตัวอย่างที่ต่างจริง (สูงสุด 5):${X}`);
    for (const r of driftReal.slice(0, 5)) {
      console.log(`  ${D}[${r.i}] ${corpus[r.i].replace(/\n/g, ' ⏎ ').slice(0, 90)}${X}`);
      console.log(`      เดิม : ${JSON.stringify(r.oldA?.quotation_data ?? r.oldA?.intent).slice(0, 150)}`);
      console.log(`      ใหม่ : ${JSON.stringify(stripCore(r.nw)?.quotation_data ?? r.nw?.intent).slice(0, 150)}`);
    }
  }
  const coreDiff = withCq.filter(r => !coreMatch.includes(r));
  if (coreDiff.length) {
    console.log(`\n${Y}ชื่อแกนกลางที่ไม่ตรง (สูงสุด 8):${X}`);
    for (const r of coreDiff.slice(0, 8))
      console.log(`  ${D}cq=${String(r.oldA?.quotation_data?.customer_query).replace(/\n/g, ' ⏎ ').slice(0, 60)}${X}\n      Pre-Search เดิม: "${r.core_pre}" / "${r.core_pre2}"  →  ใหม่: "${r.nw?.customer_core_name}"`);
  }
  if (errs.length) { console.log(`\n${R}error:${X}`); errs.slice(0, 3).forEach(e => console.log(`  [${e.i}] ${e.err}`)); }

  const pass = driftReal.length <= noise.length && intentChanged.length === 0;
  console.log(`\n${pass ? `${G}✅ ผ่าน — ความต่างไม่เกินพื้น noise ของ prompt เดิม และ intent ไม่เปลี่ยน${X}` : `${R}❌ ไม่ผ่าน — ต้องแก้ prompt ก่อน${X}`}\n`);
  await pool.end();
  process.exitCode = pass ? 0 : 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
