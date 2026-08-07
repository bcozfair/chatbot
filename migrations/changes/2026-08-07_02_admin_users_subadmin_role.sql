-- เพิ่ม role ที่ 3 ของ Admin Portal: subadmin
--
--   admin    = เข้าถึงและจัดการได้ทุกอย่าง รวมถึงจัดการผู้ใช้คนอื่น
--   subadmin = เข้าได้เฉพาะหน้าประวัติใบเสนอราคา (ดู/กรอง/ส่งออก Odoo/ถอยเครื่องหมายส่งออก)
--   user     = เข้าได้เฉพาะหน้าบัญชีห้ามเสนอราคา
--
-- constraint นี้ผ่อนคลายกว่าเดิม (2 ค่า -> 3 ค่า) ข้อมูลเดิมผ่านทั้งหมด จึงไม่ต้อง UPDATE ล้างค่าก่อน
--
-- ต้องรันไฟล์นี้ "ก่อน" deploy โค้ดชุดที่รองรับ subadmin — ถ้าสลับลำดับ แอดมินที่เลือกสิทธิ์
-- subadmin ในหน้าจัดการผู้ใช้จะโดน CHECK ปฏิเสธแล้วได้ 500 กลับไป

-- DROP ก่อน ADD เพื่อให้รันไฟล์นี้ซ้ำได้โดยไม่ error
ALTER TABLE public.admin_users
  DROP CONSTRAINT IF EXISTS admin_users_role_check;

ALTER TABLE public.admin_users
  ADD CONSTRAINT admin_users_role_check CHECK (role IN ('admin', 'subadmin', 'user'));
