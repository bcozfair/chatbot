// ─────────────────────────────────────────────────────────────────────────────
//  เฟส 1ข — ทางเลือก (ก): ตัด Pre-Search AI call แล้วใช้ regex ที่มีอยู่แล้วแทน
//
//  ข้อสังเกตที่นำมาสู่การทดสอบนี้: โค้ดปัจจุบันเอาผลลัพธ์ของ AI ไปผ่าน
//  cleanCompanyName() ซ้ำอยู่แล้ว (customerService.ts:823) และ cleanCompanyName
//  ก็ลบ บริษัท/จำกัด/มหาชน/หจก./บจก./สำนักงานใหญ่/สาขา/บ. + วงเล็บ ออกอยู่แล้ว
//  ซึ่งตรงกับกติกาใน prompt ของ Pre-Search แทบทุกข้อ → AI อาจทำงานซ้ำซ้อน
//
//  วัดสิ่งที่ชี้ขาดจริง: ไม่ใช่ "สตริงตรงกันไหม" แต่ "หลัง normalize แล้วยัง
//  ค้นเจอตัวเดียวกันไหม" เพราะ search จับคู่ด้วย normalizeCompanyNameTS()
//
//  รัน:  EVAL_N=80 npx tsx scripts/diag/coreNameRegexEval.ts
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pool } from '../../config/db.js';
import { createChatCompletion } from '../../config/clients.js';
import { buildExtractionPrompt, parseAiJson } from './extractionCore.js';
import { cleanCompanyName, normalizeCompanyNameTS } from '../../services/customerService.js';

const N = Number(process.env.EVAL_N || 80);
const DAYS = Number(process.env.EVAL_DAYS || 7);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
// เก็บผล AI ไว้ ยิงครั้งเดียวพอ — จะได้ลองปรับ regex กี่รอบก็ได้โดยไม่เสียเงินเพิ่ม
const CACHE = process.env.EVAL_CACHE || '/tmp/coreNameRegexEval.cache.json';
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

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

// ─── ตัวที่เสนอ: cleanCompanyName + ลบสิ่งที่ AI ทำอยู่แต่ regex เดิมไม่ได้ทำ ───
// จากข้อมูลจริง 32 เคสที่ regex เดิมพลาด แทบทั้งหมดคือ 2 อย่างนี้:
//   1. รหัสอ้างอิงลูกค้า  A010674 / A005841(3) / A/33681
//   2. ข้อความเลขผู้เสียภาษีที่เซลส์ copy ติดมาจากระบบ Odoo
const RE_REF  = /\bA\s*\/?\s*\d{4,7}\s*(?:\(\s*\d+\s*\))?/gi;
const RE_TAX  = /เลข(?:ประจำ|ประจํา)ตัวผู้?เสียภาษี(?:อากร)?\s*:?\s*\d*/g;
const RE_SHOP = /ร้าน/g;
// "สาขา 00001" — cleanCompanyName ลบคำว่า "สาขา" แต่ทิ้งเลขไว้ ต้องลบเลขไปด้วย
const RE_BRANCH = /สาขา(?:ที่)?\s*\d+/g;

// เซลส์ copy ชื่อมาจาก Odoo บางครั้งได้ "ํา" (U+0E4D+U+0E32) แทน "ำ" (U+0E33)
// ตาเปล่าเหมือนกันเป๊ะ แต่ regex ของ cleanCompanyName จับ "จำกัด" ไม่ติด → คำต่อท้ายค้าง
const foldSaraAm = (s: string) => s.normalize('NFC').replace(/\u0E4D\u0E32/g, '\u0E33');

export function extractCoreNameRegex(customerQuery: string): string {
  const firstLine = foldSaraAm(String(customerQuery || '').split('\n')[0]);
  const noTax = firstLine.replace(RE_TAX, ' ').replace(RE_BRANCH, ' ');
  // trim ก่อนส่งเข้า cleanCompanyName เพราะกฎ ^บ\. ของมันผูกกับต้นสตริง
  // ถ้ามีช่องว่างค้างจากการลบรหัสออก จะจับ "บ." ไม่ติด
  const stripped = cleanCompanyName(noTax.replace(RE_REF, ' ').replace(RE_SHOP, ' ').trim());
  if (stripped.trim()) return stripped;
  // ตัดรหัสแล้วไม่เหลืออะไร = เซลส์พิมพ์มาแต่รหัส → คืนรหัสตัวหลัก ตัด (n) ท้ายทิ้ง (AI ก็ทำแบบนี้)
  return cleanCompanyName(noTax.replace(/\(\s*\d+\s*\)/g, ' ').trim());
}

async function pool_<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array(items.length) as R[];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const c = i++; out[c] = await fn(items[c], c); }
  }));
  return out;
}

async function main() {
  const { rows } = await pool.query<{ content: string }>(
    `SELECT DISTINCT ON (content) content
       FROM messages
      WHERE created_at > now() - ($1 || ' days')::interval
        AND type = 'text' AND content IS NOT NULL AND length(content) BETWEEN 12 AND 1200
        AND (content ILIKE '%เสนอราคา%' OR content ~ '\\n')
      ORDER BY content, created_at DESC LIMIT $2`, [DAYS, N]);
  const corpus = rows.map(r => r.content);
  console.log(`${B}เฟส 1ข — ทางเลือก (ก): regex แทน Pre-Search AI${X}`);
  console.log(`ข้อความจริง ${corpus.length} · 3 LLM call/ข้อความ = ${corpus.length * 3} calls\n`);

  let cache: Record<string, { cq: string; ai1: string; ai2: string }> = {};
  if (existsSync(CACHE)) {
    cache = JSON.parse(readFileSync(CACHE, 'utf8'));
    console.log(`${D}ใช้ cache ${Object.keys(cache).length} รายการจาก ${CACHE} (ไม่ยิง LLM ซ้ำ)${X}\n`);
  }
  let done = 0;
  const res = await pool_(corpus, CONCURRENCY, async (content, i) => {
    if (cache[content]) { done++; return cache[content]! as any; }
    try {
      const e: any = await createChatCompletion({
        messages: [{ role: 'user', content: buildExtractionPrompt(content) }],
        response_format: { type: 'json_object' }, max_tokens: 8192,
      });
      const j = parseAiJson(e.choices[0]?.message?.content || '');
      const cq = j?.quotation_data?.customer_query;
      if (!cq || !String(cq).trim()) { done++; return null; }
      // ยิง Pre-Search 2 ครั้ง เพื่อรู้พื้นความไม่นิ่งของเป้า
      const [a, b] = await Promise.all([
        createChatCompletion({ messages: [{ role: 'user', content: buildPreSearchPrompt(String(cq)) }] }),
        createChatCompletion({ messages: [{ role: 'user', content: buildPreSearchPrompt(String(cq)) }] }),
      ]) as any[];
      done++; process.stdout.write(`\r${D}  ${done}/${corpus.length}${X}   `);
      const rec = {
        i, cq: String(cq),
        ai1: (a.choices[0]?.message?.content || '').trim(),
        ai2: (b.choices[0]?.message?.content || '').trim(),
      };
      cache[content] = rec;
      return rec;
    } catch { done++; return null; }
  });
  console.log('\n');

  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));
  const ok = res.filter(Boolean) as { i: number; cq: string; ai1: string; ai2: string }[];
  // regex ล้วน: เลียนแบบสิ่งที่โค้ดทำกับผล AI เป๊ะ — บรรทัดแรก แล้วผ่าน cleanCompanyName
  const regexOld = (cq: string) => cleanCompanyName(cq.split('\n')[0]);
  const regexOf = extractCoreNameRegex;
  const norm = (s: string) => normalizeCompanyNameTS(s);

  const aiNoise = ok.filter(r => cleanCompanyName(r.ai1) !== cleanCompanyName(r.ai2));
  const strEq = ok.filter(r => regexOf(r.cq) === cleanCompanyName(r.ai1) || regexOf(r.cq) === cleanCompanyName(r.ai2));
  const normEqOld = ok.filter(r => norm(regexOld(r.cq)) === norm(cleanCompanyName(r.ai1)) || norm(regexOld(r.cq)) === norm(cleanCompanyName(r.ai2)));
  const normEq = ok.filter(r => norm(regexOf(r.cq)) === norm(cleanCompanyName(r.ai1)) || norm(regexOf(r.cq)) === norm(cleanCompanyName(r.ai2)));
  const empty = ok.filter(r => !regexOf(r.cq).trim());

  console.log(`${B}เทียบ regex ล้วน กับ Pre-Search AI (${ok.length} เคสที่มีชื่อลูกค้า)${X}`);
  console.log(`   ${D}พื้นความไม่นิ่งของ AI เอง          ${aiNoise.length}/${ok.length} = ${(100 * aiNoise.length / ok.length).toFixed(1)}%${X}`);
  console.log(`   ${D}cleanCompanyName เดิมล้วน ๆ        ${normEqOld.length}/${ok.length} = ${(100 * normEqOld.length / ok.length).toFixed(1)}%${X}`);
  console.log(`   สตริงตรงกันเป๊ะ                  ${strEq.length}/${ok.length} = ${(100 * strEq.length / ok.length).toFixed(1)}%`);
  console.log(`   ★ ${B}หลัง normalize แล้วตรงกัน${X}        ${normEq.length === ok.length ? G : Y}${normEq.length}/${ok.length} = ${(100 * normEq.length / ok.length).toFixed(1)}%${X}  ${D}← ตัวชี้ขาด (search ใช้ค่านี้จับคู่)${X}`);
  console.log(`   ${D}regex ได้ค่าว่าง (เสียคำค้น)        ${empty.length}${X}`);

  const diff = ok.filter(r => !normEq.includes(r));
  if (diff.length) {
    console.log(`\n${Y}เคสที่ต่างกันหลัง normalize (${diff.length} เคส):${X}`);
    for (const r of diff.slice(0, 12))
      console.log(`  ${D}cq="${r.cq.replace(/\n/g, ' ⏎ ').slice(0, 62)}"${X}\n      AI   : "${r.ai1}"\n      regex: "${regexOf(r.cq)}"`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
