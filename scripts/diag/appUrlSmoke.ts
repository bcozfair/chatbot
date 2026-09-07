// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของ 2 เรื่องที่เคยทำให้ "ลิงก์ที่ส่งให้ลูกค้าผิดโดยไม่มี error"
//
//   1) normalizeAppUrl        — ฐานโดเมนของลิงก์ PDF ต้องถูกหรือไม่ก็ล้มตั้งแต่ boot
//   2) parseQuotationNosFromText — แกะเลขที่ใบจากข้อความ รวมใบฉบับแก้ไข "-01"
//
//  ทั้งหมดเป็น pure logic ไม่แตะ DB ไม่ยิงเน็ต → รันบน production ได้ปลอดภัย
//  รัน:  npm run diag:app-url
//  ให้รันซ้ำทุกครั้งที่แตะ config/appUrl.ts หรือ utils/quotationLink.ts
// ─────────────────────────────────────────────────────────────────────────────
import { normalizeAppUrl, getAppUrl } from '../../config/appUrl.js';
import { parseQuotationNosFromText, buildPdfLink } from '../../utils/quotationLink.js';

let failures = 0;
const ok = (label: string, cond: boolean) => { if (!cond) failures++; console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`); };
const throws = (label: string, raw: any) => {
  let threw = false;
  try { normalizeAppUrl(raw); } catch { threw = true; }
  ok(label, threw);
};

console.log('── 1. normalizeAppUrl: ค่าที่ต้องปฏิเสธ (ต้องโยน Error ไม่ใช่ปล่อยผ่าน) ──');
throws('undefined → ล้ม', undefined);
throws('null → ล้ม', null);
throws("'' → ล้ม", '');
throws('เว้นวรรคล้วน → ล้ม', '   ');
throws('ไม่ใช่ URL → ล้ม', 'salechatbot.primus-iot.com');       // ลืมใส่ https://
throws('scheme แปลก → ล้ม', 'ftp://example.com');
throws('มี path ต่อท้าย → ล้ม', 'https://example.com/download-pdf');
throws('มี query → ล้ม', 'https://example.com/?x=1');
throws('http:// กับโดเมนจริง → ล้ม', 'http://salechatbot.primus-iot.com');
// ⭐ เคสที่เกิดขึ้นจริง 2026-08-20 — ค่าที่เดามาจาก Host header ของ curl ในเครื่อง
ok('ยังยอมรับ http://127.0.0.1:3011 (เครื่อง dev เท่านั้น)', normalizeAppUrl('http://127.0.0.1:3011') === 'http://127.0.0.1:3011');

console.log('\n── 2. normalizeAppUrl: ค่าที่ต้องรับ + ทำให้เป็นมาตรฐาน ──');
ok('โดเมนปกติ', normalizeAppUrl('https://salechatbot.primus-iot.com') === 'https://salechatbot.primus-iot.com');
ok('ตัด / ปิดท้ายทิ้ง (กัน //download-pdf)', normalizeAppUrl('https://a.com/') === 'https://a.com');
ok('ตัดช่องว่างหัวท้าย', normalizeAppUrl('  https://a.com  ') === 'https://a.com');
ok('เก็บพอร์ตที่ระบุไว้', normalizeAppUrl('https://a.com:8443') === 'https://a.com:8443');
ok('http://localhost ผ่านได้', normalizeAppUrl('http://localhost:3011') === 'http://localhost:3011');

console.log('\n── 3. ลิงก์ที่ประกอบออกมาต้องเปิดได้จริง (ไม่มี // ซ้อน ไม่มี path หาย) ──');
{
  const base = normalizeAppUrl('https://a.com/');
  const link = buildPdfLink(base, 'e0ab1f19-22a8-4ef2-8159-70db08738752', 'QP-260805514');
  ok('ไม่มี // ซ้อนกลางลิงก์', !link.slice('https://'.length).includes('//'));
  ok('เป็น absolute url ที่ LINE รับได้', /^https:\/\/[^/]+\/download-pdf\//.test(link));
  ok('มี openExternalBrowser=1', link.endsWith('?openExternalBrowser=1'));
}

console.log('\n── 4. parseQuotationNosFromText: ต้องจับได้ ──');
const eq = (a: string[] | null, b: string[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
ok('ใบปกติ', eq(parseQuotationNosFromText('QP-260805512'), ['QP-260805512']));
ok('พิมพ์ตัวเล็กก็ได้', eq(parseQuotationNosFromText('qp-260805512'), ['QP-260805512']));
ok('QT ก็ได้', eq(parseQuotationNosFromText('QT-260805176'), ['QT-260805176']));
ok('มีช่องว่างหน้าหลัง', eq(parseQuotationNosFromText('  QP-260805512  '), ['QP-260805512']));
ok('หลายใบคั่นเว้นวรรค', eq(parseQuotationNosFromText('QP-260805512 QP-260805513'), ['QP-260805512', 'QP-260805513']));
ok('หลายใบคั่นจุลภาค', eq(parseQuotationNosFromText('QP-260805512, QP-260805513'), ['QP-260805512', 'QP-260805513']));
// ⭐ เคสที่พังมาตลอดก่อน 2026-08-20 — ใบฉบับแก้ไข
ok('ใบฉบับแก้ไข -01 (เคสที่เคยพัง)', eq(parseQuotationNosFromText('QP-260805349-01'), ['QP-260805349-01']));
ok('ใบฉบับแก้ไข QT-...-01', eq(parseQuotationNosFromText('QT-260805054-01'), ['QT-260805054-01']));
ok('ปนใบปกติกับใบแก้ไข', eq(parseQuotationNosFromText('QP-260805512, QP-260805349-01'), ['QP-260805512', 'QP-260805349-01']));

console.log('\n── 5. parseQuotationNosFromText: ต้องไม่จับ (ปล่อยให้ flow อื่นทำงานต่อ) ──');
ok('ข้อความว่าง', parseQuotationNosFromText('') === null);
ok('null', parseQuotationNosFromText(null) === null);
ok('ข้อความธรรมดา', parseQuotationNosFromText('สวัสดีครับ') === null);
ok('คำสั่งแก้ไข → ต้องตกไปที่ agent แก้ไขใบ', parseQuotationNosFromText('แก้ไข QP-260805512 เพิ่มจำนวน 2') === null);
ok('มีข้อความห้อยท้าย', parseQuotationNosFromText('QP-260805512 ขอบคุณครับ') === null);
ok('รหัสสินค้าที่หน้าตาคล้าย', parseQuotationNosFromText('MID-R100') === null);
ok('เลขที่ไม่ครบรูปแบบ', parseQuotationNosFromText('QP-') === null);
ok('รูปแบบ -R ที่ไม่เคยมีจริง', parseQuotationNosFromText('QP-260805349-R01') === null);

console.log('\n── 6. ด่านกับตัวจับต้องไม่มีทางเพี้ยนจากกัน (กันเคส "ส่ง PDF ผิดใบ") ──');
{
  // ทุกข้อความที่ผ่านด่าน ผลที่จับได้ต้องประกอบกลับเป็นข้อความเดิมได้พอดี
  // ถ้าวันหน้ามีคนแก้สูตรจนสองอันไม่ตรงกัน ข้อนี้จะจับได้ทันที
  const inputs = [
    'QP-260805512', 'QP-260805349-01', 'QT-260805054-01',
    'QP-260805512 QP-260805513', 'QP-260805512, QP-260805349-01',
    ' qp-260805512 ,qt-260805176 ',
  ];
  let clean = true;
  for (const raw of inputs) {
    const got = parseQuotationNosFromText(raw);
    if (!got) { clean = false; console.log(`   ✗ "${raw}" ควรผ่านด่านแต่ไม่ผ่าน`); continue; }
    const rebuilt = raw.trim().toUpperCase().replace(/[\s,]+/g, ' ');
    if (got.join(' ') !== rebuilt) { clean = false; console.log(`   ✗ "${raw}" → จับได้ ${got.join(' ')} ไม่ตรงกับข้อความเดิม`); }
  }
  ok('ทุกเคสที่ผ่านด่าน จับเลขที่ได้ครบไม่ตกหล่น', clean);
}

console.log('\n── 7. ค่า APP_URL ที่ตั้งอยู่จริงบนเครื่องนี้ ──');
try {
  const url = getAppUrl();
  console.log(`   APP_URL = ${url}`);
  ok('APP_URL ที่ตั้งไว้ใช้งานได้', url.startsWith('http'));
} catch (e: any) {
  failures++;
  console.log(`✗ FAIL  APP_URL ที่ตั้งไว้ใช้ไม่ได้ — เซิร์ฟเวอร์จะสตาร์ทไม่ขึ้น: ${e?.message ?? e}`);
}

console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ ไม่ผ่าน ${failures} ข้อ`);
process.exit(failures === 0 ? 0 : 1);
