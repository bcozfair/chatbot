# logworker — ตัวเก็บ log ที่รันบน host

โปรเซสแยกที่ทำงานเบื้องหลัง 4 อย่างของแผน [`docs/plan-logging-audit-compliance.md`](../../docs/plan-logging-audit-compliance.md)

| งาน | ทำอะไร | ความถี่ |
| --- | --- | --- |
| `system_log:<container>` | อ่าน `docker logs` → ตาราง `system_logs` | ต่อเนื่อง (`--follow`) |
| `audit_actor` | เติมชื่อผู้แก้ไขให้แถว `audit_logs` ที่ยัง `pending` | ทุก 1 นาที |
| `traffic_daily` | สรุป traffic ของเมื่อวาน + วันนี้ | ทุก 15 นาที |
| `log_retention` | ลบ `system_logs` / `audit_logs` ที่เกินอายุ | ทุก 1 ชั่วโมง |

## สัญญาข้อเดียวที่สำคัญที่สุด

> **หยุด logworker เมื่อไหร่ ระบบหลักต้องทำงานปกติทุกอย่าง**

ไม่มีโค้ดในแอปที่เรียกอะไรจาก worker · ไม่แชร์ connection pool กับแอป · ไม่ถือ lock ที่แอปต้องใช้
พิสูจน์ได้ตรง ๆ ด้วย `sudo systemctl stop logworker` แล้วใช้งานระบบตามปกติ

## ทำไมรันบน host ไม่ใช่ในคอนเทนเนอร์

ถ้าอยู่ในคอนเทนเนอร์ต้อง mount `/var/run/docker.sock` เข้าไป ซึ่งเท่ากับให้สิทธิ์เทียบเท่า root
ของทั้งเครื่องกับโปรเซสนั้น — แลกไม่คุ้มกับการเก็บ log

## ทำไมมี `package.json` แยก

แอปมี dependency หนัก (puppeteer + chromium รวมหลายร้อย MB) ซึ่ง worker ไม่ได้ใช้เลย
โฟลเดอร์นี้ติดตั้งแค่ `pg` + `dotenv` + `tsx` ≈ **13 MB**

Node หา package จาก "ที่อยู่ของไฟล์ที่ import" ไม่ใช่ CWD ⇒ ต้อง symlink เข้าไปใน `scripts/logworker/`
(คำสั่งอยู่ในขั้นตอนติดตั้งด้านล่าง) · ทั้ง `deploy/` และ `**/node_modules` ถูกกันไว้ใน `.dockerignore` แล้ว
จึงไม่หลุดเข้า image ของแอป

## ติดตั้ง (ครั้งเดียวต่อ server)

```bash
# 0) ต้องรัน migration ทั้ง 3 ไฟล์ก่อน ไม่งั้น worker จะปฏิเสธการสตาร์ทพร้อมบอกว่าขาดตารางอะไร
cd /home/app_sales/salechatbot/chatbot
docker compose exec app npx tsx scripts/runMigration.ts migrations/changes/2026-09-03_03_system_logs.sql
docker compose exec app npx tsx scripts/runMigration.ts migrations/changes/2026-09-03_04_audit_logs.sql
docker compose exec app npx tsx scripts/runMigration.ts migrations/changes/2026-09-03_05_traffic_daily.sql

# 1) dependency ขั้นต่ำ + symlink
cd deploy/logworker
npm ci
ln -sfn ../../deploy/logworker/node_modules ../../scripts/logworker/node_modules

# 2) ลองรันด้วยมือก่อน 1 นาที ดูว่าอ่าน log ได้และเขียน DB ได้
node --import tsx ../../scripts/logworker/index.ts
#    ควรเห็น: "เริ่มอ่าน docker logs ของ ... " แล้วตามด้วย "พร้อมทำงาน"
#    Ctrl-C เพื่อหยุด (จะเห็น "ปิดเรียบร้อย")

# 3) ติดตั้งเป็น service
sudo cp logworker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now logworker
systemctl status logworker
```

⚠️ ก่อน `cp` ให้เปิด `logworker.service` แล้วแก้ `User` / `WorkingDirectory` / `ExecStart`
ให้ตรงกับ path จริงของเครื่องนั้น

## เงื่อนไขที่ต้องมีบนเครื่อง

| อะไร | ตรวจด้วย | หมายเหตุ |
| --- | --- | --- |
| Node 20+ บน host | `node -v` | ยืนยันแล้วว่ามี v22 |
| เรียก `docker logs` ได้โดยไม่ต้อง sudo | `docker logs --tail 1 primus-chatbot-app-1` | ผู้ใช้ต้องอยู่ในกลุ่ม `docker` |
| ต่อ DB จาก host ได้ | `nc -z 127.0.0.1 5432` | ต้องมี `docker-compose.override.yml` ที่ publish พอร์ต 5432 ออก host |

ถ้าเครื่องไหนไม่ publish พอร์ต DB ออก host ให้เพิ่มใน `docker-compose.override.yml` ของเครื่องนั้น:

```yaml
services:
  db:
    ports:
      - "127.0.0.1:5432:5432"
```

## ค่าตั้ง (อ่านจาก `.env` ของโปรเจกต์)

| คีย์ | ค่าตั้งต้น | ความหมาย |
| --- | --- | --- |
| `SYSTEM_LOG_DB_LEVEL` | `warn` | ระดับต่ำสุดที่เขียนลง DB · ต่ำกว่านี้ยังอยู่ใน `docker logs` ตามเดิม |
| `SYSTEM_LOG_CONTAINERS` | `primus-chatbot-app-1` | คอนเทนเนอร์ที่อ่าน (คั่นด้วย comma) |
| `SYSTEM_LOG_RETENTION_DAYS` | `90` | อายุของ warn ขึ้นไป |
| `SYSTEM_LOG_INFO_RETENTION_DAYS` | `14` | อายุของ info/debug |
| `AUDIT_LOG_RETENTION_DAYS` | `730` | อายุของ `audit_logs` (2 ปี) |
| `LOGWORKER_PG_HOST` / `LOGWORKER_PG_PORT` | `127.0.0.1` / `5432` | ตั้งใน unit file · **ไม่ได้** ใช้ `PG_HOST` เพราะค่านั้นเป็นชื่อ service ในเครือข่าย docker |

ค่าที่พิมพ์ผิดจะตกกลับเป็นค่าปลอดภัยเสมอ (`warn` / ค่าตั้งต้นของแต่ละ retention) — ไม่มีทางที่พิมพ์ผิด
แล้วตารางโตวันละหลาย MB เงียบ ๆ หรือข้อมูลถูกลบทันที

## ตรวจว่ายังทำงานอยู่

3 ทาง เรียงจากสะดวกที่สุด:

1. **หน้า "บันทึกระบบ"** ใน Admin Portal — มีแถบสถานะของทั้ง 4 งานอยู่บนสุด ขึ้นเตือนเองเมื่อค้างเกิน 15 นาที
2. `npm run diag:log-worker` — ตรวจครบทั้งตัวแยกระดับ, ตัวลบข้อมูลอ่อนไหว, migration, trigger, และสถานะ worker
3. `journalctl -u logworker -n 50`

## แก้ปัญหาเบื้องต้น

| อาการ | สาเหตุที่พบบ่อย |
| --- | --- |
| `Cannot find package 'pg'` | ลืม symlink `scripts/logworker/node_modules` (ขั้นตอนที่ 1) |
| `ยังไม่ได้รัน migration: ขาดตาราง ...` | ข้ามขั้นตอนที่ 0 |
| `ECONNREFUSED 127.0.0.1:5432` | เครื่องนี้ไม่ได้ publish พอร์ต DB ออก host |
| `permission denied ... docker.sock` | ผู้ใช้ใน unit file ไม่ได้อยู่ในกลุ่ม `docker` |
| `มี logworker อีกตัวทำงานอยู่แล้ว` | มีตัวที่รันด้วยมือค้างอยู่ — advisory lock กันซ้อนให้แล้ว ปิดตัวที่รันมือทิ้ง |
| ตาราง `system_logs` ไม่โตเลย | ปกติ ถ้าระบบไม่มี warn/error — ลองตั้ง `SYSTEM_LOG_DB_LEVEL=info` ชั่วคราวเพื่อพิสูจน์ |
