-- Phase 3: ปลด customers_view + contacts_view (legacy)
-- โค้ดทุกจุดถูก repoint ไป customers_data_view แล้ว (db/repositories.ts, handlers/lineHandler.ts,
--   services/quotationService.ts, utils/flexTemplates.ts, scripts/evalCustomerSearch.ts)
-- ยืนยันแล้วว่าไม่มี view/matview อื่นใน DB พึ่งพา 2 ตัวนี้ (pg_depend เช็คว่าง)
-- customers_data_view = source of truth เดียวสำหรับ query ลูกค้า/ผู้ติดต่อ
--
-- rollback: re-create จาก git history ของ migrations/schema.sql (บล็อก CREATE VIEW เดิม) ถ้าจำเป็น

DROP VIEW IF EXISTS public.contacts_view;
DROP VIEW IF EXISTS public.customers_view;
