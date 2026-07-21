-- ─────────────────────────────────────────────────────────────────────────────
--  ตารางนับเลขที่ใบเสนอราคาแบบ atomic (แก้ race ตอนออกเลขพร้อมกัน)
--
--  เดิม getQuotationNo() นับ COUNT-then-INSERT: ยิงยืนยันพร้อมกันได้เลขซ้ำ →
--  unique index uq_quotations_quotation_no เตะเป็น HTTP 500 ตอน load
--  ตัวใหม่ใช้ INSERT ... ON CONFLICT DO UPDATE ... RETURNING (row lock) ภายใน
--  transaction เดียวกับการ UPDATE status จึง atomic และ rollback แล้วเลขคืน (ไม่มีช่องว่างจาก error)
--
--  counter_key:
--    'QP:2607'            = เลขปกติ prefix QP เดือน 2607 (YYMM ของ created_at)
--    'REV:QP-260705012'   = เลข revision ต่อจากเลขฐาน QP-260705012
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-07-20_02_quotation_counters.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม (CREATE IF NOT EXISTS + ON CONFLICT ... GREATEST)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.quotation_counters (
  counter_key text PRIMARY KEY,
  last_seq    integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── Seed เลขปกติจากข้อมูลจริง ─────────────────────────────────────────────────
-- 'QP-260705012' -> key 'QP:2607', seq 12
-- รูปแบบเลข = prefix + '-' + YYMM(4) + '05'(รหัสสาขา) + NNN(3) = 9 หลักหลัง dash พอดี
-- regex [0-9]{9}$ จึงตัด revision (ที่มี '-NN' ต่อท้าย) ออกจากชุดนี้อัตโนมัติ
INSERT INTO public.quotation_counters (counter_key, last_seq)
SELECT split_part(quotation_no, '-', 1) || ':' ||
       substring(split_part(quotation_no, '-', 2) FROM 1 FOR 4),
       MAX(substring(split_part(quotation_no, '-', 2) FROM 7 FOR 3)::int)
FROM public.quotations
WHERE quotation_no ~ '^(QP|QT)-[0-9]{9}$'
GROUP BY 1
ON CONFLICT (counter_key) DO UPDATE
  SET last_seq = GREATEST(public.quotation_counters.last_seq, EXCLUDED.last_seq),
      updated_at = CURRENT_TIMESTAMP;

-- ── Seed เลข revision จากข้อมูลจริง ───────────────────────────────────────────
-- 'QP-260705012-02' -> key 'REV:QP-260705012', seq 2
INSERT INTO public.quotation_counters (counter_key, last_seq)
SELECT 'REV:' || regexp_replace(quotation_no, '-[0-9]+$', ''),
       MAX((regexp_replace(quotation_no, '^.*-', ''))::int)
FROM public.quotations
WHERE quotation_no ~ '^(QP|QT)-[0-9]{9}-[0-9]+$'
GROUP BY 1
ON CONFLICT (counter_key) DO UPDATE
  SET last_seq = GREATEST(public.quotation_counters.last_seq, EXCLUDED.last_seq),
      updated_at = CURRENT_TIMESTAMP;

COMMENT ON TABLE public.quotation_counters IS 'ตัวนับลำดับเลขที่ใบเสนอราคาแบบ atomic ต่อ (prefix:YYMM) และ REV:เลขฐาน';
