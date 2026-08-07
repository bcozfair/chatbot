-- customers_data_build (Arm 2): เปลี่ยนเกณฑ์ "ผู้ติดต่อจาก sale_orders สังกัดบริษัทไหน"
--
-- ── ปัญหาเดิม ──
-- Arm 2 คือผู้ติดต่อที่มีเฉพาะใน sale_orders (ไม่มีใน customers) — ต้องเดาว่าสังกัดบริษัทไหน
-- นิยามเดิมจับด้วย customer_tax_id อย่างเดียวแล้วปิดท้าย `ORDER BY c2.company_id LIMIT 1`
-- = "เอา company_id ต่ำสุดของเลขภาษีนั้นเสมอ" ผลคือผู้ติดต่อของทุกสาขาในนิติบุคคลเดียวกัน
-- ถูกโยนไปกองรวมที่บริษัทเดียว แล้วบริษัทนั้นก็ยืมชื่อ/รหัสของแถวที่ contact_id ต่ำสุดมาแสดง
-- → เกิด "บริษัทผี" ที่ชื่อ+รหัสซ้ำกับบริษัทจริงเป๊ะ ๆ
--
-- วัดจากข้อมูลจริง 2026-08-07: บริษัทที่ชื่อ+รหัสซ้ำกันทั้งระบบมี 65 กลุ่ม (76 แถวเกิน)
-- และ 63 ใน 65 กลุ่มเกิดจาก Arm 2 ทั้งสิ้น
--
-- เคสที่ผู้ใช้เจอ: เซลส์พิมพ์ "บริษัท ไพรมัส จำกัด (สำนักงานใหญ่)" แล้วได้ปุ่มให้เลือก 2 ปุ่ม
-- ที่ข้อความเหมือนกันทุกตัวอักษร (company_id 1 กับ 969120 ซึ่งเป็น A0010 ทั้งคู่) เลือกผิดปุ๊บ
-- ก็ไม่เจอผู้ติดต่อที่ต้องการ เพราะผู้ติดต่ออยู่ใต้ company_id อีกตัว
--
-- ── เกณฑ์ใหม่ (cascade ละเอียดก่อน หยาบทีหลัง) ──
--   1. เลขภาษี + รหัสอ้างอิง (customer_reference) ตรงกัน → บริษัทนั้น
--   2. ไม่เจอ → เลขภาษี + ชื่อบริษัท ตรงกัน → บริษัทนั้น
--   3. ไม่เจอทั้งคู่ → ไม่ยัดเข้าบริษัทใด ปล่อยให้ COALESCE ตกไปที่ s.contact_id
--      = แยกเป็นบริษัทของตัวเองตามข้อมูลในใบขาย (ซึ่งเป็นความจริงของข้อมูลมากกว่าการเดา)
--
-- ผลที่จำลองกับข้อมูลจริงก่อนรัน: ย้าย 575 จาก 4,365 แถวของ Arm 2 (13%),
-- ในนั้น 50 แถวกลายเป็นบริษัทเดี่ยว, จำนวนแถวรวมของตารางไม่เปลี่ยน (ยังคง 81,995)
--
-- ── ทำไมแยก LATERAL เป็น 2 ตัว ──
-- `grp` = ค่าระดับนิติบุคคล (เครดิต/ประเภท/เบอร์กลาง/อีเมลกลาง) ยังจับด้วยเลขภาษีอย่างเดียว
--         เหมือนเดิมทุกประการ — ค่าพวกนี้ใช้ร่วมกันได้ทั้งนิติบุคคล ไม่ต้องแม่นระดับสาขา
-- `own` = บริษัทที่ผู้ติดต่อสังกัดจริง ใช้เกณฑ์เข้มด้านบน
-- ถ้ารวมเป็นตัวเดียวแล้วใช้เกณฑ์เข้ม แถวที่ตกขั้น 3 จะเสียค่าเครดิต/ประเภทไปฟรี ๆ ทั้งที่
-- รู้อยู่ว่าเป็นนิติบุคคลเดียวกัน
--
-- ⚠️ หลังรันไฟล์นี้ต้องรัน `tsx scripts/sync/refreshCustomerDirectory.ts` เพื่อ build+swap
--    ตาราง customers_data_view ใหม่ — ไฟล์นี้แก้แค่ "นิยาม" (view) ไม่ได้แตะตารางที่ app อ่าน
-- ⚠️ รันด้วย pg.Client เท่านั้น (pool ตั้ง statement_timeout 15s แต่ไฟล์นี้ใช้เวลานานกว่า)

-- ── index สำหรับ LATERAL `own` ──
-- customers มี index ของ customer_tax_id อยู่แล้ว (idx_customers_tax_id) แต่ยังไม่มีของ
-- รหัสอ้างอิง และเงื่อนไขเทียบเป็น btrim(...) จึงต้องเป็น expression index ไม่งั้นตกไป seq scan
-- ทุกแถวของ Arm 2 (4,365 ครั้ง/รอบ refresh)
CREATE INDEX IF NOT EXISTS idx_customers_reference_trimmed
  ON public.customers (btrim(customer_reference));

-- ════════════════════════════════════════════════════════════════════
-- นิยามข้อมูล — เหมือน 2026-08-06_01 ทุกประการ ยกเว้น LATERAL ของ Arm 2
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

  -- ── Arm 2: contact ที่มีเฉพาะใน sale_orders
  --          company_id มาจาก `own` (เกณฑ์เข้ม) · field ระดับบริษัทมาจาก `grp` (เลขภาษี) ──
  SELECT
    COALESCE(own.company_id, s.grp_company_id)   AS company_id,
    s.contact_id,
    'saleorder'::text                            AS source,
    public.clean_text(s.customer_name)           AS customer_name,
    public.clean_text(s.customer_reference)      AS customer_reference,
    public.clean_text(s.customer_tax_id)         AS customer_tax_id,
    grp.customer_payment_terms                   AS customer_payment_terms,
    public.clean_text(s.customer_sale_area)      AS customer_sale_area,
    public.clean_text(s.salesperson)             AS salesperson,
    public.clean_text(s.sales_team)              AS sales_team,
    grp.customer_type                            AS customer_type,
    grp.phone                                    AS phone,
    grp.mobile                                   AS mobile,
    grp.email                                    AS email,
    public.clean_text(s.contact_name)            AS contact_name,
    public.clean_text(s.contact_mobile)          AS contact_mobile,
    public.clean_text(s.contact_phone)           AS contact_phone,
    NULL::text                                   AS contact_email,
    public.clean_text(s.invoice_street)          AS invoice_street,
    public.clean_text(s.invoice_district)        AS invoice_district,
    public.clean_text(s.invoice_sub_district)    AS invoice_sub_district,
    public.clean_text(s.invoice_state)           AS invoice_state,
    public.clean_text(s.invoice_zip)             AS invoice_zip
  FROM (
    -- ตัวแทนกลุ่มสำหรับขั้น 3: ผู้ติดต่อที่ใบขายบอกว่าเป็น "บริษัทเดียวกัน"
    -- (เลขภาษี + รหัสอ้างอิง + ชื่อ ตรงกันทั้งชุด) ต้องได้ company_id เดียวกัน
    --
    -- ⚠️ ห้ามใช้ s.contact_id ตรง ๆ เป็น fallback — ทดสอบกับข้อมูลจริงแล้วพบว่า
    -- ผู้ติดต่อ 27 คนของ "เอสซีจี เซรามิกส์ (มหาชน) สาขาที่ 00001" จะกลายเป็น 27 บริษัท
    -- ที่ชื่อ+รหัสเหมือนกันเป๊ะ = ปุ่มซ้ำ 27 ปุ่มในหน้าเลือกบริษัท ซึ่งแย่กว่าปัญหาเดิม
    --
    -- ชื่อบริษัทว่าง = ไม่มีอะไรให้จับกลุ่ม ยืนเดี่ยวด้วย contact_id ของตัวเองตามเดิม
    SELECT s0.*,
      CASE
        WHEN NULLIF(btrim(s0.customer_name), '') IS NULL THEN s0.contact_id
        ELSE min(s0.contact_id) OVER (PARTITION BY
               COALESCE(btrim(s0.customer_tax_id), ''),
               COALESCE(btrim(s0.customer_reference), ''),
               btrim(s0.customer_name))
      END AS grp_company_id
    FROM latest_so s0
  ) s
  -- ค่าระดับนิติบุคคล — จับด้วยเลขภาษีอย่างเดียว (เหมือนนิยามเดิมเป๊ะ)
  LEFT JOIN LATERAL (
    SELECT
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
  ) grp ON true
  -- บริษัทที่ผู้ติดต่อรายนี้สังกัดจริง
  --   ขั้น 1: รหัสอ้างอิงตรงกัน — วัดแล้วรหัสอ้างอิง 52,085 จาก 52,184 รหัส (99.8%) ชี้บริษัทเดียว
  --           จึงเป็นคีย์ที่แม่นที่สุด และใช้ได้กับลูกค้าต่างประเทศที่ไม่มีเลขผู้เสียภาษีไทยด้วย
  --           (ถ้าบังคับให้ต้องมีเลขภาษีเสมอ ลูกค้ากลุ่ม S0xxx จะไม่มีวันจับเข้าบริษัทได้เลย)
  --   ขั้น 2: เลขภาษี + ชื่อบริษัท ตรงกันทั้งคู่ — ชื่ออย่างเดียวไม่พอ เพราะชื่อซ้ำข้ามนิติบุคคลได้
  -- HAVING เป็นตัวบังคับขั้น 3: ไม่มีบริษัทไหนผ่านเกณฑ์ = ไม่คืนแถว = ใช้ตัวแทนกลุ่มด้านบนแทน
  -- `IS NOT TRUE` ทำให้ NULL (เช่น รหัสอ้างอิงว่าง) ถูกจัดเป็น "ไม่ตรง" ไม่ใช่ค่ากำกวมใน ORDER BY
  LEFT JOIN LATERAL (
    SELECT c3.company_id
    FROM public.customers c3
    WHERE (NULLIF(btrim(s.customer_tax_id), '') IS NOT NULL AND c3.customer_tax_id = s.customer_tax_id)
       OR (NULLIF(btrim(s.customer_reference), '') IS NOT NULL
           AND btrim(c3.customer_reference) = btrim(s.customer_reference))
    GROUP BY c3.company_id
    HAVING bool_or(btrim(c3.customer_reference) = btrim(s.customer_reference))
        OR (bool_or(c3.customer_tax_id = s.customer_tax_id)
            AND bool_or(btrim(c3.customer_name) = btrim(s.customer_name)))
    ORDER BY (bool_or(btrim(c3.customer_reference) = btrim(s.customer_reference)) IS NOT TRUE),
             c3.company_id
    LIMIT 1
  ) own ON true
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
-- ใบเสนอราคาที่ผูก contact ซึ่งย้ายบริษัท ต้องชี้ company_id ใหม่ให้ตรง
--
-- ใบเก่าเก็บ (customer_id, contact_id) ไว้เป็นคู่ ถ้า contact ย้ายบริษัทแล้ว customer_id
-- ยังชี้บริษัทเดิม คู่นี้จะหาแถวใน customers_data_view ไม่เจออีกต่อไป → ด่าน blacklist
-- และการ lookup ตอน export/enrich จะพลาด
--
-- contact_id เป็นค่าที่ไม่ซ้ำทั้งตาราง (ตรวจแล้ว 78,229 แถว = 78,229 ค่า) จึงใช้เป็นคีย์เทียบได้
-- ไม่แตะ customer_details (snapshot ของใบที่ยืนยันแล้วต้องคงเดิมตามหลัก snapshot)
-- ════════════════════════════════════════════════════════════════════
UPDATE public.quotations q
   SET customer_id = nb.company_id,
       updated_at  = NOW()
  FROM public.customers_data_build nb
 WHERE q.contact_id = nb.contact_id
   AND q.contact_id > 0
   AND q.customer_id IS DISTINCT FROM nb.company_id;
