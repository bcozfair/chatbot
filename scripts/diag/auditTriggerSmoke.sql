-- ─────────────────────────────────────────────────────────────────────────────
--  ชุดตรวจ trigger บันทึกการแก้ไข (audit_row) — รันซ้ำได้ทุกครั้งที่แก้ 2026-09-03_02_audit_logs.sql
--
--  ⚠️ รันบน DB ชั่วคราวเท่านั้น ห้ามรันกับ chatbot_primus — สคริปต์นี้ INSERT/DELETE ข้อมูลจริง
--     และแก้ constraint ของ audit_logs ชั่วคราวเพื่อจงใจทำให้ trigger ล้ม
--
--  วิธีรัน (ดู scripts/diag/auditTriggerSmoke.md สำหรับขั้นตอนเตรียม DB):
--    docker exec primus-chatbot-db-1 psql -U postgres -d chatbot_logtest -X -q -f /tmp/audit_smoke.sql
--
--  ผ่าน = ทุกบรรทัดในคอลัมน์ result เป็น PASS
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on
SET client_min_messages = warning;   -- ซ่อน NOTICE ให้เหลือแต่ผลตรวจ

CREATE TEMP TABLE t_result (seq serial, name text, result text, detail text);

CREATE OR REPLACE FUNCTION pg_temp.check(p_name text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO t_result (name, result, detail)
  VALUES (p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_detail);
END;
$$;

TRUNCATE public.audit_logs RESTART IDENTITY;
DELETE FROM public.promotions WHERE code LIKE 'SMOKE-%';
DELETE FROM public.admin_users WHERE username LIKE 'smoke-%';

DO $t$
DECLARE
  v_id  integer;
  v_n   integer;
  v_row public.audit_logs%ROWTYPE;
BEGIN
  -- ── 1. INSERT ─────────────────────────────────────────────────────────────
  INSERT INTO public.promotions (code, name, discount_type, discount_value, is_active)
  VALUES ('SMOKE-A', 'ทดสอบ', 'percent', 10, true)
  RETURNING id INTO v_id;

  SELECT * INTO v_row FROM public.audit_logs ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.check('1 INSERT เขียน audit 1 แถว',
    v_row.action = 'promotion.insert' AND v_row.entity_id = v_id::text,
    format('action=%s entity_id=%s', v_row.action, v_row.entity_id));
  PERFORM pg_temp.check('1b INSERT เก็บทั้งแถวไว้ใน after และ before ว่าง',
    v_row."after" ->> 'code' = 'SMOKE-A' AND v_row."before" IS NULL,
    format('after.code=%s', v_row."after" ->> 'code'));
  PERFORM pg_temp.check('1c ชื่อที่คนอ่านออก (entity_label) มาจากคอลัมน์ code',
    v_row.entity_label = 'SMOKE-A', v_row.entity_label);
  PERFORM pg_temp.check('1d ไม่มีใครบอกว่าใครทำ ⇒ actor_type=pending รอ logworker',
    v_row.actor_type = 'pending' AND v_row.actor_source IS NULL, v_row.actor_type);

  -- ── 2. UPDATE ที่เปลี่ยนค่าจริง ────────────────────────────────────────────
  UPDATE public.promotions SET discount_value = 25, updated_at = now() WHERE id = v_id;

  SELECT * INTO v_row FROM public.audit_logs ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.check('2 UPDATE เขียน audit และบอกช่องที่เปลี่ยน',
    v_row.action = 'promotion.update' AND 'discount_value' = ANY(v_row.changed_cols),
    array_to_string(v_row.changed_cols, ','));
  PERFORM pg_temp.check('2b เก็บเฉพาะช่องที่เปลี่ยน ไม่เก็บทั้งแถว',
    v_row."before" ? 'discount_value' AND NOT (v_row."before" ? 'name'),
    v_row."before"::text);
  PERFORM pg_temp.check('2c ค่าเดิม → ค่าใหม่ ถูกต้อง',
    (v_row."before" ->> 'discount_value')::numeric = 10
    AND (v_row."after" ->> 'discount_value')::numeric = 25,
    format('%s → %s', v_row."before" ->> 'discount_value', v_row."after" ->> 'discount_value'));

  -- ── 3. UPDATE ที่ไม่ได้เปลี่ยนอะไรจริง ─────────────────────────────────────
  SELECT count(*) INTO v_n FROM public.audit_logs;
  UPDATE public.promotions SET discount_value = 25 WHERE id = v_id;                 -- ค่าเดิม
  UPDATE public.promotions SET updated_at = now() + interval '1 s' WHERE id = v_id; -- แค่ timestamp
  PERFORM pg_temp.check('3 กดบันทึกโดยไม่แก้อะไร / แก้แต่ updated_at ⇒ ไม่เขียน log',
    (SELECT count(*) FROM public.audit_logs) = v_n,
    format('ก่อน %s แถว หลัง %s แถว', v_n, (SELECT count(*) FROM public.audit_logs)));

  -- ── 4. SET LOCAL app.actor — ขั้น B ของแผน ────────────────────────────────
  PERFORM set_config('app.actor', '7|สมชาย', true);
  PERFORM set_config('app.request_id', 'abcdef0123456789', true);
  PERFORM set_config('app.client_ip', '203.0.113.9', true);
  UPDATE public.promotions SET name = 'ทดสอบ 2' WHERE id = v_id;

  SELECT * INTO v_row FROM public.audit_logs ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.check('4 แอปบอกชื่อคนทำมาเอง ⇒ actor_type=admin source=direct',
    v_row.actor_type = 'admin' AND v_row.actor_source = 'direct'
    AND v_row.actor_id = '7' AND v_row.actor_name = 'สมชาย',
    format('%s/%s %s %s', v_row.actor_type, v_row.actor_source, v_row.actor_id, v_row.actor_name));
  PERFORM pg_temp.check('4b request_id และ ip ถูกบันทึกไว้ให้ตามรอยข้ามตารางได้',
    v_row.request_id = 'abcdef0123456789' AND v_row.ip = '203.0.113.9',
    format('%s %s', v_row.request_id, v_row.ip));
  PERFORM set_config('app.actor', '', true);
  PERFORM set_config('app.request_id', '', true);
  PERFORM set_config('app.client_ip', '', true);

  -- ── 5. DELETE ─────────────────────────────────────────────────────────────
  DELETE FROM public.promotions WHERE id = v_id;
  SELECT * INTO v_row FROM public.audit_logs ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.check('5 DELETE เก็บทั้งแถวไว้ใน before',
    v_row.action = 'promotion.delete' AND v_row."before" ->> 'code' = 'SMOKE-A'
    AND v_row."after" IS NULL,
    v_row.action);

  -- ── 6. ห้ามให้ password_hash หลุดลง log ───────────────────────────────────
  INSERT INTO public.admin_users (username, password_hash, name, role)
  VALUES ('smoke-user', '$2a$10$ความลับที่ห้ามหลุด', 'ผู้ใช้ทดสอบ', 'admin');
  SELECT * INTO v_row FROM public.audit_logs ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.check('6 admin_users: password_hash ถูกตัดทิ้งก่อนเขียน',
    NOT (v_row."after" ? 'password_hash') AND v_row."after" ->> 'username' = 'smoke-user',
    v_row."after"::text);
  DELETE FROM public.admin_users WHERE username = 'smoke-user';

  -- ── 7. PK ที่ไม่ใช่ id ─────────────────────────────────────────────────────
  INSERT INTO public.product_stock_rules (internal_reference, is_active)
  VALUES ('SMOKE-REF-1', true);
  SELECT * INTO v_row FROM public.audit_logs ORDER BY id DESC LIMIT 1;
  PERFORM pg_temp.check('7 ตารางที่ PK ไม่ใช่ id (product_stock_rules) ได้ entity_id ถูกต้อง',
    v_row.entity_id = 'SMOKE-REF-1' AND v_row.entity_type = 'stock_rule',
    format('%s/%s', v_row.entity_type, v_row.entity_id));
  DELETE FROM public.product_stock_rules WHERE internal_reference = 'SMOKE-REF-1';
END;
$t$;

-- ── 8. ข้อสำคัญที่สุด: trigger ล้ม แล้วงานของผู้ใช้ต้องยังสำเร็จ ───────────────
--     จงใจทำให้ INSERT ลง audit_logs เป็นไปไม่ได้ แล้วดูว่า UPDATE promotions ยังผ่านไหม
--     (ใช้ CHECK(false) แทน REVOKE เพราะแอปต่อด้วย postgres ซึ่งเป็น superuser
--      REVOKE จึงไม่มีผล — ต้องทำให้ล้มด้วยวิธีที่ superuser ก็เลี่ยงไม่ได้)
INSERT INTO public.promotions (code, name, discount_type, discount_value, is_active)
VALUES ('SMOKE-B', 'ทดสอบล้ม', 'percent', 5, true);

ALTER TABLE public.audit_logs ADD CONSTRAINT smoke_break CHECK (false) NOT VALID;

DO $t$
DECLARE v_n integer; v_ok boolean;
BEGIN
  SELECT count(*) INTO v_n FROM public.audit_logs;
  BEGIN
    UPDATE public.promotions SET discount_value = 99 WHERE code = 'SMOKE-B';
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;

  PERFORM pg_temp.check('8 audit_logs เขียนไม่ได้ ⇒ UPDATE ของผู้ใช้ต้องยังสำเร็จ',
    v_ok AND (SELECT discount_value FROM public.promotions WHERE code = 'SMOKE-B') = 99,
    CASE WHEN v_ok THEN 'คำสั่งผ่าน' ELSE 'คำสั่งล้มตาม trigger ← ห้ามเกิด' END);
  PERFORM pg_temp.check('8b และต้องไม่มีแถว audit เพิ่ม (หายไปเงียบ ๆ ตามที่ออกแบบ)',
    (SELECT count(*) FROM public.audit_logs) = v_n,
    format('%s แถว', (SELECT count(*) FROM public.audit_logs)));
END;
$t$;

ALTER TABLE public.audit_logs DROP CONSTRAINT smoke_break;
DELETE FROM public.promotions WHERE code LIKE 'SMOKE-%';

-- ── 9. ตารางต้องห้าม ต้องไม่มี trigger ติดอยู่เด็ดขาด ─────────────────────────
DO $t$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE tg.tgname = 'trg_audit'
     AND c.relname IN ('quotations','quotation_counters','messages','products','customers',
                       'sale_orders','api_logs','system_logs','audit_logs');
  PERFORM pg_temp.check('9 ตารางต้องห้าม (ใบเสนอราคา/แชท/sync/log) ไม่มี trg_audit',
    v_bad IS NULL, COALESCE('พบที่: ' || v_bad, 'สะอาด'));

  PERFORM pg_temp.check('9b ตารางตั้งค่าติด trg_audit ครบ 11 ตัว',
    (SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE tg.tgname = 'trg_audit') = 11,
    format('%s ตัว', (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_audit')));
END;
$t$;

SELECT seq, result, name, detail FROM t_result ORDER BY seq;

SELECT CASE WHEN count(*) = 0 THEN '✅ ผ่านทั้งหมด'
            ELSE '❌ ไม่ผ่าน ' || count(*) || ' ข้อ' END AS "สรุป"
  FROM t_result WHERE result <> 'PASS';
