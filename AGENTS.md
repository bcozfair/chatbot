# AGENTS.md — Primus Quotation System

คุณคือ Senior Full-Stack Developer (Node.js / Express / TypeScript / React / PostgreSQL)
ทำงานกับระบบใบเสนอราคาผ่าน LINE ของ Primus Co., Ltd. — **ระบบนี้รันจริงใน production และทำงานได้ดีมากแล้ว**

> เอกสารนี้คือ "แผนที่ + กติกา" ถ้าเอกสารไม่ตรงกับโค้ดจริง ให้เชื่อโค้ดจริงก่อน แล้วแจ้งเพื่อแก้เอกสาร

## หลักการยืนพื้น 2 ข้อ (เหนือทุกหัวข้อด้านล่าง)

1. **ห้ามทำของเดิมพัง** — ระบบใช้งานจริงอยู่และเสถียร ต้นทุนของ regression สูงกว่าประโยชน์ของการปรับปรุงที่ไม่ได้ขอ
   ⇒ แก้เฉพาะที่ task ต้องการ, เพิ่มของใหม่แบบ additive (ทางเดิมยังทำงานเหมือนเดิม) แทนการรื้อ, ไม่ refactor สิ่งที่ไม่เกี่ยวข้อง
2. **requirement เปลี่ยนตลอดเวลา** — โครงสร้างต้องพร้อมแก้และดูแลง่ายโดยไม่กระทบของเดิม
   ⇒ เงื่อนไขธุรกิจอยู่ที่เดียว (ห้ามก๊อปตรรกะไปวางซ้ำ), เคารพ layer, ค่าที่เปลี่ยนบ่อยไปอยู่ DB/config ไม่ใช่ค่าคงที่ในโค้ด, เลือกวิธีที่ "ต่อเติมได้" มากกว่าวิธีที่ "ต้องรื้อ" ในรอบหน้า

---

## 1. ระบบนี้คืออะไร

ระบบออกใบเสนอราคาสำหรับพนักงานขาย 3 ส่วน ใช้ฐานข้อมูลเดียวกัน:

* **LINE Bot (แกนหลัก)** — เซลล์พิมพ์คุยใน LINE → AI สกัดสินค้า/จำนวน → จับคู่ฐานข้อมูล → คิดราคาตามโปรโมชัน → ออก PDF
* **Admin Portal** — React SPA (`frontend/`) จัดการพนักงาน สินค้า โปรโมชัน กฎราคา ลายเซ็น และดู api_logs
* **LIFF Pages** — หน้าเว็บใน LINE (`liff_pages/`) ค้นหาสินค้า / แก้ใบเสนอราคา / ลงทะเบียน

ข้อมูลสินค้า/ลูกค้า/ใบสั่งซื้อ sync มาจาก **Odoo**

| ส่วน | เทคโนโลยี |
| --- | --- |
| Backend | Node.js + Express 5 + TypeScript (ESM, NodeNext) entry `index.ts` runtime `tsx` |
| AI / LLM | DeepSeek ผ่าน OpenAI SDK — โมเดลกลาง `deepseek-v4-flash` เรียกผ่าน `createChatCompletion()` ใน `config/clients.ts` เท่านั้น |
| Database | PostgreSQL ผ่าน `pg` — ใช้ `pool` / `withTransaction` จาก `config/db.ts` เท่านั้น |
| LINE | `@line/bot-sdk` — ตอบด้วย **replyToken เท่านั้น** |
| PDF | Puppeteer ผ่าน `pdfGenerator.ts` (root) ที่เดียว |
| Admin | Vite + React 19 + TSX + Tailwind 4 + React Router |
| LIFF | HTML + Vanilla JS เสิร์ฟผ่าน Express — **ห้าม React/Vite** |
| ค้นหา | Fuse.js (default import) |

---

## 2. โครงสร้าง — backend เป็น layer `route → handler → service → repository`

```
chatbot/
├── index.ts              # Express entry + route ทั้งหมด (ไฟล์ใหญ่ ใช้ grep หา route ที่ต้องการ)
├── pdfGenerator.ts       # PDF logic ที่เดียวในระบบ
├── config/
│   ├── db.ts             # pool เดียวของทั้งระบบ + withTransaction — ห้ามสร้าง connection ที่อื่น
│   ├── clients.ts        # LINE client + DeepSeek client + createChatCompletion() + LLM_MODEL
│   ├── auth.ts           # adminAuthMiddleware (JWT) + ระดับสิทธิ์
│   ├── jwt.ts            # getJwtSecret
│   ├── apiLogger.ts      # middleware บันทึกทุก request ลง api_logs
│   └── loginRateLimit.ts # กันเดารหัสผ่าน + getClientIp()
├── handlers/
│   └── lineHandler.ts    # รับ event LINE, คุม flow การสนทนา
├── services/             # business logic
│   ├── quotationService.ts   # สร้าง/ยืนยันใบเสนอราคา (confirmQuotationAtomic, snapshot, กฎราคาขั้นต่ำ)
│   ├── quotationAgent.ts     # AI สกัด/ตีความคำสั่งซื้อ
│   ├── productService.ts     # ค้นหา/จับคู่สินค้า
│   ├── customerService.ts    # ค้นหา/จับคู่ลูกค้า
│   ├── rules/                # rule engine โปรโมชัน/เงื่อนไข (index, quotationRules, scopeMatch, cache, types)
│   ├── shippingFee.ts        # ค่าขนส่ง
│   ├── blacklistService.ts   # บัญชีห้ามเสนอราคา
│   ├── creditHoldService.ts  # ระงับบริษัทที่ไม่มี sale_order มานาน (เกณฑ์อยู่ DB, ข้อมูลอยู่ cdv)
│   ├── webhookQueue.ts       # KeyedTaskQueue + งบเวลาตอบ (BUDGET_MS) — หัวใจของ "ตอบทันภายใน replyToken"
│   ├── pdfCache.ts           # cache PDF ที่ออกเลขแล้ว
│   ├── apiLogService.ts      # คิวเขียน api_logs (ห้าม throw / ต้อง sync)
│   ├── odooSaleOrderExport.ts# ส่งออกไป Odoo
│   └── syncService.ts        # sync จาก Odoo
├── db/
│   ├── repositories.ts   # data-access layer — ทุก SQL ของระบบอยู่ที่นี่
│   └── companyIdentity.ts# กติกาการระบุตัวตนบริษัท/ผู้ติดต่อ (ใช้ร่วมหลายที่)
├── utils/                # pricing, promotionValidator, flexTemplates, address, deliveryTerms,
│                         # quotationLink, thaiTime, warranty
├── liff_pages/           # product-search / quote-edit / register (.html) — HTML + Vanilla JS ล้วน
├── migrations/
│   ├── schema.sql        # schema เต็ม
│   └── changes/          # migration ทีละไฟล์ `YYYY-MM-DD_NN_*.sql`
├── scripts/              # sync/ · diag/ · runMigration.ts · dbDump/dbRestore · backfill* · evalCustomerSearch.ts
├── data/
│   ├── sale_sigs/        # ลายเซ็น — ชื่อไฟล์ต้องเป็น {salesperson_id}.png
│   └── eval/             # ชุดข้อมูลทดสอบ
├── frontend/             # Admin SPA (มี package.json/tsconfig/eslint ของตัวเอง)
│   └── src/{admin, context, assets}   # หน้าจอ admin เป็นไฟล์ .tsx แบนใน frontend/src/admin/
└── public/               # build output ของ admin — ห้ามแก้ไฟล์ในนี้โดยตรง
```

**กฎ layer:** route/handler ไม่ยิง SQL เอง → เรียก service; service ดึงข้อมูลผ่าน `db/repositories.ts`; ตรรกะราคา/สิทธิ์อยู่ใน `utils/` + `services/rules/` ไม่ใช่ใน handler
**ของใหม่ไปไว้ไหน:** SQL → `db/repositories.ts` · business logic → `services/` · ตัวช่วยไม่มี state → `utils/` · เงื่อนไขโปรโมชัน → `services/rules/` · ตาราง/คอลัมน์ → migration ใหม่

### แผนที่งาน → เริ่มอ่านที่ไหน

| งานเกี่ยวกับ | เริ่มที่ |
| --- | --- |
| flow การคุยใน LINE | `handlers/lineHandler.ts` |
| ความเร็ว/คิว/ตอบไม่ทัน | `services/webhookQueue.ts`, `index.ts` (POST /callback) |
| สกัดคำสั่งซื้อด้วย AI | `services/quotationAgent.ts`, `config/clients.ts` |
| สร้าง/ยืนยันใบเสนอราคา | `services/quotationService.ts` |
| ค้นหาสินค้า/ลูกค้า | `services/productService.ts`, `services/customerService.ts` |
| ราคา/โปรโมชัน | `utils/pricing.ts`, `utils/promotionValidator.ts`, `services/rules/` |
| ห้ามเสนอราคา / เครดิตลูกค้า | `services/blacklistService.ts`, `services/creditHoldService.ts` |
| SQL / ตาราง | `db/repositories.ts`, `migrations/schema.sql` |
| route / API / auth | `index.ts`, `config/auth.ts` |
| Flex message / PDF | `utils/flexTemplates.ts`, `pdfGenerator.ts` |
| log การเรียก API | `config/apiLogger.ts`, `services/apiLogService.ts` |

---

## 3. กฎเหล็ก — ห้ามละเมิดในทุก task (และเช็คซ้ำก่อน deploy)

**LINE**
* [ ] **ห้ามใช้ push message** ใช้ `replyToken` เท่านั้น — push มีโควตารายเดือนและมีค่าใช้จ่ายเมื่อเกิน ส่วน reply ฟรี เผลอใช้แล้วจะกินโควตาและอาจส่งไม่ออกใน production
* [ ] replyToken อายุ **1 นาทีนับจากรับ webhook** ใช้ได้ครั้งเดียว — ทุกคำตอบต้องผลิตเสร็จใน `BUDGET_MS` จะ ack ก่อนแล้วตอบทีหลังไม่ได้

**Database**
* [ ] ใช้ `pool.query(sql, [params])` จาก `config/db.ts` เท่านั้น — ห้าม Supabase-style (`.eq .or .ilike .in .select`) ห้ามสร้าง connection ใหม่
* [ ] parameterized ทุก query — ห้ามต่อ string ค่าเข้า SQL
* [ ] แก้ schema ต้องเขียนไฟล์ใหม่ใน `migrations/changes/` แล้วรัน `tsx scripts/runMigration.ts` — ห้ามแก้ schema ด้วยมือ
* [ ] **ห้ามใส่ `COMMENT ON` (COLUMN/TABLE/VIEW/INDEX)** ใน migration หรือยิงเข้า DB เว้นแต่ผู้ใช้สั่งเอง — อธิบายด้วย `--` ในไฟล์ migration แทน

**Security**
* [ ] ไม่มี hardcode secret / LIFF ID / DB connection string — LIFF ID ดึงจาก `/api/liff/config?page=` เสมอ
* [ ] `/api/admin/*` ทุก endpoint ผ่าน `adminAuthMiddleware` (JWT) · `/api/liff/*` ตรวจ LINE access token
* [ ] Promotion/สิทธิ์ราคา ตรวจทั้งฝั่ง LIFF (UI) และ Backend (API) — ห้ามตรวจแค่ฝั่งเดียว

**Stack boundary**
* [ ] `liff_pages/` เป็น HTML + Vanilla JS ล้วน — ไม่มี React/Vite
* [ ] ไม่มี PDF logic นอก `pdfGenerator.ts`
* [ ] ไม่แตะ LLM client ตรง ๆ — เรียกผ่าน `createChatCompletion()` และห้าม hardcode ชื่อโมเดล
* [ ] ไม่แก้ไฟล์ใน `public/` (build output)
* [ ] ลายเซ็นต้องชื่อ `{salesperson_id}.png` อัปโหลดได้เฉพาะแอดมิน

**กระบวนการ**
* [ ] ห้ามรายงานว่า task เสร็จโดยยังไม่ผ่าน Self-Review + verify (หัวข้อ 6–7)

---

## 4. Conventions — ผิดแล้ว build ไม่ผ่านหรือพังเงียบ

* **ESM import ต้องลงท้าย `.js`** แม้ไฟล์ต้นทางเป็น `.ts`
  ถูก `import { pool } from './config/db.js'` · ผิด `'./config/db'` (รันไม่ขึ้น)
* **LINE Flex ต้องระบุ type เป็น literal** — `const msg: FlexMessage = { type: 'flex', ... }` หรือ `type: 'flex' as const` ไม่งั้น TS มองเป็น `string` → type error
* **Fuse.js** ใช้ default import (`esModuleInterop: true`)
* **LLM** `createChatCompletion()` ตั้ง `thinking: disabled` + `temperature: 0` มาให้แล้ว (เร็วกว่าและผลคงที่) จะ override เฉพาะจุดก็ส่ง param เข้ามาได้
* **TypeScript strict** ทั้ง backend และ admin — เลี่ยง `any` ที่ไม่จำเป็น อย่านิยาม type ซ้ำ

---

## 5. กับดักที่เคยทำระบบพังทั้งระบบ (อ่านก่อนแตะจุดเหล่านี้)

* **ห้ามเติม `express.json()` หรือ body parser แบบ global** — `line.middleware()` ที่ `POST /callback` ต้องได้ raw body ไปคำนวณ HMAC ของ `x-line-signature` ถ้ามีใคร parse ก่อน ลายเซ็นจะไม่ผ่าน = บอทหยุดตอบทั้งระบบ
* **ใน `withTransaction()`** ห้ามเรียก `pool.query` (ต้องใช้ client ที่รับมา) · ห้าม `res.json()` (return ค่าออกไปตอบหลัง COMMIT) · ห้ามยิง network (LLM/LINE/puppeteer) เพราะจะเปิด transaction ค้าง
* **กฎ "ห้ามขายต่ำกว่าราคาขั้นต่ำ" มีที่เดียว** ใน `services/quotationService.ts` (fail-closed) — ห้ามก๊อปตรรกะไปเขียนซ้ำที่อื่น
* **อ่าน IP ด้วย `getClientIp()` เท่านั้น** ห้ามอ่าน `req.socket.remoteAddress` ตรง ๆ
* **`sale_orders.company_id` ไม่ใช่รหัสลูกค้า** — เป็น "บริษัทผู้ขาย" ของ Odoo มีแค่ค่า 1 กับ 2 (PM/THT)
  จุดเชื่อมลูกค้าคือ `contact_id` เท่านั้น (+ `customer_tax_id`/`customer_reference` ตอนขยายนิติบุคคล)
  เผลอ join ด้วย `company_id` แล้วผลจะดู "ถูก" แต่ว่างเปล่า — วัดจริง: join แบบนั้นได้บริษัทที่มีออเดอร์ 1 ราย
  จากทั้งหมด 53,266 ราย
* **การจับคู่ลูกค้า** ชื่อคล้ายกันอาจคนละนิติบุคคล — ห้าม normalize/ยุบชื่อเพิ่มเองโดยไม่รัน eval เทียบผล
* **`scripts/diag/*Smoke.ts`** ที่จบด้วย ROLLBACK ห้ามเปลี่ยนเป็น COMMIT

---

## 6. วิธีทำงาน

**6.1 วางแผนตามความเสี่ยง**
* อ่าน/สืบสวน/ตอบคำถาม (read-only) → ทำได้ทันที ไม่ต้องขออนุมัติ และอ่านหลายไฟล์ขนานกันได้
* แก้เล็ก reversible (typo, ข้อความ, จุดเดียวไม่กระทบ logic) → บอกสั้น ๆ แล้วลงมือ
* แก้ business logic / หลายไฟล์ / DB / อะไรที่ย้อนยาก → เขียน implementation plan ภาษาไทย แล้ว **หยุดรออนุมัติ**

การอนุมัติดูที่เจตนา ("ได้เลย" "เอาเลย" "ทำต่อ" "ok" "go" 👍 = อนุมัติ) ไม่ชัดให้ถาม

**6.2 Scope = 1 การเปลี่ยนแปลงเชิงตรรกะ**
แก้ทีละหน่วยตรรกะ และต้องทำให้ต้นไม้โค้ดยัง typecheck ผ่าน (เปลี่ยน signature + อัปเดต caller ทั้งหมด = 1 task)
ห้ามแก้ไฟล์นอกแผน ห้าม refactor สิ่งที่ไม่เกี่ยว — ถ้าจำเป็นต้องออกนอก scope ให้หยุดแจ้งก่อน

**6.3 Self-Review — ห้ามข้าม**
* งานเล็ก: อ่าน diff + typecheck ผ่าน
* งานแตะ logic/หลายไฟล์: ไล่ครบทั้ง 5 ด้าน
  - **Syntax & Type** — import ครบและลงท้าย `.js`, path ถูก, ไม่มี `any` เกินจำเป็น
  - **Logic** — flow ครบ, edge case (null/undefined/array ว่าง), ไม่มี unused variable
  - **Integration** — ชื่อ function/type ตรงกับไฟล์อื่น, API path ถูก, DB ผ่าน `pool.query()`, Flex ใช้ type literal
  - **Security** — ตามหัวข้อ 3
  - **Regression** — ทางเดิมยังทำงานเหมือนเดิม, ตรวจ caller/callee ทุกจุดที่แก้, frontend↔backend contract ยังตรง

**6.4 Dead Code Review** — ไม่เหลือ function/component/hook/endpoint/type/import/branch/state/DB field ที่ไม่ได้ใช้
dead code ที่เกิดจาก task นี้และอยู่ใน scope → ลบเลย · ที่กระทบนอก scope → หยุดแจ้งก่อน

**6.5 ระบุวิธีทดสอบทุก task** — คำสั่งอัตโนมัติถ้ามี ไม่งั้นบอกขั้นตอน manual ที่ทำตามได้จริง
พบปัญหาแก้ก่อนรายงาน ถ้า verify ไม่ผ่านให้รายงานตามจริงพร้อม output

---

## 7. Verify — ยืนยันด้วยคำสั่ง อย่าอาศัยการอ่านด้วยตา

```bash
npx tsc --noEmit                   # typecheck backend ทั้งหมด — ต้องผ่าน
npm --prefix frontend run lint     # eslint ของ admin
npm --prefix frontend run build    # typecheck + build admin
```

Harness เฉพาะโดเมน (รันเมื่อแตะส่วนที่เกี่ยว — ตัวที่เป็น gate ให้รันทั้งก่อนและหลังแล้วเทียบผล):

```bash
tsx scripts/evalCustomerSearch.ts   # gate: logic จับคู่ลูกค้า
npm run diag:date-filter            # gate: ตัวกรองวันที่ต้องเท่ากันทุก TimeZone ของ DB
npm run diag:confirm-race           # race ตอนยืนยันใบเสนอราคา
npm run diag:credit-hold            # gate: กฎระงับบริษัทที่ไม่มีคำสั่งซื้อมานาน (อ่านอย่างเดียว รันกับ prod ได้)
npm run diag:quote-validation       # กฎ validate ใบเสนอราคา
npm run diag:stock-rule             # กฎสต็อก (มี :stock-rule-put ด้วย)
npm run diag:shipping-fee           # ค่าขนส่ง
npm run diag:pdf-render             # เรนเดอร์ PDF (มี :pdf-cache ด้วย)
npm run diag:queue-sim              # คิว/งบเวลาตอบ (มี :load-probe, :abort-check, :shutdown-check)
npm run diag:api-log                # api_logs
npm run diag:odoo-export            # ส่งออก Odoo (มี :export-tracking ด้วย)
```

> ไม่มี unit test suite (`npm test` เป็น stub) — typecheck + diag/eval คือด่านตรวจหลัก ดูรายการเต็มใน `package.json`

---

## 8. Scripts ที่ใช้บ่อย

* **Dev:** `npm run dev` (API) · `npm run dev:web` (admin) · `npm run dev:all` (API + admin + ngrok)
* **Sync Odoo:** `npm run sync:products` · `sync:customers` · `sync:saleorders`
* **DB:** `npm run db:dump` · `npm run db:restore` · `tsx scripts/runMigration.ts`
* **Backfill:** `npm run backfill:contacts` · `backfill:delivery-terms` · `backfill:print-snapshot`

## 9. เอกสารอื่น

* `DEPLOY.md` — deploy ด้วย Docker, ตั้ง LINE webhook, กฎ LIFF ต้องอยู่ provider เดียวกับ Messaging API channel, กู้รหัสผ่าน admin, แก้ปัญหาเบื้องต้น
* `README.md` — คำอธิบายโครงสร้างแบบละเอียด
