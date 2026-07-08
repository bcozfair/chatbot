CREATE TABLE IF NOT EXISTS product_optional_links (
  id                  SERIAL PRIMARY KEY,
  trigger_product_id  INTEGER NOT NULL,
  optional_product_id INTEGER NOT NULL,
  is_active           BOOLEAN DEFAULT true,
  note                TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(trigger_product_id, optional_product_id)
);

CREATE INDEX IF NOT EXISTS idx_optional_links_trigger 
  ON product_optional_links(trigger_product_id);
