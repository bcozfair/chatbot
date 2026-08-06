-- customers_data_view: เปลี่ยนกลไก refresh จาก REFRESH MATERIALIZED VIEW CONCURRENTLY เป็น build+swap
--
-- ปัญหาเดิม (วัดจริงบน prod): refresh ใช้ 10.0–11.5 วิ ทุกรอบ sync (ทุก 5 นาที × ~132 รอบ/วัน)
--   query ของ view เองใช้แค่ ~3 วิ — อีก ~6.5 วิเป็น overhead ของ CONCURRENTLY ล้วน ๆ
--   (Postgres ต้องสร้าง temp table 82k แถว + สร้าง unique index บนมัน + FULL OUTER JOIN
--    เทียบ "ทั้งแถว 23 คอลัมน์" กับของเดิม แล้วค่อย DELETE/INSERT ส่วนต่าง)
--   ทดสอบแล้วว่าเพิ่ม work_mem ไม่ช่วยขั้นตอนนี้เลย
--
-- กลไกใหม่: สร้างตารางใหม่ทั้งก้อน (ไม่ล็อกใคร ~2.1 วิ) แล้วสลับชื่อใน transaction เดียว
--   (ถือ AccessExclusiveLock ระดับ ms) → logic อยู่ใน scripts/sync/refreshCustomerDirectory.ts
--   customers_data_view จึงกลายเป็น "ตารางจริง" ไม่ใช่ materialized view อีกต่อไป
--   ⇒ ห้ามสั่ง REFRESH MATERIALIZED VIEW กับมันอีก · app ทุกจุด SELECT เหมือนเดิมไม่ต้องแก้
--
-- นิยามข้อมูลเหมือน 2026-08-05_02 ทุกประการ ยกเว้น 2 จุดที่ทำให้ผลลัพธ์ "คงที่" (deterministic):
--   1. latest_so: เพิ่ม tie-break order_reference DESC — เดิมถ้าใบล่าสุดของ contact เสมอกัน
--      (order_date เท่ากัน เช่นคู่ QP-/QT- วันเดียวกัน) DISTINCT ON เลือกมั่ว
--      วัดแล้ว: 38 contact มีเสมอ, 7 รายค่าต่างกันจริง แต่ไม่กระทบผลลัพธ์ (ต่างแค่ salesperson
--      ซึ่ง Arm 1 อ่านจาก customers ไม่ได้อ่านจาก sale_orders) — ใส่ไว้กัน regression ในอนาคต
--   2. comp / comp lateral: array_agg เพิ่ม ORDER BY contact_id — เดิมไม่มี ORDER BY แปลว่า
--      "ค่าแรกที่ไม่ null ของบริษัท" ขึ้นกับลำดับ scan ที่ planner บังเอิญเลือก
--      พิสูจน์แล้ว: รันนิยามเดิม 2 ครั้งบนข้อมูลชุดเดียวกันแต่คนละ plan ได้ผลต่างกัน 19 แถว
--      (= อำเภอ/ตำบลของลูกค้าเปลี่ยนเองได้ทุก refresh โดยข้อมูลต้นทางไม่ได้เปลี่ยน)
--      ผลกระทบตอนแปลง: 154/81,986 แถว (0.19%) ย้ายไปยึดค่าของ contact_id น้อยสุดถาวร
--      ไม่มีแถวไหนข้อมูลหายเป็น NULL (ตรวจทั้ง NULL→ค่า และ ค่า→NULL = 0)
--   ตรวจเทียบกับนิยามเดิมบน snapshot เดียวกัน: จำนวนแถวเท่ากัน คีย์ไม่หาย/ไม่เกิน
--   20 จาก 23 คอลัมน์ตรงกันทุกแถว
--
-- ⚠️ รันด้วย pg.Client เท่านั้น (pool ตั้ง statement_timeout 15s แต่ไฟล์นี้ใช้เวลานานกว่า)

-- ── index สำหรับ latest_so ──
-- ของเดิม idx_sale_orders_contact_order (contact_id, order_date DESC) ใช้ไม่ได้จริง เพราะ DESC ของ
-- Postgres = NULLS FIRST แต่ query สั่ง DESC NULLS LAST → planner ตกไป seq scan 366MB + external
-- sort 49MB/worker. index นี้เรียงตรงกับ ORDER BY เป๊ะและมี order_reference เป็น key ตัวท้าย
-- → ได้ index-only scan (ขั้น latest_so: 1,450ms → 129ms)
CREATE INDEX IF NOT EXISTS idx_so_contact_latest
  ON public.sale_orders (contact_id, order_date DESC NULLS LAST, order_reference DESC)
  WHERE contact_id > 0;

-- ── index สำหรับ watermark (ข้าม refresh เมื่อไม่มีอะไรเปลี่ยน) ──
-- refresh ต้องหา max(sync_updated_at)/max(updated_at) ให้ได้ในระดับ ms ไม่งั้นการเช็ค
-- "มีอะไรเปลี่ยนไหม" จะแพงกว่าการ refresh เอง
CREATE INDEX IF NOT EXISTS idx_customers_sync_updated_at ON public.customers (sync_updated_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_sale_orders_updated_at    ON public.sale_orders (updated_at DESC NULLS LAST);

-- ════════════════════════════════════════════════════════════════════
-- นิยามข้อมูล — เก็บเป็น plain view ตัวเดียว (source of truth)
-- refresh script สร้างตารางจาก view นี้: CREATE TABLE ... AS SELECT * FROM customers_data_build
-- ⚠️ ห้าม app query view นี้ตรง ๆ (ใช้ ~2 วิ/ครั้ง) — app ต้องอ่าน customers_data_view เสมอ
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.customers_data_build AS
WITH latest_so AS (
  -- ยุบ sale_orders -> 1 แถว/contact (ใบล่าสุด)
  -- แยก 2 ขั้น: ขั้นแรกหา key ด้วย index-only scan (ไม่แตะ heap 366MB) แล้วค่อย join กลับด้วย PK
  SELECT
    k.contact_id, s.customer_name, s.customer_reference, s.customer_tax_id,
    s.contact_name, s.contact_mobile, s.contact_phone, s.customer_sale_area, s.salesperson, s.sales_team,
    s.invoice_street, s.invoice_district, s.invoice_sub_district, s.invoice_state, s.invoice_zip
  FROM (
    SELECT DISTINCT ON (contact_id) contact_id, order_reference
    FROM public.sale_orders
    WHERE contact_id > 0
    ORDER BY contact_id, order_date DESC NULLS LAST, order_reference DESC
  ) k
  JOIN public.sale_orders s ON s.order_reference = k.order_reference
),
base AS (
  -- ── Arm 1: ผู้ติดต่อหลักจาก customers (contact_id>=0 → รวมบริษัทที่ไม่มีผู้ติดต่อด้วย)
  --          address + sales_team blend customers -> latest sale_order ──
  SELECT
    c.company_id,
    c.contact_id,
    'odoo'::text                                 AS source,
    public.clean_text(c.customer_name)           AS customer_name,
    public.clean_text(c.customer_reference)      AS customer_reference,
    public.clean_text(c.customer_tax_id)         AS customer_tax_id,
    public.clean_text(c.customer_payment_terms)  AS customer_payment_terms,
    public.clean_text(c.customer_sale_area)      AS customer_sale_area,
    public.clean_text(c.salesperson)             AS salesperson,
    COALESCE(public.clean_text(c.sales_team),           public.clean_text(so.sales_team))          AS sales_team,
    public.clean_text(c.customer_type)           AS customer_type,
    public.clean_text(c.phone)                   AS phone,
    public.clean_text(c.mobile)                  AS mobile,
    public.clean_text(c.email)                   AS email,
    public.clean_text(c.contact_name)            AS contact_name,
    public.clean_text(c.contact_mobile)          AS contact_mobile,
    public.clean_text(c.contact_phone)           AS contact_phone,
    public.clean_text(c.contact_email)           AS contact_email,
    COALESCE(public.clean_text(c.invoice_street),       public.clean_text(so.invoice_street))       AS invoice_street,
    COALESCE(public.clean_text(c.invoice_district),     public.clean_text(so.invoice_district))     AS invoice_district,
    COALESCE(public.clean_text(c.invoice_sub_district), public.clean_text(so.invoice_sub_district)) AS invoice_sub_district,
    COALESCE(public.clean_text(c.invoice_state),        public.clean_text(so.invoice_state))        AS invoice_state,
    COALESCE(public.clean_text(c.invoice_zip),          public.clean_text(so.invoice_zip))          AS invoice_zip
  FROM public.customers c
  LEFT JOIN latest_so so ON so.contact_id = c.contact_id
  WHERE c.contact_id >= 0

  UNION ALL

  -- ── Arm 2: contact ที่มีเฉพาะใน sale_orders + enrich field บริษัท (payment/type/phone/mobile/email) จากบริษัทจริง via tax_id ──
  SELECT
    COALESCE(comp.company_id, s.contact_id)      AS company_id,
    s.contact_id,
    'saleorder'::text                            AS source,
    public.clean_text(s.customer_name)           AS customer_name,
    public.clean_text(s.customer_reference)      AS customer_reference,
    public.clean_text(s.customer_tax_id)         AS customer_tax_id,
    comp.customer_payment_terms                  AS customer_payment_terms,
    public.clean_text(s.customer_sale_area)      AS customer_sale_area,
    public.clean_text(s.salesperson)             AS salesperson,
    public.clean_text(s.sales_team)              AS sales_team,
    comp.customer_type                           AS customer_type,
    comp.phone                                   AS phone,
    comp.mobile                                  AS mobile,
    comp.email                                   AS email,
    public.clean_text(s.contact_name)            AS contact_name,
    public.clean_text(s.contact_mobile)          AS contact_mobile,
    public.clean_text(s.contact_phone)           AS contact_phone,
    NULL::text                                   AS contact_email,
    public.clean_text(s.invoice_street)          AS invoice_street,
    public.clean_text(s.invoice_district)        AS invoice_district,
    public.clean_text(s.invoice_sub_district)    AS invoice_sub_district,
    public.clean_text(s.invoice_state)           AS invoice_state,
    public.clean_text(s.invoice_zip)             AS invoice_zip
  FROM latest_so s
  LEFT JOIN LATERAL (
    SELECT c2.company_id,
      (array_remove(array_agg(public.clean_text(c2.customer_payment_terms) ORDER BY c2.contact_id), NULL))[1] AS customer_payment_terms,
      (array_remove(array_agg(public.clean_text(c2.customer_type)          ORDER BY c2.contact_id), NULL))[1] AS customer_type,
      (array_remove(array_agg(public.clean_text(c2.phone)                  ORDER BY c2.contact_id), NULL))[1] AS phone,
      (array_remove(array_agg(public.clean_text(c2.mobile)                 ORDER BY c2.contact_id), NULL))[1] AS mobile,
      (array_remove(array_agg(public.clean_text(c2.email)                  ORDER BY c2.contact_id), NULL))[1] AS email
    FROM public.customers c2
    WHERE c2.customer_tax_id = s.customer_tax_id
      AND s.customer_tax_id IS NOT NULL AND btrim(s.customer_tax_id) <> ''
    GROUP BY c2.company_id
    ORDER BY c2.company_id
    LIMIT 1
  ) comp ON true
  WHERE NOT EXISTS (SELECT 1 FROM public.customers c3 WHERE c3.contact_id = s.contact_id)
),
comp AS (
  -- company-level propagation: หยิบค่าที่ไม่ null ของ contact_id น้อยสุดในบริษัท
  -- (สาขา = คนละ company_id จึงไม่ปนสาขา · ORDER BY contact_id = ตัวที่ทำให้ผลคงที่)
  -- ⚠️ sales_team ไม่อยู่ในนี้โดยตั้งใจ — ทีมขายไม่ใช่คุณสมบัติของบริษัท ผู้ติดต่อคนละคนอาจคนละทีม
  SELECT company_id,
    (array_remove(array_agg(customer_sale_area   ORDER BY contact_id), NULL))[1] AS customer_sale_area,
    (array_remove(array_agg(invoice_district     ORDER BY contact_id), NULL))[1] AS invoice_district,
    (array_remove(array_agg(invoice_sub_district ORDER BY contact_id), NULL))[1] AS invoice_sub_district
  FROM base GROUP BY company_id
)
SELECT
  b.company_id, b.contact_id, b.source,
  b.customer_name, b.customer_reference, b.customer_tax_id, b.customer_payment_terms,
  COALESCE(b.customer_sale_area, comp.customer_sale_area)         AS customer_sale_area,
  b.salesperson, b.sales_team, b.customer_type, b.phone, b.mobile, b.email,
  b.contact_name, b.contact_mobile, b.contact_phone, b.contact_email,
  b.invoice_street,
  COALESCE(b.invoice_district, comp.invoice_district)            AS invoice_district,
  COALESCE(b.invoice_sub_district, comp.invoice_sub_district)    AS invoice_sub_district,
  b.invoice_state, b.invoice_zip
FROM base b
LEFT JOIN comp ON comp.company_id = b.company_id;

-- ════════════════════════════════════════════════════════════════════
-- แปลง customers_data_view: MATERIALIZED VIEW -> ตารางจริง
-- (rerun ได้ — ถ้าเป็นตารางอยู่แล้วก็สร้างใหม่ทับ)
--
-- ครอบด้วย transaction เดียว: ระหว่างทำ คนอ่านจะ "รอ" ~3 วิแล้วได้ข้อมูล
-- ถ้าไม่ครอบ จะมีช่วงที่ตารางหายจริง ๆ → บอทที่ยิง query พอดีจะได้ error
-- ════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW IF EXISTS public.customers_data;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='customers_data_view' AND relnamespace='public'::regnamespace AND relkind='m') THEN
    DROP MATERIALIZED VIEW public.customers_data_view;
  ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname='customers_data_view' AND relnamespace='public'::regnamespace AND relkind='r') THEN
    DROP TABLE public.customers_data_view;
  END IF;
END $$;

CREATE TABLE public.customers_data_view AS SELECT * FROM public.customers_data_build;

CREATE UNIQUE INDEX idx_cdv_company_contact ON public.customers_data_view (company_id, contact_id);
CREATE INDEX        idx_cdv_company         ON public.customers_data_view (company_id);

-- ANALYZE เต็มรูปแบบตารางนี้ใช้ 7.3 วิ (คอลัมน์ text ไทยต้อง sort 30,000 ตัวอย่างด้วย collation ไทย
-- ต่อคอลัมน์ — วัดแยก: customer_name อย่างเดียว 5.1 วิ) → ลด sample ของคอลัมน์ text เหลือ target 10
-- แล้วเก็บละเอียดเฉพาะ 2 คอลัมน์ที่เป็นคีย์ของทุก query. ต้องตรงกับ refreshCustomerDirectory.ts
SET LOCAL default_statistics_target = 10;
ANALYZE public.customers_data_view;
SET LOCAL default_statistics_target = 100;
ANALYZE public.customers_data_view (company_id, contact_id);

-- plain view สำหรับเปิดดูใน DB tool + ใช้ใน odooSaleOrderExport / diag
CREATE OR REPLACE VIEW public.customers_data AS
  SELECT * FROM public.customers_data_view;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- watermark ของรอบ refresh ล่าสุด — ใช้ข้าม refresh เมื่อ customers/sale_orders ไม่ขยับเลย
-- เก็บเป็นตารางแยกแทนการยัดแถวปลอมลง sync_state (scripts/diag ลิสต์ sync_state ทั้งตาราง)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.customers_data_view_state (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source_watermark  TIMESTAMPTZ,
  refreshed_at      TIMESTAMPTZ,
  build_ms          INTEGER,
  row_count         INTEGER
);
INSERT INTO public.customers_data_view_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
