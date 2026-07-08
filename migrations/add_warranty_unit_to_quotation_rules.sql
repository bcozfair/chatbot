ALTER TABLE quotation_rules
  ADD COLUMN IF NOT EXISTS warranty_unit VARCHAR(10) NOT NULL DEFAULT 'year'
    CHECK (warranty_unit IN ('month', 'year'));
