-- ─────────────────────────────────────────────────────────────────────────────
--  ค่าขนส่งอัตโนมัติสำหรับลูกค้าที่ไม่มีเครดิต
--
--  ลูกค้าที่ customer_payment_terms ไม่ได้เป็นรูปแบบ "<เลข> Days" (เช่น Cash /
--  เช็คล่วงหน้า30วัน / NULL / Immediate Payment) ถือว่า "ไม่มีเครดิต" — ถ้ายอด
--  สินค้าก่อน VAT (หลังหักส่วนลด) รวมทุกใบ < เกณฑ์ ระบบจะเติมบรรทัดค่าขนส่งให้เอง
--
--  ไฟล์นี้เตรียม 3 อย่าง:
--    1. products.is_system_item — ธงกันสินค้าที่ระบบสร้างเองไม่ให้โผล่ในผลค้นหา
--    2. แถวสินค้า "ค่าบริการ" ที่ map กลับ Odoo ได้ (SOFBLDXXXX0010)
--    3. shipping_fee_config — ค่าคงที่ที่แอดมินแก้ได้จากหน้า Admin
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-07-22_01_shipping_fee.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. ธงสินค้าที่ระบบสร้างเอง ───────────────────────────────────────────────
--
--  syncProducts.ts ไม่ได้ระบุคอลัมน์นี้ใน INSERT/UPDATE ของมัน (upsert ระบุคอลัมน์
--  ตายตัว) ค่าที่ตั้งไว้จึงไม่มีทางถูก sync เขียนทับ
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_system_item boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.products.is_system_item IS
  'true = แถวที่ระบบสร้างเอง ไม่ได้มาจาก Odoo sync — ต้องถูกกรองออกจากทุก query ค้นหาสินค้า';

CREATE INDEX IF NOT EXISTS idx_products_is_system_item
  ON public.products (is_system_item)
  WHERE is_system_item = true;

-- ── 2. แถวสินค้าค่าบริการ ────────────────────────────────────────────────────
--
--  product_template_id = -1 : Odoo ใช้เลขบวกเสมอ (ปัจจุบัน 8,780–179,606) เลขลบ
--    จึงชนไม่ได้ 100% และการมี product_id ทำให้บรรทัดนี้รอดตัวกรองใน PUT /api/quotation/:id
--    ที่ทิ้งรายการซึ่งไม่มี product_id ทิ้งเงียบ ๆ
--
--  model = 'SOFBLDXXXX0010' (ไม่ใช่ 'N/A' ตามที่ Odoo ให้มา) : ทั้งระบบใช้ products.model
--    เป็นกุญแจ join (สต็อก / ราคาขั้นต่ำ / กฎวันส่ง) ค่าต้อง unique — ถ้าใส่ 'N/A' ตรง ๆ
--    วันหนึ่งที่ Odoo ส่งสินค้าอื่นที่ model ว่างมาจะ join ชนกันทันที
--    ส่วนค่า 'N/A' ของจริงจะไปโผล่ตอน export CSV แทน
--
--  minimum_sales_price = 0 : ทำให้ checkMinSalesPrice() ข้ามบรรทัดนี้เองตามโค้ดเดิม
--    (มีเงื่อนไข `if (minPrice <= 0) continue`) ไม่ต้องแก้ validator
--
--  actual_quantity = 0 : ตามความจริง (ไม่ใช่สินค้าที่มีสต็อก) การซ่อนคำเตือน
--    "สินค้าคงเหลือ 0" ทำที่ชั้นแสดงผล ไม่ใช่ด้วยการโกหกตัวเลขสต็อก
INSERT INTO public.products (
  product_template_id, internal_reference, name, model,
  product_group, product_category, product_sub_category,
  sales_price, minimum_sales_price, unit_of_measure,
  quantity_on_hand, quantity_on_hand_unreserved, actual_quantity, incoming, outgoing,
  is_system_item
) VALUES (
  -1, 'SOFBLDXXXX0010', 'ค่าบริการ', 'SOFBLDXXXX0010',
  'Office', 'Service', 'Service',
  200, 0, 'pcs',
  0, 0, 0, 0, 0,
  true
)
ON CONFLICT (product_template_id) DO NOTHING;

-- ── 3. ตารางค่าคงที่ (แถวเดียว) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shipping_fee_config (
  id                          integer PRIMARY KEY DEFAULT 1,
  is_active                   boolean       NOT NULL DEFAULT true,
  threshold_before_vat        numeric(15,2) NOT NULL DEFAULT 1000,
  fee_price                   numeric(15,2) NOT NULL DEFAULT 200,
  fee_quantity                numeric(15,2) NOT NULL DEFAULT 1,
  default_item_name           text          NOT NULL DEFAULT 'ค่าขนส่ง',
  product_internal_reference  text          NOT NULL DEFAULT 'SOFBLDXXXX0010',
  updated_at                  timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT shipping_fee_config_single_row  CHECK (id = 1),
  CONSTRAINT shipping_fee_config_threshold   CHECK (threshold_before_vat >= 0),
  CONSTRAINT shipping_fee_config_price       CHECK (fee_price >= 0),
  CONSTRAINT shipping_fee_config_qty         CHECK (fee_quantity > 0),
  CONSTRAINT shipping_fee_config_name        CHECK (btrim(default_item_name) <> ''),
  CONSTRAINT shipping_fee_config_ref         CHECK (btrim(product_internal_reference) <> '')
);

COMMENT ON TABLE  public.shipping_fee_config IS
  'ค่าคงที่ของกฎค่าขนส่งอัตโนมัติ — มีได้แถวเดียว (id = 1) แก้จากหน้า Admin > ตั้งค่า > ค่าขนส่ง';
COMMENT ON COLUMN public.shipping_fee_config.threshold_before_vat IS
  'ยอดสินค้าก่อน VAT (หลังหักส่วนลด) ที่ต่ำกว่าค่านี้จึงคิดค่าขนส่ง';
COMMENT ON COLUMN public.shipping_fee_config.default_item_name IS
  'ชื่อรายการตั้งต้นที่แสดงในใบเสนอราคา — เซลล์แก้รายใบได้ ค่านี้ใช้เฉพาะตอนสร้างบรรทัดใหม่';
COMMENT ON COLUMN public.shipping_fee_config.product_internal_reference IS
  'ชี้ไปที่แถวใน products ที่ถือข้อมูล Odoo (internal_reference / name / group / category)';

INSERT INTO public.shipping_fee_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
