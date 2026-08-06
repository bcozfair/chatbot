-- บัญชีห้ามเสนอราคา (blacklist) — บล็อกได้ทั้งระดับบริษัทและระดับผู้ติดต่อ
--
-- ตารางนี้เก็บ id ดิบของ customers_data_view (company_id / contact_id) แล้ว join ตอนอ่าน
-- เพื่อโชว์ชื่อ — **ไม่ใส่ FK ไป customers** เพราะตารางนั้นถูก sync ทับจาก Odoo เป็นรอบ
-- FK จะทำให้ sync ล้ม หรือรายการ blacklist หายไปโดยไม่ตั้งใจ
--
-- created_by มี FK ไป admin_users ได้ เพราะเป็นข้อมูลของระบบเราเอง ไม่ถูก sync ทับ
-- (admin_users = ตารางผู้ใช้ Admin Portal ทั้งหมด ไม่ได้มีแต่ role 'admin' — ดู 2026-08-06_01)
-- ON DELETE SET NULL = ลบผู้ใช้แล้วรายการ blacklist ยังอยู่ แค่ไม่รู้ว่าใครเป็นคนเพิ่ม
--
-- contact_id NULL = บล็อกทั้งบริษัท / มีค่า = บล็อกเฉพาะผู้ติดต่อรายนั้น
-- ค่า 0 ห้ามเข้าตารางนี้: ใน customers_data_view แถว contact_id = 0 คือ "บริษัทที่ไม่มีผู้ติดต่อ"
-- ถ้าปล่อยให้เก็บ 0 ได้ จะมี 2 วิธีเขียน "ทั้งบริษัท" (NULL กับ 0) ซึ่ง unique index กันซ้ำไม่ได้

CREATE TABLE IF NOT EXISTS public.quotation_blacklist (
    id          serial PRIMARY KEY,
    company_id  integer NOT NULL,
    contact_id  integer,
    reason      text,
    created_by  integer REFERENCES public.admin_users(id) ON DELETE SET NULL,
    created_at  timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at  timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT quotation_blacklist_company_id_check CHECK (company_id > 0),
    CONSTRAINT quotation_blacklist_contact_id_check CHECK (contact_id IS NULL OR contact_id > 0)
);

-- กันเพิ่มซ้ำ — ต้องแยกเป็น 2 index เพราะ NULL ไม่ชนกันเองใน unique index ปกติ
-- (ถ้าใช้ index เดียวบน (company_id, contact_id) จะเพิ่ม "บล็อกทั้งบริษัท" ซ้ำได้ไม่จำกัด)
CREATE UNIQUE INDEX IF NOT EXISTS quotation_blacklist_company_uniq
    ON public.quotation_blacklist (company_id) WHERE contact_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS quotation_blacklist_contact_uniq
    ON public.quotation_blacklist (company_id, contact_id) WHERE contact_id IS NOT NULL;
