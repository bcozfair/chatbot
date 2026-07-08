-- Create a temp table to backup existing rules with internal_reference
CREATE TEMP TABLE temp_moq_rules AS
SELECT p.internal_reference, pmr.min_order_qty, pmr.sale_line_warn_msg, pmr.is_active, pmr.created_at, pmr.updated_at
FROM product_moq_rules pmr
JOIN products p ON pmr.product_id = p.product_template_id
WHERE p.internal_reference IS NOT NULL AND p.internal_reference != '';

-- Drop the old table
DROP TABLE IF EXISTS product_moq_rules CASCADE;

-- Create the new table
CREATE TABLE product_moq_rules (
  internal_reference TEXT PRIMARY KEY,
  min_order_qty      INTEGER NOT NULL CHECK (min_order_qty > 0),
  sale_line_warn_msg TEXT    NOT NULL,
  is_active          BOOLEAN DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Restore data from temp table
INSERT INTO product_moq_rules (internal_reference, min_order_qty, sale_line_warn_msg, is_active, created_at, updated_at)
SELECT internal_reference, min_order_qty, sale_line_warn_msg, is_active, created_at, updated_at
FROM temp_moq_rules
ON CONFLICT (internal_reference) DO NOTHING;

-- Drop temp table
DROP TABLE IF EXISTS temp_moq_rules;
