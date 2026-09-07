-- ─────────────────────────────────────────────────────────────────────────────
--  เฟส 3 ของแผน docs/plan-product-block-rules.md §4.4 — ปิดกฎ MOQ ปลอม 4 แถว
--
--  4 แถวนี้ไม่ใช่กฎ MOQ จริง แอดมินตั้ง min_order_qty เป็น 9999/99999 เพื่อ "บล็อก"
--  สินค้า 4 ตัวในซีรีส์ Import(PM) > COMMONWEALTH > FP-108 (ซีรีส์นั้นมี 24 ตัว)
--  เพราะระบบเดิมบล็อกได้แค่ระดับ series ตอนนี้ย้ายไปเป็นกฎระดับ ref ใน
--  product_block_rules แล้ว (migration 2026-09-07_02) จึงไม่ต้องใช้ workaround อีก
--
--  ทำไมต้องปิด: ถ้าปล่อยไว้ เซลล์จะโดน 2 ข้อความพร้อมกันสำหรับสินค้าตัวเดียว
--    ❌ ระงับการเสนอราคา รายการ ... (จริง)
--    ⬇️ จำนวนไม่ถึงขั้นต่ำ รายการ ... (ไม่จริง — สินค้าไม่ได้ห้ามขายเพราะจำนวน)
--
--  ⚠️ ⚠️ ห้ามรันไฟล์นี้ก่อนโค้ดเฟส 3 ขึ้น production ⚠️ ⚠️
--     ก่อนเฟส 3 ยังไม่มีใครอ่าน product_block_rules ถ้าปิด MOQ ตอนนั้น
--     สินค้า 4 ตัวนี้จะ "ขายได้" ในช่วงคาบเกี่ยว
--     ตรวจก่อนรัน: ยิง GET /api/products/FP-108-1%20220%20V.U1BW/blocked ต้องได้ blocked:true
--
--  ไม่ลบแถวทิ้ง เพื่อให้ย้อนได้ด้วยคำสั่งเดียวและเก็บ min_order_qty เดิมไว้เป็นหลักฐาน
--  rollback: UPDATE public.product_moq_rules SET is_active = true
--             WHERE internal_reference IN (...รายการเดียวกันข้างล่าง...);
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-09-07_03_retire_fake_moq_blocks.sql
--  idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ด่าน: ต้องมีกฎบล็อกระดับ ref ครบทั้ง 4 ก่อน ไม่งั้นปิด MOQ แล้วสินค้าหลุดขายได้
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.product_block_rules
   WHERE is_active = true
     AND internal_reference IN
         ('FAFC4FP1080001', 'FAFC4FP1080003', 'FAFC4FP1080009', 'FAFC4FP1080016');
  IF n <> 4 THEN
    RAISE EXCEPTION 'มีกฎบล็อกระดับ ref แค่ % แถว (ต้องได้ 4) — ยังปิด MOQ ปลอมไม่ได้ สินค้าจะหลุดขายได้', n;
  END IF;
END $$;

UPDATE public.product_moq_rules
   SET is_active = false, updated_at = now()
 WHERE internal_reference IN
       ('FAFC4FP1080001', 'FAFC4FP1080003', 'FAFC4FP1080009', 'FAFC4FP1080016')
   AND is_active IS DISTINCT FROM false;

COMMIT;
