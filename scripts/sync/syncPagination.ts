// ============================================================
// Logic การตัดสินใจของ cursor-pagination loop ที่ sync ทั้ง 3 ตัวใช้ร่วมกัน
//
// ทำไมแยกออกมา: เดิม loop ถูก copy เหมือนกันใน syncCustomers / syncSaleorders /
// syncProducts รวมถึง "จุดบั๊ก silent truncation" — ตอน has_more=true แต่ cursor
// ไม่ขยับ โค้ดเดิม COMMIT แล้ว break เฉย ๆ ทำให้ startSync บันทึกเป็น success
// ทั้งที่กวาดยังไม่จบ (ข้อมูลหายเงียบ) แก้ที่เดียวไม่ครบ 3 ที่เมื่อไหร่จะเพี้ยนกันเงียบ ๆ
// เหมือนที่ gatewayClient.ts เคยโดน
//
// ฟังก์ชันนี้เป็น pure (ไม่แตะ DB/network) จึง unit test ได้ตรง ๆ
// ============================================================

export interface PageTransitionInput {
  /** payload.has_more จาก gateway */
  hasMore: boolean;
  /** payload.next_cursor */
  nextCursor: string | null | undefined;
  /** cursor ของหน้าที่เพิ่งดึง (null = หน้าแรก since=1970) */
  previousCursor: string | null;
  /** จำนวนครั้งที่ retry เพราะ cursor ไม่ขยับ (reset เป็น 0 ทุกครั้งที่ cursor ขยับจริง) */
  stallRetries: number;
  /** เพดาน retry ตอน cursor ไม่ขยับ ก่อนจะยอมแพ้แล้ว throw */
  maxStallRetries: number;
}

export type PageTransition =
  | { action: 'complete' }                 // has_more=false → flip incremental, save final cursor, break
  | { action: 'advance' }                  // เลื่อนไป nextCursor แล้วดึงหน้าถัดไป
  | { action: 'retry-stall' }              // cursor ไม่ขยับ แต่ยัง retry ได้ → ดึง cursor เดิมซ้ำ
  | { action: 'error'; reason: string };   // ต้อง throw (จะถูกบันทึกเป็น failed ไม่ใช่ success ปลอม)

/** เพดาน retry ตอน cursor ไม่ขยับ — เผื่อ gateway คืนหน้าซ้ำชั่วคราวตอน flaky */
export const MAX_STALL_RETRIES = 2;

/**
 * ตัดสินว่าจะทำอะไรต่อหลังดึง 1 หน้า
 *
 * หัวใจของการแก้ silent truncation: เมื่อ has_more=true แต่ cursor ไม่ขยับ
 * ต้องไม่ "จบแบบสำเร็จ" — retry ก่อน ถ้ายังไม่ขยับก็ throw เพื่อให้ startSync
 * บันทึกเป็น failed (จะได้รู้ว่ากวาดไม่ครบ ไม่ใช่เข้าใจผิดว่า sync จบสมบูรณ์)
 */
export function decidePageTransition(input: PageTransitionInput): PageTransition {
  const { hasMore, nextCursor, previousCursor, stallRetries, maxStallRetries } = input;

  if (!hasMore) return { action: 'complete' };

  if (!nextCursor || typeof nextCursor !== 'string') {
    return { action: 'error', reason: 'has_more=true but next_cursor is missing/invalid' };
  }

  if (nextCursor === previousCursor) {
    if (stallRetries < maxStallRetries) return { action: 'retry-stall' };
    return {
      action: 'error',
      reason: `sync stalled: has_more=true but next_cursor did not advance after ${maxStallRetries} retries — sweep incomplete, refusing to report success`,
    };
  }

  return { action: 'advance' };
}
