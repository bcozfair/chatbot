--
-- PostgreSQL database dump
--
-- Baseline schema ของ chatbot_primus สร้างจาก pg_dump --schema-only ของ DB จริง
-- ใช้ไฟล์นี้ตั้ง DB ใหม่ตั้งแต่ศูนย์ แทนการไล่รัน migration ทีละไฟล์
-- migration เดิมย้ายไปเก็บที่ migrations/archive/ เพื่ออ้างอิงประวัติเท่านั้น
--
-- หมายเหตุ: บรรทัด \restrict / \unrestrict ที่ pg_dump 18 ใส่มาถูกตัดออก
-- เพราะเป็น meta-command ของ psql ทำให้รันผ่าน pg driver (runMigration.ts) ไม่ได้
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
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
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
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

--
-- Phase 3 (2026-07-23): customers_view + contacts_view ถูกปลดแล้ว (migration 2026-07-23_02)
-- ทุก query ลูกค้า/ผู้ติดต่ออ่านจาก customers_data_view (materialized view ด้านล่าง) แทน
--


--
-- Name: clean_text; Type: FUNCTION; Schema: public; Owner: -
-- trim + แปลง 'null'/'' เป็น NULL จริง (ใช้โดย customers_data_view)
--

CREATE OR REPLACE FUNCTION public.clean_text(v text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT CASE WHEN lower(btrim(v)) = ANY (ARRAY['null', '']) THEN NULL ELSE btrim(v) END $$;


--
-- Name: customers_data_view; Type: MATERIALIZED VIEW; Schema: public; Owner: -
-- 1 แถว/ผู้ติดต่อ รวมข้อมูลลูกค้าครบสำหรับใบเสนอราคา normalize จาก customers (หลัก) + sale_orders
-- Arm1=customers contact_id>=0 (รวมบริษัทไม่มีผู้ติดต่อ) ; Arm2=sale_orders orphan +enrich via tax_id
-- comp=company-level propagation (sale_area/district/sub_district) ; REFRESH หลัง sync (services/syncService.ts)
--

CREATE INDEX IF NOT EXISTS idx_sale_orders_contact_order ON public.sale_orders (contact_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_customers_contact_id ON public.customers (contact_id);
CREATE INDEX IF NOT EXISTS idx_customers_tax_id ON public.customers (customer_tax_id);

CREATE MATERIALIZED VIEW public.customers_data_view AS
WITH latest_so AS (
  SELECT DISTINCT ON (contact_id)
    contact_id, customer_name, customer_reference, customer_tax_id,
    contact_name, contact_mobile, contact_phone, customer_sale_area, salesperson,
    invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip
  FROM public.sale_orders
  WHERE contact_id IS NOT NULL AND contact_id > 0
  ORDER BY contact_id, order_date DESC NULLS LAST
),
base AS (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_cdv_company_contact ON public.customers_data_view (company_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_cdv_company ON public.customers_data_view (company_id);


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
    CONSTRAINT quotations_delivery_days_override_check CHECK (
        (delivery_days_override IS NULL)
        OR ((delivery_days_override >= 0) AND (delivery_days_override <= 3650))
    )
);


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
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
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
-- Name: quotations quotations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.salesperson(user_id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

