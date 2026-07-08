-- SQL Migration: เพิ่ม customer_id และ contact_id ในตาราง quotations
-- วันที่สร้าง: 2026-07-02

ALTER TABLE quotations
ADD COLUMN IF NOT EXISTS customer_id integer,
ADD COLUMN IF NOT EXISTS contact_id integer;

COMMENT ON COLUMN quotations.customer_id IS 'ID อ้างอิง Odoo Company/Customer ID จาก customers_view';
COMMENT ON COLUMN quotations.contact_id IS 'ID อ้างอิง Odoo Contact ID จาก contacts_view';
