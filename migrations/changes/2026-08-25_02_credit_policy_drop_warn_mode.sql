-- ปลดโหมด "เฝ้าดู" (warn) ออกจากเกณฑ์ระงับบริษัทที่ไม่มีคำสั่งซื้อมานาน
--
-- ทำไม: หน้าแอดมินเปลี่ยนจากปุ่มเลือก 3 โหมด เป็นสวิตช์ เปิด/ปิด (2026-08-25)
--       เหลือแค่ block/off · โหมด warn มีไว้เฝ้าดูก่อนเปิดจริงว่า "ถ้าเปิดแล้วจะโดนใครบ้าง"
--       ซึ่งทำหน้าที่ครบแล้วตั้งแต่เปิดจริงเมื่อ 2026-08-21
--
-- ⚠️ warn → off ไม่ใช่ warn → block
--    warn ไม่เคยบล็อกใครเลย ต่างจาก off แค่มีบรรทัด log ⇒ map เป็น off คือค่าเดียว
--    ที่ทำให้พฤติกรรมที่ผู้ใช้เห็นไม่เปลี่ยน · map เป็น block = เปิดกฎให้เองโดยไม่มีใครสั่ง
--    ซึ่งจะกลายเป็นบล็อกใบเสนอราคาจริงทันทีโดยแอดมินไม่รู้ตัว — ห้ามเด็ดขาด
--
-- ลำดับกับ deploy: รันไฟล์นี้ "ก่อน" deploy โค้ดใหม่ได้ปลอดภัย เพราะโค้ดที่รันอยู่
--    ยอมรับทั้ง 3 ค่าอยู่แล้ว การแคบ CHECK ลงไม่ทำให้ของเดิมพัง · ทางกลับกัน deploy
--    โค้ดใหม่ก่อนก็ไม่พัง แค่แถวที่ค้างเป็น warn จะยังตีความเป็น off จนกว่าจะรันไฟล์นี้
--
-- รันซ้ำได้ (idempotent) — UPDATE ไม่โดนแถวไหน และ constraint ถูกสร้างทับด้วยนิยามเดิม

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '30s';

-- ── 1. ไล่ค่าที่ค้าง ──
UPDATE public.quotation_credit_policy
   SET mode = 'off'
 WHERE mode = 'warn';

-- ── 2. แคบ CHECK ให้เหลือ 2 ค่า — กันไม่ให้ warn กลับเข้ามาทาง API/psql อีก ──
ALTER TABLE public.quotation_credit_policy
  DROP CONSTRAINT IF EXISTS quotation_credit_policy_mode;

ALTER TABLE public.quotation_credit_policy
  ADD  CONSTRAINT quotation_credit_policy_mode
       CHECK (mode = ANY (ARRAY['off', 'block']));

-- ── 3. ยืนยันว่าไม่ได้เผลอเปลี่ยนสถานะจริงของระบบ ──
DO $guard$
DECLARE m text; n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.quotation_credit_policy;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ตารางเกณฑ์ต้องมีแถวเดียว แต่เจอ % แถว — ยกเลิกทั้งหมด', n;
  END IF;

  SELECT mode INTO m FROM public.quotation_credit_policy WHERE id = 1;
  IF m IS NULL THEN
    RAISE EXCEPTION 'ไม่เจอแถว id = 1 — ยกเลิกทั้งหมด';
  END IF;

  RAISE NOTICE 'เกณฑ์เครดิตหลังไล่ค่า: mode = % (ถ้าเคยเป็น block ต้องยังเป็น block)', m;
END $guard$;

COMMIT;
