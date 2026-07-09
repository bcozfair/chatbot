-- SQL Migration: ลบ column comment ของตาราง quotations เพื่อให้ pgAdmin แสดงเฉพาะชื่อคอลัมน์
-- วันที่สร้าง: 2026-07-09

COMMENT ON COLUMN quotations.customer_details IS NULL;
COMMENT ON COLUMN quotations.item_details IS NULL;
COMMENT ON COLUMN quotations.employee_details IS NULL;
COMMENT ON COLUMN quotations.customer_id IS NULL;
COMMENT ON COLUMN quotations.contact_id IS NULL;
