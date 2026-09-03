-- ─────────────────────────────────────────────────────────────────────────────
--  เฟส 3 ของแผน docs/plan-logging-audit-compliance.md — กอง "Audit log"
--
--  ตอบคำถาม "ใครแก้ข้อมูลอะไร จากค่าอะไรเป็นค่าอะไร" ซึ่งตอนนี้ตอบได้เฉพาะการส่งออกใบเสนอราคา
--
--  ทำไมเป็น DB trigger ไม่ใช่การเรียกจากโค้ด:
--    โปรเจกต์นี้เป็น Express + pg ดิบ ไม่มี ORM จึงไม่มีของสำเร็จรูป · ถ้าเขียนเรียกเองทุก endpoint
--    (43 จุด) จะลืมเมื่อไหร่ก็เป็นช่องโหว่ที่ไม่มีใครรู้ · และสำคัญกว่านั้น ระบบนี้มี scripts/,
--    งาน sync และการเข้า psql แก้มือ ซึ่ง "โค้ดแอปมองไม่เห็น" — trigger คือคำตอบมาตรฐานของ
--    สถานการณ์แบบนี้พอดี: ไม่ว่าใครแก้ผ่านช่องทางไหนก็ถูกบันทึก
--
--  ══ 🚫 กฎถาวร — ห้ามติด trigger ตัวนี้กับตารางเหล่านี้เด็ดขาด ══
--     quotations · quotation_counters · messages · products · customers
--     sale_orders · customers_data_view · api_logs · system_logs · audit_logs
--
--     5 ตัวแรก = เส้นทางออกใบเสนอราคาและแชท (เขียนทุกครั้งที่ลูกค้าคุยกับบอท)
--     ที่เหลือ = ตารางที่ sync/logger เขียนรัวเป็นหมื่นแถวต่อรอบ
--     ติดเมื่อไหร่ = เพิ่มงานให้ทุก INSERT บนเส้นทางที่ผู้ใช้รออยู่ + ตาราง audit บวมจนไร้ประโยชน์
--
--  ══ ความเสี่ยงข้อเดียวที่มีจริง และวิธีปิด ══
--     trigger ทำงานใน transaction เดียวกับคำสั่งเขียนจริง ⇒ ถ้ามันโยน error คำสั่งของผู้ใช้
--     จะ rollback ตาม ⇒ แอดมินกดบันทึกไม่ได้
--     ปิดด้วย EXCEPTION WHEN OTHERS ในตัวฟังก์ชัน (ดูท้ายฟังก์ชัน) ⇒ เลวร้ายสุดเหลือแค่
--     "audit หาย 1 แถว + มี WARNING ใน log" ซึ่งยอมรับได้ ส่วนงานของผู้ใช้ผ่านตามปกติเสมอ
--     มีเคสทดสอบข้อนี้อยู่ใน scripts/diag/auditTriggerSmoke.ts
--
--  รัน: npx tsx scripts/runMigration.ts migrations/changes/2026-09-03_02_audit_logs.sql
--  idempotent — รันซ้ำได้ผลเท่าเดิม (DROP TRIGGER IF EXISTS ก่อน CREATE ทุกตัว)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id            bigserial     PRIMARY KEY,
  occurred_at   timestamptz   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_id    varchar(16),
  actor_type    varchar(12)   NOT NULL,
  actor_id      varchar(60),
  actor_name    varchar(120),
  actor_source  varchar(10),
  action        varchar(60)   NOT NULL,
  entity_type   varchar(40),
  entity_id     varchar(80),
  entity_label  varchar(200),
  changed_cols  text[],
  "before"      jsonb,
  "after"       jsonb,
  ip            varchar(45),
  result        varchar(12)   NOT NULL DEFAULT 'ok',
  note          text
);

-- คำอธิบายคอลัมน์ที่ไม่ชัดในตัวเอง (ไม่ใช้ COMMENT ON COLUMN ตามกติกาของโปรเจกต์):
--   actor_type    admin | system | pending | unknown | ambiguous
--                 pending   = trigger เขียนไว้ก่อน รอ logworker ไปหาว่าใครทำจาก api_logs
--                 unknown   = worker หาไม่เจอ (แก้จาก psql / script ตรง ๆ) ← พิสูจน์ว่าเลี่ยงไม่ได้
--                 ambiguous = ช่วงเวลานั้นมีแอดมินมากกว่า 1 คนยิงคำสั่งเขียน แยกไม่ออก
--   actor_id      ไม่มี FK โดยเจตนา — DELETE /api/admin/users/:id มีจริง ถ้าผู้ใช้ถูกลบ log ต้องไม่หายตาม
--   actor_name    ชื่อ ณ เวลานั้น เก็บซ้ำไว้ตรงนี้เลย — ชื่อเปลี่ยนทีหลังห้ามย้อนแก้ประวัติ
--                 (ต่างจาก api_logs ที่ JOIN เอาตอนอ่าน เพราะตารางนั้นไม่ใช่หลักฐาน)
--   actor_source  direct     = แอปบอกมาตรง ๆ ผ่าน SET LOCAL app.actor (แม่นยำ 100%)
--                 correlated = worker เทียบเวลากับ api_logs เอา (แม่นสูงแต่ไม่ใช่ 100%)
--                 ⚠️ หน้าจอต้องแสดงค่านี้ให้เห็น ห้ามแสดงชื่อเฉย ๆ เหมือนกันทั้งสองแบบ
--   before/after  INSERT → เก็บทั้งแถวใน after · DELETE → เก็บทั้งแถวใน before
--                 UPDATE → เก็บ "เฉพาะช่องที่เปลี่ยน" ทั้งสองฝั่ง เพราะนั่นคือคำถามที่ตารางนี้ตอบ
--                 และทำให้แถวเล็กพอที่จะเก็บ 2 ปีได้โดยไม่ต้องคิดเรื่องขนาด
--                 ทุกกรณีตัด password_hash ทิ้งก่อนเขียนเสมอ (ดู REDACT ในฟังก์ชัน)
--   result        ok | denied — เผื่อวันหน้าบันทึก "พยายามแก้แล้วไม่มีสิทธิ์" ตอนนี้เป็น ok เสมอ

-- ตารางนี้เขียนไม่กี่สิบแถว/วัน จึงใส่ index ได้เต็มที่
-- (เหตุผลที่ api_logs จงใจไม่ใส่ index — ต้นทุนของทุก insert — ใช้ไม่ได้กับตารางนี้)
CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred
  ON public.audit_logs (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON public.audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
  ON public.audit_logs (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_request
  ON public.audit_logs (request_id) WHERE request_id IS NOT NULL;
-- logworker ไล่เก็บแถวที่ยังไม่รู้ว่าใครทำ — partial index ⇒ เล็กและว่างเปล่าเกือบตลอดเวลา
CREATE INDEX IF NOT EXISTS idx_audit_logs_pending
  ON public.audit_logs (occurred_at) WHERE actor_type = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
--  trigger กลางตัวเดียว ใช้ซ้ำทุกตารางผ่าน TG_ARGV
--    TG_ARGV[0] = entity_type            เช่น 'promotion'
--    TG_ARGV[1] = คอลัมน์ที่ใช้เป็นชื่อให้คนอ่าน (เว้นว่างได้)
--    TG_ARGV[2] = คอลัมน์ primary key    (ไม่ใส่ = 'id')
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_row() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- ช่องที่ห้ามหลุดลง log ไม่ว่าตารางไหน — ตัดทิ้งก่อนเขียนเสมอ
  REDACT       CONSTANT text[] := ARRAY['password_hash', 'password', 'token', 'secret', 'api_key'];
  -- UPDATE ที่เปลี่ยนแค่ช่องเหล่านี้ = การกดบันทึกที่ไม่ได้แก้อะไรจริง ⇒ ไม่เขียน log
  NOISE_ONLY   CONSTANT text[] := ARRAY['updated_at', 'created_at'];

  v_entity     text := TG_ARGV[0];
  v_label_col  text := NULLIF(TG_ARGV[1], '');
  v_pk_col     text := COALESCE(NULLIF(TG_ARGV[2], ''), 'id');

  v_old        jsonb;
  v_new        jsonb;
  v_before     jsonb;
  v_after      jsonb;
  v_changed    text[];
  v_row        jsonb;
  v_actor_raw  text;
  v_actor_id   text;
  v_actor_name text;
  v_actor_type text;
  v_actor_src  text;
  v_request_id text;
  v_ip         text;
BEGIN
  v_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - REDACT END;
  v_new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) - REDACT END;

  IF TG_OP = 'UPDATE' THEN
    -- ช่องที่ค่าต่างจริง ๆ (IS DISTINCT FROM ⇒ NULL↔ค่า ก็นับว่าเปลี่ยน)
    SELECT array_agg(k ORDER BY k) INTO v_changed
      FROM (
        SELECT key AS k FROM jsonb_each(v_old) o WHERE v_new -> o.key IS DISTINCT FROM o.value
        UNION
        SELECT key AS k FROM jsonb_each(v_new) n WHERE v_old -> n.key IS DISTINCT FROM n.value
      ) s;

    -- ไม่เปลี่ยนอะไรเลย หรือเปลี่ยนแต่ timestamp ⇒ ไม่มีอะไรให้บันทึก
    IF v_changed IS NULL OR v_changed <@ NOISE_ONLY THEN
      RETURN NULL;
    END IF;

    -- เก็บเฉพาะช่องที่เปลี่ยน — นั่นคือคำถามที่ตารางนี้ตอบ และทำให้แถวเล็กพอเก็บ 2 ปีได้สบาย
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_before FROM unnest(v_changed) k;
    SELECT jsonb_object_agg(k, v_new -> k) INTO v_after  FROM unnest(v_changed) k;
  ELSE
    v_before := v_old;
    v_after  := v_new;
    SELECT array_agg(key ORDER BY key) INTO v_changed FROM jsonb_each(COALESCE(v_new, v_old));
  END IF;

  v_row := COALESCE(v_new, v_old);

  -- ใครเป็นคนแก้ — 2 ทาง
  --   1. แอปบอกมาตรง ๆ ด้วย SET LOCAL app.actor = '<id>|<ชื่อ>' (ขั้น B ของแผน · ทยอยเติมทีละ endpoint)
  --   2. ไม่มี ⇒ ทิ้งไว้เป็น pending ให้ logworker ไปเทียบเวลากับ api_logs เอา (ขั้น A · ใช้ได้ตั้งแต่วันแรก)
  -- current_setting(..., true) = missing_ok ⇒ คืน NULL แทนที่จะ error เมื่อยังไม่มีใครตั้งค่า
  v_actor_raw  := NULLIF(current_setting('app.actor', true), '');
  v_request_id := NULLIF(current_setting('app.request_id', true), '');
  v_ip         := NULLIF(current_setting('app.client_ip', true), '');

  IF v_actor_raw IS NOT NULL THEN
    v_actor_id   := split_part(v_actor_raw, '|', 1);
    v_actor_name := NULLIF(split_part(v_actor_raw, '|', 2), '');
    v_actor_type := 'admin';
    v_actor_src  := 'direct';
  ELSE
    v_actor_type := 'pending';
  END IF;

  INSERT INTO public.audit_logs (
    request_id, actor_type, actor_id, actor_name, actor_source,
    action, entity_type, entity_id, entity_label, changed_cols, "before", "after", ip
  ) VALUES (
    left(v_request_id, 16), v_actor_type, left(v_actor_id, 60), left(v_actor_name, 120), v_actor_src,
    v_entity || '.' || lower(TG_OP),
    v_entity,
    left(v_row ->> v_pk_col, 80),
    CASE WHEN v_label_col IS NULL THEN NULL ELSE left(v_row ->> v_label_col, 200) END,
    v_changed, v_before, v_after,
    left(v_ip, 45)
  );

  RETURN NULL;   -- AFTER trigger — ค่าที่คืนถูกละเลยอยู่แล้ว

EXCEPTION WHEN OTHERS THEN
  -- ⚠️ บรรทัดนี้คือหัวใจของความปลอดภัยทั้งไฟล์ ห้ามลบ
  -- trigger อยู่ใน transaction เดียวกับคำสั่งของผู้ใช้ ถ้าปล่อยให้ error หลุดออกไป
  -- การกดบันทึกของแอดมินจะ rollback ตาม · ยอมให้ audit หาย 1 แถวดีกว่าทำให้คนทำงานไม่ได้
  RAISE WARNING '[audit] % บน % ล้มเหลว: % (%)', TG_OP, TG_TABLE_NAME, SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
--  ติด trigger — 11 ตารางตั้งค่าเท่านั้น (แก้กันวันละไม่กี่ครั้ง)
--  ทุกตัว DROP ก่อน CREATE ⇒ รันไฟล์นี้ซ้ำได้ และแก้ argument ทีหลังได้ด้วยการรันซ้ำ
-- ─────────────────────────────────────────────────────────────────────────────
DO $mk$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('promotions',              'promotion',      'code',                'id'),
      ('quotation_rules',         'quotation_rule', 'brand',               'id'),
      ('product_optional_links',  'optional_link',  'trigger_product_id',  'id'),
      ('product_stock_rules',     'stock_rule',     'internal_reference',  'internal_reference'),
      ('product_moq_rules',       'moq_rule',       'internal_reference',  'internal_reference'),
      ('shipping_fee_config',     'shipping_fee',   'default_item_name',   'id'),
      ('quotation_credit_policy', 'credit_policy',  'mode',                'id'),
      ('quotation_blacklist',     'blacklist',      'company_id',          'id'),
      ('admin_users',             'admin_user',     'username',            'id'),
      ('salesperson',             'salesperson',    'name',                'user_id'),
      ('sync_settings',           'sync_setting',   'resources',           'id')
    ) AS v(tbl, entity, label_col, pk_col)
  LOOP
    -- ตารางยังไม่มีบนเครื่องนี้ (DB เก่ากว่า migration บางตัว) ⇒ ข้ามไป ไม่ทำให้ทั้งไฟล์ล้ม
    IF to_regclass('public.' || t.tbl) IS NULL THEN
      RAISE NOTICE '[audit] ข้าม % — ยังไม่มีตารางนี้', t.tbl;
      CONTINUE;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON public.%I', t.tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.audit_row(%L, %L, %L)',
      t.tbl, t.entity, t.label_col, t.pk_col);
  END LOOP;
END;
$mk$;

-- ─────────────────────────────────────────────────────────────────────────────
--  ความถูกต้องแท้จริง (integrity) — ตารางนี้ต้องแก้ย้อนหลังไม่ได้ ตาม พ.ร.บ.คอมพิวเตอร์ ม.26
--
--  ⚠️ REVOKE ตรงนี้ไม่มีผลกับ superuser (แอปต่อด้วย postgres ซึ่งข้ามทุก permission)
--     จึงเป็นการ "ประกาศเจตนา + กันพลาดของ role ธรรมดา" ไม่ใช่กำแพงจริง
--     กำแพงจริงต้องรอเฟส 6 (ให้แอปใช้ DB role จำกัดสิทธิ์แทน postgres) ซึ่งเสี่ยงพอที่จะแยกทำ
--     ตัวคุมจริงในระหว่างนี้คือ: แอปไม่มีโค้ดที่ UPDATE/DELETE ตารางนี้เลยสักบรรทัด
--     + ลายนิ้วมือรายวัน (traffic_daily.audit_digest) ที่สำเนาออกนอกเครื่องพร้อม backup
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM PUBLIC;
