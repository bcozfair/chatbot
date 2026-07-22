-- ─────────────────────────────────────────────────────────────────────────────
--  รวมการตั้งเวลา auto sync จาก 2 โหมดแยกกัน เป็นชุดเดียว
--
--  เดิม: mode='daily' (ยิงตาม daily_time) หรือ mode='interval' (ทุก interval_minutes)
--        เลือกได้อย่างใดอย่างหนึ่ง ตั้งเจาะจงวันไม่ได้ และจำกัด interval แค่ชุด
--        {1,3,5,10,15,30,60} นาที
--
--  ใหม่: วัน + ช่วงเวลา + interval ใช้ร่วมกันทั้งหมด
--        days             = วันที่ให้ทำงาน (0=อาทิตย์ … 6=เสาร์ ตรงกับ Date.getDay())
--                           อาเรย์ว่าง = ทุกวัน
--        window_start/end = ช่วงเวลาในแต่ละวันที่อนุญาตให้ sync ('HH:MM' เวลาไทย)
--        interval_seconds = เว้นกี่วินาทีต่อรอบ ภายในช่วงนั้น (30–86400)
--
--  "วันละครั้ง" ทำได้ด้วยช่วงแคบ เช่น 02:00–02:00 ทุก 3600 วิ → ยิงครั้งเดียวตอนตี 2
--  ไม่รองรับช่วงข้ามเที่ยงคืน (end ต้อง >= start) เพราะเงื่อนไข "วัน" จะกำกวมว่านับวันไหน
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-07-22_02_sync_settings_schedule.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ (ADD/DROP IF [NOT] EXISTS + แปลงค่าเฉพาะตอนคอลัมน์เก่ายังอยู่)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.sync_settings ADD COLUMN IF NOT EXISTS days             integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}';
ALTER TABLE public.sync_settings ADD COLUMN IF NOT EXISTS window_start     text      NOT NULL DEFAULT '00:00';
ALTER TABLE public.sync_settings ADD COLUMN IF NOT EXISTS window_end       text      NOT NULL DEFAULT '23:59';
ALTER TABLE public.sync_settings ADD COLUMN IF NOT EXISTS interval_seconds integer   NOT NULL DEFAULT 900;

-- ── แปลงค่าที่ตั้งไว้เดิมให้ความหมายเท่าเดิม ────────────────────────────────
-- ครอบด้วย DO block: ถ้าคอลัมน์เก่าถูก drop ไปแล้ว (รันซ้ำ) plpgsql จะไม่ parse
-- คำสั่งข้างในเลย จึงไม่ error
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sync_settings' AND column_name = 'mode'
  ) THEN
    -- daily 02:00 → ทุกวัน ช่วง 02:00–02:00 ทุก 1 ชม. = ยิงครั้งเดียวตอนตี 2 เหมือนเดิม
    UPDATE public.sync_settings
       SET window_start     = COALESCE(NULLIF(daily_time, ''), '02:00'),
           window_end       = COALESCE(NULLIF(daily_time, ''), '02:00'),
           interval_seconds = 3600,
           days             = '{0,1,2,3,4,5,6}'
     WHERE mode = 'daily';

    -- interval N นาที → ทุกวัน ตลอดวัน ทุก N*60 วิ
    UPDATE public.sync_settings
       SET window_start     = '00:00',
           window_end       = '23:59',
           interval_seconds = GREATEST(30, COALESCE(interval_minutes, 15) * 60),
           days             = '{0,1,2,3,4,5,6}'
     WHERE mode = 'interval';
  END IF;
END $$;

ALTER TABLE public.sync_settings DROP COLUMN IF EXISTS mode;
ALTER TABLE public.sync_settings DROP COLUMN IF EXISTS daily_time;
ALTER TABLE public.sync_settings DROP COLUMN IF EXISTS interval_minutes;

COMMENT ON COLUMN public.sync_settings.days             IS 'วันที่ให้ auto sync ทำงาน 0=อาทิตย์…6=เสาร์ (ว่าง = ทุกวัน)';
COMMENT ON COLUMN public.sync_settings.window_start     IS 'เวลาเริ่มช่วงที่อนุญาตให้ sync (HH:MM เวลาไทย)';
COMMENT ON COLUMN public.sync_settings.window_end       IS 'เวลาสิ้นสุดช่วง (HH:MM เวลาไทย) ต้อง >= window_start';
COMMENT ON COLUMN public.sync_settings.interval_seconds IS 'เว้นกี่วินาทีต่อรอบภายในช่วงเวลา (30–86400)';
