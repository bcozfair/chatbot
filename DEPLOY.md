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
```

### 2.5 เช็คว่าแอปตอบ (บน server)
```bash
curl -I http://127.0.0.1:${APP_PORT:-3011}/        # ควรได้ HTTP 200
```

---

## ส่วนที่ 3 — แจ้ง IT
บอก IT: **subdomain ที่ต้องการ** (เช่น `bot.company.com`) + **พอร์ต** ที่ตั้งใน `APP_PORT` (ผูกไว้ที่ `127.0.0.1`)
IT จะตั้ง reverse proxy + HTTPS ให้ชี้ subdomain → พอร์ตนั้น

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
SELECT to_regclass('public.customers_data_view') AS matview,
       to_regproc('public.clean_text(text)')     AS clean_text,
       EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.customers_data_view')
              AND attname='sales_team' AND NOT attisdropped)                                  AS sales_team,
       EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name='salesperson' AND column_name='employee_quotation_id')         AS employee_qid,
       EXISTS(SELECT 1 FROM information_schema.columns
              WHERE table_name='quotations' AND column_name='odoo_exported_at')               AS exported_at,
       to_regclass('public.quotation_export_batches')                                         AS export_batches,
       to_regclass('public.api_logs')                                                         AS api_logs;"
```
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
  จากนั้นค่อยแก้เป็น `true` แล้ว `docker compose restart app` — **ไม่ต้อง build ใหม่**
  แยกตัวแปรสองอย่าง (โค้ดใหม่ / การเก็บ log) คนละครั้ง ถ้ามีอะไรผิดจะรู้ทันทีว่าเกิดจากอะไร
  ถ้าเปิดแล้วมีปัญหา กลับเป็น `false` + restart = ระบบกลับไปเหมือนเดิมทุกประการภายใน 10 วินาที
- ไม่ตั้งทั้งสองคีย์ก็รันได้ โค้ดมีค่าตั้งต้น (เปิด, 30 วัน)
- **เช็คขนาดตารางหลังเปิดใช้จริง ~14 วัน** แล้วคูณ ~2 เพื่อประมาณค่าที่ 30 วัน:
  ```bash
  docker compose exec -T db psql -U "$PG_USER" -d "$PG_DATABASE" -c "
  SELECT pg_size_pretty(pg_total_relation_size('public.api_logs')) AS size,
         count(*) AS rows, min(created_at) AS oldest FROM public.api_logs;"
  ```
  เกินคาดเมื่อไหร่ให้ลด `API_LOG_RETENTION_DAYS` แล้ว restart — ตัวลบจะเก็บกวาดให้เองในรอบถัดไป
- ตารางนี้ **ไม่มี PII** (เก็บแค่ user id, path, status, เวลา — ไม่เก็บ request body ไม่มีชื่อ/เบอร์ลูกค้า
  ไม่มีข้อความแชท) จึงไม่เพิ่มข้อจำกัดเรื่องการส่งไฟล์ dump

### ขั้น 5 — rebuild + up
```bash
docker compose up -d --build          # สร้างกล่องใหม่จากโค้ดล่าสุด แล้วสลับให้อัตโนมัติ
docker compose ps                     # db ต้อง healthy, app ต้อง running
docker compose logs -f app            # เห็น listening on 3011 = สำเร็จ
curl -I http://127.0.0.1:${APP_PORT:-3011}/
```
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
