-- 1. ล้างข้อมูลทั้งหมดในตาราง sale_orders (เนื่องจากการ Delete หาตัวซ้ำรันช้ามากบนข้อมูลจำนวนมาก)
TRUNCATE TABLE sale_orders;

-- 2. ลบ Primary Key constraint เดิม
ALTER TABLE sale_orders DROP CONSTRAINT IF EXISTS sale_orders_pkey1;

-- 3. เพิ่ม Primary Key constraint ใหม่ โดยใช้เฉพาะ order_reference
ALTER TABLE sale_orders ADD PRIMARY KEY (order_reference);

-- 4. รีเซ็ตสถานะการ Sync ใน sync_state เพื่อเริ่มดึงข้อมูลใหม่ทั้งหมดตั้งแต่ต้น (Full Sync)
UPDATE sync_state 
SET sync_cursor = NULL, 
    sync_cursor_timestamp = NULL, 
    sync_mode = 'full', 
    pages_synced = 0, 
    records_synced = 0 
WHERE resource = 'sale_order';
