-- ─────────────────────────────────────────────────────────────────────────────
--  API ดึงข้อมูลออกไปให้ระบบภายนอก (NUC-Kay) sync — ฝั่งปลายทางเป็นคนเรียกเข้ามา
--
--  ทำไมต้อง "ให้เขาดึง" ไม่ใช่ "เรายิงไปให้":
--    NUC อยู่ 192.168.109.69 คนละ subnet กับเครื่องนี้ (192.168.100.17) และยิง TCP ไม่ถึง
--    แต่เครื่องนี้มี subdomain สาธารณะ (APP_URL) ที่ IT ทำ reverse proxy + HTTPS ไว้แล้ว
--    → ปลายทางเปิด outbound HTTPS อย่างเดียวก็ sync ได้ ไม่ต้องลากสาย ไม่ต้องเปิดพอร์ตเพิ่มทั้งสองฝั่ง
--
--  ไฟล์นี้สร้างของใหม่ล้วน + เพิ่ม index เท่านั้น ไม่ ALTER ตารางเดิม ไม่แตะข้อมูล
--
--  ⚠️ ต้องรันผ่าน psql เท่านั้น ห้ามผ่าน scripts/runMigration.ts — CREATE INDEX CONCURRENTLY
--     อยู่ใน transaction ไม่ได้ (runMigration.ts ยิงทั้งไฟล์เป็น query เดียว = transaction เดียว)
--     ที่ต้อง CONCURRENTLY เพราะ CREATE INDEX ธรรมดาบล็อกการเขียน sale_orders ทั้งตารางระหว่างสร้าง
--     และ auto-sync ของโปรเจกต์นี้เขียนตารางนั้นทุก 10 นาทีอยู่แล้ว
--
--  รัน: docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1 \
--         -f - < migrations/changes/2026-09-02_05_sync_api.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════
--  กุญแจของเครื่องปลายทาง
--
--  ที่ไม่ใช้ JWT แอดมินซ้ำ: token แอดมินอายุ 24 ชม. เพิกถอนไม่ได้ และผูกกับ "คน" ที่มีสิทธิ์
--  เขียนข้อมูล การเอาไปฝังในเครื่องปลายทางที่เราคุมไม่ได้ = ยกสิทธิ์แอดมินให้เครื่องนั้นทั้งดุ้น
--  กุญแจในตารางนี้ทำได้อย่างเดียวคือ "อ่านผ่าน /api/sync/v1/*" ปิดได้ทันทีรายตัว และจำกัดตารางได้
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.sync_api_keys (
  id             serial       PRIMARY KEY,
  name           varchar(80)  NOT NULL,
  key_prefix     varchar(16)  NOT NULL,
  key_hash       char(64)     NOT NULL UNIQUE,
  allowed_tables text[],
  is_active      boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by     varchar(80),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  note           text
);

-- คำอธิบายคอลัมน์ที่ไม่ชัดในตัวเอง (ไม่ใช้ COMMENT ON COLUMN ตามกติกาของโปรเจกต์):
--   key_prefix     8 ตัวแรกของกุญแจ เก็บไว้เพื่อ "ชี้ตัวได้โดยไม่ต้องรู้กุญแจ" — เวลาปลายทางแจ้งว่า
--                  ใช้กุญแจไหนอยู่ หรือเห็นใน log ว่ากุญแจไหนยิงเข้ามา จะได้ไม่ต้องเดา
--   key_hash       sha256 ของกุญแจเต็ม (hex 64) — ตัวกุญแจจริงไม่มีอยู่ใน DB เลย
--                  ถ้าปลายทางทำหาย = ออกใหม่ ไม่มีทาง "ขอดูของเดิม" (เจตนา)
--   allowed_tables NULL = ทุกตารางที่ registry เปิดไว้ · ใส่ array = เฉพาะที่ระบุ
--                  เผื่อวันหน้ามีปลายทางที่ 2 ที่ควรเห็นแค่บางตาราง ไม่ต้องรื้อโครง
--   revoked_at     เพิกถอนแล้วเก็บแถวไว้ ไม่ลบทิ้ง — เพื่อให้ยังตอบได้ว่ากุญแจที่เคยยิงเข้ามาคือของใคร

-- ════════════════════════════════════════════════════════════════════
--  index สำหรับ keyset pagination ของ 4 ตารางโหมด incremental
--
--  query ที่ต้องรองรับคือ  WHERE (updated_at, <pk>) > ($1, $2) ORDER BY updated_at, <pk> LIMIT n
--  index คอลัมน์เดียวที่มีอยู่เดิม (idx_sale_orders_updated_at ฯลฯ) คัดช่วงได้ก็จริง แต่ยังต้อง sort
--  ทุกหน้า และที่สำคัญกว่า: ตัด tie ของ timestamp ที่ซ้ำกันไม่ได้ ซึ่งคือจุดที่ข้อมูล "หายเงียบ"
--  (upsert ทีละ batch → หลายพันแถวได้ updated_at = NOW() ค่าเดียวกันเป๊ะ ถ้าแบ่งหน้าตรงกลางกอง
--   ด้วย timestamp อย่างเดียว แถวที่เหลือของกองนั้นจะถูกข้ามไปตลอดกาล)
-- ════════════════════════════════════════════════════════════════════
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_orders_sync_cursor
  ON public.sale_orders (updated_at, order_reference);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customers_sync_cursor
  ON public.customers (updated_at, company_id, contact_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_sync_cursor
  ON public.products (updated_at, product_template_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quotations_sync_cursor
  ON public.quotations (updated_at, id);
