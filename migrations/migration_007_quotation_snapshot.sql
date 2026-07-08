-- SQL Migration: ปรับปรุงโครงสร้างตาราง quotations สำหรับ Snapshot
-- วันที่สร้าง: 2026-07-02

-- 1. เปลี่ยนชื่อคอลัมน์เดิมเพื่อความปลอดภัยและเก็บข้อมูลไว้ทำ Migration
ALTER TABLE quotations RENAME COLUMN customer_name TO customer_name_old;
ALTER TABLE quotations RENAME COLUMN items TO items_old;

-- 2. เพิ่มคอลัมน์ใหม่
ALTER TABLE quotations ADD COLUMN customer_details jsonb;
ALTER TABLE quotations ADD COLUMN item_details jsonb;
ALTER TABLE quotations ADD COLUMN salesperson_id varchar(255);
ALTER TABLE quotations ADD COLUMN employee_details jsonb;

-- 3. ให้ข้อมูลใน customer_details และ item_details เป็น nullable เผื่อใช้งานกรณีพิเศษ แต่ตอนใช้งานจริงจะอัปเดตค่าเสมอ
COMMENT ON COLUMN quotations.customer_details IS 'รายละเอียดลูกค้า Snapshot (reference, tax_id, customer_name, contact_name, phone, email, address, payment_terms)';
COMMENT ON COLUMN quotations.item_details IS 'รายละเอียดรายการสินค้า Snapshot (internal_reference, product_id, model, name, sales_description, price, quantity, discount_1, discount_2, remark, warranty_display, delivery_days, is_optional)';
COMMENT ON COLUMN quotations.employee_details IS 'รายละเอียดทีมขาย Snapshot (salesperson_id, saleperson, sale_phone, employee_quotations, employee_quotations_phone)';
