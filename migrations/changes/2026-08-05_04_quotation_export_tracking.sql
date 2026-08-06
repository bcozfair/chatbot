-- ─────────────────────────────────────────────────────────────────────────────
--  จำว่าใบเสนอราคาใบไหนถูก export ไป Odoo แล้ว เพื่อไม่ให้ส่งออกซ้ำ
--
--  ที่มา: ปุ่ม "ส่งออก Odoo" เดิมส่งออก "ทุกใบที่มีเลขที่ใบเสนอราคา" ทุกครั้งที่กด ระบบไม่มีที่จำว่า
--    ใบไหนเคยนำเข้า Odoo ไปแล้ว แอดมินจึงต้องไล่ตัดใบเก่าทิ้งเองใน Excel ก่อนนำเข้า พลาดเมื่อไหร่
--    ก็ได้ Sale Order ซ้ำใน Odoo
--
--  โครงที่เลือก = คอลัมน์ + log แยก (2 ชั้น):
--    - quotations.odoo_exported_at  → คอลัมน์กรองเร็ว ตอบคำถาม "ใบนี้ส่งไปแล้วหรือยัง" ด้วย index เดียว
--    - quotation_export_batches     → 1 แถวต่อ 1 ครั้งที่กดปุ่ม (ใคร/เมื่อไหร่/format/ตัวกรองที่ใช้)
--    - quotation_export_log         → 1 แถวต่อ 1 ใบในชุดนั้น ไว้ตรวจย้อนหลังว่าใบนี้ไปกับไฟล์ไหน
--  ไม่ยุบเหลือชั้นเดียวเพราะ: มีแต่คอลัมน์ = ไม่รู้ว่าใบไปกับไฟล์ไหน / มีแต่ log = ต้อง JOIN ทุกครั้งที่กรอง
--
--  การยกเลิกเครื่องหมาย (นำเข้า Odoo ไม่ผ่าน) ใช้วิธี set odoo_exported_at = NULL แล้วประทับ
--  reverted_at ใน log — ไม่ลบแถว log ทิ้ง เพราะประวัติว่า "เคยส่งแล้วถอย" คือข้อมูลที่ต้องตรวจได้
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-08-05_04_quotation_export_tracking.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

-- NULL = ยังไม่เคยส่งออก (ใบเก่าทั้งหมดตอนติดตั้งจะเป็น NULL = ยังไม่ส่ง — ตั้งใจให้เป็นแบบนั้น
-- ไม่เดา backfill ให้ เพราะไม่มีข้อมูลว่าใบไหนเคยนำเข้า Odoo ไปแล้วจริง ๆ)
ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS odoo_exported_at timestamptz;

-- 1 แถว = 1 ครั้งที่กดปุ่มส่งออก
CREATE TABLE IF NOT EXISTS public.quotation_export_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exported_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exported_by_id       integer,
  exported_by_username text,
  format               text NOT NULL,
  quotation_count      integer NOT NULL DEFAULT 0,
  row_count            integer NOT NULL DEFAULT 0,
  filters              jsonb
);

-- 1 แถว = 1 ใบเสนอราคาในชุดนั้น
CREATE TABLE IF NOT EXISTS public.quotation_export_log (
  id           bigserial PRIMARY KEY,
  batch_id     uuid NOT NULL REFERENCES public.quotation_export_batches(id) ON DELETE CASCADE,
  quotation_id uuid REFERENCES public.quotations(id) ON DELETE SET NULL,
  quotation_no character varying(100),
  exported_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reverted_at  timestamptz
);

-- path ที่ใช้บ่อยที่สุด: ตัวกรองตั้งต้น "ยังไม่ส่งออก" + เรียง created_at DESC
CREATE INDEX IF NOT EXISTS idx_quotations_not_exported
  ON public.quotations (created_at DESC) WHERE odoo_exported_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_quotations_odoo_exported_at
  ON public.quotations (odoo_exported_at);

CREATE INDEX IF NOT EXISTS idx_quotation_export_log_quotation
  ON public.quotation_export_log (quotation_id);

CREATE INDEX IF NOT EXISTS idx_quotation_export_log_batch
  ON public.quotation_export_log (batch_id);
