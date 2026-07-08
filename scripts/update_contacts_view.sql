-- SQL script to recreate contacts_view with sale_orders fallback (handling 'null' text strings)
CREATE OR REPLACE VIEW contacts_view AS
WITH latest_so AS (
    SELECT DISTINCT ON (contact_id)
        contact_id,
        contact_name,
        contact_mobile,
        contact_phone,
        invoice_street,
        invoice_district,
        invoice_sub_district,
        invoice_state,
        invoice_zip
    FROM sale_orders
    WHERE contact_id IS NOT NULL AND contact_id > 0
    ORDER BY contact_id, order_date DESC
)
SELECT 
    c.contact_id AS id,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.contact_name)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.contact_name) END,
        CASE WHEN LOWER(TRIM(BOTH FROM so.contact_name)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM so.contact_name) END
    ) AS name,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.contact_mobile)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.contact_mobile) END,
        CASE WHEN LOWER(TRIM(BOTH FROM so.contact_mobile)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM so.contact_mobile) END
    ) AS mobile,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.contact_phone)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.contact_phone) END,
        CASE WHEN LOWER(TRIM(BOTH FROM so.contact_phone)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM so.contact_phone) END,
        CASE WHEN LOWER(TRIM(BOTH FROM c.phone)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.phone) END
    ) AS phone,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.contact_email)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.contact_email) END,
        CASE WHEN LOWER(TRIM(BOTH FROM c.email)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.email) END
    ) AS email,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.invoice_street)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.invoice_street) END,
        CASE WHEN LOWER(TRIM(BOTH FROM so.invoice_street)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM so.invoice_street) END
    ) AS invoice_street,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.invoice_district)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.invoice_district) END,
        CASE WHEN LOWER(TRIM(BOTH FROM so.invoice_district)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM so.invoice_district) END
    ) AS invoice_district,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.invoice_sub_district)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.invoice_sub_district) END,
        CASE WHEN LOWER(TRIM(BOTH FROM so.invoice_sub_district)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM so.invoice_sub_district) END
    ) AS invoice_sub_district,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.invoice_state)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.invoice_state) END,
        CASE WHEN LOWER(TRIM(BOTH FROM so.invoice_state)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM so.invoice_state) END
    ) AS invoice_state,
    COALESCE(
        CASE WHEN LOWER(TRIM(BOTH FROM c.invoice_zip)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM c.invoice_zip) END,
        CASE WHEN LOWER(TRIM(BOTH FROM so.invoice_zip)) IN ('null', '') THEN NULL ELSE TRIM(BOTH FROM so.invoice_zip) END
    ) AS invoice_zip,
    c.company_id AS customer_id
FROM customers c
LEFT JOIN latest_so so ON c.contact_id = so.contact_id
WHERE c.contact_id > 0;
