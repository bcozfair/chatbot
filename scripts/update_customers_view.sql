-- SQL script to recreate customers_view
-- customers เก็บข้อมูลแบบ denormalized: 1 บริษัท มีได้หลาย row (1 row = 1 contact)
-- View นี้ deduplicate ให้เหลือ 1 row ต่อ 1 company_id
-- โดยเลือก contact_id ที่น้อยที่สุด (contact_id แรก = row ของบริษัทหลัก)
CREATE OR REPLACE VIEW customers_view AS
SELECT DISTINCT ON (company_id)
    company_id                              AS id,
    TRIM(BOTH FROM customer_name)           AS display_name,
    TRIM(BOTH FROM customer_reference)      AS reference,
    TRIM(BOTH FROM customer_tax_id)         AS tax_id,
    TRIM(BOTH FROM phone)                   AS phone,
    TRIM(BOTH FROM email)                   AS email,
    TRIM(BOTH FROM customer_sale_area)      AS branch,
    TRIM(BOTH FROM salesperson)             AS salesperson,
    TRIM(BOTH FROM customer_type)           AS customer_type
FROM customers
ORDER BY company_id, contact_id;
