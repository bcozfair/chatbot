-- ─────────────────────────────────────────────────────────────────────────────
--  ให้เซลล์เลือก "ประเภทการจัดส่ง" เองได้ครบ 4 แบบ + ตรึงกำหนดส่งไว้ตอนยืนยันใบ
--
--  เดิมประเภทการส่งถูกตัดสินจากสต๊อกล้วน ๆ จึงมีได้แค่ 2 แบบ (In_stock. / Make to order.)
--  แต่ dropdown ฝั่ง Odoo มี 4 แบบ (เพิ่ม Import. / Install.) เซลล์เลือกเองไม่ได้เลย
--
--  delivery_type_override
--    NULL   = ใช้ค่าอัตโนมัติตามสต๊อก (พฤติกรรมเดิม 100% — ใบเก่าทุกใบเป็น NULL)
--    ค่าคีย์ = ประเภทที่เซลล์เลือกเอง ยึดค่านี้ต่อไปแม้จะเพิ่ม/ลบสินค้าหรือแก้จำนวน
--             จนกว่าจะกดรีเซ็ตกลับเป็นค่าอัตโนมัติ (ส่ง null กลับมา)
--    กติกาเดียวกับ delivery_days_override ที่มีอยู่แล้ว (2026-07-21_01)
--
--  delivery_terms
--    ภาพนิ่งของ "กำหนดส่งทั้งใบ" ที่ตรึงไว้ตอน confirmQuotationAtomic ประทับเลขที่ใบ
--    { type, days, all_in_stock, type_source, days_source }
--
--    ต้องตรึงเพราะประเภทอัตโนมัติคำนวณจาก "สต๊อก ณ ตอนออกใบ" ซึ่ง item_details ไม่ได้เก็บไว้
--    ถ้าไม่ตรึง ไฟล์ export ที่กดทีหลังจะได้ค่าคนละตัวกับ PDF ที่ลูกค้าถืออยู่
--
--    NULL = ใบเก่าก่อน deploy หรือใบที่ยังไม่ยืนยัน — ตั้งใจไม่ backfill ย้อนหลัง เพราะ
--    ข้อมูลสต๊อกวันออกใบไม่มีอยู่จริงแล้ว การเดาด้วยสต๊อกวันนี้ทำให้ทั้งประเภทและจำนวนวันผิด
--    (วัดจากใบที่รอ export จริง: ไม่มีใบไหนเลยที่ in_stock_days = out_of_stock_days)
--    ใบเหล่านี้จะได้ช่อง delivery_name/delivery_time ว่างในไฟล์ ให้แอดมินกรอกใน Odoo เอง
--
--  เป็น jsonb ไม่ใช่คอลัมน์แยก เพราะเป็นก้อนเดียวที่อ่าน/เขียนพร้อมกันเสมอ และ requirement
--  ฝั่งกำหนดส่งเปลี่ยนบ่อย (เพิ่มประเภท/เพิ่มหมายเหตุ) — เพิ่ม key ใหม่ได้โดยไม่ต้อง migrate
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-08-20_01_quotation_delivery_type.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS delivery_type_override text;

ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS delivery_terms jsonb;

-- คีย์ต้องตรงกับ DELIVERY_TYPES ใน utils/deliveryTerms.ts — เพิ่มประเภทใหม่ต้องแก้ทั้งสองที่
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotations_delivery_type_override_check'
  ) THEN
    ALTER TABLE public.quotations
      ADD CONSTRAINT quotations_delivery_type_override_check CHECK (
        delivery_type_override IS NULL
        OR delivery_type_override IN ('in_stock', 'make_to_order', 'import', 'install')
      );
  END IF;
END $$;
