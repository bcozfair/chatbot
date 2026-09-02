-- ─────────────────────────────────────────────────────────────────────────────
--  สถานะ "นำเข้า Odoo แล้ว" ของใบเสนอราคา — เก็บเป็น snapshot ถาวรในตาราง quotations
--
--  ทำไมต้อง snapshot ไม่ใช่ join สด:
--    ไฟล์นำเข้าของเราส่งเลขใบ (QP-/QT-) ไปเป็นชื่อเอกสารใน Odoo แถวใน sale_orders จึงมี
--    order_reference = quotation_no ให้จับคู่ได้ "ช่วงหนึ่ง" เท่านั้น — พอเอกสารถูกยืนยัน/ออกบิลจริง
--    Odoo เปลี่ยนชื่อเป็น OP-/OT-/DP-/DT- แถวชื่อ Q* ก็ค้างเป็นซากไม่อัปเดตอีก และถ้าวันหน้า
--    ล้างซากหรือ full sync ใหม่ ชื่อเดิมจะหายไปเลย → join สดจะ "ตกสถานะกลับ" จากเขียวเป็นเหลือง
--    เองโดยไม่มีใครแตะอะไร ซึ่งอ่านแล้วเข้าใจผิดว่าใบนั้นหลุดออกจาก Odoo
--    บันทึกครั้งเดียวตอนเห็นครั้งแรกแล้วไม่แตะอีก = สถานะเดินหน้าทางเดียว ไม่เด้งกลับ
--
--  odoo_imported_at = เวลาที่ "รอบ sync มองเห็นใบนี้ใน Odoo ครั้งแรก" (ไม่ใช่เวลาที่ Odoo สร้าง)
--                     เขียนครั้งเดียวตลอดชีพ — ตัว reconcile คัดเฉพาะแถวที่ยังเป็น NULL
--  odoo_so_id       = sale_orders.sale_order_id (id ในฐาน Odoo) — ตัวนี้ "ไม่เปลี่ยน" แม้เอกสาร
--                     จะถูกเปลี่ยนชื่อ จึงเป็นสมอให้ตามหาสถานะปัจจุบันของเอกสารได้ในอนาคต
--                     (ตอนนี้ยังไม่มีหน้าจอไหนใช้ เก็บไว้เพื่อไม่ต้องมาไล่จับคู่ย้อนหลังทีหลัง)
--
--  ไม่ทำ index ให้ — quotations มีแค่ ~1.3k แถว ตัว reconcile กวาดทั้งตารางก็จบในหลักมิลลิวินาที
--  ส่วนฝั่ง sale_orders จับผ่าน order_reference ซึ่งเป็น primary key อยู่แล้ว
--
--  รัน (ตาม DEPLOY.md ข้อ 4 — ใช้ psql ไม่ใช่ runMigration.ts):
--    docker exec -i primus-chatbot-db-1 psql -U postgres -d chatbot_primus \
--      < migrations/changes/2026-09-02_03_quotations_odoo_import_link.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS odoo_imported_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS odoo_so_id       integer;
