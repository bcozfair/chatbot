-- ─────────────────────────────────────────────────────────────────────────────
--  ปิดรูรั่วของแผน G/G#2 — ยกตัวเลข LLM ขึ้นไปเก็บถาวรใน traffic_daily
--
--  ปัญหาที่ไฟล์นี้แก้:
--    api_logs เก็บ 120 วันแล้วถูกลบ · traffic_daily เก็บถาวรแต่ "ไม่มีคอลัมน์ llm/token เลย"
--    ⇒ ทุกวันที่ผ่านพ้น 120 วัน เวลารอ LLM · จำนวน call ต่อข้อความ · อัตราที่ prompt เข้าแคช
--      จะหายถาวร ไม่มีที่ไหนเหลือให้ย้อนดู
--    เป็นข้อมูลที่ใช้ตอบคำถามระยะยาวโดยเฉพาะ ("หลังแก้ prompt เมื่อ 4 เดือนก่อน แคชดีขึ้นจริงไหม")
--    ซึ่งเป็นคำถามที่ช่วงเวลา 120 วันตอบไม่ได้ตามนิยาม
--
--  ⚠️ ทุกคอลัมน์ nullable ไม่มี DEFAULT — จงใจ
--    วันก่อน 2026-09-03 ไม่มีการวัดค่าเหล่านี้เลย · NULL = "ไม่ได้วัด" ซึ่งต่างจาก 0 = "ไม่มีการเรียก LLM"
--    ถ้าใส่ DEFAULT 0 กราฟย้อนหลังจะอ่านว่าเมื่อก่อนบอทไม่เคยเรียก LLM เลย ซึ่งเป็นเรื่องโกหก
--    (หลักเดียวกับ audit_digest ที่ยอมเป็น NULL ในวันที่ไม่มีแถว audit)
--    ⇒ trafficDailyJob จึงไม่ COALESCE ค่าพวกนี้ · sum() ของศูนย์แถวคืน NULL เองตามธรรมชาติ
--
--  ADD COLUMN nullable ไม่มี DEFAULT = แก้ catalog อย่างเดียว ไม่ rewrite ตาราง
--  (ตารางนี้ ~26 แถว) ⇒ รันได้ทุกเวลา
--
--  รัน: docker compose exec app npx tsx scripts/runMigration.ts \
--         migrations/changes/2026-09-07_01_traffic_daily_llm.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
--
--  ⚠️ หลังรันไฟล์นี้ต้องสั่งคำนวณวันเก่าใหม่ ไม่งั้นคอลัมน์ใหม่จะว่างจนกว่าจะขึ้นวันใหม่:
--         node --import tsx scripts/logworker/recompute.ts
--     (backfillFromApiLogs ข้ามวันที่มีแถวอยู่แล้ว จึงเติมย้อนหลังให้ไม่ได้)
-- ─────────────────────────────────────────────────────────────────────────────

-- คำอธิบายคอลัมน์ (ไม่ใช้ COMMENT ON COLUMN ตามกติกาของโปรเจกต์):
--   llm_tasks          จำนวนงานที่มีการวัดเวลา LLM (llm_ms IS NOT NULL) ของวันนั้น
--                      = ตัวหารที่ถูกต้องของ llm_ms_sum / llm_calls_sum / own_ms_sum
--                      ⚠️ ไม่ใช่ webhook_events เพราะงานที่ถูกทิ้งตอนคิวตัน (499) ไม่เคยเรียก LLM
--                         ถ้าหารด้วย webhook_events ค่าเฉลี่ยจะต่ำกว่าความจริงในวันที่คิวตัน
--   llm_ms_sum         ผลรวมเวลารอ LLM ทั้งวัน — เก็บเป็นผลรวมเพื่อให้ค่าเฉลี่ยของเดือน/ปี
--                      คำนวณย้อนกลับได้ถูกต้อง 100% (sum ของ sum ÷ sum ของ count)
--   llm_calls_sum      ผลรวมจำนวน call — llm_calls_sum / llm_tasks = "เรียกกี่ครั้งต่อ 1 ข้อความ"
--                      ตัวคูณที่ทำให้แยกได้ว่า "ช้าเพราะเรียกหลายครั้ง" หรือ "เรียกครั้งเดียวแต่ช้า"
--   own_ms_sum         ผลรวมเวลาที่เป็นงานของเราเอง (DB + LINE API + โค้ด) — คู่กับ llm_ms_sum
--                      ทั้งคู่ต้องอยู่ด้วยกัน ไม่งั้นตอบไม่ได้ว่าควรไปแก้ฝั่งไหน
--   llm_p95_ms         p95 ของ llm_ms รายวัน
--                      ⚠️ รวมข้ามวันไม่ได้ (เหมือน p95_ms) — ช่วงยาวต้องติดป้าย "สูงสุดรายวัน"
--                      จำเป็นเพราะค่าเฉลี่ยกลบหางยาว ซึ่งหางยาวคือตัวที่ชนงบเวลา 48 วิ
--   llm_token_tasks    จำนวนงานที่มีตัวเลข token (llm_prompt_tokens IS NOT NULL)
--                      = ตัวหารของ llm_prompt_tokens · แยกจาก llm_tasks เพราะ token นับเฉพาะ
--                      call ที่สำเร็จ และคอลัมน์ token เพิ่งเริ่มเก็บทีหลัง llm_ms อยู่ 1 วัน
--                      ⇒ ถ้าใช้ตัวหารเดียวกัน ค่าเฉลี่ย token ของวันคาบเกี่ยวจะต่ำกว่าความจริง
--   llm_prompt_tokens  ผลรวม prompt token ทั้งวัน
--   llm_cached_tokens  ผลรวมส่วนที่ DeepSeek คืนจากแคช
--                      อัตราแคชของช่วงใดก็ได้ = sum(llm_cached_tokens) / sum(llm_prompt_tokens)
--                      เป็นอัตราส่วนของผลรวมสองตัว ⇒ รวมข้ามวันได้ถูกต้องทุกระดับ
ALTER TABLE public.traffic_daily
  ADD COLUMN IF NOT EXISTS llm_tasks         integer,
  ADD COLUMN IF NOT EXISTS llm_ms_sum        bigint,
  ADD COLUMN IF NOT EXISTS llm_calls_sum     integer,
  ADD COLUMN IF NOT EXISTS own_ms_sum        bigint,
  ADD COLUMN IF NOT EXISTS llm_p95_ms        integer,
  ADD COLUMN IF NOT EXISTS llm_token_tasks   integer,
  ADD COLUMN IF NOT EXISTS llm_prompt_tokens bigint,
  ADD COLUMN IF NOT EXISTS llm_cached_tokens bigint;
