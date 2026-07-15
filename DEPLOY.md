# แผน: Deploy ลง Server รวมของบริษัทด้วย Docker

Context (ทำไมต้องทำ / ข้อกำหนดจาก IT)
ผู้ใช้รู้สึกว่า frontend/backend แยกกันทำให้ deploy ยาก แต่จริง ๆ ตอน runtime มันเป็น process เดียวอยู่แล้ว — frontend/ (React+Vite) build ไปที่ public/ แล้ว Express ตัวเดียว (index.ts, port 3011) เสิร์ฟให้ (index.ts:25) ทุก API เป็น same-origin /api/... → ไม่ต้องเปลี่ยน frontend framework (vanilla/Next ไม่ช่วย ยังต้อง build/deploy เหมือนเดิม)

ข้อกำหนดจาก IT (บังคับ):

Deploy ด้วย Docker เท่านั้น
เป็น server Ubuntu ที่รันหลายโปรเจครวมกัน → โปรเจคเราต้องอยู่แยก path และรันในกล่อง Docker ของตัวเอง (ไม่ชนกับโปรเจคอื่น)
IT จัดการ subdomain + HTTPS ให้ ผ่าน reverse proxy กลาง (เหมือนที่อาจารย์เคยตั้งให้บน DigitalOcean) → เราแค่ expose พอร์ตของแอปให้ proxy ของ IT วิ่งเข้ามา ไม่ต้องทำ Cloudflare Tunnel/Caddy เอง
Database: รัน Postgres เป็น container ของเราเอง ใน docker-compose (แยกจาก Postgres ของโปรเจคอื่น)
เป้าหมาย: บน server ทำแค่ git clone → ตั้ง .env → docker compose up -d --build แล้วได้ทั้ง app + Postgres รันในกล่อง แยกขาดจากโปรเจคอื่น IT ชี้ subdomain มาที่พอร์ตของเรา

⚠️ Security เร่งด่วน: .env (LINE token, DeepSeek key, DB password database, JWT primus-secret-key-12345) ถูก commit เข้า git แล้ว → ถือว่ารั่ว ต้อง rotate ใหม่ทั้งหมด + เอาออกจาก git

Docker ทำงานยังไง (สรุปสำหรับมือใหม่ — เทียบกับ DigitalOcean+SQLite เดิม)
container = กล่อง ที่ห่อแอป + Node + Chromium (สำหรับ PDF) + ฟอนต์ไทย ไว้ด้วยกัน แยกขาดจากโปรเจคอื่นบน server เดียวกัน
Dockerfile = สูตรสร้างกล่อง (image), docker-compose.yml = ไฟล์สั่งรันหลายกล่อง (app + Postgres) ด้วยคำสั่งเดียว
เทียบ workflow เดิม: ssh → git clone → migrate → node + อาจารย์ตั้ง subdomain → ใหม่: ssh → git clone → docker compose up -d --build + IT ตั้ง subdomain (ต่างแค่มีขั้น "build image" เพิ่ม และ Postgres เป็นกล่องแทนไฟล์ SQLite)
ไฟล์ที่จะสร้าง / แก้
สร้างใหม่: Dockerfile, .dockerignore, docker-compose.yml, .env.example, DEPLOY.md (runbook ละเอียดสำหรับมือใหม่) แก้: package.json (เพิ่ม start), .gitignore, git rm --cached .env ไม่ต้องแก้ source แอป — puppeteer อ่าน PUPPETEER_EXECUTABLE_PATH เอง, DB host มาจาก env, SPA/LIFF เสิร์ฟผ่าน Express อยู่แล้ว

ขั้นตอนดำเนินการ (ฝั่งโค้ด — ผมทำให้ในเครื่องได้)

1. เพิ่ม script ที่ root (package.json)
   "start": "tsx index.ts"
   รัน backend ด้วย tsx ใน production (ESM ไฟล์เดียว ไม่ต้อง compile), tsx เป็น dependency อยู่แล้ว → runtime image ต้องลง dependency ครบ (รวม tsx + typescript)
2. Dockerfile (multi-stage)
   Stage 1 (build frontend): node:22-bookworm-slim → ใน frontend/ รัน npm ci && npm run build → ได้ output ที่ /app/public
   Stage 2 (runtime): node:22-bookworm-slim
   apt install chromium fonts-liberation fonts-thai-tlwg + libs ที่ Chromium ต้องใช้ (libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 libgbm1)
   ENV PUPPETEER_SKIP_DOWNLOAD=true และ PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium (puppeteer.launch() อ่านเอง ไม่ต้องแก้ pdfGenerator.ts)
   npm install → COPY . . → COPY --from=stage1 /app/public ./public → CMD ["npm","run","start"]
   ⚠️ fonts-thai-tlwg จำเป็น — ใบเสนอราคา PDF เป็นภาษาไทย ไม่มีฟอนต์ = กล่องสี่เหลี่ยม (จุดเสี่ยงสูงสุดต้องเทสต์)
   .dockerignore: node_modules, frontend/node_modules, public, dist, .git, .env, *.log, ngrok.exe
3. docker-compose.yml (2 services, แยก namespace ไม่ชนโปรเจคอื่น)
   name: primus-chatbot          # prefix ให้ container/volume/network ไม่ชนโปรเจคอื่นบน server รวม
   services:
   db:
   image: postgres:16
   restart: unless-stopped
   environment:
   POSTGRES_DB: ${PG_DATABASE}
   POSTGRES_USER: ${PG_USER}
   POSTGRES_PASSWORD: ${PG_PASSWORD}
   volumes:

   - pgdata:/var/lib/postgresql/data
     healthcheck:
     test: ["CMD-SHELL", "pg_isready -U ${PG_USER} -d ${PG_DATABASE}"]
     interval: 5s
     timeout: 5s
     retries: 10

   # ไม่ publish port 5432 ออก host → app คุยกับ db ผ่าน network ภายใน (db:5432) เท่านั้น

  app:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      PG_HOST: db             # ชี้ไป service db (ไม่ใช่ localhost)
      PG_PORT: 5432
      PORT: 3011
      NODE_ENV: production
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "127.0.0.1:<HOST_PORT>:3011"   # <HOST_PORT> = พอร์ตที่ IT ให้ route subdomain มา
    volumes:
      - sig_sale:/app/data/sale_sigs
      - sig_admin:/app/data/admin_sigs

volumes:
  pgdata:
  sig_sale:
  sig_admin:
สิ่งที่ต้องถาม IT: (1) พอร์ต host ว่างที่จะให้ผูก subdomain (<HOST_PORT> เช่น 8080) และ (2) reverse proxy กลางเชื่อมแบบ publish port (แบบข้างบน) หรือแบบ join docker network ร่วม/ใส่ Traefik labels — ถ้าเป็น network/labels จะปรับ compose ตามที่ IT กำหนด

4. จัดการ Secrets
   git rm --cached .env (เลิก track แต่เก็บไฟล์ไว้)
   แก้ .gitignore เพิ่ม: .env, dist, public, frontend/node_modules, *.log, ngrok.exe
   สร้าง .env.example (คีย์ครบ ค่าว่าง) commit ได้
   Rotate secret ที่เคย commit: LINE token+secret (LINE console), DeepSeek key, JWT_SECRET ใหม่ (rotate แล้ว admin หลุด login — ปกติ), PG_PASSWORD ใหม่ → ใส่ใน .env บน server เท่านั้น
   ขั้นตอนบน Server (ผมเข้าไม่ถึง — ทำเป็น DEPLOY.md ให้ทำตาม ผ่าน SSH หรือ VSCode Remote-SSH)
5. เตรียม server + clone

# IT ติดตั้ง Docker + Docker Compose ให้แล้ว (เช็ค: docker --version, docker compose version)

cd /opt/apps            # หรือ path ที่ IT กำหนดให้โปรเจคเรา (แยกจากโปรเจคอื่น)
git clone <repo-url></repo> primus-chatbot
cd primus-chatbot
cp .env.example .env    # แล้วแก้ค่าจริง (secret ที่ rotate ใหม่ + PG_HOST=db)
6. ย้าย Database: เครื่อง dev (Windows) → Postgres container บน server
บน Windows (PowerShell) — dump จาก Postgres ในเครื่อง (DB=chatbot_primus, user=postgres, pass=database):

$env:PGPASSWORD = "database"
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -h localhost -p 5432 -U postgres -d chatbot_primus -Fc -f "$HOME\chatbot_primus.dump"
scp "$HOME\chatbot_primus.dump" <user></user>@<server></server>:/opt/apps/primus-chatbot/
บน server — ขึ้น db container ก่อนแล้ว restore เข้าไป:

docker compose up -d db                 # ขึ้นเฉพาะ Postgres
docker compose ps                       # รอจน db = healthy
docker compose cp chatbot_primus.dump db:/tmp/chatbot_primus.dump
docker compose exec db pg_restore -U "$PG_USER" -d "$PG_DATABASE" --clean --if-exists --no-owner /tmp/chatbot_primus.dump

# ตรวจสอบ

docker compose exec db psql -U "$PG_USER" -d "$PG_DATABASE" -c "\dt"
docker compose exec db psql -U "$PG_USER" -d "$PG_DATABASE" -c "SELECT count(*) FROM quotations;"
⚠️ major version ต้องตรง (dev PG16 → postgres:16), --no-owner กัน error เรื่อง role ทางเลือก (ไม่เอาข้อมูลเดิม): ข้าม dump/restore → หลังแอปขึ้นแล้ว docker compose exec app npm run db:init + รัน migrations/*.sql

7. ขึ้นทั้ง stack + แจ้ง IT
   docker compose up -d --build            # build image + รัน app + db
   docker compose logs -f app              # เห็น "listening on 3011"
   แจ้ง IT: subdomain ที่ต้องการ + <HOST_PORT> ที่ผูกไว้ → IT ตั้ง reverse proxy + HTTPS → ตั้ง LINE webhook = https://<subdomain></subdomain>/callback กด Verify ที่ LINE console + อัปเดต LIFF endpoint URL ใน console

แก้โค้ดหลัง deploy (ตอบคำถามผู้ใช้)
โค้ดถูกห่อเข้า image ตอน build → แก้ไฟล์เฉย ๆ กล่องยังไม่เปลี่ยน ต้อง rebuild ทุกครั้ง:

วิธีแนะนำ (git): แก้ในเครื่อง → git push → SSH เข้า server → git pull → docker compose up -d --build
วิธี VSCode Remote-SSH: ต่อเข้า server แก้บนนั้นเลย (เหมือนเปิดโฟลเดอร์ในเครื่อง) → เปิด terminal ใน VSCode รัน docker compose up -d --build
แก้เฉพาะ frontend ก็ต้อง --build เหมือนกัน (เพราะ build เข้า image); DB ไม่หาย เพราะอยู่ใน volume pgdata
Verification (เทสต์บนเครื่อง dev ก่อนขึ้น server)
docker compose up -d --build → docker compose ps (db healthy, app up) → logs เห็น "listening on 3011"
Seed DB (restore dump หรือ db:init+migrations)
Endpoints: curl -I http://localhost:<HOST_PORT>/ (SPA 200), /admin (200), เปิด LIFF route เช็คไม่มี __LIFF_ID__ ค้าง, ยิง /api/... ที่แตะ DB ได้ JSON (พิสูจน์ app↔db)
PDF/Puppeteer (เสี่ยงสุด): สร้าง quote PDF (/download-pdf/...) เช็ค render ได้ และภาษาไทยไม่เป็นกล่อง
Persistence: อัปโหลดลายเซ็น → docker compose down && up -d → ไฟล์ใน data/sale_sigs + row ใน DB ยังอยู่ (พิสูจน์ volume)
ผ่าน dev → ทำซ้ำบน server, แจ้ง IT ผูก subdomain, ตั้ง LINE webhook + Verify
Critical files
package.json (เพิ่ม start — แก้)
Dockerfile, .dockerignore, docker-compose.yml, .env.example, DEPLOY.md (สร้างใหม่)
.gitignore (แก้) + git rm --cached .env
frontend/vite.config.ts, config/db.ts, pdfGenerator.ts, index.ts (ไม่ต้องแก้ — แค่ผ่าน env)
Open decisions (ถาม IT)
การเชื่อม reverse proxy กลาง: publish host port (แผนตั้งไว้แบบนี้) vs join docker network ร่วม/Traefik labels + <HOST_PORT> ที่ว่าง
Path บน server ที่ IT กำหนดให้โปรเจค (เช่น /opt/apps/primus-chatbot)
DB seeding — restore ข้อมูลเดิม (แผนตั้งไว้) vs เริ่มใหม่
Secret rotation — ยืนยัน OK (rotate JWT = admin หลุด login)
