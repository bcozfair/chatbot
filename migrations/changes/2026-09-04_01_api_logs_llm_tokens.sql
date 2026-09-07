-- ─────────────────────────────────────────────────────────────────────────────
--  แผน G#2 — เก็บ "prompt token ที่ DeepSeek คืนมาจากแคช" ลง api_logs
--
--  ทำไมเป็นคอลัมน์ ไม่ใช่ log ข้อความ:
--    คำถามที่ต้องตอบคือสัดส่วนสะสม ("แคชติดกี่ % · ดีขึ้นไหมหลังแก้ prompt")
--    ไม่ใช่คำถามรายเหตุการณ์ ⇒ ต้อง AVG/GROUP BY ย้อนหลังได้ · และ logworker เก็บ
--    เฉพาะระดับ warn ขึ้นไป (SYSTEM_LOG_DB_LEVEL) บรรทัด info แบบนี้จะหายทั้งหมด
--    ส่วนการดัน level ให้ต่ำลงทั้งระบบทำ system_logs โตวันละหลาย MB โดยไม่จำเป็น
--
--  ยืนยันแล้วว่าโมเดลคืนตัวเลขนี้จริง (ยิงจริง 2026-09-04, deepseek-v4-flash):
--    call 1  prompt 2,129 · prompt_cache_hit_tokens 0     · miss 2,129
--    call 2  prompt 2,129 · prompt_cache_hit_tokens 2,048 · miss 81   ← prefix เดิมเป๊ะ
--  ⇒ แคชทำงาน เข้าเป็นบล็อก (2,048 = 32 × 64 token) และเข้าเฉพาะส่วนหัวที่ตรงกันเป๊ะ
--
--  ADD COLUMN nullable ไม่มี DEFAULT = แก้ catalog อย่างเดียว ไม่ rewrite ตาราง
--  (ปัจจุบัน 18,305 แถว / 5.5 MB) ⇒ รันได้ทุกเวลา และรันก่อน deploy โค้ดใหม่ได้
--
--  รัน: docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1 \
--         -f - < migrations/changes/2026-09-04_01_api_logs_llm_tokens.sql
--  ไฟล์นี้ idempotent — รันซ้ำได้ผลเท่าเดิม
-- ─────────────────────────────────────────────────────────────────────────────

-- คำอธิบายคอลัมน์ (ไม่ใช้ COMMENT ON COLUMN ตามกติกาของโปรเจกต์):
--   llm_prompt_tokens  prompt token รวมทุก call ของงานนี้ · NULL = ไม่ใช่งาน webhook
--   llm_cached_tokens  ส่วนที่ DeepSeek คืนจากแคช (prompt_cache_hit_tokens) รวมทุก call
--                      อัตราแคช = llm_cached_tokens / llm_prompt_tokens
--                      ต่ำ = prompt เปลี่ยนหัวทุกครั้ง มีของที่ควรย้ายไปท้าย prompt
--
--  ⚠️ นับเฉพาะ call ที่สำเร็จ ต่างจาก llm_ms/llm_calls ที่นับ call ที่พังด้วย
--     — call ที่พังไม่มี usage ให้อ่าน ⇒ งานที่ LLM พังทุกครั้งจะได้ 0/0 ไม่ใช่ NULL
--  ⚠️ เก็บเป็นผลรวมต่อ 1 งาน ไม่ได้แยกราย call · จุดเรียก LLM มี 4 ที่ (customerService ×2,
--     productService, lineHandler) prompt คนละชุด ⇒ ตัวเลขนี้ตอบได้ว่า "ภาพรวมติดกี่ %"
--     แต่ตอบไม่ได้ว่า prompt ไหนไม่ติด ถ้าต้องรู้ให้ไล่ทีละจุดด้วย diag ชั่วคราว
--     อย่าเพิ่งสร้างตารางราย call เพราะแพงกว่ามาก (คูณจำนวน call ต่อข้อความ ที่วัดได้สูงสุด 4)
ALTER TABLE public.api_logs
  ADD COLUMN IF NOT EXISTS llm_prompt_tokens int,
  ADD COLUMN IF NOT EXISTS llm_cached_tokens int;
