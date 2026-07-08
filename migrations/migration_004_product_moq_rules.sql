-- migration_004_product_moq_rules.sql

-- สร้างตารางใหม่สำหรับ MOQ รายสินค้า
CREATE TABLE IF NOT EXISTS product_moq_rules (
  product_id        INTEGER PRIMARY KEY,
  min_order_qty     INTEGER NOT NULL CHECK (min_order_qty > 0),
  sale_line_warn_msg TEXT    NOT NULL,
  is_active         BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ดร็อปฟิลด์เดิมออกจาก quotation_rules
ALTER TABLE quotation_rules
  DROP COLUMN IF EXISTS min_order_qty,
  DROP COLUMN IF EXISTS sale_line_warn_msg;
