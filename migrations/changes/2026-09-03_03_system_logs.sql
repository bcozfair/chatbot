-- ─────────────────────────────────────────────────────────────────────────────
--  เฟส 2 ของแผน docs/plan-logging-audit-compliance.md — กอง "System log"
--
--  ตอบคำถามที่ตอนนี้ตอบไม่ได้: "ระบบพังตรงไหน เพราะอะไร" ย้อนหลังเกินอายุ docker json-file
--  (max-size 10m x 5 ไฟล์ = หมุนทิ้งภายในไม่กี่วันตอนมีปัญหา ซึ่งคือตอนที่ต้องการมันที่สุดพอดี)
--
--  ⚠️ ไม่มีอะไรในไฟล์นี้ที่โค้ดแอปแตะ — ทั้ง 2 ตารางถูกเขียนโดย scripts/logworker/ ซึ่งเป็น
--     โปรเซสแยกบน host เท่านั้น · หยุด logworker แล้วแอปทำงานปกติทุกอย่าง (12-Factor §XI:
--     แอปเขียน stdout แล้วจบ ไม่รู้เรื่องปลายทาง)
--
--  สิ่งที่จงใจไม่ทำ:
--    - ไม่เปลี่ยน logging driver ของ docker — ต้อง recreate คอนเทนเนอร์ = downtime
--      และจะทำให้ `docker logs` ที่ใช้ดูสด ๆ ทุกวันใช้ไม่ได้
--    - ไม่ mount docker socket เข้าคอนเทนเนอร์ — เท่ากับให้สิทธิ์ root กับแอป
--    - ไม่ partition — เกณฑ์ที่ควรย้ายคือเกิน ~5M แถว หรือ 3 GB (ไกลมากที่ระดับ warn)
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-09-03_03_system_logs.sql
--  ไฟล์นี้สร้างของใหม่ล้วน ไม่ ALTER ตารางเดิม ไม่แตะ matview → รันตอนระบบเปิดอยู่ได้ จบในไม่กี่ ms
--  idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.system_logs (
  id          bigserial     PRIMARY KEY,
  created_at  timestamptz   NOT NULL,
  container   varchar(60)   NOT NULL,
  stream      varchar(6)    NOT NULL,
  level       varchar(5)    NOT NULL,
  source      varchar(60),
  event       varchar(80),
  message     text          NOT NULL,
  request_id  varchar(16),
  ctx         jsonb,
  err_stack   text
);

-- คำอธิบายคอลัมน์ที่ไม่ชัดในตัวเอง (ไม่ใช้ COMMENT ON COLUMN ตามกติกาของโปรเจกต์):
--   created_at  เวลาที่ docker ประทับให้บรรทัดนั้น (--timestamps) ไม่ใช่เวลาที่ worker อ่านเจอ
--               ⇒ worker หยุดไป 10 นาทีแล้วกลับมาเก็บย้อนหลัง เวลายังตรงกับเหตุการณ์จริง
--   container   ชื่อคอนเทนเนอร์ต้นทาง — เผื่อวันหน้าเก็บจากหลายคอนเทนเนอร์ในตารางเดียว
--   stream      stdout | stderr ← "ตัวชี้ระดับที่เชื่อถือได้ตัวเดียวที่มี"
--               Node ส่ง console.log/info ออก stdout และ console.warn/error ออก stderr เสมอ
--               ⇒ worker แยกสองสตรีมตอนอ่าน แทนการเดาระดับจากคำในข้อความ ซึ่งพังทันทีกับบรรทัด
--               อย่าง "[queue] ... [replied=144 timedOut=0 dropped=0 failed=0]" ที่มีคำว่า failed
--               แต่เป็น log ปกติที่สุดของระบบ
--   level       fatal|error|warn|info|debug (RFC 5424 ย่อเหลือเท่าที่ใช้จริง)
--   source      ชื่อในวงเล็บเหลี่ยมต้นบรรทัด เช่น [sync] [queue] [api-log] → 'sync','queue','api-log'
--   request_id  ดึงจาก reqId=xxxx ถ้าบรรทัดนั้นมี → JOIN กับ api_logs / audit_logs ได้
--               บรรทัดเดิมส่วนใหญ่ยังไม่มี ⇒ เป็น NULL (เฟส 6 ค่อยทยอยเติมทีละโมดูล)
--   err_stack   บรรทัดต่อเนื่องที่ตามหลังมา (stack trace / JSON ที่พิมพ์หลายบรรทัด) รวมไว้ที่แถวแรก
--               ไม่แตกเป็นแถวละบรรทัด เพราะจะอ่านไม่รู้เรื่องและทำให้ตารางบวมฟรี

-- แกนหลัก: ทุกหน้าจอมีช่วงเวลาเสมอ + เรียงใหม่ไปเก่า · retention DELETE ก็เดินผ่าน index ตัวนี้
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at
  ON public.system_logs (created_at DESC, id DESC);

-- "ขอดูเฉพาะ error/fatal ของสัปดาห์นี้" คือ query ที่ถูกใช้บ่อยที่สุดของหน้านี้
CREATE INDEX IF NOT EXISTS idx_system_logs_level
  ON public.system_logs (level, created_at DESC);

-- ตามรอย request เดียวข้ามทั้ง 3 ตาราง (api_logs / audit_logs / system_logs)
-- partial: บรรทัดส่วนใหญ่ยังไม่มี request_id ⇒ index เต็มจะเปลืองเปล่า
CREATE INDEX IF NOT EXISTS idx_system_logs_request_id
  ON public.system_logs (request_id) WHERE request_id IS NOT NULL;

-- churn สูงเหมือน api_logs (insert เรื่อย ๆ + DELETE ก้อนใหญ่ตอน retention)
ALTER TABLE public.system_logs SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);

-- ─────────────────────────────────────────────────────────────────────────────
--  checkpoint ของ logworker — ตารางเดียวที่ทั้ง 3 งานเบื้องหลังใช้ร่วมกัน
--
--  ทำไมต้องมี: worker ต้อง restart ได้ตลอดเวลา (deploy, เครื่อง reboot, systemd restart)
--  โดยเก็บบรรทัดที่หายไประหว่างนั้นได้ครบและไม่ซ้ำ ⇒ ต้องจำ "อ่านถึงไหนแล้ว" ไว้ใน DB
--  ไม่ใช่ในไฟล์บน host ซึ่งหายไปพร้อมเครื่อง
--
--  ใช้เป็นตัวตรวจสุขภาพด้วย: cursor_at ค้างเกิน 15 นาที = worker ตายเงียบ → ขึ้นเตือนบนหน้าจอ
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.log_worker_state (
  -- 60 ไม่ใช่ 30: ชื่องานของการอ่าน log เป็น 'system_log:<ชื่อคอนเทนเนอร์>' ซึ่งชื่อคอนเทนเนอร์จริง
  -- ('primus-chatbot-app-1') ทำให้ยาว 31 ตัวอักษรแล้ว — ถ้าเก็บไม่พอ checkpoint จะเขียนไม่ลง
  -- แล้ว worker จะวนอ่าน log ก้อนเดิมซ้ำตลอดกาลโดยไม่มีใครรู้
  job          varchar(60)  PRIMARY KEY,
  cursor_at    timestamptz,
  last_run_at  timestamptz,
  last_ok_at   timestamptz,
  last_error   text,
  runs         bigint       NOT NULL DEFAULT 0,
  rows_written bigint       NOT NULL DEFAULT 0
);

-- job ที่รู้จักตอนนี้ (worker เขียนทับค่าเองตอนทำงาน — แถวตั้งต้นมีไว้ให้หน้าจอเห็นว่า "ยังไม่เคยรัน")
--   system_log:<container>  อ่าน docker logs ของคอนเทนเนอร์นั้น
--   audit_actor             เติมชื่อผู้แก้ไขให้แถว audit ที่ยัง pending
--   traffic_daily           สรุป traffic รายวัน
--   log_retention           ลบ system_logs / audit_logs ที่เกินอายุ
INSERT INTO public.log_worker_state (job) VALUES
  ('audit_actor'), ('traffic_daily'), ('log_retention')
ON CONFLICT (job) DO NOTHING;
