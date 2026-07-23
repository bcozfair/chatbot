-- customers_data — plain view ครอบ matview customers_data_view (มีไว้เปิดดูใน DB tool เท่านั้น)
--
-- ทำไม: customers_data_view เป็น MATERIALIZED VIEW ซึ่ง TablePlus ไม่แสดงใน sidebar
--   (TablePlus สร้าง tree จาก information_schema ที่ไม่รวม matview) → เปิดคลิกดูไม่ได้
--   plain view โผล่ใน information_schema.views → เห็นในโฟลเดอร์ "Views" ของ TablePlus คลิกดูข้อมูลได้
--
-- ปลอดภัย/ไม่กระทบ app:
--   - app ทุกจุดยัง query customers_data_view (matview, มี index → 1ms) โดยตรงเหมือนเดิม
--   - view นี้ไม่มี code ใดเรียก — มีไว้ "ดู" เฉย ๆ; อ่านทะลุ matview → สดตาม matview เสมอ ไม่มี staleness เพิ่ม
--   - read-only ล้วน ไม่เก็บข้อมูลซ้ำ ไม่กินพื้นที่ ไม่ต้องแตะ sync/refresh
--   ⚠️ ห้ามใช้ view นี้ใน app code — app ต้องชี้ customers_data_view (matview) โดยตรง

CREATE OR REPLACE VIEW public.customers_data AS
  SELECT * FROM public.customers_data_view;

COMMENT ON VIEW public.customers_data IS
  'plain view ครอบ matview customers_data_view — มีไว้เปิดดูใน DB tool (TablePlus ไม่โชว์ matview); ห้ามใช้ใน app code, app ต้อง query customers_data_view (matview) โดยตรง';
