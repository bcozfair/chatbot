-- sales_team: เพิ่ม fallback ข้ามตาราง (customers ว่าง → หยิบจาก sale_order ล่าสุดของ contact คนเดียวกัน)
-- ต่อยอดจาก 2026-08-05_01 ที่เพิ่มคอลัมน์ sales_team แบบค่าดิบล้วน
--
--   Arm 1 (source='odoo')      → COALESCE(customers.sales_team, sale_order ล่าสุดของ contact นั้น)
--   Arm 2 (source='saleorder') → sale_orders.sales_team (เหมือนเดิม — มีแหล่งเดียวอยู่แล้ว)
--
-- blend แบบเดียวกับ invoice_street/district/... ที่ทำอยู่ก่อนแล้วในไฟล์นี้ (customers ก่อน แล้วค่อย sale_order)
-- ผลที่วัดได้ตอนทำ: มีทีม 47,527 → 49,126 แถว (+1,599) จากทั้งหมด 81,911 แถว
--
-- ไม่ทำ company-level propagation (ไม่ยืมทีมจากผู้ติดต่อคนอื่นในบริษัทเดียวกัน) — วัดแล้วได้เพิ่มแค่ 237 แถว
--   แต่มี 270 บริษัท (1,978 แถว) ที่ผู้ติดต่อในบริษัทเดียวกันอยู่คนละทีมจริง ๆ → เสี่ยงแจกทีมผิด ไม่คุ้ม
--   (customer_sale_area/invoice_district ยัง propagate เหมือนเดิม ไม่กระทบ)
--
-- ⚠️ รันด้วย pg.Client เท่านั้น (pool มี statement_timeout 15s แต่สร้าง matview ใหม่ใช้เวลานานกว่า)

DROP VIEW IF EXISTS public.customers_data;
DROP MATERIALIZED VIEW IF EXISTS public.customers_data_view;

CREATE MATERIALIZED VIEW public.customers_data_view AS
WITH latest_so AS (
  -- ยุบ sale_orders -> 1 แถว/contact (order ล่าสุด)
  SELECT DISTINCT ON (contact_id)
    contact_id, customer_name, customer_reference, customer_tax_id,
    contact_name, contact_mobile, contact_phone, customer_sale_area, salesperson, sales_team,
    invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip
  FROM public.sale_orders
  WHERE contact_id IS NOT NULL AND contact_id > 0
  ORDER BY contact_id, order_date DESC NULLS LAST
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
      (array_remove(array_agg(public.clean_text(c2.customer_payment_terms)), NULL))[1] AS customer_payment_terms,
      (array_remove(array_agg(public.clean_text(c2.customer_type)), NULL))[1]          AS customer_type,
      (array_remove(array_agg(public.clean_text(c2.phone)), NULL))[1]                  AS phone,
      (array_remove(array_agg(public.clean_text(c2.mobile)), NULL))[1]                 AS mobile,
      (array_remove(array_agg(public.clean_text(c2.email)), NULL))[1]                  AS email
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
  -- company-level propagation: หยิบค่า non-null ตัวแรกของบริษัท (สาขา = คนละ company_id จึงไม่ปนสาขา)
  -- ⚠️ sales_team ไม่อยู่ในนี้โดยตั้งใจ — ทีมขายไม่ใช่คุณสมบัติของบริษัท ผู้ติดต่อคนละคนอาจคนละทีม
  SELECT company_id,
    (array_remove(array_agg(customer_sale_area), NULL))[1]     AS customer_sale_area,
    (array_remove(array_agg(invoice_district), NULL))[1]       AS invoice_district,
    (array_remove(array_agg(invoice_sub_district), NULL))[1]   AS invoice_sub_district
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
LEFT JOIN comp ON comp.company_id = b.company_id
WITH DATA;

-- index ของ matview เอง (matview = ตารางจริง) — unique จำเป็นสำหรับ REFRESH CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_cdv_company_contact ON public.customers_data_view (company_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_cdv_company ON public.customers_data_view (company_id);

-- plain view สำหรับเปิดดูใน DB tool (TablePlus ไม่โชว์ matview)
CREATE OR REPLACE VIEW public.customers_data AS
  SELECT * FROM public.customers_data_view;

COMMENT ON VIEW public.customers_data IS
  'plain view ครอบ matview customers_data_view — มีไว้เปิดดูใน DB tool (TablePlus ไม่โชว์ matview); ห้ามใช้ใน app code, app ต้อง query customers_data_view (matview) โดยตรง';
