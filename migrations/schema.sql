--
-- PostgreSQL database dump
--
-- Baseline schema ของ chatbot_primus สร้างจาก pg_dump --schema-only ของ DB จริง
-- ใช้ไฟล์นี้ตั้ง DB ใหม่ตั้งแต่ศูนย์ แทนการไล่รัน migration ทีละไฟล์
-- migration เดิมย้ายไปเก็บที่ migrations/archive/ เพื่ออ้างอิงประวัติเท่านั้น
--
-- หมายเหตุ: บรรทัด \restrict / \unrestrict ที่ pg_dump 18 ใส่มาถูกตัดออก
-- เพราะเป็น meta-command ของ psql ทำให้รันผ่าน pg driver (runMigration.ts) ไม่ได้
-- และไม่ได้ใส่ `COMMENT ON SCHEMA public IS ''` ที่ pg_dump ของ DB จริงพ่นออกมา (เป็นคอมเมนต์
-- ว่างเปล่า ไม่มีผลต่อโครงสร้าง)
--
-- ตรวจว่าไฟล์นี้ยังตรงกับ DB จริง (ปลอดภัย — สร้าง DB เปล่าชื่อ schema_check ไม่แตะ chatbot_primus):
--   d() { docker compose exec -T db pg_dump -U postgres -d "$1" --schema-only --no-owner --no-privileges \
--         | grep -v '^\\restrict\|^\\unrestrict\|^-- Dumped'; }   # 3 บรรทัดนี้ต่างกันทุกครั้งโดยธรรมชาติ
--   docker compose exec -T db psql -U postgres -d postgres -q -c 'DROP DATABASE IF EXISTS schema_check' -c 'CREATE DATABASE schema_check'
--   docker compose exec -T db psql -U postgres -d schema_check -v ON_ERROR_STOP=1 -q -f - < migrations/schema.sql
--   diff <(d chatbot_primus) <(d schema_check)
--   docker compose exec -T db psql -U postgres -d postgres -q -c 'DROP DATABASE schema_check'
--
-- ผลที่ถูกต้อง = ต่างแค่ก้อน `COMMENT ON SCHEMA public` ข้างบนก้อนเดียว
-- ถ้าต่างมากกว่านั้น แปลว่ามี migration ที่ยังไม่ถูกยุบเข้าไฟล์นี้
-- ตรวจล่าสุด 2026-08-25 (ผ่าน — ยุบ 2026-08-25_01 นิยาม last_order_at ใหม่ + 2026-08-25_02 ปลดโหมด warn เข้าไปแล้ว)
-- ก่อนหน้า 2026-08-21 (รอบนั้นพบว่าขาด quotation_counters, sync_settings, index 6 ตัว
-- และ role 'subadmin' — ยุบเข้าครบแล้ว)
--
-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    name character varying(100) NOT NULL,
    role character varying(20) DEFAULT 'admin'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT admin_users_role_check CHECK (role IN ('admin', 'subadmin', 'user'))
);


--
-- Name: admin_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_users_id_seq OWNED BY public.admin_users.id;


--
-- Name: api_logs; Type: TABLE; Schema: public; Owner: -
--

-- บันทึกการเรียก API ทุกครั้ง (ใครเรียกอะไร ได้ status อะไร ใช้เวลาเท่าไหร่)
-- จงใจไม่เก็บ request body — ดูเหตุผลเต็มใน migrations/changes/2026-08-10_01_api_logs.sql
-- route เก็บเฉพาะที่ Express บอกมาเป็น string ไม่บอกก็ NULL (จัดกลุ่มตอนอ่านแทน)
-- inflight/db_waiting/queue_waited_ms = ตัวเลขสำหรับวิเคราะห์ทรัพยากร
CREATE TABLE public.api_logs (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    request_id character varying(16) NOT NULL,
    method character varying(6) NOT NULL,
    route character varying(120),
    path character varying(200) NOT NULL,
    status_code smallint NOT NULL,
    duration_ms integer NOT NULL,
    resp_bytes integer,
    admin_user_id integer,
    line_user_id character varying(40),
    inflight smallint,
    db_waiting smallint,
    queue_waited_ms integer,
    ip character varying(45)
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.01');


--
-- Name: api_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_logs_id_seq OWNED BY public.api_logs.id;


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    company_id integer CONSTRAINT customers_company_id_not_null1 NOT NULL,
    contact_id integer CONSTRAINT customers_contact_id_not_null1 NOT NULL,
    sync_updated_at timestamp with time zone,
    company_updated_at timestamp with time zone,
    contact_updated_at timestamp with time zone,
    customer_reference text,
    customer_tax_id text,
    customer_name text,
    contact_name text,
    contact_mobile text,
    contact_phone text,
    contact_email text,
    invoice_street text,
    invoice_district text,
    invoice_sub_district text,
    invoice_state text,
    invoice_zip text,
    salesperson text,
    salesperson_phone text,
    sales_team text,
    customer_sale_area text,
    customer_type text,
    tags text,
    industry_type text,
    customer_payment_terms text,
    main_income text,
    company_capital numeric DEFAULT 0,
    source_name text,
    customer_status text,
    phone text,
    mobile text,
    email text,
    fax text,
    website_link text,
    line text,
    facebook text,
    company_employee text,
    special text,
    language text,
    referred_by text,
    business_type text,
    zone text,
    opportunity_to_buy text,
    branch text,
    customer_no_tax_id boolean,
    type text,
    grade text,
    date_last timestamp with time zone,
    date_paid timestamp with time zone,
    to_envelope text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: sale_orders; Type: TABLE; Schema: public; Owner: -
--
-- 1 แถว = 1 เอกสารขายของ Odoo (sync ตัดให้เหลือรายการสินค้าแรกรายการเดียว) — PK คือ
-- order_reference ซึ่ง Odoo "เปลี่ยนได้" ตอนยืนยันใบเสนอราคา (QP-xxx → OP-xxx) sync เป็น
-- upsert ล้วนไม่เคยลบแถว แถวชื่อเก่าจึงค้างอยู่เป็นซากที่ไม่ถูกอัปเดตอีก และของจริงคือแถว
-- ที่ last_updated ใหม่กว่าภายใต้ sale_order_id เดียวกัน (sale_order_id ไม่เปลี่ยนตามชื่อ)
--
-- สถานะมี 2 ชั้นคนละความหมาย: order_status = สถานะเอกสาร (Quotation/Approved/Locked/
-- Cancelled/Demo Order) · invoice_status = ตั้งบิลหรือยัง (no/to invoice/invoiced)
--

CREATE TABLE public.sale_orders (
    order_reference character varying(255) CONSTRAINT sale_orders_order_reference_not_null1 NOT NULL,
    customer_reference text,
    customer_tax_id text,
    customer_name text,
    contact_name text,
    contact_mobile text,
    contact_phone text,
    invoice_street text,
    invoice_district text,
    invoice_sub_district text,
    invoice_state text,
    invoice_zip text,
    order_date timestamp with time zone,
    customer_reference_po text,
    delivery_street text,
    delivery_district text,
    delivery_sub_district text,
    delivery_state text,
    delivery_zip text,
    employee_quotations text,
    employee_quotations_phone text,
    salesperson text,
    salesperson_phone text,
    sales_team text,
    customer_sale_area text,
    invoice_status text,
    last_updated timestamp with time zone,
    sale_order_id integer,
    company_id integer,
    contact_id integer,
    salesperson_id integer,
    total_amount numeric,
    total_discount numeric,
    amount_after_discount numeric,
    vat numeric,
    net_amount numeric,
    model text DEFAULT 'N/A'::text NOT NULL,
    model_code character varying(255) DEFAULT 'N/A'::character varying NOT NULL,
    quantity numeric,
    product_category text,
    product_group text,
    product_sub_category text,
    product_series text,
    order_status text,
    invoice_date timestamp with time zone,
    source text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Phase 3 (2026-07-23): customers_view + contacts_view ถูกปลดแล้ว (migration 2026-07-23_02)
-- ทุก query ลูกค้า/ผู้ติดต่ออ่านจาก customers_data_view (ตารางด้านล่าง) แทน
--


--
-- Name: clean_text; Type: FUNCTION; Schema: public; Owner: -
-- trim + แปลง 'null'/'' เป็น NULL จริง (ใช้โดย customers_data_view)
--

CREATE OR REPLACE FUNCTION public.clean_text(v text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT CASE WHEN lower(btrim(v)) = ANY (ARRAY['null', '']) THEN NULL ELSE btrim(v) END $$;


--
-- Name: customers_data_build / customers_data_view; Type: VIEW + TABLE; Schema: public; Owner: -
-- 1 แถว/ผู้ติดต่อ รวมข้อมูลลูกค้าครบสำหรับใบเสนอราคา normalize จาก customers (หลัก) + sale_orders
-- Arm1=customers contact_id>=0 (รวมบริษัทไม่มีผู้ติดต่อ) ; Arm2=sale_orders orphan +enrich via tax_id
-- comp=company-level propagation (sale_area/district/sub_district)
--
-- ⚠️ customers_data_view เป็น "ตารางจริง" ไม่ใช่ materialized view (migration 2026-08-06_01)
--    customers_data_build = view ที่เก็บนิยาม · scripts/sync/refreshCustomerDirectory.ts สร้างตาราง
--    ใหม่จาก view นี้แล้วสลับชื่อ (build+swap) หลัง sync — ห้ามสั่ง REFRESH MATERIALIZED VIEW
--

CREATE INDEX IF NOT EXISTS idx_sale_orders_contact_order ON public.sale_orders (contact_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_customers_contact_id ON public.customers (contact_id);
CREATE INDEX IF NOT EXISTS idx_customers_tax_id ON public.customers (customer_tax_id);

-- ── index สำหรับ LATERAL `own` ของ Arm 2 ──
-- เงื่อนไขเทียบเป็น btrim(...) จึงต้องเป็น expression index ไม่งั้น Arm 2 ตกไป seq scan
-- ทุกแถว (4,365 ครั้ง/รอบ refresh)
CREATE INDEX IF NOT EXISTS idx_customers_reference_trimmed ON public.customers (btrim(customer_reference));

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

-- ════════════════════════════════════════════════════════════════════
-- แปลง customers_data_view: MATERIALIZED VIEW -> ตารางจริง
-- (rerun ได้ — ถ้าเป็นตารางอยู่แล้วก็สร้างใหม่ทับ)
--
-- ครอบด้วย transaction เดียว: ระหว่างทำ คนอ่านจะ "รอ" ~3 วิแล้วได้ข้อมูล
-- ถ้าไม่ครอบ จะมีช่วงที่ตารางหายจริง ๆ → บอทที่ยิง query พอดีจะได้ error
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- plain view customers_data (2026-07-23_03) ถูกปลดแล้วใน 2026-08-06_02 — มีไว้เพื่อให้ TablePlus
-- เห็น matview เท่านั้น ตอนนี้ customers_data_view เป็นตารางจริงจึงโผล่ในโฟลเดอร์ Tables อยู่แล้ว
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
-- INCLUDE (last_order_at) = ด่านตรวจเครดิตอ่านวันที่ซื้อล่าสุดจบใน index ไม่ต้องแตะ heap
-- (ต้องตรงกับที่ scripts/sync/refreshCustomerDirectory.ts สร้างตอน build+swap)
CREATE INDEX        idx_cdv_company         ON public.customers_data_view (company_id) INCLUDE (last_order_at);

-- ANALYZE เต็มรูปแบบตารางนี้ใช้ 7.3 วิ (คอลัมน์ text ไทยต้อง sort 30,000 ตัวอย่างด้วย collation ไทย
-- ต่อคอลัมน์ — วัดแยก: customer_name อย่างเดียว 5.1 วิ) → ลด sample ของคอลัมน์ text เหลือ target 10
-- แล้วเก็บละเอียดเฉพาะ 2 คอลัมน์ที่เป็นคีย์ของทุก query. ต้องตรงกับ refreshCustomerDirectory.ts
SET LOCAL default_statistics_target = 10;
ANALYZE public.customers_data_view;
SET LOCAL default_statistics_target = 100;
ANALYZE public.customers_data_view (company_id, contact_id);

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


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id text,
    message_id text,
    type text,
    content text,
    reply_token text,
    reply_content text
);


--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.messages ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: product_moq_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_moq_rules (
    internal_reference text NOT NULL,
    min_order_qty integer NOT NULL,
    sale_line_warn_msg text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT product_moq_rules_min_order_qty_check CHECK ((min_order_qty > 0))
);


--
-- Name: product_optional_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_optional_links (
    id integer NOT NULL,
    trigger_product_id text NOT NULL,
    optional_product_id text NOT NULL,
    is_active boolean DEFAULT true,
    note text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: product_optional_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_optional_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_optional_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_optional_links_id_seq OWNED BY public.product_optional_links.id;


--
-- Name: product_stock_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_stock_rules (
    internal_reference text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    product_template_id integer NOT NULL,
    sync_updated_at timestamp with time zone,
    sequence integer,
    internal_reference text,
    name text,
    brand text,
    series text,
    model text,
    sales_price numeric,
    minimum_sales_price numeric,
    product_group text,
    product_category text,
    product_sub_category text,
    production text,
    quantity_on_hand numeric DEFAULT 0,
    quantity_on_hand_unreserved numeric DEFAULT 0,
    actual_quantity numeric DEFAULT 0,
    incoming numeric DEFAULT 0,
    outgoing numeric DEFAULT 0,
    unit_of_measure text,
    costing_method text,
    activity_exception_decoration text,
    optional_products text,
    sales_description text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    is_system_item boolean DEFAULT false NOT NULL
);


--
-- Name: promotions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promotions (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    discount_type character varying(20) NOT NULL,
    discount_value numeric(10,2) NOT NULL,
    product_code text,
    customer_type text,
    min_qty integer DEFAULT 0 NOT NULL,
    start_date timestamp with time zone,
    end_date timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    customer_refs text
);


--
-- Name: promotions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.promotions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: promotions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.promotions_id_seq OWNED BY public.promotions.id;


--
-- Name: quotation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotation_rules (
    id integer NOT NULL,
    production text,
    brand text,
    series text,
    warranty_years integer DEFAULT 1 NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    delivery_in_stock_days integer DEFAULT 3 NOT NULL,
    delivery_out_of_stock_days integer DEFAULT 7 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    warranty_unit character varying(10) DEFAULT 'year'::character varying NOT NULL,
    quote_company character varying(10) DEFAULT NULL::character varying,
    delivery_days_qty_10 integer,
    delivery_days_qty_20 integer,
    delivery_days_qty_50 integer,
    delivery_days_qty_100 integer,
    CONSTRAINT quotation_rules_quote_company_check CHECK (((quote_company)::text = ANY ((ARRAY['PM'::character varying, 'THT'::character varying])::text[]))),
    CONSTRAINT quotation_rules_warranty_unit_check CHECK (((warranty_unit)::text = ANY ((ARRAY['month'::character varying, 'year'::character varying])::text[]))),
    CONSTRAINT quotation_rules_delivery_qty_days_check CHECK (
        ((delivery_days_qty_10 IS NULL) OR (delivery_days_qty_10 >= 0)) AND
        ((delivery_days_qty_20 IS NULL) OR (delivery_days_qty_20 >= 0)) AND
        ((delivery_days_qty_50 IS NULL) OR (delivery_days_qty_50 >= 0)) AND
        ((delivery_days_qty_100 IS NULL) OR (delivery_days_qty_100 >= 0))
    )
);


--
-- Name: quotation_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quotation_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quotation_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quotation_rules_id_seq OWNED BY public.quotation_rules.id;


--
-- Name: quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id character varying(255),
    total_sum numeric(15,2) DEFAULT 0.00,
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    quotation_no character varying(100),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    customer_details jsonb,
    item_details jsonb,
    salesperson_id character varying(255),
    employee_details jsonb,
    customer_id integer,
    contact_id integer,
    delivery_days_override integer,
    odoo_exported_at timestamp with time zone,
    delivery_type_override text,
    delivery_terms jsonb,
    print_snapshot jsonb,
    -- สถานะ "นำเข้า Odoo แล้ว" — snapshot เขียนครั้งเดียวตอนรอบ sync เห็นใบนี้ใน sale_orders ครั้งแรก
    -- (ห้าม join สดกับ sale_orders.order_reference: Odoo เปลี่ยนชื่อเอกสารตอนยืนยัน แถวชื่อ Q* เป็นซาก
    --  ที่วันหนึ่งจะหายไป → สถานะจะเด้งกลับจาก "นำเข้าแล้ว" เป็น "รอนำเข้า" เอง)
    odoo_imported_at timestamp with time zone,
    -- id ของเอกสารในฐาน Odoo — ไม่เปลี่ยนแม้เอกสารถูกเปลี่ยนชื่อ ใช้เป็นสมอตามหาสถานะปัจจุบันได้
    odoo_so_id integer,
    CONSTRAINT quotations_delivery_days_override_check CHECK (
        (delivery_days_override IS NULL)
        OR ((delivery_days_override >= 0) AND (delivery_days_override <= 3650))
    ),
    CONSTRAINT quotations_delivery_type_override_check CHECK (
        (delivery_type_override IS NULL)
        OR (delivery_type_override = ANY (ARRAY['in_stock'::text, 'make_to_order'::text, 'import'::text, 'install'::text]))
    )
);


--
-- Name: quotation_blacklist; Type: TABLE; Schema: public; Owner: -
--
-- บัญชีห้ามเสนอราคา — contact_id NULL = ทั้งบริษัท / มีค่า = เฉพาะผู้ติดต่อรายนั้น
-- เก็บ id ดิบของ customers_data_view ไม่มี FK ไป customers เพราะตารางนั้นถูก sync ทับจาก Odoo
-- ค่า 0 ห้ามเข้า contact_id (ใน view แปลว่า "บริษัทที่ไม่มีผู้ติดต่อ" — จะซ้ำความหมายกับ NULL)
--

CREATE TABLE public.quotation_blacklist (
    id          serial PRIMARY KEY,
    company_id  integer NOT NULL,
    contact_id  integer,
    reason      text,
    created_by  integer,
    created_at  timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at  timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT quotation_blacklist_company_id_check CHECK (company_id > 0),
    CONSTRAINT quotation_blacklist_contact_id_check CHECK (contact_id IS NULL OR contact_id > 0)
);

-- แยก 2 index เพราะ NULL ไม่ชนกันเองใน unique index ปกติ
CREATE UNIQUE INDEX quotation_blacklist_company_uniq
    ON public.quotation_blacklist (company_id) WHERE contact_id IS NULL;

CREATE UNIQUE INDEX quotation_blacklist_contact_uniq
    ON public.quotation_blacklist (company_id, contact_id) WHERE contact_id IS NOT NULL;


--
-- Name: quotation_credit_policy; Type: TABLE; Schema: public; Owner: -
--
-- เกณฑ์ระงับการเสนอราคาบริษัทที่ไม่มีคำสั่งซื้อมานาน (แถวเดียว)
-- ตัวข้อมูล "ซื้อล่าสุดเมื่อไหร่" อยู่ที่ customers_data_view.last_order_at ไม่ใช่ที่นี่
-- แยกกันเพราะ customers_data_view ถูกสร้างใหม่ทั้งก้อนทุกรอบ sync — ค่าที่แอดมินตั้งจะหาย
-- mode: off = ไม่ตรวจ · block = ห้ามออกใบ (หน้าแอดมินเป็นสวิตช์ เปิด/ปิด)
-- เคยมีค่าที่ 3 คือ 'warn' (ตรวจ+log แต่ยังออกใบได้) — ปลดออกแล้ว 2026-08-25_02
--

CREATE TABLE public.quotation_credit_policy (
    id              integer PRIMARY KEY DEFAULT 1,
    mode            text    DEFAULT 'off' NOT NULL,
    dormant_months  integer DEFAULT 12 NOT NULL,
    updated_at      timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by      integer,
    CONSTRAINT quotation_credit_policy_single_row CHECK (id = 1),
    CONSTRAINT quotation_credit_policy_mode CHECK (mode = ANY (ARRAY['off', 'block'])),
    CONSTRAINT quotation_credit_policy_months CHECK (dormant_months > 0 AND dormant_months <= 240)
);

INSERT INTO public.quotation_credit_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


--
-- Name: quotation_counters; Type: TABLE; Schema: public; Owner: -
--
-- ตัวนับเลขที่ใบเสนอราคาแบบ atomic (migration 2026-07-20_02) — services/quotationService.ts
-- ใช้ INSERT ... ON CONFLICT DO UPDATE ... RETURNING แทน COUNT-then-INSERT ที่ race กันได้
-- counter_key: 'QP:2607' = เลขปกติ prefix QP งวด YYMM · 'REV:QP-260705012' = เลขใบฉบับแก้ไข
--
-- ⚠️ ไม่มีที่ไหนสร้างตารางนี้ให้ตอน runtime — DB ใหม่ที่ไม่มีตารางนี้จะออกเลขใบไม่ได้เลย
--    (ต่างจาก sync_state/sync_settings/customers/products ที่โค้ด sync สร้างเองตอน boot)
--

CREATE TABLE public.quotation_counters (
    counter_key text PRIMARY KEY,
    last_seq integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: quotation_export_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotation_export_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exported_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    exported_by_id integer,
    exported_by_username text,
    format text NOT NULL,
    quotation_count integer DEFAULT 0 NOT NULL,
    row_count integer DEFAULT 0 NOT NULL,
    filters jsonb
);


--
-- Name: quotation_export_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotation_export_log (
    id bigint NOT NULL,
    batch_id uuid NOT NULL,
    quotation_id uuid,
    quotation_no character varying(100),
    exported_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    reverted_at timestamp with time zone
);


--
-- Name: quotation_export_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quotation_export_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quotation_export_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quotation_export_log_id_seq OWNED BY public.quotation_export_log.id;


--
-- Name: salesperson; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salesperson (
    user_id character varying(255) NOT NULL,
    name character varying(255) DEFAULT 'รอดำเนินการ'::character varying NOT NULL,
    status character varying(255) DEFAULT 'pending_branch'::character varying NOT NULL,
    phone character varying(100),
    salesperson_id character varying(50),
    branch character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    employee_quotation_id character varying(255)
);


--
-- Name: shipping_fee_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipping_fee_config (
    id integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    threshold_before_vat numeric(15,2) DEFAULT 1000 NOT NULL,
    fee_price numeric(15,2) DEFAULT 200 NOT NULL,
    fee_quantity numeric(15,2) DEFAULT 1 NOT NULL,
    default_item_name text DEFAULT 'ค่าขนส่ง'::text NOT NULL,
    product_internal_reference text DEFAULT 'SOFBLDXXXX0010'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT shipping_fee_config_name CHECK ((btrim(default_item_name) <> ''::text)),
    CONSTRAINT shipping_fee_config_price CHECK ((fee_price >= (0)::numeric)),
    CONSTRAINT shipping_fee_config_qty CHECK ((fee_quantity > (0)::numeric)),
    CONSTRAINT shipping_fee_config_ref CHECK ((btrim(product_internal_reference) <> ''::text)),
    CONSTRAINT shipping_fee_config_single_row CHECK ((id = 1)),
    CONSTRAINT shipping_fee_config_threshold CHECK ((threshold_before_vat >= (0)::numeric))
);


--
-- Name: sync_settings; Type: TABLE; Schema: public; Owner: -
--
-- ตารางเวลา auto-sync แถวเดียว (id=1) — services/syncService.ts อ่านตอน boot
-- โค้ดสร้าง/เติมคอลัมน์ตารางนี้เองด้วย (ensureSyncSettingsTable) แต่เก็บไว้ที่นี่ด้วย
-- เพื่อให้ DB ที่ตั้งจากไฟล์นี้มีโครงตรงกับ DB จริงตั้งแต่ก่อน app สตาร์ต
--

CREATE TABLE public.sync_settings (
    id integer PRIMARY KEY DEFAULT 1,
    auto_enabled boolean DEFAULT false NOT NULL,
    resources text[] DEFAULT ARRAY['products'::text, 'customers'::text, 'saleorders'::text] NOT NULL,
    updated_at timestamp with time zone,
    days integer[] DEFAULT '{0,1,2,3,4,5,6}'::integer[] NOT NULL,
    window_start text DEFAULT '00:00'::text NOT NULL,
    window_end text DEFAULT '23:59'::text NOT NULL,
    interval_seconds integer DEFAULT 900 NOT NULL,
    CONSTRAINT sync_settings_singleton CHECK ((id = 1))
);

INSERT INTO public.sync_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


--
-- Name: sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_state (
    resource character varying(50) NOT NULL,
    sync_cursor text,
    last_success_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    sync_cursor_timestamp text,
    sync_mode text DEFAULT 'full'::text NOT NULL,
    pages_synced integer DEFAULT 0 NOT NULL,
    records_synced integer DEFAULT 0 NOT NULL,
    last_status text,
    last_run_at timestamp with time zone,
    last_error text,
    last_error_at timestamp with time zone
);


--
-- Name: admin_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users ALTER COLUMN id SET DEFAULT nextval('public.admin_users_id_seq'::regclass);


--
-- Name: api_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_logs ALTER COLUMN id SET DEFAULT nextval('public.api_logs_id_seq'::regclass);


--
-- Name: product_optional_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_optional_links ALTER COLUMN id SET DEFAULT nextval('public.product_optional_links_id_seq'::regclass);


--
-- Name: promotions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotions ALTER COLUMN id SET DEFAULT nextval('public.promotions_id_seq'::regclass);


--
-- Name: quotation_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_rules ALTER COLUMN id SET DEFAULT nextval('public.quotation_rules_id_seq'::regclass);


--
-- Name: quotation_export_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_export_log ALTER COLUMN id SET DEFAULT nextval('public.quotation_export_log_id_seq'::regclass);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: admin_users admin_users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_username_key UNIQUE (username);


--
-- Name: api_logs api_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_logs
    ADD CONSTRAINT api_logs_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey1 PRIMARY KEY (company_id, contact_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: product_moq_rules product_moq_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_moq_rules
    ADD CONSTRAINT product_moq_rules_pkey PRIMARY KEY (internal_reference);


--
-- Name: product_optional_links product_optional_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_optional_links
    ADD CONSTRAINT product_optional_links_pkey PRIMARY KEY (id);


--
-- Name: product_optional_links product_optional_links_trigger_product_id_optional_product__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_optional_links
    ADD CONSTRAINT product_optional_links_trigger_product_id_optional_product__key UNIQUE (trigger_product_id, optional_product_id);


--
-- Name: product_stock_rules product_stock_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_stock_rules
    ADD CONSTRAINT product_stock_rules_pkey PRIMARY KEY (internal_reference);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (product_template_id);


--
-- Name: promotions promotions_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_code_key UNIQUE (code);


--
-- Name: promotions promotions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_pkey PRIMARY KEY (id);


--
-- Name: quotation_rules quotation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_rules
    ADD CONSTRAINT quotation_rules_pkey PRIMARY KEY (id);


--
-- Name: quotations quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_pkey PRIMARY KEY (id);


--
-- Name: quotation_export_batches quotation_export_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_export_batches
    ADD CONSTRAINT quotation_export_batches_pkey PRIMARY KEY (id);


--
-- Name: quotation_export_log quotation_export_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_export_log
    ADD CONSTRAINT quotation_export_log_pkey PRIMARY KEY (id);


--
-- Name: sale_orders sale_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_orders
    ADD CONSTRAINT sale_orders_pkey PRIMARY KEY (order_reference);


--
-- Name: salesperson salesperson_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salesperson
    ADD CONSTRAINT salesperson_pkey PRIMARY KEY (user_id);


--
-- Name: shipping_fee_config shipping_fee_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_fee_config
    ADD CONSTRAINT shipping_fee_config_pkey PRIMARY KEY (id);


--
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (resource);


--
-- Name: idx_api_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_logs_created_at ON public.api_logs USING btree (created_at DESC, id DESC);


--
-- Name: idx_api_logs_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_logs_request_id ON public.api_logs USING btree (request_id);


--
-- Name: idx_optional_links_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_optional_links_trigger ON public.product_optional_links USING btree (trigger_product_id);


--
-- Name: idx_products_is_system_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_is_system_item ON public.products USING btree (is_system_item) WHERE (is_system_item = true);


--
-- Name: idx_products_model_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_model_trgm ON public.products USING gin (model public.gin_trgm_ops);


--
-- Name: idx_products_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_name_trgm ON public.products USING gin (name public.gin_trgm_ops);


--
-- Name: idx_products_ref_trgm / idx_products_brand_trgm / idx_products_template_id_text; Type: INDEX
--
-- GET /api/products/search มี WHERE เป็น OR คร่อม 5 branch — Postgres ทำ BitmapOr ได้ก็ต่อเมื่อ
-- *ทุก* branch indexable ไม่งั้นตกไป Seq Scan ทั้งชุด (199-322 ms/คำค้น → DB CPU ตันตอน
-- concurrency สูง → HTTP 500) · ตัวที่ 3 เป็น expression index เพราะ branch นั้นเทียบ
-- product_template_id::text ซึ่ง products_pkey ใช้ไม่ได้
-- ⚠️ บน DB ที่มีข้อมูลแล้วให้สร้างด้วย CREATE INDEX CONCURRENTLY ผ่าน psql (ห้าม runMigration.ts)
--

CREATE INDEX idx_products_ref_trgm ON public.products USING gin (internal_reference public.gin_trgm_ops);

CREATE INDEX idx_products_brand_trgm ON public.products USING gin (brand public.gin_trgm_ops);

CREATE INDEX idx_products_template_id_text ON public.products USING btree (((product_template_id)::text));


--
-- Name: idx_products_internal_reference; Type: INDEX; Schema: public; Owner: -
--
-- internal_reference เป็น key ที่ใช้ join จริงหลายที่ (stock-rules, products/search, productService)
-- ตรวจแล้วว่าไม่ซ้ำในข้อมูลจริง จึงเป็น UNIQUE เพื่อกันข้อมูล sync ซ้ำด้วย
-- ค่าว่าง '' ถือเป็นค่าปกติใน Postgres (ไม่เหมือน NULL) จึงต้องกรองออกด้วย partial index
--

CREATE UNIQUE INDEX idx_products_internal_reference ON public.products USING btree (internal_reference) WHERE ((internal_reference IS NOT NULL) AND (TRIM(BOTH FROM internal_reference) <> ''::text));


--
-- Name: idx_so_salesperson_cover; Type: INDEX; Schema: public; Owner: -
--
-- listSalespeopleFromOrders() ใน db/repositories.ts: DISTINCT ON (salesperson) ... ORDER BY
-- salesperson, order_date DESC — ก่อนมี index คือ Seq Scan 382MB + external sort 30MB = ~7 วิ
-- ซึ่งใกล้ statement_timeout 15 วิ พอชนเพดานฟังก์ชันนี้จะ return [] เงียบ ๆ แล้ว POST ลงทะเบียน
-- พนักงานขายจะปฏิเสธทุกคนโดยไม่มี error โผล่ที่ไหน
-- ⚠️ INCLUDE จำเป็น — index ธรรมดา (salesperson, order_date DESC) planner ไม่เลือกใช้เลย
--    (วัดแล้ว: ยัง Seq Scan 7.2-8.7 วิ) ต้องครบทุกคอลัมน์ที่ query ใช้จึงได้ Index Only Scan
--

CREATE INDEX idx_so_salesperson_cover ON public.sale_orders USING btree (salesperson, order_date DESC) INCLUDE (salesperson_id, salesperson_phone, customer_sale_area, sales_team);


--
-- Name: idx_messages_user_created; Type: INDEX; Schema: public; Owner: -
--
-- getRecentMessages() ใน db/repositories.ts: WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
-- ถูกเรียกทุกข้อความในเส้นทาง /callback (async) — ก่อนมี index คือ Seq Scan ทั้งตารางทุกครั้ง
-- (seq_scan 3,821 / idx_scan 0 / seq_tup_read 12.4M เพื่อคืนแค่ 10 แถว) วัดได้ 2.0 ms / 414 buffers
-- หลังสร้าง: Index Scan หยิบ 10 แถวแรกจาก index ตรง ๆ ไม่ต้อง sort = 0.046 ms / 6 buffers
-- ไม่ใส่ INCLUDE (content, reply_content) เพราะเป็น text ยาว จะทำให้ index ใหญ่กว่าตารางเอง
-- และทำให้ INSERT ทุกข้อความแพงขึ้น — query นี้ LIMIT 10 ตาม pointer ไป heap แค่ 10 แถวถูกกว่ามาก
--

CREATE INDEX idx_messages_user_created ON public.messages USING btree (user_id, created_at DESC);


--
-- Name: idx_quotations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_status ON public.quotations USING btree (status);


--
-- Name: idx_quotations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_user_id ON public.quotations USING btree (user_id);


--
-- Name: uq_quotations_quotation_no; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_quotations_quotation_no ON public.quotations USING btree (quotation_no) WHERE ((quotation_no IS NOT NULL) AND ((quotation_no)::text <> ''::text));


--
-- Name: idx_quotations_not_exported; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_not_exported ON public.quotations USING btree (created_at DESC) WHERE (odoo_exported_at IS NULL);


--
-- Name: idx_quotations_odoo_exported_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_odoo_exported_at ON public.quotations USING btree (odoo_exported_at);


--
-- Name: idx_quotation_export_log_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_export_log_batch ON public.quotation_export_log USING btree (batch_id);


--
-- Name: idx_quotation_export_log_quotation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_export_log_quotation ON public.quotation_export_log USING btree (quotation_id);


--
-- Name: quotations quotations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.salesperson(user_id) ON DELETE SET NULL;


--
-- Name: quotation_export_log quotation_export_log_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_export_log
    ADD CONSTRAINT quotation_export_log_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.quotation_export_batches(id) ON DELETE CASCADE;


--
-- Name: quotation_export_log quotation_export_log_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_export_log
    ADD CONSTRAINT quotation_export_log_quotation_id_fkey FOREIGN KEY (quotation_id) REFERENCES public.quotations(id) ON DELETE SET NULL;


--
-- Name: quotation_blacklist quotation_blacklist_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--
-- FK 2 ตัวนี้ต้องอยู่ตรงนี้ ไม่ใช่ในตัว CREATE TABLE — admin_users_pkey ถูกสร้างในหมวด
-- CONSTRAINT ด้านบน ซึ่งอยู่หลัง CREATE TABLE ทุกตัว ถ้าเขียน REFERENCES ไว้ในตาราง
-- ไฟล์นี้จะล้มตอนตั้ง DB ใหม่จากศูนย์ ("no unique constraint matching given keys")
--

ALTER TABLE ONLY public.quotation_blacklist
    ADD CONSTRAINT quotation_blacklist_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- Name: quotation_credit_policy quotation_credit_policy_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_credit_policy
    ADD CONSTRAINT quotation_credit_policy_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

