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
# PUPPETEER_SKIP_DOWNLOAD=true ทำให้ puppeteer ไม่โหลด Chromium ของตัวเอง (ใช้ตัวจาก apt แทน)
COPY package*.json ./
RUN npm install

# โค้ดแอปทั้งหมด (public/ ในเครื่องถูกกันด้วย .dockerignore แล้วเอา build ใหม่มาทับ)
COPY . .
COPY --from=frontend /app/public ./public

EXPOSE 3011
CMD ["npm", "run", "start"]
