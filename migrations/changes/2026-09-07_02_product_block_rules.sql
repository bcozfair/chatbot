-- ─────────────────────────────────────────────────────────────────────────────
--  เฟส 2 ของแผน docs/plan-product-block-rules.md — ตารางกฎบล็อกสินค้า 5 ระดับ
--
--  ของเดิมบล็อกได้แค่ production > brand > series (สวิตช์ is_locked บน quotation_rules)
--  ตารางนี้เพิ่ม model กับ internal_reference เข้ามา ให้ระดับเท่ากับกฎ MOQ
--
--  ⚠️ เฟสนี้ยังไม่มีใครอ่านตารางนี้ — โค้ดยังใช้ quotation_rules.is_locked เหมือนเดิม
--     ตารางถูกเติมข้อมูลไว้ล่วงหน้าเฉย ๆ เพื่อให้เฟส 3 สลับตัวอ่านได้โดยไม่มีช่วงที่กฎหาย
--     is_locked ยังอยู่ตลอดเฟส 2-4 (rollback = revert โค้ดอย่างเดียว ไม่ต้องแตะ DB)
--     จะลบตอนเฟส 5
--
--  ⚠️ ห้ามรัน migration ปิด MOQ ปลอม (2026-XX-XX retire_fake_moq_blocks) พร้อมไฟล์นี้
--     เฟส 2 ยังไม่มีใครอ่านตารางใหม่ ถ้าปิด MOQ ตอนนี้สินค้า 4 ตัวนั้นจะขายได้ทันที
--     ดู §4.4 ของแผน
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-09-07_02_product_block_rules.sql
--  idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.product_block_rules (
    id                 serial PRIMARY KEY,
    production         text,
    brand              text,
    series             text,
    model              text,
    internal_reference text,
    warn_msg           text NOT NULL,
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    -- กันแถวว่างทั้งแถว ซึ่งจะกลายเป็นกฎ wildcard ที่บล็อกสินค้าทั้งคลัง
    --
    -- ⚠️ ต้องใช้ NULLIF(btrim(...),'') ไม่ใช่ IS NOT NULL เฉย ๆ
    -- engine ฝั่ง TS ตัดสิน wildcard ด้วย truthy (`if (rule.production)`) แปลว่า '' = wildcard เท่ากับ NULL
    -- ถ้า CHECK ดูแค่ IS NOT NULL แถวที่ทุกช่องเป็น '' จะผ่าน constraint แล้วบล็อกทั้งระบบ
    CONSTRAINT product_block_rules_scope_not_empty CHECK (
        NULLIF(btrim(production), '')         IS NOT NULL
     OR NULLIF(btrim(brand), '')              IS NOT NULL
     OR NULLIF(btrim(series), '')             IS NOT NULL
     OR NULLIF(btrim(model), '')              IS NOT NULL
     OR NULLIF(btrim(internal_reference), '') IS NOT NULL
    ),

    -- NOT NULL อย่างเดียวไม่พอ — '' หรือ '   ' ผ่าน NOT NULL ได้ แล้วเซลล์จะเห็นข้อความว่างเปล่า
    -- (บังคับกรอกเหมือน sale_line_warn_msg ของ product_moq_rules)
    CONSTRAINT product_block_rules_warn_msg_not_blank CHECK (btrim(warn_msg) <> '')
);

-- กฎซ้ำ scope เดียวกันไม่มีประโยชน์ และทำให้ผลลัพธ์ขึ้นกับ id
-- lower(btrim(...)) เพราะ engine เทียบแบบ trim + lowercase — 'ACME' กับ 'acme ' คือกฎเดียวกัน
-- ถ้าใช้ COALESCE เฉย ๆ จะสร้างกฎซ้ำที่ระบบมองว่าเหมือนกันได้ แล้วผลลัพธ์ไปขึ้นกับ id
CREATE UNIQUE INDEX IF NOT EXISTS product_block_rules_scope_uniq
    ON public.product_block_rules (
        lower(btrim(COALESCE(production, ''))),
        lower(btrim(COALESCE(brand, ''))),
        lower(btrim(COALESCE(series, ''))),
        lower(btrim(COALESCE(model, ''))),
        lower(btrim(COALESCE(internal_reference, '')))
    );

-- ── ด่านก่อนย้าย: ถ้ามีแถว is_locked ที่ scope ว่างทั้งหมด = บล็อกทั้งคลัง ──
-- ต้องหยุดให้คนมาดู ไม่ใช่ย้ายตามเงียบ ๆ
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.quotation_rules
   WHERE is_locked = true
     AND NULLIF(btrim(production), '') IS NULL
     AND NULLIF(btrim(brand), '')      IS NULL
     AND NULLIF(btrim(series), '')     IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'พบกฎ is_locked ที่ scope ว่างทั้งแถว % แถว — ต้องตัดสินใจก่อนย้าย', n;
  END IF;
END $$;

-- ── ย้ายกฎบล็อกเดิมพร้อมข้อความ ──────────────────────────────────────────────
-- quotation_rules ไม่มีคอลัมน์เก็บข้อความเลย ข้อความจึงต้องเขียนที่นี่
-- warn_msg ต่อ scope อยู่ใน VALUES ให้เห็นชัดตอน review — ไม่ใช่ค่า default ลอย ๆ
--
-- ⚠️ ข้อความ 4 อันนี้เขียนจาก scope ของกฎ ไม่ใช่เหตุผลทางธุรกิจจริง
--    ให้ฝ่ายขายอ่านแล้วแก้ก่อนขึ้นเฟส 3 (แก้ที่นี่ก่อนรัน หรือแก้ผ่านหน้าแอดมินในเฟส 4)
--
-- NULLIF(btrim(..)) ตอน SELECT ด้วย เพื่อไม่ให้ '' หรือ '  ' หลุดเข้าตารางใหม่
-- ON CONFLICT DO NOTHING เพื่อให้รันซ้ำได้ — ไม่ทับข้อความที่แอดมินแก้ไปแล้ว
INSERT INTO public.product_block_rules (production, brand, series, warn_msg)
SELECT NULLIF(btrim(r.production), ''),
       NULLIF(btrim(r.brand), ''),
       NULLIF(btrim(r.series), ''),
       w.warn_msg
  FROM public.quotation_rules r
  JOIN (VALUES
    ('production 2(pm)', '', '',
     'สินค้ากลุ่มผลิต Production 2 ไม่เปิดให้เสนอราคาผ่านระบบ กรุณาติดต่อแอดมินเพื่อขอราคาเป็นรายกรณี'),
    ('production 3(pm)', '', 'ecm',
     'สินค้าซีรีส์ ECM ไม่เปิดให้เสนอราคาผ่านระบบ กรุณาติดต่อแอดมินเพื่อขอราคาเป็นรายกรณี'),
    ('buy to sell', '', '',
     'สินค้ากลุ่ม Buy to Sell ต้องเช็คราคาและระยะเวลาสั่งซื้อกับแอดมินก่อนทุกครั้ง'),
    ('buy to sell(tht)', '', '',
     'สินค้ากลุ่ม Buy to Sell (THT) ต้องเช็คราคาและระยะเวลาสั่งซื้อกับแอดมินก่อนทุกครั้ง')
  ) AS w(production, brand, series, warn_msg)
    ON lower(btrim(coalesce(r.production, ''))) = w.production
   AND lower(btrim(coalesce(r.brand, '')))      = w.brand
   AND lower(btrim(coalesce(r.series, '')))     = w.series
 WHERE r.is_locked = true
ON CONFLICT DO NOTHING;

-- ── กฎระดับ ref ที่แอดมินทำ workaround ไว้ในตาราง MOQ ────────────────────────
-- 4 แถวนี้ตั้ง min_order_qty 9999/99999 เพื่อ "บล็อก" เพราะระบบเดิมบล็อกได้แค่ระดับ series
-- ทั้ง 4 อยู่ใน Import(PM) > COMMONWEALTH > FP-108 ซึ่งมีสินค้า 24 ตัว — บล็อกทั้งซีรีส์ไม่ได้
-- ข้อความที่แอดมินเขียนเองอยู่แล้ว ยกมาใช้เป็น warn_msg ตรง ๆ (ดู §3.2 ของแผน)
--
-- ⚠️ แถวใน product_moq_rules ยัง active อยู่ในเฟสนี้ — ปิดตอนเฟส 3 เท่านั้น (§4.4)
INSERT INTO public.product_block_rules (internal_reference, warn_msg)
SELECT m.internal_reference, btrim(m.sale_line_warn_msg)
  FROM public.product_moq_rules m
 WHERE m.internal_reference IN
       ('FAFC4FP1080001', 'FAFC4FP1080003', 'FAFC4FP1080009', 'FAFC4FP1080016')
   AND btrim(m.sale_line_warn_msg) <> ''
ON CONFLICT DO NOTHING;

-- ── ด่านสุดท้าย: ต้องย้ายครบ ไม่มีแถวไหนหล่น ────────────────────────────────
-- เช็คแบบ "มีอยู่จริงไหม" ไม่ใช่นับจำนวนแถวรวม — เพราะหลังเฟส 4 แอดมินเพิ่มกฎเองได้
-- ถ้านับรวมแล้วเทียบเลข การรันซ้ำหลังจากนั้นจะ error ทั้งที่ข้อมูลถูกต้อง
DO $$
DECLARE n_missing int; n_refs int; n_extra int;
BEGIN
  -- ทุกกฎ is_locked ต้องมีคู่ของมันในตารางใหม่ (ถ้าไม่มี = ลืมเขียน warn_msg ใน VALUES)
  SELECT count(*) INTO n_missing
    FROM public.quotation_rules r
   WHERE r.is_locked = true
     AND NOT EXISTS (
       SELECT 1 FROM public.product_block_rules b
        WHERE lower(btrim(coalesce(b.production, ''))) = lower(btrim(coalesce(r.production, '')))
          AND lower(btrim(coalesce(b.brand, '')))      = lower(btrim(coalesce(r.brand, '')))
          AND lower(btrim(coalesce(b.series, '')))     = lower(btrim(coalesce(r.series, '')))
          AND coalesce(b.model, '')              = ''
          AND coalesce(b.internal_reference, '') = ''
     );
  IF n_missing > 0 THEN
    RAISE EXCEPTION 'กฎ is_locked % แถวยังไม่มีคู่ในตารางใหม่ — ต้องเพิ่ม warn_msg ของ scope นั้นใน VALUES',
      n_missing;
  END IF;

  -- กันเคส sale_line_warn_msg ว่าง แล้วแถวถูกกรองทิ้งเงียบ ๆ
  SELECT count(*) INTO n_refs FROM public.product_block_rules
   WHERE internal_reference IN
         ('FAFC4FP1080001', 'FAFC4FP1080003', 'FAFC4FP1080009', 'FAFC4FP1080016');
  IF n_refs <> 4 THEN
    RAISE EXCEPTION 'กฎระดับ ref ที่ย้ายมาจาก MOQ ได้ % แถว (ต้องได้ 4) — เช็ค sale_line_warn_msg ว่างหรือ ref หาย', n_refs;
  END IF;

  -- มี MOQ ที่ทำหน้าที่บล็อกเพิ่มมาอีกหลังจากเขียนแผนนี้ไหม
  SELECT count(*) INTO n_extra FROM public.product_moq_rules
   WHERE min_order_qty >= 9999
     AND internal_reference NOT IN
         ('FAFC4FP1080001', 'FAFC4FP1080003', 'FAFC4FP1080009', 'FAFC4FP1080016');
  IF n_extra > 0 THEN
    RAISE EXCEPTION 'พบกฎ MOQ ที่ใช้บล็อกเพิ่มมาอีก % แถว — ต้องเพิ่มเข้ารายการก่อนรัน', n_extra;
  END IF;
END $$;

COMMIT;
