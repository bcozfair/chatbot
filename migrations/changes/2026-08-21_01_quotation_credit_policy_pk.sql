-- ─────────────────────────────────────────────────────────────────────────────
--  เติม PRIMARY KEY ให้ quotation_credit_policy
--
--  ตารางนี้ตั้งใจให้มีแถวเดียว (id = 1) แต่ตอนสร้างใน 2026-08-20_04 ใส่ไว้แค่
--  CHECK (id = 1) ซึ่งคุม "ค่า" ไม่ได้คุม "ความซ้ำ" — ตารางจึงไม่มี PK และไม่มี
--  index สักตัว ต่างจากตารางแถวเดียวตัวอื่นในระบบที่มี PK ครบ
--  (customers_data_view_state / shipping_fee_config / sync_settings)
--
--  ผลที่ตามมา: บรรทัด seed ใน migrations/schema.sql
--      INSERT INTO public.quotation_credit_policy (id) VALUES (1) ON CONFLICT DO NOTHING;
--  ไม่ได้กันอะไรเลย เพราะ ON CONFLICT ที่ไม่มี unique index ไว้ให้ชนจะไม่เคยชน
--  (ทดลองแล้ว: ยิง 3 ครั้งได้ 3 แถว ไม่มี error) ⇒ ถ้าใครรัน schema.sql ทับ DB เดิม
--  โดยไม่ใส่ ON_ERROR_STOP จะได้แถว id=1 ซ้ำเงียบ ๆ แล้วหน้าแอดมินกับด่านตรวจ
--  จะหยิบแถวไหนก็ไม่แน่นอน
--
--  ⚠️ ต้องรันคู่กับการแก้ schema.sql ให้ seed เป็น ON CONFLICT (id) DO NOTHING
--     (commit เดียวกัน) ไม่งั้นไฟล์ baseline ยังกันซ้ำไม่ได้เหมือนเดิม
--
--  รัน: docker compose exec -T db psql -U postgres -d chatbot_primus -v ON_ERROR_STOP=1 \
--         -f - < migrations/changes/2026-08-21_01_quotation_credit_policy_pk.sql
--  รันได้ทุกเวลา — ตารางมีแถวเดียว ล็อกเสี้ยววินาที ไม่แตะ customers_data_view
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

-- กันพลาด: ถ้า DB ที่จะรันมีแถวซ้ำอยู่แล้ว ให้ล้มพร้อมบอกเหตุผลเป็นภาษาคน
-- แทนที่จะปล่อยให้ ADD PRIMARY KEY แจ้ง "could not create unique index" ลอย ๆ
-- (ไม่ลบแถวซ้ำให้อัตโนมัติ — ค่าที่ต่างกันต้องให้คนตัดสินว่าจะเก็บอันไหน)
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM public.quotation_credit_policy;

  IF dup_count > 1 THEN
    RAISE EXCEPTION
      'quotation_credit_policy มี % แถว (ต้องมีแถวเดียว) — ตรวจก่อนว่าจะเก็บแถวไหน แล้วลบที่เหลือด้วย ctid: SELECT ctid, * FROM public.quotation_credit_policy;',
      dup_count;
  END IF;
END $$;

-- แถวหายก็เติมคืน (DB ที่เคยโดนลบแถวทิ้ง) — ทำก่อน ADD PRIMARY KEY เพราะตอนนี้
-- ยังไม่มี unique index ให้ ON CONFLICT ชน จึงต้องใช้ WHERE NOT EXISTS แทน
INSERT INTO public.quotation_credit_policy (id)
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM public.quotation_credit_policy);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.quotation_credit_policy'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE public.quotation_credit_policy ADD PRIMARY KEY (id);
  END IF;
END $$;
