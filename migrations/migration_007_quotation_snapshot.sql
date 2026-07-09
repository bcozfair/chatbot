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
