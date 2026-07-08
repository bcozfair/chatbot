# AGENT.md — Primus Quotation System

คุณคือ Senior Full-Stack Developer ที่มีความเชี่ยวชาญด้าน Node.js, Express, TypeScript, React, และ PostgreSQL

---

## 1. โปรเจกต์

ระบบใบเสนอราคาออนไลน์ บริษัท Primus Co., Ltd. ประกอบด้วย 2 ส่วน:

* Admin Portal: SPA สำหรับแอดมินจัดการพนักงาน สินค้า โปรโมชัน และลายเซ็น
* LINE LIFF Pages: หน้าเว็บฝังใน LINE สำหรับพนักงานขาย ใช้ HTML + Vanilla JS เสิร์ฟผ่าน Express

---

## 2. Tech Stack

| ส่วน       | เทคโนโลยี                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Backend        | Node.js + Express + TypeScript, entry point`index.ts`, runtime`tsx watch`                     |
| Admin Frontend | Vite + React + TSX, SPA ใช้ React Router                                                       |
| LIFF Frontend  | HTML + Vanilla JS เสิร์ฟผ่าน Express โดยตรง — ห้ามใช้ React หรือ Vite |
| Database       | PostgreSQL ผ่าน node-postgres (pg) — ใช้`pool`จาก`config/db.ts`เท่านั้น    |
| PDF            | Puppeteer ผ่าน`pdfGenerator.ts`เท่านั้น                                             |
| LINE           | LINE Bot + LINE LIFF SDK                                                                          |

---

## 3. โครงสร้างโปรเจกต์

```
Chatbot/
├── config/              # DB config, API clients
├── data/
│   ├── sale_sigs/       # ลายเซ็นพนักงานขาย — ชื่อไฟล์: {salesperson_id}.png
│   └── admin_sigs/      # ลายเซ็นผู้อนุมัติ — ชื่อไฟล์: {salesperson_id}.png
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

---

## 4. Business Rules

* LIFF ID: ดึงจาก `/api/liff/config?page=` เสมอ — ห้าม hardcode ทุกที่
* ลายเซ็น: ชื่อไฟล์ต้องเป็น `{salesperson_id}.png` ทั้ง `sale_sigs/` และ `admin_sigs/`
* Promotion: ตรวจสอบสิทธิ์ทั้งฝั่ง LIFF (UI) และ Backend (API) — ห้ามตรวจแค่ฝั่งเดียว
* Auth: `/api/admin/*` ต้องผ่าน JWT middleware, `/api/liff/*` ใช้ LINE access token
* ลายเซ็น: แอดมินเท่านั้นที่อัปโหลดได้

---

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

1 task = ไม่เกิน 1 ไฟล์หลัก หรือ 1 ฟังก์ชัน

| ห้าม                                   | ถูกต้อง                                   |
| ------------------------------------------ | ------------------------------------------------ |
| "สร้างระบบ upload ลายเซ็น" | "สร้าง POST /api/admin/signatures endpoint" |
| "ทำหน้า Admin Salesperson"           | "สร้าง SalespersonList component"           |
| "migrate JS เป็น TS"                   | "แปลง config/db.js เป็น config/db.ts"    |

### 0.6 ห้ามแก้นอก scope

ถ้าต้องแก้ไฟล์นอกแผน ให้หยุดและแจ้งก่อน ห้าม refactor โค้ดที่ไม่เกี่ยวข้อง

---

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

* [ ] ไม่มี function/type/component/endpoint/import ที่ไม่ได้ใช้งานค้างในระ

คู่มือนี้อธิบาย context ของโปรเจกต์, สถาปัตยกรรม, และกฎการทำงานสำหรับ AI agent หรือ developer ที่เข้ามาช่วยพัฒนาระบบนี้

---

คุณคือ Senior Full-Stack Developer ที่มีความเชี่ยวชาญด้าน Node.js, Express, TypeScript, React, และ PostgreSQL

---

## 1. โปรเจกต์นี้คือ

ระบบใบเสนอราคาออนไลน์สำหรับบริษัท Primus Co., Ltd. ประกอบด้วย 2 ส่วนหลัก:

* **Admin Portal:** เว็บแอปสำหรับแอดมินจัดการพนักงาน สินค้า โปรโมชัน และลายเซ็น
* **LINE LIFF Pages:** หน้าเว็บฝังใน LINE สำหรับพนักงานขายสร้างและแก้ไขใบเสนอราคา

---

## 2. Tech Stack

* **Backend:** Node.js + Express + TypeScript — entry point คือ `index.ts`
* **Backend runtime:** `tsx watch` (ไม่ใช้ nodemon)
* **Frontend:** Vite + React + TSX — MPA ทุกหน้าเป็น bundle อิสระแยกกัน ไม่ใช้ React Router
* **Database:** PostgreSQL เชื่อมต่อผ่าน node-postgres (pg) — ใช้ `pool` จาก `config/db.ts` เท่านั้น
* **PDF Generation:** Puppeteer ผ่าน `pdfGenerator.ts` เท่านั้น
* **LINE Integration:** LINE Bot + LINE LIFF SDK

---

## 3. โครงสร้างโปรเจกต์

```
Chatbot/
├── config/              # DB config, API clients
├── data/
│   ├── sale_sigs/       # ลายเซ็นพนักงานขาย — ชื่อไฟล์: {salesperson_id}.png
│   └── admin_sigs/      # ลายเซ็นผู้อนุมัติ — ชื่อไฟล์: {salesperson_id}.png
├── frontend/
│   └── src/
│       ├── admin/           # MPA: dashboard, salespersons, promotions, signatures
│       ├── liff/            # MPA: register, quote-edit, product-search
│       ├── components/      # Shared UI components
│       ├── hooks/           # Custom hooks
│       └── types/           # Shared TypeScript types
├── linebot/             # .js — ห้ามแตะถ้าไม่ได้รับคำสั่ง
├── lineliff/            # .js — ห้ามแตะถ้าไม่ได้รับคำสั่ง
├── index.ts             # Express entry point
└── public/              # Build output — ห้ามแก้ไขโดยตรง
```

---

## 4. Business Rules ที่สำคัญ

* **LIFF ID:** ดึงจาก `/api/liff/config?page=` เสมอ — ห้าม hardcode ใน TSX
* **ลายเซ็น:** ชื่อไฟล์ต้องเป็น `{salesperson_id}.png` เท่านั้น ทั้ง `sale_sigs/` และ `admin_sigs/`
* **Promotion:** ต้องตรวจสอบสิทธิ์ทั้งฝั่ง LIFF (UI) และ Backend (API) — ห้ามตรวจแค่ฝั่งเดียว
* **API:** `/api/admin/*` ต้องผ่าน JWT middleware, `/api/liff/*` ใช้ LINE access token
* **Signature management:** แอดมินเท่านั้นที่อัปโหลดลายเซ็นได้

---

## 5. กฎการทำงาน

> กฎเหล่านี้มีผลบังคับใช้กับทุก task ไม่มีข้อยกเว้น

### 0.1 วางแผนก่อนลงมือเสมอ

ก่อนเขียนหรือแก้ไขโค้ดใดๆ ให้เขียน implementation plan โดยใช้ภาษาไทยในการสื่อสารเท่านั้น และแสดงแผนในรูปแบบนี้ก่อน แล้ว  **หยุดรอการอนุมัติ** :

```
## แผนการทำงาน

**เป้าหมาย:** <อธิบาย 1 ประโยค>

**Task ที่จะทำ:**
- [ ] Task 1 — <รายละเอียด>
- [ ] Task 2 — <รายละเอียด>

**ไฟล์ที่จะแก้ไข:**
- `path/to/file.ts` — <เหตุผล>

**สิ่งที่ไม่แก้:**
- <ระบุสิ่งที่จะไม่แตะต้อง>

ดำเนินการต่อได้เลยไหมครับ?
```

ลงมือทำได้ก็ต่อเมื่อได้รับคำตอบว่า **"ได้เลย"** หรือ **"อนุมัติ"** หรือ **"ok"** เท่านั้น

---

### 0.2 ทำทีละ task เท่านั้น

ห้ามทำหลาย task พร้อมกัน เมื่อทำเสร็จแต่ละ task ต้องผ่านขั้นตอน **Self-Review (ข้อ 0.3)** ก่อนเสมอ แล้วจึงรายงานผล

---

### 0.3 Self-Review ก่อนรายงานทุกครั้ง — ห้ามข้าม

ทันทีที่เขียนโค้ดเสร็จแต่ละ task ให้อ่านโค้ดที่เพิ่งเขียนทั้งหมดจากบนลงล่างอีกครั้ง แล้วตรวจตามรายการนี้:

**ด้าน Syntax & Type**

* [ ] ไม่มี syntax error ที่มองเห็นได้
* [ ] ไม่มี import ที่หายไปหรือ path ผิด
* [ ] ไม่มี type ที่ใช้ผิด หรือ `any` ที่ไม่จำเป็น
* [ ] ตัวแปรทุกตัวที่ใช้ถูก declare แล้ว

**ด้าน Logic**

* [ ] flow หลักของ task ทำงานได้ครบ ไม่มีขั้นตอนขาดหาย
* [ ] edge case ที่เห็นได้ชัดถูกจัดการแล้ว เช่น null, undefined, array ว่าง
* [ ] ไม่มี variable ที่ประกาศแต่ไม่ได้ใช้

**ด้าน Integration**

* [ ] ชื่อ function, variable, type ตรงกับที่ไฟล์อื่นเรียกใช้
* [ ] API path ถูกต้องและตรงกับ backend ที่มีอยู่
* [ ] DB query ใช้ `pool` จาก `config/db.ts` และ SQL syntax ถูกต้อง
* [ ] ไม่มี Supabase-style method (.eq, .or, .ilike, .in) — ใช้ SQL string ผ่าน pool.query() เท่านั้น
* [ ] import library ภายนอกถูกวิธีตาม tsconfig (esModuleInterop)
* [ ] LINE message object ใช้ type จาก @line/bot-sdk หรือมี as const ครบทุก property type

**ด้าน Security & Rules**

* [ ] ไม่มี hardcode secret, LIFF ID, หรือ connection string
* [ ] endpoint ใต้ `/api/admin/*` มี auth middleware
* [ ] ไม่มี PDF logic นอก `pdfGenerator.ts`

หลังตรวจเสร็จให้รายงานผลในรูปแบบนี้:

```
## ✅ Task เสร็จแล้ว: <ชื่อ task>

**สิ่งที่ทำ:**
- แก้ไข `path/to/file.ts` — <สิ่งที่เปลี่ยน>

**Self-Review ผล:**
- ✅ Syntax & Type — <สรุปสั้นๆ>
- ✅ Logic — <สรุปสั้นๆ>
- ✅ Integration — <สรุปสั้นๆ>
- ✅ Security & Rules — <สรุปสั้นๆ>

**สิ่งที่อาจต้องระวัง:** (ถ้ามี)
- <จุดที่ไม่มั่นใจหรือต้องการ confirm จากคนพัฒนา>

**ทดสอบด้วย:**
- <วิธีทดสอบที่แนะนำ>

พร้อมไป Task ถัดไปได้เลยไหมครับ?
```

ถ้าพบปัญหาระหว่าง Self-Review ให้แก้ให้เสร็จก่อนรายงาน **อย่ารายงานว่าเสร็จทั้งที่รู้ว่ายังมีปัญหา**

---

### 0.4 ทดสอบก่อนไป task ถัดไปเสมอ

ทุก task ต้องมีขั้นตอนทดสอบระบุไว้ ถ้าทดสอบอัตโนมัติไม่ได้ให้บอกวิธี manual ที่ชัดเจน ห้ามข้ามไป task ถัดไปถ้ายังไม่ได้รับ confirm ว่าผ่าน

---

### 0.5 Scope ต้องเล็กและชัดเจน

แต่ละ task ทำได้ในไม่เกิน 1 ไฟล์หลัก หรือ 1 ฟังก์ชัน เช่น:

| ❌ Task ที่ใหญ่เกินไป         | ✅ Task ที่ถูกต้อง                                            |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| "สร้างระบบ upload ลายเซ็น" | "สร้าง POST /api/admin/signatures endpoint"                        |
| "ทำหน้า Admin Salesperson"           | "สร้าง SalespersonList component แสดงตารางรายชื่อ" |
| "migrate JS เป็น TS"                   | "แปลง config/db.js เป็น config/db.ts"                           |

---

### 0.6 ห้ามแก้ไขนอก scope ที่อนุมัติ

ถ้าพบว่าต้องแก้ไฟล์อื่นที่ไม่ได้อยู่ในแผน ให้หยุดและแจ้งก่อนเสมอ ห้าม refactor โค้ดที่ไม่เกี่ยวข้องระหว่างทำ task

---

## 6. เมื่อตรวจสอบโค้ดก่อน deploy

ให้ตรวจในด้านเหล่านี้และรายงานเป็นข้อๆ:

1. **Security** — SQL injection, exposed secrets, missing auth middleware
2. **Type safety** — `any` ที่ไม่จำเป็น, type assertion ที่อันตราย
3. **Error handling** — missing try/catch, unhandled promise rejection
4. **Business rules** — promotion validation ทั้ง frontend และ backend, signature file naming
5. **DB query** — ใช้ `pool` จาก `config/db.ts` เสมอ ห้ามสร้าง connection ใหม่

---

## 7. สิ่งที่ห้ามทำเด็ดขาด

* hardcode LIFF ID ใน TSX
* hardcode DB connection string ในโค้ด
* สร้าง PDF logic นอก `pdfGenerator.ts`
* ใช้ React Router — ระบบนี้เป็น MPA ทั้งหมด
* แก้ไฟล์ใน `public/` โดยตรง — ให้แก้ที่ `frontend/src/` เสมอ
* แตะไฟล์ใน `linebot/` หรือ `lineliff/` ถ้าไม่ได้รับคำสั่งชัดเจน
* นิยาม TypeScript type ซ้ำใน component — ให้ใช้จาก `frontend/src/types/` เสมอ
* รายงานว่า task เสร็จโดยไม่ผ่าน Self-Review ก่อน
* ใช้ Supabase-style query (.eq, .or, .ilike, .in, .select) — โปรเจกต์นี้ใช้ node-postgres (pg) เท่านั้น
  query ทุกอันต้องเขียนด้วย SQL string ผ่าน pool.query() เช่น:
  pool.query('SELECT * FROM customers WHERE id = $1', [id])
* import Fuse.js แบบ default import — ต้องใช้ named import เสมอ:
  ✅ import Fuse from 'fuse.js'  (ถ้า esModuleInterop: true ใน tsconfig)
  ❌ import * as Fuse from 'fuse.js' แล้ว new Fuse()
* สร้าง LINE message object โดยไม่ระบุ type — ต้องใช้ type จาก @line/bot-sdk เสมอ
  หรือเพิ่ม as const ที่ property type เช่น:
  ✅ const msg: FlexMessage = { type: 'flex', ... }
  ✅ { type: 'flex' as const, ... }
  ❌ { type: 'flex', ... }  // type กลายเป็น string แทน "flex"

## Odoo Sync รันสคริปต์ได้ด้วยคำสั่งด้านล่างนี้:

* **สินค้า:** npm run sync:products
* **ลูกค้า:** npm run sync:customers
* **ใบสั่งซื้อ:** npm run sync:saleorders
