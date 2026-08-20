-- ระงับการเสนอราคาบริษัทที่ไม่มีคำสั่งซื้อมานาน (credit hold)
--
-- ประกอบด้วย 2 ส่วนที่ต้องแยกกันให้ขาด:
--   1) quotation_credit_policy — "เกณฑ์" ที่แอดมินตั้ง (กี่เดือน / เปิด-ปิด)
--   2) customers_data_build.last_order_at — "ข้อมูล" วันที่ซื้อล่าสุดของนิติบุคคล
--
-- ทำไมเกณฑ์ต้องอยู่คนละที่กับข้อมูล: customers_data_view ถูก DROP แล้วสร้างใหม่ทั้งก้อน
-- ทุกรอบ sync (build+swap ทุก 10 นาที) — อะไรที่แอดมินกรอกแล้วเก็บไว้ในนั้นจะหายทุกรอบ
--
-- ทำไมเก็บ "วันที่" ไม่ใช่ boolean is_dormant:
--   * cdv rebuild เฉพาะ จ.–ศ. 07:10–17:50 → ศุกร์เย็นถึงจันทร์เช้าไม่ rebuild เลย
--     boolean ที่แช่ now() ไว้ตอน build จะค้างข้ามเส้น 1 ปีได้ ~2.5 วัน
--   * boolean ฝังเกณฑ์ (12 เดือน) ไว้ในตัว — แอดมินแก้เป็น 6 เดือนแล้วค่าไม่ขยับ
--     จนกว่าจะ rebuild ต้องบังคับ refresh ทุกครั้งที่แก้ค่า
--   * เก็บวันที่แล้วเทียบตอน query ราคาเท่ากันเป๊ะ แต่เกณฑ์มีผลทันที และเอาไปโชว์
--     ให้เซลล์เห็นได้ว่า "ซื้อครั้งล่าสุดเมื่อไหร่" ซึ่ง boolean บอกไม่ได้

-- ── 1. เกณฑ์ที่แอดมินตั้ง (แถวเดียว) ──
-- mode 3 สถานะแทน boolean: ต้องมีช่วง 'warn' ไว้เก็บ log ว่า "ถ้าเปิดจริงจะบล็อกใครบ้าง"
-- ก่อนสวิตช์เป็น 'block' — ขึ้น production มาเป็น 'off' เสมอ เปิดเองทีหลังจากหน้าแอดมิน
CREATE TABLE IF NOT EXISTS public.quotation_credit_policy (
    id              integer DEFAULT 1 NOT NULL,
    mode            text    DEFAULT 'off' NOT NULL,
    dormant_months  integer DEFAULT 12 NOT NULL,
    updated_at      timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by      integer REFERENCES public.admin_users(id) ON DELETE SET NULL,
    CONSTRAINT quotation_credit_policy_single_row CHECK (id = 1),
    CONSTRAINT quotation_credit_policy_mode CHECK (mode = ANY (ARRAY['off', 'warn', 'block'])),
    CONSTRAINT quotation_credit_policy_months CHECK (dormant_months > 0 AND dormant_months <= 240)
);

INSERT INTO public.quotation_credit_policy (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── 2. เพิ่ม last_order_at ใน view (คอลัมน์ต่อท้าย → CREATE OR REPLACE ทำได้ ไม่ต้อง DROP) ──
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
),
-- ════════════════════════════════════════════════════════════════════
-- last_order_at — วันที่มีคำสั่งซื้อล่าสุดของ "นิติบุคคล" ที่บริษัทนี้สังกัด
--
-- ⚠️ sale_orders.company_id ไม่ใช่รหัสลูกค้า — เป็นบริษัทผู้ขาย (มีแค่ค่า 1 กับ 2)
--    จุดเชื่อมลูกค้าคือ contact_id เท่านั้น ห้ามเผลอ join ด้วย company_id
--
-- ⚠️ นิยาม "นิติบุคคลเดียวกัน" ตรงนี้ต้องตรงกับ db/companyIdentity.ts เสมอ
--    (เลขภาษี / รหัสอ้างอิง / ชื่อ ตรงข้อใดข้อหนึ่ง = รายเดียวกัน — 1 ชั้น ไม่ไล่ต่อเป็นทอด)
--    ถ้าแยกกันเมื่อไหร่ ด่านตรวจกับป้ายเตือนจะให้คำตอบคนละอย่าง
--    → scripts/diag/creditHoldSmoke.ts เทียบผลของสองที่นี้ทุกครั้งที่รัน
--
-- ทำไมต้องขยายเป็นนิติบุคคล ไม่ดูแค่ company_id ตัวเอง: Odoo แตกบริษัทเดียวเป็นหลายรหัส
-- วัดบนข้อมูลจริง 2026-08-20 — ถ้าไม่ขยาย จะมี 1,259 บริษัทที่ซื้อจริงใต้รหัสสาขาอื่น
-- ถูกนับเป็น "เงียบเกิน 1 ปี" ผิด ๆ (13% ของกลุ่มที่ยัง active อยู่)
--
-- ทำไมคำนวณตรงนี้แทนที่จะถามตอนออกใบ: ถามทีละบริษัทตอนใช้งานจริงราคา ~190ms และ
-- ติดป้ายในผลค้นหา 30 รายพร้อมกันราคา 2.2 วิ (ใช้ไม่ได้) — ยุบมาคำนวณทั้งตารางรอบเดียว
-- ด้วย hash aggregate ล้วนราคา 1.5 วิ ต่อรอบ build แล้วตอนใช้งานเหลือ index lookup
-- ════════════════════════════════════════════════════════════════════
so_last AS (
  -- ใบสั่งซื้อล่าสุดต่อผู้ติดต่อ (ใช้ idx_so_contact_latest → index-only scan)
  SELECT contact_id, max(order_date) AS d
    FROM public.sale_orders
   WHERE contact_id > 0
   GROUP BY contact_id
),
own_last AS (
  -- ยุบขึ้นมาระดับ company_id ของตัวเองก่อน
  SELECT b.company_id, max(so.d) AS d
    FROM base b
    LEFT JOIN so_last so ON so.contact_id = b.contact_id
   GROUP BY b.company_id
),
ent_keys AS (
  -- (บริษัท → คีย์บ่งชี้นิติบุคคล) หนึ่งแถวต่อคีย์ · base ผ่าน clean_text มาแล้ว
  -- จึงไม่ต้อง NULLIF(TRIM(...)) ซ้ำเหมือนฝั่ง companyIdentity ที่รับค่าดิบ
           SELECT DISTINCT company_id, 't'::text AS kind, customer_tax_id    AS k FROM base WHERE customer_tax_id    IS NOT NULL
  UNION ALL SELECT DISTINCT company_id, 'r'::text,        customer_reference       FROM base WHERE customer_reference IS NOT NULL
  UNION ALL SELECT DISTINCT company_id, 'n'::text,        customer_name            FROM base WHERE customer_name      IS NOT NULL
),
key_last AS (
  -- คีย์แต่ละตัวถูกซื้อล่าสุดเมื่อไหร่ (รวมทุกบริษัทที่ถือคีย์นี้)
  SELECT ek.kind, ek.k, max(ol.d) AS d
    FROM ent_keys ek
    JOIN own_last ol ON ol.company_id = ek.company_id
   GROUP BY ek.kind, ek.k
),
ent_last AS (
  -- แล้วกระจายกลับ: บริษัทหนึ่งได้วันล่าสุดของคีย์ที่ตัวเองถืออยู่ทุกตัว
  SELECT ek.company_id, max(kl.d) AS d
    FROM ent_keys ek
    JOIN key_last kl ON kl.kind = ek.kind AND kl.k = ek.k
   GROUP BY ek.company_id
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
  b.invoice_state, b.invoice_zip,
  -- GREATEST ข้าม NULL ให้เอง · own_last เผื่อบริษัทที่ไม่มีคีย์เลยสักตัว (ไม่มีแถวใน ent_last)
  GREATEST(own_last.d, ent_last.d)                               AS last_order_at
FROM base b
LEFT JOIN comp     ON comp.company_id     = b.company_id
LEFT JOIN own_last ON own_last.company_id = b.company_id
LEFT JOIN ent_last ON ent_last.company_id = b.company_id;

-- ── 3. เติมคอลัมน์ให้ตารางจริงที่ใช้อยู่ตอนนี้ ──
-- ไม่ rebuild ทั้งตารางในไฟล์นี้ เพราะ runMigration.ts ใช้ pool ที่ตั้ง statement_timeout 15s
-- แต่ build+ANALYZE ใช้ ~8 วิ + swap → เสี่ยงตายกลางคัน
-- ADD COLUMN แบบไม่มี DEFAULT = แก้แค่ catalog ไม่ rewrite ตาราง (ทันที)
-- ค่าจะเป็น NULL ทั้งตารางจนกว่ารอบ refresh ถัดไปจะสร้างตารางใหม่จาก view ข้างบน
-- NULL = "ไม่เคยซื้อ" = ปล่อยผ่าน จึงไม่มีใครถูกบล็อกผิดในช่วงคาบเกี่ยว (และ mode ยังเป็น 'off')
ALTER TABLE public.customers_data_view
  ADD COLUMN IF NOT EXISTS last_order_at timestamp with time zone;
