-- ─────────────────────────────────────────────────────────────────────────────
--  บันทึกผลรอบ sync ล่าสุดลง sync_state (เดิมเก็บไว้ใน memory อย่างเดียว)
--
--  เดิม error ของ sync ไปอยู่ที่ console + runState.lastError ในหน่วยความจำ
--  → หายทุกครั้งที่ restart/redeploy container และเก็บได้แค่ error ตัวสุดท้าย
--  ของทั้งรอบ แอดมินต้อง SSH เข้า server ถึงจะเห็น
--
--  สำคัญ — กติกาการเขียน 4 คอลัมน์นี้ (อยู่ใน services/syncService.ts):
--    รอบที่สำเร็จ  → เขียนแค่ last_status, last_run_at
--    รอบที่ล้มเหลว → เขียนครบทั้ง 4 คอลัมน์
--  last_error / last_error_at จึง "ไม่ถูกล้างเมื่อรอบถัดไปสำเร็จ" โดยตั้งใจ
--  เพราะ auto sync ตั้งเป็นแบบ interval ถ้าล้างทุกรอบที่สำเร็จ error ตอนตี 2
--  จะถูกทับตอน 2:15 แล้วไม่มีใครได้เห็นเลยว่าเมื่อคืนระบบล่ม
--
--  ส่วน last_success_at เดิมยังมีความหมายเหมือนเดิม = "commit หน้าล่าสุดสำเร็จเมื่อไหร่"
--  (ถูกเด้งทุกหน้าที่ commit ระหว่างรอบ) ไม่ใช่ "รอบล่าสุดสำเร็จ" → หน้าแอดมินอ่านคู่กับ
--  last_status เสมอ
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-07-22_01_sync_state_last_run.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม (ADD COLUMN IF NOT EXISTS)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.sync_state ADD COLUMN IF NOT EXISTS last_status   text;
ALTER TABLE public.sync_state ADD COLUMN IF NOT EXISTS last_run_at   timestamptz;
ALTER TABLE public.sync_state ADD COLUMN IF NOT EXISTS last_error    text;
ALTER TABLE public.sync_state ADD COLUMN IF NOT EXISTS last_error_at timestamptz;

COMMENT ON COLUMN public.sync_state.last_status   IS 'ผลรอบ sync ล่าสุด: success | failed | aborted | skipped';
COMMENT ON COLUMN public.sync_state.last_run_at   IS 'เวลาที่รอบ sync ล่าสุดจบ ไม่ว่าผลจะเป็นอะไร';
COMMENT ON COLUMN public.sync_state.last_error    IS 'ข้อความ error ล่าสุด — ไม่ถูกล้างเมื่อรอบถัดไปสำเร็จ';
COMMENT ON COLUMN public.sync_state.last_error_at IS 'เวลาที่เกิด error ล่าสุด — ไม่ถูกล้างเมื่อรอบถัดไปสำเร็จ';
