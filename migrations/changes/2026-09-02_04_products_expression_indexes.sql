-- ทำให้ findProduct() ทุก stage ใช้ index ได้ แทนที่จะ Seq Scan ทั้งตารางทุกครั้ง (แผน A)
--
-- ปัญหา: SQL ใน services/productService.ts ค้นบน "ค่าที่ normalize แล้ว" ไม่ใช่คอลัมน์ดิบ
--          LOWER(REGEXP_REPLACE(COALESCE(model, ''), '[\s,\(\)]', '', 'g'))
--        index บน model/name ตรง ๆ (idx ที่มีอยู่) ใช้กับ expression นี้ไม่ได้เลย
--        ⇒ stage 1 / 1.3 / 1.5 / 1.7 / 2 ทุกตัวตกไป Seq Scan บน 51,456 แถว
--
-- วัดจริงบนฝาแฝดใน schema perf_lab (scripts/diag/searchIndexEval.ts):
--   ดูตัวเลขที่ได้จริงในหัวข้อ "ขั้น 4.8" ของ DEPLOY.md
--
-- ⚠️ index ต้องเขียน expression ให้ "ตรงกับ SQL ในโค้ด" — ถ้า expression ไม่ตรง planner
--    จับคู่ไม่ได้แล้วกลับไป Seq Scan เงียบ ๆ โดยไม่มี error ให้เห็น
--    (ช่องว่างไม่สำคัญ เพราะ Postgres เทียบที่ parse tree ไม่ใช่ตัวอักษร แต่ตัว regex,
--     ลำดับ argument และ COALESCE ต้องเหมือนกันทุกตัว)
--
-- ⚠️ ห้ามรันไฟล์นี้ผ่าน scripts/runMigration.ts — CREATE INDEX CONCURRENTLY อยู่ใน
--    transaction ไม่ได้ และ runMigration ส่งทั้งไฟล์เข้า client.query() ครั้งเดียว
--    ซึ่ง pg จะห่อเป็น implicit transaction เมื่อมีหลาย statement
--    ให้รันผ่าน psql แทน (psql ส่งทีละ statement):
--      docker compose exec -T db psql -U postgres -d chatbot_primus \
--        -f - < migrations/changes/2026-09-02_04_products_expression_indexes.sql
--
--    ตรวจว่าสร้างครบและใช้ได้จริง (ต้องได้ 4 แถว indisvalid = t ทุกแถว):
--      SELECT indexrelid::regclass AS idx, indisvalid, indisready
--      FROM pg_index WHERE indrelid = 'public.products'::regclass
--        AND indexrelid::regclass::text LIKE '%_norm%';
--
--    ถ้าค้างระหว่างทางจน index เป็น invalid ให้ DROP แล้วสร้างใหม่:
--      DROP INDEX CONCURRENTLY IF EXISTS <ชื่อ>;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── btree: stage 1 (exact) — norm_model = $1 OR norm_name = $1 ────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_model_norm
  ON public.products ( LOWER(REGEXP_REPLACE(COALESCE(model, ''), '[\s,\(\)]', '', 'g')) );

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_name_norm
  ON public.products ( LOWER(REGEXP_REPLACE(COALESCE(name,  ''), '[\s,\(\)]', '', 'g')) );

-- ── gin_trgm: stage 1.5 / 1.7 (LIKE '%...%') และ stage 2 (operator %) ─────────
--    LIKE ที่ขึ้นต้นด้วย % ใช้ btree ไม่ได้ ต้องเป็น trigram เท่านั้น
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_model_norm_trgm
  ON public.products USING gin
     ( (LOWER(REGEXP_REPLACE(COALESCE(model, ''), '[\s,\(\)]', '', 'g'))) gin_trgm_ops );

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_name_norm_trgm
  ON public.products USING gin
     ( (LOWER(REGEXP_REPLACE(COALESCE(name,  ''), '[\s,\(\)]', '', 'g'))) gin_trgm_ops );

ANALYZE public.products;
