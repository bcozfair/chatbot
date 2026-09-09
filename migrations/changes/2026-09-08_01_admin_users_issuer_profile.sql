-- โปรไฟล์ "ผู้เสนอราคา" ของแอดมิน — เฟส B2 ของ docs/plan-web-quote-request.md §2.8
--
-- สองคอลัมน์นี้อยู่ไฟล์เดียวกันเพราะเป็นของโปรไฟล์ชุดเดียวกันและมาพร้อมกันในเฟสเดียว
-- ทั้งคู่ NULL ได้ และ NULL มีความหมายชัดเจนทั้งคู่ (ไม่ใช่ "ยังไม่รู้")

-- เบอร์ของผู้จัดทำคนนี้ ตามที่มีจริงใน sale_orders.employee_quotations_phone ของชื่อเดียวกัน
-- เขียนพร้อมกับ employee_quotation_id เสมอ (services/webIdentity.ts: setAdminQuotationMaker)
-- ห้ามมี path อื่นเขียนคอลัมน์นี้ ไม่งั้นจะมีใบที่ชื่อกับเบอร์ไม่ใช่ของคนเดียวกัน
-- NULL = ชื่อนั้นไม่มีเบอร์ในข้อมูล (วัดแล้วมี 2 ชื่อจาก 70) → PDF ไม่พิมพ์บรรทัดเบอร์
ALTER TABLE public.admin_users ADD COLUMN IF NOT EXISTS employee_quotation_phone character varying(64);

-- กุญแจไฟล์ลายเซ็นของแอดมิน = ชื่อไฟล์ใน data/admin_sigs/<key>.{png,jpg,jpeg}
-- เป็น hex 12 ตัวสุ่ม ไม่ใช่ admin_id เพราะ /data ถูก express.static เสิร์ฟโดยไม่มี auth
-- ⇒ ชื่อไฟล์ที่เดาได้ = ลายเซ็นถูกดูดออกไปได้ด้วยการไล่เลข (§2.5)
-- NULL = ยังไม่เคยอัปโหลดลายเซ็น → ออกใบได้ปกติ ใบจะไม่มีลายเซ็นช่องผู้เสนอราคา
ALTER TABLE public.admin_users ADD COLUMN IF NOT EXISTS signature_key character varying(32);
