import { pool } from '../config/db.js';
import { serr, slog, swarn } from '../scripts/sync/syncLog.js';

/**
 * จับคู่ใบเสนอราคาที่ถูกนำเข้า Odoo แล้ว — เรียกท้ายทุกรอบ sync
 *
 * ─── ทำไมต้องมีตัวนี้ ────────────────────────────────────────────────────────
 * ไฟล์นำเข้าของเราส่ง quotation_no ไปเป็นชื่อเอกสารใน Odoo แถวใน sale_orders จึงมี
 * order_reference ตรงกับเลขใบให้จับคู่ได้ แต่ "ชั่วคราว" เท่านั้น:
 *   QP-xxxxx (ใบเสนอราคา) → พอยืนยัน/ออกบิลจริง Odoo เปลี่ยนชื่อเป็น OP-/OT-/DP-/DT-
 * แถวชื่อเดิมกลายเป็นซากที่ไม่อัปเดตอีก และวันหนึ่งอาจถูกล้างหรือหายไปตอน full sync
 * → ถ้าไปเช็คสถานะด้วยการ join สดตอนเปิดหน้าจอ ใบที่ "สำเร็จแล้ว" จะกลับไปเป็น
 *   "รอนำเข้า" เองโดยไม่มีใครแตะอะไร ซึ่งกลับหัวกลับหางกับความจริง
 * จึงต้องบันทึกทันทีที่เห็นครั้งแรก แล้วไม่แตะอีกเลย — สถานะเดินหน้าทางเดียว
 *
 * ─── ข้อจำกัดที่รู้ตัว ───────────────────────────────────────────────────────
 * gateway ส่ง "สถานะปัจจุบันของเอกสารที่เปลี่ยนแปลง" ไม่ใช่ประวัติการเปลี่ยน ใบที่ถูก
 * นำเข้าแล้วยืนยันจนเปลี่ยนชื่อ *ภายในช่องว่างระหว่างรอบ sync เดียวกัน* จะไม่เคยโผล่มา
 * ในชื่อ Q* เลย → ค้างที่ "รอนำเข้า" ทั้งที่สำเร็จ (ในทางปฏิบัติพบน้อยมาก เพราะเอกสาร
 * ส่วนใหญ่ถูกยืนยันหลังนำเข้าเป็นวัน ๆ) ปิดช่องนี้ไม่ได้จาก payload ชุดนี้ เพราะไม่มี
 * field ไหนบอก "เอกสารนี้เดิมชื่ออะไร"
 *
 * ─── กติกา ──────────────────────────────────────────────────────────────────
 * ห้าม throw — ถูกเรียกใน finally ของรอบ sync ถ้าโยน error ออกไปจะกลืนบรรทัดสรุปรอบทิ้ง
 * ทั้งที่ตัว sync สำเร็จแล้ว ตัวนี้เป็นแค่ข้อมูลประกอบหน้าจอ พังได้โดยไม่ต้องล้มทั้งรอบ
 */
export async function reconcileQuotationOdooLinks(): Promise<{ linked: number; pending: number } | null> {
  try {
    // ยังไม่ได้รัน migration 2026-09-02_03 → ข้ามไปเงียบ ๆ (เตือนไว้บรรทัดเดียว)
    // ที่นี่จงใจไม่ ALTER ให้เอง ต่างจาก sale_orders ที่ไม่มีคอลัมน์แล้ว sync พังทั้งรอบ —
    // ตรงนี้ขาดคอลัมน์แค่ทำให้หน้าจอไม่โชว์สถานะ ไม่คุ้มที่จะให้แอปสั่ง DDL กับตารางใบเสนอราคา
    const { rows: cols } = await pool.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'quotations' AND column_name = 'odoo_imported_at'
    `);
    if (cols.length === 0) {
      swarn('ข้ามการจับคู่ใบเสนอราคากับ Odoo — ยังไม่มีคอลัมน์ quotations.odoo_imported_at (รัน migration 2026-09-02_03)');
      return null;
    }

    // เขียนเฉพาะแถวที่ยังว่าง = แต่ละใบถูกมาร์กครั้งเดียวตลอดชีพ รันซ้ำกี่รอบก็ไม่เปลี่ยนค่าเดิม
    //
    // order_date guard: กันจับคู่ข้ามยุคกับเอกสารที่ Odoo สร้างเองแล้วบังเอิญชื่อชนกัน
    //   (เลขของเราคือ QP-YYMM05NNN จองบล็อก 05000–05999 ไว้ ซึ่งเลขของ Odoo เองไปไม่ถึง
    //    — guard นี้จึงเป็นเข็มขัดเส้นที่สอง ไม่ใช่เส้นเดียวที่กันอยู่)
    //   เผื่อ 1 วันเพราะ order_date ฝั่ง Odoo เป็นวันที่ของเอกสาร ไม่ใช่เวลาที่กดนำเข้า
    //   จึงเป็นวันก่อนหน้าเวลาสร้างใบในระบบเราได้เมื่อคนละโซนเวลา/คีย์ย้อนวัน
    const upd = await pool.query(`
      UPDATE quotations q
         SET odoo_imported_at = NOW(),
             odoo_so_id       = s.sale_order_id
        FROM sale_orders s
       WHERE q.odoo_imported_at IS NULL
         AND q.quotation_no IS NOT NULL
         AND s.order_reference = q.quotation_no
         AND s.sale_order_id IS NOT NULL
         AND s.order_date >= q.created_at - INTERVAL '1 day'
    `);
    const linked = upd.rowCount ?? 0;

    // ค้าง = ส่งออกไฟล์ไปแล้วแต่ยังไม่เคยเห็นใน Odoo (ยังไม่ได้อัปโหลด / อัปโหลดไม่สำเร็จ / โดนช่องว่างรอบ sync)
    const { rows } = await pool.query(`
      SELECT count(*)::int AS pending
        FROM quotations
       WHERE odoo_imported_at IS NULL AND odoo_exported_at IS NOT NULL
    `);
    const pending = rows[0]?.pending ?? 0;

    if (linked > 0) slog(`🔗 นำเข้า Odoo แล้ว: ใหม่ ${linked} ใบ · ยังค้าง ${pending} ใบ`);
    return { linked, pending };
  } catch (err: any) {
    serr(`จับคู่ใบเสนอราคากับ Odoo ไม่สำเร็จ — ${err?.message || err}`);
    return null;
  }
}
