// ─────────────────────────────────────────────────────────────────────────────
//  abortCheck — ยิงทดสอบ C.3: งานที่หมดเวลาต้อง "หยุดจริง" ไม่ใช่รันต่อเป็นงานผี
//
//  ทำไมต้องมี: เส้นทางนี้จะเกิดก็ต่อเมื่อ "หมดงบเวลา" ซึ่งไม่เกิดตอน dev และตอน prod ก็เห็นได้
//  แค่ใน log ⇒ ถ้าไม่ยิงเองจะไม่มีวันรู้ว่าโค้ดที่เขียนไว้ทำงานไหม จนกว่าจะไปพังของจริง
//
//  ไม่แตะ DB · ไม่เรียก LINE · ไม่เรียก LLM (เคสที่แตะ handleEvent จริงใช้ signal ที่ abort
//  ไว้ก่อนแล้ว ⇒ ด่านตรวจใบแรกโยนออกก่อนถึง query แรกเสมอ)
//
//  รัน: docker compose run --rm --no-deps -v $PWD/scripts:/app/scripts ... app npx tsx scripts/diag/abortCheck.ts
// ─────────────────────────────────────────────────────────────────────────────

import { runWithDeadline } from '../../services/webhookQueue.js';
import { handleEvent } from '../../handlers/lineHandler.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

// unhandledRejection = อาการที่ทำให้ Node ฆ่าโปรเซสทิ้งทั้งตัว (ทุกคนในคิวหายไปด้วย)
// จับไว้ทั้งไฟล์ ถ้าโผล่แม้แต่ครั้งเดียวถือว่าเทสตก
const unhandled: any[] = [];
process.on('unhandledRejection', (err) => unhandled.push(err));

async function main() {
  // ── 1. งานเสร็จทันงบ → ok และ signal ต้องไม่ถูก abort ─────────────────────────
  {
    let sawAbort = false;
    const res = await runWithDeadline(1_000, async (signal) => {
      await sleep(50);
      sawAbort = signal.aborted;
    });
    check('เสร็จทันงบ → outcome=ok', res.outcome === 'ok', `ได้ ${res.outcome}`);
    check('เสร็จทันงบ → ไม่ถูก abort', !sawAbort);
  }

  // ── 2. งานพังเอง → error (ต้องไม่ถูกนับเป็น timeout) ─────────────────────────
  {
    const res = await runWithDeadline(1_000, async () => {
      throw new Error('boom');
    });
    check(
      'งานพังเอง → outcome=error',
      res.outcome === 'error' && (res as any).error?.message === 'boom',
      `ได้ ${res.outcome}`
    );
  }

  // ── 3. หมดเวลา → timeout + งานต้องเห็นธง abort แล้ว "หยุดที่ด่านถัดไป" ───────
  //     นี่คือหัวใจของ C.3: ก่อนหน้านี้ stage 2/3 จะรันต่อจนจบทั้งที่ไม่มีใครรอผลแล้ว
  {
    const ran: string[] = [];
    const res = await runWithDeadline(120, async (signal) => {
      ran.push('stage1');
      await sleep(250);                       // ← หมดเวลาระหว่างนี้
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      ran.push('stage2');
      await sleep(250);
      ran.push('stage3');
    });
    check('หมดเวลา → outcome=timeout', res.outcome === 'timeout', `ได้ ${res.outcome}`);
    await sleep(600);                          // รอให้งานผี (ถ้ามี) มีเวลาวิ่งต่อจนจบ
    check(
      'งานหยุดที่ด่านตรวจถัดไป ไม่รันต่อ',
      ran.join(',') === 'stage1',
      `รันไปถึง [${ran.join(', ')}]`
    );
  }

  // ── 4. งานที่ถูก abort ไป reject ทีหลัง ต้องไม่กลายเป็น unhandledRejection ───
  //     (rejection เกิด "หลัง" race จบไปแล้ว — เป็นบั๊กที่มองไม่เห็นจนกว่าจะหมดเวลาจริง)
  {
    let ghostErr: any = null;
    const res = await runWithDeadline(
      100,
      async () => {
        await sleep(200);
        throw new Error('ghost failure');
      },
      (e) => { ghostErr = e; }
    );
    check('หมดเวลา (เคสงานพังทีหลัง) → outcome=timeout', res.outcome === 'timeout');
    await sleep(400);
    check('งานผีที่พังถูกดักด้วย onGhostError', ghostErr?.message === 'ghost failure', String(ghostErr?.message));
  }

  // ── 5. ของจริง: handleEvent ที่ได้ signal ซึ่ง abort ไปแล้ว ──────────────────
  //     ต้องคืน null เงียบ ๆ ที่ด่านใบแรก โดยไม่แตะ DB / ไม่ยิง LINE
  //     (userId ปลอม — ถ้าด่านตรวจไม่ทำงาน มันจะไปโผล่เป็น insertSalesperson ใน DB ทันที)
  {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const out = await handleEvent(
      {
        type: 'message',
        message: { type: 'text', text: 'เสนอราคา ทดสอบ abort' },
        source: { userId: 'ABORT_CHECK_FAKE_USER' },
        replyToken: 'FAKE_TOKEN_ต้องไม่ถูกใช้'
      },
      { deadlineAt: Date.now() + 60_000, signal: ac.signal }
    );
    const took = Date.now() - t0;
    check('handleEvent ที่ถูก abort แล้ว → คืน null', out === null, `ได้ ${JSON.stringify(out)}`);
    // ด่านใบแรกอยู่ก่อน getSalespersonByUserId ⇒ ถ้าเร็วกว่า 50ms แปลว่าไม่ได้ไปแตะ DB จริง
    check('หยุดก่อนแตะ DB (เร็วกว่า 50ms)', took < 50, `ใช้ ${took}ms`);
  }

  // (ไม่มีเคส "ไม่ส่ง signal มา" เพราะเส้นทางนั้นต้องวิ่งเข้า DB จริงและอาจยิง LINE จริง
  //  ⇒ ทดสอบที่นี่ไม่ได้โดยไม่มีผลข้างเคียง · ครอบด้วย tsc + boot smoke + runExtractionDiag แทน)

  await sleep(200);
  check('ไม่มี unhandledRejection ตลอดการทดสอบ', unhandled.length === 0, `เจอ ${unhandled.length} ครั้ง`);

  console.log(failed === 0 ? '\nABORT_CHECK_OK' : `\nABORT_CHECK_FAILED (${failed} ข้อ)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
