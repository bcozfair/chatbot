# syntax=docker/dockerfile:1

# =====================================================================
# Stage 1 — build React admin SPA (Vite outputs to ../public = /app/public)
# =====================================================================
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend

# ติดตั้ง deps ของ frontend ก่อน (cache layer จนกว่า package จะเปลี่ยน)
# ใช้ npm install (ไม่ใช่ npm ci) เพราะ frontend/package-lock.json ไม่ sync กับ package.json
COPY frontend/package*.json ./
RUN npm install

# build → เขียนไปที่ /app/public ตาม vite.config.ts (outDir: ../public)
COPY frontend/ ./
RUN npm run build

# =====================================================================
# Stage 2 — runtime (Express + tsx + Chromium สำหรับ puppeteer)
# =====================================================================
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium (สำหรับสร้าง PDF) + ฟอนต์ไทย (ไม่งั้น PDF ภาษาไทยเป็นกล่องสี่เหลี่ยม)
# + shared libs ที่ Chromium headless ต้องใช้
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-thai-tlwg \
      ca-certificates \
      libnss3 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libxss1 \
      libxshmfence1 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ติดตั้ง dependency ทั้งหมด (รวม tsx + typescript ที่ใช้รัน production)
# --include=dev บังคับลง devDependencies ด้วย เพราะ NODE_ENV=production จะข้าม devDeps ไม่งั้น tsx จะหาย
# PUPPETEER_SKIP_DOWNLOAD=true ทำให้ puppeteer ไม่โหลด Chromium ของตัวเอง (ใช้ตัวจาก apt แทน)
COPY package*.json ./
RUN npm install --include=dev

# โค้ดแอปทั้งหมด (public/ ในเครื่องถูกกันด้วย .dockerignore แล้วเอา build ใหม่มาทับ)
COPY . .
COPY --from=frontend /app/public ./public

EXPOSE 3011

# C.4 — รัน node ตรง ๆ ไม่ผ่าน npm
#
# ของเดิม `npm run start` ทำให้ process tree เป็น npm(PID 1) → sh -c → tsx → node(PID 30)
# docker ส่ง SIGTERM ให้ PID 1 เท่านั้น ⇒ ตัว handler ปิดอย่างสุภาพที่อยู่ใน node ไม่เคยได้รับสัญญาณ
# (ยืนยันจากของจริง: `docker compose exec app ps -ef` เห็น node อยู่ลึก 4 ชั้น + มี esbuild
#  เป็น zombie ค้างเพราะ npm ไม่ได้ทำหน้าที่ init) ⇒ ต่อให้เขียน graceful shutdown ดีแค่ไหน
# ก็ไม่ทำงาน · คู่กับ init: true ใน docker-compose.yml (tini เป็น PID 1 → ส่งต่อสัญญาณ + เก็บ zombie)
CMD ["node", "--import", "tsx", "index.ts"]
