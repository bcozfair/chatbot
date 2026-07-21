-- ─────────────────────────────────────────────────────────────────────────────
--  ให้เซลล์แก้ "จำนวนวันจัดส่ง" ของใบเสนอราคาเองได้
--
--  เดิมวันจัดส่งคำนวณจาก quotation_rules ล้วน ๆ (in_stock / out_of_stock + tier
--  ตามจำนวน) แล้ว pdfGenerator เอาค่ามากสุดของทุกรายการมาพิมพ์ลงช่อง
--  Delivery Time — เซลล์แก้ไม่ได้เลยแม้จะรู้ว่าเคสนี้ส่งได้เร็ว/ช้ากว่ากฏ
--
--  NULL = ใช้ค่าที่ระบบคำนวณ (พฤติกรรมเดิม 100% — ใบเก่าทุกใบเป็น NULL)
--  ตัวเลข = ค่าที่เซลล์ตั้งเอง ยึดค่านี้ต่อไปแม้จะเพิ่ม/ลบสินค้าหรือแก้จำนวน
--          จนกว่าจะกดรีเซ็ตกลับเป็นค่าอัตโนมัติ (ส่ง null กลับมา)
--
--  เก็บเป็นคอลัมน์ ไม่ใช่ยัดลง customer_details jsonb เพราะเป็นข้อเท็จจริงของ
--  "ใบ" ไม่ใช่ของลูกค้า และ customer_details ถูกสร้างใหม่ทุกครั้งที่ PUT
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-07-21_01_quotation_delivery_days_override.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS delivery_days_override integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotations_delivery_days_override_check'
  ) THEN
    ALTER TABLE public.quotations
      ADD CONSTRAINT quotations_delivery_days_override_check CHECK (
        delivery_days_override IS NULL
        OR (delivery_days_override >= 0 AND delivery_days_override <= 3650)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.quotations.delivery_days_override IS
  'จำนวนวันจัดส่งที่เซลล์แก้เองจากหน้า LIFF (NULL = ใช้ค่าที่คำนวณจาก quotation_rules)';
