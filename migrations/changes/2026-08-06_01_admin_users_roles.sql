-- ระบบผู้ใช้และสิทธิ์ของ Admin Portal — เตรียม role ให้มีผลจริง
--
-- คอลัมน์ admin_users.role มีอยู่แล้วตั้งแต่แรก (default 'admin') แต่ไม่เคยมี CHECK
-- ทำให้ใส่ค่าอะไรก็ได้ ไฟล์นี้ล็อกให้เหลือ 2 ค่าตามที่ระบบรองรับจริง: admin กับ user
--   admin = เข้าถึงและจัดการได้ทุกอย่าง รวมถึงจัดการผู้ใช้คนอื่น
--   user  = สิทธิ์จำกัด (ยังไม่มีเมนูของตัวเองจนกว่าฟีเจอร์ blacklist จะเสร็จ)
--
-- pgcrypto ใช้ตั้ง/กู้รหัสผ่านด้วย SQL ตอนล็อกตัวเองออกจากระบบหรือ DB ยังไม่มี admin สักคน
-- (password_hash เป็น bcrypt — พิมพ์รหัสผ่านดิบลงไปตรง ๆ ไม่ได้ ต้องผ่าน crypt())
--   UPDATE admin_users SET password_hash = crypt('รหัสใหม่', gen_salt('bf', 10)) WHERE username = 'admin';
-- gen_salt('bf', N) ให้ hash ขึ้นต้น $2a$ ซึ่ง bcryptjs ฝั่งแอปตรวจผ่าน

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ต้องล้างค่าที่ไม่เข้าพวกก่อน ไม่งั้น ADD CONSTRAINT ล้มทั้งไฟล์
UPDATE public.admin_users
SET role = 'admin'
WHERE role IS NULL OR role NOT IN ('admin', 'user');

-- DROP ก่อน ADD เพื่อให้รันไฟล์นี้ซ้ำได้โดยไม่ error
ALTER TABLE public.admin_users
  DROP CONSTRAINT IF EXISTS admin_users_role_check;

ALTER TABLE public.admin_users
  ADD CONSTRAINT admin_users_role_check CHECK (role IN ('admin', 'user'));
