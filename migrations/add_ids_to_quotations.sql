-- SQL Migration: เพิ่ม customer_id และ contact_id ในตาราง quotations
-- วันที่สร้าง: 2026-07-02

ALTER TABLE quotations
ADD COLUMN IF NOT EXISTS customer_id integer,
ADD COLUMN IF NOT EXISTS contact_id integer;
