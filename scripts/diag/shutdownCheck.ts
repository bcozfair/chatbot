// ─────────────────────────────────────────────────────────────────────────────
//  shutdownCheck — ยิงทดสอบ C.4: ตอน shutdown ต้อง "รอคิวที่ค้างให้ตอบจนจบ"
//
//  ทำไมต้องมี: drain() ถูกเขียนไว้ตั้งแต่ C.0 แต่ไม่เคยถูกเรียกที่ไหนเลยจนถึง C.4
//  ⇒ ยังไม่เคยมีอะไรพิสูจน์ว่ามันทำงาน และเส้นทางนี้จะถูกใช้จริงตอน deploy เท่านั้น
//  ซึ่งถ้าพลาดคือ "ข้อความหายยกชุด" แบบเดียวกับบั๊กที่กำลังแก้อยู่พอดี
//
//  ข้อที่สำคัญที่สุดคือข้อ 4: งานที่ยัง "รอคิว" อยู่ (ยังไม่เริ่มรัน) ต้องถูกรันจนหมด
//  ระหว่าง drain ไม่ใช่ถูกทิ้ง — เพราะพวกนี้แหละคือข้อความที่หายเงียบทุกครั้งที่ deploy
//
//  ไม่แตะ DB · ไม่เรียก LINE · ไม่เรียก LLM
//  รัน: npm run diag:shutdown-check
// ─────────────────────────────────────────────────────────────────────────────

import { KeyedTaskQueue } from '../../services/webhookQueue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

async function main() {
  // ── 1. คิวว่างอยู่แล้ว → คืน true ทันที (restart ตอนไม่มีคนใช้ต้องไม่ช้าลง) ──────
  {
    const q = new KeyedTaskQueue(12);
    const t0 = Date.now();
    const ok = await q.drain(5_000);
    const took = Date.now() - t0;
    check('คิวว่าง → drain คืน true ทันที', ok && took < 20, `${ok} ใน ${took}ms`);
  }

  // ── 2. มีงานรันอยู่ → รอจนเสร็จแล้วค่อยคืน true ────────────────────────────────
  {
    const q = new KeyedTaskQueue(12);
    let done = false;
    q.push('u1', async () => { await sleep(300); done = true; });
    const t0 = Date.now();
    const ok = await q.drain(5_000);
    check('มีงานรันอยู่ → รอจนเสร็จ', ok && done, `drain=${ok} done=${done} ใน ${Date.now() - t0}ms`);
  }

  // ── 3. งานช้ากว่า timeout → คืน false (ไม่ค้างตลอดกาล) ────────────────────────
  {
    const q = new KeyedTaskQueue(12);
    q.push('u1', async () => { await sleep(1_000); });
    const t0 = Date.now();
    const ok = await q.drain(200);
    const took = Date.now() - t0;
    check('งานช้ากว่า timeout → คืน false ตรงเวลา', !ok && took < 400, `drain=${ok} ใน ${took}ms`);
    check('รายงานของที่เหลือได้ (ไว้ log ว่าหายกี่ตัว)', q.activeCount === 1, `active=${q.activeCount}`);
    await sleep(900); // เก็บกวาดก่อนเคสถัดไป
  }

  // ── 4. ⭐ งานที่ยัง "รอคิว" ต้องได้รันจนหมด ไม่ใช่ถูกทิ้ง ───────────────────────
  //     นี่คือหัวใจของ C.4: maxConcurrency=2 + งาน 6 ตัว ⇒ 4 ตัวยังไม่ได้เริ่มตอนสั่งปิด
  {
    const q = new KeyedTaskQueue(2);
    const finished: string[] = [];
    for (let i = 1; i <= 6; i++) {
      q.push(`u${i}`, async () => { await sleep(120); finished.push(`u${i}`); });
    }
    await sleep(10); // ให้คิวเริ่มรัน 2 ตัวแรกก่อน แล้วค่อย "สั่งปิด"
    check('ก่อน drain มีงานรอคิวจริง', q.pendingCount === 4, `pending=${q.pendingCount} active=${q.activeCount}`);
    const ok = await q.drain(5_000);
    check(
      'งานที่รอคิวถูกรันจนครบ 6/6 ระหว่าง drain',
      ok && finished.length === 6,
      `drain=${ok} เสร็จ ${finished.length}/6 [${finished.join(', ')}]`
    );
    check('หลัง drain คิวว่างจริง', q.isIdle, `active=${q.activeCount} pending=${q.pendingCount}`);
  }

  // ── 5. งานที่พังกลางคัน ต้องไม่ทำให้ drain ค้าง ────────────────────────────────
  {
    const q = new KeyedTaskQueue(12);
    q.push('u1', async () => { await sleep(50); throw new Error('งานพัง'); });
    q.push('u2', async () => { await sleep(50); });
    const ok = await q.drain(2_000);
    check('งานพังกลางคัน → drain ยังคืน true ไม่ค้าง', ok && q.isIdle, `drain=${ok}`);
  }

  // ── 6. เรียก drain ซ้อนกัน (สัญญาณซ้อน) ต้องได้คำตอบทั้งคู่ ────────────────────
  {
    const q = new KeyedTaskQueue(12);
    q.push('u1', async () => { await sleep(150); });
    const [a, b] = await Promise.all([q.drain(2_000), q.drain(2_000)]);
    check('drain ซ้อนกัน → คืน true ทั้งคู่', a === true && b === true, `${a} / ${b}`);
  }

  console.log(failed === 0 ? '\nSHUTDOWN_CHECK_OK' : `\nSHUTDOWN_CHECK_FAILED (${failed} ข้อ)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
