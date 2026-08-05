-- ทำให้ GET /api/products/search ใช้ index ได้ครบทุก branch ของ WHERE ... OR ...
--
-- ปัญหา: WHERE เป็น OR คร่อม 5 branch แต่มี trgm index แค่ 2 ตัว (model, name)
-- Postgres ทำ BitmapOr ได้ก็ต่อเมื่อ *ทุก* branch indexable ไม่งั้นตกไป Seq Scan ทั้งชุด
-- วัดจริง: Seq Scan 199-322 ms/คำค้น × pool 40 connection บนเครื่อง 4 cores
--          → DB CPU ตัน → connectionTimeoutMillis 5000 หมดเวลา → HTTP 500 (26% ที่ concurrency 100)
--
-- ⚠️ ห้ามรันไฟล์นี้ผ่าน scripts/runMigration.ts — CREATE INDEX CONCURRENTLY อยู่ใน
--    transaction ไม่ได้ และ runMigration ส่งทั้งไฟล์เข้า client.query() ครั้งเดียว
--    ซึ่ง pg จะห่อเป็น implicit transaction เมื่อมีหลาย statement
--    ให้รันผ่าน psql ทีละคำสั่งแทน:
--      docker compose exec -T db psql -U postgres -d chatbot_primus \
--        -f /path/2026-08-05_05_products_search_indexes.sql
--    (psql ส่งทีละ statement จึงใช้ CONCURRENTLY ได้)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2 branch ที่ยังไม่มี trgm index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_ref_trgm
  ON products USING gin (internal_reference gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_brand_trgm
  ON products USING gin (brand gin_trgm_ops);

-- branch ที่ 5: p.product_template_id::text = $2 เป็น expression — btree บน
-- คอลัมน์ดิบ (products_pkey) ใช้ไม่ได้ ถ้าขาดตัวนี้ BitmapOr พังทั้งชุดแล้วกลับไป Seq Scan
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_template_id_text
  ON products ((product_template_id::text));
