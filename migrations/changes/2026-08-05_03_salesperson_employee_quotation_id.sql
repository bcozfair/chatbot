-- เพิ่มคอลัมน์ employee_quotation_id ให้ตาราง salesperson
--
-- ที่มา: ช่อง J (employee_quotation_id) ของไฟล์นำเข้า Sale Order ของ Odoo เดิมปล่อยเป็นเซลล์ว่างเสมอ
--   ตอนนี้ต้องใส่ "ชื่อจริงของเซลล์" ฝั่ง Odoo ซึ่งอาจไม่ตรงกับ salesperson.name ที่พิมพ์บน PDF
--   (name เป็นชื่อที่ใช้แสดงในใบเสนอราคา) จึงแยกเป็นคอลัมน์ของตัวเอง ไม่ทับ name
--
-- แอดมินกรอก/แก้/ล้างค่าได้จากหน้า "จัดการลายเซ็นพนักงาน" (PUT /api/admin/salespersons/:userId)
-- NULL = ยังไม่กรอก → ช่อง J ของใบนั้นเป็นเซลล์ว่างเหมือนเดิม (ไม่เดาค่าจาก name ให้)

ALTER TABLE public.salesperson
  ADD COLUMN IF NOT EXISTS employee_quotation_id character varying(255);
