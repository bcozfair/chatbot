# คู่มือ Deploy ด้วย Docker (สำหรับมือใหม่)

Deploy LINE chatbot นี้ลง server บริษัท (Ubuntu, รันหลายโปรเจครวมกัน) ด้วย Docker
โครงสร้าง: 1 กล่องแอป (Express + React ที่ build แล้ว + Chromium สำหรับ PDF) + 1 กล่อง PostgreSQL

**ยืนยันสภาพ server แล้ว**: Docker 29 + Compose v2, user `app_sales` อยู่กลุ่ม `docker` (ไม่ต้อง sudo), path = `/home/app_sales/salechatbot`
**IT จัดการให้**: subdomain + HTTPS (reverse proxy กลาง) — เราแค่บอกพอร์ตที่เปิดไว้

---

## ภาพรวมลำดับงาน
1. เครื่องตัวเอง (Windows): push โค้ด + dump database
2. Server: ดึงโค้ด → ตั้ง `.env` → restore database → `docker compose up`
3. แจ้ง IT ผูก subdomain กับพอร์ต
4. ตั้ง LINE webhook

---

## ส่วนที่ 1 — บนเครื่องตัวเอง (Windows / PowerShell)

### 1.1 push โค้ด (ไฟล์ Docker ที่เพิ่งสร้าง) ขึ้น GitHub
```powershell
cd C:\Users\bcozf\Downloads\Chatbot
git add Dockerfile .dockerignore docker-compose.yml .env.example DEPLOY.md package.json
git commit -m "chore: add Docker deployment setup"
git push origin main
```

### 1.2 dump database ออกจาก PostgreSQL ในเครื่อง
```powershell
$env:PGPASSWORD = "database"
& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -h localhost -p 5432 -U postgres -d chatbot_primus -Fc -f "$HOME\chatbot_primus.dump"
```
> เครื่อง dev นี้ใช้ PostgreSQL **18** → docker-compose ตั้ง `postgres:18` ให้ตรงกันแล้ว (major version ต้องตรง ไม่งั้น restore ไม่ได้)

### 1.3 ส่งไฟล์ dump ไป server
```powershell
scp "$HOME\chatbot_primus.dump" app_sales@<server-ip>:/home/app_sales/salechatbot/
```
> `<server-ip>` = IP ของ server (ตัวเดียวกับที่ SSH เข้า)

---

## ส่วนที่ 2 — บน Server (SSH หรือ VSCode Remote-SSH เข้า Ubuntu)

### 2.1 ดึงโค้ดล่าสุด
```bash
cd /home/app_sales/salechatbot
git pull origin main          # ถ้ายังไม่เคย clone: cd /home/app_sales && git clone https://github.com/bcozfair/chatbot.git salechatbot
```
> ถ้า repo เป็น **private** จะโดนถาม username/password → ใช้ GitHub **Personal Access Token** แทน password (หรือถาม IT เรื่อง deploy key)

### 2.2 สร้างไฟล์ `.env` แล้วเติมค่าจริง
```bash
cp .env.example .env
nano .env                     # หรือแก้ผ่าน VSCode Remote-SSH
```
เติมค่าให้ครบ โดย **สำคัญ**:
- `PG_HOST=db` (ต้องเป็น `db` ไม่ใช่ localhost — เพราะ DB อยู่คนละกล่อง)
- `PG_DATABASE=chatbot_primus`, `PG_USER=postgres`
- `PG_PASSWORD=` ← **ตั้งรหัสใหม่** (จำไว้ ใช้ตอน restore ด้านล่าง)
- `JWT_SECRET=` ← ตั้งค่าใหม่
- `APP_PORT=` ← พอร์ตที่จะให้ IT route subdomain มา (ถ้ายังไม่รู้ ใช้ `3011` ไปก่อน แล้วเปลี่ยนทีหลัง)
- `APP_URL=` ← **โดเมนสาธารณะเต็ม ๆ** เช่น `https://bot.company.com` (ยังไม่รู้ตอนนี้ก็ข้ามไปก่อน แต่**ต้องกลับมาเติมให้ได้ก่อนเปิดใช้จริง** — ดูส่วนที่ 3)
- LINE / DeepSeek / LIFF / sync keys → ใส่ค่าเดิมจาก `.env` เครื่องคุณ

### 2.3 ขึ้น database container ก่อน แล้ว restore ข้อมูล
```bash
docker compose up -d db
docker compose ps                    # รอจนคอลัมน์ STATUS ของ db ขึ้น "healthy"

# โหลดค่า .env เข้า shell เพื่อใช้ $PG_USER / $PG_DATABASE
set -a; source .env; set +a

docker compose cp chatbot_primus.dump db:/tmp/chatbot_primus.dump
docker compose exec db pg_restore -U "$PG_USER" -d "$PG_DATABASE" --clean --if-exists --no-owner /tmp/chatbot_primus.dump
```
ตรวจสอบว่าย้ายครบ:
```bash
docker compose exec db psql -U "$PG_USER" -d "$PG_DATABASE" -c "\dt"
docker compose exec db psql -U "$PG_USER" -d "$PG_DATABASE" -c "SELECT count(*) FROM quotations;"
```
เทียบจำนวนตาราง/row กับเครื่อง dev ให้ตรง

### 2.4 build + รันทั้ง stack
```bash
docker compose up -d --build         # ครั้งแรก build นาน (โหลด Chromium + ฟอนต์) รอสักครู่
docker compose logs -f app           # เห็น "listening on 3011" = สำเร็จ (กด Ctrl+C ออกจาก log ได้ แอปยังรันอยู่)
docker image prune -f --filter "until=24h"   # ลบ image เก่าที่ไม่มีใครใช้ (ของอายุน้อยกว่า 24 ชม. ไม่โดน)
```

### 2.5 เช็คว่าแอปตอบ (บน server)
```bash
curl -I http://127.0.0.1:${APP_PORT:-3011}/        # ควรได้ HTTP 200
```

---

## ส่วนที่ 3 — แจ้ง IT
บอก IT: **subdomain ที่ต้องการ** (เช่น `bot.company.com`) + **พอร์ต** ที่ตั้งใน `APP_PORT` (ผูกไว้ที่ `127.0.0.1`)
IT จะตั้ง reverse proxy + HTTPS ให้ชี้ subdomain → พอร์ตนั้น

> **🔴 ได้ subdomain มาแล้วต้องเติม `APP_URL` ใน `.env` ทันที แล้ว `docker compose up -d --force-recreate app`**
> ลิงก์ PDF ที่บอทส่งเข้าแชทประกอบขึ้นจากค่านี้ · **ถ้า `APP_URL` ว่าง แอปจะเดาจาก Host header ของ
> webhook ตัวแรกที่เข้ามาหลัง container เกิดใหม่** แล้วล็อกไว้ในหน่วยความจำจนกว่าจะ recreate —
> ซึ่งแปลว่า `curl` ตรวจสุขภาพจากในเครื่อง (ขั้น 4) ที่บังเอิญยิง `/callback` ก่อน LINE ตัวจริง
> จะทำให้ทุกลิงก์กลายเป็น `http://127.0.0.1:3011` ที่มือถือลูกค้าเปิดไม่ได้ **โดยไม่มี error ใด ๆ ให้เห็น**
> เกิดขึ้นจริงเมื่อ 2026-08-20 (ใบเสนอราคาเสียไป 4 ใบ) · ตั้ง `APP_URL` แล้วเส้นทางเดานี้จะไม่ทำงานเลย
>
> ตรวจว่าตั้งติดจริง: `docker compose exec -T app printenv APP_URL` ต้องขึ้นโดเมน ไม่ใช่ค่าว่าง
> · ตั้งแต่ 2026-08-20 แอป **ปฏิเสธที่จะสตาร์ท**ถ้า `APP_URL` ขาด/ไม่ใช่ https/มี path ต่อท้าย
>   ดังนั้นถ้า container ขึ้นแล้ว log ว่า `[APP_URL] ...` แล้วดับ ให้ไปแก้ค่าใน `.env` แล้ว
>   `docker compose up -d --force-recreate app` — ไม่ใช่ปัญหาอื่น · ตรวจค่าล่วงหน้าได้ด้วย
>   `npm run diag:app-url` (อ่านอย่างเดียว รันบน prod ได้)

> ถ้า IT บอกว่า proxy ของเขาอยู่ใน docker network (ไม่ใช่ host) อาจต้องปรับ `docker-compose.yml` ให้ join network ของเขาแทนการ publish port — แจ้งผมได้ เดี๋ยวปรับให้

---

## ส่วนที่ 4 — ตั้ง LINE webhook
เมื่อ IT ให้ HTTPS URL มาแล้ว:
1. LINE Developers console → Messaging API → **Webhook URL** = `https://<subdomain>/callback` → กด **Verify** (ต้องได้ Success)
2. อัปเดต **LIFF Endpoint URL** ของทั้ง 3 LIFF apps → `https://<subdomain>/liff/register`, `/liff/quote-edit`, `/liff/product-search`

---

## ⚠️ ข้อบังคับ: LIFF ต้องอยู่ provider เดียวกับ Messaging API channel

LINE user id **ผูกกับ provider ไม่ใช่บัญชีผู้ใช้** ถ้า LINE Login channel (เจ้าของ LIFF apps)
อยู่คนละ provider กับ Messaging API channel ผู้ใช้คนเดียวกันจะได้ **user id คนละตัว**:

| ที่มา | ค่าที่ได้ |
|---|---|
| webhook `event.source.userId` | id ของ provider ฝั่ง Messaging |
| `liff.getProfile().userId` ในหน้า LIFF | id ของ provider ฝั่ง Login |

ผลคือหน้า LIFF ที่เปิด **โดยไม่มี `?userId=`** (เช่นจากริชเมนู) จะได้ id ที่ไม่มีในตาราง `salesperson`
→ `/api/quotation/draft-cart` ตอบ 403 "บัญชี LINE นี้ยังไม่ได้ลงทะเบียน"
(ดู log `[draft-cart] 403 ไม่พบ salesperson: userId="U..."` ใน `index.ts` เพื่อยืนยันอาการ)

หน้าที่เปิดจากปุ่มในแชทไม่เจอปัญหา เพราะบอทแนบ `?userId=` (id ฝั่ง Messaging) มาให้เสมอ
และหน้า LIFF ใช้ค่าจาก URL ก่อน `getProfile()` — อาการจึงโผล่เฉพาะทางริชเมนู

### วิธีย้าย (channel ย้าย provider ไม่ได้ ต้องสร้างใหม่)
1. LINE Developers Console → เข้า **provider เดียวกับ Messaging API channel** → **Create a LINE Login channel**
2. ในช่อง Login channel ใหม่ → **Linked LINE Official Account** = เลือก OA ตัวเดียวกับบอท
   *(ข้อนี้ห้ามลืม — ไม่งั้น `liff.sendMessages()` ที่หน้า product-search / quote-edit ใช้ส่ง trigger กลับแชทจะพัง)*
3. เปิด scope: **profile**, **openid**, **chat_message.write**
4. สร้าง LIFF apps 3 ตัว endpoint ตามส่วนที่ 4 ข้อ 2 (`/liff/register`, `/liff/quote-edit`, `/liff/product-search`)
5. เอา LIFF ID ใหม่ใส่ `.env` แล้ว restart แอป
   ```
   LIFF_ID=<register>
   LIFF_QUOTE_ID=<quote-edit>
   LIFF_PRODUCT_SEARCH_ID=<product-search>
   ```
6. OA Manager → ริชเมนู → แก้ URL ปุ่มแค็ตตาล็อกเป็น `https://liff.line.me/<LIFF_PRODUCT_SEARCH_ID ใหม่>`
7. **ตรวจว่าย้ายสำเร็จ**: เปิดแค็ตตาล็อกจาก**ริชเมนู** (ไม่ใช่ปุ่มในแชท) → ใส่สินค้าลงตะกร้า → กด 💾 ร่างใบเสนอราคา
   ต้องได้การ์ดร่างกลับมาในแชท ไม่ใช่ข้อความ "ยังไม่ได้ลงทะเบียน"

> หลังย้ายเสร็จ `getProfile().userId` จะตรงกับ webhook แล้ว ทำให้ยกระดับความปลอดภัยต่อได้:
> เปลี่ยนจากเชื่อ `userId` ที่ client ส่งมา → ตรวจ **LIFF ID token** ฝั่ง server แทน (ยังไม่ได้ทำ)

---

## อัปเดต server ที่ deploy ไปแล้ว

โค้ดถูกห่อเข้า image ตอน build → **แก้ไฟล์เฉย ๆ กล่องยังไม่เปลี่ยน ต้อง rebuild ทุกครั้ง**
ถ้าช่วงที่ค้างมี migration ด้วย **ห้ามใช้แค่ `git pull && up -d --build`** — ต้องทำตามลำดับ 6 ขั้นนี้

> ลำดับสำคัญ: **migration ต้องรันก่อน rebuild** เพราะโค้ดใหม่ query คอลัมน์ที่ยังไม่มีใน DB เก่า
> repo นี้ **ไม่มีตารางบันทึกว่า migration ไหนรันไปแล้ว** → git log บอกไม่ได้ ต้องเช็คจาก DB จริง (ขั้น 4)

### ขั้น 1 — ดูว่า server ค้างอยู่ commit ไหน + มีอะไรค้าง
```bash
cd /home/app_sales/salechatbot
git log --oneline -1                        # commit ปัจจุบัน (สมมติเรียกว่า <OLD>)
git status -sb                              # ต้องสะอาด ไม่งั้น pull ชน
git fetch origin
git log --oneline HEAD..origin/main                       # commit ที่ค้าง
git diff --stat HEAD..origin/main -- migrations/changes    # migration ที่ค้าง
git diff HEAD..origin/main -- .env.example docker-compose.yml package.json
```

### ขั้น 2 — สำรอง DB ก่อนเสมอ (ห้ามข้าม)
```bash
set -a; source .env; set +a
docker compose exec -T db pg_dump -U "$PG_USER" -d "$PG_DATABASE" -Fc > backup-$(date +%F-%H%M).dump
ls -lh backup-*.dump          # ต้องมีขนาดสมเหตุผล ไม่ใช่ 0 ไบต์
```
(`*.dump` อยู่ใน `.gitignore` แล้ว วางไว้ในโฟลเดอร์โปรเจคได้ ไม่หลุดขึ้น git)

### ⚠️ ขั้น 3 — เช็ค mount ของ volume `pgdata` (เฉพาะ server ที่เก่ากว่า commit 32751ef)
commit `32751ef` ย้าย mount จาก `/var/lib/postgresql/data` → `/var/lib/postgresql`
ถ้า server ยังไม่มี commit นี้ พอ pull แล้ว recreate กล่อง db **Postgres จะเห็น data dir ว่างแล้ว initdb ใหม่ = DB เปล่า**
```bash
git merge-base --is-ancestor 32751ef HEAD && echo "มี fix แล้ว ข้ามขั้นนี้ได้" || echo "ยังไม่มี fix — อ่านต่อ"
docker inspect -f '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' $(docker compose ps -q db)
```
ถ้า Destination ยังเป็น `/var/lib/postgresql/data` → หลัง `up -d --build` ให้เช็คว่า DB ว่างไหม (`\dt`)
ถ้าว่างให้ restore จาก dump ขั้น 2 (ข้อมูลเดิมไม่ได้หาย แต่ค้างอยู่คนละ path ใน volume):
```bash
docker compose cp backup-XXXX.dump db:/tmp/restore.dump
docker compose exec db pg_restore -U "$PG_USER" -d "$PG_DATABASE" --clean --if-exists --no-owner /tmp/restore.dump
```

### ขั้น 4 — pull แล้วรัน migration ที่ขาด
```bash
git pull --ff-only origin main
```
เช็คสถานะ DB จริงว่าขาดตัวไหน (คำสั่งเดียวตอบครบ — เพิ่มบรรทัดเองได้เมื่อมี migration ใหม่):
```bash
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
SELECT to_regclass('public.customers_data_view')  AS matview,
       to_regprocedure('public.clean_text(text)') AS clean_text,
       EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.customers_data_view')
              AND attname='sales_team' AND NOT attisdropped)                                  AS sales_team,
       EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name='salesperson' AND column_name='employee_quotation_id')         AS employee_qid,
       EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name='quotations' AND column_name='odoo_exported_at')               AS exported_at,
       to_regclass('public.quotation_export_batches')                                         AS export_batches,
       to_regclass('public.api_logs')                                                         AS api_logs,
       EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name='api_logs' AND column_name='ip')                               AS api_logs_ip,
       to_regclass('public.quotation_credit_policy')                                          AS credit_policy,
       EXISTS(SELECT 1 FROM pg_constraint WHERE contype='p'
              AND conrelid=to_regclass('public.quotation_credit_policy'))                     AS credit_policy_pk,
       EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name='customers_data_view' AND column_name='last_order_at')         AS cdv_last_order,
       (pg_get_viewdef('public.customers_data_build'::regclass) LIKE '%to invoice%')          AS cdv_billed_only,
       (SELECT pg_get_constraintdef(oid) NOT LIKE '%warn%' FROM pg_constraint
         WHERE conname='quotation_credit_policy_mode')                                        AS credit_mode_2_values,
       EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name='sale_orders' AND column_name='order_status')                  AS so_status_cols,
       EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name='quotations' AND column_name='odoo_imported_at')               AS q_odoo_link;"
```
> คอลัมน์ `clean_text` ต้องใช้ **`to_regprocedure`** ไม่ใช่ `to_regproc` — `to_regproc` รับได้แค่ชื่อฟังก์ชันเปล่า
> ใส่ `(text)` ต่อท้ายจะคืน null ทุกครั้งแม้ฟังก์ชันมีอยู่จริง = สัญญาณเตือนหลอกว่า migration ขาด
รันเฉพาะไฟล์ที่ผลข้างบนบอกว่ายังไม่มี เรียงตามชื่อไฟล์ (วันที่):
```bash
for f in migrations/changes/<ไฟล์ที่ขาด>.sql ; do
  echo "== $f"
  docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1 -f - < "$f" || break
done
```
กฎ 3 ข้อของขั้นนี้:
- **ใช้ psql ไม่ใช่ `npx tsx scripts/runMigration.ts`** — pool ใน `config/db.ts` ตั้ง `statement_timeout: 15000`
  แต่สร้าง matview `customers_data_view` ใหม่ใช้เวลานานกว่านั้น (ไฟล์ migration เตือนไว้เองว่า "รันด้วย pg.Client เท่านั้น")
  และไฟล์ .sql ใหม่ยังไม่อยู่ใน image เก่าที่ยังรันอยู่ (`COPY . .` ตอน build) → exec ในกล่อง app จะหาไฟล์ไม่เจอ
- **ไฟล์ที่สร้าง matview ทับกัน ให้รันแค่ตัวล่าสุด** — เช่น `2026-08-05_02` `DROP` แล้วสร้างใหม่ทั้งก้อนอยู่แล้ว
  ไม่ต้องรัน `_01` ก่อน (รันสองรอบ = ค้นหาลูกค้าล่มนานเป็นเท่าตัวเปล่า ๆ)
- **มีช่วงที่ค้นหาลูกค้าพัง** — ระหว่างสร้าง matview ใหม่ (ราว 1–3 นาที) `customers_data_view` หายชั่วคราว → ทำนอกเวลาใช้งาน
- **ข้อยกเว้น: `2026-08-10_01_api_logs.sql` รันได้ทุกเวลา** — สร้างตารางใหม่ล้วน ไม่ ALTER ตารางเดิม ไม่แตะ matview จบในไม่กี่ ms
- **ข้อยกเว้น: `2026-08-20_04_quotation_credit_policy.sql` รันได้ทุกเวลา และรัน "ก่อน" deploy โค้ดใหม่ได้**
  สร้างตารางใหม่ + `CREATE OR REPLACE VIEW` (แก้แค่ catalog) + `ADD COLUMN` แบบ nullable ไม่มี DEFAULT
  → ไม่ rebuild `customers_data_view` ในไฟล์ ไม่มีช่วงที่ค้นหาลูกค้าพัง จบในไม่กี่ ms
  ⚠️ หลังรันแล้ว `last_order_at` จะเป็น NULL ทั้งตารางจนกว่า **รอบ sync ถัดไป** จะ rebuild ตารางจาก view
  (NULL = "ไม่เคยซื้อ" = ปล่อยผ่าน จึงไม่มีใครถูกบล็อกผิด และเกณฑ์ยังตั้งต้นเป็น `mode='off'` อยู่แล้ว)
  ถ้าอยากให้มีค่าทันทีโดยไม่รอ sync ให้ทำ build+swap มือตามขั้นตอนใน `scripts/sync/refreshCustomerDirectory.ts`
- **ข้อยกเว้น: `2026-08-21_01_quotation_credit_policy_pk.sql` รันได้ทุกเวลา**
  เติม PK ให้ตารางแถวเดียว `quotation_credit_policy` — ล็อกเสี้ยววินาที ไม่แตะ `customers_data_view`
  ล้มพร้อมข้อความภาษาคนถ้าเจอแถว id=1 ซ้ำ (ไม่ลบให้เอง — ต้องให้คนเลือกว่าจะเก็บแถวไหน)
  (`CREATE TABLE customers_data_view_new AS SELECT * FROM customers_data_build` → สร้าง index
  `(company_id) INCLUDE (last_order_at)` → ANALYZE → สลับชื่อใน transaction) — วัดจริง build 4.7 วิ สลับ 13 ms
- **ข้อยกเว้น: `2026-08-25_01_credit_hold_billed_orders_credit_customers_only.sql` รันได้ทุกเวลา และรัน "ก่อน" deploy โค้ดใหม่ได้**
  เปลี่ยนนิยาม `last_order_at`: นับเฉพาะใบที่ `invoice_status IN ('invoiced','to invoice')` และเฉพาะ
  ลูกค้าเครดิต/เช็คล่วงหน้า (นอกนั้น NULL = ผ่านด่าน) · **ไม่มีคอลัมน์ใหม่** โค้ดด่านตรวจไม่ต้องแก้
  สักบรรทัด ลำดับ migration/deploy จึงสลับกันได้อิสระ
  ไฟล์ทำ build+swap ให้ในตัว (ทั้งไฟล์อยู่ใน transaction เดียว) → ไม่มีช่วงที่ค้นหาลูกค้าพัง
  ล็อก AccessExclusive ระดับ ms ตอนสลับ ส่วน build 2–3 วิ ไม่ล็อกใคร · ล้มกลางคัน = rollback ทั้งไฟล์
  มี guard ล้มเองถ้า build ได้ 0 แถว หรือไม่มีบริษัทไหนได้ `last_order_at` เลย (เงื่อนไขเครดิตกลับด้าน)
  ⚠️ หลังรันเสร็จให้ `VACUUM (ANALYZE false) public.customers_data_view` — ตารางที่เพิ่งสร้างยังไม่มี
  visibility map ด่านตรวจจะตกจาก Index Only Scan ไปเป็น Index Scan จนกว่า autovacuum จะมาถึง
  ตรวจผล: `npm run diag:credit-hold` ต้องเขียวหมด และบรรทัด "ขอบเขต" ต้องบอกจำนวนที่เข้าเกณฑ์
  (1,656 บริษัท ณ 2026-08-25 — ถ้าได้ 10,926 แปลว่า view ยังไม่ถูก rebuild)
- **ข้อยกเว้น: `2026-08-25_02_credit_policy_drop_warn_mode.sql` รันได้ทุกเวลา และสลับลำดับกับ deploy ได้**
  ปลดโหมด `warn` (เฝ้าดู) ทิ้ง: ไล่แถวที่ค้างเป็น `warn` → `off` แล้วแคบ CHECK ให้เหลือ `off`/`block`
  ตามหน้าแอดมินที่เปลี่ยนเป็นสวิตช์ เปิด/ปิด · แตะตารางแถวเดียว ไม่ยุ่งกับ `customers_data_view` จบในไม่กี่ ms
  ⚠️ **`warn` ต้อง map เป็น `off` ไม่ใช่ `block`** — `warn` ไม่เคยบล็อกใคร ต่างจาก `off` แค่บรรทัด log
  ถ้า map เป็น `block` = เปิดกฎให้เองโดยไม่มีใครสั่ง แล้วใบเสนอราคาจะถูกบล็อกจริงทันที
  ลำดับสลับได้: โค้ดเก่ายอมรับทั้ง 3 ค่าอยู่แล้ว (แคบ CHECK ไม่ทำให้พัง) · โค้ดใหม่อ่านค่าที่ไม่รู้จักเป็น `off`
  ตรวจผล: `npm run diag:credit-hold` มีข้อ "CHECK ของ mode รับแค่ off/block" คอยจับว่ารันแล้วหรือยัง
- **ข้อยกเว้น: `2026-08-20_03_api_logs_ip.sql` รันได้ทุกเวลา และรัน "ก่อน" deploy โค้ดใหม่ได้**
  `ADD COLUMN` แบบ nullable ไม่มี DEFAULT = PostgreSQL แก้แค่ metadata ไม่ล็อกตาราง ไม่เขียนแถวใหม่
  และโค้ดเก่าที่ยังรันอยู่ระบุชื่อคอลัมน์ใน INSERT ครบทุกตัว จึงเขียน log ต่อได้ตามปกติ (คอลัมน์ใหม่เป็น NULL)
- **ข้อยกเว้น: `2026-09-02_02_sale_orders_status_source.sql` รันได้ทุกเวลา และรัน "ก่อน" deploy โค้ดใหม่ได้**
  เก็บ 3 field ที่ gateway ส่งมาแล้ว sync ทิ้ง (`order_status` / `invoice_date` / `source`)
  `ADD COLUMN` nullable ไม่มี DEFAULT → แก้แค่ metadata ไม่ล็อกตาราง 316k แถว
  โค้ดเก่าไม่รู้จักคอลัมน์ใหม่ก็ไม่พัง (upsert ระบุชื่อคอลัมน์ครบทุกตัว)
  ⚠️ แถวเก่าเป็น NULL หมดจนกว่า Odoo จะแก้เอกสารนั้นแล้ว incremental sync ดึงมาทับ
  ถ้าอยากได้ครบทันทีต้อง `docker compose exec app npm run sync:saleorders -- --full` (กวาดทั้งฐาน ทำนอกเวลา)
- **ข้อยกเว้น: `2026-09-02_03_quotations_odoo_import_link.sql` รันได้ทุกเวลา และรัน "ก่อน" deploy โค้ดใหม่ได้**
  เพิ่ม `quotations.odoo_imported_at` / `odoo_so_id` = สถานะ "นำเข้า Odoo แล้ว" ของหน้าประวัติใบเสนอราคา
  `ADD COLUMN` nullable ไม่มี DEFAULT บนตาราง ~1.3k แถว จบในไม่กี่ ms
  สลับลำดับกับ deploy ได้: โค้ดใหม่ที่เจอว่ายังไม่มีคอลัมน์จะเตือนบรรทัดเดียวแล้วข้าม ไม่ล้มรอบ sync
  ⚠️ ค่ายังว่างทั้งตารางจนกว่า **รอบ sync ถัดไป** จะมาร์กให้ (มาร์กย้อนหลังให้เองในคำสั่งเดียว ไม่ต้อง backfill)
  ตรวจผล: หน้าประวัติใบเสนอราคาต้องมีป้าย "นำเข้า Odoo แล้ว" ไม่ใช่ "รอนำเข้า" ทั้งหน้า

### ขั้น 4.5 — เปลี่ยนชื่อค่าภาษีใน `.env` (ครั้งเดียว ตอนขึ้น export แยก QP/QT)
export แยกไฟล์ตามบริษัทแล้ว ชื่อภาษีจึงแยกเป็น 2 คีย์ — คีย์เดิม `ODOO_EXPORT_TAX` ไม่ถูกอ่านอีกต่อไป
```bash
grep -n ODOO_EXPORT_TAX .env      # มีคีย์เดิมอยู่ไหม
```
ถ้ามี ให้แก้เป็น 2 บรรทัดนี้แทน (ค่าตรงกับที่ Odoo แต่ละระบบตั้งชื่อไว้):
```
ODOO_EXPORT_TAX_QP="Output VAT 7% (Exc)"
ODOO_EXPORT_TAX_QT="Output VAT 7%(Exc)"
```
- ⚠️ QT **ไม่มีเว้นวรรค** หน้าวงเล็บ ส่วน QP มี — ต่างกันจริง ห้ามแก้ให้เหมือนกัน
- ไม่แก้ก็ไม่พัง โค้ดมีค่าตั้งต้นสองตัวนี้อยู่แล้ว แต่คีย์เดิมที่ค้างใน `.env` จะกลายเป็นค่าที่ไม่มีใครอ่าน

### ขั้น 4.6 — ตั้งค่า API log (ครั้งเดียว ตอนขึ้นตาราง `api_logs`)
```
API_LOG_ENABLED=false        # ⚠️ ขึ้นครั้งแรกให้ตั้ง false ก่อน
API_LOG_RETENTION_DAYS=30
```
- **ขึ้นครั้งแรกให้ปิดไว้ก่อน** แล้วทำขั้น 5-6 ให้ผ่าน = พิสูจน์ว่าโค้ดใหม่ขึ้นแล้วระบบเหมือนเดิมทุกอย่าง
  จากนั้นค่อยแก้ `.env` เป็น `true` แล้ว **ไม่ต้อง build ใหม่** แค่สร้างคอนเทนเนอร์ใหม่:
  ```bash
  docker compose up -d --force-recreate app
  ```
  ⚠️ **ห้ามใช้ `docker compose restart app`** — compose ผูกค่า env เข้ากับคอนเทนเนอร์ตอน *สร้าง*
  ไม่ใช่ตอนสตาร์ท `restart` จึงรันด้วยค่าเดิมทั้งที่แก้ `.env` ไปแล้ว (ดูเหมือนสำเร็จแต่ไม่มีอะไรเปลี่ยน)
  เช็คได้ด้วย `docker compose exec app sh -c 'echo $API_LOG_ENABLED'`
  แยกตัวแปรสองอย่าง (โค้ดใหม่ / การเก็บ log) คนละครั้ง ถ้ามีอะไรผิดจะรู้ทันทีว่าเกิดจากอะไร
  ถ้าเปิดแล้วมีปัญหา กลับเป็น `false` + `up -d --force-recreate app` = ระบบกลับไปเหมือนเดิมภายใน 10 วินาที
- ไม่ตั้งทั้งสองคีย์ก็รันได้ โค้ดมีค่าตั้งต้น (เปิด, 30 วัน)
- **เช็คขนาดตารางหลังเปิดใช้จริง ~14 วัน** แล้วคูณ ~2 เพื่อประมาณค่าที่ 30 วัน:
  ```bash
  docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
  SELECT pg_size_pretty(pg_total_relation_size('public.api_logs')) AS size,
         count(*) AS rows, min(created_at) AS oldest FROM public.api_logs;"
  ```
  เกินคาดเมื่อไหร่ให้ลด `API_LOG_RETENTION_DAYS` แล้ว restart — ตัวลบจะเก็บกวาดให้เองในรอบถัดไป
- ⚠️ **ตารางนี้มีข้อมูลส่วนบุคคลตั้งแต่ `2026-08-20_03_api_logs_ip.sql` เป็นต้นไป**
  ยังไม่เก็บ request body จึงไม่มีชื่อ/เบอร์ลูกค้าและไม่มีข้อความแชทเหมือนเดิม **แต่คอลัมน์ `ip`
  ที่วางอยู่แถวเดียวกับ `line_user_id` ทำให้ระบุตัวบุคคลได้** → ก่อนส่ง dump ให้คนนอกต้องตัดคอลัมน์นี้
  ออกก่อน หรือ dump โดยไม่เอาตารางนี้ไปเลย:
  ```bash
  docker compose exec -T db pg_dump -U "$PG_USER" -d "$PG_DATABASE" -Fc \
    --exclude-table-data=public.api_logs > dump-ไม่มี-api-logs.dump
  ```
  ตัวช่วยที่มีอยู่แล้วคือ retention 30 วันซึ่งลบให้อัตโนมัติทุกชั่วโมง — ข้อมูลไม่ค้างยาว

### ขั้น 4.7 — จูน PostgreSQL ให้ตรงสเปกเครื่อง (ครั้งเดียวต่อ server)

⚠️ **ค่าเหล่านี้ไม่ได้อยู่ในโค้ด** — เก็บอยู่ใน `postgresql.auto.conf` ข้างใน volume `pgdata`
ถ้าย้ายเครื่องหรือสร้าง volume ใหม่ ต้องตั้งใหม่ ไม่งั้น Postgres จะกลับไปใช้ค่า default
ซึ่งคิดว่าตัวเองอยู่บนเครื่องเล็กและดิสก์เป็นจานหมุน

ตั้งครั้งแรก 2026-09-02 บน server 8 core / 32 GB (แชร์กับ `appsale-mongo-prod` ที่กิน ~5 GB):

```bash
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" \
 -c "ALTER SYSTEM SET work_mem = '32MB'" \
 -c "ALTER SYSTEM SET maintenance_work_mem = '512MB'" \
 -c "ALTER SYSTEM SET effective_cache_size = '12GB'" \
 -c "ALTER SYSTEM SET random_page_cost = 1.1" \
 -c "ALTER SYSTEM SET max_parallel_workers_per_gather = 4" \
 -c "ALTER SYSTEM SET track_io_timing = on" \
 -c "SELECT pg_reload_conf()"
```

- **ไม่ต้อง restart ไม่มี downtime** — ทั้งหกค่าเป็น reload-only `pg_reload_conf()` พอ
- เหตุผลของแต่ละค่า (วัดจาก `pg_stat_database` ตอนตั้ง):
  - `work_mem` 4MB → 32MB — query spill ลงดิสก์ไปแล้ว **temp_files 6,299 / temp_bytes 24 GB**
  - `maintenance_work_mem` 64MB → 512MB — เร่ง `CREATE INDEX` / `ANALYZE` ตอน rebuild `customers_data_view`
  - `effective_cache_size` 4GB → 12GB — เครื่องมี buff/cache จริง ~15 GB
  - `random_page_cost` 4 → 1.1 — เครื่องเป็น SSD และ DB ทั้งก้อนแค่ ~626 MB อยู่ใน OS cache ครบ
  - `max_parallel_workers_per_gather` 2 → 4 — มี 8 core (`max_parallel_workers` default = 8 อยู่แล้ว)
  - `track_io_timing` off → on — จำเป็นสำหรับแยก "อ่านนอก shared_buffers" ออกจาก "รอดิสก์จริง"
    ต้นทุนแทบเป็นศูนย์บนเครื่องที่มี clocksource เร็ว (เช็คด้วย `pg_test_timing`)
- **ตรวจว่าขึ้นจริง** — ต้องได้ `source = configuration file` และ `pending_restart = f` ทุกแถว:
  ```bash
  docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
  SELECT name, setting, unit, source, pending_restart FROM pg_settings
  WHERE name IN ('work_mem','maintenance_work_mem','effective_cache_size','random_page_cost',
                 'max_parallel_workers_per_gather','track_io_timing') ORDER BY name;"
  ```
- **ย้อนกลับได้ทันทีถ้ามีปัญหา** (ทีละค่าหรือทั้งหมด) แล้ว reload:
  ```bash
  docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" \
    -c "ALTER SYSTEM RESET random_page_cost" -c "SELECT pg_reload_conf()"
  ```
- ⚠️ **`shared_buffers` ยังคงไว้ที่ 128MB โดยตั้งใจ** — วัดแล้วไม่ใช่คอขวด: ตอน rebuild
  `customers_data_view` มี `Buffers: shared read=85074` (~665 MB) แต่ `I/O Timings: shared read=25.9 ms`
  จาก ~5,000 ms ทั้ง query ⇒ OS page cache รับไปหมดแล้ว ต้นทุนจริงเป็น CPU ล้วน
  (และ `shared_buffers` ต้อง restart ถึงจะมีผล จึงไม่คุ้มเสี่ยงโดยไม่มีหลักฐานว่าช่วย)
- ⚠️ **`work_mem` เป็นค่าต่อ sort/hash node ไม่ใช่ต่อ connection** — query ที่ซับซ้อนใช้ได้หลายก้อน
  pool ในแอปตั้ง max 40 (`config/db.ts`) ⇒ กรณีสุดโต่งประมาณ 1.3 GB ซึ่งเครื่องนี้รับไหว
  แต่ถ้าวันหน้าขยาย pool หรือเพิ่มบริการอื่นบนเครื่องเดียวกัน ต้องคิดเพดานนี้ใหม่

### ขั้น 4.8 — สร้าง expression index ของ `products` (ครั้งเดียวต่อ DB)

`findProduct()` ค้นบน "ค่าที่ normalize แล้ว" ไม่ใช่คอลัมน์ดิบ ⇒ index เดิมบน `model`/`name`
ใช้ไม่ได้เลย ทุก stage ตกไป Seq Scan บน 51,456 แถวทุกครั้งที่มีคนพิมพ์รหัสสินค้าเข้ามา

```bash
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1 \
  -f - < migrations/changes/2026-09-02_04_products_expression_indexes.sql
```

- ⚠️ **ต้องรันผ่าน `psql` เท่านั้น ห้ามผ่าน `scripts/runMigration.ts`** — `CREATE INDEX CONCURRENTLY`
  อยู่ใน transaction ไม่ได้
- ใช้เวลา ~6 วินาที ไม่ล็อกตาราง เพิ่มขนาด `products` จาก 47 → 62 MB
- **ต้องขึ้นคู่กับโค้ด** — [`services/productService.ts`](services/productService.ts) stage 2 เติมด่าน
  `%` เข้าไปเพื่อให้ใช้ GIN index ได้ ถ้าขึ้นโค้ดโดยไม่มี index จะ**ช้ากว่าเดิม** (Seq Scan เดิม
  บวกการคำนวณ similarity อีกชุดจาก `%`) ส่วนการมี index โดยยังไม่ขึ้นโค้ดนั้นปลอดภัย
  (stage 1/1.3/1.5/1.7 ได้ประโยชน์ทันที มีแต่ stage 2 ที่ต้องรอโค้ด)
- ⚠️ **ห้ามถอด `SET LOCAL pg_trgm.similarity_threshold = 0.25` ใน `fuzzySearch()` ออก** —
  operator `%` เทียบกับค่านี้ ซึ่ง default = 0.3 คือ "เข้มกว่า" เกณฑ์ `> 0.25` ของโค้ด
  ถ้าไม่ตั้ง แถวที่ similarity อยู่ใน [0.25, 0.3) จะหายไปเงียบ ๆ โดยไม่มี error ให้เห็น
  (เลือกตั้งในโค้ดแทน `ALTER DATABASE` เพราะค่าที่ผูกกับ DB จะหายไปตอนสร้าง DB ใหม่จาก schema.sql)
- วัดจริงบน prod (`EXPLAIN ANALYZE`, ตารางเดียวกัน):

  | stage | ก่อน | หลัง |
  |---|---|---|
  | 1 — exact (`norm = $1`) | 348.6 ms · Seq Scan 1,833 buffers | **0.081 ms** · BitmapOr 7 buffers |
  | 1.5 — numeric (`LIKE '%220%'`) | 441.9 ms · Seq Scan | **46.1 ms** · Bitmap Index Scan |
  | 2 — fuzzy (`similarity > 0.25`) | 1,080.0 ms · Seq Scan | **195.4 ms** · Bitmap Index Scan |

- ตรวจว่าใช้ได้จริง (ต้องได้ 4 แถว `indisvalid = t`):
  ```bash
  docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
  SELECT indexrelid::regclass AS idx, indisvalid, pg_size_pretty(pg_relation_size(indexrelid))
  FROM pg_index WHERE indrelid = 'public.products'::regclass
    AND indexrelid::regclass::text LIKE '%_norm%' ORDER BY 1;"
  ```
- ย้อนกลับ: `DROP INDEX CONCURRENTLY IF EXISTS <ชื่อ>;` (ต้อง revert โค้ด stage 2 ด้วย ไม่งั้นช้ากว่าเดิม)

### ขั้น 4.9 — เปิด API ให้ระบบภายนอกดึงข้อมูลไป sync (ครั้งเดียวต่อ DB)

เปิด `/api/sync/v1/*` ให้เครื่องภายนอก (ตัวแรกคือ **NUC-Kay** `192.168.109.69` ที่เก็บลง MongoDB)
ดึงข้อมูลออกไปเองผ่าน **HTTPS สาธารณะ** ไม่ต้องต่อ LAN ไม่ต้องเปิดพอร์ตเพิ่มทั้งสองฝั่ง
(ยืนยันแล้วว่า LAN ใช้ไม่ได้: เซิร์ฟเวอร์อยู่ `192.168.100.17/24` NUC อยู่คนละ subnet และ TCP ยิงไม่ถึง)

```bash
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -v ON_ERROR_STOP=1 \
  -f - < migrations/changes/2026-09-02_05_sync_api.sql
```

- ⚠️ **ต้องรันผ่าน `psql` เท่านั้น ห้ามผ่าน `scripts/runMigration.ts`** — `CREATE INDEX CONCURRENTLY`
  อยู่ใน transaction ไม่ได้
- สร้างตาราง `sync_api_keys` + index `(updated_at, pk)` ของ 4 ตารางโหมด incremental
  (`sale_orders` `customers` `products` `quotations`) เพิ่มพื้นที่รวม ~30 MB
- **CONCURRENTLY จะ "รอ" ทุก transaction ที่เปิดค้างอยู่ก่อนหน้าให้จบก่อน** — ถ้ารอบ refresh
  `customers_data_view` กำลังวิ่ง (กินหลายนาที) คำสั่งนี้จะค้างรอจนกว่ามันจบ ซึ่งเป็นพฤติกรรมปกติ
  ไม่ใช่อาการแฮงก์ · ห้ามกด Ctrl-C ทิ้งกลางคัน จะเหลือ index ที่ `indisvalid = false` ค้างไว้
- ตรวจว่าครบและใช้ได้จริง:
  ```bash
  docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
  SELECT indexrelid::regclass AS idx, indisvalid FROM pg_index
   WHERE indexrelid::regclass::text LIKE '%sync_cursor%' ORDER BY 1;"
  ```
  ต้องได้ 4 แถวและ `indisvalid` เป็น `t` ทั้งหมด · ถ้าเจอ `f` ให้ `DROP INDEX CONCURRENTLY <ชื่อ>;` แล้วรันใหม่
- รันได้ทุกเวลา — สร้างของใหม่ล้วน ไม่ ALTER ตารางเดิม ไม่ rebuild matview ไม่ล็อกการเขียน

**หลัง rebuild (ขั้น 5) แล้วค่อยออกกุญแจให้เครื่องปลายทาง:**

```bash
docker compose exec app npm run sync:key -- --name "NUC-Kay"   # กุญแจแสดงครั้งเดียว
docker compose exec app npm run sync:key -- --list             # ดูว่ามีกุญแจอะไรอยู่ ใช้ล่าสุดเมื่อไหร่
docker compose exec app npm run sync:key -- --revoke 1         # เพิกถอน มีผลทันทีในครั้งถัดไป
docker compose exec app npm run diag:sync-api                  # ต้องเขียวหมด (อ่านอย่างเดียว)
```

- กุญแจใช้ได้อย่างเดียวคือ **อ่านผ่าน `/api/sync/v1/*`** ไม่ใช่สิทธิ์แอดมิน และเพิกถอนได้รายตัว
- ตารางไหนเปิดให้ดึงบ้างอยู่ใน `TABLE_REGISTRY` ที่ [`services/externalSync.ts`](services/externalSync.ts)
  **ตารางที่ไม่อยู่ในทะเบียนตอบ 404 เสมอ** — ตารางใหม่จาก migration จึงไม่หลุดออกไปเองโดยไม่มีคนตัดสินใจ
  (`npm run diag:sync-api` มีข้อคอยเตือนว่ามีตารางตกทะเบียน)
- คอลัมน์ที่ตัดไม่ให้ออกไปเด็ดขาด: `admin_users.password_hash` และ `messages.reply_token`
- สคริปต์ฝั่งเครื่องปลายทางอยู่ที่ [`integrations/nuc-sync-client/`](integrations/nuc-sync-client/) พร้อม README
- **คู่มือใช้งาน API ฉบับเต็ม** (endpoint, พารามิเตอร์, วิธีดึงที่ถูกต้อง, รหัสข้อผิดพลาด): [`docs/SYNC_API.md`](docs/SYNC_API.md)

### ขั้น 5 — rebuild + up
```bash
docker compose up -d --build          # สร้างกล่องใหม่จากโค้ดล่าสุด แล้วสลับให้อัตโนมัติ
docker compose ps                     # db ต้อง healthy, app ต้อง running
docker compose logs -f app            # เห็น listening on 3011 = สำเร็จ
curl -I http://127.0.0.1:${APP_PORT:-3011}/
docker image prune -f --filter "until=24h"   # ⚠️ ทำทุกครั้งหลัง build — ไม่งั้น image เก่าสะสมจนดิสก์ตัน
```
- **`docker image prune` ต่อท้ายทุก build ห้ามข้าม** — แต่ละ build ทิ้ง image เก่าไว้ 1 ตัว วันละ ~20 ตัว
  ประมาณ 2 เดือนดิสก์เต็ม · `--filter "until=24h"` กันไม่ให้ลบ image ที่เพิ่ง build (เผื่อต้อง rollback)
- ข้อมูลใน database **ไม่หาย** (อยู่ใน volume `pgdata`) และรูปลายเซ็นก็ไม่หาย (volume `sig_*`)
- แก้เฉพาะหน้า admin (frontend) ก็ต้อง `--build` เหมือนกัน
- ถ้า `docker-compose.yml` เปลี่ยนในช่วงที่ค้าง **กล่อง db จะถูก recreate ด้วย ไม่ใช่แค่ app** → เช็คขั้น 3 ให้ผ่านก่อนเสมอ

### ขั้น 6 — ตรวจหลังขึ้น
รัน diag ที่ **อ่านอย่างเดียว** ได้บน prod:
```bash
docker compose exec app npx tsx scripts/diag/odooExportSmoke.ts --company qp
docker compose exec app npx tsx scripts/diag/odooExportSmoke.ts --company qt
docker compose exec app npx tsx scripts/diag/dateFilterSmoke.ts
docker compose exec app npx tsx scripts/diag/quoteValidationSmoke.ts
docker compose exec app npx tsx scripts/diag/apiLogSmoke.ts
docker compose exec app npx tsx scripts/diag/pdfCacheSmoke.ts
docker compose exec app npx tsx scripts/diag/appUrlSmoke.ts
```
> ❌ ห้ามรันบน prod: `diag:export-tracking`, `diag:shipping-fee`, `diag:confirm-race` — สามตัวนี้เขียนข้อมูลทดสอบลง DB

---

## ให้ Claude บน server ทำแทน

สั่งแบบนี้ (ต้องให้ `git pull` มาก่อน ไม่งั้นมันอ่าน DEPLOY.md ฉบับเก่า):
```
cd /home/app_sales/salechatbot
git pull --ff-only origin main แล้วอัปเดต deployment ตาม DEPLOY.md
หัวข้อ "อัปเดต server ที่ deploy ไปแล้ว" ทำตามลำดับในนั้นเป๊ะ ๆ ห้ามข้ามขั้น
ห้ามแก้ไฟล์ใน migrations/ และห้ามคิดคำสั่ง migration เอง
ก่อนขั้นที่ทำให้ระบบใช้งานไม่ได้ (สร้าง matview ใหม่, recreate กล่อง db) ให้หยุดถามก่อน
```
ข้อห้ามถาวรบน server: ห้าม `docker compose down -v` (ลบ volume = ข้อมูลหายจริง),
ห้ามแก้ไฟล์ใน `migrations/changes/` ที่รันไปแล้ว (เขียนไฟล์ใหม่แทน), ห้ามรัน migration โดยไม่ dump ก่อน

---

## คำสั่งที่ใช้บ่อย (cheat sheet)
```bash
docker compose ps                 # ดูสถานะกล่อง
docker compose logs -f app        # ดู log แอป (เรียลไทม์)
docker compose logs -f db         # ดู log database
docker compose restart app        # รีสตาร์ทแอป (ไม่ rebuild)
docker compose down               # หยุดทุกกล่อง (ข้อมูลใน volume ยังอยู่)
docker compose up -d              # เปิดใหม่
```

---

## ตั้ง / กู้รหัสผ่านผู้ใช้ Admin Portal ด้วย SQL

ปกติจัดการผู้ใช้ผ่านหน้าเว็บ (เมนู **จัดการผู้ใช้งานระบบ** — เห็นเฉพาะสิทธิ์ผู้ดูแลระบบ) และเปลี่ยนรหัสผ่านตัวเองด้วยปุ่มรูปกุญแจข้างปุ่มออกจากระบบ
ใช้วิธีด้านล่างเมื่อ **เข้าหน้าเว็บไม่ได้แล้ว** เท่านั้น เช่น ลืมรหัสผ่านผู้ดูแลระบบ หรือตั้ง DB ใหม่จนยังไม่มีผู้ใช้สักคน

> **พิมพ์รหัสผ่านลงคอลัมน์ `password_hash` ตรง ๆ ไม่ได้** — ระบบเทียบด้วย bcrypt ใส่ค่าดิบไปจะล็อกอินไม่ผ่านตลอด
> ต้องให้ `crypt()` ของ pgcrypto แปลงให้ (extension ติดตั้งมากับ `migrations/schema.sql` แล้ว)

```bash
set -a; source .env; set +a

# เปลี่ยนรหัสผ่านของผู้ใช้ที่มีอยู่
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
UPDATE admin_users
SET password_hash = crypt('รหัสใหม่ที่ต้องการ', gen_salt('bf', 10)),
    updated_at = CURRENT_TIMESTAMP
WHERE username = 'admin';"

# สร้างผู้ดูแลระบบคนแรก (ใช้ตอนตาราง admin_users ยังว่าง)
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
INSERT INTO admin_users (username, password_hash, name, role)
VALUES ('admin', crypt('รหัสใหม่ที่ต้องการ', gen_salt('bf', 10)), 'ผู้ดูแลระบบ', 'admin');"

# ดูรายชื่อผู้ใช้และสิทธิ์ (ไม่ดึง hash ออกมา)
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
SELECT id, username, name, role FROM admin_users ORDER BY id;"
```

`role` มีได้แค่ `admin` (จัดการได้ทุกอย่าง) กับ `user` (สิทธิ์จำกัด) — ใส่ค่าอื่น DB จะปฏิเสธ
รหัสผ่านโผล่เป็นข้อความธรรมดาในคำสั่งที่พิมพ์ ทำเสร็จแล้วอย่าเก็บไฟล์ที่มีคำสั่งนี้ไว้ และล้าง history ของ shell ถ้าจำเป็น

---

## แก้ปัญหาเบื้องต้น
- **PDF ภาษาไทย** → template ใช้ฟอนต์ **Sarabun จาก Google Fonts** (ต้องมีเน็ต ซึ่ง server ต่อได้อยู่แล้ว) ถ้าเน็ตบล็อก จะ fallback ไปฟอนต์ไทยที่ติดตั้งใน image (`fonts-thai-tlwg`) — ยังอ่านออกไม่เป็นกล่อง ทดสอบจริงได้หลัง restore DB โดยสร้าง PDF (`/download-pdf/...`)
  - ทดสอบแล้วบนเครื่อง dev: Chromium 150 + ฟอนต์ไทย 13 ตระกูลติดตั้งครบในกล่อง ✓
- **app ต่อ db ไม่ได้ / ECONNREFUSED** → เช็คว่า `.env` ตั้ง `PG_HOST=db` (ไม่ใช่ localhost) และ db ขึ้น `healthy` แล้ว (`docker compose ps`)
- **พอร์ตชนโปรเจคอื่น** → เปลี่ยน `APP_PORT` ใน `.env` เป็นเลขอื่น แล้ว `docker compose up -d`
- **restore แล้ว error เรื่อง role/owner** → มี `--no-owner` อยู่แล้ว ถ้ายัง error ส่ง log มาให้ดู
