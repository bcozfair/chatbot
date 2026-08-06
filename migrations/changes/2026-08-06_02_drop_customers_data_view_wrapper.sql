-- ปลด plain view customers_data — หมดเหตุผลที่มันเกิดมาแล้ว
--
-- 2026-07-23_03 สร้าง view นี้ครอบ customers_data_view ด้วยเหตุผลเดียว: customers_data_view
-- เป็น MATERIALIZED VIEW ซึ่ง TablePlus ไม่แสดงใน sidebar (สร้าง tree จาก information_schema
-- ที่ไม่รวม matview) → เปิดคลิกดูข้อมูลไม่ได้ จึงทำ plain view ครอบให้โผล่ในโฟลเดอร์ Views
--
-- ตั้งแต่ 2026-08-06_01 customers_data_view กลายเป็นตารางจริง → โผล่ในโฟลเดอร์ Tables
-- คลิกดูได้ตรง ๆ อยู่แล้ว view ตัวครอบจึงไม่มีหน้าที่อะไรเหลือ
--
-- ที่เรียกใช้จริงมีที่เดียว (scripts/diag/odooExportSmoke.ts) — ย้ายไปอ่าน customers_data_view
-- ตรง ๆ แล้ว เจตนาเดิมของมันยังอยู่ครบ: มันต้องการอ่านแยกจาก "ท่อน JOIN" ที่ export ใช้
-- (ODOO_EXPORT_SALES_TEAM_JOIN) ไม่ได้ต้องการอ่านแยกจากตาราง
--
-- ผลพลอยได้: refresh ทุกรอบไม่ต้อง DROP+CREATE view ตัวนี้ใน transaction ที่ถือ
-- AccessExclusiveLock อีก (view ผูกกับ OID ของตาราง พอสลับตารางก็ต้องสร้าง view ใหม่ตาม)
-- → ช่วงที่คนอ่านถูกบล็อกตอนสลับตารางสั้นลง

DROP VIEW IF EXISTS public.customers_data;
