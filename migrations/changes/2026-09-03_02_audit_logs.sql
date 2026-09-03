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
--  กติกาที่ทุกจุดใช้ร่วมกัน — แยกเป็นฟังก์ชันเพื่อให้ "แก้ที่เดียวแล้วมีผลทั้งระบบ"
--  (ถ้าวันหน้าต้องเพิ่มช่องที่ต้องปิดบัง หรือเปลี่ยนวิธีรู้ว่าใครเป็นคนแก้ ให้แก้แค่ 3 ฟังก์ชันนี้)
-- ─────────────────────────────────────────────────────────────────────────────

-- ช่องที่ห้ามหลุดลง log ไม่ว่าตารางไหน — ตัดทิ้งก่อนเขียนเสมอ
CREATE OR REPLACE FUNCTION public.audit_redact_cols() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT ARRAY['password_hash', 'password', 'token', 'secret', 'api_key'] $$;

-- UPDATE ที่เปลี่ยนแค่ช่องเหล่านี้ = การกดบันทึกที่ไม่ได้แก้อะไรจริง ⇒ ไม่เขียน log
CREATE OR REPLACE FUNCTION public.audit_noise_cols() RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT ARRAY['updated_at', 'created_at'] $$;

-- ใครเป็นคนแก้ — 2 ทาง
--   1. แอปบอกมาตรง ๆ ด้วย SET LOCAL app.actor = '<id>|<ชื่อ>' (ขั้น B ของแผน · ทยอยเติมทีละ endpoint)
--   2. ไม่มี ⇒ ทิ้งไว้เป็น pending ให้ logworker ไปเทียบเวลากับ api_logs เอา (ขั้น A · ใช้ได้ตั้งแต่วันแรก)
-- current_setting(..., true) = missing_ok ⇒ คืน NULL แทนที่จะ error เมื่อยังไม่มีใครตั้งค่า
CREATE OR REPLACE FUNCTION public.audit_actor_ctx() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$fn$
DECLARE
  v_raw text := NULLIF(current_setting('app.actor', true), '');
BEGIN
  RETURN jsonb_build_object(
    'request_id', NULLIF(current_setting('app.request_id', true), ''),
    'ip',         NULLIF(current_setting('app.client_ip',  true), ''),
    'actor_type', CASE WHEN v_raw IS NULL THEN 'pending' ELSE 'admin'  END,
    'actor_src',  CASE WHEN v_raw IS NULL THEN NULL      ELSE 'direct' END,
    'actor_id',   CASE WHEN v_raw IS NULL THEN NULL      ELSE split_part(v_raw, '|', 1) END,
    'actor_name', CASE WHEN v_raw IS NULL THEN NULL      ELSE NULLIF(split_part(v_raw, '|', 2), '') END
  );
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
--  trigger กลางตัวเดียว ใช้ซ้ำทุกตารางผ่าน TG_ARGV
--    TG_ARGV[0] = entity_type            เช่น 'promotion'
--    TG_ARGV[1] = คอลัมน์ที่ใช้เป็นชื่อให้คนอ่าน (เว้นว่างได้)
--    TG_ARGV[2] = คอลัมน์ primary key    (ไม่ใส่ = 'id')
--
--  ══ ทำไมเป็น FOR EACH STATEMENT ไม่ใช่ FOR EACH ROW ══
--  ของเดิมเป็น row-level แล้ววัดจริงบนข้อมูลจริงพบว่า POST /api/admin/stock-rules แบบ
--  "ยกทั้งสายการผลิต" (สายใหญ่สุด 35,141 รายการ) ทำให้:
--     เวลา 672 ms → 4,106 ms (ช้าลง 6 เท่า)  และเขียน audit 35,141 แถวจากการกดปุ่มครั้งเดียว
--  ซึ่งจะกลบรายการแก้ไขจริงในหน้าจอจนอ่านไม่ออก — ตารางที่ควรเป็น "หลักฐาน" กลายเป็นกองขยะ
--
--  statement-level + transition table แก้ทั้งสองข้อพร้อมกัน:
--     คำสั่งเล็ก (≤ BULK_THRESHOLD แถว) → เขียนรายตัวเหมือนเดิมเป๊ะ ได้ค่าเดิม→ค่าใหม่ครบ
--     คำสั่งใหญ่                        → เขียนสรุปแถวเดียว บอกจำนวน ช่องที่เปลี่ยน และตัวอย่างรายการ
--  ⇒ การแก้จากหน้าจอ (ทีละตัว) ได้รายละเอียดเท่าเดิม · การกดยกชุดไม่ทำให้ตารางบวมและไม่ช้า
--
--  ⚠️ ข้อแลกเปลี่ยนที่ยอมรับแล้ว: ของเดิมถ้า audit พังจะหายทีละ 1 แถว ตอนนี้จะหายทั้งคำสั่ง
--     แต่ "งานของผู้ใช้ต้องผ่านเสมอ" ยังเหมือนเดิม เพราะ EXCEPTION WHEN OTHERS ยังอยู่ที่เดิม
--
--  ⚠️ transition table ประกาศรวมหลาย event ในคำสั่งเดียวไม่ได้ (ข้อจำกัดของ PostgreSQL)
--     ⇒ ต้องแยกเป็น trg_audit_ins / trg_audit_upd / trg_audit_del ตารางละ 3 ตัว
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_stmt() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- เกินเท่านี้ = "การกดยกชุด" ไม่ใช่ "การแก้ทีละรายการ" ⇒ เก็บเป็นสรุป
  -- 50 มาจาก: การเลือกด้วยมือในหน้าจอแทบไม่เกินไม่กี่สิบ ส่วนการยกทั้งสายเป็นหลักพันขึ้นไป
  BULK_THRESHOLD CONSTANT int := 50;
  -- เก็บตัวอย่างรายการที่กระทบไว้เท่านี้ในแถวสรุป — พอให้ตามรอยต่อได้ว่าเป็นชุดไหน
  SAMPLE_SIZE    CONSTANT int := 20;

  v_entity    text := TG_ARGV[0];
  v_label_col text := NULLIF(TG_ARGV[1], '');
  v_pk_col    text := COALESCE(NULLIF(TG_ARGV[2], ''), 'id');

  v_redact text[] := public.audit_redact_cols();
  v_noise  text[] := public.audit_noise_cols();
  v_ctx    jsonb  := public.audit_actor_ctx();

  v_count  int;      -- จำนวนแถวที่เปลี่ยน "จริง"
  v_cols   text[];   -- ช่องทั้งหมดที่เปลี่ยนในคำสั่งนี้ (รวมทุกแถว)
  v_detail jsonb;    -- รายละเอียดรายแถว — เก็บแค่ BULK_THRESHOLD แถวแรกเท่านั้น
  v_sample jsonb;    -- ตัวอย่าง pk สำหรับแถวสรุป
  d        jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    WITH o AS MATERIALIZED (SELECT (to_jsonb(t) - v_redact) AS j FROM audit_old t),
         n AS MATERIALIZED (SELECT (to_jsonb(t) - v_redact) AS j FROM audit_new t),
         pair AS (
           SELECT o.j AS oj, n.j AS nj
             FROM o JOIN n ON o.j ->> v_pk_col = n.j ->> v_pk_col
         ),
         chg AS (
           -- ตัวกรองราคาถูก: เทียบทั้งก้อนครั้งเดียวต่อแถว หลังถอดช่องที่ไม่นับว่าเป็นการแก้ไข
           -- (ของเดิมแตกเป็น key/value ทุกแถวก่อนค่อยตัดสิน ซึ่งแพงกว่ามากตอนกดยกชุด)
           SELECT oj, nj, row_number() OVER () AS rn
             FROM pair
            WHERE (oj - v_noise) IS DISTINCT FROM (nj - v_noise)
         )
    SELECT
      (SELECT count(*)::int FROM chg),
      -- ช่องที่เปลี่ยน: ดูทางเดียวพอ — to_jsonb ของแถวในตารางเดียวกันมีคีย์ครบเท่ากันเสมอ
      -- จึงไม่มีทางที่ "ช่องหายไป" ต้องไล่ทาง old → new อีกรอบ
      (SELECT array_agg(DISTINCT e.key ORDER BY e.key)
         FROM chg c, LATERAL jsonb_each(c.nj) e
        WHERE c.oj -> e.key IS DISTINCT FROM e.value),
      -- รายละเอียดรายแถว — คิดเฉพาะแถวที่จะเขียนจริงเท่านั้น
      (SELECT jsonb_agg(jsonb_build_object(
                'pk',    c.nj ->> v_pk_col,
                'label', CASE WHEN v_label_col IS NULL THEN NULL ELSE c.nj ->> v_label_col END,
                'ch',    (SELECT jsonb_agg(e.key ORDER BY e.key)
                            FROM jsonb_each(c.nj) e WHERE c.oj -> e.key IS DISTINCT FROM e.value),
                'b',     (SELECT jsonb_object_agg(e.key, c.oj -> e.key)
                            FROM jsonb_each(c.nj) e WHERE c.oj -> e.key IS DISTINCT FROM e.value),
                'a',     (SELECT jsonb_object_agg(e.key, e.value)
                            FROM jsonb_each(c.nj) e WHERE c.oj -> e.key IS DISTINCT FROM e.value)
              ) ORDER BY c.rn)
         FROM chg c WHERE c.rn <= BULK_THRESHOLD),
      (SELECT jsonb_agg(c.nj ->> v_pk_col ORDER BY c.rn) FROM chg c WHERE c.rn <= SAMPLE_SIZE)
    INTO v_count, v_cols, v_detail, v_sample;

  ELSE
    -- INSERT / DELETE — ทั้งแถวคือเนื้อหา ไม่ต้องเทียบอะไร
    -- นับก่อนแล้วค่อยตัดสินใจ ⇒ คำสั่งใหญ่ไม่ต้องแปลงทุกแถวเป็น jsonb ทิ้งเปล่า ๆ
    IF TG_OP = 'INSERT' THEN
      SELECT count(*)::int INTO v_count FROM audit_new;
    ELSE
      SELECT count(*)::int INTO v_count FROM audit_old;
    END IF;

    IF COALESCE(v_count, 0) = 0 THEN
      RETURN NULL;
    END IF;

    IF v_count <= BULK_THRESHOLD THEN
      IF TG_OP = 'INSERT' THEN
        SELECT jsonb_agg(jsonb_build_object(
                 'pk', j ->> v_pk_col,
                 'label', CASE WHEN v_label_col IS NULL THEN NULL ELSE j ->> v_label_col END,
                 'ch', (SELECT jsonb_agg(e.key ORDER BY e.key) FROM jsonb_each(j) e),
                 'b', NULL, 'a', j)),
               (SELECT array_agg(e.key ORDER BY e.key)
                  FROM jsonb_each((SELECT to_jsonb(t) - v_redact FROM audit_new t LIMIT 1)) e)
          INTO v_detail, v_cols
          FROM (SELECT (to_jsonb(t) - v_redact) AS j FROM audit_new t) s;
      ELSE
        SELECT jsonb_agg(jsonb_build_object(
                 'pk', j ->> v_pk_col,
                 'label', CASE WHEN v_label_col IS NULL THEN NULL ELSE j ->> v_label_col END,
                 'ch', (SELECT jsonb_agg(e.key ORDER BY e.key) FROM jsonb_each(j) e),
                 'b', j, 'a', NULL)),
               (SELECT array_agg(e.key ORDER BY e.key)
                  FROM jsonb_each((SELECT to_jsonb(t) - v_redact FROM audit_old t LIMIT 1)) e)
          INTO v_detail, v_cols
          FROM (SELECT (to_jsonb(t) - v_redact) AS j FROM audit_old t) s;
      END IF;
    ELSE
      -- ยกชุด: ต้องการแค่ชุดคอลัมน์กับตัวอย่าง ⇒ แตะแค่ไม่กี่แถว ไม่ใช่ทั้งคำสั่ง
      IF TG_OP = 'INSERT' THEN
        SELECT array_agg(e.key ORDER BY e.key) INTO v_cols
          FROM jsonb_each((SELECT to_jsonb(t) - v_redact FROM audit_new t LIMIT 1)) e;
        SELECT jsonb_agg(j ->> v_pk_col) INTO v_sample
          FROM (SELECT to_jsonb(t) AS j FROM audit_new t LIMIT SAMPLE_SIZE) s;
      ELSE
        SELECT array_agg(e.key ORDER BY e.key) INTO v_cols
          FROM jsonb_each((SELECT to_jsonb(t) - v_redact FROM audit_old t LIMIT 1)) e;
        SELECT jsonb_agg(j ->> v_pk_col) INTO v_sample
          FROM (SELECT to_jsonb(t) AS j FROM audit_old t LIMIT SAMPLE_SIZE) s;
      END IF;
    END IF;
  END IF;

  -- ไม่มีอะไรเปลี่ยนจริง (คำสั่งไม่โดนแถวไหน หรือ UPDATE ที่แตะแค่ timestamp) ⇒ ไม่เขียน log
  IF COALESCE(v_count, 0) = 0 THEN
    RETURN NULL;
  END IF;

  IF v_count <= BULK_THRESHOLD THEN
    -- เส้นทางปกติ — รายละเอียดครบเท่าเดิมทุกช่อง
    FOR d IN SELECT * FROM jsonb_array_elements(v_detail) LOOP
      INSERT INTO public.audit_logs (
        request_id, actor_type, actor_id, actor_name, actor_source,
        action, entity_type, entity_id, entity_label, changed_cols, "before", "after", ip
      ) VALUES (
        left(v_ctx ->> 'request_id', 16),
        v_ctx ->> 'actor_type',
        left(v_ctx ->> 'actor_id', 60),
        left(v_ctx ->> 'actor_name', 120),
        v_ctx ->> 'actor_src',
        v_entity || '.' || lower(TG_OP),
        v_entity,
        left(d ->> 'pk', 80),
        left(d ->> 'label', 200),
        ARRAY(SELECT jsonb_array_elements_text(d -> 'ch')),
        NULLIF(d -> 'b', 'null'::jsonb),
        NULLIF(d -> 'a', 'null'::jsonb),
        left(v_ctx ->> 'ip', 45)
      );
    END LOOP;
  ELSE
    -- เส้นทางยกชุด — สรุปแถวเดียวต่อ 1 คำสั่ง
    INSERT INTO public.audit_logs (
      request_id, actor_type, actor_id, actor_name, actor_source,
      action, entity_type, entity_id, entity_label, changed_cols, "before", "after", ip, note
    ) VALUES (
      left(v_ctx ->> 'request_id', 16),
      v_ctx ->> 'actor_type',
      left(v_ctx ->> 'actor_id', 60),
      left(v_ctx ->> 'actor_name', 120),
      v_ctx ->> 'actor_src',
      v_entity || '.bulk_' || lower(TG_OP),
      v_entity,
      NULL,
      to_char(v_count, 'FM999,999,999') || ' รายการ',
      v_cols,
      NULL,
      jsonb_build_object('rows', v_count, 'sample', v_sample),
      left(v_ctx ->> 'ip', 45),
      format('คำสั่งเดียวกระทบ %s รายการ (เกินเพดาน %s) — เก็บเป็นสรุปแถวเดียวแทนรายตัว '
             'เพื่อไม่ให้บันทึกการแก้ไขรายการอื่นจมหาย · "after" เก็บจำนวนจริงกับตัวอย่าง %s รายการแรกไว้',
             v_count, BULK_THRESHOLD, SAMPLE_SIZE)
    );
  END IF;

  RETURN NULL;   -- AFTER trigger — ค่าที่คืนถูกละเลยอยู่แล้ว

EXCEPTION WHEN OTHERS THEN
  -- ⚠️ บรรทัดนี้คือหัวใจของความปลอดภัยทั้งไฟล์ ห้ามลบ
  -- trigger อยู่ใน transaction เดียวกับคำสั่งของผู้ใช้ ถ้าปล่อยให้ error หลุดออกไป
  -- การกดบันทึกของแอดมินจะ rollback ตาม · ยอมให้ audit หายดีกว่าทำให้คนทำงานไม่ได้
  RAISE WARNING '[audit] % บน % ล้มเหลว: % (%)', TG_OP, TG_TABLE_NAME, SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
--  ติด trigger — 11 ตารางตั้งค่าเท่านั้น (แก้กันวันละไม่กี่ครั้ง)
--  ตารางละ 3 ตัว (ins/upd/del) เพราะ transition table รวม event ไม่ได้
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

    -- trg_audit = ตัว row-level ของรุ่นก่อน ถอดทิ้งด้วยถ้าเคยรันไฟล์รุ่นเก่ามาแล้ว
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit     ON public.%I', t.tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_ins ON public.%I', t.tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_upd ON public.%I', t.tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_del ON public.%I', t.tbl);

    EXECUTE format(
      'CREATE TRIGGER trg_audit_ins AFTER INSERT ON public.%I
         REFERENCING NEW TABLE AS audit_new
         FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt(%L, %L, %L)',
      t.tbl, t.entity, t.label_col, t.pk_col);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_upd AFTER UPDATE ON public.%I
         REFERENCING OLD TABLE AS audit_old NEW TABLE AS audit_new
         FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt(%L, %L, %L)',
      t.tbl, t.entity, t.label_col, t.pk_col);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_del AFTER DELETE ON public.%I
         REFERENCING OLD TABLE AS audit_old
         FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt(%L, %L, %L)',
      t.tbl, t.entity, t.label_col, t.pk_col);
  END LOOP;
END;
$mk$;

-- ฟังก์ชัน row-level ของรุ่นก่อนไม่มีใครใช้แล้ว — ไม่ใส่ CASCADE โดยเจตนา
-- ถ้ายังมี trigger ตัวไหนอ้างอยู่ ให้ล้มตรงนี้ดังกว่าเงียบ ๆ แล้วเหลือของค้าง
DROP FUNCTION IF EXISTS public.audit_row();

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
