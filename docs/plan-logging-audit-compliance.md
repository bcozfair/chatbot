# แผนงาน: ยกระดับการเก็บ Log + UX/UI การแสดงผล ให้ได้มาตรฐานสากลและ พ.ร.บ.คอมพิวเตอร์

> สถานะ: **ร่างแผน ยังไม่ลงมือ** — สำรวจจากโค้ดจริงและ DB จริงเมื่อ 2026-09-02
> อ่านไฟล์นี้ก่อนเริ่มงานทุกครั้ง แล้วอัปเดตช่อง "สถานะ" ของแต่ละเฟสเมื่อทำเสร็จ
> หลักการที่คุมทั้งแผน: **ของเดิมที่ทำงานดีอยู่ห้ามพัง** — ทุกเฟสเป็นการ "ต่อเติม" ไม่ใช่ "รื้อ"
> `api_logs` / `config/apiLogger.ts` / `services/apiLogService.ts` ที่ใช้งานอยู่ **ไม่ถูกแก้โครงเลย** ทั้งแผน

---

## 1. สิ่งที่ต้องการ (จากโจทย์)

| ต้องการ | เฟสที่ตอบ |
| --- | --- |
| เดิมเก็บแค่ log api → ให้เก็บ **system log ทั้งหมด** | เฟส 3 |
| เก็บ **log การแก้ไข** (ใครแก้อะไร เปลี่ยนจากอะไรเป็นอะไร) | เฟส 2 |
| **Dashboard สรุป traffic** ราย วัน/สัปดาห์/เดือน/ปี | เฟส 4 |
| ให้ตรง **พ.ร.บ.คอมพิวเตอร์** | เฟส 1 (+ 5) |
| **UX/UI ตามมาตรฐานสากล** | เฟส 5 |

---

## 2. สถานะปัจจุบัน (วัดจริง 2026-09-02)

### 2.1 สิ่งที่มีอยู่แล้วและใช้ได้ดี

* ตาราง `api_logs` — [`migrations/changes/2026-08-10_01_api_logs.sql`](../migrations/changes/2026-08-10_01_api_logs.sql)
  เก็บ: `created_at, request_id, method, route, path, status_code, duration_ms, resp_bytes, admin_user_id, line_user_id, ip, inflight, db_waiting, queue_waited_ms`
* Middleware ที่ไม่แตะ request stream และไม่ยิง DB ในเส้นทางที่ผู้ใช้รอ — [`config/apiLogger.ts`](../config/apiLogger.ts)
* ตัวเขียนแบบ batch + retention ที่ผ่านการปรับจูนแล้ว — [`services/apiLogService.ts`](../services/apiLogService.ts)
* `request_id` ตอบกลับเป็น header `X-Request-Id` — **นี่คือกุญแจของทั้งแผน** (ดู §6)
* หน้าจอ [`frontend/src/admin/ApiLogs.tsx`](../frontend/src/admin/ApiLogs.tsx) 839 บรรทัด 2 แท็บ (ภาพรวม / รายการ)
* audit จริงที่มีอยู่ 1 ชุด: `quotation_export_batches` + `quotation_export_log` — ครอบแค่การส่งออกใบเสนอราคา
* นาฬิกาเครื่อง: `System clock synchronized: yes`, `NTP service: active` ✅ (ข้อบังคับหนึ่งของประกาศฯ ผ่านแล้ว)

### 2.2 ตัวเลขจริงที่ใช้ตัดสินใจเรื่องขนาด

| อะไร | ค่า |
| --- | --- |
| `api_logs` | 16,264 แถว · **4,936 kB** · ตั้งแต่ 2026-08-10 |
| ปริมาณต่อวัน | ~750–1,200 แถว/วัน ⇒ **~210 kB/วัน** |
| ขนาด DB ทั้งก้อน | 658 MB |
| `messages` (แชท LINE) | 4,740 แถว · 3,832 kB |
| ดิสก์ | 73 G · ใช้ไป 61 G · **เหลือ 8.6 G (88%)** ⚠️ |
| ไฟล์ `.dump` ค้างใน repo root | 4 ไฟล์ ~**297 MB** ⚠️ |

> ⇒ retention 90 วันของ `api_logs` = **~19 MB** · 1 ปี = ~77 MB · **ราคาถูกมาก ไม่ใช่ข้อจำกัด**
> ตัวที่ต้องระวังเรื่องขนาดคือ `system_logs` (เฟส 3) ไม่ใช่ `api_logs`

### 2.3 ช่องว่างที่ต้องปิด

| # | ช่องว่าง | หลักฐาน |
| --- | --- | --- |
| G1 | **retention 30 วัน < 90 วันที่กฎหมายบังคับ** | `.env:43 API_LOG_RETENTION_DAYS=30` |
| G2 | **ไม่มี log การแก้ไขเลย** — รู้แค่ว่า `PUT /api/admin/promotions/42 → 200` แต่ไม่รู้ว่าเปลี่ยนอะไรเป็นอะไร | 43 endpoint ที่เขียนข้อมูล (35 ตัวอยู่ใต้ `/api/admin`) มี audit แค่ export |
| G3 | **system log หายทุกครั้งที่หมุน** — `console.*` **821 จุด** ตกลง docker `json-file` `max-size 10m × 5` แล้วหมุนทิ้ง ค้นย้อนหลังไม่ได้ | `docker-compose.yml:9-13, 48-52` |
| G4 | **ไม่มีบันทึกการเข้าสู่ระบบ** — ตัวนับ login ผิดอยู่ใน memory ล้วน restart แล้วหาย | `config/loginRateLimit.ts` |
| G5 | **ไม่มี dashboard traffic** — หน้า "แผงควบคุม" นับแค่จำนวน record ของแต่ละเมนู | `AdminApp.tsx:216-222` |
| G6 | **ดูสถิติย้อนหลังเป็นปีไม่ได้** — ต่อให้ขยาย retention ก็ยังไม่มีชั้นสรุป | ไม่มีตาราง rollup |
| G7 | **การเข้าดู log ไม่ถูกบันทึก** และไม่มี role แยกสำหรับผู้ตรวจสอบ | `index.ts:3809` `requireRole('admin')` |
| G8 | **log แก้/ลบได้ด้วย DB user ตัวเดียวกับแอป** — ไม่มีชั้นกันการแก้ไขย้อนหลัง | ทั้งระบบใช้ `PG_USER=postgres` |
| G9 | UI: log อยู่กระจัดกระจาย ไม่มีศูนย์รวม · `ApiLogs.tsx` ใหญ่ 839 บรรทัดและไม่มี component กลางให้หน้าใหม่ใช้ซ้ำ | — |

---

## 3. เกณฑ์ที่ยึด (ทำไมต้องออกแบบแบบนี้)

### 3.1 พ.ร.บ.คอมพิวเตอร์ ม.26 + ประกาศกระทรวงดิจิทัลฯ พ.ศ. 2564

| ข้อบังคับ | สถานะตอนนี้ | ปิดที่เฟส |
| --- | --- | --- |
| เก็บข้อมูลจราจรฯ **ไม่น้อยกว่า 90 วัน** (สั่งขยายได้ถึง 2 ปี) | ❌ 30 วัน | 1 |
| ข้อมูลจราจร: ต้นทาง ปลายทาง เวลา ปริมาณ ระยะเวลา ชนิดบริการ | ✅ เกือบครบ (`ip, path, created_at, resp_bytes, duration_ms, method`) ขาดปริมาณขาเข้า | 1 |
| **ระบุตัวผู้ใช้บริการได้** | ⚠️ `admin_user_id` / `line_user_id` มี แต่ลิงก์ `/download-pdf` สาธารณะระบุไม่ได้ (ข้อจำกัดจริง ระบุไว้แล้วในโค้ด) | 1 (บันทึกเหตุผลไว้เป็นเอกสาร) |
| ข้อมูลต้อง **ไม่ถูกแก้ไขโดยง่าย** (integrity) | ❌ | 6 |
| **กำหนดชั้นความลับและสิทธิ์เข้าถึง** + ผู้มีหน้าที่ประสานงาน | ❌ ไม่มีเอกสาร | 6 |
| ตั้งนาฬิกาให้ตรงเวลาอ้างอิงสากล | ✅ NTP ทำงานอยู่ | 1 (แค่บันทึกเป็นหลักฐาน) |

### 3.2 มาตรฐานสากลที่อ้างอิง

* **ISO/IEC 27001:2022** — A.8.15 Logging · A.8.16 Monitoring · A.8.17 Clock synchronization
* **NIST SP 800-92** (Log Management) และ **SP 800-53 ตระกูล AU** (AU-2 เลือกเหตุการณ์ที่ต้องเก็บ, AU-3 เนื้อหาของแต่ละแถว, AU-9 ป้องกันการแก้ไข, AU-11 retention)
* **OWASP ASVS V7** + Logging Cheat Sheet — เหตุการณ์ที่ "ต้อง" เก็บ: การยืนยันตัวตน (สำเร็จ/ล้มเหลว), การถูกปฏิเสธสิทธิ์, การเปลี่ยนสิทธิ์/ข้อมูลตั้งค่า, การส่งออกข้อมูล · และที่ "ห้าม" เก็บ: รหัสผ่าน, token, เลขบัตร, ข้อมูลอ่อนไหว
* **RFC 5424** — ระดับความรุนแรงมาตรฐาน (ใช้ 5 ระดับที่จำเป็นจริง: `fatal|error|warn|info|debug`)
* **PDPA** — ตีกับข้อบน: log ยิ่งเก็บนานยิ่งเสี่ยง ⇒ ต้องมี "เก็บเท่าที่จำเป็น + redact + คุมสิทธิ์เข้าถึง" คู่กันเสมอ
* **WCAG 2.2 AA** — สำหรับหน้าจอในเฟส 5

### 3.3 กติกาที่ห้ามละเมิดตลอดแผน

1. **ห้ามเพิ่มงานในเส้นทางที่ผู้ใช้รอ** — ทุกการเขียน log ต้องอยู่หลัง `res.on('finish')` หรือใน batch timer ตามแบบ `apiLogService` ที่พิสูจน์แล้ว
2. **ห้ามเก็บ request body ทั้งก้อน** (การตัดสินใจหลักของ `api_logs` เดิม — PII + ขนาด) · เฟส 2 เก็บเฉพาะ *ส่วนต่าง* ของตารางตั้งค่า ไม่ใช่ body ดิบ
3. **ห้ามเก็บรหัสผ่าน / JWT / API key / `password_hash`** — ต้องมี redactor กลางและ test ครอบ
4. **ห้ามใช้ `COMMENT ON COLUMN`** — คำอธิบายคอลัมน์เขียนเป็น `--` ในไฟล์ migration (กติกาโปรเจกต์)
5. **บั๊กในตัว log ต้องทำได้อย่างมากแค่ "แถวนั้นหาย"** ห้ามลามไปล้ม response หรือ process

---

## 4. ภาพรวมสถาปัตยกรรมปลายทาง

```
                     ┌──────────────────────────────────────────┐
   request ─────────▶│  apiLogMiddleware  (ของเดิม ไม่แก้)       │──▶ api_logs      (จราจร)
                     └──────────────────────────────────────────┘
                                    │ request_id
   handler เขียนข้อมูล ─────────────┼──▶ auditedQuery() ─▶ trigger ─▶ audit_logs   (การแก้ไข)
                                    │
   console.* / log.*  ──────────────┴──▶ logSink (batch) ─▶ system_logs (ระบบ)
                                                              │
                        nightly rollup ◀────────────────────── ┘
                                    │
                                    ▼
                              traffic_daily  ─▶ Dashboard วัน/สัปดาห์/เดือน/ปี
```

**4 ตาราง แยกกันชัดเจน เพราะอายุการเก็บและกลุ่มผู้อ่านต่างกัน:**

| ตาราง | ตอบคำถาม | อายุ | ผู้อ่านหลัก |
| --- | --- | --- | --- |
| `api_logs` (มีอยู่) | ใครเรียกอะไร ช้าตรงไหน | **90–120 วัน** | ops / เจ้าหน้าที่รัฐ |
| `audit_logs` (ใหม่) | ใครแก้อะไร จากอะไรเป็นอะไร | **2 ปี** | ผู้บริหาร / ตรวจสอบภายใน |
| `system_logs` (ใหม่) | ระบบพังตรงไหน เพราะอะไร | **90 วัน (warn+) / 14 วัน (info,debug)** | dev |
| `traffic_daily` (ใหม่) | ปริมาณใช้งานย้อนหลังเป็นปี | **ไม่ลบ** (365 แถว/ปี) | ผู้บริหาร |

---

## 5. เฟส 1 — ปิดช่องกฎหมายก่อน (เล็ก เร็ว เสี่ยงต่ำที่สุด)

> **ทำก่อนทุกอย่าง** เพราะเป็นข้อบังคับที่ผิดอยู่ ณ วินาทีนี้ และแทบไม่ต้องเขียนโค้ด

**สถานะ: ☐ ยังไม่ทำ**

| งาน | รายละเอียด |
| --- | --- |
| 1.1 ขยาย retention | `.env`: `API_LOG_RETENTION_DAYS=30` → **`120`** (90 วันตามกฎหมาย + กันเหลื่อม 30 วัน) · ไม่ต้องแก้โค้ด `parseRetentionDays` รองรับถึง 3,650 อยู่แล้ว · ต้นทุน ~19–25 MB |
| 1.2 กู้พื้นที่ดิสก์ | ย้าย/ลบไฟล์ `backup-*.dump` 4 ไฟล์ (~297 MB) ออกจาก repo root ก่อน — ดิสก์เหลือ 8.6 G ที่ 88% เป็นความเสี่ยงของทั้งเครื่อง ไม่ใช่แค่ของแผนนี้ |
| 1.3 เก็บ `req_bytes` | `ALTER TABLE api_logs ADD COLUMN req_bytes integer` + อ่าน `Content-Length` ขาเข้าใน `collect()` — ปิดข้อ "ปริมาณข้อมูล" ให้ครบทั้งสองทาง · nullable ไม่มี default = แก้แค่ metadata รันตอนระบบเปิดอยู่ได้ |
| 1.4 บันทึกการเข้าสู่ระบบ (G4) | เพิ่ม `auth_events` **หรือ** ใช้ `audit_logs` ของเฟส 2 (แนะนำอย่างหลัง — ตารางเดียวจบ) · เก็บ: สำเร็จ/ล้มเหลว, username ที่กรอก, IP, user-agent, เหตุผล (`bad_password` / `rate_limited` / `no_such_user`) · **ห้ามเก็บรหัสที่กรอก** |
| 1.5 หลักฐานเรื่องนาฬิกา | บันทึกผล `timedatectl` ลง `DEPLOY.md` เป็นหลักฐานว่าตรงข้อบังคับ + เพิ่มขั้นตรวจใน checklist deploy |
| 1.6 เอกสารกำกับ | เพิ่มหัวข้อใน `DEPLOY.md`: ผู้มีหน้าที่ประสานงาน, ชั้นความลับของแต่ละตาราง log, ใครเข้าถึงได้, วิธีส่งมอบข้อมูลเมื่อมีหมายเรียก, ข้อจำกัดที่ระบุตัวคนกดลิงก์ `/download-pdf` ไม่ได้ (พร้อมเหตุผล) |

**เกณฑ์ผ่าน:** query `SELECT min(created_at) FROM api_logs` ย้อนได้เกิน 90 วันหลังผ่านไป 3 เดือน · `df -h /` เหลือ > 15%

---

## 6. เฟส 2 — `audit_logs`: log การแก้ไข (ช่องว่างที่ใหญ่ที่สุด)

**สถานะ: ☐ ยังไม่ทำ**

### 6.1 ปัญหาและทางเลือกที่ชั่งแล้ว

35 endpoint ที่แก้ข้อมูลเขียน `pool.query('UPDATE ...')` ตรง ๆ ใน `index.ts` (ตัวอย่าง [`index.ts:2522`](../index.ts#L2522))
มีแค่ 12 จุดในทั้งโปรเจกต์ที่ใช้ `withTransaction` และ repository 39 ตัวมีเพียง 4 ตัวที่รับ `DbExecutor`

| ทางเลือก | ข้อดี | ทำไมไม่เลือก |
| --- | --- | --- |
| A. เรียก `recordAudit()` ด้วยมือทุก handler | ตรงไปตรงมา | ต้องเขียน before/after เองทุกจุด · **ลืมจุดเดียว = ช่องโหว่ที่ไม่มีใครรู้** · แก้จาก psql/script ไม่ถูกบันทึกเลย |
| B. Trigger ล้วน | ครบ 100% ไม่มีทางหลุด | trigger ไม่รู้ว่า "ใครแก้" |
| **C. Trigger + ป้ายชื่อผู้ทำจาก Node** ✅ | ครบ 100% **และ** รู้ว่าใครทำ · แก้ handler จุดละ 1 บรรทัด | (เลือกอันนี้) |

### 6.2 โครงตาราง

```sql
CREATE TABLE public.audit_logs (
  id            bigserial   PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_id    varchar(16),            -- จับคู่กับ api_logs / system_logs ได้ทันที
  actor_type    varchar(12) NOT NULL,   -- admin | line | system | sync | api_key | unknown
  actor_id      varchar(60),            -- ไม่มี FK — ผู้ใช้ถูกลบแล้ว log ต้องไม่หายตาม (เหตุผลเดียวกับ api_logs)
  actor_name    varchar(120),           -- ชื่อ ณ เวลานั้น (denormalize โดยตั้งใจ — ชื่อเปลี่ยนทีหลังต้องไม่ย้อนแก้ประวัติ)
  action        varchar(60) NOT NULL,   -- promotion.update | user.role_change | auth.login_failed | quotation.export
  entity_type   varchar(40),
  entity_id     varchar(80),
  entity_label  varchar(200),           -- ชื่อที่คนอ่านออก เช่น code ของโปรโมชัน
  changed_cols  text[],                 -- ให้ตารางแสดง "แก้ 3 ช่อง" ได้โดยไม่ต้องแกะ jsonb
  before        jsonb,
  after         jsonb,
  ip            varchar(45),
  result        varchar(10) NOT NULL DEFAULT 'ok',   -- ok | denied | error
  note          text
);

CREATE INDEX idx_audit_logs_occurred  ON public.audit_logs (occurred_at DESC, id DESC);
CREATE INDEX idx_audit_logs_entity    ON public.audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_audit_logs_actor     ON public.audit_logs (actor_id, occurred_at DESC);
CREATE INDEX idx_audit_logs_request   ON public.audit_logs (request_id);
```

> ตารางนี้เขียนไม่กี่สิบแถว/วัน (คนละคนละโลกกับ `api_logs`) จึง **ใส่ index ได้เต็มที่** — เหตุผลที่ `api_logs` ไม่ใส่ index (ต้นทุนของทุก insert) ใช้ไม่ได้กับตารางนี้

### 6.3 กลไก (ส่วนที่ต้องออกแบบให้ถูก)

**ก. Trigger กลางตัวเดียว** ใช้ซ้ำกับทุกตารางผ่าน `TG_ARGV`:

```sql
CREATE FUNCTION audit_row() RETURNS trigger AS $$
DECLARE actor jsonb := COALESCE(current_setting('app.actor', true), '{}')::jsonb;
...
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION audit_row('promotion', 'code');
```

ติดกับ **11 ตารางตั้งค่า** ที่แก้กันวันละไม่กี่ครั้ง: `promotions`, `quotation_rules`, `product_optional_links`, `product_stock_rules`, `product_moq_rules`, `shipping_fee_config`, `quotation_credit_policy`, `quotation_blacklist`, `admin_users`, `salesperson`, `sync_settings`
**ห้ามติดกับ** `api_logs`, `messages`, `products`, `customers`, `sale_orders`, `customers_data_view` — ตารางที่ sync/insert รัว การ audit จะกลายเป็น write amplification ที่ทำระบบพัง

`admin_users` ต้องมี **column filter**: ตัด `password_hash` ออกก่อนเขียน before/after (กติกา §3.3 ข้อ 3)

**ข. ป้ายชื่อผู้ทำ** — `auditedQuery()` ใน `config/db.ts` แทน `pool.query` เฉพาะ statement ที่เขียนข้อมูล:

```ts
export async function auditedQuery(req, text, params) {
  return withTransaction(async (client) => {
    await client.query("SELECT set_config('app.actor', $1, true)", [actorJson(req)]);
    return client.query(text, params);
  });
}
```

* `set_config(..., true)` = `SET LOCAL` → ผูกกับ transaction ตายพร้อม COMMIT **ไม่รั่วข้าม request** (จุดที่พลาดกันบ่อยที่สุดของแพตเทิร์นนี้)
* แก้ handler ละ **1 บรรทัด** (`pool.query(` → `auditedQuery(req, `) ไม่ต้องรื้อโครง
* จุดที่ลืมแก้ยัง **ถูกบันทึกอยู่ดี** แค่ `actor_type='unknown'` → ไล่เก็บทีหลังได้จาก log เอง
* แก้จาก psql / script / sync ก็ถูกบันทึก (`actor_type='system'`) — ซึ่ง audit trail ที่ดีต้องทำได้

**ค. เหตุการณ์ที่ไม่ใช่การแก้แถวเดียว** เรียก `recordAudit()` ตรง ๆ จาก `services/auditService.ts`:
เข้าสู่ระบบสำเร็จ/ล้มเหลว · ถูกปฏิเสธสิทธิ์ (403) · ส่งออกใบเสนอราคา + ถอยเครื่องหมาย · สั่ง sync · อัปโหลด/ลบลายเซ็น · เปิดดูหน้า log (เฟส 6) · การนำเข้าโปรโมชันเป็นชุด

> ⚠️ `recordAudit()` **ห้ามใช้ buffer แบบทิ้งของได้** อย่าง `apiLogService` — audit หายไม่ได้ · เขียนตรงพร้อม retry และถ้าเขียนไม่ลงต้อง `console.error` ดัง ๆ (ซึ่งเฟส 3 จะจับต่อ)

**ง. `quotations` (ทำทีหลัง, ไม่บังคับ)** — แก้บ่อยและมี jsonb ก้อนใหญ่ ถ้า audit เต็มรูป before/after จะโตเร็วมาก
⇒ เก็บเฉพาะ `changed_cols` + สรุปย่อ (ยอดรวมก่อน→หลัง, จำนวนรายการก่อน→หลัง) ไม่เก็บ items ทั้งก้อน

### 6.4 เกณฑ์ผ่าน

* แก้โปรโมชัน 1 ตัวจากหน้าเว็บ → ได้ 1 แถวที่บอกชื่อคนแก้ + ช่องที่เปลี่ยน + ค่าเดิม/ค่าใหม่
* `UPDATE promotions ...` จาก psql → ได้แถวที่ `actor_type='unknown'` (พิสูจน์ว่าเลี่ยงไม่ได้)
* `SELECT before, after FROM audit_logs WHERE entity_type='admin_user'` → **ไม่มี `password_hash` โผล่**
* `scripts/diag/auditSmoke.ts` ครอบทั้ง 3 ข้อ (ตามแบบ diag script ที่มีอยู่ 20+ ตัว)

---

## 7. เฟส 3 — `system_logs`: เก็บ system log ทั้งหมด

**สถานะ: ☐ ยังไม่ทำ**

### 7.1 ปัญหา

`console.*` 821 จุด (`index.ts` 149 · `lineHandler.ts` 43 · `quotationService.ts` 37 · …) → docker `json-file` 10 MB × 5 → **หมุนทิ้ง ค้นย้อนหลังไม่ได้ ไม่มี request_id ผูก**
การไล่แก้ 821 จุดรวดเดียวคือความเสี่ยง regression ที่ไม่คุ้ม

### 7.2 ทำสองชั้น — ได้ผลทันทีวันแรก แล้วค่อยยกระดับ

**3a. ชั้นดัก (ไม่แก้โค้ดเดิมเลย)** — `config/logger.ts` patch `console.log/warn/error` ตอน boot:
* เรียกของเดิมต่อเสมอ (stdout ยังทำงานเหมือนเดิม 100% — docker logs ไม่เปลี่ยน)
* พ่วง `enqueueSystemLog()` ตามหลัง
* **ธง re-entrancy กันวนไม่จบ** — `console.error` ที่อยู่ในตัว logger เองต้องไม่ถูกดักซ้ำ (ถ้าพลาดข้อนี้ = process ตายทันทีตอน DB ล่ม)
* **redactor** ตัดค่าที่หน้าตาเป็น token/รหัส/`Bearer .*`/`password` + ตัดข้อความที่ 4 kB
* ผูก `request_id` อัตโนมัติผ่าน `AsyncLocalStorage` ที่ตั้งใน `apiLogMiddleware` → log ทุกบรรทัดรู้ว่ามาจาก request ไหนโดยไม่ต้องแก้ call site เลยสักจุด

**3b. ชั้นโครงสร้าง (ทยอย ไม่รีบ)** — `log.error({event, ctx})` แบบ structured ตาม RFC 5424
ไล่ทีละโมดูลตามลำดับความสำคัญ: `webhookQueue` → `lineHandler` → `quotationService` → `syncService` → ที่เหลือ
`console.*` ที่ยังไม่แปลงยังทำงานได้ตลอด (ชั้น 3a รับไว้) — **ไม่มี big-bang**

### 7.3 โครงตาราง + การคุมขนาด

```sql
CREATE TABLE public.system_logs (
  id          bigserial   PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  level       varchar(5)  NOT NULL,   -- fatal|error|warn|info|debug (RFC 5424 ย่อเหลือที่ใช้จริง)
  source      varchar(60),            -- ชื่อโมดูล เช่น webhook-queue, api-log, sync
  event       varchar(80),            -- ชื่อเหตุการณ์แบบคงที่ (3b) — NULL สำหรับบรรทัดที่ดักมาจาก console
  message     text        NOT NULL,
  request_id  varchar(16),
  actor_id    varchar(60),
  ctx         jsonb,
  err_stack   text
);
CREATE INDEX idx_system_logs_created ON public.system_logs (created_at DESC, id DESC);
CREATE INDEX idx_system_logs_level   ON public.system_logs (level, created_at DESC);
CREATE INDEX idx_system_logs_request ON public.system_logs (request_id);
```

**ประมาณขนาด:** ~10 บรรทัด/request × 1,000 request/วัน × ~350 B ≈ **3.5 MB/วัน**
⇒ ถ้าเก็บทุกระดับ 90 วัน = ~315 MB · ดิสก์เหลือ 8.6 G จึง **ยังไหวแต่ไม่ควรใจกว้าง**

**ตั้งต้นที่ปลอดภัย (ปรับได้ด้วย env ไม่ต้อง deploy ใหม่):**
| env | ค่า | ความหมาย |
| --- | --- | --- |
| `SYSTEM_LOG_DB_LEVEL` | `warn` | ต่ำกว่านี้ไปแค่ stdout ไม่ลง DB — วันปกติ DB โตแค่หลัก **kB** |
| `SYSTEM_LOG_RETENTION_DAYS` | `90` | สำหรับ `warn` ขึ้นไป |
| `SYSTEM_LOG_INFO_RETENTION_DAYS` | `14` | สำหรับ `info`/`debug` ตอนเปิดชั่วคราวเพื่อไล่บั๊ก |
| `SYSTEM_LOG_ENABLED` | `true` | สวิตช์ปิดทั้งระบบ (แบบเดียวกับ `API_LOG_ENABLED`) |

ตัวเขียน + retention **คัดลอกแพทเทิร์นจาก `apiLogService.ts` ทั้งดุ้น** (batch 500 / flush 2 วิ / เพดาน buffer / retention ทีละก้อนรายชั่วโมง / flush ตอน shutdown) — ของที่จูนมาแล้วและพิสูจน์กับ production แล้ว ไม่ต้องคิดใหม่

### 7.4 เกณฑ์ผ่าน

* ถอด DB ออกกลางคัน (`docker stop db`) → แอปยังตอบ request ได้ ไม่มี unhandled rejection · log แค่หาย
* `console.error` ในตัว logger เอง → ไม่เกิด loop (มี diag ยิงเคสนี้ตรง ๆ)
* หา error 1 ตัวจาก `X-Request-Id` แล้วเห็นทั้ง 3 ตาราง (`api_logs` + `system_logs` + `audit_logs`) ครบ

---

## 8. เฟส 4 — Dashboard สรุป traffic วัน/สัปดาห์/เดือน/ปี

**สถานะ: ☐ ยังไม่ทำ**

### 8.1 ทำไมต้องมีชั้น rollup

`api_logs` เก็บ 120 วัน → **มุมมอง "ปี" จะว่างเปล่าตลอดกาล** ถ้าอ่านจากแถวดิบ
และการ `GROUP BY` แถวดิบข้ามหลายเดือนทุกครั้งที่เปิดหน้าคือการสแกนซ้ำ ๆ โดยไม่จำเป็น
⇒ **สรุปวันละครั้ง เก็บถาวร** (365 แถว/ปี = ไม่มีต้นทุน) แล้วหน้าจอทุกมุมมองอ่านจากตารางเดียวกัน

```sql
CREATE TABLE public.traffic_daily (
  day               date PRIMARY KEY,
  requests          integer NOT NULL,
  requests_api      integer NOT NULL,   -- แยก /api ออกจาก static/liff/download
  webhook_events    integer NOT NULL,
  webhook_dropped   integer NOT NULL,
  webhook_timeout   integer NOT NULL,
  errors_4xx        integer NOT NULL,
  errors_5xx        integer NOT NULL,
  uniq_line_users   integer NOT NULL,
  uniq_admin_users  integer NOT NULL,
  uniq_ips          integer NOT NULL,
  bytes_out         bigint,
  duration_sum_ms   bigint  NOT NULL,   -- ให้คำนวณค่าเฉลี่ยของช่วงใหญ่ได้ "ถูกต้องจริง"
  p50_ms            integer, p95_ms integer, p99_ms integer,
  max_inflight      smallint, db_wait_hits integer,
  quotations_created integer,
  messages_in       integer,
  audit_changes     integer,
  computed_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

> ⚠️ **กับดักที่ต้องพูดตรง ๆ บนหน้าจอ: percentile รวมย้อนกลับไม่ได้**
> p95 ของเดือน ≠ ค่าเฉลี่ยของ p95 รายวัน · จะทำให้ถูกต้องต้องเก็บ t-digest ซึ่งเกินความจำเป็นของงานนี้มาก
> **วิธีที่เลือก:** ค่าเฉลี่ย (`duration_sum_ms / requests`) แสดงเป็นตัวเลขหลักเพราะรวมย้อนกลับได้ถูกต้อง 100%
> ส่วน p95 ของช่วงยาวติดป้ายชัดว่า **"p95 สูงสุดรายวันในช่วงนี้"** ไม่ใช่ "p95 ของทั้งช่วง"
> (เป็นหลักเดียวกับที่ `ApiLogs.tsx` บังคับให้เขียน "เอกสารของ" กำกับ `doc_owner` เสมอ — ห้ามให้ตัวเลขโกหก)

**งานสรุป:** setInterval ระดับโมดูลตามแบบ `syncService` · รันตี 1 ตามเวลาไทย สรุป "เมื่อวาน" · `INSERT ... ON CONFLICT (day) DO UPDATE` → รันซ้ำได้ · `scripts/backfillTrafficDaily.ts` ย้อนหลังจากข้อมูลที่มีอยู่ 23 วันได้ทันที
มุมมอง "วันนี้" อ่านสดจาก `api_logs` แล้วต่อท้ายอนุกรมของ rollup (วันที่ยังไม่จบยังไม่มีแถวสรุป)

### 8.2 หน้าจอ

เมนูใหม่ **"รายงานการใช้งาน"** (`Traffic.tsx`) แยกจาก `ApiLogs.tsx` — คนละกลุ่มผู้ใช้ (ผู้บริหาร vs ops) และ `ApiLogs.tsx` ใหญ่ 839 บรรทัดแล้ว

* **ตัวเลือกช่วง:** วัน / สัปดาห์ / เดือน / ปี + ปุ่มเลื่อนไปหน้า–หลัง + เทียบกับช่วงก่อนหน้า (`▲ 12% จากสัปดาห์ที่แล้ว`)
* **แถว KPI:** เรียก API ทั้งหมด · ผู้ใช้ไม่ซ้ำ (LINE / แอดมิน) · ใบเสนอราคาที่ออก · ข้อความเข้า · อัตราข้อผิดพลาด · เวลาตอบเฉลี่ย — ทุกใบมี sparkline ของช่วงนั้น
* **กราฟหลัก:** ปริมาณตามเวลา (แกนละเอียดตามช่วง: ราย ชม. / ราย วัน / ราย สัปดาห์ / ราย เดือน) ซ้อนแท่งข้อผิดพลาด
* **ตารางประกอบ:** endpoint ที่ถูกเรียกมากสุด · ผู้ใช้ที่ใช้งานมากสุด · ข้อผิดพลาดแยกตาม status · ชั่วโมงที่โหลดหนักสุด (heatmap 7×24)
* **ปุ่มส่งออก:** CSV + PDF ของช่วงที่เลือก — **จำเป็นจริง** เพราะเป็นรูปแบบที่ส่งมอบเมื่อมีหมายเรียกตาม ม.18/ม.26
* คลิกทุกตัวเลขแล้ว **ทะลุไปหน้า "บันทึกการเรียก API" พร้อมตัวกรองที่ถูกตั้งไว้ให้แล้ว** (drill-down — ตัวที่ทำให้ dashboard ไม่ใช่แค่รูปสวย)

---

## 9. เฟส 5 — UX/UI ตามมาตรฐานสากล

**สถานะ: ☐ ยังไม่ทำ**

### 9.1 จัดบ้าน: รวมเป็นกลุ่มเมนูเดียว

ตอนนี้ `NAV_ITEMS` ([`AdminApp.tsx:60`](../frontend/src/admin/AdminApp.tsx#L60)) มี `apilogs` โดด ๆ · เพิ่มอีก 3 หน้าแบบเดิมจะกลายเป็นเมนูรก
⇒ ทำเป็นกลุ่มพับได้ **"บันทึกและรายงาน"** (แบบเดียวกับ `SETTINGS_SUBITEMS` ที่มีอยู่แล้ว):

```
บันทึกและรายงาน
 ├─ รายงานการใช้งาน      (เฟส 4)
 ├─ บันทึกการเรียก API   (ของเดิม)
 ├─ บันทึกการแก้ไข       (เฟส 2)
 └─ บันทึกระบบ           (เฟส 3)
```

### 9.2 แยก component กลางออกจาก `ApiLogs.tsx`

4 หน้านี้เป็นหน้าเดียวกันในเชิงโครงสร้าง (ช่วงเวลา → กรอง → ตาราง → รายละเอียด) · ถ้า copy-paste จะได้โค้ด 3,000 บรรทัดที่แก้ที่หนึ่งลืมอีกสามที่
⇒ สร้าง `frontend/src/admin/logs/` แล้วดึงของที่มีอยู่แล้วใน `ApiLogs.tsx` ออกมา (ไม่ได้เขียนใหม่ — ย้าย):

`TimeRangePicker` · `LogFilterBar` · `LogTable` (paged + sticky header) · `DetailDrawer` · `SeverityBadge` · `CopyableId` · `Pagination` · `EmptyState` · `ExportButton` · `formatDateTime`/`formatMs`/`formatBytes`/`decodePath` (ยกไป `logs/format.ts`)

> `ApiLogs.tsx` ต้องหน้าตาและพฤติกรรมเหมือนเดิมเป๊ะหลังรีแฟกเตอร์ — งานนี้เป็น **การย้ายที่ ไม่ใช่การออกแบบใหม่** (กติกา "ของเดิมห้ามพัง")

### 9.3 กติกาหน้าจอที่บังคับใช้ทั้ง 4 หน้า

| หัวข้อ | กติกา |
| --- | --- |
| **เวลา** | ปัก `Asia/Bangkok` เสมอ ไม่ใช้โซนของเบราว์เซอร์ (ของเดิมทำถูกอยู่แล้ว — ยกเป็นกติกากลาง) · แสดงเวลาสัมพัทธ์ ("3 นาทีที่แล้ว") คู่กับเวลาเต็มใน tooltip |
| **ความรุนแรง** | สีเดียวกันทุกหน้า: 5xx/fatal แดง · 4xx/warn เหลือง · 3xx/info ฟ้า · 2xx/ok เขียว |
| **สี ≠ ความหมายเดียว** | ห้ามใช้สีเป็นตัวสื่อความหมายอย่างเดียว ต้องมีข้อความ/ไอคอนกำกับ (WCAG 1.4.1) — คนตาบอดสีอ่านได้ |
| **ความคมชัด** | badge ทุกตัวผ่าน contrast 4.5:1 (WCAG 2.2 AA) — ของเดิมบางตัว (`text-amber-700` บนพื้น 50) ต้องวัดใหม่ |
| **คีย์บอร์ด** | เลื่อนแถวด้วย ↑↓ · Enter เปิดรายละเอียด · Esc ปิด · `/` โฟกัสช่องค้นหา · focus ring มองเห็นชัด |
| **สถานะ** | มีครบ 4 แบบทุกตาราง: กำลังโหลด (skeleton ไม่ใช่ spinner เปล่า) · ว่าง · ผิดพลาด+ปุ่มลองใหม่ · ไม่มีสิทธิ์ |
| **URL คือสถานะ** | ตัวกรอง/ช่วงเวลา/หน้า อยู่ใน query string → copy ลิงก์ส่งให้เพื่อนแล้วเห็นหน้าจอเดียวกัน (จำเป็นมากตอนสอบสวนเหตุการณ์) |
| **สหสัมพันธ์** | ทุกหน้ามีปุ่ม "ดูทุกอย่างของ request นี้" จาก `request_id` → เปิดไทม์ไลน์รวม 3 ตาราง **นี่คือฟีเจอร์ที่ทำให้แผนทั้งหมดคุ้ม** |
| **ตัวเลขต้องไม่โกหก** | ค่าที่เป็นการประมาณต้องติดป้ายบอก (ดู §8.1 เรื่อง p95) · ค่าที่ระบุตัวคนไม่ได้ต้องเขียนกำกับ (แบบ `doc_owner` เดิม) |
| **บนมือถือ** | ตารางยุบเป็นการ์ดที่ < 768px — แอดมินเปิดจากมือถือจริงเวลามีเหตุ |

---

## 10. เฟส 6 — ความถูกต้องแท้จริงและสิทธิ์เข้าถึง (ปิดข้อกฎหมายที่เหลือ)

**สถานะ: ☐ ยังไม่ทำ**

| งาน | รายละเอียด |
| --- | --- |
| 6.1 **เขียนได้อย่างเดียว** (G8) | สร้าง DB role `chatbot_app` ที่ถูก `REVOKE UPDATE, DELETE ON audit_logs, api_logs, system_logs` · การลบตาม retention ใช้ role แยก · แอปเลิกใช้ superuser `postgres` — **มีผลดีเกินขอบเขตแผนนี้** และเป็นข้อบังคับ "ข้อมูลต้องไม่ถูกแก้ไขโดยง่าย" |
| 6.2 **ลายนิ้วมือรายวัน** | งานสรุปรายวัน (เฟส 4) คำนวณ `sha256` ของแถว audit ทั้งวัน + hash ของเมื่อวาน → เก็บลง `audit_daily_digest` และเขียนสำเนาออกนอกเครื่องพร้อม backup · เป็นหลักฐาน integrity ที่พิสูจน์ได้จริงโดยไม่ต้องทำ hash chain รายแถว |
| 6.3 **role `auditor`** (G7) | เพิ่มค่าใน `admin_users_role_check` — เห็นเฉพาะกลุ่มเมนู "บันทึกและรายงาน" อ่านอย่างเดียว · ให้ผู้ตรวจสอบ/ฝ่ายกฎหมายเข้าดูได้โดยไม่ต้องแจก `admin` |
| 6.4 **บันทึกการดู log** | เปิดหน้า log / กดส่งออก = เขียน `audit_logs` (`action='log.view'`, `'log.export'`) · หลักปฏิบัติมาตรฐาน — คนที่เข้าถึงหลักฐานต้องถูกบันทึกด้วย |
| 6.5 **log อยู่ใน backup** | ตรวจว่า `scripts/dbDump.ts` ไม่ได้ `--exclude-table-data` ตาราง log ทั้ง 4 (ตอนนี้ตัดเฉพาะตาราง `SYNCABLE`) และเพิ่มคำเตือน PII ของ dump ใน `DEPLOY.md` §4.6 ให้ครอบ `audit_logs`/`system_logs` ด้วย |

---

## 11. ลำดับที่แนะนำ และเหตุผล

| ลำดับ | เฟส | แรง | ทำไมอยู่ตรงนี้ |
| --- | --- | --- | --- |
| 1 | **1 — ปิดช่องกฎหมาย** | XS | แก้ env + ลบไฟล์ + เขียนเอกสาร · **ผิดกฎหมายอยู่ตอนนี้** และเกือบไม่มีความเสี่ยงทางเทคนิค |
| 2 | **2 — audit_logs** | M | ช่องว่างใหญ่สุดในเชิงคุณค่า · ทำก่อนเฟส 3 เพราะ trigger จบในตัว ไม่ต้องรอ logger |
| 3 | **3a — ชั้นดัก console** | S | ได้ system log ทั้ง 821 จุดโดยไม่แก้โค้ดเดิม · ต้องมาก่อนเฟส 4 เพื่อให้ dashboard มีข้อมูลครบ |
| 4 | **4 — rollup + Dashboard** | L | ต้องรอ rollup สะสมข้อมูล จึงเริ่ม backfill ให้เร็วที่สุดหลังเฟส 1 |
| 5 | **5 — UX/UI** | M | รีแฟกเตอร์ component หลังรู้แล้วว่า 4 หน้าต้องการอะไรจริง ๆ (ทำก่อนจะเดาผิด) |
| 6 | **6 — integrity/สิทธิ์** | M | ปิดข้อกฎหมายที่เหลือ · 6.1 แตะสิทธิ์ DB จึงควรทำตอนของอื่นนิ่งแล้ว |
| 7 | 3b — structured log ทีละโมดูล | ทยอย | งานต่อเนื่อง ไม่มีเส้นตาย |

**ทางลัดถ้าต้องรีบตอบเรื่องกฎหมายอย่างเดียว:** เฟส 1 + 6.6 (เอกสาร) ก็ผ่าน ม.26 ได้แล้ว — ที่เหลือคือคุณค่าทางธุรกิจและการดูแลระบบ

---

## 12. ความเสี่ยงและสิ่งที่จงใจไม่ทำ

| ความเสี่ยง | การรับมือ |
| --- | --- |
| ดิสก์เหลือ 8.6 G (88%) แล้วยังจะเพิ่ม 3 ตาราง | เฟส 1.2 กู้คืน ~297 MB ก่อน · `SYSTEM_LOG_DB_LEVEL=warn` ทำให้วันปกติโตหลัก kB · ตั้ง alert ที่ 90% |
| Trigger ทำให้การเขียนช้าลง | ติดเฉพาะ 11 ตารางตั้งค่าที่แก้วันละไม่กี่ครั้ง · **ห้ามแตะ** ตารางที่ sync เขียนรัว |
| patch `console` แล้ววนไม่จบตอน DB ล่ม | ธง re-entrancy + diag ยิงเคสนี้ตรง ๆ เป็นเกณฑ์ผ่านของเฟส 3 |
| `SET LOCAL` รั่วข้าม request | ใช้ `set_config(..., true)` ใน `withTransaction` เท่านั้น — ตายพร้อม COMMIT · **ห้าม** `SET` ระดับ session บน pooled client เด็ดขาด |
| เก็บ log นานขึ้น = PII ค้างนานขึ้น (ชนกับ PDPA) | redactor กลาง + ไม่เก็บ body ดิบ + `audit_logs` เก็บเฉพาะส่วนต่างของ *ตารางตั้งค่า* + เฟส 6.3/6.4 คุมว่าใครดูได้และดูแล้วถูกบันทึก |
| รีแฟกเตอร์ `ApiLogs.tsx` แล้วของเดิมเพี้ยน | เฟส 5.2 เป็นการย้ายไฟล์ล้วน ต้องเทียบหน้าจอก่อน/หลังทีละแท็บก่อน merge |

**จงใจไม่ทำ:**
* ไม่ส่ง log ออกไป ELK / Loki / Datadog — เครื่องเดียว ปริมาณหลัก MB/วัน การเพิ่ม stack ใหม่แพงกว่าปัญหาหลายเท่า (เกณฑ์ที่ควรกลับมาคิดใหม่: > 50 GB/เดือน หรือมีมากกว่า 1 เครื่อง)
* ไม่เก็บ request/response body ทั้งก้อน (คงการตัดสินใจเดิม)
* ไม่เก็บเนื้อหาแชท LINE เพิ่ม — `messages` มีอยู่แล้ว การทำซ้ำใน log คือการเพิ่มความเสี่ยง PII เปล่า ๆ
* ไม่ทำ hash chain รายแถว — 6.2 (digest รายวัน) ให้ผลเชิงพิสูจน์ใกล้เคียงด้วยต้นทุนเสี้ยวเดียว
* ไม่ partition ตาราง log — เกณฑ์เดิมยังใช้ได้: เกิน ~5M แถว หรือ 3 GB ค่อยคิด (ที่ 120 วันยังอยู่แค่ ~25 MB)
