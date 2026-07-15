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
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -h localhost -p 5432 -U postgres -d chatbot_primus -Fc -f "$HOME\chatbot_primus.dump"
```
> ถ้า PostgreSQL ไม่ใช่เวอร์ชัน 16 ให้เปลี่ยนเลขใน path (เช่น `15\bin`) — เช็คด้วย `psql --version`

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

## แก้โค้ดหลัง deploy ต้องทำยังไง
โค้ดถูกห่อเข้า image ตอน build → **แก้ไฟล์เฉย ๆ กล่องยังไม่เปลี่ยน ต้อง rebuild ทุกครั้ง**
```bash
# บนเครื่องตัวเอง: แก้โค้ด → git push
# บน server:
cd /home/app_sales/salechatbot
git pull origin main
docker compose up -d --build          # สร้างกล่องใหม่จากโค้ดล่าสุด แล้วสลับให้อัตโนมัติ
```
- ข้อมูลใน database **ไม่หาย** (อยู่ใน volume `pgdata`) และรูปลายเซ็นก็ไม่หาย (volume `sig_*`)
- แก้เฉพาะหน้า admin (frontend) ก็ต้อง `--build` เหมือนกัน

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

## แก้ปัญหาเบื้องต้น
- **PDF ภาษาไทย** → template ใช้ฟอนต์ **Sarabun จาก Google Fonts** (ต้องมีเน็ต ซึ่ง server ต่อได้อยู่แล้ว) ถ้าเน็ตบล็อก จะ fallback ไปฟอนต์ไทยที่ติดตั้งใน image (`fonts-thai-tlwg`) — ยังอ่านออกไม่เป็นกล่อง ทดสอบจริงได้หลัง restore DB โดยสร้าง PDF (`/download-pdf/...`)
  - ทดสอบแล้วบนเครื่อง dev: Chromium 150 + ฟอนต์ไทย 13 ตระกูลติดตั้งครบในกล่อง ✓
- **app ต่อ db ไม่ได้ / ECONNREFUSED** → เช็คว่า `.env` ตั้ง `PG_HOST=db` (ไม่ใช่ localhost) และ db ขึ้น `healthy` แล้ว (`docker compose ps`)
- **พอร์ตชนโปรเจคอื่น** → เปลี่ยน `APP_PORT` ใน `.env` เป็นเลขอื่น แล้ว `docker compose up -d`
- **restore แล้ว error เรื่อง role/owner** → มี `--no-owner` อยู่แล้ว ถ้ายัง error ส่ง log มาให้ดู
