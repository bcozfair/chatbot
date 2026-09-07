-- ─────────────────────────────────────────────────────────────────────────────
--  เฟส 4 ของแผน docs/plan-logging-audit-compliance.md — กอง "Metrics / Dashboard"
--
--  ทำไมต้องสรุปเก็บถาวร ไม่อ่านสดจาก api_logs:
--    api_logs เก็บ 120 วัน ⇒ ถ้าหน้าจออ่านจากแถวดิบ มุมมอง "ปี" จะว่างตลอดกาล
--    สรุปวันละครั้งเก็บไม่ลบ = 365 แถว/ปี ≈ ไม่มีต้นทุน แล้วทุกมุมมอง (วัน/สัปดาห์/เดือน/ปี)
--    อ่านจากตารางเดียวกันหมด ⇒ ตัวเลขตรงกันเสมอโดยไม่ต้องมีสูตรสองชุด
--
--  ⚠️ p95 รวมย้อนกลับไม่ได้ — p95 ของเดือน ≠ ค่าเฉลี่ยของ p95 รายวัน (ทางคณิตศาสตร์)
--     จึงเก็บ duration_sum_ms ไว้ด้วย เพื่อให้ "ค่าเฉลี่ยของช่วงยาว" คำนวณได้ถูกต้อง 100%
--     (sum ของ sum หารด้วย sum ของ count) ส่วน p95 ของช่วงยาวหน้าจอต้องติดป้ายให้ชัดว่าเป็น
--     "p95 สูงสุดรายวันในช่วงนี้" ไม่ใช่ p95 จริงของทั้งช่วง — ตัวเลขต้องไม่โกหก
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-09-03_05_traffic_daily.sql
--  idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.traffic_daily (
  day                date       PRIMARY KEY,

  requests           integer    NOT NULL DEFAULT 0,
  requests_api       integer    NOT NULL DEFAULT 0,
  webhook_events     integer    NOT NULL DEFAULT 0,
  webhook_dropped    integer    NOT NULL DEFAULT 0,
  webhook_timeout    integer    NOT NULL DEFAULT 0,

  errors_4xx         integer    NOT NULL DEFAULT 0,
  errors_5xx         integer    NOT NULL DEFAULT 0,

  uniq_line_users    integer    NOT NULL DEFAULT 0,
  uniq_admin_users   integer    NOT NULL DEFAULT 0,
  uniq_ips           integer    NOT NULL DEFAULT 0,

  bytes_out          bigint,
  duration_sum_ms    bigint     NOT NULL DEFAULT 0,
  p50_ms             integer,
  p95_ms             integer,
  p99_ms             integer,
  max_inflight       smallint,
  db_wait_hits       integer    NOT NULL DEFAULT 0,

  quotations_created integer    NOT NULL DEFAULT 0,
  messages_in        integer    NOT NULL DEFAULT 0,
  audit_changes      integer    NOT NULL DEFAULT 0,
  system_errors      integer    NOT NULL DEFAULT 0,

  audit_digest       varchar(64),
  audit_prev_digest  varchar(64),

  computed_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- คำอธิบายคอลัมน์ที่ไม่ชัดในตัวเอง (ไม่ใช้ COMMENT ON COLUMN ตามกติกาของโปรเจกต์):
--   day               "วันไทย" เสมอ (created_at AT TIME ZONE 'Asia/Bangkok')::date
--                     ไม่ใช่วัน UTC — ผู้บริหารที่อ่านรายงานอยู่ที่ไทย ไม่มีใครสนใจวัน UTC
--   requests          แถว HTTP จริงทั้งหมด (ไม่รวม method='TASK' ซึ่งเป็นงานเบื้องหลังของ webhook)
--   webhook_events    แถว method='TASK' = จำนวน event ที่บอทประมวลผลจริง
--                     dropped (499) = คิวตันจนไม่ได้เริ่ม · timeout (504) = เกินงบเวลา 48 วิ
--   duration_sum_ms   ผลรวมของ duration_ms ทั้งวัน — ตัวที่ทำให้ค่าเฉลี่ยของ "เดือน/ปี" ถูกต้อง
--   db_wait_hits      จำนวนแถวที่ db_waiting > 0 = จำนวนครั้งที่ pool 40 connection ไม่พอ "จริง ๆ"
--   audit_digest      sha256 ของแถว audit_logs ทั้งวัน (เรียงตาม id) ต่อท้ายด้วย digest ของเมื่อวาน
--                     = หลักฐาน integrity แบบโซ่รายวัน · ใครแก้แถวเก่าย้อนหลัง digest จะไม่ตรง
--                     ต้นทุนเสี้ยวเดียวของ hash chain รายแถว แต่ตอบคำถาม "ถูกแก้ไหม" ได้เหมือนกัน
--                     ⚠️ มีค่าก็ต่อเมื่อสำเนาออกนอกเครื่องพร้อม backup — เก็บไว้ใน DB เครื่องเดียวกัน
--                     กับของที่มันเฝ้าอยู่ ไม่ได้พิสูจน์อะไรเลย (เขียนไว้ใน DEPLOY.md แล้ว)
--   system_errors     จำนวนแถว system_logs ระดับ error/fatal ของวันนั้น

-- ตารางนี้ 365 แถว/ปี — PRIMARY KEY (day) พอสำหรับทุก query ที่หน้าจอใช้ (BETWEEN + ORDER BY day)
-- จงใจไม่ใส่ index อื่น

-- แถวของ "วันนี้" ถูกเขียนซ้ำได้เรื่อย ๆ ตอนหน้าจอขอดูสด ⇒ churn ต่ำแต่มีจริง
ALTER TABLE public.traffic_daily SET (
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
