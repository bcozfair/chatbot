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
-- Name: contacts_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.contacts_view AS
 WITH latest_so AS (
         SELECT DISTINCT ON (sale_orders.contact_id) sale_orders.contact_id,
            sale_orders.contact_name,
            sale_orders.contact_mobile,
            sale_orders.contact_phone,
            sale_orders.invoice_street,
            sale_orders.invoice_district,
            sale_orders.invoice_sub_district,
            sale_orders.invoice_state,
            sale_orders.invoice_zip
           FROM public.sale_orders
          WHERE ((sale_orders.contact_id IS NOT NULL) AND (sale_orders.contact_id > 0))
          ORDER BY sale_orders.contact_id, sale_orders.order_date DESC
        )
 SELECT c.contact_id AS id,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.contact_name)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.contact_name)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM so.contact_name)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM so.contact_name)
        END) AS name,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.contact_mobile)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.contact_mobile)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM so.contact_mobile)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM so.contact_mobile)
        END) AS mobile,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.contact_phone)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.contact_phone)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM so.contact_phone)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM so.contact_phone)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM c.phone)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.phone)
        END) AS phone,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.contact_email)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.contact_email)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM c.email)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.email)
        END) AS email,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.invoice_street)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.invoice_street)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM so.invoice_street)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM so.invoice_street)
        END) AS invoice_street,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.invoice_district)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.invoice_district)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM so.invoice_district)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM so.invoice_district)
        END) AS invoice_district,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.invoice_sub_district)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.invoice_sub_district)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM so.invoice_sub_district)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM so.invoice_sub_district)
        END) AS invoice_sub_district,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.invoice_state)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.invoice_state)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM so.invoice_state)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM so.invoice_state)
        END) AS invoice_state,
    COALESCE(
        CASE
            WHEN (lower(TRIM(BOTH FROM c.invoice_zip)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM c.invoice_zip)
        END,
        CASE
            WHEN (lower(TRIM(BOTH FROM so.invoice_zip)) = ANY (ARRAY['null'::text, ''::text])) THEN NULL::text
            ELSE TRIM(BOTH FROM so.invoice_zip)
        END) AS invoice_zip,
    c.company_id AS customer_id
   FROM (public.customers c
     LEFT JOIN latest_so so ON ((c.contact_id = so.contact_id)))
  WHERE (c.contact_id > 0);


--
-- Name: customers_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.customers_view AS
 SELECT DISTINCT ON (company_id) company_id AS id,
    TRIM(BOTH FROM customer_name) AS display_name,
    TRIM(BOTH FROM customer_reference) AS reference,
    TRIM(BOTH FROM customer_tax_id) AS tax_id,
    TRIM(BOTH FROM phone) AS phone,
    TRIM(BOTH FROM email) AS email,
    TRIM(BOTH FROM customer_sale_area) AS branch,
    TRIM(BOTH FROM salesperson) AS salesperson,
    TRIM(BOTH FROM customer_type) AS customer_type,
    TRIM(BOTH FROM customer_payment_terms) AS customer_payment_terms
   FROM public.customers
  ORDER BY company_id, contact_id;


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
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
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
    CONSTRAINT quotation_rules_quote_company_check CHECK (((quote_company)::text = ANY ((ARRAY['PM'::character varying, 'THT'::character varying])::text[]))),
    CONSTRAINT quotation_rules_warranty_unit_check CHECK (((warranty_unit)::text = ANY ((ARRAY['month'::character varying, 'year'::character varying])::text[])))
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
    contact_id integer
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
    employee_quotations character varying(255) DEFAULT 'ชื่อแอดมิน'::character varying,
    employee_quotations_phone character varying(100) DEFAULT 'เบอร์โทร'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
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
    records_synced integer DEFAULT 0 NOT NULL
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
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (resource);


--
-- Name: idx_optional_links_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_optional_links_trigger ON public.product_optional_links USING btree (trigger_product_id);


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

