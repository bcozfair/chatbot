-- Drop the old table
DROP TABLE IF EXISTS product_stock_rules CASCADE;

-- Create the new table with internal_reference as Primary Key
CREATE TABLE product_stock_rules (
  internal_reference TEXT PRIMARY KEY,
  is_active          BOOLEAN DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
