-- ─────────────────────────────────────────────────────────────────────────────
--  เฟส 5 ของแผน docs/plan-product-block-rules.md §6 — ลบคอลัมน์ quotation_rules.is_locked
--
--  การบล็อกสินค้าย้ายไป product_block_rules ครบตั้งแต่เฟส 3 (migration 2026-09-07_02)
--  คอลัมน์นี้ถูกคงไว้ตลอดเฟส 2-4 เพื่อให้ rollback ได้ด้วยการ revert โค้ดอย่างเดียว
--  และเพื่อให้ diag:block-parity เทียบของเก่ากับของใหม่ได้ระหว่าง soak
--
--  ⚠️ ⚠️ ห้ามรันไฟล์นี้ก่อนโค้ดเฟส 5 ก้อนที่ 1 ขึ้น production ⚠️ ⚠️
--     โค้ดที่รันอยู่ก่อนหน้านั้นยัง INSERT/UPDATE คอลัมน์นี้ในหน้า "เงื่อนไขใบเสนอราคา"
--     ถ้า drop ก่อน แอดมินกดบันทึกกฎจะได้ 500 ทันที
--     ตรวจก่อนรัน: `grep -rn "is_locked" --include=*.ts --include=*.tsx .` ต้องเหลือแต่คอมเมนต์
--
--  ⚠️ migration นี้ย้อนไม่ได้ด้วยตัวเอง (drop คอลัมน์ = ข้อมูลหาย) — ต้อง dump ก่อนรันเสมอ
--  rollback:
--     ALTER TABLE public.quotation_rules ADD COLUMN is_locked boolean DEFAULT false NOT NULL;
--     UPDATE public.quotation_rules SET is_locked = true WHERE id IN (2, 23, 24, 26);
--     (4 id นี้คือแถวที่ is_locked = true ณ วันรัน — ค่าเดียวกับ LEGACY_LOCKED_SCOPES
--      ใน scripts/diag/blockParity.ts) แล้ว revert โค้ดเฟส 5 ทั้งสองก้อน
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
DECLARE
  has_col boolean;
  n       integer;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'quotation_rules' AND column_name = 'is_locked'
  ) INTO has_col;

  IF NOT has_col THEN
    RAISE NOTICE 'quotation_rules.is_locked ถูกลบไปแล้ว — ข้ามการตรวจ';
    RETURN;
  END IF;

  -- ด่าน 1: ต้องมีกฎบล็อกที่เปิดใช้อยู่จริง
  -- ถ้าตารางใหม่ว่าง แปลว่าไม่มีอะไรบล็อกสินค้าเลย การลบคอลัมน์นี้ = ปลดล็อกทั้งคลังเงียบ ๆ
  SELECT count(*) INTO n FROM public.product_block_rules WHERE is_active = true;
  IF n = 0 THEN
    RAISE EXCEPTION 'product_block_rules ไม่มีกฎที่เปิดใช้เลย — ลบ is_locked ตอนนี้ = ไม่มีอะไรบล็อกสินค้า';
  END IF;

  -- ด่าน 2: ทุกแถวที่ยัง is_locked = true ต้องมีคู่ของมันในตารางใหม่ (scope ตรงกันเป๊ะ)
  -- ถามแบบ NOT EXISTS ทีละแถว ไม่ใช่นับหัวเทียบกัน — หลังเฟส 4 แอดมินเพิ่มกฎใหม่ได้
  -- จำนวนสองตารางจึงไม่เท่ากันเป็นเรื่องปกติ แต่ "แถวเดิมต้องไม่หาย" ต้องจริงเสมอ
  SELECT count(*) INTO n
    FROM public.quotation_rules q
   WHERE q.is_locked = true
     AND NOT EXISTS (
       SELECT 1 FROM public.product_block_rules b
        WHERE b.is_active = true
          AND b.model IS NULL AND b.internal_reference IS NULL
          AND coalesce(b.production, '') = coalesce(q.production, '')
          AND coalesce(b.brand, '')      = coalesce(q.brand, '')
          AND coalesce(b.series, '')     = coalesce(q.series, '')
     );
  IF n > 0 THEN
    RAISE EXCEPTION 'กฎ is_locked % แถวยังไม่มีคู่ใน product_block_rules — ลบตอนนี้สินค้าชุดนั้นจะหลุด', n;
  END IF;
END $$;

ALTER TABLE public.quotation_rules DROP COLUMN IF EXISTS is_locked;

COMMIT;
