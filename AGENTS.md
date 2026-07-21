# AGENTS.md — Primus Quotation System

คุณคือ Senior Full-Stack Developer เชี่ยวชาญ Node.js, Express, TypeScript, React และ PostgreSQL
ทำงานกับระบบใบเสนอราคาผ่าน LINE ของบริษัท Primus Co., Ltd.

> เอกสารนี้คือ "แผนที่ + กติกา" ของโปรเจกต์ ถ้าเจอจุดที่เอกสารไม่ตรงกับโค้ดจริง ให้เชื่อโค้ดจริงก่อน แล้วแจ้งเพื่อแก้เอกสาร

---

## 1. โปรเจกต์

ระบบสร้างใบเสนอราคาสำหรับพนักงานขาย ทำงาน 3 ส่วนที่เชื่อมฐานข้อมูลเดียวกัน:

* **LINE Bot (แกนหลัก)** — พนักงานพิมพ์คุยใน LINE บอทใช้ AI สกัดสินค้า/จำนวน จับคู่กับฐานข้อมูล คำนวณราคาตามโปรโมชัน แล้วออกใบเสนอราคา PDF
* **Admin Portal** — SPA (React) สำหรับแอดมินจัดการพนักงาน สินค้า โปรโมชัน และลายเซ็น
* **LIFF Pages** — หน้าเว็บฝังใน LINE (`liff_pages/`) สำหรับค้นหาสินค้า / แก้ไขใบเสนอราคา / ลงทะเบียน ใช้ HTML + Vanilla JS ล้วน

ข้อมูลสินค้า/ลูกค้า/ใบสั่งซื้อ sync มาจาก **Odoo** (ดูหัวข้อ 9)

---

## 2. Tech Stack

| ส่วน | เทคโนโลยี |
| --- | --- |
| Backend | Node.js + Express 5 + TypeScript (ESM), entry `index.ts`, runtime `tsx` |
| AI / LLM | DeepSeek ผ่าน OpenAI SDK — โมเดลกลาง `deepseek-v4-flash` เรียกผ่าน `createChatCompletion()` ใน `config/clients.ts` เท่านั้น |
| Database | PostgreSQL ผ่าน node-postgres (`pg`) — ใช้ `pool` จาก `config/db.ts` เท่านั้น |
| LINE | `@line/bot-sdk` — ตอบกลับด้วย **replyToken เท่านั้น** (ห้าม push, ดูหัวข้อ 8) |
| PDF | Puppeteer ผ่าน `pdfGenerator.ts` (root) เท่านั้น |
| Admin Frontend | Vite + React 19 + TSX + Tailwind CSS 4 + React Router (โฟลเดอร์ `frontend/`) |
| LIFF Frontend | HTML + Vanilla JS เสิร์ฟผ่าน Express โดยตรง — **ห้ามใช้ React หรือ Vite** |
| ค้นหา/จับคู่ | Fuse.js (fuzzy search) |

---

## 3. โครงสร้างโปรเจกต์ (backend เป็น layer: handler → service → repository)

```
chatbot/
├── index.ts                 # Express entry point + route ทั้งหมด
├── pdfGenerator.ts          # สร้าง PDF ด้วย Puppeteer — PDF logic อยู่ที่นี่ที่เดียว
├── config/
│   ├── db.ts                # pool เดียวของทั้งระบบ — ห้ามสร้าง connection ที่อื่น
│   ├── clients.ts           # LINE client + DeepSeek client + createChatCompletion()
│   ├── auth.ts              # adminAuthMiddleware (JWT)
│   └── jwt.ts               # getJwtSecret
├── handlers/
│   └── lineHandler.ts       # รับ event จาก LINE, จัดการ flow การสนทนา
├── services/                # business logic
│   ├── quotationService.ts  # สร้าง/ยืนยันใบเสนอราคา (confirmQuotationAtomic, snapshot)
│   ├── quotationAgent.ts    # AI agent สกัด/ตีความคำสั่งซื้อ
│   ├── productService.ts    # ค้นหา/จับคู่สินค้า
│   ├── customerService.ts   # ค้นหา/จับคู่ลูกค้า
│   ├── syncService.ts       # sync ข้อมูลจาก Odoo
│   └── rules/               # rule engine ของโปรโมชัน/เงื่อนไข (index, quotationRules, scopeMatch, cache, types)
├── db/
│   └── repositories.ts      # data-access layer — ทุก SQL query อยู่ที่นี่
├── utils/
│   ├── pricing.ts           # calcNetPrice, sumLineTotals
│   ├── promotionValidator.ts# ตรวจสิทธิ์ราคา/โปรโมชันฝั่ง backend
│   └── flexTemplates.ts     # สร้าง LINE Flex message
├── liff_pages/              # HTML + Vanilla JS (product-search, quote-edit, register) — ห้ามนำ React เข้ามา
├── migrations/
│   ├── schema.sql           # schema เต็ม
│   └── changes/             # migration ทีละไฟล์ (YYYY-MM-DD_NN_*.sql)
├── scripts/                 # sync/, diag/, evalCustomerSearch.ts, runMigration.ts, dbDump/Restore
├── data/
│   ├── sale_sigs/           # ลายเซ็นพนักงานขาย — ชื่อไฟล์: {salesperson_id}.png
│   └── eval/                # ชุดข้อมูลทดสอบ (customer_search_cases.json ฯลฯ)
├── frontend/                # Admin SPA (React) — มี package.json/tsconfig/eslint ของตัวเอง
│   └── src/{admin, components, hooks, context, assets, types}
└── public/                  # build output ของ admin — ห้ามแก้ไฟล์ในนี้โดยตรง
```

### แผนที่งาน → เริ่มอ่านที่ไหน

| งานเกี่ยวกับ | เริ่มที่ |
| --- | --- |
| flow การคุยใน LINE | `handlers/lineHandler.ts` |
| สกัดคำสั่งซื้อด้วย AI | `services/quotationAgent.ts`, `config/clients.ts` |
| สร้าง/ยืนยันใบเสนอราคา | `services/quotationService.ts` |
| ค้นหาสินค้า/ลูกค้า | `services/productService.ts`, `services/customerService.ts` |
| ราคา/โปรโมชัน | `utils/pricing.ts`, `utils/promotionValidator.ts`, `services/rules/` |
| SQL / ตาราง | `db/repositories.ts`, `migrations/schema.sql` |
| route / API / auth | `index.ts`, `config/auth.ts` |
| Flex message / PDF | `utils/flexTemplates.ts`, `pdfGenerator.ts` |

---

## 4. Business Rules

* **LIFF ID:** ดึงจาก `/api/liff/config?page=` เสมอ — ห้าม hardcode ทุกที่
* **ลายเซ็น:** ชื่อไฟล์ต้องเป็น `{salesperson_id}.png` — อัปโหลดได้เฉพาะแอดมิน
* **Promotion:** ตรวจสิทธิ์ทั้งฝั่ง LIFF (UI) และ Backend (API) — ห้ามตรวจแค่ฝั่งเดียว
* **Auth:** `/api/admin/*` ต้องผ่าน JWT middleware (`adminAuthMiddleware`), `/api/liff/*` ใช้ LINE access token
* **ตอบ LINE:** ใช้ replyToken เท่านั้น ไม่ใช้ push (ดูเหตุผลหัวข้อ 8)

---

## 5. Conventions — วิธีเขียนโค้ดในโปรเจกต์นี้ (กันพังตั้งแต่ต้น)

ต่อไปนี้คือ pattern ที่ต้องทำตามให้ตรง มิฉะนั้นโค้ดจะ build ไม่ผ่านหรือพังเงียบ:

* **ESM import ต้องลงท้าย `.js`** — โปรเจกต์เป็น `NodeNext` ESM แม้ไฟล์ต้นทางเป็น `.ts` ก็ต้อง import ด้วย `.js`
  * ถูก: `import { pool } from './config/db.js'`
  * ผิด: `import { pool } from './config/db'` (รันไม่ขึ้น)
* **Database:** ใช้ `pool.query('SELECT ... WHERE id = $1', [id])` จาก `config/db.ts` เท่านั้น
  * ห้าม Supabase-style (`.eq .or .ilike .in .select`), ห้ามต่อ string ค่าเข้า SQL (ต้อง parameterized), ห้ามสร้าง connection ใหม่
  * เพิ่ม/แก้ตาราง: เขียนไฟล์ใหม่ใน `migrations/changes/` แล้วรันผ่าน `scripts/runMigration.ts` — ห้ามแก้ schema ด้วยมือนอก migration
* **LLM:** เรียกผ่าน `createChatCompletion()` เท่านั้น (ตั้ง `thinking: disabled` + `temperature: 0` ให้แล้ว เพื่อความเร็วและผลลัพธ์คงที่) — ห้ามสร้าง OpenAI client ใหม่ หรือ hardcode ชื่อโมเดล
* **LINE Flex message ต้องระบุ type เป็น literal เสมอ:**
  * ถูก: `const msg: FlexMessage = { type: 'flex', ... }` หรือ `{ type: 'flex' as const, ... }`
  * ผิด: `{ type: 'flex', ... }` (TS มองเป็น `string` ไม่ใช่ literal → type error)
* **Fuse.js:** `import Fuse from 'fuse.js'` (default import, เพราะ `esModuleInterop: true`)
* **TypeScript:** ทั้ง backend และ admin เป็น `strict` — เลี่ยง `any` ที่ไม่จำเป็น, อย่านิยาม type ซ้ำ ใช้จาก `frontend/src/types/` (สำหรับ admin)

---

## 6. กฎการทำงาน

### 6.1 วางแผนตามระดับความเสี่ยง

ปรับความเข้มของ "วางแผนก่อนลงมือ" ตามงาน:

* **อ่าน / สืบสวน / ตอบคำถาม (read-only):** ทำได้ทันที ไม่ต้องขออนุมัติ และ**สืบสวนหลายไฟล์พร้อมกันได้**
* **แก้เล็ก reversible** (typo, ข้อความ, ปรับ 1 จุดที่ไม่กระทบ logic อื่น): บอกสั้น ๆ ว่าจะทำอะไรแล้วลงมือได้เลย
* **แก้ business logic / หลายไฟล์ / DB / อะไรที่ย้อนยาก:** เขียน implementation plan เป็นภาษาไทย แล้ว**หยุดรอการอนุมัติ**ก่อนลงมือ

การอนุมัติดูที่**เจตนา**ของผู้ใช้ ไม่ใช่คำเป๊ะ ๆ ("ได้เลย", "เอาเลย", "ทำต่อ", "โอเค", "ok", "go", 👍 ล้วนถือว่าอนุมัติ) ถ้ายังไม่ชัดให้ถาม

### 6.2 ทำการแก้ไขทีละอย่าง

การ**แก้ไข**ให้ทำทีละหน่วยตรรกะ (ไม่ทำหลายอย่างพันกันในครั้งเดียว) แต่การ**อ่าน**ขนานกันได้
ทุกการแก้ไขต้องผ่าน Self-Review (6.4) และ Dead Code Review (6.5) ก่อนรายงาน

### 6.3 Scope = 1 การเปลี่ยนแปลงเชิงตรรกะ

1 task = 1 การเปลี่ยนแปลงที่สมเหตุสมผลและ**ทำให้ต้นไม้โค้ดยัง typecheck ผ่าน** เช่น เปลี่ยน signature ของฟังก์ชัน + อัปเดต caller ทั้งหมด = 1 task (ห้ามทิ้งโค้ดค้างในสถานะ compile ไม่ผ่าน)
ห้ามแก้ไฟล์นอกแผน / ห้าม refactor โค้ดที่ไม่เกี่ยวข้อง — ถ้าจำเป็นต้องออกนอก scope ให้หยุดแจ้งก่อน

### 6.4 Self-Review — ห้ามข้าม

เลือกความเข้มตามขนาดงาน:

* **งานเล็ก (แก้ 1 จุด ไม่กระทบ logic):** ไล่อ่าน diff + รัน typecheck (หัวข้อ 7) ให้ผ่าน
* **งานแตะ logic / หลายไฟล์:** ไล่เต็ม checklist ด้านล่าง

**Syntax & Type** — ไม่มี syntax error / import หายหรือลืม `.js` / path ผิด / `any` เกินจำเป็น / ตัวแปรไม่ได้ declare
**Logic** — flow ครบ, จัดการ edge case (null/undefined/array ว่าง), ไม่มี unused variable
**Integration** — ชื่อ function/variable/type ตรงกับไฟล์อื่น, API path ถูก, DB ผ่าน `pool.query()`, Flex message ระบุ type literal
**Security** — ไม่มี hardcode secret/LIFF ID, `/api/admin/*` มี auth, ไม่มี PDF logic นอก `pdfGenerator.ts`, `liff_pages/` ไม่มี React/Vite
**Refactoring Impact** — ตรวจ reference ของทุกสิ่งที่แก้, import/export สอดคล้อง, ไม่เหลือ dead code

พบปัญหาแก้ก่อนรายงาน — **ห้ามรายงานว่าเสร็จทั้งที่รู้ว่ายังมีปัญหา** ถ้า verify ไม่ผ่านให้รายงานตามจริงพร้อม output

### 6.5 Dead Code Review

เมื่อแก้/ลบ/เปลี่ยนอะไร ให้ทำ Impact Analysis: ตรวจ caller, callee, type/interface, จุดเชื่อม frontend↔backend, API contract, และ DB field/query ที่เกี่ยวข้อง

* [ ] ไม่มี function/component/hook/endpoint/type/import/branch ที่ไม่ได้ใช้แล้ว
* [ ] ไม่มี state/props/variable ที่ไม่ได้ใช้
* [ ] ไม่มี DB field/query ที่เป็นของเหลือจากระบบเดิม

dead code ที่เกิดจาก task นี้และอยู่ใน scope → ลบเลย
dead code ที่กระทบนอก scope → หยุดและแจ้งก่อน

### 6.6 ระบุวิธีทดสอบทุก task

บอกวิธี verify ที่ชัดเจนเสมอ — คำสั่งอัตโนมัติ (หัวข้อ 7) ถ้ามี ไม่งั้นระบุขั้นตอน manual ที่ทำตามได้จริง

---

## 7. Verify — คำสั่งตรวจงานที่รันได้จริง

ใช้เครื่องมือเหล่านี้ยืนยันงานก่อนรายงานเสร็จ (อย่าอาศัยการอ่านด้วยตาอย่างเดียว):

```bash
npx tsc --noEmit                      # typecheck backend ทั้งหมด (tsconfig root exclude frontend อยู่แล้ว) — ต้องผ่าน
npm --prefix frontend run lint        # eslint ของ admin
npm --prefix frontend run build       # typecheck + build admin (tsc -b && vite build)
```

Harness เฉพาะโดเมน (ใช้เมื่อแตะส่วนที่เกี่ยว):

```bash
tsx scripts/evalCustomerSearch.ts     # gate: รันก่อน/หลังทุกครั้งที่แก้ logic จับคู่ลูกค้า แล้วเทียบผล
npm run diag:confirm-race             # ตรวจ race ตอนยืนยันใบเสนอราคา
```

> ยังไม่มี unit test suite (`npm test` เป็น stub) — typecheck + diag/eval harness คือด่านตรวจหลักของระบบนี้

---

## 8. ข้อห้ามเด็ดขาด & Deploy Checklist

ตรวจทุกข้อก่อน deploy และห้ามละเมิดในทุก task:

**Security**
* [ ] ไม่มี hardcode LIFF ID / secret / DB connection string
* [ ] `/api/admin/*` ทุก endpoint มี JWT middleware
* [ ] ทุก SQL เป็น parameterized query (กัน SQL injection)

**Database**
* [ ] ใช้ `pool.query(sql, [params])` จาก `config/db.ts` เท่านั้น — ห้าม Supabase-style (`.eq .or .ilike .in .select`) และห้ามสร้าง connection ใหม่

**LINE**
* [ ] **ห้ามใช้ push message** — ใช้ replyToken เท่านั้น
  เหตุผล: push มีโควตารายเดือนและมีค่าใช้จ่ายเมื่อเกินโควตา ขณะที่ระบบนี้ทำงานแบบตอบกลับ event (reply ฟรี) การเผลอใช้ push จะกินโควตาและอาจส่งไม่ออกใน production

**Stack Boundary**
* [ ] `liff_pages/` เป็น HTML + Vanilla JS ล้วน — ไม่มี React/Vite
* [ ] ไม่มี PDF logic นอก `pdfGenerator.ts`
* [ ] ไม่แก้ไฟล์ใน `public/` โดยตรง (เป็น build output)
* [ ] ไม่แตะ AI/LLM client โดยตรง — เรียกผ่าน `createChatCompletion()`

**Code Quality**
* [ ] ไม่มี `any` เกินจำเป็น, ไม่นิยาม type ซ้ำ (admin ใช้จาก `frontend/src/types/`)
* [ ] LINE message ระบุ type literal เสมอ, Fuse.js ใช้ default import
* [ ] ไม่เหลือ function/type/component/endpoint/import ที่ไม่ได้ใช้ค้างในระบบ

**ห้ามเด็ดขาด:** รายงานว่า task เสร็จโดยยังไม่ผ่าน Self-Review + verify

---

## 9. Scripts

**Sync จาก Odoo**
* สินค้า: `npm run sync:products`
* ลูกค้า: `npm run sync:customers`
* ใบสั่งซื้อ: `npm run sync:saleorders`

**Dev / Run**
* `npm run dev` — API (tsx watch) | `npm run dev:web` — admin | `npm run dev:all` — API + admin + ngrok พร้อมกัน

**Database**
* `npm run db:dump` / `npm run db:restore` — dump/restore | `tsx scripts/runMigration.ts` — รัน migration ใน `migrations/changes/`

**Diagnostics / Eval** — อยู่ใน `scripts/diag/` และ `scripts/evalCustomerSearch.ts` (ดูหัวข้อ 7)
