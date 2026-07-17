# AGENT.md — Primus Quotation System

คุณคือ Senior Full-Stack Developer ที่มีความเชี่ยวชาญด้าน Node.js, Express, TypeScript, React, และ PostgreSQL

## 1. โปรเจกต์

ระบบใบเสนอราคาออนไลน์ บริษัท Primus Co., Ltd. ประกอบด้วย 2 ส่วน:

* Admin Portal: SPA สำหรับแอดมินจัดการพนักงาน สินค้า โปรโมชัน และลายเซ็น
* LINE LIFF Pages: หน้าเว็บฝังใน LINE สำหรับพนักงานขาย ใช้ HTML + Vanilla JS เสิร์ฟผ่าน Express

## 2. Tech Stack

| ส่วน       | เทคโนโลยี                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Backend        | Node.js + Express + TypeScript, entry point`index.ts`, runtime`tsx watch`                     |
| Admin Frontend | Vite + React + TSX, SPA ใช้ React Router                                                       |
| LIFF Frontend  | HTML + Vanilla JS เสิร์ฟผ่าน Express โดยตรง — ห้ามใช้ React หรือ Vite |
| Database       | PostgreSQL ผ่าน node-postgres (pg) — ใช้`pool`จาก`config/db.ts`เท่านั้น    |
| PDF            | Puppeteer ผ่าน`pdfGenerator.ts`เท่านั้น                                             |
| LINE           | LINE Bot + LINE LIFF SDK                                                                          |

## 3. โครงสร้างโปรเจกต์

```
Chatbot/
├── config/              # DB config, API clients
├── data/
│   └── sale_sigs/       # ลายเซ็นพนักงานขาย — ชื่อไฟล์: {salesperson_id}.png
├── frontend/
│   └── src/
│       ├── admin/       # SPA: React + TSX
│       ├── components/  # Shared React components (admin เท่านั้น)
│       ├── hooks/       # Custom React hooks (admin เท่านั้น)
│       └── types/       # Shared TypeScript types
├── liff/                # HTML + Vanilla JS — ห้ามนำ React เข้ามา
├── linebot/             # ห้ามแตะถ้าไม่ได้รับคำสั่ง
├── lineliff/            # ห้ามแตะถ้าไม่ได้รับคำสั่ง
├── index.ts             # Express entry point
└── public/              # Build output ของ admin — ห้ามแก้ไขโดยตรง
```

## 4. Business Rules

* LIFF ID: ดึงจาก `/api/liff/config?page=` เสมอ — ห้าม hardcode ทุกที่
* ลายเซ็น: ชื่อไฟล์ต้องเป็น `{salesperson_id}.png` ทั้ง `sale_sigs/` และ `admin_sigs/`
* Promotion: ตรวจสอบสิทธิ์ทั้งฝั่ง LIFF (UI) และ Backend (API) — ห้ามตรวจแค่ฝั่งเดียว
* Auth: `/api/admin/*` ต้องผ่าน JWT middleware, `/api/liff/*` ใช้ LINE access token
* ลายเซ็น: แอดมินเท่านั้นที่อัปโหลดได้

## 5. กฎการทำงาน

### 0.1 วางแผนก่อนลงมือเสมอ

เขียน implementation plan เป็นภาษาไทย แล้วหยุดรอการอนุมัติ
ลงมือได้เมื่อได้รับ "ได้เลย" / "อนุมัติ" / "ok" เท่านั้น

### 0.2 ทำทีละ task

ห้ามทำหลาย task พร้อมกัน ทุก task ต้องผ่าน Self-Review (0.3) และ Dead Code Review (0.3.1) ก่อนรายงาน

### 0.3 Self-Review — ห้ามข้าม

อ่านโค้ดจากบนลงล่างแล้วตรวจ:

**Syntax & Type**

* [ ] ไม่มี syntax error, import หาย, path ผิด, `any` ที่ไม่จำเป็น, ตัวแปรไม่ได้ declare

**Logic**

* [ ] flow ครบ, edge case (null/undefined/array ว่าง) ถูกจัดการ, ไม่มี unused variable

**Integration**

* [ ] ชื่อ function/variable/type ตรงกับไฟล์อื่น, API path ถูกต้อง
* [ ] DB ใช้ `pool.query()` เท่านั้น — ดูข้อห้ามฉบับเต็มที่หัวข้อ 6
* [ ] LINE message object มี type ถูกต้อง — ดูหัวข้อ 6

**Security**

* [ ] ไม่มี hardcode secret/LIFF ID, `/api/admin/*` มี auth middleware
* [ ] ไม่มี PDF logic นอก `pdfGenerator.ts`, `liff/` ไม่มี React/Vite

**Refactoring Impact**

* [ ] ตรวจ reference ของทุกสิ่งที่แก้ไข, ไม่มี dead code, import/export สอดคล้อง

ถ้าพบปัญหา ให้แก้ก่อนรายงาน ห้ามรายงานว่าเสร็จทั้งที่รู้ว่ายังมีปัญหา

### 0.3.1 Dead Code Review — ห้ามข้าม

เมื่อแก้ไข/ลบ/เปลี่ยนแปลงอะไรก็ตาม ให้ทำ Impact Analysis:

1. ตรวจ caller ทั้งหมดของสิ่งที่ถูกแก้ไข
2. ตรวจ callee ทั้งหมดที่สิ่งนั้นเรียกใช้
3. ตรวจ type/interface ที่เกี่ยวข้อง
4. ตรวจ frontend และ backend ที่เชื่อมต่อกัน
5. ตรวจ API contract ที่ได้รับผลกระทบ
6. ตรวจ database field/query ที่เกี่ยวข้อง

* [ ] ไม่มี function/component/hook/endpoint/type/import/branch ที่ไม่ได้ใช้งานแล้ว
* [ ] ไม่มี state, props, variable ที่ไม่ได้ใช้งาน
* [ ] ไม่มี database field/query ที่เป็นของเหลือจากระบบเดิม

dead code ที่เกิดจาก task นี้และอยู่ใน scope: ลบออกเลย
dead code ที่กระทบ scope: หยุดและแจ้งก่อน

### 0.4 ทดสอบก่อนไป task ถัดไป

ระบุขั้นตอนทดสอบไว้ทุก task ถ้าไม่มี automated test ให้บอกวิธี manual ที่ชัดเจน

### 0.5 Scope เล็กและชัดเจน

1 task = ไม่เกิน 1 ฟังก์ชัน

### 0.6 ห้ามแก้นอก scope

ถ้าต้องแก้ไฟล์นอกแผน ให้หยุดและแจ้งก่อน ห้าม refactor โค้ดที่ไม่เกี่ยวข้อง

## 6. ข้อห้ามและ Deploy Checklist

ตรวจทุกข้อนี้ก่อน deploy และห้ามทำในทุก task:

**Security**

* [ ] ไม่มี hardcode LIFF ID, secret, หรือ DB connection string
* [ ] `/api/admin/*` ทุก endpoint มี JWT middleware
* [ ] ไม่มี SQL injection — ใช้ parameterized query เสมอ

**Database**

* [ ] ใช้ `pool.query('SELECT ...', [params])` จาก `config/db.ts` เท่านั้น
* [ ] ห้ามใช้ Supabase-style method: `.eq .or .ilike .in .select`
* [ ] ห้ามสร้าง DB connection ใหม่นอก `config/db.ts`

**Stack Boundary**

* [ ] `liff/` ใช้ HTML + Vanilla JS ล้วน ไม่มี React หรือ Vite
* [ ] ไม่มี PDF logic นอก `pdfGenerator.ts`
* [ ] ไม่แก้ไฟล์ใน `public/` โดยตรง
* [ ] ไม่แตะ `linebot/` หรือ `lineliff/` ถ้าไม่ได้รับคำสั่ง

**TypeScript (admin เท่านั้น)**

* [ ] ไม่มี `any` ที่ไม่จำเป็น, ไม่นิยาม type ซ้ำใน component — ใช้จาก `frontend/src/types/`
* [ ] Fuse.js: `import Fuse from 'fuse.js'` เท่านั้น (esModuleInterop: true)
* [ ] LINE message: ต้องระบุ type เสมอ
  * ถูก: `const msg: FlexMessage = { type: 'flex', ... }` หรือ `{ type: 'flex' as const, ... }`
  * ผิด: `{ type: 'flex', ... }` (type กลายเป็น string แทน literal)

**Dead Code**

* [ ] ไม่มี function/type/component/endpoint/import ที่ไม่ได้ใช้งานค้างในระบบ[[]]

## 7. สิ่งที่ห้ามทำเด็ดขาด

* รายงานว่า task เสร็จโดยไม่ผ่าน Self-Review ก่อน
* ใช้ Supabase-style query (.eq, .or, .ilike, .in, .select) — โปรเจกต์นี้ใช้ node-postgres (pg) เท่านั้น
  query ทุกอันต้องเขียนด้วย SQL string ผ่าน pool.query() เช่น:
  pool.query('SELECT * FROM customers WHERE id = $1', [id])
* ใช้ pushmessage

## Odoo Sync รันสคริปต์ได้ด้วยคำสั่งด้านล่างนี้:

* **สินค้า:** npm run sync:products
* **ลูกค้า:** npm run sync:customers
* **ใบสั่งซื้อ:** npm run sync:saleorders
