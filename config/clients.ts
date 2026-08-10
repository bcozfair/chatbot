import { AsyncLocalStorage } from 'async_hooks';
import * as line from '@line/bot-sdk';
import * as dotenv from 'dotenv';
import { OpenAI } from 'openai';

dotenv.config();

const hasDeepSeekKey = !!process.env.DEEPSEEK_API_KEY;

/**
 * เพดานเวลาของ LLM — จุดเดียวที่คุมได้ทั้งระบบ (ทุกการเรียกผ่าน createChatCompletion ด้านล่าง)
 *
 * ของเดิมไม่ตั้งอะไรเลย ⇒ ใช้ default ของ SDK คือ timeout 600 วิ × ลองใหม่ 3 ครั้ง = 1,800 วิ
 * ต่อ 1 การเรียก ซ้อนกับ retry ระดับแอปอีก 3 ชั้น ⇒ worst case ~90 นาที/ข้อความ ขณะกินสล็อตคิว
 * อยู่ตลอด ทั้งที่ replyToken ตายไปตั้งแต่นาทีแรก
 *
 * 20 วิมาจากของที่วัดจริง (scripts/diag/extractionReliability.ts, 150 call):
 * p50 1,787ms · p95 2,554ms · max 3,000ms ⇒ เผื่อไว้ราว 8 เท่าของ p95 แล้ว
 * worst case ต่อ 1 การเรียกจึงลดจาก 1,800 วิ เหลือ 40 วิ
 */
export const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: hasDeepSeekKey ? 'https://api.deepseek.com' : (process.env.OPENAI_BASE_URL || undefined),
  timeout: 20_000,
  maxRetries: 1,   // default 2 (= ยิงรวม 3 ครั้ง) → เหลือยิงรวม 2 ครั้ง
});

// โมเดลกลางของระบบ — ใช้ deepseek-v4-flash
// (deepseek-chat / deepseek-reasoner จะถูก deprecate 2026/07/24 — v4-flash คือตัวแทนถาวร)
export const LLM_MODEL = 'deepseek-v4-flash';

/**
 * เรียก chat completion ด้วยโมเดลกลาง + ปิด thinking mode เป็นค่าเริ่มต้น
 *
 * ทำไมต้องปิด thinking: deepseek-v4-flash default = thinking mode ซึ่งช้ามาก
 * (วัดจริง avg ~6.9s, p95 ~12.6s) ขณะที่ non-thinking เร็ว ~1.7s (p95 ~2.1s) โดย
 * ความถูกต้องเท่ากัน 100% — งานสกัด/จับคู่ของเราไม่ต้องใช้ reasoning
 *
 * ทำไม temperature = 0: งานทุกจุดของระบบนี้เป็น "เลือกคำตอบเดียวที่ถูก" (สกัด JSON / เลือกเบอร์ตัวเลือก)
 * ค่า default ของ DeepSeek คือ 1.0 = สุ่มตามความน่าจะเป็น ทำให้ตอนโมเดลลังเลจะได้คำตอบไม่เหมือนเดิมทุกครั้ง
 * (วัดจริงกับ prompt เลือกรุ่นสินค้า: temp 1.0 ตอบผิด 1/8 ครั้ง, temp 0 ถูก 8/8)
 * DeepSeek เองแนะนำ 0.0 สำหรับงานประเภท Coding/Math ซึ่งตรงกับงานเรา
 *
 * รับ params เหมือน openai.chat.completions.create ทุกอย่าง ยกเว้นไม่ต้องระบุ model/thinking/temperature
 * (ถ้าอยากเปิด thinking หรือเพิ่มความหลากหลายเฉพาะจุด ส่ง thinking/temperature มา override ได้)
 */
export async function createChatCompletion(params: Record<string, any>): Promise<any> {
  const timing = llmTimingStore.getStore();
  const t0 = timing ? Date.now() : 0;
  try {
    return await openai.chat.completions.create({
      model: LLM_MODEL,
      thinking: { type: 'disabled' },
      temperature: 0,
      ...params,
    } as any);
  } catch (err) {
    if (timing) timing.errors++;
    throw err;
  } finally {
    // นับทั้งครั้งที่สำเร็จและครั้งที่พัง — ครั้งที่พังคือครั้งที่กินเวลานานที่สุด (timeout 20 วิ + retry)
    // ถ้าไม่นับ ตัวเลขจะสวยกว่าความจริงพอดีตอนที่ระบบมีปัญหา ซึ่งเป็นตอนที่ต้องการตัวเลขที่สุด
    if (timing) { timing.ms += Date.now() - t0; timing.calls++; }
  }
}

/**
 * ─── เวลาที่หมดไปกับ LLM ต่อ "1 งานของคิว webhook" (P4a) ─────────────────────────────
 *
 * ที่มา: api_logs บอกได้แค่ว่างาน /callback ใช้เวลา 17.8 วิ แต่บอกไม่ได้ว่าเป็น LLM / DB / LINE API
 * ซึ่งเป็นภาระที่หนักที่สุดของระบบ (45% ของเวลาเครื่องรวม) และกิน 37% ของงบ 48 วิที่ replyToken มีให้
 * ⇒ ยังตัดสินใจไม่ได้เลยว่าต้องไปแก้ prompt, ลดจำนวนการเรียก, หรือแก้โค้ดฝั่งเรา
 *
 * ทำไมต้องใช้ AsyncLocalStorage ไม่ใช่ตัวแปรนับรวมทั้งโมดูล: คิวรันพร้อมกันได้ 12 งาน
 * (KeyedTaskQueue(12) ใน index.ts) ตัวนับก้อนเดียวจะเอาเวลาของงานคนอื่นมาปนจนตัวเลขไร้ความหมาย
 * และไม่ร้อยพารามิเตอร์ผ่าน handleEvent เพราะจุดเรียก createChatCompletion กระจายอยู่ 4 ที่ใน 3 ไฟล์
 *
 * เฟสนี้ยังไม่แตะ schema ของ api_logs โดยตั้งใจ — ออกทาง console.log ของ [queue] ก่อน
 * ให้ข้อมูลจริงตอบว่าคุ้มไหมที่จะเพิ่มคอลัมน์ (P4b)
 */
export interface LlmTiming {
  /** เวลารวมที่รออยู่ใน createChatCompletion (รวมครั้งที่พัง) */
  ms: number;
  calls: number;
  errors: number;
}

const llmTimingStore = new AsyncLocalStorage<LlmTiming>();

export function newLlmTiming(): LlmTiming {
  return { ms: 0, calls: 0, errors: 0 };
}

/**
 * รัน fn โดยให้ทุก createChatCompletion ที่เกิดข้างในสะสมเวลาลง store ที่ผู้เรียกถือไว้เอง
 *
 * ผู้เรียกเป็นเจ้าของ object เพื่อให้บล็อก finally อ่านค่าได้แม้ fn จะโยน error ออกมา
 * นอกบริบทนี้ getStore() คืน undefined แล้วทุกอย่างทำงานเหมือนเดิม — ไม่มีใครพังเพราะไม่ได้ห่อ
 */
export function withLlmTiming<T>(store: LlmTiming, fn: () => Promise<T>): Promise<T> {
  return llmTimingStore.run(store, fn);
}

export const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

export const lineClient = line.LineBotClient.fromChannelAccessToken({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
});
