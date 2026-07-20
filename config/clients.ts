import * as line from '@line/bot-sdk';
import * as dotenv from 'dotenv';
import { OpenAI } from 'openai';

dotenv.config();

const hasDeepSeekKey = !!process.env.DEEPSEEK_API_KEY;

export const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: hasDeepSeekKey ? 'https://api.deepseek.com' : (process.env.OPENAI_BASE_URL || undefined),
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
  return openai.chat.completions.create({
    model: LLM_MODEL,
    thinking: { type: 'disabled' },
    temperature: 0,
    ...params,
  } as any);
}

export const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

export const lineClient = line.LineBotClient.fromChannelAccessToken({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
});
