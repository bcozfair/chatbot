-- ─────────────────────────────────────────────────────────────────────────────
--  เตรียม sandbox ให้ scripts/diag/searchIndexEval.ts
--  สร้างฝาแฝดของ products 2 ชุดใน schema perf_lab (ไม่แตะตารางจริงเลย)
--    p_base = index เท่าที่ prod มีวันนี้
--    p_opt  = index เดิม + expression index 4 ตัวของแผน A
--  รัน:  docker compose exec -T db psql -U postgres -d chatbot_primus \
--          -v ON_ERROR_STOP=1 -f - < scripts/diag/searchIndexEval.setup.sql
--  เสร็จแล้วเก็บกวาด:  DROP SCHEMA perf_lab CASCADE;
-- ─────────────────────────────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS perf_lab CASCADE;
CREATE SCHEMA perf_lab;

CREATE TABLE perf_lab.p_base AS SELECT * FROM public.products;
CREATE TABLE perf_lab.p_opt  AS SELECT * FROM perf_lab.p_base;  -- snapshot เดียวกันเป๊ะ

CREATE INDEX b_pk   ON perf_lab.p_base (product_template_id);
CREATE INDEX b_mtrg ON perf_lab.p_base USING gin (model gin_trgm_ops);
CREATE INDEX b_ntrg ON perf_lab.p_base USING gin (name  gin_trgm_ops);
CREATE INDEX b_sys  ON perf_lab.p_base (is_system_item) WHERE is_system_item = true;

CREATE INDEX o_pk   ON perf_lab.p_opt (product_template_id);
CREATE INDEX o_mtrg ON perf_lab.p_opt USING gin (model gin_trgm_ops);
CREATE INDEX o_ntrg ON perf_lab.p_opt USING gin (name  gin_trgm_ops);
CREATE INDEX o_sys  ON perf_lab.p_opt (is_system_item) WHERE is_system_item = true;

-- ★ แผน A — string literal ต้องตรงกับ SQL ใน productService.ts ทุกตัวอักษร
--   ไม่งั้น planner จับคู่ expression ไม่ได้ แล้วกลับไป Seq Scan เหมือนเดิม
CREATE INDEX o_model_norm ON perf_lab.p_opt
  ( LOWER(REGEXP_REPLACE(COALESCE(model, ''), '[\s,\(\)]', '', 'g')) );
CREATE INDEX o_name_norm ON perf_lab.p_opt
  ( LOWER(REGEXP_REPLACE(COALESCE(name,  ''), '[\s,\(\)]', '', 'g')) );
CREATE INDEX o_model_norm_trgm ON perf_lab.p_opt
  USING gin ( (LOWER(REGEXP_REPLACE(COALESCE(model, ''), '[\s,\(\)]', '', 'g'))) gin_trgm_ops );
CREATE INDEX o_name_norm_trgm ON perf_lab.p_opt
  USING gin ( (LOWER(REGEXP_REPLACE(COALESCE(name,  ''), '[\s,\(\)]', '', 'g'))) gin_trgm_ops );

ANALYZE perf_lab.p_base;
ANALYZE perf_lab.p_opt;

SELECT (SELECT count(*) FROM perf_lab.p_base) AS base_rows,
       (SELECT count(*) FROM perf_lab.p_opt)  AS opt_rows,
       (SELECT count(*) FROM perf_lab.p_base b
          FULL JOIN perf_lab.p_opt o USING (product_template_id)
        WHERE b.model IS DISTINCT FROM o.model
           OR b.name  IS DISTINCT FROM o.name
           OR b.quantity_on_hand_unreserved IS DISTINCT FROM o.quantity_on_hand_unreserved) AS twin_diff;
