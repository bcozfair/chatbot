CREATE TABLE IF NOT EXISTS product_stock_rules (
  product_id        INTEGER PRIMARY KEY,  -- product_template_id
  no_stock_warn_msg TEXT    NOT NULL,
  is_active         BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
