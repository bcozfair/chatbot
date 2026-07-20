-- ─────────────────────────────────────────────────────────────────────────────
--  เงื่อนไขวันจัดส่งเมื่อสั่งจำนวนมาก (Req #1)
--
--  เพิ่ม 4 คอลัมน์ลง quotation_rules แทนการสร้างตารางแยก เพราะ scope
--  (production, brand, series) เป็นชุดเดียวกับกฏเดิมเป๊ะ และแอดมินจัดการ
--  จากหน้า "เงื่อนไขหลัก" หน้าเดียว
--
--  NULL = ไม่มี tier → ใช้ delivery_out_of_stock_days เดิม
--  แถวที่ไม่ได้กรอก (เช่น Import ทั้ง 18 ยี่ห้อ) จึงทำงานเหมือนเดิม 100%
--
--  tier มีผลเฉพาะตอน "สต็อกไม่พอ" เท่านั้น ถ้าของพอส่งยังเป็น
--  delivery_in_stock_days (3 วัน) เสมอไม่ว่าสั่งกี่ตัว
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-07-20_01_delivery_qty_tiers.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.quotation_rules
  ADD COLUMN IF NOT EXISTS delivery_days_qty_10  integer,
  ADD COLUMN IF NOT EXISTS delivery_days_qty_20  integer,
  ADD COLUMN IF NOT EXISTS delivery_days_qty_50  integer,
  ADD COLUMN IF NOT EXISTS delivery_days_qty_100 integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotation_rules_delivery_qty_days_check'
  ) THEN
    ALTER TABLE public.quotation_rules
      ADD CONSTRAINT quotation_rules_delivery_qty_days_check CHECK (
        (delivery_days_qty_10  IS NULL OR delivery_days_qty_10  >= 0) AND
        (delivery_days_qty_20  IS NULL OR delivery_days_qty_20  >= 0) AND
        (delivery_days_qty_50  IS NULL OR delivery_days_qty_50  >= 0) AND
        (delivery_days_qty_100 IS NULL OR delivery_days_qty_100 >= 0)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.quotation_rules.delivery_days_qty_10  IS 'วันจัดส่งเมื่อสั่ง >= 10 ชิ้นและสต็อกไม่พอ (NULL = ไม่ใช้ tier)';
COMMENT ON COLUMN public.quotation_rules.delivery_days_qty_20  IS 'วันจัดส่งเมื่อสั่ง >= 20 ชิ้นและสต็อกไม่พอ (NULL = ไม่ใช้ tier)';
COMMENT ON COLUMN public.quotation_rules.delivery_days_qty_50  IS 'วันจัดส่งเมื่อสั่ง >= 50 ชิ้นและสต็อกไม่พอ (NULL = ไม่ใช้ tier)';
COMMENT ON COLUMN public.quotation_rules.delivery_days_qty_100 IS 'วันจัดส่งเมื่อสั่ง >= 100 ชิ้นและสต็อกไม่พอ (NULL = ไม่ใช้ tier)';

-- ── Seed ตามตารางที่ฝ่ายขายกำหนด ────────────────────────────────────────────

-- Production 1 → 7 / 15 / 20 / 30
UPDATE public.quotation_rules
SET delivery_days_qty_10  = 7,
    delivery_days_qty_20  = 15,
    delivery_days_qty_50  = 20,
    delivery_days_qty_100 = 30,
    updated_at = CURRENT_TIMESTAMP
WHERE production = 'Production 1(PM)'
  AND brand IS NULL
  AND series IS NULL;

-- Production 3 → 20 / 30 / 45 / 60
-- ไม่มีกฏระดับ production ของ P3 มีแต่ระดับซีรีส์ จึงใส่ที่ PE กับ LM-001N
-- (ซีรีส์ที่สามคือ ECM ซึ่ง is_locked = true อยู่แล้ว เสนอราคาไม่ได้ จึงไม่ต้องมี tier)
UPDATE public.quotation_rules
SET delivery_days_qty_10  = 20,
    delivery_days_qty_20  = 30,
    delivery_days_qty_50  = 45,
    delivery_days_qty_100 = 60,
    updated_at = CURRENT_TIMESTAMP
WHERE production = 'Production 3(PM)'
  AND series IN ('PE', 'LM-001N');

-- Production 2 ยังไม่กำหนด tier (ยืนยันแล้ว) และปัจจุบัน is_locked = true อยู่
-- Import ทั้ง 18 ยี่ห้อไม่ต้องมี tier เพราะทุกช่วงจำนวนใช้ค่าเท่ากับ delivery_out_of_stock_days เดิม
