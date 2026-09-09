-- ─────────────────────────────────────────────────────────────────────────────
--  เฟส B ของแผน docs/plan-web-quote-request.md §2.5 — ชื่อผู้จัดทำใบฝั่ง Odoo ของแอดมิน
--
--  ใบที่ออกจากหน้าเว็บแอดมินใช้ "ตัวตนพร็อกซี": ช่อง H (ผู้ขาย) เป็นเซลส์ที่แอดมินเลือก
--  ส่วนช่อง J (ผู้จัดทำ) เป็นชื่อของแอดมินเอง — คอลัมน์นี้คือที่เก็บชื่อช่อง J ของแอดมินแต่ละคน
--
--  ค่าที่ถูกต้องต้องมีอยู่จริงใน sale_orders.employee_quotations ของแถว invoice_status='invoiced'
--  (ตัดสังกัดท้ายชื่อออกแล้ว) — วัดกับ DB จริง 2026-09-07 ได้ 70 ชื่อ · query ~250ms
--  ฝั่ง API ตรวจซ้ำตอน PUT /api/admin/webchat/me · ไม่อยู่ในรายชื่อ = 400
--
--  เก็บเป็นชื่อเปล่าไม่มีสังกัดห้อยท้าย — สังกัด (PM)/(THT) ถูกเติมตอน export
--  โดย withCompanySuffix() ใน services/odooSaleOrderExport.ts รูปแบบเดียวกับ
--  salesperson.employee_quotation_id ที่ใช้อยู่แล้วสำหรับใบจาก LINE
--
--  NULL = แอดมินคนนั้นยังไม่ได้ตั้งชื่อผู้จัดทำ → หน้าเว็บบล็อกไม่ให้เริ่มแชท
--  additive อย่างเดียว ไม่มี default ไม่ rewrite ตาราง ⇒ ขึ้น prod ก่อนโค้ดได้ปลอดภัย
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-09-07_05_admin_users_employee_quotation_id.sql
--  idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS employee_quotation_id character varying(255);

COMMENT ON COLUMN public.admin_users.employee_quotation_id IS
  'ชื่อผู้จัดทำใบฝั่ง Odoo (ช่อง J) ของแอดมินคนนี้ — ต้องเป็นชื่อที่มีจริงใน sale_orders.employee_quotations (invoiced) เก็บแบบไม่มีสังกัดห้อยท้าย · NULL = ยังไม่ได้ตั้งค่า';

COMMIT;
