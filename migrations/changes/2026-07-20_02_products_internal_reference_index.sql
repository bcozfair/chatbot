-- ─────────────────────────────────────────────────────────────────────────────
--  Index บน products.internal_reference
--
--  internal_reference เป็น key ที่ใช้ join จริงหลายที่ แต่ไม่เคยมี index เลย:
--    - GET  /api/admin/stock-rules            (join product_stock_rules → products)
--    - GET  /api/products/search              (join product_stock_rules)
--    - POST /api/admin/stock-rules            (ขยายทั้งสายการผลิตเป็นรายสินค้า)
--    - services/productService.ts             (เช็คสินค้าถูกระงับตอนออกใบเสนอราคา)
--
--  ตอนกฎมีแค่หลักร้อยยังไม่รู้สึก พอตั้งกฎยกทั้งสายการผลิต (หลักพัน-หลักหมื่น)
--  ทุก query ข้างบนกลายเป็น seq scan บน products 50,764 แถว
--
--  ตรวจแล้วว่า internal_reference ไม่ซ้ำเลยในข้อมูลจริง (0 ค่าซ้ำ) จึงใช้
--  UNIQUE index ได้ ซึ่งนอกจากเร็วแล้วยังกันข้อมูล sync เข้ามาซ้ำในอนาคตด้วย
--  (product_stock_rules.internal_reference เป็น PK อยู่แล้ว จึงต้องเป็น 1:1)
--
--  NULL ไม่ถูกนับเป็นค่าซ้ำใน Postgres สินค้าที่ไม่มีรหัสอ้างอิงจึงไม่กระทบ
--  แต่ค่าว่าง '' ถือเป็นค่าปกติ จึงกรองออกด้วย partial index
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-07-20_02_products_internal_reference_index.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

-- กันพลาด: ถ้าวันหนึ่งข้อมูลมี internal_reference ซ้ำจริง ให้ล้มพร้อมบอกเหตุผล
-- แทนที่จะปล่อยให้ CREATE UNIQUE INDEX แจ้ง error ที่อ่านไม่รู้เรื่อง
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT internal_reference
    FROM public.products
    WHERE internal_reference IS NOT NULL AND TRIM(internal_reference) <> ''
    GROUP BY internal_reference
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'พบ internal_reference ซ้ำ % ค่าใน products — ต้องแก้ข้อมูลก่อนสร้าง unique index (ดูด้วย: SELECT internal_reference, COUNT(*) FROM products WHERE internal_reference IS NOT NULL AND TRIM(internal_reference) <> '''' GROUP BY 1 HAVING COUNT(*) > 1)',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_internal_reference
  ON public.products (internal_reference)
  WHERE internal_reference IS NOT NULL AND TRIM(internal_reference) <> '';

COMMENT ON INDEX public.idx_products_internal_reference IS
  'ใช้ join กับ product_stock_rules / product_moq_rules — unique เพราะเป็น key 1:1 กับสินค้า';
