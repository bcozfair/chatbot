// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของตัวจับเวลา LLM ต่อ 1 งานคิว (config/clients.ts — LlmTiming)
//  รัน:  npm run diag:llm-timing
//  ไม่แตะ DB · ไม่แตะ LINE · ไม่ยิง API จริง (สลับ openai.chat.completions.create เป็นตัวปลอม)
//  ⇒ ปลอดภัยบน production
//
//  คำถามที่สคริปต์นี้ตอบ:
//    (ก) ms ยังเป็น "ผลรวมทุก call" เหมือนเดิม — ของเก่าต้องไม่เปลี่ยนความหมาย
//    (ข) busyMs เป็น "เวลาจริงที่มี LLM ค้างอยู่" คือ union ของช่วงเวลา ไม่ใช่ผลรวม
//    (ค) own_ms = processed - busyMs ไม่ติดลบในเคสที่สูตรเดิม (processed - ms) ติดลบ
//        ← นี่คือบั๊กที่เจอจริงใน api_logs: 1 ใน 72 แถวได้ own_ms = -1,996ms
//    (ง) call ที่พังยังถูกนับเวลา และ store ไม่รั่วข้ามงาน (คิวรันพร้อมกัน 12 งาน)
// ─────────────────────────────────────────────────────────────────────────────
import { openai, newLlmTiming, withLlmTiming, createChatCompletion } from '../../config/clients.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** setTimeout ไม่เคยตรงเป๊ะ — ยอมให้คลาดได้เท่านี้ต่อ 1 ช่วงเวลา */
const near = (got: number, want: number, tol = 60) => Math.abs(got - want) <= tol;

// ตัวปลอม: หน่วงตาม __delayMs ที่ส่งมากับ params แล้วคืน usage เหมือนของจริง
// (params ถูก spread เข้า create ทั้งก้อน ฟิลด์นี้จึงเดินทางมาถึงที่นี่ได้)
(openai.chat.completions as any).create = async (p: any) => {
  await sleep(p.__delayMs ?? 0);
  if (p.__fail) throw new Error('จำลอง LLM ล้ม');
  return { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60 }, choices: [] };
};

const call = (delayMs: number, fail = false) =>
  createChatCompletion({ messages: [], __delayMs: delayMs, __fail: fail } as any);

async function scenario(label: string, fn: () => Promise<void>) {
  const t = newLlmTiming();
  const t0 = Date.now();
  await withLlmTiming(t, fn);
  return { t, processed: Date.now() - t0, label };
}

// ── (ก) ยิงเรียงกัน: ผลรวม = เวลาจริง ⇒ ms กับ busyMs ต้องเท่ากัน ────────────────
{
  const { t, processed } = await scenario('serial', async () => { await call(120); await call(120); });
  ok('เรียงกัน 2 call ×120ms: ms = ผลรวม ≈ 240', near(t.ms, 240), `ms=${t.ms}`);
  ok('เรียงกัน: busyMs ≈ ms (ไม่มีช่วงทับกัน)', near(t.busyMs, t.ms, 20), `busy=${t.busyMs}`);
  ok('เรียงกัน: calls = 2', t.calls === 2, `calls=${t.calls}`);
  ok('เรียงกัน: own = processed - busy ≥ 0', processed - t.busyMs >= 0, `own=${processed - t.busyMs}`);
}

// ── (ข) ยิงขนาน: ผลรวมโตเป็น 3 เท่า แต่เวลาจริงเท่าเดิม ← หัวใจของการแก้ครั้งนี้ ──
{
  const { t, processed } = await scenario('parallel', async () => {
    await Promise.all([call(200), call(200), call(200)]);
  });
  ok('ขนาน 3 call ×200ms: ms = ผลรวม ≈ 600', near(t.ms, 600), `ms=${t.ms}`);
  ok('ขนาน: busyMs = เวลาจริง ≈ 200 (ไม่ใช่ 600)', near(t.busyMs, 200), `busy=${t.busyMs}`);
  ok('ขนาน: busyMs ต้องไม่เกิน processed', t.busyMs <= processed, `busy=${t.busyMs} processed=${processed}`);
  // ★ ข้อที่พิสูจน์ว่าบั๊กหาย: สูตรเดิมติดลบ สูตรใหม่ไม่ติดลบ
  ok('ขนาน: สูตรเดิม (processed - ms) ติดลบจริง — ยืนยันว่าเคสนี้คือเคสที่พัง',
    processed - t.ms < 0, `เดิม=${processed - t.ms}ms`);
  ok('★ ขนาน: สูตรใหม่ (processed - busyMs) ไม่ติดลบ',
    processed - t.busyMs >= 0, `ใหม่=${processed - t.busyMs}ms`);
}

// ── (ค) ซ้อนกันแบบไม่เต็มช่วง: union ต้องยาวกว่าช่วงเดียว แต่สั้นกว่าผลรวม ─────────
{
  // A: 0→300 · B: เริ่มที่ 150 ยาวถึง 450 ⇒ union = 450 · ผลรวม = 600
  const { t, processed } = await scenario('overlap', async () => {
    const a = call(300);
    await sleep(150);
    const b = call(300);
    await Promise.all([a, b]);
  });
  ok('ซ้อนบางส่วน: ms = ผลรวม ≈ 600', near(t.ms, 600, 90), `ms=${t.ms}`);
  ok('ซ้อนบางส่วน: busyMs = union ≈ 450', near(t.busyMs, 450, 90), `busy=${t.busyMs}`);
  ok('ซ้อนบางส่วน: own ≥ 0', processed - t.busyMs >= 0, `own=${processed - t.busyMs}`);
}

// ── (ง) มีช่องว่างระหว่าง call: เวลาที่เราไม่ได้รอ LLM ต้องไม่ถูกนับเป็น busy ───────
{
  const { t, processed } = await scenario('gap', async () => {
    await call(100);
    await sleep(250);          // ← ช่วงนี้คืองานของเราเอง (DB / LINE API)
    await call(100);
  });
  ok('มีช่องว่าง: busyMs ≈ 200 (ไม่รวมช่วงที่ไม่ได้รอ LLM)', near(t.busyMs, 200), `busy=${t.busyMs}`);
  ok('มีช่องว่าง: own ≈ 250 = งานของเราเองจริง ๆ',
    near(processed - t.busyMs, 250, 90), `own=${processed - t.busyMs}`);
}

// ── call ที่พัง: ยังต้องนับเวลาและปิดช่วง busy ให้เรียบร้อย (ไม่งั้นค้างเปิดตลอด) ───
{
  const { t } = await scenario('error', async () => {
    await call(150, true).catch(() => {});
    await call(150);
  });
  ok('call ที่พัง: errors = 1 และ calls = 2', t.errors === 1 && t.calls === 2, `errors=${t.errors} calls=${t.calls}`);
  ok('call ที่พัง: ยังนับเวลาเข้า ms ≈ 300', near(t.ms, 300), `ms=${t.ms}`);
  ok('call ที่พัง: ช่วง busy ถูกปิด ⇒ busyMs ≈ 300 ไม่บวมเกิน', near(t.busyMs, 300), `busy=${t.busyMs}`);
  ok('call ที่พัง: ไม่มี call ค้างเปิด (inFlight = 0)', t.inFlight === 0, `inFlight=${t.inFlight}`);
}

// ── ไม่เรียก LLM เลย: ทุกอย่างต้องเป็น 0 ไม่ใช่ค่าค้างจากงานก่อน ─────────────────
{
  const { t, processed } = await scenario('none', async () => { await sleep(100); });
  ok('ไม่เรียก LLM: ms/busyMs/calls = 0', t.ms === 0 && t.busyMs === 0 && t.calls === 0);
  ok('ไม่เรียก LLM: own = processed ทั้งก้อน', processed - t.busyMs === processed);
}

// ── 12 งานพร้อมกัน (เท่าความกว้างคิวจริง): ตัวเลขต้องไม่ปนข้ามงาน ────────────────
{
  const runs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    scenario(`job${i}`, async () => { await Promise.all([call(100 + i * 10), call(100 + i * 10)]); })));
  const bad = runs.filter((r, i) => !near(r.t.ms, (100 + i * 10) * 2, 120) || r.t.calls !== 2);
  ok('12 งานพร้อมกัน: แต่ละงานได้ตัวเลขของตัวเอง ไม่ปนกัน', bad.length === 0,
    bad.length ? bad.map(b => `${b.label}:ms=${b.t.ms}/calls=${b.t.calls}`).join(' ') : '');
  ok('12 งานพร้อมกัน: ทุกงาน busyMs < ms (ยิงขนานทั้งหมด)',
    runs.every(r => r.t.busyMs < r.t.ms));
  ok('12 งานพร้อมกัน: ทุกงาน own ≥ 0', runs.every(r => r.processed - r.t.busyMs >= 0));
}

// ── token ยังนับเหมือนเดิม (กันการแก้ครั้งนี้ไปกระทบ G#2) ────────────────────────
{
  const { t } = await scenario('token', async () => { await Promise.all([call(50), call(50)]); });
  ok('token: prompt = 200 · cached = 120 (2 call สำเร็จ)',
    t.promptTokens === 200 && t.cachedTokens === 120, `${t.promptTokens}/${t.cachedTokens}`);
}

console.log(failures === 0 ? `\n✅ ผ่านทั้งหมด` : `\n❌ ไม่ผ่าน ${failures} ข้อ`);
process.exit(failures === 0 ? 0 : 1);
