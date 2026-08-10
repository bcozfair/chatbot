-- ─────────────────────────────────────────────────────────────────────────────
--  บันทึกการเรียก API ทุกครั้ง เพื่อตอบ 2 คำถามที่ตอนนี้ตอบไม่ได้เลย
--    1. "ใครทำอะไร"        — user ไหนเรียก endpoint ไหน เมื่อไหร่ ได้ status อะไร
--    2. "ช้าตรงไหน/ทรัพยากรพอไหม" — endpoint ไหนกินเวลา ช่วงไหนโหลดหนัก pool ตันไหม
--
--  ที่มา: ของเดิมมีแต่ console.log(">>> POST ... received!") กระจายราย route ซึ่งไม่มี status code
--    ไม่มี duration ไม่มีตัวตนผู้เรียก แล้วตกไปอยู่ใน docker json-file ที่หมุนทิ้ง (max-size 10m x 5)
--    จน query ย้อนหลังไม่ได้ ส่วน quotation_export_log ที่เป็น audit จริงก็ครอบแค่การ export ใบเสนอราคา
--
--  ⚠️ ทำไมไม่เก็บ request body — เป็นการตัดสินใจหลักของดีไซน์นี้
--    body คือคอลัมน์ที่ใหญ่ที่สุด (~70% ของขนาดแถว) เป็นตัวเดียวที่ต้องใช้ CPU เดิน redact ทุก request
--    และเป็นตัวที่ลาก PII (ชื่อ/เบอร์ลูกค้า, ข้อความแชท LINE) เข้ามาทั้งหมด
--    แต่ไม่จำเป็นกับคำถามทั้งสองข้อ: "ใครทำอะไร" ตอบด้วย actor+method+path, "ช้าตรงไหน" ตอบด้วย duration+route
--    ผลคือแถวละ ~175 ไบต์แทน ~570 และตารางนี้ไม่มี PII เลย (เก็บแค่ id กับ path)
--    ถ้าวันหน้าจำเป็นจริง ๆ ค่อย ADD COLUMN request_body jsonb ทีหลังได้ ไม่ต้องรื้อของเดิม
--
--  สิ่งที่จงใจไม่ทำ:
--    - ไม่ index actor/status/route — 30 วันที่ 5,000 req/วัน = 150k แถว การกรองในหน้าต่าง 7 วัน
--      คือสแกน ~35k แถวที่ index เวลาคัดมาแล้ว = หลักสิบ ms · ทุก index ที่เพิ่มคือต้นทุนของทุก insert
--      ถ้าช้าค่อยเพิ่มทีหลังด้วย CREATE INDEX CONCURRENTLY (ทำตอนระบบเปิดอยู่ได้)
--    - ไม่ partition — เกณฑ์ที่ควรย้าย: เกิน ~5M แถว หรือ pg_total_relation_size เกิน 3 GB
--      (ไกลมากที่ retention 30 วัน — ที่ 20,000 req/วัน ยังอยู่แค่ ~153 MB)
--
--  ไฟล์นี้สร้างของใหม่ล้วน ไม่ ALTER ตารางเดิม ไม่แตะ matview → รันตอนระบบเปิดอยู่ได้ จบในไม่กี่ ms
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-08-10_01_api_logs.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_logs (
  id              bigserial     PRIMARY KEY,
  created_at      timestamptz   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_id      varchar(16)   NOT NULL,
  method          varchar(6)    NOT NULL,
  route           varchar(120),
  path            varchar(200)  NOT NULL,
  status_code     smallint      NOT NULL,
  duration_ms     integer       NOT NULL,
  resp_bytes      integer,
  admin_user_id   integer,
  line_user_id    varchar(40),
  inflight        smallint,
  db_waiting      smallint,
  queue_waited_ms integer
);

-- คำอธิบายคอลัมน์ที่ไม่ชัดในตัวเอง (ไม่ใช้ COMMENT ON COLUMN ตามกติกาของโปรเจกต์):
--   request_id      สุ่ม 16 ตัวอักษร ส่งกลับเป็น header X-Request-Id ด้วย — สั้นพอให้ผู้ใช้ copy จาก
--                   หน้าจอ/docker logs มาวางในช่องค้นหาได้ด้วยมือ · ไม่รับค่าที่ client ส่งเข้ามา (ปลอมได้)
--   route           pattern ที่ Express บอก เช่น /api/quotation/:id — เก็บ "เฉพาะตอนที่ Express บอกมาเป็น
--                   string เท่านั้น ไม่เดาเอง" ไม่บอกก็ NULL (404/static/route ที่ประกาศเป็น array)
--                   การจัดกลุ่มสำหรับหน้าสถิติไปทำตอนอ่านด้วย COALESCE(route, ย่อ path) แทน
--                   เพื่อไม่ให้มีโอกาสเขียนค่าที่เดาผิดค้างใน DB — สูตรไม่ดีก็แก้ SQL อย่างเดียวจบ
--   admin_user_id   ไม่มี FK และไม่เก็บ username ซ้ำ — JOIN admin_users ตอนอ่าน (มี 6 แถว)
--                   ที่ไม่ใส่ FK เพราะ DELETE /api/admin/users/:id มีจริง ถ้าผู้ใช้ถูกลบ log ต้องไม่หายตาม
--   inflight        จำนวน request ที่ค้างอยู่ในระบบ ณ วินาทีที่ request นี้เริ่ม (counter ++/-- ตัวเดียว)
--                   แยกได้ว่า "ช้าเพราะโหลดเยอะ" หรือ "endpoint นั้นช้าเอง" = คำถามแรกของการ sizing
--   db_waiting      pool.waitingCount ตอนจบ — > 0 เมื่อไหร่แปลว่า pool 40 connection ไม่พอ
--   queue_waited_ms เฉพาะแถว method='TASK' ของ webhook (NULL สำหรับ HTTP ปกติ) = เวลานั่งรอในคิว
--                   duration_ms - queue_waited_ms = เวลาประมวลผลจริง → แยกได้ว่าต้องเพิ่มเครื่อง
--                   (รอคิวนาน) หรือแก้โค้ด/LLM (ประมวลผลนาน)

-- แกนหลัก: ทุกหน้าจอมีช่วงเวลาเสมอ + เรียงใหม่ไปเก่า · query สถิติก็ใช้ตัวนี้คัดช่วงเวลาก่อนแล้วค่อย
-- GROUP BY ในหน่วยความจำ · retention DELETE ก็เดินจากปลายเก่าสุดผ่าน index ตัวนี้
CREATE INDEX IF NOT EXISTS idx_api_logs_created_at
  ON public.api_logs (created_at DESC, id DESC);

-- ตามรอยจาก X-Request-Id ที่ผู้ใช้แคปหน้าจอมา (ค้นโดยไม่รู้วันที่)
-- และใช้จับคู่ 2 แถวของ /callback (HTTP ack + งานจริงที่ทำเบื้องหลัง) เข้าด้วยกัน
CREATE INDEX IF NOT EXISTS idx_api_logs_request_id
  ON public.api_logs (request_id);

-- ตารางนี้ churn สูงกว่าตารางอื่นทั้งหมด (insert รัวตลอดเวลา + DELETE ก้อนใหญ่ทุกชั่วโมง)
-- ค่า default ของ autovacuum (scale_factor 0.2 = รอ dead tuple ถึง 20% ของตาราง) ทำให้บวมค้างนานเกินไป
ALTER TABLE public.api_logs SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);
