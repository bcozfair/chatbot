// ─────────────────────────────────────────────────────────────────────────────
//  KeyedTaskQueue — ย้ายออกมาจาก index.ts (เดิมเป็น class ฝังกลางไฟล์ ทดสอบไม่ได้)
//
//  ตรรกะการจัดคิว "ยกมาทั้งดุ้น" ไม่แก้แม้แต่บรรทัดเดียว — ที่เพิ่มเข้ามามีแค่ส่วนที่
//  ไม่กระทบพฤติกรรมเดิม:
//    · getter activeCount / pendingCount / isIdle  → ให้ scripts/diag/queueSim.ts วัดได้
//    · drain(timeoutMs)                            → ให้ graceful shutdown รอคิวจนว่าง (C.4)
//
//  เหตุผลที่ต้องแยกไฟล์: sim ต้องรันคิว "ตัวเดียวกับ prod" ไม่ใช่ของจำลอง ไม่งั้นผลที่วัด
//  ไม่ได้บอกอะไรเกี่ยวกับระบบจริงเลย
// ─────────────────────────────────────────────────────────────────────────────

/**
 * งบเวลาตอบกลับ 1 event
 *
 * replyToken ของ LINE มีอายุ "1 นาทีนับจากตอนรับ webhook" ไม่ใช่ตอนเริ่มประมวลผล และ LINE
 * ระบุเองว่าเวลานี้เปลี่ยนได้โดยไม่แจ้งล่วงหน้า + network delay ทำให้สั้นกว่านี้ได้อีก
 * ⇒ ทุกคำตอบต้องผลิตเสร็จภายในงบนี้ในการยิงครั้งเดียว ไม่มีทางหนี (push ถูกห้ามด้วยเหตุผลโควตา
 *    และ token ใช้ได้ครั้งเดียว จะ ack ก่อนแล้วตอบทีหลังก็ไม่ได้)
 */
export const REPLY_TOKEN_TTL_MS = 60_000;
export const SAFETY_MARGIN_MS = 12_000;   // เผื่อ network + เวลาที่ replyMessage เองใช้
export const BUDGET_MS = REPLY_TOKEN_TTL_MS - SAFETY_MARGIN_MS;

/**
 * คำนวณงบที่เหลือของ event หนึ่ง ณ ตอนที่มันถูกดึงออกจากคิว
 * อยู่ที่นี่เพื่อให้ index.ts กับ scripts/diag/queueSim.ts ใช้ "ตรรกะตัวเดียวกัน"
 * ไม่ใช่ของที่ก๊อปกันไว้แล้วค่อย ๆ เพี้ยนออกจากกัน
 *
 * @param receivedAt เวลาที่รับ webhook (ไม่ใช่เวลาที่เริ่มประมวลผล)
 * @param now        เวลาปัจจุบัน (รับเข้ามาเพื่อให้ sim ป้อนเวลาเสมือนได้)
 * @param budgetMs   งบทั้งหมด (sim ปรับได้เพื่อจูน SAFETY_MARGIN_MS)
 */
export function replyBudget(receivedAt: number, now: number, budgetMs: number = BUDGET_MS) {
  const waited = now - receivedAt;
  const remaining = budgetMs - waited;
  return { waited, remaining, expired: remaining <= 0 };
}

/**
 * คิวประมวลผล event แบบ FIFO ต่อ key (userId) — event ของผู้ใช้คนเดียวกันจะรันทีละตัว
 * ไม่ทับกัน (กันการกดปุ่มยืนยันรัว ๆ ชนกันเอง) ส่วนผู้ใช้คนละคนรันขนานกันได้
 * และจำกัดจำนวน key ที่ทำงานพร้อมกันทั้งระบบด้วย maxConcurrency
 */
export class KeyedTaskQueue {
  private queues = new Map<string, (() => Promise<void>)[]>();
  private activeKeys = new Set<string>();
  private active = 0;
  private maxConcurrency: number;
  private idleWaiters: (() => void)[] = [];

  constructor(maxConcurrency = 12) {
    this.maxConcurrency = maxConcurrency;
  }

  /** จำนวน task ที่กำลังรันอยู่จริง ณ ขณะนี้ (ไม่เกิน maxConcurrency) */
  public get activeCount(): number {
    return this.active;
  }

  /** จำนวน task ที่ยังรอคิวอยู่ (ยังไม่เริ่มรัน) */
  public get pendingCount(): number {
    let n = 0;
    for (const tasks of this.queues.values()) n += tasks.length;
    return n;
  }

  public get isIdle(): boolean {
    return this.active === 0 && this.pendingCount === 0;
  }

  public push(key: string, task: () => Promise<void>) {
    const list = this.queues.get(key);
    if (list) list.push(task);
    else this.queues.set(key, [task]);
    this.next();
  }

  /**
   * รอจนคิวว่าง (ไม่มีทั้งงานที่รันอยู่และงานที่รอ) หรือครบ timeout
   * คืน true ถ้าว่างทัน / false ถ้าหมดเวลาก่อน — ใช้ตอน graceful shutdown
   */
  public drain(timeoutMs = 30_000): Promise<boolean> {
    if (this.isIdle) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.idleWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private next() {
    for (const [key, tasks] of this.queues) {
      if (this.active >= this.maxConcurrency) return;
      // key ที่กำลังทำงานอยู่ให้ข้ามไป ไม่กินสล็อต จนกว่าตัวก่อนหน้าของ key นั้นจะเสร็จ
      if (this.activeKeys.has(key) || tasks.length === 0) continue;

      const task = tasks.shift()!;
      if (tasks.length === 0) this.queues.delete(key);

      this.activeKeys.add(key);
      this.active++;
      task()
        .catch((err) => {
          console.error('[KeyedTaskQueue] Task error:', err);
        })
        .finally(() => {
          this.activeKeys.delete(key);
          this.active--;
          this.next();
          this.flushIdleWaiters();
        });
    }
  }

  private flushIdleWaiters() {
    if (!this.idleWaiters.length || !this.isIdle) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
