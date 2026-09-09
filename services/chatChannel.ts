// ─────────────────────────────────────────────────────────────────────────────
//  ช่องทางตอบกลับที่ถอดออกจาก LINE ได้ — เฟส A ของ docs/plan-web-quote-request.md
//
//  โจทย์: อยากให้ handleEvent (ตัวประมวลผลข้อความทั้งก้อน ~1,900 บรรทัด) ถูกเรียกจาก
//  หน้าเว็บแอดมินได้ด้วย โดย **ไม่ต้องแตะตรรกะข้างในเลยแม้แต่บรรทัดเดียว**
//  ทางที่เลือกคือ "ฉีดตัวตอบกลับเข้าไป" แทนที่จะให้ handleEvent import lineClient มาใช้ตรง ๆ
//
//  ไฟล์นี้จงใจไม่รู้จักอะไรเลยนอกจากรูปร่างของ replyMessage — ไม่ import LINE SDK
//  ไม่แตะ DB ⇒ ถอดไฟล์นี้ออกแล้วระบบเดิมกลับมาเหมือนเดิมเป๊ะ (หลักการข้อ 1 ของแผน)
//
//  ⚠️ เฟสนี้ยังไม่มีใครส่ง client เข้ามา — ทุกเส้นทางยังใช้ค่าปริยายคือ lineClient ตัวเดิม
//     พฤติกรรมจึงต้องเท่าของเดิมทุกบิต ตัวใช้งานจริงมาที่เฟส C
// ─────────────────────────────────────────────────────────────────────────────

/**
 * สิ่งเดียวที่ `handleEvent` ต้องการจากตัวตอบกลับ — แคบไว้ตั้งใจ
 *
 * `lineClient` ของ LINE SDK เข้ารูปนี้อยู่แล้วโดยไม่ต้องห่ออะไร (ตรวจด้วย tsc)
 * ถ้าวันหนึ่ง handleEvent ไปเรียกเมธอดอื่นของ SDK เพิ่ม จะพังที่ compile time ทันที
 * ซึ่งเป็นสิ่งที่ต้องการ — จะได้รู้ตัวว่าเส้นทางเว็บกำลังจะขาดอะไร ไม่ใช่ไปเงียบตอนรัน
 */
export interface ReplyClient {
  replyMessage(p: { replyToken: string; messages: any[] }): Promise<any>;
}

/**
 * ตัวตอบกลับที่ "เก็บใส่ตะกร้าแทนส่งออก LINE"
 *
 * ใช้ตอนเรียก handleEvent จากฝั่งเว็บ: ข้อความที่ปกติจะถูกยิงกลับไปทาง replyToken
 * จะไปกองอยู่ใน `captured` ให้ฝั่งเรียกหยิบไปตอบเป็น JSON แทน
 *
 * คืน `null` ได้โดยไม่ต้องปลอม response ของ LINE ให้เหมือนจริง เพราะไม่มีใครอ่านค่านี้:
 * ใน handleEvent ทุกจุดเป็น `return lineClient.replyMessage(...)` (ไม่เอาไปคิดต่อ) และค่าที่
 * ไหลออกไปก็ไม่มีใครแตะ — index.ts ดู `res.outcome` ของ runWithDeadline แทน ส่วน abortCheck
 * ตรวจแค่เคส abort ที่คืน null อยู่แล้ว
 */
export function createCaptureClient(): { captured: any[]; client: ReplyClient } {
  const captured: any[] = [];
  return {
    captured,
    client: {
      async replyMessage(p: { replyToken: string; messages: any[] }) {
        captured.push(...p.messages);   // เก็บแทนส่งออก LINE
        return null;
      }
    }
  };
}
