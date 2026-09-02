-- ─────────────────────────────────────────────────────────────────────────────
--  เก็บ 3 field ที่ gateway ส่งมาแล้วแต่ sync ทิ้งไป — Status / Invoice Date / Source
--
--  payload ของ /api/odoo/sale_order_updated_records_v2 มี 46 field ต่อแถว แต่
--  upsertSaleOrderRows() เก็บลงตารางแค่ 43 — ที่หายไปคือ 3 ตัวนี้ ซึ่งเป็นข้อมูลที่
--  ตอบคำถามที่ตารางเดิมตอบไม่ได้
--
--  order_status ('Status')  = สถานะ workflow ของเอกสารฝั่ง Odoo
--      Quotation → Approved → Locked (ยืนยันแล้ว) และแตกเป็น Cancelled / Demo Order
--      ต่างจาก invoice_status ที่เดิมมีอยู่ ซึ่งบอกแค่ "ตั้งบิลแล้วหรือยัง" (no/to invoice/invoiced)
--      ⚠️ ตั้งชื่อว่า order_status ไม่ใช่ status ตรง ๆ เพราะต้องอ่านคู่กับ invoice_status
--         ที่อยู่ติดกันแล้วแยกออกทันทีว่าตัวไหนคือสถานะอะไร
--
--  invoice_date ('Invoice Date') = วันที่ออกบิลจริง (ส่วนใหญ่เป็น NULL)
--
--  source ('Source') = ช่องทางที่ออเดอร์เข้ามา — ค่าจริงที่พบ: Sales, Admin (E-Mail),
--      PO ลูกค้า, Marketing (Line OA), Sales (แจ้งเปิดบิล), Branch Manager, Admin (Line),
--      Specialist, Admin (Tel.), Marketing (E-Mail)
--      ⚠️ ไฟล์นำเข้า Odoo ของเรากรอกช่องนี้เป็น "Sales" ตายตัว (ODOO_EXPORT_SOURCE)
--         ค่านี้จึงแยก "ออเดอร์ที่มาจากแชทบอท" ออกจากออเดอร์ที่เซลล์สร้างเองไม่ได้
--
--  ⚠️ แถวเก่าทั้ง 316k แถวจะเป็น NULL จนกว่า Odoo จะแก้เอกสารนั้นแล้ว sync รอบ incremental
--     ดึงมาทับ — ถ้าอยากได้ครบทันทีต้องสั่ง full sync (npm run sync:saleorders -- --full)
--     ซึ่งกวาดใหม่ทั้งฐานตั้งแต่ 1970 ควรทำนอกเวลาทำการ
--
--  ADD COLUMN แบบ nullable ไม่มี DEFAULT = PostgreSQL แก้แค่ metadata ไม่เขียนแถวใหม่
--  รันได้ทันทีตอนระบบเปิดอยู่ ไม่ล็อกตารางค้าง ไม่กระทบ traffic
--
--  ไม่ทำ index ให้ — ยังไม่มีหน้าจอไหนคัดด้วย 3 คอลัมน์นี้ และทุก index คือต้นทุนของทุกรอบ
--  sync ที่ upsert ทีละแถว ถ้าวันหน้าต้องคัดจริงค่อยเพิ่ม CREATE INDEX CONCURRENTLY ทีหลังได้
--
--  รัน (ตาม DEPLOY.md ข้อ 4 — ใช้ psql ไม่ใช่ runMigration.ts):
--    docker exec -i primus-chatbot-db-1 psql -U postgres -d chatbot_primus \
--      < migrations/changes/2026-09-02_02_sale_orders_status_source.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.sale_orders
  ADD COLUMN IF NOT EXISTS order_status text,
  ADD COLUMN IF NOT EXISTS invoice_date timestamp with time zone,
  ADD COLUMN IF NOT EXISTS source       text;
