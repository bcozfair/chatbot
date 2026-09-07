-- ═══════════════════════════════════════════════════════════════════════════
--  ด่านตรวจเครดิต: ตรวจเฉพาะลูกค้าเครดิต/เช็คล่วงหน้า และนับเฉพาะใบที่ออกบิลแล้ว
--
--  เปลี่ยนนิยาม customers_data_view.last_order_at 2 เรื่องพร้อมกัน:
--
--    1. นับเฉพาะ sale_orders ที่ invoice_status IN ('invoiced','to invoice')
--       'no' = Odoo บอกว่าไม่มีอะไรต้องวางบิล (ใบยกเลิก/ใบร่าง/ยังไม่ส่งของ) จึงไม่ใช่
--       หลักฐานว่าลูกค้าจ่ายเงินจริง — ถ้าใบล่าสุดเป็น 'no' ค่าจะตกไปใช้ใบที่ออกบิลของ
--       รหัสอื่นในนิติบุคคลเดียวกัน ถ้าทั้งนิติบุคคลไม่มีใบที่ออกบิลเลยก็คืน NULL
--
--    2. บริษัทที่ไม่ใช่ลูกค้าเครดิต/เช็คล่วงหน้า → NULL ตั้งแต่ต้นทาง
--       ลูกค้า Cash จ่ายเงินหน้างาน ไม่มีความเสี่ยงเครดิตให้ระงับ
--
--  ⚠️ ตัว sync ไม่ต้องแก้ — invoice_status ยังเก็บดิบเหมือนเดิม กรองตอน build view เท่านั้น
--
--  ── ทำไมไม่ต้องแก้โค้ดด่านตรวจเลยสักบรรทัด ──
--  NULL แปลว่า "ไม่เข้าข่ายตรวจ" ทั้ง 3 สาเหตุ (ไม่ใช่เครดิต / ไม่เคยซื้อ / ไม่เคยมีบิล)
--  และ services/creditHoldService.ts เทียบด้วย `max(last_order_at) < cutoff` ซึ่งคืน NULL
--  เมื่อไม่มีค่า → ไม่ใช่ true → ผ่านด่าน ตรรกะเดิมรองรับอยู่แล้ว
--
--  ── ผลบนข้อมูลจริง (วัด 2026-08-25 ก่อนรัน) ──
--    เดิม  เข้าเกณฑ์ 10,926 บริษัท
--    ใหม่  เข้าเกณฑ์  1,656 บริษัท
--      42,640 ไม่ใช่เครดิต → ผ่าน
--      10,718 เครดิต/เช็คล่วงหน้า
--         ├  4,843 ไม่มีใบสั่งซื้อเลย        → ผ่าน (ลูกค้าใหม่ ต้องเสนอราคาได้)
--         ├    452 มีใบแต่ไม่เคยออกบิลเลย   → ผ่าน (ผลของกฎข้อ 1 — จงใจ)
--         ├  3,767 บิลล่าสุดยังอยู่ในเกณฑ์   → ผ่าน
--         └  1,656 บิลล่าสุดเกินเกณฑ์       → บล็อก
--
--  ── ความปลอดภัย ──
--  รันได้ทุกเวลา · idempotent (รันซ้ำได้ ผลเท่าเดิม) · ไม่แตะข้อมูลใน customers/sale_orders
--  build+swap ถือ AccessExclusiveLock ระดับ ms (ตัว build 2–3 วิ ไม่ล็อกใคร)
--  ล้มกลางคัน = ทั้งไฟล์ rollback ตารางเดิมอยู่ครบ (ทั้งไฟล์อยู่ใน transaction เดียว)
--
--  ⚠️ ห้ามเอาโค้ดขึ้นก่อน migration ถ้าวันหลังมีการเพิ่มคอลัมน์ — รอบนี้ไม่มีคอลัมน์ใหม่
--     จึงสลับลำดับได้อิสระ โค้ดเก่าอ่านค่าใหม่ได้ปกติ
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL work_mem = '128MB';
SET LOCAL jit = off;
SET LOCAL statement_timeout = '180s';
SET LOCAL lock_timeout = '5s';

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
-- last_order_at — "วันอ้างอิงของด่านตรวจเครดิต" ไม่ใช่วันสั่งซื้อล่าสุดตามชื่อ
--
-- ⚠️⚠️ ชื่อคอลัมน์หลอก อ่านนิยามให้จบก่อนเอาไปใช้ที่อื่น ⚠️⚠️
--   ค่าที่ได้ = วันที่ล่าสุดของใบที่ "ออกบิลแล้ว/รอออกบิล" ของนิติบุคคลนี้
--               และเฉพาะเมื่อนิติบุคคลนี้เป็นลูกค้าเครดิต/เช็คล่วงหน้าเท่านั้น
--   NULL     = ไม่เข้าข่ายตรวจ ซึ่งมีได้ 3 สาเหตุและด่านปฏิบัติเหมือนกันหมด (= ผ่าน):
--                1. ไม่ใช่ลูกค้าเครดิต (Cash / Immediate Payment / ไม่ได้ระบุใน Odoo)
--                2. เป็นเครดิต แต่ไม่มีใบสั่งซื้อเลยสักใบ  ← ลูกค้าใหม่ ต้องเสนอราคาได้
--                3. เป็นเครดิต มีใบ แต่ไม่เคยมีใบที่ออกบิลเลย (452 บริษัท ณ 2026-08-25)
--   ⇒ ห้ามเอาคอลัมน์นี้ไปแสดงเป็น "ลูกค้ารายนี้ซื้อครั้งสุดท้ายเมื่อไหร่" เด็ดขาด
--     ลูกค้า Cash ทุกรายจะได้ NULL ทั้งที่ซื้อประจำ
--   ตัวเลข ณ 2026-08-25: 42,640 บริษัทไม่ใช่เครดิต · 10,718 เป็นเครดิต · เข้าเกณฑ์ 1,656
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
-- ประเภทการชำระเงินก็ต้องขยายด้วยเหตุผลเดียวกัน: 579 นิติบุคคล (จาก 2,031 ที่มีหลายรหัส)
-- มีรหัสที่ประเภทไม่ตรงกัน ถ้าดูแค่รหัสที่เซลล์เลือก ลูกค้าเครดิตจะหลุดด่านได้ด้วยการ
-- เลือกรหัสสาขาที่เป็น Cash (ต่างกัน 215 บริษัท วัด 2026-08-25)
--
-- ทำไมคำนวณตรงนี้แทนที่จะถามตอนออกใบ: ถามทีละบริษัทตอนใช้งานจริงราคา ~190ms และ
-- ติดป้ายในผลค้นหา 30 รายพร้อมกันราคา 2.2 วิ (ใช้ไม่ได้) — ยุบมาคำนวณทั้งตารางรอบเดียว
-- ด้วย hash aggregate ล้วนราคา 1.5 วิ ต่อรอบ build แล้วตอนใช้งานเหลือ index lookup
-- ════════════════════════════════════════════════════════════════════
so_last AS (
  -- ใบล่าสุดต่อผู้ติดต่อ นับเฉพาะที่ออกบิลแล้ว/รอออกบิล
  --
  -- 'no' = Odoo บอกว่า "ไม่มีอะไรต้องวางบิล" ครอบทั้งใบที่ยกเลิก ใบร่าง และใบที่ยังไม่ส่งของ
  -- จึงไม่ใช่หลักฐานว่าลูกค้าจ่ายเงินจริง — ด่านเครดิตต้องดูเฉพาะใบที่กลายเป็นเงิน
  -- ถ้าใบล่าสุดของบริษัทเป็น 'no' ค่าจะตกไปใช้ใบที่ออกบิลของรหัสอื่นในนิติบุคคลเดียวกัน
  -- และถ้าทั้งนิติบุคคลไม่มีใบที่ออกบิลเลย ก็คืน NULL (= ผ่านด่าน)
  --
  -- ⚠️ ตัวกรองนี้ทำให้ใช้ idx_so_contact_latest แบบ index-only ไม่ได้แล้ว (invoice_status
  --    ไม่อยู่ใน index) กลายเป็น seq scan — วัด 2026-08-25: 90ms → 333ms บน build 2.1 วิ
  --    ยังไม่คุ้มสร้าง index เพิ่ม ถ้าวันไหน build ช้าขึ้นจนสะดุด ค่อยมาดูตรงนี้
  SELECT contact_id, max(order_date) AS d
    FROM public.sale_orders
   WHERE contact_id > 0
     AND invoice_status IN ('invoiced', 'to invoice')
   GROUP BY contact_id
),
own_last AS (
  -- ยุบขึ้นมาระดับ company_id ของตัวเองก่อน
  SELECT b.company_id, max(so.d) AS d
    FROM base b
    LEFT JOIN so_last so ON so.contact_id = b.contact_id
   GROUP BY b.company_id
),
own_credit AS (
  -- บริษัทนี้เป็นลูกค้าเครดิต/เช็คล่วงหน้าหรือไม่ (ยังไม่ขยายนิติบุคคล)
  --
  -- รูปแบบที่นับว่าเป็นเครดิต — ค่าที่มีจริงใน Odoo ณ 2026-08-25:
  --   '7/14/15/20/30/40/45/60/65/90 Days'  → ตรง regex
  --   'เช็คล่วงหน้า7/15/30/45วัน'              → ตรง LIKE
  -- ที่เหลือไม่นับ: 'Cash', 'Immediate Payment', และ NULL (28,241 บริษัทไม่ได้ตั้งค่าใน Odoo)
  --
  -- ⚠️ COALESCE จำเป็น ไม่ใช่ของแถม — bool_or() บนบริษัทที่ payment terms เป็น NULL ทุกแถว
  --    คืน NULL ไม่ใช่ false แล้วเงื่อนไขที่เขียนกลับด้าน (NOT credit) จะกินบริษัทกลุ่มนี้
  --    หายไปเงียบ ๆ ทั้ง 28,241 ราย
  --
  -- ⚠️ ค่าใหม่ที่ Odoo เพิ่มมาทีหลัง (เช่น '2 Months' / 'เครดิต 30 วัน') จะไม่ตรงสักรูปแบบ
  --    แล้วลูกค้ากลุ่มนั้นหลุดด่านโดยไม่มีใครรู้ → creditHoldSmoke.ts มีข้อที่ลิสต์ค่าที่
  --    ไม่เข้าทั้งสองรูปแบบออกมาให้เห็นทุกครั้งที่รัน ห้ามลบทิ้ง
  SELECT b.company_id,
         COALESCE(bool_or(b.customer_payment_terms ~ '^[0-9]+ Days$'
                       OR b.customer_payment_terms LIKE 'เช็คล่วงหน้า%'), false) AS c
    FROM base b
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
  -- คีย์แต่ละตัวถูกซื้อล่าสุดเมื่อไหร่ + เป็นเครดิตไหม (รวมทุกบริษัทที่ถือคีย์นี้)
  SELECT ek.kind, ek.k, max(ol.d) AS d, bool_or(oc.c) AS c
    FROM ent_keys ek
    JOIN own_last   ol ON ol.company_id = ek.company_id
    JOIN own_credit oc ON oc.company_id = ek.company_id
   GROUP BY ek.kind, ek.k
),
ent_last AS (
  -- แล้วกระจายกลับ: บริษัทหนึ่งได้วันล่าสุด/สถานะเครดิตของคีย์ที่ตัวเองถืออยู่ทุกตัว
  SELECT ek.company_id, max(kl.d) AS d, COALESCE(bool_or(kl.c), false) AS c
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
  -- ไม่ใช่ลูกค้าเครดิต → NULL ตั้งแต่ต้นทาง ด่านจึงไม่ต้องรู้เรื่องเงื่อนไขการชำระเงินเลย
  -- (own_credit/own_last เผื่อบริษัทที่ไม่มีคีย์เลยสักตัว = ไม่มีแถวใน ent_last)
  -- GREATEST ข้าม NULL ให้เอง
  CASE WHEN COALESCE(ent_last.c, own_credit.c, false)
       THEN GREATEST(own_last.d, ent_last.d)
  END                                                            AS last_order_at
FROM base b
LEFT JOIN comp       ON comp.company_id       = b.company_id
LEFT JOIN own_last   ON own_last.company_id   = b.company_id
LEFT JOIN own_credit ON own_credit.company_id = b.company_id
LEFT JOIN ent_last   ON ent_last.company_id   = b.company_id;

-- ── build ตารางใหม่จากนิยามใหม่ (ไม่ล็อกของเดิม คนอ่านยังใช้ตารางเก่าได้ตลอด) ──
-- ขั้นตอนตรงนี้ต้องตรงกับ scripts/sync/refreshCustomerDirectory.ts ทุกบรรทัด
-- (ชื่อ index / default_statistics_target / ลำดับ ANALYZE) ไม่งั้น sync รอบถัดไปจะสร้าง
-- ตารางที่หน้าตาไม่เหมือนของที่ migration นี้ทิ้งไว้
DROP TABLE IF EXISTS public.customers_data_view_new;
CREATE TABLE public.customers_data_view_new AS SELECT * FROM public.customers_data_build;

CREATE UNIQUE INDEX idx_cdv_new_company_contact ON public.customers_data_view_new (company_id, contact_id);
CREATE INDEX        idx_cdv_new_company         ON public.customers_data_view_new (company_id) INCLUDE (last_order_at);

SET LOCAL default_statistics_target = 10;
ANALYZE public.customers_data_view_new;
SET LOCAL default_statistics_target = 100;
ANALYZE public.customers_data_view_new (company_id, contact_id);

-- guard: ตารางว่าง = นิยามพัง — ล้มทั้งไฟล์ ตารางเดิมที่ใช้งานได้อยู่จะไม่ถูกแตะ
DO $guard$
DECLARE n bigint; n_credit bigint;
BEGIN
  SELECT count(*) INTO n FROM public.customers_data_view_new;
  IF n = 0 THEN
    RAISE EXCEPTION 'build ได้ 0 แถว — นิยาม view พัง ยกเลิกทั้งหมด ตารางเดิมยังอยู่ครบ';
  END IF;

  -- guard 2: ต้องมีบริษัทที่ last_order_at ไม่เป็น NULL เหลืออยู่จริง
  -- ถ้าเป็น 0 แปลว่าเงื่อนไขเครดิตเขียนกลับด้าน (bool_or คืน NULL แล้วโดน COALESCE เป็น false
  -- ทั้งฐาน) ซึ่งจะทำให้ด่านตรวจกลายเป็น "ไม่บล็อกใครเลย" อย่างเงียบสนิท
  SELECT count(DISTINCT company_id) INTO n_credit
    FROM public.customers_data_view_new WHERE last_order_at IS NOT NULL;
  IF n_credit = 0 THEN
    RAISE EXCEPTION 'ไม่มีบริษัทไหนได้ last_order_at เลย — เงื่อนไขเครดิตกลับด้าน ยกเลิกทั้งหมด';
  END IF;

  RAISE NOTICE 'build ใหม่ % แถว · บริษัทที่อยู่ในขอบเขตตรวจเครดิต %', n, n_credit;
END $guard$;

-- ── สลับชื่อ ──
DROP TABLE IF EXISTS public.customers_data_view;
ALTER TABLE public.customers_data_view_new RENAME TO customers_data_view;
ALTER INDEX idx_cdv_new_company_contact RENAME TO idx_cdv_company_contact;
ALTER INDEX idx_cdv_new_company         RENAME TO idx_cdv_company;

-- watermark ไม่ต้องแตะ: ข้อมูลต้นทางไม่ได้เปลี่ยน (เปลี่ยนแค่นิยาม) และเราเพิ่ง rebuild ให้แล้ว
-- → sync รอบหน้าจะข้ามอย่างถูกต้อง ส่วน refreshed_at/row_count อัปเดตให้ตรงความจริง
UPDATE public.customers_data_view_state
   SET refreshed_at = NOW(),
       row_count    = (SELECT count(*) FROM public.customers_data_view)
 WHERE id = 1;

COMMIT;
