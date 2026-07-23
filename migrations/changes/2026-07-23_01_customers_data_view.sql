-- customers_data_view — MATERIALIZED VIEW, 1 แถว/ผู้ติดต่อ รวมข้อมูลลูกค้าครบสำหรับทำใบเสนอราคา
-- normalize จาก 2 ตารางดิบ: customers (หลัก) + sale_orders (เติมเฉพาะ contact ที่ customers ไม่มี)
--
--   Arm 1 = customers ทุกแถว contact_id>=0 (~77,436: 73,686 ผู้ติดต่อ + 3,750 บริษัทไม่มีผู้ติดต่อ contact_id=0)
--   Arm 2 = sale_orders DISTINCT ON(contact_id) ที่ NOT EXISTS ใน customers (~5,906) + enrich field บริษัทจาก tax_id
--   comp  = company-level propagation: เติม sale_area/district/sub_district ที่ว่างจาก contact อื่นในบริษัทเดียวกัน
--   รวม ≈ 83,344 แถว · unique key = (company_id, contact_id) · contact_id=0 = บริษัทไม่ระบุผู้ติดต่อ
--
-- เป็น MATERIALIZED VIEW: propagation ต้อง aggregate จากค่าที่มาจาก sale_orders (plain view จะทำ point lookup ช้า)
--   → materialize + index (company_id,contact_id) ให้ point lookup <5ms; REFRESH หลัง sync (syncService)
-- customers ยังเป็น Odoo mirror ล้วน — เติมตอน refresh view เท่านั้น · ไม่แตะ customers_view/contacts_view

CREATE OR REPLACE FUNCTION public.clean_text(v text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT CASE WHEN lower(btrim(v)) = ANY (ARRAY['null', '']) THEN NULL ELSE btrim(v) END $$;

-- index บน base table (ช่วย REFRESH ให้เร็ว)
CREATE INDEX IF NOT EXISTS idx_sale_orders_contact_order ON public.sale_orders (contact_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_customers_contact_id      ON public.customers (contact_id);
CREATE INDEX IF NOT EXISTS idx_customers_tax_id          ON public.customers (customer_tax_id);

-- drop object เดิม ไม่ว่าจะเป็น view (รุ่นก่อน) หรือ materialized view (rerun)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname='customers_data_view' AND relkind='v') THEN
    DROP VIEW public.customers_data_view;
  ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname='customers_data_view' AND relkind='m') THEN
    DROP MATERIALIZED VIEW public.customers_data_view;
  END IF;
END $$;

CREATE MATERIALIZED VIEW public.customers_data_view AS
WITH latest_so AS (
  -- ยุบ sale_orders 366k -> 1 แถว/contact (order ล่าสุด)
  SELECT DISTINCT ON (contact_id)
    contact_id, customer_name, customer_reference, customer_tax_id,
    contact_name, contact_mobile, contact_phone, customer_sale_area, salesperson,
    invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip
  FROM public.sale_orders
  WHERE contact_id IS NOT NULL AND contact_id > 0
  ORDER BY contact_id, order_date DESC NULLS LAST
),
base AS (
  -- ── Arm 1: ผู้ติดต่อหลักจาก customers (contact_id>=0 → รวมบริษัทที่ไม่มีผู้ติดต่อด้วย)
  --          address blend customers -> latest sale_order เหมือน contacts_view ──
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
  b.salesperson, b.customer_type, b.phone, b.mobile, b.email,
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
