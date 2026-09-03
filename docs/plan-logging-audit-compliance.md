# แผนงาน: ระบบเก็บ Log และรายงาน ให้ได้มาตรฐานสากล + พ.ร.บ.คอมพิวเตอร์

> **สถานะ: ร่าง v3 — รอการตัดสินใจ ยังไม่ลงมือ**
> v3 = ใช้วิธีมาตรฐานของวงการทั้งหมด (v1 มาตรฐานแต่เสี่ยงเกิน · v2 ปลอดภัยแต่หลุดมาตรฐาน)
> สำรวจจากโค้ดจริงและ DB จริง 2026-09-02/03

---

## สรุปสำหรับตัดสินใจ (อ่านหน้านี้พอ)

**ปัญหา:** ตอนนี้เก็บ log อยู่กองเดียวจาก 4 กองที่ระบบมาตรฐานต้องมี และ retention 30 วัน **ต่ำกว่าที่กฎหมายบังคับ (90 วัน)**

**จะทำ 4 อย่าง:**

| # | ทำอะไร | วิธี | แตะโค้ดเดิมไหม |
| --- | --- | --- | --- |
| 1 | เก็บ log ให้ครบ 90 วันตามกฎหมาย | แก้ `.env` 1 บรรทัด | ไม่ (แต่ต้อง restart 1 ครั้ง) |
| 2 | **บันทึกการแก้ไข** (ใครแก้อะไร ค่าเดิม→ค่าใหม่) | **DB trigger** บน 11 ตารางตั้งค่า | ไม่แตะโค้ดแอป · เพิ่มของใน DB |
| 3 | **เก็บ system log ทั้งหมด** | โปรเซสแยกอ่าน `docker logs` | ไม่เลย |
| 4 | **Dashboard traffic วัน/สัปดาห์/เดือน/ปี** | โปรเซสแยกสรุปรายวัน + หน้าจอใหม่ | หน้าจอเป็นไฟล์ใหม่ · แตะ `index.ts` 2 บรรทัด |

**เรื่องใบเสนอราคาที่กังวล — ตรวจแล้วไม่เกี่ยวกัน:**
ตารางทั้ง 11 ตัวที่จะติด trigger ถูก **อ่านอย่างเดียว** ในเส้นทางออกใบเสนอราคา ไม่มีคำสั่งเขียนสักจุด
เส้นทางนั้นเขียนแค่ `quotations` · `quotation_counters` · `messages` ซึ่ง **ห้ามติด trigger** (เขียนเป็นกฎถาวรในแผน)
⇒ trigger จะไม่เคยทำงานระหว่างออกใบเสนอราคา · มันทำงานตอนแอดมินกดบันทึกในหน้าตั้งค่าเท่านั้น (วันละไม่กี่ครั้ง)

**ก่อนขึ้นจริงจะพิสูจน์ให้ดูก่อน:** restore dump ลง DB ชั่วคราว ติด trigger แล้วรัน `npm run diag:*` ทั้ง 20+ ตัว
(ครอบ confirm-race, quote-validation, credit-hold, shipping-fee) ให้เห็นว่าตัวเลขไม่ขยับ

**ความเสี่ยงที่เหลือจริง ๆ มี 1 ข้อ:** ถ้า trigger ล้ม การกดบันทึกของ**แอดมิน**จะล้มตาม
→ แก้ด้วยการบังคับใส่ `EXCEPTION WHEN OTHERS` ในตัว trigger ⇒ เลวร้ายสุดเหลือแค่ "audit หาย 1 แถว + มี warning"
→ **ไม่ว่ากรณีไหนก็ไปไม่ถึงใบเสนอราคา**

---

## 1. ปัญหาปัจจุบัน

### 1.1 ระบบมาตรฐานเก็บ log 4 กอง — เรามีกองเดียว

| กอง | ตอบคำถาม | เรามีไหม |
| --- | --- | --- |
| **Access log** | ใครเรียก endpoint ไหน ตอนไหน ได้ status อะไร ใช้เวลาเท่าไหร่ | ✅ `api_logs` — ทำถูกตามตำราแล้ว |
| **Audit log** | ใครแก้ข้อมูลอะไร จากค่าอะไรเป็นค่าอะไร | ❌ มีแค่การส่งออกใบเสนอราคา |
| **System log** | ระบบพังตรงไหน เพราะอะไร | ❌ `console.*` 821 จุด ตกลง docker แล้วหมุนทิ้ง |
| **Metrics / Dashboard** | ปริมาณใช้งานย้อนหลัง | ❌ ไม่มี |

### 1.2 ที่ผิดกฎหมายอยู่ตอนนี้

`API_LOG_RETENTION_DAYS=30` — พ.ร.บ.คอมพิวเตอร์ ม.26 บังคับ **ไม่น้อยกว่า 90 วัน**

### 1.3 ที่ยังขาดสำหรับ พ.ร.บ.

| ข้อบังคับ | สถานะ |
| --- | --- |
| เก็บข้อมูลจราจร ≥ 90 วัน | ❌ 30 วัน |
| ต้นทาง/ปลายทาง/เวลา/ปริมาณ/ระยะเวลา/ชนิดบริการ | ✅ ครบแล้วใน `api_logs` |
| ระบุตัวผู้ใช้บริการได้ | ⚠️ ได้ ยกเว้นลิงก์ `/download-pdf` สาธารณะ (ข้อจำกัดจริง ต้องบันทึกเป็นเอกสาร) |
| ข้อมูลแก้ไขโดยง่ายไม่ได้ | ❌ |
| กำหนดชั้นความลับ/สิทธิ์เข้าถึง + ผู้ประสานงาน | ❌ ไม่มีเอกสาร |
| นาฬิกาตรงเวลาสากล | ✅ NTP ทำงานอยู่ (ต้องบันทึกเป็นหลักฐาน) |

---

## 2. วิธีที่จะใช้ — กองละหนึ่งวิธี

### 2.1 Audit log → **DB trigger** (วิธีมาตรฐานสายองค์กร)

**ทำไมเลือกวิธีนี้:** โปรเจกต์นี้เป็น Express + `pg` ดิบ ไม่มี ORM จึงไม่มีของสำเร็จรูปแบบ Rails/Django
ถ้าเขียนเรียกเองทุก endpoint (43 จุด) จะลืมเมื่อไหร่ก็เป็นช่องโหว่ที่ไม่มีใครรู้
และที่สำคัญกว่า — ระบบนี้มี `scripts/`, งาน sync, และการเข้า psql แก้มือ **ซึ่งโค้ดแอปมองไม่เห็น**
trigger คือคำตอบมาตรฐานของสถานการณ์แบบนี้พอดี: ไม่ว่าใครแก้ผ่านช่องทางไหนก็ถูกบันทึก

**ติดกับ 11 ตารางตั้งค่าเท่านั้น** (แก้กันวันละไม่กี่ครั้ง):
`promotions` · `quotation_rules` · `product_optional_links` · `product_stock_rules` · `product_moq_rules` ·
`shipping_fee_config` · `quotation_credit_policy` · `quotation_blacklist` · `admin_users` · `salesperson` · `sync_settings`

**🚫 กฎถาวร — ห้ามติด trigger กับตารางเหล่านี้เด็ดขาด:**
`quotations` · `quotation_counters` · `messages` · `products` · `customers` · `sale_orders` · `customers_data_view` · `api_logs`
เหตุผล: กลุ่มแรกคือเส้นทางออกใบเสนอราคา กลุ่มหลังคือตารางที่ sync เขียนรัว

**ข้อบังคับของ trigger ตัวนี้ 2 ข้อ:**

1. **ต้องมี `EXCEPTION WHEN OTHERS THEN RAISE WARNING; RETURN NULL;`**
   trigger ทำงานใน transaction เดียวกับคำสั่งเขียนจริง ถ้ามันโยน error คำสั่งของผู้ใช้จะ rollback ตาม
   ⇒ ยอมให้ "audit หาย 1 แถว + มี warning" ดีกว่า "แอดมินกดบันทึกไม่ได้"
2. **ตัด `password_hash` ออกก่อนเขียน** สำหรับตาราง `admin_users`

**ใครเป็นคนแก้ — ทำ 2 ขั้น ไม่ต้องแก้ handler ตั้งแต่วันแรก:**

| ขั้น | วิธี | ได้อะไร | แตะโค้ดเดิม |
| --- | --- | --- | --- |
| **A (เริ่มที่นี่)** | trigger เขียนแถวไว้ก่อนเป็น `actor_type='pending'` · worker ไปหาว่าใครทำจาก `api_logs` (ซึ่งมี `admin_user_id` + `request_id` + `ip` อยู่แล้ว) แล้วเติมชื่อกลับ | ข้อมูลการแก้ไขแม่นยำ 100% ตั้งแต่วันแรก · ชื่อผู้ทำได้จากการเทียบเวลา ติดป้าย `correlated` | **ไม่แตะเลย** |
| **B (ทยอยทีหลัง)** | เติม `SET LOCAL app.actor` ในหน้าที่แก้ข้อมูล ทีละจุด | ชื่อผู้ทำแม่นยำ 100% ติดป้าย `direct` | 1 บรรทัด/จุด |

ทำ B ทีละจุดได้เรื่อย ๆ **ไม่ต้องแก้ตารางหรือหน้าจอเลย** · จุดที่ยังไม่ทำก็ยังใช้ผลจาก A ต่อไปได้

### 2.2 System log → **โปรเซสแยกอ่าน `docker logs`** (วิธีมาตรฐานเช่นกัน)

มาตรฐาน (12-Factor §XI) บอกไว้ตรง ๆ ว่า **แอปควรเขียน log ลง stdout แล้วจบ ห้ามให้แอปรู้เรื่องปลายทาง**
ให้ตัวเก็บภายนอกไปจัดการต่อ — ซึ่งแอปเราทำครึ่งแรกถูกอยู่แล้ว **ขาดแค่ตัวเก็บ**

```
docker logs -f --since <checkpoint>  →  แยกระดับความรุนแรง  →  ลบข้อมูลอ่อนไหว  →  system_logs
```

* **ไม่แตะโค้ดแอปแม้แต่บรรทัดเดียว** และแอปไม่รู้ด้วยซ้ำว่ามีคนอ่านอยู่
* ได้ของที่วิธีอื่นให้ไม่ได้: stack trace ตอน crash, ข้อความจาก Node เอง, log ตอน boot ก่อนโค้ดเราทำงาน
* ตัวเก็บตาย → แอปไม่รู้สึกอะไร และ `docker logs` ยังกองไว้ 50 MB ให้ตามเก็บย้อนหลังได้
* ยืนยันแล้วว่า host มี node v22 และเรียก `docker logs` ได้โดยไม่ต้อง sudo

### 2.3 Dashboard → **สรุปรายวันเก็บถาวร**

`api_logs` เก็บ 120 วัน ⇒ ถ้าอ่านจากแถวดิบ **มุมมอง "ปี" จะว่างตลอดกาล**
⇒ สรุปวันละครั้งเก็บถาวรในตาราง `traffic_daily` (365 แถว/ปี = ไม่มีต้นทุน) แล้วทุกมุมมองอ่านจากตารางเดียวกัน

> ⚠️ **p95 รวมย้อนกลับไม่ได้** — p95 ของเดือน ≠ ค่าเฉลี่ยของ p95 รายวัน
> ตัวเลขหลักบนหน้าจอจึงใช้ **ค่าเฉลี่ย** (รวมย้อนกลับได้ถูกต้อง 100%)
> ส่วน p95 ของช่วงยาวติดป้ายชัดว่า **"p95 สูงสุดรายวันในช่วงนี้"**

### 2.4 ทั้ง 3 งานเบื้องหลังรวมเป็นโปรเซสเดียว

`logworker` — systemd service บน host (ไม่ใช่ในคอนเทนเนอร์ เพราะถ้าอยู่ในคอนเทนเนอร์ต้อง mount docker socket = ให้สิทธิ์เทียบเท่า root)

1. อ่าน `docker logs` → `system_logs`
2. เติมชื่อผู้ทำให้แถว audit ที่ยัง `pending` → `audit_logs`
3. สรุปรายวันตี 1 → `traffic_daily`

หยุด/เริ่ม/ถอนได้อิสระ ไม่กระทบแอป

---

## 3. ภาพรวม

```
 ┌──────────── คอนเทนเนอร์แอป (โค้ดไม่ถูกแก้) ─────────────┐
 │  request ─▶ apiLogMiddleware ─────────▶ api_logs        │
 │  console.* 821 จุด ────────────────────▶ stdout          │
 │  แอดมินกดบันทึก ─▶ ตารางตั้งค่า ─[trigger]─▶ audit_logs  │
 │  ออกใบเสนอราคา ──▶ quotations/counters/messages          │
 │                     └── ไม่มี trigger ── ไม่เกี่ยวข้อง    │
 └───────────┬──────────────┬───────────────┬───────────────┘
             │ docker logs  │ อ่าน api_logs │ อ่าน api_logs
             ▼              ▼               ▼
 ┌─────────── logworker (systemd บน host) ──────────────────┐
 │  ① → system_logs    ② เติมชื่อผู้ทำ    ③ → traffic_daily │
 └──────────────────────────────────────────────────────────┘
             │ อ่านอย่างเดียว
             ▼
   routes/logs.ts (ไฟล์ใหม่) ─▶ หน้าจอใหม่ 3 หน้า
```

**4 ตาราง อายุการเก็บและคนอ่านต่างกัน:**

| ตาราง | เก็บนานแค่ไหน | ใครอ่าน |
| --- | --- | --- |
| `api_logs` (มีอยู่ ไม่แก้) | 120 วัน | ops / เจ้าหน้าที่รัฐ |
| `audit_logs` (ใหม่) | 2 ปี | ผู้บริหาร / ตรวจสอบภายใน |
| `system_logs` (ใหม่) | 90 วัน (warn ขึ้นไป) · 14 วัน (info) | dev |
| `traffic_daily` (ใหม่) | ไม่ลบ | ผู้บริหาร |

---

## 4. แผนเป็นเฟส

### เฟส 1 — ปิดช่องกฎหมาย ☐

*แรง: เล็กมาก · ไม่แตะโค้ด*

| งาน | รายละเอียด |
| --- | --- |
| retention 30 → **120 วัน** | แก้ `.env` 1 บรรทัด · เป็นการ **ลบน้อยลง** ไม่ใช่มากขึ้น ไม่มี burst · ต้นทุน ~19–25 MB · ต้อง restart 1 ครั้ง (ใช้ deploy รอบถัดไปได้) · โค้ดรองรับถึง 3,650 วันอยู่แล้ว |
| กู้พื้นที่ดิสก์ | **ย้าย** `backup-*.dump` 4 ไฟล์ (~297 MB) ออกนอกเครื่อง — ห้ามลบจนกว่าจะยืนยันปลายทาง · ดิสก์ 88% เป็นความเสี่ยงที่มีอยู่เดิม |
| เอกสาร | บันทึกผล `timedatectl` ลง `DEPLOY.md` · เพิ่มหัวข้อ: ผู้มีหน้าที่ประสานงาน, ชั้นความลับของแต่ละตาราง, ใครเข้าถึงได้, วิธีส่งมอบเมื่อมีหมายเรียก, ข้อจำกัดที่ระบุตัวคนกด `/download-pdf` ไม่ได้ |

**เกณฑ์ผ่าน:** ผ่านไป 3 เดือน `SELECT min(created_at) FROM api_logs` ย้อนได้เกิน 90 วัน · ดิสก์เหลือ > 15%

---

### เฟส 2 — logworker + `system_logs` ☐

*แรง: กลาง · ไม่แตะโค้ดแอปเลย*

ทำก่อนเฟส audit เพราะเป็นการสร้างโครง worker (systemd + checkpoint + ตัวลบข้อมูลอ่อนไหว + pool) ที่อีก 2 งานมาอาศัยต่อ

```sql
CREATE TABLE public.system_logs (
  id          bigserial   PRIMARY KEY,
  created_at  timestamptz NOT NULL,      -- เวลาจาก docker ไม่ใช่เวลาที่ worker อ่าน
  level       varchar(5)  NOT NULL,      -- fatal|error|warn|info|debug (RFC 5424)
  source      varchar(60),               -- ชื่อในวงเล็บเหลี่ยม เช่น api-log, sync
  event       varchar(80),
  message     text        NOT NULL,
  request_id  varchar(16),
  ctx         jsonb,
  err_stack   text
);

CREATE TABLE public.log_worker_state (   -- checkpoint ให้ restart แล้วต่อได้ ไม่ซ้ำไม่ขาด
  job varchar(30) PRIMARY KEY, cursor_at timestamptz,
  last_run_at timestamptz, last_error text
);
```

**คุมขนาด:** ~10 บรรทัด/request × 1,000 request/วัน ≈ 3.5 MB/วัน ⇒ ถ้าเก็บทุกระดับ 90 วัน = ~315 MB
⇒ ตั้งต้น `SYSTEM_LOG_DB_LEVEL=warn` (ต่ำกว่านั้นยังอยู่ใน `docker logs` ตามเดิม) ⇒ **วันปกติโตหลัก kB**

**⚠️ `docker logs` มี PII จริง** — เช่น `>>> PUT /api/admin/promotions/42 received! body: {...}` และข้อความแชท
⇒ ตัวลบข้อมูลอ่อนไหว (`Bearer …`, `password`, `token`, `secret`, `api_key` + ตัดที่ 4 kB) เป็นเงื่อนไขบังคับก่อนขึ้นใช้จริง

**ข้อจำกัดที่ต้องยอมรับ:** บรรทัด log เดิมไม่มี `request_id` จึงยังผูกกับ `api_logs` ไม่ได้
→ แก้ได้โดยทยอยเปลี่ยน `console.*` เป็นบรรทัด JSON ทีละโมดูล (เฟส 6 · ไม่บังคับ · worker แกะ JSON ได้อยู่แล้ว)

**เกณฑ์ผ่าน:**
* `systemctl stop logworker` → ระบบทำงานปกติทุกอย่าง (พิสูจน์ว่าไม่กระทบ)
* หยุด 10 นาทีแล้วเปิดใหม่ → บรรทัดที่หายไปถูกเก็บครบ ไม่ซ้ำ
* หยุด DB → worker ไม่ตาย กลับมาต่อได้เอง
* `SELECT * FROM system_logs WHERE message ~* 'bearer|password|token'` → **ว่างเปล่า**

---

### เฟส 3 — `audit_logs` + trigger ☐

*แรง: กลาง · เพิ่มของใน DB ไม่แตะโค้ดแอป*

```sql
CREATE TABLE public.audit_logs (
  id            bigserial   PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_id    varchar(16),            -- จับคู่กับ api_logs / system_logs
  actor_type    varchar(12) NOT NULL,   -- admin | system | pending | unknown | ambiguous
  actor_id      varchar(60),            -- ไม่มี FK — ผู้ใช้ถูกลบแล้ว log ต้องไม่หายตาม
  actor_name    varchar(120),           -- ชื่อ ณ เวลานั้น (ชื่อเปลี่ยนทีหลังห้ามย้อนแก้ประวัติ)
  actor_source  varchar(10),            -- direct | correlated ← บอกตรง ๆ ว่ามาจากไหน
  action        varchar(60) NOT NULL,   -- promotion.update | admin_user.role_change
  entity_type   varchar(40),
  entity_id     varchar(80),
  entity_label  varchar(200),           -- ชื่อที่คนอ่านออก เช่น code ของโปรโมชัน
  changed_cols  text[],
  before        jsonb,
  after         jsonb,
  ip            varchar(45),
  result        varchar(12) NOT NULL DEFAULT 'ok',
  note          text
);
CREATE INDEX idx_audit_logs_occurred ON public.audit_logs (occurred_at DESC, id DESC);
CREATE INDEX idx_audit_logs_entity   ON public.audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_audit_logs_actor    ON public.audit_logs (actor_id, occurred_at DESC);
CREATE INDEX idx_audit_logs_request  ON public.audit_logs (request_id);
```

ตารางนี้เขียนไม่กี่สิบแถว/วัน จึงใส่ index ได้เต็มที่
(เหตุผลที่ `api_logs` จงใจไม่ใส่ index — ต้นทุนของทุก insert — ใช้ไม่ได้กับตารางนี้)

**trigger กลางตัวเดียว ใช้ซ้ำทุกตารางผ่าน `TG_ARGV`:**

```sql
CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION audit_row('promotion', 'code');
```

**การเข้าสู่ระบบ** — worker อ่านจาก `api_logs` ที่มีอยู่แล้ว (`POST /api/admin/login` + status + ip)
200 → `auth.login_ok` · 401 → `auth.login_failed` · 429 → `auth.rate_limited`
⚠️ ไม่รู้ว่ากรอก username อะไร (เพราะ `api_logs` ไม่เก็บ body ตามการตัดสินใจเดิม) → แก้ได้ในเฟส 6 ถ้าต้องการ

**เกณฑ์ผ่าน:**
* แก้โปรโมชัน 1 ตัวจากหน้าเว็บ → ได้ 1 แถว บอกช่องที่เปลี่ยน + ค่าเดิม/ใหม่ + ชื่อคนแก้
* `UPDATE promotions ...` จาก psql → ได้แถว `actor_type='unknown'` (พิสูจน์ว่าเลี่ยงไม่ได้)
* **จงใจทำให้ `audit_logs` เขียนไม่ได้ (REVOKE INSERT ชั่วคราว) → `UPDATE promotions` ต้องยังสำเร็จ**
* `SELECT before, after FROM audit_logs WHERE entity_type='admin_user'` → ไม่มี `password_hash`
* **รัน `npm run diag:*` ทั้งชุดบน DB ที่ติด trigger แล้ว → ผ่านหมด ตัวเลขไม่ขยับ**

---

### เฟส 4 — สรุปรายวัน + Dashboard ☐

*แรง: ใหญ่ · เก็บข้อมูลไม่แตะแอป · หน้าจอเป็นไฟล์ใหม่*

```sql
CREATE TABLE public.traffic_daily (
  day date PRIMARY KEY,
  requests integer NOT NULL, requests_api integer NOT NULL,
  webhook_events integer NOT NULL, webhook_dropped integer NOT NULL, webhook_timeout integer NOT NULL,
  errors_4xx integer NOT NULL, errors_5xx integer NOT NULL,
  uniq_line_users integer NOT NULL, uniq_admin_users integer NOT NULL, uniq_ips integer NOT NULL,
  bytes_out bigint,
  duration_sum_ms bigint NOT NULL,      -- ให้คำนวณค่าเฉลี่ยของช่วงใหญ่ได้ถูกต้อง 100%
  p50_ms integer, p95_ms integer, p99_ms integer,
  max_inflight smallint, db_wait_hits integer,
  quotations_created integer, messages_in integer, audit_changes integer,
  computed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

* รันตี 1 เวลาไทย สรุป "เมื่อวาน" · `ON CONFLICT (day) DO UPDATE` → รันซ้ำได้
* **บังคับ `SET statement_timeout` ทุก query** (query ค้างตัวเดียวบล็อก rebuild `customers_data_view` ทั้งระบบ)
* backfill ย้อนหลังจาก 23 วันที่มีอยู่ได้ทันที · มุมมอง "วันนี้" อ่านสดจาก `api_logs` ต่อท้าย

**หน้าจอ "รายงานการใช้งาน" (`Traffic.tsx` — ไฟล์ใหม่ ไม่แตะ `ApiLogs.tsx`)**

* ตัวเลือกช่วง วัน / สัปดาห์ / เดือน / ปี + เลื่อนหน้า–หลัง + เทียบช่วงก่อนหน้า
* แถว KPI: เรียก API ทั้งหมด · ผู้ใช้ไม่ซ้ำ · ใบเสนอราคาที่ออก · ข้อความเข้า · อัตราข้อผิดพลาด · เวลาตอบเฉลี่ย
* กราฟปริมาณตามเวลา ซ้อนแท่งข้อผิดพลาด · heatmap 7×24 · endpoint/ผู้ใช้ที่มากสุด
* **ปุ่มส่งออก CSV/PDF** — จำเป็นจริง เป็นรูปแบบที่ส่งมอบเมื่อมีหมายเรียก
* **คลิกตัวเลขแล้วทะลุไปหน้ารายการพร้อมตัวกรองที่ตั้งไว้ให้** ← ตัวที่ทำให้ dashboard ไม่ใช่แค่รูปสวย

---

### เฟส 5 — หน้าจอ + สิทธิ์ + ความถูกต้องแท้จริง ☐

*แรง: กลาง · โค้ดใหม่ล้วน*

**เมนู** — เพิ่มกลุ่มพับได้ "บันทึกและรายงาน" (แบบเดียวกับกลุ่มตั้งค่าที่มีอยู่):

```
บันทึกและรายงาน
 ├─ รายงานการใช้งาน      (ใหม่)
 ├─ บันทึกการเรียก API   (ของเดิม — ไม่แก้สักบรรทัด)
 ├─ บันทึกการแก้ไข       (ใหม่)
 └─ บันทึกระบบ           (ใหม่)
```

**Backend** — แตะ `index.ts` 2 บรรทัด (ถอยกลับ = ลบ 2 บรรทัด):

```ts
import { logsRouter } from './routes/logs.js';
app.use('/api/admin/logs', adminAuthMiddleware, requireRole('admin'), logsRouter);
```

**⚠️ ไม่รีแฟกเตอร์ `ApiLogs.tsx`** — หน้านั้นใช้งานได้ดีอยู่แล้ว การขยับเพื่อความสวยของโค้ดคือความเสี่ยงที่ไม่มีใครได้อะไรกลับมา
3 หน้าใหม่จะ **คัดลอก** helper ที่ต้องใช้ (~80 บรรทัด) ไปไว้ที่ `logs/format.ts` ของตัวเอง

**กติกาหน้าจอที่บังคับใช้กับ 3 หน้าใหม่:**

| หัวข้อ | กติกา |
| --- | --- |
| เวลา | ปัก `Asia/Bangkok` เสมอ ไม่ใช้โซนเบราว์เซอร์ · เวลาสัมพัทธ์ + เวลาเต็มใน tooltip |
| ความรุนแรง | สีเดียวกันทุกหน้า: 5xx/fatal แดง · 4xx/warn เหลือง · 3xx/info ฟ้า · 2xx/ok เขียว |
| สี ≠ ความหมายเดียว | ต้องมีข้อความ/ไอคอนกำกับด้วย (WCAG 1.4.1) — คนตาบอดสีต้องอ่านได้ |
| ความคมชัด | badge ทุกตัวผ่าน 4.5:1 (WCAG 2.2 AA) |
| คีย์บอร์ด | ↑↓ เลื่อนแถว · Enter เปิด · Esc ปิด · `/` โฟกัสค้นหา · focus ring ชัด |
| สถานะครบ 4 แบบ | กำลังโหลด (skeleton) · ว่าง · ผิดพลาด+ปุ่มลองใหม่ · ไม่มีสิทธิ์ |
| URL คือสถานะ | ตัวกรอง/ช่วงเวลา/หน้า อยู่ใน query string → copy ลิงก์ส่งต่อแล้วเห็นหน้าจอเดียวกัน |
| สหสัมพันธ์ | ปุ่ม "ดูทุกอย่างของ request นี้" → ไทม์ไลน์รวมทุกตาราง ← **ผลตอบแทนหลักของทั้งแผน** |
| ตัวเลขต้องไม่โกหก | ค่าประมาณติดป้าย (p95 ช่วงยาว) · ชื่อผู้ทำต้องแสดง `actor_source` ให้เห็น |
| มือถือ | ตารางยุบเป็นการ์ดที่ < 768px |

**สิทธิ์และความถูกต้อง:**

| งาน | รายละเอียด |
| --- | --- |
| `audit_logs` เขียนได้อย่างเดียว | `REVOKE UPDATE, DELETE` — ปลอดภัยเพราะแอปไม่เคยแตะตารางนี้ · retention 2 ปี ⇒ ไม่ต้องมีเส้นทางลบเลยใน 2 ปีแรก |
| ลายนิ้วมือรายวัน | งานสรุปคำนวณ `sha256` ของแถว audit ทั้งวัน + hash เมื่อวาน → เก็บและสำเนาออกนอกเครื่องพร้อม backup · เป็นหลักฐาน integrity โดยไม่ต้องทำ hash chain รายแถว |
| สิทธิ์เข้าถึง log | เปิดให้ `admin` เท่านั้น — เท่ากับหน้า "บันทึกการเรียก API" เดิม · **ไม่เพิ่ม role ใหม่** ไม่แตะ `admin_users_role_check` · ข้อบังคับ "กำหนดชั้นความลับและสิทธิ์เข้าถึง" ตอบด้วยการเขียนไว้ใน `DEPLOY.md` ว่าใครเข้าถึงได้ (เฟส 1) |
| บันทึกการดู log | เปิดหน้า/กดส่งออก = เขียน `audit_logs` (`log.view`, `log.export`) |
| log อยู่ใน backup | ตรวจว่า `dbDump.ts` ไม่ได้ตัดตาราง log ทั้ง 4 + ขยายคำเตือน PII ใน `DEPLOY.md` §4.6 |

---

### เฟส 6 — งานต่อเนื่อง ไม่มีเส้นตาย ☐

*ทุกข้อแตะโค้ดเดิม จึงแยกไว้ให้ตัดสินใจทีละข้อ*

| งาน | ได้อะไรเพิ่ม |
| --- | --- |
| `SET LOCAL app.actor` ทีละ endpoint (ขั้น B ของ §2.1) | ชื่อผู้ทำแม่นยำ 100% แทนการเทียบเวลา |
| เปลี่ยน `console.*` เป็นบรรทัด JSON ทีละโมดูล | ได้ `request_id` ผูกทุกบรรทัด + กรองด้วย `event`/`ctx` ได้จริง |
| บันทึก username ที่ล็อกอินผิด | ต้องแตะ handler login 1 บรรทัด |
| คอลัมน์ `req_bytes` | "ปริมาณข้อมูลขาเข้า" ครบทั้งสองทาง — แตะเส้นทางที่วิ่งทุก request จึงยังไม่ทำ |
| แอปใช้ DB role จำกัดสิทธิ์แทน `postgres` | integrity ครบทุกตาราง แต่เสี่ยงพังทั้งระบบถ้าลืม GRANT — ต้องทดสอบทั้งชุดบน DB ชั่วคราวก่อน |

---

## 5. ลำดับที่แนะนำ

| ลำดับ | เฟส | เหตุผล |
| --- | --- | --- |
| 1 | **1 — ปิดช่องกฎหมาย** | ผิดกฎหมายอยู่ตอนนี้ · ไม่แตะโค้ดสักบรรทัด |
| 2 | **2 — logworker + system log** | สร้างโครง worker ที่เฟส 3 กับ 4 มาอาศัยต่อ · ไม่แตะแอป |
| 3 | **3 — audit + trigger** | ช่องว่างที่มีคุณค่าสูงสุด · ทำหลัง worker เพราะต้องใช้ worker เติมชื่อผู้ทำ |
| 4 | **4 — สรุปรายวัน + Dashboard** | เริ่มสรุปให้เร็วที่สุด (ต้องสะสมข้อมูล) หน้าจอตามทีหลังได้ |
| 5 | **5 — หน้าจอ + สิทธิ์** | ทำทีเดียวจบพร้อม router ใหม่ |
| 6 | 6 — งานต่อเนื่อง | ตัดสินใจทีละข้อ |

**ถ้าต้องรีบตอบเรื่องกฎหมายอย่างเดียว:** เฟส 1 อย่างเดียวก็ผ่าน ม.26 แล้ว และไม่แตะโค้ดสักบรรทัด

---

## 6. ความเสี่ยงและการรับมือ

| ความเสี่ยง | รับมือยังไง |
| --- | --- |
| **trigger ล้ม → แอดมินกดบันทึกไม่ได้** | บังคับ `EXCEPTION WHEN OTHERS` · มีเคสทดสอบเป็นเกณฑ์ผ่าน · **ไม่กระทบใบเสนอราคาในทุกกรณี** |
| trigger ไปติดตารางผิดตัวในอนาคต | เขียนกฎ 🚫 ไว้ในแผนและในหัวไฟล์ migration · ตารางที่ห้ามระบุชื่อไว้ครบ |
| ดิสก์เหลือ 8.6 G (88%) | เฟส 1 กู้ ~297 MB ก่อน · `SYSTEM_LOG_DB_LEVEL=warn` ทำให้วันปกติโตหลัก kB · ตั้ง alert ที่ 90% |
| worker กิน DB connection | pool ของ worker สูงสุด 5 · ตอนนี้ใช้ 15 จาก 100 |
| worker รันซ้อน 2 ตัว | systemd unit เดียว + `pg_try_advisory_lock` ตอนสตาร์ท |
| worker หยุดเงียบ ๆ | `log_worker_state.cursor_at` ค้างเกิน 15 นาที = alert · แสดงสถานะ worker บนหน้า "บันทึกระบบ" |
| query ของ worker ค้างจนบล็อก rebuild `customers_data_view` | บังคับ `SET statement_timeout` ทุก query |
| เก็บ log นานขึ้น = PII ค้างนานขึ้น (ชนกับ PDPA) | ตัวลบข้อมูลอ่อนไหว + ไม่เก็บ body ดิบ + audit เก็บเฉพาะส่วนต่างของตารางตั้งค่า + คุมสิทธิ์และบันทึกคนที่เข้าดู |

**จงใจไม่ทำ:**

* ไม่ส่ง log ออก ELK / Loki / Datadog — เครื่องเดียว ปริมาณหลัก MB/วัน (กลับมาคิดใหม่เมื่อ > 50 GB/เดือน หรือมีมากกว่า 1 เครื่อง)
* ไม่ใช้ `pgaudit` — เก็บข้อความ SQL ลง server log ไม่ใช่ค่าเดิม→ค่าใหม่รายแถว และต้อง restart Postgres
* ไม่ใช้ CDC/Debezium — ต้องเปิด `wal_level=logical` (restart อีก) และ WAL ไม่รู้ว่าใครทำอยู่ดี
* ไม่เปลี่ยน logging driver ของ docker — ต้อง recreate คอนเทนเนอร์ = downtime
* ไม่ mount docker socket เข้าคอนเทนเนอร์ — เท่ากับให้สิทธิ์ root
* ไม่เก็บ request/response body ทั้งก้อน (คงการตัดสินใจเดิมของ `api_logs`)
* ไม่เก็บเนื้อหาแชท LINE เพิ่ม — `messages` มีอยู่แล้ว
* ไม่ทำ hash chain รายแถว — digest รายวันให้ผลใกล้เคียงด้วยต้นทุนเสี้ยวเดียว
* ไม่ partition ตาราง log — เกินราว 5M แถว หรือ 3 GB ค่อยคิด

---

## ภาคผนวก — ตัวเลขที่ใช้ตัดสินใจ (วัดจริง 2026-09-02)

| อะไร | ค่า |
| --- | --- |
| `api_logs` | 16,264 แถว · 4,936 kB · ~750–1,200 แถว/วัน ⇒ **~210 kB/วัน** |
| retention 90 วันจะใช้ | **~19 MB** (1 ปี ~77 MB) — ไม่ใช่ข้อจำกัด |
| ตารางตั้งค่า 11 ตัวรวมกัน | 5,662 แถว · ~900 kB (ใหญ่สุด `product_stock_rules` 5,274 แถว) |
| `salesperson` | 39 แถว · **แก้ 0 ครั้งใน 7 วัน** |
| `console.*` ในโค้ด | **821 จุด** (`index.ts` 149 · `lineHandler` 43 · `quotationService` 37) |
| endpoint ที่เขียนข้อมูล | 43 ตัว (35 ตัวใต้ `/api/admin`) |
| DB | 658 MB · `max_connections` 100 · ใช้อยู่ 15 |
| ดิสก์ | 73 G · เหลือ **8.6 G (88%)** |
| host | node v22.23.2 · `docker logs` เรียกได้ไม่ต้อง sudo |
| NTP | `System clock synchronized: yes` |

**หลักฐานเรื่องใบเสนอราคา:** grep ทั้ง `services/` `handlers/` `db/` แล้ว ไม่พบ `INSERT`/`UPDATE`/`DELETE`
บนตารางตั้งค่าทั้ง 11 ตัวในเส้นทางบอทเลย · ที่เขียนมี 2 ที่คือ `saveCreditPolicy` (เรียกจาก `PUT /api/admin/credit-policy`
เท่านั้น) และ `sync_settings` (migration ตอน boot + ตอนแอดมินกดบันทึก) · ยิ่งกว่านั้น `creditHoldService`
อ่านผ่าน `loadCached` คือ cache ใน memory ไม่ได้แตะ DB ด้วยซ้ำ
