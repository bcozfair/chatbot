# CLAUDE.md

คู่มือสำหรับ agent ที่ทำงานในรีโปนี้ — เก็บ **สิ่งที่โค้ดไม่ได้พูดออกมาเอง**
`README.md` คือคำอธิบายโครงสร้างแบบละเอียด · `DEPLOY.md` คือ runbook ของการขึ้นระบบ ·
ไฟล์นี้คือ "ทำไมมันถึงเป็นแบบนี้" และ "อะไรที่เคยพังมาแล้ว"

**`AGENTS.md` คืออีกครึ่งหนึ่งและไม่ใช่ของเลือกอ่าน** — กฎ git, กฎเวลาหลาย session อยู่ในทรีเดียวกัน,
ขอบเขตการอนุมัติ และด่าน verify อยู่ที่นั่น
**`docs/design.md` ต้องอ่านก่อนแตะอะไรที่คนมองเห็น** — สี่พื้นผิวของแอปนี้ (Admin · LIFF · Flex · PDF)
มีกติกาคนละชุด และการเผลอเอากติกาของพื้นผิวหนึ่งไปใช้กับอีกพื้นผิวคือบั๊กที่เกิดซ้ำที่สุด

**กติกาของเอกสารชุดนี้ 3 ข้อ**

1. **เอกสารไม่ตรงโค้ด ให้เชื่อโค้ดแล้วแก้เอกสารในคอมมิตเดียวกับงาน** — "คอมมิตหน้าค่อยแก้" มาไม่ถึงจริงบ่อยกว่าที่คิด
2. **ข้ออ้างที่วัดได้ ต้องมีตัวเลขและวันที่กำกับ** ตัวเลขที่ไม่มีวันที่คือตัวเลขที่ไม่มีใครกล้าใช้
3. **หัวข้อที่ยาวเกิน ~15 บรรทัด เขียนเป็นไฟล์ใน `docs/` แล้วเหลือบรรทัดดัชนีไว้ที่นี่** — ไฟล์นี้ถูกโหลดเข้า
   context ทุกเทิร์นของทุก session ความยาวจึงเป็นต้นทุนที่ทุกงานจ่าย ไม่ใช่แค่งานที่เกี่ยวข้อง

---

## ระบบนี้คืออะไร

ระบบออกใบเสนอราคาของ Primus Co., Ltd. — **รันจริงใน production และเสถียร** ต้นทุนของ regression
สูงกว่าประโยชน์ของการปรับปรุงที่ไม่ได้ขอ ข้อมูลสินค้า/ลูกค้า/ใบสั่งขาย sync มาจาก **Odoo**

| ส่วน | เทคโนโลยี | หมายเหตุที่ผิดบ่อย |
| --- | --- | --- |
| Backend | Node.js + Express 5 + TypeScript (ESM, NodeNext) entry `index.ts` รันด้วย `tsx` | import ต้องลงท้าย `.js` แม้ไฟล์ต้นทางเป็น `.ts` |
| AI / LLM | DeepSeek ผ่าน OpenAI SDK — เรียกผ่าน `createChatCompletion()` ใน `config/clients.ts` เท่านั้น | ห้าม hardcode ชื่อโมเดล |
| Database | PostgreSQL ผ่าน `pg` — `pool` / `withTransaction` จาก `config/db.ts` เท่านั้น | ไม่มี ORM ไม่มี Supabase client |
| LINE | `@line/bot-sdk` — **`replyToken` เท่านั้น** | `grep pushMessage` = 0 จุด (วัด 2026-09-12) ตัวเลขนี้ต้องเป็น 0 ตลอดไป |
| PDF | Puppeteer ผ่าน `pdfGenerator.ts` (root) ที่เดียว | A4 · ฟอนต์ไทยต้องมีในกล่อง |
| Admin | Vite + React 19 + Tailwind 4 — build ลง `public/` ซึ่ง **commit เข้า repo** | ห้ามแก้ไฟล์ใน `public/` ตรง ๆ |
| LIFF | HTML + Vanilla JS ล้วน เสิร์ฟผ่าน Express | ห้าม React/Vite เด็ดขาด |
| ค้นหา | Fuse.js (default import) | |

ขนาดที่ควรรู้ก่อนเปิดไฟล์ (วัด 2026-09-12): `index.ts` **4,531 บรรทัด / 109 route** —
ใช้ `grep` หา route ที่ต้องการ อย่าอ่านทั้งไฟล์ · `handlers/lineHandler.ts` 101 KB ·
`services/quotationService.ts` 118 KB · `services/customerService.ts` 104 KB

---

## เส้นทางของหนึ่งข้อความ — และทำไมมันถึงต้องเร็ว

```
LINE webhook → line.middleware() (ต้องได้ raw body) → webhookQueue → handleEvent
     → quoteExtraction (LLM)  → productService/customerService (จับคู่)
     → services/rules/ + utils/pricing (ราคา)  → insertDraftQuotations (ร่าง)
     → Flex ตอบกลับด้วย replyToken  → [ยืนยัน] → confirmQuotationAtomic → เลขใบ → PDF
```

**นาฬิกาคือข้อจำกัดที่ออกแบบทุกอย่างในเส้นนี้** — `replyToken` อายุ 60 วินาทีนับจากรับ webhook
และใช้ได้ครั้งเดียว `services/webhookQueue.ts` จึงตั้ง `SAFETY_MARGIN_MS = 12_000` เผื่อ network
เหลือ **`BUDGET_MS = 48_000`** เป็นงบเวลาผลิตคำตอบ ทุกอย่างที่ช้ากว่านั้นต้องถูกตัดจบด้วยคำตอบสำรอง
ไม่ใช่ปล่อยให้ token หมดอายุเงียบ ๆ **"ack ก่อนแล้วตอบทีหลัง" ทำไม่ได้** เพราะการตอบทีหลังต้องใช้
push ซึ่งมีโควตารายเดือนและมีค่าใช้จ่าย ส่วน reply ฟรี — นี่คือเหตุผลเชิงเงิน ไม่ใช่เชิงสไตล์

**`express.json()` แบบ global คือสิ่งที่ห้ามเติมตลอดกาล** — `line.middleware()` ที่ `POST /callback`
ต้องได้ raw body ไปคำนวณ HMAC ของ `x-line-signature` ถ้ามีใคร parse ก่อน ลายเซ็นไม่ผ่าน =
**บอทหยุดตอบทั้งระบบ** ไม่ใช่พังเฉพาะ endpoint นั้น

**ใน `withTransaction()`** ห้ามเรียก `pool.query` (ต้องใช้ client ที่รับมา) · ห้าม `res.json()`
(return ค่าออกไปตอบหลัง COMMIT) · ห้ามยิง network ใด ๆ (LLM / LINE / puppeteer) เพราะ transaction
จะค้างคาไว้ตลอดเวลาที่รอปลายทาง และ `enrichQuotationData` ผูก pool ตรง ๆ จึง **เรียกใน transaction
ไม่ได้เลย** (self-deadlock) — enrich นอก tx เสมอ

## เส้นทางที่สอง: หน้าเว็บ "ขอใบเสนอราคา"

ตั้งแต่กลางปี 2026 วงจร "ร่าง → แก้ → ยืนยัน → PDF" มีทางเข้าสองทาง และนี่คือข้อจำกัดที่ทำให้มัน
ไม่แตกเป็นสองระบบ — แผนเต็มอยู่ใน `docs/plan-web-quote-request.md` ส่วนหัวไฟล์แต่ละตัวเขียนเหตุผล
ของตัวเองไว้แล้ว:

| เฟส | ไฟล์ | สิ่งที่มันรับผิดชอบ |
| --- | --- | --- |
| A | `services/chatChannel.ts` | ฉีด "ตัวตอบกลับ" เข้า `handleEvent` แทนการ import `lineClient` ตรง ๆ — ถอดไฟล์นี้ออกแล้วระบบเดิมกลับมาเหมือนเดิมเป๊ะ |
| B | `services/webIdentity.ts` | แถวพร็อกซี `user_id = web:<admin>:<sales>` เพราะ `quotations.user_id` มี FK ไป `salesperson` และแอดมินไม่ใช่ผู้ขาย |
| C | `services/quoteExtraction.ts` | "ข้อความดิบ → ร่างใบ" ที่ย้ายออกจากกลาง `handleEvent` |
| D | `services/webQuoteService.ts` | หลังบ้านของหน้าเว็บ — คืนข้อมูลดิบ ไม่ประกอบ Flex ไม่มี replyToken |

**กฎเดียวที่ค้ำทั้งสี่เฟส: ตรรกะธุรกิจ (ราคา · ส่วนลด · กฎบล็อก · blacklist · เครดิต) เรียกของเดิม
ห้ามก๊อปมาไว้ฝั่งเว็บ** ไม่งั้นวันหนึ่งใบที่ออกจากเว็บกับจาก LINE จะคิดเลขไม่ตรงกัน และจะไม่มีใคร
รู้ว่าฝั่งไหนถูก

**`prompt` ของ `quoteExtraction` เป็นส่วนหนึ่งของ input ที่โมเดลเห็น** — รวมช่องว่างและระดับการเยื้อง
ที่ติดมาจากตอนยังอยู่ใน `handleEvent` ห้ามจัดย่อหน้าใหม่ให้สวย ด่าน `npm run diag:line-parity`
เทียบกับ golden file ทีละตัวอักษร แก้ช่องว่างเมื่อไหร่ด่านล้มทันที

---

## คำสั่ง

```bash
npm run dev          # API (tsx watch)
npm run dev:web      # Admin SPA (Vite)
npm run dev:all      # API + admin + ngrok พร้อมกัน

npx tsc --noEmit                   # typecheck backend — ด่านหลัก ไม่มี unit test suite
npm --prefix frontend run lint     # eslint ของ admin
npm --prefix frontend run build    # typecheck + build admin (ผลลง public/)

npm run sync:products · sync:customers · sync:saleorders   # ดึงจาก Odoo
npm run db:dump · db:restore                               # ถ่ายฐานข้อมูล
tsx scripts/runMigration.ts                                # รัน migration ที่ยังไม่ได้รัน
npm run backfill:contacts · backfill:delivery-terms · backfill:print-snapshot
npm run logworker                                          # worker เขียน log แยกโปรเซส
```

`npm test` เป็น stub (`exit 1`) โดยตั้งใจ — **ด่านตรวจของโปรเจคนี้คือ typecheck + `scripts/diag/*`**
(46 ไฟล์ · 30+ npm script) ดูรายการเต็มใน `package.json` และดูว่าตัวไหนเป็น gate ใน `AGENTS.md` ข้อ 6

---

## กับดักของข้อมูล — แต่ละข้อเคยทำให้มีคนสรุปผิดมาแล้ว

- **`sale_orders.company_id` ไม่ใช่รหัสลูกค้า** — เป็น "บริษัทผู้ขาย" ของ Odoo มีแค่ค่า `1` กับ `2`
  (PM / THT) จุดเชื่อมลูกค้าคือ **`contact_id` เท่านั้น** (+ `customer_tax_id` / `customer_reference`
  ตอนขยายนิติบุคคล) เผลอ join ด้วย `company_id` แล้วผลจะ **ดูถูกแต่ว่างเปล่า** — วัดจริง: join แบบนั้น
  ได้บริษัทที่มีออเดอร์ **1 ราย จากทั้งหมด 53,266 ราย**

- **`customers` ไม่ใช่รายชื่อลูกค้า** — `customers_data_view` (matview, 1 แถว = 1 ผู้ติดต่อ) คือ
  **source of truth เดียว** ตั้งแต่ 2026-07-23 ที่ `customers_view` / `contacts_view` ถูกปลดออกจาก DB
  เหตุผลคือ **contact 5,906 รายที่ออกใบสั่งขายจริงแต่ไม่มีแถวใน `customers`** — ค้นใน `customers`
  แล้วระบบจะรายงานลูกค้าเก่าว่าเป็นคนใหม่
  **และเพดานนี้แก้ในรีโปไม่ได้** (พิสูจน์ 2026-07-23): `TRUNCATE customers` + full sync จากปี 1970
  จบสมบูรณ์ 262 หน้า 7m13s ได้ **77,434 contact / 52,353 บริษัทพอดี** เพราะ gateway ตัด
  `active=false` ทิ้ง และ endpoint เป็น since/cursor ล้วน ไม่มี by-id ให้ขอทีละตัว (ลอง widen 8 แบบ
  ไม่รับ) ทางแก้จริงคือส่งต่อทีม gateway/Odoo
  **`payload.company_count` เป็นค่า per-page ไม่ใช่ยอดรวม** และ `payload.count` = `undefined` —
  ใช้เป็น completeness gate ไม่ได้

- **`customers_data_view` เป็น "ตารางจริง" ไม่ใช่ materialized view แล้ว** (ตั้งแต่ migration
  `2026-08-06_01_customers_data_fast_refresh.sql`) — **ห้ามสั่ง `REFRESH MATERIALIZED VIEW`
  กับมันอีก** วิธี refresh คือ **build + swap**: สร้างตารางใหม่ทั้งก้อนจาก view
  `customers_data_build` (~2.1s ไม่ล็อกใคร) แล้วสลับชื่อใน transaction เดียว (ถือ
  AccessExclusiveLock ระดับ ms) — ตรรกะทั้งหมดอยู่ที่ `scripts/sync/refreshCustomerDirectory.ts`
  ที่เดียว เรียกจากทั้ง CLI sync และ `services/syncService.ts`
  **ทำไมเลิกใช้ `REFRESH … CONCURRENTLY`:** วัดบน prod ได้ **10.0–11.5 วิ** ทั้งที่ query เองใช้
  ~3 วิ ส่วนต่างคือ Postgres ต้องสร้าง temp table 82k แถว + unique index บนมัน + FULL OUTER JOIN
  เทียบทั้งแถว 23 คอลัมน์ (เพิ่ม `work_mem` ไม่ช่วย)
  **ต้องใช้ `pg.Client` เฉพาะกิจ ไม่ใช่ pool** — pool ตั้ง `statement_timeout`/`query_timeout` = 15s
  และ build+swap ต้องไม่ไปอยู่ใน transaction ของคนอื่น · ฟังก์ชันนี้ **ห้าม throw** เพราะเป็น guard
  ท้าย sync · มัน **ข้ามรอบเองถ้าข้อมูลต้นทางไม่ขยับ** ⇒ migration ที่แก้แค่นิยาม view ต้องส่ง
  `{ force: true }` ไม่งั้นจะดูเหมือนรันแล้วแต่ไม่มีอะไรเปลี่ยน
  **ห้ามให้แอป query `customers_data_build` ตรง ๆ** (~2 วิ/ครั้ง) — แอปอ่าน `customers_data_view` เสมอ

- **`date AT TIME ZONE` ที่ไม่มี `::timestamp` เพี้ยนเฉพาะบน prod** — เครื่อง dev อยู่ Asia/Bangkok
  จึงมองไม่เห็น ส่วน container prod เป็น UTC ต้องการ "วันไทย" ให้เรียกผ่าน `utils/thaiTime.ts`
  และเงื่อนไขวันที่ใน SQL มีที่เดียวคือ `createdAtFromThaiDayCondition` /
  `createdAtToThaiDayCondition` ใน `db/repositories.ts` ห้ามเขียน SQL ซ้ำในแต่ละ endpoint
  · gate: `npm run diag:date-filter` (เทียบ 3 โซนทั้งสองฝั่ง + assert `pg_typeof` + เรียก
  `allocateQuotationNo` จริงใต้ `TZ=UTC`)

- **ห้าม `.trim()` ชื่อลูกค้า/ผู้ติดต่อในทุกเส้นที่ส่งไป Odoo** — Odoo จับคู่ `res.partner` ด้วยการ
  เทียบชื่อ **ตรงตัวทุกอักขระ** และข้อมูลจริงมีช่องว่างหัว/ท้ายอยู่ **17,666 แถว** (`contact_name`)
  กับ **810 แถว** (`customer_name`) — `"คุณแนน "` ที่ถูก trim กลายเป็นคนละ partner แล้ว **ตกทั้งใบ**
  (8 แถวในไฟล์ export วันที่ 2026-08-03) ใช้ `cleanName()` ไม่ใช่ `clean()`
  **NBSP/ZWSP ในไฟล์ export เป็นของจริงจากต้นทาง ไม่ใช่บั๊ก** — 32 เซลล์ + 1 เซลล์ ตรงกับ master
  ทุกไบต์ ไล่ normalize ทิ้งแล้วจะไม่แมตช์แทน · gate: `npm run diag:odoo-export` (ถ้ารายงาน
  `(ตรวจ 0 ชื่อ)` แปลว่าด่านผ่านแบบว่างเปล่า อย่าเชื่อ)

- **snapshot ของรายการสินค้ามี whitelist สองชั้น ต้องเพิ่มให้ครบทั้งคู่** — ฝั่งเขียน
  `buildItemSnapshots()` และฝั่งอ่าน `legacyItems` ใน `enrichQuotationData()` (ทั้งคู่ใน
  `quotationService.ts`) เคสจริง 2026-07-24: `linked_to_product_id` มีที่ read แต่ลืมที่ write
  → snapshot เก็บไม่ครบ → อ่านกลับได้ `null` เสมอ → Flex ไม่แสดง badge สินค้าพ่วง **แต่หน้า LIFF
  แสดงปกติ** เพราะใช้ items สดที่ยังไม่ round-trip ⇒ อาการโผล่คนละที่กับสาเหตุ
  เกณฑ์ตัดสิน: field ที่ `buildItemSnapshots()` คำนวณใหม่ได้เอง **ไม่ต้องเพิ่ม** · field ที่เป็น
  ข้อเท็จจริงของบรรทัดนั้นและสร้างใหม่ไม่ได้ **ต้องเพิ่ม** ไม่งั้นหายถาวร

- **เดือนของเลขใบยึด `created_at` (วันที่ร่าง) ⇒ ห้ามเขียนทับ `created_at` ตอนยืนยัน** และ
  `getRecentConfirmedQuotations` ต้องใช้ `updated_at` — สองข้อนี้เป็นคู่กัน ผิดข้อใดข้อหนึ่ง
  แล้ว fallback ของ LIFF round-trip พังเงียบ ๆ · gate: `npm run diag:confirm-race`

- **กฎระงับสต็อกเทียบ `unreserved` กับ "จำนวนที่สั่ง" ไม่ใช่ `actual_quantity <= 0`** และ
  **สินค้าที่ไม่มีแถวใน `product_stock_rules` ต้องเพิ่ม/ปรับจำนวนได้เสมอแม้ของว่าง** —
  client (`product-search.html` / `quote-edit.html`) **ห้ามบล็อกจากสต็อกดิบเด็ดขาด** เพราะ client
  ไม่รู้ว่าสินค้าไหนติดกฎ (เคยพลาดแล้วถอดออกใน `e141cea`) สต็อกบนหน้า LIFF เป็น **badge เตือน
  เท่านั้น** server เป็นด่านจริง · `PUT /api/quotation/:id` ต้องตรวจ **ทุกบรรทัด** ไม่ใช่แค่รายการ
  ที่เพิ่งเพิ่ม (เหมือนที่ min-price ทำอยู่แล้ว) · gate: `diag:stock-rule` + `diag:stock-rule-put`
  + `diag:quote-validation`

- **การจับคู่ลูกค้าแตะแล้วต้องวัด และมีสองชุดที่ตอบคนละคำถาม**
  - `npm run diag:customer-search` (`scripts/diag/customerSearchEval.ts`) — ถามว่า
    **"แก้แล้วลูกค้าที่ระบบเลือกให้ ยังเป็นคนเดิมไหม"** เทียบกับ
    `data/eval/customer_search_baseline.json` · `-- --save` บันทึก baseline ใหม่
    (ทำตอนของยังดีอยู่เท่านั้น) · `-- --refresh-corpus` ดูดคำค้นชุดใหม่ ซึ่ง **ทำให้ผลก่อน/หลัง
    เทียบกันไม่ได้** · มันสร้างสำเนาทดสอบจาก `customerService.ts` ตอนรันแล้วลบทิ้ง จึงไม่มี
    สำเนาโค้ดแช่แข็งให้ทดสอบผิดตัว และจำคำตอบ LLM ไว้ในดิสก์ตาม prompt
  - `tsx scripts/evalCustomerSearch.ts` — ชุดข้อสอบ 54 เคสที่มีเฉลย
    (`--ai` = pipeline เต็ม · ไม่ใส่ = deterministic เร็ว/ฟรี)
    baseline 2026-07-20: AI off 50/54 top-1 · AI on 52/54 · **`wrong-auto-select` ต้องเป็น 0 ตลอด**
    เพราะมันแปลว่าบอทเลือกบริษัทผิดให้เงียบ ๆ
    **`--mine` ทำให้ผลเทียบกันไม่ได้** เพราะ re-mine ชุดเคสใหม่ทั้งชุด — จะเพิ่มเคสให้เติมทั้ง
    `PINNED_CASES` และไฟล์ JSON ตรง ๆ
  สองเคสที่ยังพลาดอยู่แก้ด้วยตรรกะไม่ได้ (หลักฐานเท่ากันทุกไบต์เพราะสาขาพี่น้องใช้รายชื่อผู้ติดต่อ
  ร่วมกัน) — พฤติกรรมที่ปลอดภัยคือไม่ auto-select ซึ่งเป็นสิ่งที่เกิดขึ้นอยู่แล้ว อย่าเสียเวลาไล่

- **`customers_data_view.last_order_at` เป็นชื่อคอลัมน์ที่หลอก** — ไม่ใช่ "วันสั่งซื้อล่าสุด"
  แต่เป็นวันล่าสุดของใบที่ **ออกบิลแล้ว/รอออกบิล** ของนิติบุคคลที่บริษัทนั้นสังกัด และ
  **เฉพาะลูกค้าเครดิต/เช็คล่วงหน้าเท่านั้น** · `NULL` = ไม่เข้าข่ายตรวจ ซึ่งมาได้จาก 3 สาเหตุ
  (ไม่ใช่ลูกค้าเครดิต / เป็นเครดิตแต่ไม่มีใบเลย = ลูกค้าใหม่ / มีใบแต่ยังไม่เคยออกบิล) ทั้งสาม
  ปฏิบัติเหมือนกันคือ **ผ่าน**
  ⇒ **ห้ามเอาคอลัมน์นี้ไปแสดงเป็น "ซื้อครั้งสุดท้ายเมื่อไหร่" ที่อื่น** ลูกค้า Cash ทุกรายจะได้
  `NULL` ทั้งที่ซื้อเป็นประจำ · ขอบเขตการตรวจฝังอยู่ที่ **นิยาม view ที่เดียว** จะเปลี่ยนว่าใครอยู่
  ในขอบเขต ให้แก้ view อย่าเติมเงื่อนไขใน query ของ `creditHoldService.ts`
  · ด่านกฎเป็น **fail-closed**: DB ล่มต้องกลายเป็น "ตรวจไม่สำเร็จ ห้ามออกใบ" ไม่ใช่ "ไม่โดนบล็อก"

- **`district`/`ตำบล` ยังไม่ครบ ~26,730 แถว** ที่มี zip แต่ไม่มีอำเภอ (distinct zip 1,009) —
  อำเภอเติมจาก zip ได้ถ้า import postal table ส่วน **ตำบลเติมจาก zip ไม่ได้** (1 zip หลายตำบล)

---

## ค่าอะไรอยู่ที่ไหน — และทำไมถึงอยู่ตรงนั้น

- **`.env` = สวิตช์ของ deployment** ไม่ใช่ของร้าน — มันอยู่นอก git ดังนั้นไม่มี checkout ไหนได้มัน
  มาจากการ pull **`APP_URL` ไม่มีค่าสำรองโดยตั้งใจ** (`config/appUrl.ts`) ไม่ตั้ง = ตายตั้งแต่ boot
  เพราะทางสำรองแบบ "เดาจาก Host header" เคยทำให้ลิงก์ที่ส่งหาลูกค้าชี้ผิดเครื่องโดยไม่มีใครรู้
  · ห้ามอ่าน `process.env.APP_URL` ตรง ๆ และห้ามใส่ `|| '...'` ที่จุดเรียก
  · ตรวจด้วย `npm run diag:app-url` · บนเครื่อง dev ใช้ `APP_URL=http://localhost:3011`
  (ยอม http เฉพาะ localhost/127.0.0.1)

- **ค่าที่ร้านเปลี่ยนเองอยู่ใน DB และมีหน้าจอให้แก้** — โปรโมชัน กฎราคา MOQ กฎสต็อก กฎบล็อก
  ค่าขนส่ง เกณฑ์เครดิต บัญชีห้ามเสนอราคา ล้วนอยู่ในตารางและแก้ผ่าน Admin Portal
  **ค่าที่เปลี่ยนบ่อยแล้วไปฝังเป็นค่าคงที่ในโค้ดคือค่าที่ร้านแก้เองไม่ได้** — นั่นคือเหตุผลที่
  หลักการข้อ 2 ใน `AGENTS.md` บังคับให้มันลง DB/config

- **LIFF ID ไม่ hardcode** — ดึงจาก `/api/liff/config?page=` เสมอ (ทั้งสามหน้า) เพราะ LIFF ID
  ผูกกับ channel และเปลี่ยนตอนย้าย environment

- **ชื่อโมเดล LLM ไม่ hardcode** — `createChatCompletion()` ตั้ง `thinking: disabled` +
  `temperature: 0` มาให้แล้ว (เร็วกว่าและผลคงที่) จะ override เฉพาะจุดก็ส่ง param เข้ามา

- **ห้าม `COMMENT ON` (COLUMN/TABLE/VIEW/INDEX)** ใน migration หรือยิงเข้า DB เว้นแต่ผู้ใช้สั่งเอง —
  อธิบายด้วย `--` ในไฟล์ migration แทน

- **migration ใหม่ต้องยุบเข้า `migrations/schema.sql` ด้วย** (47 ไฟล์ใน `migrations/changes/`
  ณ 2026-09-12) ไม่งั้น schema เต็มจะค่อย ๆ ล้าสมัยจนตั้ง DB ใหม่จากศูนย์ไม่ได้ — วิธีตรวจอยู่หัวไฟล์

---

## โครงสร้าง — layer `route → handler → service → repository`

```
chatbot/
├── index.ts              # Express entry + route ทั้งหมด (4,531 บรรทัด · 109 route — ใช้ grep)
├── pdfGenerator.ts       # PDF logic ที่เดียวในระบบ
├── config/               # db · clients (LINE+LLM) · auth · jwt · apiLogger · loginRateLimit
│                         # · syncApiAuth · appUrl (ไม่มีค่าสำรอง ตั้งใจ)
├── handlers/lineHandler.ts   # รับ event LINE, คุม flow การสนทนา
├── services/             # business logic — ดูตารางแผนที่งานข้างล่าง
│   └── rules/            # rule engine โปรโมชัน/เงื่อนไข (index · quotationRules · scopeMatch · cache · types)
├── db/
│   ├── repositories.ts   # data-access layer — ทุก SQL ของระบบอยู่ที่นี่
│   ├── logRepositories.ts
│   └── companyIdentity.ts# กติกาการระบุตัวตนบริษัท/ผู้ติดต่อ (ใช้ร่วมหลายที่)
├── utils/                # pricing · promotionValidator · flexTemplates · address
│                         # · deliveryTerms · quotationLink · thaiTime · warranty
├── liff_pages/           # product-search · quote-edit · register (.html) — HTML + Vanilla JS ล้วน
├── migrations/
│   ├── schema.sql        # schema เต็ม (ตั้ง DB ใหม่จากศูนย์ได้จริง — วิธีตรวจอยู่หัวไฟล์)
│   └── changes/          # migration ทีละไฟล์ `YYYY-MM-DD_NN_*.sql`
├── scripts/              # sync/ · diag/ · logworker/ · runMigration · dbDump/dbRestore
│                         # · backfill* · evalCustomerSearch
├── data/sale_sigs/       # ลายเซ็น — ชื่อไฟล์ต้องเป็น {salesperson_id}.png
├── frontend/             # Admin SPA (มี package.json/tsconfig/eslint ของตัวเอง)
└── public/               # build output ของ admin — commit เข้า repo · ห้ามแก้ตรง ๆ
```

**กฎ layer:** route/handler ไม่ยิง SQL เอง → เรียก service · service ดึงข้อมูลผ่าน
`db/repositories.ts` · ตรรกะราคา/สิทธิ์อยู่ใน `utils/` + `services/rules/` ไม่ใช่ใน handler
**ของใหม่ไปไว้ไหน:** SQL → `db/repositories.ts` · business logic → `services/` ·
ตัวช่วยไม่มี state → `utils/` · เงื่อนไขโปรโมชัน → `services/rules/` · ตาราง/คอลัมน์ → migration ใหม่

### แผนที่งาน → เริ่มอ่านที่ไหน

| งานเกี่ยวกับ | เริ่มที่ |
| --- | --- |
| flow การคุยใน LINE | `handlers/lineHandler.ts` |
| ความเร็ว / คิว / ตอบไม่ทัน | `services/webhookQueue.ts` · `index.ts` (`POST /callback`) |
| สกัดคำสั่งซื้อด้วย AI | `services/quoteExtraction.ts` · `config/clients.ts` |
| สร้าง/ยืนยัน/แก้ใบเสนอราคา | `services/quotationService.ts` · `services/quotationAgent.ts` (แก้ใบเดิม) |
| หน้าเว็บ "ขอใบเสนอราคา" | `services/webQuoteService.ts` · `webIdentity.ts` · `chatChannel.ts` · `salespersonPicker.ts` |
| ค้นหา/จับคู่สินค้า/ลูกค้า | `services/productService.ts` · `services/customerService.ts` |
| ราคา / โปรโมชัน | `utils/pricing.ts` · `utils/promotionValidator.ts` · `services/rules/` |
| ห้ามเสนอราคา / เครดิตลูกค้า | `services/blacklistService.ts` · `services/creditHoldService.ts` |
| SQL / ตาราง | `db/repositories.ts` · `migrations/schema.sql` |
| route / API / auth | `index.ts` · `config/auth.ts` · `config/syncApiAuth.ts` |
| Flex message / PDF | `utils/flexTemplates.ts` · `pdfGenerator.ts` |
| log และรายงาน | `config/apiLogger.ts` · `services/apiLogService.ts` · `db/logRepositories.ts` · `routes/logs.ts` · `scripts/logworker/` |
| ส่งออก/นำเข้า Odoo | `services/odooSaleOrderExport.ts` · `services/quotationOdooLink.ts` · `services/syncService.ts` |
| ให้ระบบภายนอกดึงข้อมูล | `services/externalSync.ts` · `docs/SYNC_API.md` |

**หัวไฟล์คือเอกสารจริงของไฟล์นั้น** — `chatChannel.ts` `webIdentity.ts` `quoteExtraction.ts`
`webQuoteService.ts` `salespersonPicker.ts` `externalSync.ts` `quotationOdooLink.ts`
`frontend/src/admin/navHash.ts` ล้วนเขียน "ทำไมถึงเป็นแบบนี้ / ทางที่ไม่ได้เลือก" ไว้ในหัวไฟล์แล้ว
อ่านก่อนแก้ และเขียนต่อในรูปแบบเดียวกันเมื่อสร้างไฟล์ใหม่

---

## ดัชนีเอกสาร

หัวข้อที่ยาวอยู่ในไฟล์ของตัวเอง เปิดอ่านเฉพาะไฟล์ที่เกี่ยวกับงานตรงหน้า

- **`AGENTS.md`** — กฎ git · หลาย session ในทรีเดียว · ขอบเขตการอนุมัติ · ด่าน verify
- **`docs/design.md`** — กติกาหน้าตาของสี่พื้นผิว (Admin · LIFF · Flex · PDF)
- **`DEPLOY.md`** — Docker, LINE webhook, กฎ LIFF ต้องอยู่ provider เดียวกับ Messaging API channel,
  กู้รหัสผ่านแอดมิน, พ.ร.บ.คอมพิวเตอร์ ม.26, แก้ปัญหาเบื้องต้น
- **`README.md`** — โครงสร้างละเอียด: endpoint ทั้งหมด, schema, business logic รายบริการ
- **`docs/SYNC_API.md`** — API ให้ระบบภายนอกดึงข้อมูล (3 โหมด sync และเกณฑ์เลือก)
- **`docs/plan-web-quote-request.md`** — หน้าเว็บขอใบเสนอราคา เฟส A–D (แผนยาว อ่านเฉพาะหัวข้อที่ตรงงาน)
- **`docs/plan-product-block-rules.md`** — กฎบล็อกสินค้า
- **`docs/plan-logging-audit-compliance.md`** — ระบบ log / audit / ข้อกำหนดตามกฎหมาย
- **`docs/plan-user-roles-auth.md`** — สิทธิ์ผู้ใช้และการยืนยันตัวตน
