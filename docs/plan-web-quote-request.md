# แผนงาน: หน้าเว็บขอใบเสนอราคาสำหรับ admin/subadmin (วางข้อความเหมือนคุยใน LINE)

> **สถานะ: v5 — เปลี่ยนสถาปัตยกรรมเป็น form-first · ✅ เฟส B เสร็จแล้ว · เฟส A กลายเป็นโค้ดที่ไม่มีใครเรียก · ถัดไปคือเฟส C′**
> v1 สำรวจจากโค้ดจริง + วัดกับ DB จริง 2026-09-04 · v2–v3 สำรวจ/วัดเพิ่ม + ตัดสินใจ 2026-09-07
> · v4 แบ่งเฟสเพื่อสลับเครื่อง dev ↔ server 2026-09-07
> · **v5 เจ้าของสั่งเปลี่ยนเป็นหน้าเดียวแบบฟอร์ม ไม่จำลองแชท LINE 2026-09-08 — อ่าน §0 ก่อนทุกอย่าง**
>
> **✅ เงื่อนไข "รอ `plan-product-block-rules.md`" ผ่านแล้ว** — แผนนั้นจบครบ 5 เฟสและขึ้น production
> 2026-09-07 (commit `413a721` บน `main`) ⇒ แผนนี้เริ่มได้
>
> 📘 **งานจริงทำเป็นเฟส ไม่ใช่ทำรวด — อ่าน §6.0 ก่อนลงมือทุกครั้ง**
> ที่นั่นมีตารางสถานะเฟส · คำสั่งตรวจว่า "เครื่องที่กำลังนั่งอยู่นี้ตามถึงไหนแล้ว" · และรายการส่งมอบ

> ## ✅ ลำดับงาน — แผนนี้ทำ *หลัง* `plan-product-block-rules.md` — **เงื่อนไขผ่านแล้ว**
>
> ตัดสินใจ 2026-09-07: ทำ [plan-product-block-rules.md](plan-product-block-rules.md) ให้จบทั้ง 5 เฟสก่อน
> — **จบแล้วและขึ้น production เมื่อ 2026-09-07** (`413a721`) ⇒ ข้อจำกัดนี้ไม่มีผลอีกต่อไป
> เก็บเหตุผลไว้เป็นบันทึกว่าทำไมลำดับต้องเป็นแบบนี้:
> * แผนนั้นเล็กกว่า ~3 เท่า และแต่ละเฟสขึ้นเดี่ยว/ย้อนกลับได้ (เฟส 1 ไม่เปลี่ยนพฤติกรรมเลย)
> * แผนนั้นยุบ **นิยาม "ถูกบล็อก" ที่ตอนนี้มี 2 แบบ** (`findBlockingRule` filter-ก่อน-match
>   vs `resolveQuotationRule` resolve-แล้วดูตัวชนะ — ดู plan-product-block-rules §1.3)
>   ให้เหลือคำตอบเดียว · ต้องนิ่งก่อนที่แผนนี้จะเอาโหมด advise ไปแปลงการบล็อกเป็นคำเตือน
> * กฎบล็อกระดับ `internal_reference` อาจไปโดนสินค้าค่าขนส่ง `SOFBLDXXXX0010` — และแผนนี้
>   ทำให้บรรทัดค่าขนส่ง (ref เดียวกันนั้น) **ถูกสั่งให้มีอยู่ในใบได้เสมอ** แม้ยอดถึงเกณฑ์
>   ⇒ guard "ข้าม `is_shipping_fee`" ของแผนนั้นต้องมีอยู่ก่อน ไม่งั้นกฎบล็อกระดับ ref
>   ตัวเดียวจะทำให้ใบที่มีค่าขนส่งออกไม่ได้ทั้งใบ
> * ลดแรงเสียดทานตอน merge ใน 3 ไฟล์ที่ทั้งสองแผนแตะ:
>   `services/quotationService.ts` (คนละบริเวณ) · กลุ่ม route `/api/admin/*` ใน `index.ts` · `AdminApp.tsx`

## 0. v5 — เปลี่ยนเป็น form-first (ตัดสินใจ 2026-09-08)

> **อ่านหัวข้อนี้ก่อนหัวข้ออื่นทั้งหมด** — §1–§5 (ตัวตนพร็อกซี · โหมด advise · override · ผู้ติดต่อใหม่)
> ยังใช้ได้ทั้งหมดไม่มีอะไรเปลี่ยน · สิ่งที่เปลี่ยนคือ **รูปหน้าเว็บ** และ **วิธีต่อกับของเดิม**

### 0.1 โจทย์ที่เจ้าของสั่ง

หน้าออกใบเสนอราคาของแอดมินคือ **หน้าเดียว** ที่มี

1. ช่องพิมพ์ข้อความขอใบเสนอราคา (วางข้อความยาว ๆ แบบที่เซลส์พิมพ์ใน LINE)
2. ฟอร์มร่างใบที่ระบบสกัดมาให้ — แก้ข้อมูลลูกค้า/ผู้ติดต่อ/เงื่อนไข และ **เพิ่ม-ลบ-แก้สินค้า** ได้
   คล้าย [`liff_pages/quote-edit.html`](../liff_pages/quote-edit.html)
3. สั่ง **revise** ใบที่ยืนยันไปแล้วได้ในหน้าเดียวกัน

และ **ไม่ต้องการให้เกี่ยวข้องกับ LINE เลย** — วิ่งผ่าน frontend → backend → AI เท่านั้น

### 0.2 ทำไม v4 ถึงไม่ตอบโจทย์นี้

v4 ออกแบบให้หน้าเว็บ **จำลองบทสนทนา LINE**: เรียก `handleEvent` ผ่าน capture client แล้วเอา
Flex message ที่ได้มาเรนเดอร์เป็น HTML · ความกำกวมของรุ่นสินค้าตอบด้วย "การ์ดให้กดเลือก" ·
การแก้ใบลิงก์ออกไปหน้า `/web/quote-edit` อีกหน้าหนึ่ง

ปัญหาคือ **โมเดลแชทกับโมเดลฟอร์มขัดกันโดยธรรมชาติ**:

| เรื่อง | แบบแชท (v4) | แบบฟอร์ม (v5 — ที่ต้องการ) |
| --- | --- | --- |
| รุ่นกำกวม | การ์ด + ปุ่มกดเลือกทีละรายการ → ต้องจำ state `pending_product` ใน DB | **dropdown ในแถวสินค้า** เลือกแล้วจบ ไม่ต้องมี state |
| บริษัทซ้ำ | การ์ดเลือกบริษัท → state `pending_company` | dropdown ในฟอร์ม |
| แก้ใบ | ลิงก์ออกไปอีกหน้า (`/web/quote-edit`) | อยู่ในหน้าเดียวกัน |
| ผลลัพธ์ที่ backend คืน | Flex JSON ที่ต้องแปลงกลับเป็น UI | **ข้อมูลดิบ** ให้ frontend เรนเดอร์เอง |

v4 ถึงกับมีขั้นตอน *ย้อนความเป็น LINE ออก* อยู่ในตัวเอง (ขั้น 3: "แปลง action ที่เป็น `uri`
ชี้ `liff.line.me/...` → `/web/quote-edit?...`") ซึ่งเป็นสัญญาณว่ากำลังฝืนโครงสร้าง

### 0.3 สิ่งที่ตรวจแล้วว่า **ไม่ผูกกับ LINE อยู่แล้ว** — ใช้ได้เลย ไม่ต้องแก้อะไร

ตรวจโค้ดจริง 2026-09-08:

* **วงจร ร่าง → แก้ → ยืนยัน → PDF ไม่มี LINE เลย** — `index.ts` ช่วง 880–1320
  (`PUT /api/quotation/:id` · `POST /api/quotation/:id/confirm` · `/cancel`)
  **ไม่มี `lineClient` / `replyMessage` / `pushMessage` แม้แต่ตัวเดียว** · ตัว confirm log ว่า `[Push Disabled]`
* [`liff_pages/quote-edit.html`](../liff_pages/quote-edit.html) (4,120 บรรทัด) ขับทั้งวงจรผ่าน REST 9 เส้นนี้อยู่แล้ว
  — LIFF ในหน้านั้นถูกใช้แค่เรื่อง *ตัวตน* ไม่ได้ใช้ส่งข้อความ:
  `/api/quotations` · `/api/quotations/delivery-preview` · `/api/quotation/:id` (PUT) ·
  `/api/quotation/:id/cancel` · `/api/products/search` · `/api/products/:code/blocked` ·
  `/api/customers/search` · `/api/customer/:id/contacts` · `/api/shipping-fee/config`
* **ตรรกะธุรกิจอยู่ใน service หมดแล้ว** — `quotationService`: `processQuotationRequest` ·
  `insertDraftQuotations` · `validateQuotationItems` · `confirmQuotationAtomic` · `enrichQuotationData` ·
  `resolveContactFlow` · `buildItemSnapshots` · `cancelOldRevision` · บวก `customerService` ·
  `productService` · `shippingFee` · `rules/*` · `pdfGenerator` · `odooSaleOrderExport`
  — ทั้งหมดไม่รู้จัก LINE
* **revise ก็เป็น service แล้ว** — [`quotationAgent.handleQuotationEditRequest()`](../services/quotationAgent.ts#L79)
  ทำครบ: หาใบที่ใช้งานอยู่ → `validateQuotationItems` → ยกเลิกร่างค้าง → คัดลอกเป็นร่าง revision
  ด้วย `appendReviseFrom` · แกนจริงราว 40 บรรทัดใช้แต่ service **ติดแค่บรรทัดสุดท้ายที่คืนค่าเป็น Flex**

⇒ หน้าใหม่เรียกของพวกนี้ได้ตรง ๆ **โดยไม่ต้องผ่าน `handleEvent` เลย**

### 0.4 จุดเดียวที่ต้องแตะของเก่า — ย้ายตัวสกัดออกมาเป็น service

สิ่งเดียวที่หน้าใหม่ต้องใช้แล้ว **ยังฝังอยู่ใน `handleEvent`** คือ "ข้อความดิบ → ร่างใบ"
วัดขอบเขตจริงใน [`handlers/lineHandler.ts`](../handlers/lineHandler.ts):

| ช่วง | เนื้อหา | เว็บต้องใช้ไหม |
| --- | --- | --- |
| 1524–1556 | ประกอบ `historyContext` จาก `getRecentMessages` (15 นาทีล่าสุด + ตัดที่ยกเลิก/ยืนยัน) | ✅ ใช้ (บริบทของบทสนทนาเดียวกัน) |
| 1557–1638 | **prompt สกัด ~80 บรรทัด** รวมกฎ 15 ข้อ + กฎเหล็กห้ามเดารุ่น | ✅ ใช้ |
| 1639–1710 | `parseAiJson` ทนทาน + retry 3 ครั้งผูกกับงบเวลา + fallback `UNCLEAR` | ✅ ใช้ |
| 1712–1720 | branch `REGISTER` → Flex เลือกสาขา | ❌ ไม่ใช้ (แอดมินไม่ลงทะเบียนผ่านหน้านี้) |
| 1722–1801 | `findProduct` ทุกรายการ + ซ่อมรหัสที่ถูกตัดบรรทัด + สร้าง `slots` | ✅ ใช้ |
| 1802 เป็นต้นไป | ตัดสินใจส่ง Flex เลือกรุ่น / `processQuotationRequest` → Flex สรุป | ❌ ไม่ใช้ (เว็บเรนเดอร์เอง) |

**รวมที่ต้องใช้ร่วมกัน ≈ 265 บรรทัด** (ไม่ใช่แค่ prompt) — `buildResolvedItem()` ที่บรรทัด 86
เป็น helper ระดับโมดูลอยู่แล้วและบริสุทธิ์ ย้ายไปด้วยได้

> **ตัดสินใจ 2026-09-08: ย้ายออกเป็น `services/quoteExtraction.ts` ให้ทั้ง LINE และเว็บเรียกร่วมกัน**
> ไม่ copy ไปไฟล์ใหม่ — prompt คือสมองของระบบ มีสองชุดเมื่อไหร่ วันหนึ่งจะแก้ไม่ครบแล้วเพี้ยน
> เงียบ ๆ โดยไม่มี error · เป็นการ "ย้ายล้วน" พฤติกรรมต้องเท่าเดิมทุกบิต
> `lineHandler` เหลือแค่เรียก 1 ครั้งแล้วเอา `slots` ไปเรนเดอร์ Flex เหมือนเดิม
>
> **ด่านที่คุมการย้ายนี้:** `diag:extraction-reliability` · `diag:customer-search` (ก่อน–หลัง) ·
> `diag:queue-sim` · และ **ยิงข้อความจริงใน LINE 1 รอบ** — รอบนี้ด่าน LINE *จำเป็นจริง*
> เพราะเป็นการผ่าตัดทางเดินหลักของบอท ไม่ใช่แค่เปลี่ยนชื่อตัวแปรแบบเฟส A

### 0.5 สิ่งที่หายไปจาก v4

* **ไม่ต้องมี `services/webChatService.ts`** ที่ประกอบ event ปลอมแล้วเรียก `handleEvent`
* **ไม่ต้องมี `FlexRenderer`** ฝั่ง frontend
* **ไม่ต้องมี `/web/quote-edit`** และ shim ของ `window.liff` — ฟอร์มอยู่ในหน้าเดียวกันแล้ว
* **ไม่ต้องมี state machine** `pending_product` / `pending_company` สำหรับเส้นทางเว็บ
  (ยังอยู่ครบสำหรับ LINE ไม่ถูกแตะ)
* **เฟส A กลายเป็นโค้ดที่ไม่มีใครเรียก** — `services/chatChannel.ts` + `opts.client` ใน `handleEvent`
  ถูกเขียนไว้เพื่อฉีด capture client ซึ่ง v5 ไม่ใช้แล้ว
  ⇒ ปล่อยไว้ก็ไม่มีผล (ค่าปริยายเท่าของเดิม) แต่ **ควรถอยออกตอนเฟส J** เพื่อไม่ให้เหลือทางเข้าที่ไม่มีใครใช้

### 0.6 สิ่งที่ **ไม่** เปลี่ยนจาก v4

* **§2 ตัวตนพร็อกซี ยังจำเป็นเต็ม ๆ** — `quotations.user_id` มี FK ไป `salesperson` ·
  ช่อง H = เซลส์ / ช่อง J = แอดมิน · `web:` prefix ยังเป็นสวิตช์ของ §3–§5 ทั้งหมด
  ⇒ **เฟส B ที่ทำเสร็จแล้วยังใช้ได้ทั้งก้อน ไม่ต้องแก้**
* §3 โหมด advise · §4 override เครดิต/ค่าขนส่ง · §5 ผู้ติดต่อใหม่ — ห้อยกับ `user_id LIKE 'web:%'`
  เหมือนเดิมทุกข้อ ไม่เกี่ยวกับว่า UI เป็นแชทหรือฟอร์ม

---

## วิธีทำงานของแผนนี้ (dev → server)

* **เครื่อง dev** (`C:\Users\bcozf\Downloads\chatbot`) ทำงานบน **branch `dev`** เท่านั้น
  ก่อนแตกงานทุกครั้ง `git pull` ให้เท่า `origin` ก่อน (ดูบันทึก *Dev branch workflow*)
* **merge เข้า `main` และ deploy ทำที่ server** — แผนนี้จึงต้องส่งมอบเป็น commit บน `dev` ที่ merge ได้สะอาด
* **แตกงานย่อยหลายสายพร้อมกันได้บน branch `dev` เดียวกัน แต่ต้องแยกเป็น `git worktree` คนละอัน**
  — ตัวที่ต้องแยกคือ *working directory* ไม่ใช่ branch · ห้ามให้ 2 สายแชร์ checkout เดียวกัน
  (เคสจริง: agent 2 สายใน checkout เดียว amend/rebase ทับกันแล้วงานที่ยังไม่ commit หายเงียบ)
* ด่านตรวจในกล่อง (docker/compose) เป็นเงื่อนไข**ตอน deploy** — ระหว่างพัฒนา verify บน dev local พอ
* 📘 **งานถูกแบ่งเป็น 10 เฟส (A–J) เพื่อให้หยิบ/วางสลับเครื่องได้ — ดู [§6.0](#60-แผนที่เฟส--หน่วยส่งมอบเวลาสลับเครื่อง-dev--server)**
  ที่นั่นมีตารางเฟส · ลำดับที่บังคับ · **probe SQL ตรวจว่า DB ของเครื่องที่นั่งอยู่ตามถึงไหน** ·
  รายการก่อนเริ่ม/ก่อนวางมือ · และกับดักที่เกิดเฉพาะตอนสลับเครื่อง

---

## หลักการออกแบบของแผนนี้ (ยึดตามเดิม)

> **requirement เปลี่ยนตลอดเวลา ⇒ ทุกความสามารถใหม่ต้องอยู่ใน service/module แยก
> ที่ถอดออกแล้วระบบเดิมกลับมาเหมือนเดิมเป๊ะ**

แปลเป็นกติกาที่ตรวจได้:

1. **ความรู้ใหม่อยู่ในไฟล์ใหม่** — ไฟล์เดิมได้แค่ "จุดต่อ" (hook) ที่นับบรรทัดได้
2. **ทุกจุดต่อต้องมีค่าปริยายที่ให้ผลเท่าของเดิมทุกบิต** — ไม่ส่งพารามิเตอร์ใหม่ = พฤติกรรมเดิม
3. **แยกโหมดด้วยข้อมูล ไม่ใช่ด้วย flag ทั่วระบบ** — ทุกอย่างในแผนนี้ห้อยกับ `user_id LIKE 'web:%'`
   ซึ่งเป็นค่าที่มีอยู่ในแถวอยู่แล้ว ⇒ ใบของ LINE ไม่มีทางเข้าเส้นทางใหม่ได้เลยแม้แต่ทางเดียว
4. **ตารางใหม่ผูก `ON DELETE CASCADE` กับ `quotations`** — วงจรชีวิตตามร่างเสมอ ไม่ต้องเขียนโค้ดเก็บกวาด

---

## สรุปสำหรับตัดสินใจ (อ่านหน้านี้พอ)

**จะทำ (v5):** แท็บใหม่ใน Admin Portal — **หน้าเดียว** ที่ admin/subadmin
**วางข้อความชุดเดียวกับที่เซลส์พิมพ์ใน LINE** → ระบบสกัดเป็น **ฟอร์มร่างที่แก้ได้ทุกช่อง**
(เพิ่ม-ลบ-แก้สินค้า · เลือกรุ่นที่กำกวมจาก dropdown · เลือกบริษัท/ผู้ติดต่อ) → กดยืนยัน → ได้เลขที่ + PDF
· **revise ใบเก่าได้ในหน้าเดียวกัน**

ไหลเข้า pipeline เดิมทั้งเส้น (LLM สกัด → `findProduct` → `processQuotationRequest` →
`confirmQuotationAtomic`) แต่ **ไม่ผ่าน `handleEvent` และไม่มี Flex** — ดู §0

**สิ่งที่ต่างจาก LINE (ขอบเขตใหม่ของ v2):**

| # | ความสามารถ | กลไก |
| --- | --- | --- |
| 0 | **ไม่ถูกบล็อกใด ๆ** — กฎทุกข้อกลายเป็น "คำเตือน" แต่ทำรายการต่อได้เต็มรูปแบบ · บันทึกไว้ดูย้อนหลังได้ | `services/quotePolicy.ts` (โหมด `advise`) + ตาราง `quotation_issue_warnings` |
| 1 | **แก้เครดิตของลูกค้าได้** เขียนทับใน snapshot ของใบนั้น ๆ | ตาราง `quotation_overrides` + `services/quoteOverrides.ts` |
| 2 | **บรรทัด "ค่าขนส่ง" (1 บรรทัดเหมือนเดิม)** — สั่งมี/ไม่มีเองได้ + เขียนทับชื่อได้อิสระ + จำชื่อไว้เป็น dropdown | `shipping_mode='force_on'/'force_off'` + ตาราง `shipping_fee_name_presets` |
| 3 | **เพิ่มผู้ติดต่อใหม่ใต้บริษัทที่มีอยู่แล้ว** (ห้ามสร้างบริษัทใหม่) | ตาราง `local_contacts` + **Arm 3** ใน `customers_data_build` |

**หัวใจของแผน 3 ข้อ:**

1. **แยกของที่ใช้ร่วมกันออกมา ไม่ใช่ยืมทั้งก้อน** (เปลี่ยนจาก v4) — วงจร ร่าง→แก้→ยืนยัน→PDF
   **ไม่ผูกกับ LINE อยู่แล้ว** (พิสูจน์ใน §0.3) · ของที่ยังติดอยู่ใน `handleEvent` มีชิ้นเดียวคือ
   "ข้อความดิบ → ร่างใบ" (~265 บรรทัด) ⇒ **ย้ายออกเป็น `services/quoteExtraction.ts`**
   ให้ LINE กับเว็บเรียกร่วมกัน · ที่เหลือของหน้าใหม่เป็นไฟล์ใหม่ล้วน

2. **ตัวตนพร็อกซี (proxy identity)** — แอดมินไม่ใช่ **ผู้ขาย (Odoo ช่อง H)** แต่เป็น
   **ผู้จัดทำใบ (Odoo ช่อง J `employee_quotations`)** ซึ่งเป็นบทบาทที่มีอยู่จริงในข้อมูล Odoo อยู่แล้ว
   ⇒ บังคับเลือก **ออกในนามเซลส์** ทุกครั้ง แล้วสร้างแถว `salesperson` พร็อกซี (หัวข้อ 1.3 + 2)

3. **`user_id` เป็นสวิตช์เดียวของทุกความสามารถใหม่** — ทั้งโหมดไม่บล็อก, override เครดิต,
   ค่าขนส่งอิสระ ล้วนตัดสินจาก `user_id LIKE 'web:%'` ซึ่ง**เป็นไปไม่ได้**สำหรับ LINE
   (LINE user id ขึ้นต้นด้วย `U` + hex 32 ตัวเสมอ) ⇒ พิสูจน์ได้ว่าไม่กระทบของเดิมโดยไม่ต้องรัน
   · **ข้อยกเว้นเดียว: ขั้น 6c (ตรึงทีมขาย)** ซึ่งเป็นการแก้ปัญหาที่ flow ผู้ติดต่อใหม่ทำให้โผล่
   และจงใจให้มีผลกับทุกใบ — แยก commit ไว้ต่างหาก (§5.7)
   · ส่วนเฟส C (ย้ายตัวสกัด) ไม่ใช่ข้อยกเว้นของกติกานี้ เพราะ**ตั้งใจให้ผลลัพธ์เท่าเดิมทุกบิต**
   แต่เป็นเฟสที่ต้องพิสูจน์ด้วยการยิงจริง ไม่ใช่พิสูจน์ด้วยการอ่านโค้ด

**ตารางนี้ปรับเป็น v5 แล้ว** — เรียงตามเฟสของ §6.0

| เฟส | ทำอะไร | เปลี่ยนพฤติกรรมของเดิมไหม |
| --- | --- | --- |
| B | คอลัมน์ `admin_users.employee_quotation_id` + ตัวตนพร็อกซี + route `makers`/`me` | ❌ ไม่ (คอลัมน์ใหม่ไม่มีใครอ่านนอกหน้าใหม่) |
| **C** | **ย้ายตัวสกัดออกเป็น `quoteExtraction`** (~265 บรรทัดจาก `lineHandler`) | ⚠️ **ตั้งใจให้ไม่เปลี่ยน แต่เป็นการผ่าตัดทางเดินหลักของบอท** ⇒ ด่าน LINE จริง 3 เคส (§6.0) |
| D | `webQuoteService` + route `/api/admin/webquote/*` | ❌ ไม่ (ไฟล์ใหม่ · คิวแยก ไม่แย่ง slot LINE) |
| E | หน้า React หน้าเดียว (ฟอร์ม) | ❌ ไม่ (frontend ล้วน) |
| F | **โหมด advise** (`quotePolicy`) — กฎกลายเป็นคำเตือน + **บันทึกคำเตือนถาวรตอนยืนยัน** | ❌ ไม่ (ไม่ส่ง `userId`/`warnings` = เหมือนเดิม) |
| G | **`quotation_overrides`** — เครดิต + สั่งมี/ไม่มีบรรทัดค่าขนส่ง | ❌ ไม่ (ไม่มีแถว = ไม่ทำอะไร) |
| **H** | **ตรึงทีมขาย (คอลัมน์ I) ตอนยืนยันใบ** | ⚠️ **ใช่ — กระทบใบ LINE ด้วยโดยตั้งใจ** (§5.7) |
| I | **`local_contacts` + Arm 3** + รายการงานค้างคีย์ Odoo + pre-flight ตอน export | ❌ ไม่ (ตารางว่าง = view ให้ผลชุดเดิมเป๊ะ) |
| J | ตัวกรอง "ออกจากเว็บ / ออกจาก LINE" + **ป้าย "⚠️ ข้ามกฎ N ข้อ"** ในหน้าประวัติ | ❌ ไม่ (ค่าตั้งต้น `all` = ผลเหมือนเดิม) |
| K | ถอยเฟส A ออก + เอกสาร | ❌ ไม่ (ถอนโค้ดที่ไม่มีใครเรียก) |

> **v5 มี 2 เฟสที่แตะเส้นทาง LINE คือ C กับ H** — ที่เหลือเป็นไฟล์ใหม่ที่ LINE ไม่รู้จัก
> (v4 มีเฟสเดียวคือ 6c เพราะมันเลือกทาง "ยืมโค้ดเดิมทั้งก้อน" แทนที่จะ "แยกของที่ใช้ร่วมกันออกมา")

---

## 1. ของเดิมอยู่ตรงไหน

### 1.1 เส้นทางข้อความจาก LINE

```
POST /callback  (index.ts:185)
  └─ line.middleware  → res.sendStatus(200) ทันที
  └─ webhookQueue.push(userId, ...)          services/webhookQueue.ts  KeyedTaskQueue(12)
       └─ replyBudget(receivedAt) → งบที่เหลือ (BUDGET_MS = 48s)
       └─ runWithDeadline(remaining, signal → handleEvent(event, {deadlineAt, signal}))
            └─ handlers/lineHandler.ts:300  handleEvent()
                 ├─ getSalespersonByUserId(userId)         ← ด่านลงทะเบียน (status ต้อง 'active')
                 ├─ postback: confirm / cancel / select_company / select_product / edit_*
                 ├─ text: ดึง history 10 แถวจาก messages (15 นาทีล่าสุด) → prompt → LLM
                 │    └─ intent QUOTATION → deletePendingQuotations(userId)
                 │         → findProduct() ต่อรายการ → slots
                 │         → processQuotationRequest(userId, cust, contact, items, salesperson)
                 │         → getQuotationSummaryMessage(quotes) → การ์ดสรุป
                 ├─ insertMessage(...)                      ← บันทึกประวัติ
                 └─ lineClient.replyMessage({replyToken, messages})   ← จุดผูกกับ LINE จุดเดียว
```

### 1.2 ตารางที่เกี่ยวข้อง

| ตาราง | เรื่องที่ต้องรู้ |
| --- | --- |
| `salesperson` | PK = `user_id` (LINE user id) · `status` ทำหน้าที่ 2 อย่าง: สถานะลงทะเบียน **และ** state machine ของบทสนทนา (`edit_*`, `custom_quote:*`) · `salesperson_id` = รหัสพนักงาน = **ชื่อไฟล์ลายเซ็น** · **ไม่มี unique constraint บน `salesperson_id`** ([index.ts:2198](../index.ts#L2198) เตือนแต่ไม่บล็อก) |
| `quotations` | **`id` เป็น `uuid`** · `user_id` มี **FK → salesperson(user_id)** (ON DELETE SET NULL) · `employee_details` / `customer_details` / `item_details` = snapshot ที่ตรึงตอนสร้างร่าง · วัด 2026-09-07: **1,458 ใบ · `user_id IS NULL` 0 แถว** |
| `messages` | ประวัติแชท ไม่มี FK · key ด้วย `user_id` |
| `customers_data_view` | **ตารางจริง** (ไม่ใช่ matview) สร้างใหม่ทั้งก้อนจาก view `customers_data_build` ทุกรอบ sync · วัด 2026-09-07: **82,512 แถว** (`source='odoo'` 78,206 · `source='saleorder'` 4,306) · `max(contact_id)=1,031,893` · `max(company_id)=1,031,892` |

### 1.3 ชื่อคน 2 ช่องที่ไม่ใช่คนเดียวกัน — **นี่คือหัวใจของแผนนี้**

ระบบเก็บ "คน" ที่เกี่ยวกับใบเสนอราคาไว้ **2 ช่อง คนละความหมาย** และ Odoo ก็แยกสองช่องนี้เหมือนกัน:

| ช่อง | ความหมาย | ในตาราง `salesperson` | Odoo (ตอน export) | ตัวอย่างจริง |
| --- | --- | --- | --- | --- |
| **H `salesperson`** | เซลส์เจ้าของลูกค้า (ผู้ขาย) | `name` | `sale_orders.salesperson` | `คุณกวินภพ(PM)` |
| **J `employee_quotations`** | **ผู้จัดทำใบเสนอราคา** | `employee_quotation_id` | `sale_orders.employee_quotations` | `กวินภพ เขียววงษ์(PM)` |

> ทั้งสองช่องเก็บใน DB **ไม่มี** `(PM)`/`(THT)` ห้อยท้าย — `withCompanySuffix()` เติมให้ตอน export
> ตามเลขที่ใบ ([odooSaleOrderExport.ts:319-328](../services/odooSaleOrderExport.ts#L319))

**วัดจากข้อมูลจริง (2026-09-04, `sale_orders WHERE invoice_status='invoiced'`):**

* ชื่อผู้จัดทำ (J) ที่ตัดวงเล็บสังกัดออกแล้ว = **70 ชื่อ** · เคลื่อนไหวใน 365 วันล่าสุด = **53 ชื่อ**
* ในจำนวนนี้ตรงกับ `salesperson.employee_quotation_id` (เซลส์ที่ลงทะเบียนใช้บอท) แค่ **29 ชื่อ**
* ⇒ **อีก ~41 ชื่อคือฝ่ายในสำนักงาน/แอดมิน** ที่เป็นคนคีย์ใบให้เซลส์ และเป็นกลุ่มที่มียอดสูงสุด
  (ยุพาทิพย์ ผลรัก 20,942 ใบ · จุฑามาศ ใช้อู๋ 19,983 · นิษา คงแก้ว 18,592 — ทั้งหมดไม่ได้อยู่ในตาราง `salesperson`)

⇒ **กระบวนการ "แอดมินคีย์ใบให้เซลส์" มีอยู่จริงใน Odoo อยู่แล้ว และเป็นเส้นทางหลักด้วยซ้ำ**
หน้าเว็บนี้แค่ทำให้มันเกิดในระบบบอทได้ — ไม่ได้ประดิษฐ์รูปแบบใหม่

### 1.4 ชื่อ/ลายเซ็นไหลไปไหนบ้าง

| ปลายทาง | อ่านจากไหน | ได้ของใคร |
| --- | --- | --- |
| ชื่อบน PDF | `employee_details.saleperson` (snapshot) | เซลส์เจ้าของ (H) |
| **ลายเซ็นบน PDF** | ไฟล์ `data/sale_sigs/{salesperson_id}.png` — [pdfGenerator.ts:308-320](../pdfGenerator.ts#L308) ใบร่างอ่านสดจาก `user_id` / ใบออกเลขแล้วอ่าน snapshot ([index.ts:1548-1574](../index.ts#L1548)) | เซลส์เจ้าของ (H) |
| Odoo ช่อง H | `employee_details.saleperson` + ห้อยสังกัด | เซลส์เจ้าของ |
| **Odoo ช่อง J** | join **สด** `salesperson.employee_quotation_id` ตาม `q.user_id` — [index.ts:3279](../index.ts#L3279) · **ไม่มีใน snapshot** | **ผู้จัดทำ** |
| หน้าประวัติใบเสนอราคา | `COALESCE(s.name, employee_details->>'saleperson')` | เซลส์เจ้าของ |

> **ช่อง J ไม่ได้ถูก snapshot — ต่างจากช่องอื่นทั้งหมด**
> `employee_details` ที่ตรึงตอนสร้างร่างมีแค่ 3 ช่อง `{ salesperson_id, saleperson, sale_phone }`
> ([quotationService.ts:538](../services/quotationService.ts#L538)) · ช่อง J จึงมาจาก `LEFT JOIN salesperson`
> สด ๆ ตอน export โดยไม่มี snapshot ให้ถอย ([odooSaleOrderExport.ts:325-329](../services/odooSaleOrderExport.ts#L325))
>
> **เป็นเจตนาเดิม ไม่ใช่ของหลุด** — เป็นทางเดียวที่แอดมินเติม `employee_quotation_id` ย้อนหลัง
> ให้คนที่ยังไม่เคยกรอกแล้วใบเก่าที่ยังไม่ export ได้ค่าตามไปด้วย
> (เทียบคอมเมนต์ที่ `PUT /api/admin/salespersons` — [index.ts:2171](../index.ts#L2171))
>
> **ผลกับหน้าเว็บ:** แถวพร็อกซีถูก refresh ทุก request ⇒ ถ้าแอดมินเปลี่ยนชื่อผู้จัดทำของตัวเองภายหลัง
> ใบเก่าของคู่ (admin × เซลส์) นั้น **ที่ยังไม่ export** จะเปลี่ยนช่อง J ตามไปด้วย — พฤติกรรมประเภทเดียวกับ
> ที่เกิดกับเซลส์ใน LINE อยู่แล้ววันนี้ จึงไม่ใช่ของใหม่ แต่ต้องรู้ไว้

### 1.5 การบล็อกของเดิมอยู่ตรงไหนบ้าง (ฐานของฟีเจอร์ 0)

สำรวจครบทุกจุด 2026-09-07:

| # | จุด | ทำอะไร | v2 ทำอย่างไร |
| --- | --- | --- | --- |
| 1 | `validateQuotationItems()` — [quotationService.ts:1090](../services/quotationService.ts#L1090) | ด่านเดียวของทั้งระบบ · คืน `violations[]` 7 ชนิด (`BLOCKED` / `OUT_OF_STOCK` / `MOQ_VIOLATION` / `MIN_PRICE_VIOLATION` / `CUSTOMER_BLACKLISTED` / `CUSTOMER_CREDIT_HOLD` / `SYSTEM_ERROR`) | **ลดชั้นเป็นคำเตือน** เมื่อ `userId` เป็น `web:%` |
| 2 | 8 call site ที่ปฏิเสธเมื่อ `violations.length > 0` | draft / save (422) / confirm (422) / revision | ไม่ต้องแตะ — ด่านคืน `violations: []` ให้เอง |
| 3 | `getQuotationSummaryMessage()` — [flexTemplates.ts:1176](../utils/flexTemplates.ts#L1176) | ซ่อนปุ่ม "✅ ยืนยัน" เมื่อ blacklist / credit hold / ต่ำกว่าราคาขั้นต่ำ / ยังไม่ผูกลูกค้า | **แสดงกล่องเตือน *คู่กับ* ปุ่มยืนยัน** เมื่อใบเป็นของเว็บ |
| 4 | `isCustomerInfoIncomplete()` — [flexTemplates.ts:622](../utils/flexTemplates.ts#L622) | ยังไม่ผูกบริษัท/ผู้ติดต่อ = ยืนยันไม่ได้ (`index.ts:1210` ตอบ 400) | **คงไว้เป็นด่านแข็ง** (เหตุผลใน 3.1) |
| 5 | `PUT /api/quotation/:id` → 400 | บันทึกโดยไม่ระบุบริษัท+ผู้ติดต่อไม่ได้ | **คงไว้** — เหตุผลเดียวกับ #4 |
| 6 | 409 confirmed/cancelled · 403 ไม่ใช่เจ้าของ | ความถูกต้องของ transaction ไม่ใช่ "กฎธุรกิจ" | **คงไว้ทั้งหมด** |

---

## 2. ตัวตนของใบที่ออกจากเว็บ

### 2.1 โจทย์

แอดมินต้องมีแถวใน `salesperson` ก่อน (เพราะ FK ของ `quotations.user_id`) แต่แอดมิน **ไม่ใช่ผู้ขาย**
ไม่มีรหัสพนักงานขายให้ผูกลายเซ็น และไม่ควรไปโผล่เป็นเจ้าของลูกค้า

### 2.2 คำตอบ — แอดมินคือ **ผู้จัดทำ (ช่อง J)** ไม่ใช่ผู้ขาย (ช่อง H)

| ช่อง | ใบที่ออกจาก LINE (เดิม) | ใบที่ออกจากเว็บ (ใหม่) |
| --- | --- | --- |
| H ผู้ขาย + ชื่อบน PDF | เซลส์คนนั้น | **เซลส์ที่แอดมินเลือก** |
| ลายเซ็นบน PDF | ลายเซ็นเซลส์คนนั้น | **ลายเซ็นเซลส์ที่เลือก** (ไฟล์เดิม ไม่ต้องอัปโหลดใหม่) |
| J ผู้จัดทำ | เซลส์คนนั้น | **ชื่อแอดมิน** (จากรายชื่อ 70 ชื่อในหัวข้อ 1.3) |

### 2.3 กลไก — Proxy identity

**ตั้งค่าครั้งเดียวต่อแอดมิน:** เลือกชื่อตัวเองจาก dropdown ที่ดึงจาก
`sale_orders.employee_quotations WHERE invoice_status='invoiced'` (ตัดวงเล็บสังกัด + dedupe ด้วยสูตร
เดียวกับ `listSalespeopleFromOrders()` คือ `regexp_replace(nm, '\s*\([^)]*\)\s*$', '')`)
เก็บลงคอลัมน์ใหม่ `admin_users.employee_quotation_id`

> **ตัดสินใจแล้ว: เลือกได้จากรายชื่อที่มีจริงเท่านั้น — ไม่มีช่องพิมพ์ชื่อเอง**
> ฝั่ง server ตรวจซ้ำตอน `PUT` ว่าค่าที่ส่งมาอยู่ในรายชื่อจริง ไม่อยู่ = `400`
> เหตุผล: กันชื่อที่ Odoo ไม่รู้จักไม่ให้หลุดเข้าไฟล์ export ตั้งแต่ต้น
> **ผลที่ต้องยอมรับ:** แอดมินที่ยังไม่เคยมีใบ invoiced ในชื่อตัวเองจะยังใช้หน้านี้ไม่ได้จนกว่าชื่อจะโผล่ในรายชื่อ
> (รายชื่ออัปเดตตามรอบ `npm run sync:saleorders`)
>
> **ตัดสินตอนทำเฟส B:** ด่าน `PUT` เทียบ **ตรงตัว** กับรายชื่อ ตัดแค่ช่องว่างหัว/ท้าย —
> จงใจ *ไม่* ตัดสังกัดในวงเล็บให้ก่อนเทียบ ทั้งที่รายชื่อฝั่งที่ส่งให้ UI ตัดมาแล้ว
> เหตุผล: ถ้าตัดให้ `"Administrator (ปลอม)"` จะกลายเป็น `"Administrator"` แล้ว**ผ่าน** ทั้งที่ไม่ใช่
> สิ่งที่ผู้ใช้เลือก = เขียนค่าทับเงียบ ๆ (เจอตอนรัน Manual ข้อ 9 รอบแรก ได้ 200 แทนที่จะเป็น 400)
> ⇒ client ไม่มีเคสที่ต้องส่งชื่อพร้อมสังกัดมาเลย เพราะ `GET /makers` ตัดมาให้แล้วทั้ง 70 ชื่อ

**ทุกครั้งก่อนเริ่มแชท:** เลือก "ออกในนามเซลส์" จาก `salesperson` ที่ `status='active'`
แล้วระบบ upsert แถวพร็อกซี:

```
user_id = 'web:<admin_id>:<salesperson_user_id>'

  name                   ← เซลส์ที่เลือก        (→ ช่อง H + ชื่อบน PDF)
  phone                  ← เซลส์ที่เลือก
  salesperson_id         ← เซลส์ที่เลือก        (→ ไฟล์ลายเซ็น)
  employee_quotation_id  ← *** แอดมิน ***      (→ ช่อง J ผู้จัดทำ)
  status                 ← ตั้ง 'active' ตอนสร้าง แล้วปล่อยให้บทสนทนาฝั่งเว็บใช้ต่อ
  branch                 ← *** ไม่ก๊อป *** ปล่อย NULL (ดู 2.4)
```

> ⚠️ **ห้ามคัดลอก `status` จากเซลส์** — ช่องนั้นทำหน้าที่เป็น state machine ของบทสนทนา
> (`edit_*`, `custom_quote:*`, `pending_*`) ถ้าก๊อปมาจะทำ flow เพี้ยนทั้งสองฝั่ง
> ⚠️ **`employee_quotation_id` เป็นช่องเดียวที่ไม่ก๊อปจากเซลส์** — ถ้าเผลอก๊อป Odoo จะบันทึกว่า
> เซลส์เป็นคนคีย์ใบเอง ซึ่งผิดความจริงและทำให้สถิติผู้จัดทำเพี้ยน

**รูปแบบ `user_id` นี้เป็นสวิตช์ของทั้งแผน** — `web:` เป็น prefix ที่ LINE user id
(ขึ้นต้น `U` + hex 32 ตัว) เป็นไปไม่ได้ ⇒ ทุกฟีเจอร์ใน §4–§6 ปิดตายสำหรับ LINE โดยโครงสร้าง

### 2.4 ทำไมทางนี้ไม่ต้องแก้โค้ดปลายทางเลย

| เส้นทาง | อ่านจากไหน | ได้อะไร |
| --- | --- | --- |
| ลายเซ็น PDF (ใบร่าง) | query สดด้วย `user_id` → แถวพร็อกซี | `salesperson_id` ของเซลส์ ⇒ **ชี้ไฟล์ลายเซ็นเดิม** ✓ |
| ลายเซ็น PDF (ออกเลขแล้ว) | snapshot `employee_details` | ก๊อปจากแถวพร็อกซีตอนสร้างร่าง ✓ |
| Odoo ช่อง H | snapshot | ชื่อเซลส์ ✓ |
| Odoo ช่อง J | join สดด้วย `user_id` → แถวพร็อกซี | **ชื่อแอดมิน** ✓ |
| หน้าประวัติใบเสนอราคา | `COALESCE(s.name, snapshot)` | ชื่อเซลส์ (ค้น/กรองด้วยชื่อเซลส์ยังตรง) ✓ |
| จับคู่ลูกค้า | `findCustomerCandidates()` อ่าน `salesperson.name` เท่านั้น | AI เห็นหลักฐานชุดเดียวกับตอนเซลส์พิมพ์เอง ✓ |

> **ขอบเขตที่แท้จริงของแถว "จับคู่ลูกค้า"** (ตรวจโค้ดจริง 2026-09-04):
> * `salesperson.name` ถูกใช้**ทางเดียว**คือ `evidence.salespersonMatch`
>   ([customerService.ts:1109](../services/customerService.ts#L1109)) ที่ถูกเรนเดอร์เป็น **1 บรรทัดใน prompt**
>   ให้ LLM ตัดสินตอนบริษัทกำกวม · **ไม่ได้อยู่ในคะแนน Fuse / ไม่อยู่ใน SQL / ไม่อยู่ใน deterministic evidence boost**
> * **`branch_code` ไม่ถูกใช้เลย** — มีแค่ `console.log` ([customerService.ts:931](../services/customerService.ts#L931))
>   และโค้ดกำกับไว้เองว่า `NO branch_code filter` · [customerService.ts:1474](../services/customerService.ts#L1474)
> ⇒ **แถวพร็อกซีจึงไม่ก๊อป `branch` มาเลย ปล่อยเป็น NULL**
>
> `salesperson.branch` ถูกอ่านเฉพาะใน flow โปรไฟล์/ลงทะเบียนของ LINE
> ([lineHandler.ts:1188](../handlers/lineHandler.ts#L1188) · [flexTemplates.ts:316](../utils/flexTemplates.ts#L316))
> ซึ่งทั้งสองที่มี fallback รองรับค่าว่างอยู่แล้ว (`'ไม่ได้เลือกสาขา'`)

`pdfGenerator.ts` / `odooSaleOrderExport.ts` / หน้าประวัติ **ไม่ต้องแก้แม้แต่บรรทัดเดียว**

### 2.5 migration ของหัวข้อนี้

```sql
-- migrations/changes/2026-09-XX_01_admin_users_employee_quotation_id.sql
-- ชื่อผู้จัดทำใบฝั่ง Odoo ของแอดมินคนนี้ (ช่อง J ตอน export)
-- ค่าที่ถูกต้องต้องมีอยู่ใน sale_orders.employee_quotations ของแถว invoice_status='invoiced'
ALTER TABLE public.admin_users ADD COLUMN IF NOT EXISTS employee_quotation_id character varying(255);
```
NULL = ยังไม่ได้ตั้งค่า → หน้าเว็บบล็อกไม่ให้เริ่มแชทจนกว่าจะเลือกชื่อตัวเอง แล้วยุบเข้า `migrations/schema.sql`

### 2.6 ทางเลือกที่พิจารณาแล้วตัดทิ้ง

| ทางเลือก | ทำไมไม่เอา |
| --- | --- |
| ให้แอดมินใช้ `user_id` ของเซลส์ตรง ๆ | `deletePendingQuotations(userId)` จะลบร่างที่เซลส์กำลังทำใน LINE ทิ้งเงียบ ๆ + `status` ชนกัน = regression · **และทำให้สวิตช์ `web:%` ของทั้งแผนใช้ไม่ได้** |
| แจกรหัสพนักงานขายสมมติให้แอดมิน + อัปโหลดลายเซ็นแอดมิน | ผิดความหมายของช่อง H (แอดมินไม่ใช่ผู้ขาย) และไม่จำเป็น เพราะช่อง J รองรับอยู่แล้ว |
| ก๊อป `employee_quotation_id` จากเซลส์มาด้วย | Odoo จะบันทึกว่าเซลส์คีย์ใบเอง = ข้อมูลผู้จัดทำผิด |

### 2.7 เคสข้างเคียง

* **เซลส์ที่เลือกยังไม่มีลายเซ็น** → ใบไม่มีลายเซ็น = **พฤติกรรมเดิมตอนเซลส์คนนั้นออกใบเอง**
  หน้าเว็บเตือนตั้งแต่ตอนเลือกด้วย flag `has_sale_sig` ที่มีอยู่แล้ว
* **แอดมินคนนั้นเป็นเซลส์จริงด้วย** → ลงทะเบียนแถว `salesperson` ตามปกติ แล้วเลือกตัวเองในช่อง "ออกในนาม"
* **ตามรอยว่าใครกรอก** → ช่อง J บอกอยู่แล้ว + `admin_id` ฝังอยู่ใน `user_id` ⇒ ไม่ต้องเพิ่มคอลัมน์ audit

### 2.8 ผลข้างเคียงที่ต้องจัดการ

* `GET /api/admin/salespersons` ต้องกรอง `user_id NOT LIKE 'web:%'` ออก
  ไม่งั้นหน้า "จัดการข้อมูลพนักงาน" จะเต็มไปด้วยแถวพร็อกซีและขึ้นเตือนรหัสซ้ำ
* `quotation_count` ที่ใช้เตือนตอนลบพนักงาน จะไม่นับใบที่ออกผ่านเว็บของคนนั้น — ยอมรับได้ในเฟสแรก
* **1 คู่ (admin × เซลส์) = ร่างได้ครั้งละ 1 ใบ** เหมือน LINE เป๊ะ (`deletePendingQuotations`)

---

## 3. ฟีเจอร์ 0 — โหมด "เตือนแต่ไม่บล็อก" · `services/quotePolicy.ts` (ใหม่)

### 3.1 ขอบเขต: อะไรกลายเป็นคำเตือน อะไรยังเป็นด่านแข็ง

**กลายเป็นคำเตือน (ทำรายการต่อได้เต็มรูปแบบ)** — ทั้ง 7 ชนิดของ `Violation`:
`BLOCKED` (สินค้าถูกระงับ) · `OUT_OF_STOCK` · `MOQ_VIOLATION` · `MIN_PRICE_VIOLATION` ·
`CUSTOMER_BLACKLISTED` · `CUSTOMER_CREDIT_HOLD` · `SYSTEM_ERROR`

**ยังเป็นด่านแข็ง (3 ข้อ — และไม่ใช่ "กฎธุรกิจ")**

| ด่าน | ทำไมยกเลิกไม่ได้ |
| --- | --- |
| ต้องผูกบริษัท+ผู้ติดต่อก่อนยืนยัน (`isCustomerInfoIncomplete`) | ใบเสนอราคาที่ไม่มีลูกค้าออกเลขที่ไม่ได้ — เลขเดินหน้าแล้วย้อนคืนไม่ได้ และ Odoo ต้องมีคอลัมน์ B/C · **ฟีเจอร์ 3 (เพิ่มผู้ติดต่อ) คือคำตอบของด่านนี้โดยตรง** |
| 409 ใบถูกยืนยัน/ยกเลิกไปแล้ว | ความถูกต้องของ transaction ไม่ใช่กฎธุรกิจ |
| 403 ไม่ใช่เจ้าของใบ | ความปลอดภัย |

> **`SYSTEM_ERROR` ก็ลดชั้นด้วย** — ความหมายของมันคือ "ตรวจกฎไม่สำเร็จ" ไม่ใช่ "ผิดกฎ"
> ในโหมดแอดมินที่ตรวจเองอยู่แล้ว การหยุดงานเพราะ DB สะดุดไม่ได้ช่วยใคร
> แต่ต้องเรนเดอร์เป็นแถบแดงแยกชนิด (ไม่ใช่แถบเหลืองเหมือนคำเตือนอื่น) เพราะแปลว่า
> **"ยังไม่รู้ว่าผิดหรือไม่"** ต่างจากคำเตือนอื่นที่แปลว่า "รู้แล้วว่าผิด"

### 3.2 กลไก — โหมดห้อยกับ `userId` ไม่ใช่ flag ทั่วระบบ

```ts
// services/quotePolicy.ts (ใหม่ ~60 บรรทัด) — ความรู้เรื่อง "ใครไม่ถูกบล็อก" อยู่ที่นี่ที่เดียว
export type PolicyMode = 'enforce' | 'advise';

/**
 * ⚠️ นี่คือจุดเดียวในระบบที่ตัดสินว่าใครได้โหมดผ่อนปรน
 *   ไม่ส่ง userId มา  → 'enforce'  (ค่าปริยาย = พฤติกรรมเดิมทุกบิต)
 *   userId เป็น web:% → 'advise'
 * LINE user id ขึ้นต้นด้วย 'U' + hex 32 ตัวเสมอ จึงเข้าเงื่อนไขนี้ไม่ได้โดยโครงสร้าง
 */
export function resolveQuotePolicy(userId?: string | null): PolicyMode {
  return String(userId ?? '').startsWith('web:') ? 'advise' : 'enforce';
}

/** ถังพักคำเตือนต่อ userId — webQuoteService ดึงไปแสดงในฟอร์ม */
export function recordWarnings(userId: string, violations: Violation[]): void;
export function drainWarnings(userId: string): Violation[];
```

**จุดต่อในไฟล์เดิม 3 จุด:**

1. **`validateQuotationItems()`** — เพิ่ม `userId?: string` ใน `opts` และท้ายฟังก์ชัน (~8 บรรทัด):
   ```ts
   if (resolveQuotePolicy(opts.userId) === 'advise' && violations.length) {
     recordWarnings(opts.userId!, violations);
     return { items: expanded, violations: [], warnings: violations };
   }
   return { items: expanded, violations, warnings: [] };
   ```
   ⇒ **8 call site ที่ปฏิเสธเมื่อ `violations.length > 0` ไม่ต้องแตะเลยแม้แต่ที่เดียว**
   (`warnings` เป็นฟิลด์ใหม่ที่ผู้เรียกเดิม destructure ไม่ถึง จึงไม่กระทบ)

2. **ส่ง `userId` เข้าไปที่ call site 8 จุด** — เพิ่ม property เดียวต่อจุด ทุกจุดมีค่านี้อยู่ในมือแล้ว:
   [quotationService.ts:1168](../services/quotationService.ts#L1168) (`processQuotationRequest` มีพารามิเตอร์ `userId`) ·
   [index.ts:364](../index.ts#L364) · [index.ts:807](../index.ts#L807) ·
   [index.ts:923](../index.ts#L923) (`quoteRes.rows[0].user_id`) · [index.ts:1215](../index.ts#L1215) (`quote.user_id`) ·
   [lineHandler.ts:580](../handlers/lineHandler.ts#L580) · [lineHandler.ts:1459](../handlers/lineHandler.ts#L1459) ·
   [quotationAgent.ts:100](../services/quotationAgent.ts#L100)

3. **`getQuotationSummaryMessage()`** — [flexTemplates.ts:1176](../utils/flexTemplates.ts#L1176) (~6 บรรทัด):
   ```ts
   const advise = resolveQuotePolicy(quotes[0]?.user_id) === 'advise';
   const softBlocked = hasMinPriceViolation || customerBlacklisted || !!creditHoldText;
   // ยังไม่ผูกลูกค้า = ด่านแข็ง ไม่ผ่อนปรนแม้ในโหมด advise (ดู 3.1)
   const hideConfirm = customerIncomplete || (softBlocked && !advise);
   ```
   แล้วในโหมด advise ให้ **แสดงกล่องเตือน (สีเหลือง) แล้ว push ปุ่มยืนยันต่อท้าย** แทนที่จะ else

### 3.3 ทำไมใช้ "ถังพักคำเตือน" แทน AsyncLocalStorage

ทางเลือกที่ตรงที่สุดคือ AsyncLocalStorage แต่ตัดทิ้งเพราะ context ที่มองไม่เห็นในโค้ดจะกลายเป็น
กับดักตอนแก้ครั้งหน้า (ใครสักคนย้ายงานไป `setTimeout`/worker แล้วโหมดหายเงียบ)

ถังพักเป็น `Map<string, Violation[]>` ใน module ใหม่ ปลอดภัยเพราะ:

* key = `web:<admin>:<sp>` ซึ่ง **`KeyedTaskQueue` การันตีว่ามีงานเดียวต่อ key ณ เวลาหนึ่ง**
  (คิวของเว็บเป็น instance แยก concurrency 4 แต่ยังคีย์ด้วย userId เหมือนกัน) ⇒ ไม่มีทางสลับกัน
* `webQuoteService` เรียก `drainWarnings()` ทันทีหลังจบงานแต่ละก้าว แล้วทิ้ง
* มี TTL 5 นาที + เพดานจำนวน key กัน memory รั่วเมื่อ drain ไม่ถึง (เช่นงานโยน error)
* **LINE ไม่มีวันเขียนถังนี้** เพราะ `recordWarnings` ถูกเรียกในสาขา advise เท่านั้น

> **v5 — ต้องทบทวนตอนเริ่มเฟส F ว่ายังต้องมีถังพักไหม**
> ถังพักนี้ถูกออกแบบตอนที่เว็บเรียก `handleEvent` แล้วเห็นแต่ Flex ที่ออกมา จึงต้องเก็บ violation
> ออกมานอกทาง · ใน v5 `webQuoteService` เรียก `validateQuotationItems()` **เองโดยตรง**
> ⇒ ก้าว `propose` / `createDraft` อ่าน violations จากค่าที่ฟังก์ชันคืนได้เลย ไม่ต้องใช้ถัง
> **เหลือที่เดียวที่ยังต้องใช้คือตอน `POST /api/quotation/:id/confirm`** ซึ่งตรวจกฎอยู่ข้างใน endpoint
> ⇒ ทางเลือกคือ (ก) คงถังพักไว้เฉพาะเส้นนั้น หรือ (ข) ให้ endpoint คืน `warnings` มาใน response
> เลือกตอนเฟส F เมื่อเห็นโค้ดจริงแล้ว — อย่าเพิ่งสร้างถังพักตั้งแต่ยังไม่รู้ว่าต้องใช้

### 3.4 คำเตือนไปโผล่ที่ไหน

| ชนิด | ที่แสดง |
| --- | --- |
| จาก `validateQuotationItems` (BLOCKED/stock/MOQ/min-price/blacklist/credit/system) | **แถบเหลืองเหนือปุ่มยืนยันในฟอร์ม** (v5: อ่านจากค่าที่ฟังก์ชันคืนตรง ๆ) |
| จากการตรวจตอนสร้างร่าง (blacklist / credit hold / ต่ำกว่าราคาขั้นต่ำ) | แถบเตือนในฟอร์ม **คู่กับ**ปุ่มยืนยันที่ยังกดได้ |
| ตอนกดยืนยัน | ไม่มี 422 อีก — ด่านคืน `violations: []` · คำเตือนที่บันทึกไว้ยังโชว์ค้างในฟอร์ม |
| **หลังออกใบแล้ว (ย้อนหลัง)** | **ป้าย "⚠️ ข้ามกฎ N ข้อ" ในหน้าประวัติใบเสนอราคา** — ดู 3.5 |

### 3.5 บันทึกถาวรว่า "ใบนี้ออกโดยข้ามกฎอะไรบ้าง" (ตัดสินใจ 2026-09-07)

**ปัญหา:** คำเตือนที่โชว์ในฟอร์มอยู่แค่ในหน้าจอรอบนั้น (ถังพักตาม 3.3 มี TTL 5 นาที)
⇒ เปิดใบเดิมดูวันถัดไปจะไม่มีร่องรอยเลยว่าใบนั้นออกทั้งที่ติด blacklist / ราคาต่ำกว่าขั้นต่ำ / สต็อกไม่พอ
**เลือกทางเลือก ค.** — เก็บลง DB **และ**ติดป้ายให้เห็นในหน้าประวัติ (ไม่ใช่แค่ซ่อนไว้ใน log)

```sql
-- migrations/changes/2026-09-XX_06_quotation_issue_warnings.sql
-- "กฎที่ใบนี้ข้ามไป ณ วินาทีที่กดยืนยัน" — ไม่ใช่คำเตือนระหว่างร่าง
CREATE TABLE IF NOT EXISTS public.quotation_issue_warnings (
  quotation_id uuid        PRIMARY KEY REFERENCES public.quotations(id) ON DELETE CASCADE,
  warnings     jsonb       NOT NULL,   -- Violation[] ชุดเดียวกับที่ buildViolationDisplay สร้าง
  warned_count integer     NOT NULL,   -- เก็บซ้ำเพื่อให้ป้ายในตารางไม่ต้องแกะ jsonb ทุกแถว
  issued_by    integer,                -- admin_users.id · ไม่มี FK (ลบแอดมินแล้วหลักฐานต้องอยู่)
  created_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**เขียนเมื่อไหร่ — ใน transaction เดียวกับการออกเลข**

`confirmQuotationAtomic()` รับ `opts.warnings` เพิ่ม แล้ว `INSERT` ในทรานแซกชันเดียวกับที่ออกเลข
* **ไม่ส่ง `warnings` มา = ไม่เขียนอะไรเลย** ⇒ เส้นทาง LINE ([lineHandler.ts:594](../handlers/lineHandler.ts#L594)) ไม่เปลี่ยน
* ผู้เรียกฝั่งเว็บได้ `warnings` มาจาก `validateQuotationItems(..., { userId })` ที่เรียกอยู่ก่อนแล้ว
  ([index.ts:1215](../index.ts#L1215)) — ไม่ต้องตรวจกฎรอบใหม่
* **ทำไมต้องอยู่ใน tx เดียวกัน:** ถ้าเขียนหลัง commit แล้วล้ม จะได้ใบที่ข้ามกฎโดยไม่มีหลักฐาน
  ซึ่งเป็นสิ่งเดียวที่ฟีเจอร์นี้มีไว้ป้องกัน
* จุดต่อนี้เป็นจุดเดียวกับที่ขั้น 6c แตะ (ตรึงทีมขาย) ⇒ แก้ `confirmQuotationAtomic` ครั้งเดียวจบ

> **บันทึกคือ "สภาพ ณ ตอนกดยืนยัน" ไม่ใช่ประวัติทั้งหมดระหว่างร่าง** — ถ้าแอดมินเห็นคำเตือน
> ตอนร่างแล้วแก้จนหมดก่อนยืนยัน ใบนั้นจะไม่มีแถวในตารางนี้ ซึ่งถูกต้อง: ใบที่ออกไปไม่ได้ข้ามกฎอะไร

**หน้าประวัติใบเสนอราคา** ([Quotations.tsx](../frontend/src/admin/Quotations.tsx)):
* ป้ายในตาราง `⚠️ ข้ามกฎ N ข้อ` → คลิกเปิด modal แสดง `display_message` ทีละบรรทัด
* ตัวกรองเพิ่ม (วางข้าง ๆ ตัวกรองแหล่งที่มาในขั้น 10): ทั้งหมด / เฉพาะที่ข้ามกฎ / เฉพาะที่ไม่ข้าม
  — **ค่าตั้งต้น "ทั้งหมด" ⇒ ผู้เรียกเดิมได้ผลเหมือนเดิมทุกบิต** (กติกาเดียวกับตัวกรองแหล่งที่มา)
* `LEFT JOIN quotation_issue_warnings` ใน `GET /api/admin/quotations` — ตาราง 1,458 แถว ไม่ต้องมี index เพิ่ม

> ⛔ **ไม่ใส่ลงไฟล์ export Odoo** — ไฟล์นั้นคือ template คอลัมน์ A–T ที่ Odoo กำหนด
> เพิ่มคอลัมน์เข้าไปเมื่อไหร่ไฟล์นำเข้าไม่ผ่าน · หลักฐานอยู่ในหน้าประวัติกับ DB พอ

---

## 4. ฟีเจอร์ 1+2 — เครดิต override และบรรทัดค่าขนส่ง · `services/quoteOverrides.ts` (ใหม่)

### 4.1 ทำไม "เขียนทับ snapshot ตรง ๆ" ใช้ไม่ได้

`customer_details.payment_terms` **ถูกคำนวณใหม่จาก `customers_data_view` ทุกครั้งที่บันทึก**
([index.ts:1041](../index.ts#L1041) และ [quotationService.ts:668](../services/quotationService.ts#L668))
⇒ แอดมินแก้เครดิตแล้วกดบันทึกในหน้าแก้ไขใบ ค่าจะถูกเขียนกลับเป็นของเดิมเงียบ ๆ

⇒ ต้องมี **ชั้น override ที่ทับ *หลัง* snapshot ถูกประกอบเสร็จ** — และของแบบนี้ระบบนี้มีแบบแผนอยู่แล้ว
คือ `applyShippingFeeToQuoteGroup(userId)` ที่ถูกเรียกต่อท้ายทุกจุดที่เขียนใบ

### 4.2 ตารางเดียวสำหรับทั้งสองฟีเจอร์

```sql
-- migrations/changes/2026-09-XX_02_quotation_overrides.sql
-- ค่าที่แอดมินสั่งทับสำหรับ "ใบใบนั้น" — ไม่มีแถว = ระบบทำงานเหมือนไม่มีฟีเจอร์นี้
CREATE TABLE IF NOT EXISTS public.quotation_overrides (
  quotation_id   uuid        PRIMARY KEY REFERENCES public.quotations(id) ON DELETE CASCADE,
  -- NULL = ไม่ทับเครดิต · ค่าต้องอยู่ในชุดค่าที่ Odoo รู้จัก (ตรวจฝั่ง server ดู 4.4)
  payment_terms  text,
  -- ทับเฉพาะคำตอบ "ใบนี้ต้องมีบรรทัดค่าขนส่งไหม" เท่านั้น — ชื่อ/ราคายังอยู่ใน item_details เหมือนเดิม
  --   NULL        = ปล่อยกฎอัตโนมัติตัดสินตามเกณฑ์ (พฤติกรรมเดิมทุกบิต)
  --   'force_on'  = ต้องมีบรรทัด แม้ยอดถึงเกณฑ์หรือลูกค้ามีเครดิต
  --   'force_off' = ห้ามมีบรรทัด แม้เข้าเงื่อนไขที่กฎจะใส่ให้
  shipping_mode  varchar(9),
  updated_by     integer,     -- admin_users.id · ไม่มี FK โดยเจตนา (ลบแอดมินแล้วหลักฐานต้องไม่หาย)
  updated_at     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT quotation_overrides_shipping_mode_chk
    CHECK (shipping_mode IS NULL OR shipping_mode IN ('force_on', 'force_off'))
);
```

**`ON DELETE CASCADE` คือเหตุผลที่ไม่ต้องเขียนโค้ดเก็บกวาดเลย** — `deletePendingQuotations()`
([repositories.ts:369](../db/repositories.ts#L369)) ลบแถวร่างทิ้งทุกครั้งที่เริ่มรายการใหม่/ยกเลิก
override จึงหายตามไปเอง ไม่มีสถานะค้างข้ามใบ

> ⚠️ **ห้ามติด audit trigger กับตารางนี้ไม่ได้ — แต่ติดได้** : กฎถาวรใน
> [2026-09-03_04_audit_logs.sql](../migrations/changes/2026-09-03_04_audit_logs.sql#L14) ห้ามติด trigger
> กับ `quotations` เพราะเขียนทุกครั้งที่ลูกค้าคุยกับบอท · `quotation_overrides` เขียนเฉพาะตอน
> แอดมินกดปุ่ม (อัตราหลักสิบครั้ง/วัน) จึง**ติด trigger ได้และควรติด** — เป็นเหตุผลข้อที่สองที่
> เลือกตารางแยกแทนการยัดลง snapshot

### 4.3 การนำไปใช้ — เปลี่ยน call site 4 จุดเป็นตัวห่อ

```ts
// services/quoteOverrides.ts (ใหม่ ~140 บรรทัด)

/** ตัวห่อจุดเดียวที่แทนที่ applyShippingFeeToQuoteGroup ทุก call site — ลำดับสำคัญ */
export async function applyQuoteGroupRules(userId: string | null | undefined): Promise<void> {
  await applyQuoteOverrides(userId);          // 1. เครดิตที่แอดมินสั่งทับ
  await applyShippingFeeToQuoteGroup(userId); // 2. กฎค่าขนส่งอัตโนมัติ (อ่านเครดิตจากข้อ 1)
}
```

**ลำดับกลับกันไม่ได้** — กฎค่าขนส่งตัดสินจาก `hasCreditTerms(customer_details.payment_terms)`
([shippingFee.ts:36](../services/shippingFee.ts#L36)) ถ้าเรียกก่อน override มันจะใช้เครดิตเก่า

จุดที่เปลี่ยน (บรรทัดละจุด — เปลี่ยนชื่อฟังก์ชันที่เรียกเท่านั้น):
[quotationService.ts:812](../services/quotationService.ts#L812) · [index.ts:1140](../index.ts#L1140) ·
[index.ts:1183](../index.ts#L1183) · [lineHandler.ts:507](../handlers/lineHandler.ts#L507)

> ใบของ LINE ไม่มีแถวใน `quotation_overrides` เลย ⇒ `applyQuoteOverrides()` ออกจากฟังก์ชัน
> ตั้งแต่ query แรก (index scan บน PK 0 แถว) ⇒ ต้นทุนที่เพิ่มกับเส้นทาง LINE ≈ 0

### 4.4 ฟีเจอร์ 1 — แก้เครดิตของลูกค้า

**ค่าที่เลือกได้ = ค่าที่มีจริงใน DB เท่านั้น ไม่ใช่ช่องพิมพ์อิสระ**
เหตุผล: `payment_terms` ไหลตรงเข้าคอลัมน์ G `payment_term_id` ของไฟล์นำเข้า Odoo
([odooSaleOrderExport.ts:339](../services/odooSaleOrderExport.ts#L339)) ค่าที่ Odoo ไม่รู้จัก = แถวนั้นนำเข้าไม่ผ่าน

วัดจริง 2026-09-07 (`SELECT customer_payment_terms, count(DISTINCT company_id) FROM customers`):

| ค่า | บริษัท | มีเครดิตไหม (`hasCreditTerms`) |
| --- | ---: | --- |
| `NULL` | 27,413 | ไม่มี |
| `Cash` | 15,284 | ไม่มี |
| `30 Days` | 8,950 | **มี** |
| `60 Days` | 438 | **มี** |
| `เช็คล่วงหน้า30วัน` | 220 | **มี** |
| `45 / 15 / 7 / 90 / 14 / 65 / 20 / 40 Days` · `เช็คล่วงหน้า15วัน` · `เช็คล่วงหน้า45วัน` | รวม 280 | **มี** |

⇒ **15 ค่า + ค่าว่าง** · dropdown ดึงสดจาก `SELECT DISTINCT customer_payment_terms FROM customers`
(cache TTL แบบเดียวกับ `services/rules/cache.ts`) · `PUT` ตรวจซ้ำฝั่ง server ไม่อยู่ในชุด = `400`

**ผลกระทบที่ต้องรู้ (ตั้งใจให้เป็นแบบนี้):**

* แก้เครดิตจาก `Cash` → `30 Days` ⇒ `hasCreditTerms` เป็น true ⇒ **บรรทัดค่าขนส่งอัตโนมัติถูกถอดออก**
  เพราะกฎคือ "ลูกค้าไม่มีเครดิต + ยอดต่ำกว่าเกณฑ์ จึงเก็บค่าขนส่ง" — สอดคล้องกัน ไม่ใช่บั๊ก
* **ไม่ปลดด่าน credit hold** — ด่านนั้นตัดสินจาก `customers_data_view.last_order_at` ไม่ใช่ `payment_terms`
  ([creditHoldService.ts](../services/creditHoldService.ts)) · ในโหมดแอดมินมันเป็นคำเตือนอยู่แล้ว (ฟีเจอร์ 0)
* ค่าที่ทับไปโผล่ที่ **PDF** (`quoteData.payment_terms` — [pdfGenerator.ts:656](../pdfGenerator.ts#L656)),
  **Odoo คอลัมน์ G**, การ์ดสรุป และช่อง "💳 เครดิต" ในหน้าแก้ไขใบ ทั้งหมดผ่าน snapshot เดียวกัน
* **ไม่แตะข้อมูลลูกค้าใน `customers`** — เป็นการทับเฉพาะใบนั้น ตามที่ requirement ระบุ

### 4.5 ฟีเจอร์ 2 — ค่าขนส่ง **1 บรรทัด** ที่ตั้งชื่อทับได้

> **ขอบเขตที่ยืนยันแล้ว 2026-09-07: ยังเป็น 1 บรรทัดต่อกลุ่มร่างเหมือนเดิม**
> สิ่งที่เพิ่มคือ (ก) เขียนทับ **ชื่อ** ได้อิสระ (ข) จำชื่อไว้เป็น dropdown
> (ค) สั่งให้ "มี/ไม่มี" บรรทัดได้เองโดยไม่ต้องรอเกณฑ์
> ⇒ **ไม่มีการเพิ่มหลายบรรทัด และไม่มีโหมด "ยกกฎออกทั้งกลุ่ม"**

**ของเดิมทำอะไรได้/ไม่ได้** (อ่านจาก [shippingFee.ts](../services/shippingFee.ts) 2026-09-07):

| เรื่อง | ของเดิม | ต้องทำเพิ่มไหม |
| --- | --- | --- |
| ชื่อบรรทัดที่แก้ไว้ | ✅ รักษาไว้ข้ามการรันกฎซ้ำ (`prevFee.name`) และอยู่ใน whitelist ของ `enrichQuotationData` แล้ว | **ไม่ต้อง** — มีให้แล้ว |
| ราคาที่แก้ไว้ | ✅ รักษาไว้ (`prevFee.price`) | **ไม่ต้อง** |
| จำนวนบรรทัด | 1 บรรทัดต่อกลุ่มร่าง | **ไม่ต้อง** — ตรงกับ requirement |
| เพิ่มเองตอนยอดถึงเกณฑ์ / ลูกค้ามีเครดิต | ❌ กฎถอดออกให้ทันทีที่รันรอบถัดไป | ✅ **นี่คือช่องว่างเดียวที่ต้องอุด** |
| จำนวน (quantity) | ถูกตั้งเป็น `cfg.feeQuantity` (=1) เสมอ | ไม่เปิด — ดูหมายเหตุท้ายหัวข้อ |

**สินค้าที่ใช้มีแถวเดียวในระบบ** (วัด 2026-09-07):
`product_template_id = -1` · `model = 'N/A'` · `internal_reference = 'SOFBLDXXXX0010'` · `name = 'ค่าบริการ'` · `is_system_item = true`
และค่าตั้งต้น `shipping_fee_config`: เปิดใช้ · เกณฑ์ก่อน VAT 1,000 · ราคา 200 · จำนวน 1 · ชื่อ `ค่าขนส่ง`

**กลไก — ทับแค่คำตอบว่า "ใบนี้ควรมีบรรทัดไหม" ไม่ยกกฎออก**

จุดต่อในไฟล์เดิมคือบรรทัดเดียวที่ `applyShippingFeeToQuoteGroup` คำนวณ `shouldHave`
([shippingFee.ts:235](../services/shippingFee.ts#L235)):

```ts
// services/shippingFee.ts — แทนที่การกำหนด shouldHave เดิม (~5 บรรทัด)
// ไม่มีแถวใน quotation_overrides = forced เป็น null = ผลเท่าเดิมทุกบิต
const { getShippingOverride } = await import('./quoteOverrides.js');
const forced = await getShippingOverride(quotes.map(q => q.row.id), client);
const shouldHave =
  forced === 'force_on'  ? true  :
  forced === 'force_off' ? false :
  (cfg.isActive && bound && goods > 0 && goods < cfg.thresholdBeforeVat && !hasCreditTerms(paymentTerms));
```

ชื่อและราคาที่แอดมินตั้ง **ไม่ต้องเก็บใน override เลย** — อยู่ใน `item_details` แล้ว
และ `buildShippingFeeSnapshot(cfg, prevFee)` รักษาไว้ให้ทุกครั้งที่กฎรันซ้ำอยู่แล้ว

**ทำไมไม่ใช้ "ธงในบรรทัดสินค้า"** — [shippingFee.ts:124](../services/shippingFee.ts#L124) เขียนกำกับไว้เองว่า
*"ตั้งใจไม่เก็บ field ธงแยก เพราะ field ใหม่ใน snapshot จะหายเงียบตอน round-trip ผ่าน LIFF editor
ถ้าลืมเพิ่มใน whitelist"* — เป็นกับดักที่เคยเกิดจริงมาแล้ว จึงเก็บสถานะไว้นอก snapshot

**แผงค่าขนส่งของแอดมินทำอะไรได้:**
สลับ **มี / ไม่มี / ตามเกณฑ์** · เขียนทับชื่อ (combobox: เลือก preset หรือพิมพ์ใหม่) · แก้ราคา
บรรทัดยังใช้สินค้าระบบตัวเดิม (`SOFBLDXXXX0010`) ⇒ ไฟล์นำเข้า Odoo ยังอ้างรหัสที่ Odoo รู้จัก

> ⚠️ **ชื่อที่พิมพ์เองไม่ไป Odoo** — คอลัมน์ M `product` ส่งแค่ `internal_reference`
> ([odooSaleOrderExport.ts:373](../services/odooSaleOrderExport.ts#L373)) ⇒ ข้อความที่แอดมินตั้ง
> ปรากฏใน **PDF ที่ลูกค้าเห็น** และหน้าจอ แต่ใน Odoo จะเป็นชื่อสินค้า `ค่าบริการ` เสมอ
> ต้องบอกแอดมินให้รู้ตรงนี้ในหน้าจอ ไม่ใช่ปล่อยให้เข้าใจผิด

> 📌 **สมมติฐานเรื่อง quantity (แก้ได้ถ้าไม่ตรง):** ปล่อยให้เป็น `cfg.feeQuantity` (=1) เหมือนเดิม
> เพราะ "1 บรรทัด × ราคาที่แก้ได้อิสระ" ครอบทุกเคสจริงอยู่แล้ว · ถ้าเปิดให้แก้จำนวนด้วย
> ต้องแก้ `buildShippingFeeSnapshot` ให้รักษา `prev.quantity` ซึ่งจะไปคลายล็อกฝั่ง LINE ด้วย
> (วันนี้ช่องจำนวนของบรรทัดค่าขนส่งถูกล็อกในหน้า LIFF ผ่านธง `is_shipping_fee`)

**ชื่อที่บันทึกไว้ใช้ครั้งหน้า (dropdown):**

```sql
-- migrations/changes/2026-09-XX_03_shipping_fee_name_presets.sql
CREATE TABLE IF NOT EXISTS public.shipping_fee_name_presets (
  id          serial      PRIMARY KEY,
  label       text        NOT NULL UNIQUE,   -- ข้อความที่จะไปเป็นชื่อบรรทัด
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at timestamptz,
  use_count   integer     NOT NULL DEFAULT 0
);
```
ใช้ร่วมกันทั้งองค์กร (ไม่แยกรายแอดมิน) — เป็นคำศัพท์ของบริษัท ไม่ใช่ของส่วนตัว
เรียง `last_used_at DESC NULLS LAST, use_count DESC` · แอดมินลบ preset ที่ไม่ใช้แล้วได้

### 4.6 ทางเลือกที่พิจารณาแล้วตัดทิ้ง (ฟีเจอร์ 1+2)

| ทางเลือก | ทำไมไม่เอา |
| --- | --- |
| ยัดเครดิตลง `custom_meta` (ช่อง override ที่มีอยู่แล้ว สำหรับ tax_id/phone/email/address) | เดินทางผ่านสตริง `customer_name` แบบ `"บริษัท \| ผู้ติดต่อ \| meta"` ⇒ ต้องแก้ 3 จุดใน 2 ไฟล์ร้อน (`insertDraftQuotations`, `PUT`, `updateQuotationCustomerSnapshot` — ลืมจุดที่ 3 = ค่าหายตอนเลือกบริษัทจาก postback) · **และ audit ไม่ได้** เพราะห้ามติด trigger กับ `quotations` |
| เพิ่มคอลัมน์ `payment_terms_override` ใน `quotations` | ตารางร้อนที่สุดของระบบ · ห้ามติด audit trigger · และเป็นคอลัมน์ที่มีความหมายเฉพาะกับเว็บซึ่งจะกลายเป็นขยะถ้าฟีเจอร์ถูกยกเลิก |
| ธง `is_manual_shipping` ในบรรทัดสินค้า (snapshot) | กับดัก whitelist ที่โค้ดเดิมเขียนเตือนไว้เอง (ดู 4.5) |
| ให้กฎค่าขนส่ง "ยกมือออก" ทั้งกลุ่มเมื่อแอดมินแตะ | เกินความต้องการ — โจทย์คือ 1 บรรทัดที่สั่งมี/ไม่มีได้ ไม่ใช่คุมทั้งกลุ่ม · ยกมือออกแล้วยอดรวมจะไม่ถูกคิดใหม่เมื่อสินค้าเปลี่ยน |
| สร้างสินค้าระบบตัวที่สองสำหรับบรรทัดที่แอดมินเพิ่ม | ต้องไปสร้างรหัสสินค้าใหม่ใน Odoo ด้วย ⇒ พา ops เข้ามาเกี่ยวโดยไม่จำเป็น · และ `isShippingFeeItem()` เทียบ `internal_reference` ด้วย จึงเลี่ยงกฎไม่ได้อยู่ดี |

---

## 5. ฟีเจอร์ 3 — เพิ่มผู้ติดต่อใหม่ · `services/localContacts.ts` (ใหม่)

### 5.1 โจทย์และข้อจำกัด

* เพิ่ม **ผู้ติดต่อ** ได้ · **สร้างบริษัทใหม่ไม่ได้** — ต้องเป็นบริษัทที่มีอยู่แล้วใน DB (ข้อ 3.1)
* ฟิลด์: `contact_name` **บังคับ** · ตำแหน่งงาน · โทรศัพท์ · อีเมล (ข้อ 3.2)
* `customers` ถูก **sync ทับจาก Odoo gateway** ทุกรอบ ⇒ เขียนลงไปตรง ๆ = หายรอบหน้า
* `customers_data_view` ถูก **สร้างใหม่ทั้งก้อน** ทุกรอบ sync ⇒ เขียนลงไปอย่างเดียวก็หาย

### 5.2 คำตอบ — ตารางของตัวเอง + Arm 3 ในนิยาม view

ทุกเส้นทางที่อ่านลูกค้า/ผู้ติดต่ออ่านผ่าน `customers_data_view` **จุดเดียว**
(Phase 3 ปลด `customers_view`/`contacts_view` ทิ้งไปแล้ว — [repositories.ts:20](../db/repositories.ts#L20))
⇒ เติมแถวเข้า view นั้นได้ = ผู้ติดต่อใหม่โผล่ครบทุกที่โดยไม่ต้องแก้ที่ไหนอีกเลย
(picker เลือกผู้ติดต่อ · `getContactById` ที่ใช้ประกอบที่อยู่ · snapshot ตอนสร้างใบ ·
`ODOO_EXPORT_SALES_TEAM_JOIN` · reverse lookup ชื่อผู้ติดต่อ → บริษัท)

```sql
-- migrations/changes/2026-09-XX_04_local_contacts.sql

-- contact_id ของ Odoo วิ่งอยู่แถว 1.03 ล้าน (วัด 2026-09-07: max = 1,031,893)
-- ตั้งต้นที่ 900 ล้านเพื่อกันชนแบบไม่ต้องประสานกับใคร และยังห่างเพดาน int4 (2,147,483,647) อีกเท่าตัว
-- ⚠️ ห้ามใช้เลขติดลบ — โค้ดทั้งระบบใช้ contact_id > 0 เป็นเงื่อนไข "เป็นผู้ติดต่อจริง"
--    (normalizeId ของ blacklistService, CONTACT_VIEW_COLS, idx_so_contact_latest ฯลฯ)
CREATE SEQUENCE IF NOT EXISTS public.local_contact_id_seq START WITH 900000000;

CREATE TABLE IF NOT EXISTS public.local_contacts (
  contact_id    integer     PRIMARY KEY DEFAULT nextval('public.local_contact_id_seq'),
  company_id    integer     NOT NULL,        -- ต้องมีอยู่จริงใน customers_data_view (ตรวจฝั่ง server)
  contact_name  text        NOT NULL,
  job_position  text,                         -- ไม่มีปลายทางในระบบวันนี้ — ดู 5.5
  contact_phone text,
  contact_email text,
  created_by    integer,                      -- admin_users.id · ไม่มี FK (ลบแอดมินแล้วหลักฐานต้องอยู่)
  created_at    timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT local_contacts_name_not_blank CHECK (btrim(contact_name) <> '')
);
CREATE INDEX IF NOT EXISTS idx_local_contacts_company ON public.local_contacts (company_id);
```

**Arm 3 ใน `customers_data_build`** (ต่อท้าย CTE `base` ด้วย `UNION ALL`):

```sql
UNION ALL

-- ── Arm 3: ผู้ติดต่อที่แอดมินเพิ่มเองจากหน้าเว็บ (ยังไม่มีใน Odoo) ──
-- ค่าระดับบริษัททุกช่องยืมจากแถวตัวแทนของบริษัทนั้นใน Arm 1/2 → ที่อยู่/เครดิต/ทีมขายถูกต้องทันที
-- NOT EXISTS = พอ Odoo สร้างคนนี้จริงแล้ว sync กลับมา แถว local จะหลบให้เอง (self-healing)
SELECT
  l.company_id, l.contact_id, 'local'::text AS source,
  b.customer_name, b.customer_reference, b.customer_tax_id, b.customer_payment_terms,
  b.customer_sale_area, b.salesperson, b.sales_team, b.customer_type,
  b.phone, b.mobile, b.email,
  public.clean_text(l.contact_name)  AS contact_name,
  public.clean_text(l.contact_phone) AS contact_mobile,
  public.clean_text(l.contact_phone) AS contact_phone,
  public.clean_text(l.contact_email) AS contact_email,
  b.invoice_street, b.invoice_district, b.invoice_sub_district, b.invoice_state, b.invoice_zip
FROM public.local_contacts l
JOIN LATERAL (
  SELECT * FROM base b2 WHERE b2.company_id = l.company_id ORDER BY b2.contact_id LIMIT 1
) b ON true
WHERE NOT EXISTS (
  SELECT 1 FROM base b3
   WHERE b3.company_id = l.company_id
     AND btrim(b3.contact_name) = btrim(l.contact_name)
)
```

> **ตารางว่าง ⇒ view ให้ผลชุดเดิมทุกแถวทุกคอลัมน์** — เป็นข้อพิสูจน์ว่าไม่กระทบของเดิม
> และ `source = 'local'` ทำให้แยกที่มาได้เหมือนที่ `'odoo'` / `'saleorder'` ทำอยู่แล้ว
> (วัด 2026-09-07: odoo 78,206 · saleorder 4,306 · รวม 82,512)

### 5.3 ทำให้ใช้ได้ทันทีโดยไม่ต้อง rebuild ทั้งตาราง (dual-write)

`customers_data_view` เป็น**ตารางจริง** ⇒ `INSERT` ตรงได้ · การเพิ่มผู้ติดต่อจึงเขียน 2 ที่ใน transaction เดียว:

1. `local_contacts` — ต้นทางถาวร (Arm 3 สร้างแถวนี้กลับมาทุกรอบ rebuild)
2. `customers_data_view` — แถวเดียวกันเป๊ะ เพื่อให้ใช้ได้ทันทีในบทสนทนาที่กำลังคุยอยู่

**ทำไมไม่สั่ง refresh ทั้งตาราง:** `refreshCustomerDataView()` เป็น build+swap ทั้งก้อน ~2–3 วิ
+ ถือ `AccessExclusiveLock` ตอนสลับ ([refreshCustomerDirectory.ts](../scripts/sync/refreshCustomerDirectory.ts))
การเพิ่มผู้ติดต่อ 1 คนไม่ควรจ่ายราคานั้น และไม่ควรไปแย่งจังหวะกับรอบ sync

**ไม่ต้องล้าง cache ค้นหาลูกค้า** — cache นั้นคือ `SELECT DISTINCT ON (company_id) ...`
([customerService.ts:225](../services/customerService.ts#L225)) = **รายชื่อบริษัทล้วน**
และข้อ 3.1 บังคับว่าบริษัทต้องมีอยู่แล้ว ⇒ รายชื่อบริษัทไม่เปลี่ยน ⇒ ไม่มีอะไรให้ล้าง

**จุดต่อในไฟล์เดิม 1 บรรทัด:** เติม `local_contacts` เข้า watermark ของ `refreshCustomerDataView()`
```sql
GREATEST( (SELECT max(sync_updated_at) FROM public.customers),
          (SELECT max(updated_at)      FROM public.sale_orders),
          (SELECT max(updated_at)      FROM public.local_contacts) )   -- ← เพิ่ม
```
ไม่งั้นถ้ามีคนแก้ `local_contacts` ตรง ๆ (psql/script) rebuild รอบถัดไปจะ "ข้ามเพราะไม่มีอะไรเปลี่ยน"

> 📌 ตอนรัน migration ที่แก้แค่นิยาม view ต้องใช้ **`force: true`** ไม่งั้น watermark เดิมทำให้ข้าม
> (บทเรียนที่บันทึกไว้แล้ว: *refreshCustomerDirectory ไม่มี CLI · รันไฟล์ตรง ๆ เงียบสนิท*)

### 5.4 endpoint และการตรวจ

`POST /api/admin/webquote/contacts` (admin, subadmin)

| ตรวจ | ผลถ้าไม่ผ่าน |
| --- | --- |
| `company_id` มีจริงใน `customers_data_view` | `400` — **นี่คือการบังคับข้อ 3.1** |
| `contact_name` ไม่ว่างหลัง trim | `400` |
| ชื่อซ้ำกับผู้ติดต่อที่มีอยู่แล้วของบริษัทนั้น (เทียบแบบ trim) | `409` พร้อมคืนแถวเดิมให้เลือกแทน |
| อีเมลผิดรูปแบบ (ถ้ากรอกมา) | `400` |

> ⚠️ **ขอบเขตของกฎ "ห้าม trim ชื่อก่อนส่ง Odoo"** — กฎนั้นคุ้มครองชื่อที่ **Odoo เป็นเจ้าของ**
> (มีช่องว่างท้ายจริง 17,666 แถว ห้ามไปแตะ) · ส่วน**ผู้ติดต่อใหม่ที่สร้างจากหน้านี้เราเป็นต้นทางเอง
> จึง trim หัว-ท้ายตั้งแต่ตอนบันทึก** เพราะแอดมินต้องคัดลอกค่านี้ไปคีย์ใน Odoo ด้วยมือ (§5.6)
> การเก็บช่องว่างที่มองไม่เห็นไว้ = สร้างเคส "ชื่อไม่ตรง" ขึ้นมาเปล่า ๆ · และปฏิเสธชื่อที่ trim แล้วว่าง

### 5.5 ตำแหน่งงาน — เก็บใน `local_contacts` และไปถึง Odoo ผ่านมือแอดมิน

ตรวจแล้ว 2026-09-07: **ไม่มีคอลัมน์ตำแหน่งงานทั้งใน `customers` และ `customers_data_view`**
และ template ไฟล์ใบเสนอราคาคอลัมน์ A–T ก็ไม่มีช่องนี้ · PDF ก็ไม่ได้พิมพ์

⇒ เก็บลง `local_contacts.job_position` แล้ว**แสดงในรายการงานค้างพร้อมปุ่มคัดลอก** (§5.6)
ให้แอดมินเอาไปกรอกช่อง Job Position ตอนคีย์ผู้ติดต่อใน Odoo — ตอบโจทย์ข้อ 3.2 ของ requirement แล้ว
โดยไม่ต้องเพิ่มคอลัมน์ใน view หรือแตะ PDF
**ยังไม่พาขึ้น PDF** — ถ้าต้องการเป็นคำถามค้างข้อ 1 ใน §12

### 5.6 ช่องทางนำผู้ติดต่อเข้า Odoo — **รายการงานค้างให้แอดมินคีย์เอง** (ตัดสินใจ 2026-09-07)

> **ยืนยันแล้ว: แอดมินจะไปคีย์ผู้ติดต่อใน Odoo ด้วยมือ ไม่ได้ใช้ไฟล์ import**
> ⇒ **ไม่ต้องมี template `res.partner` ของ Odoo** และไม่ต้องมีตัวสร้างไฟล์ตามสเปกของ Odoo
> สิ่งที่ต้องทำเหลือแค่ "รายการงานค้าง + ปุ่มติ๊กว่าทำแล้ว" ซึ่งเล็กกว่าที่ร่างไว้ใน v2.1 มาก

**ลำดับงานจริงของแอดมิน:**

```
1. เพิ่มผู้ติดต่อในหน้าเว็บ → local_contacts (id 900000001) → ออกใบเสนอราคาได้ทันที
2. เปิดรายการ "ผู้ติดต่อที่ต้องคีย์เข้า Odoo" → คัดลอกทีละช่องไปวางใน Odoo
3. คีย์เสร็จ → กด ✅ "เพิ่มใน Odoo แล้ว" → ประทับ odoo_added_at
4. ค่อย export ไฟล์ใบเสนอราคาตามปกติ
```

**คอลัมน์เดียว ไม่มีตาราง log**

```sql
-- ชื่อสื่อว่า "ถูกเพิ่มเข้า Odoo แล้ว" ไม่ใช่ "ถูกส่งออก" — ไม่มีการส่งไฟล์เข้า Odoo ในเส้นทางนี้
ALTER TABLE public.local_contacts ADD COLUMN IF NOT EXISTS odoo_added_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_local_contacts_pending
  ON public.local_contacts (created_at) WHERE odoo_added_at IS NULL;
```

**ไม่ต้องมีตาราง log การทำงาน** — audit trigger บน `local_contacts` (ขั้น 7) บันทึก
ใคร/เมื่อไหร่/ค่าก่อน-หลัง ให้อยู่แล้ว ต่างจากใบเสนอราคาที่ต้องมี `quotation_export_tracking` แยก
เพราะ `quotations` ติด trigger ไม่ได้ตามกฎถาวร

**ติ๊กยกเลิก = `SET odoo_added_at = NULL`** — คีย์ผิด/ต้องคีย์ใหม่ต้องถอยได้
(กติกาเดียวกับ `odoo_exported_at` ของใบเสนอราคา)

**หน้าจอ: รายการงานค้าง + ปุ่มดาวน์โหลด** (เลือกแล้ว)

* ตารางในแท็บของหน้าเว็บ — ตัวกรอง `pending` (ค่าตั้งต้น) / `all`
* แต่ละแถวมี **ปุ่มคัดลอกรายช่อง**: บริษัท · รหัสอ้างอิง/เลขภาษี (ไว้ค้นบริษัทใน Odoo) ·
  ชื่อผู้ติดต่อ · ตำแหน่งงาน · โทรศัพท์ · อีเมล → ให้ **paste ไม่ใช่พิมพ์** (เหตุผลด้านล่าง)
* ปุ่ม ✅ "เพิ่มใน Odoo แล้ว" ต่อแถว + เลือกหลายแถวพร้อมกันได้
* **ปุ่มดาวน์โหลด xlsx/csv** สำหรับคนที่อยากทำเป็นชุด/ส่งต่อให้คนอื่นคีย์ —
  หัวคอลัมน์เป็น**ภาษาไทยอ่านง่าย** ไม่ใช่ชื่อฟิลด์ของ Odoo (ไฟล์นี้ไม่ได้เอาไป import)
  ใช้ `exceljs` ตัวเดิมที่ `odooSaleOrderExport.ts` ใช้อยู่
* กล่องเตือนหลังกดบันทึกผู้ติดต่อใหม่: "อย่าลืมไปเพิ่มใน Odoo" + ลิงก์มาที่รายการนี้

**⚠️ ความเสี่ยงที่มาพร้อมการคีย์มือ — ชื่อต้องตรงตัวอักษร**

การ dedupe ของ Arm 3 เทียบด้วย **ชื่อผู้ติดต่อ** (`btrim(b3.contact_name) = btrim(l.contact_name)`)
และคอลัมน์ C ของไฟล์ใบเสนอราคาก็ส่งชื่อจาก snapshot ⇒ ถ้าที่คีย์ใน Odoo ไม่ตรงเป๊ะ
(เว้นวรรคเกิน · เติม `คุณ` นำหน้า · สะกดต่าง) จะเกิดสองอย่างพร้อมกัน:

* ผู้ติดต่อโผล่ **ซ้ำ 2 แถว** ใน picker ตลอดไป (แถว local ไม่ยอมหลบเพราะ `NOT EXISTS` ไม่ตรง)
* Odoo อาจจับคู่ผู้ติดต่อของใบเสนอราคาไม่ได้ตอนนำเข้า

กันด้วย: ปุ่มคัดลอกรายช่อง (ให้ paste) · **รายงาน "ผู้ติดต่อค้างเกิน 7 วัน"** ในรายการเดียวกัน ·
และเคส diag ที่ยืนยันว่าชื่อไม่ตรงจะได้ 2 แถว (เพื่อให้พฤติกรรมนี้เป็นสิ่งที่ *รู้* ไม่ใช่ *เซอร์ไพรส์*)

> **ชื่อผู้ติดต่อ *ใหม่* ให้ trim ช่องว่างหัว-ท้ายตั้งแต่ตอนบันทึก**
> ไม่ขัดกับกฎ "ห้าม trim ชื่อก่อนส่ง Odoo" — กฎนั้นคุ้มครองชื่อที่ **Odoo เป็นเจ้าของ**
> (มีช่องว่างท้ายจริง 17,666 แถว ห้ามไปแตะ) ส่วนผู้ติดต่อใหม่เราเป็นต้นทางเอง
> การเก็บช่องว่างที่มองไม่เห็นไว้แล้วให้คนไปคัดลอกคือการสร้างเคสชื่อไม่ตรงขึ้นมาเปล่า ๆ

**ตอนกด export ไฟล์ใบเสนอราคา — เตือนแล้วให้ยืนยันซ้ำ** (ตัดสินใจแล้ว):
ถ้าในชุดที่จะส่งออกมีใบที่อ้างผู้ติดต่อซึ่ง `odoo_added_at IS NULL` → ขึ้น dialog บอกจำนวนใบ
+ รายชื่อผู้ติดต่อ แล้วให้เลือก **"ส่งออกทั้งหมด"** หรือ **"ข้ามใบเหล่านั้น"**
⇒ ไม่บล็อก (ตรงกับหลัก "แอดมินตรวจเอง") แต่ไม่มีทางพลาดโดยไม่รู้ตัว
* จุดต่อ: `GET /api/admin/quotations/export` + หน้า `Quotations.tsx` — เป็น pre-flight check
  ที่เรียกก่อนดาวน์โหลด ไม่ได้แก้ตัว generator ของไฟล์

### 5.7 ทีมขาย (Odoo คอลัมน์ I) — **ตรึงตอนยืนยันใบ** (ตัดสินใจ 2026-09-07)

**ปัญหาที่พบตอนวางลำดับงานตาม 5.6:** คอลัมน์ I มาจาก `ODOO_EXPORT_SALES_TEAM_JOIN` ที่ join
`customers_data_view` ด้วย `q.contact_id` แบบ**สด** ([repositories.ts:388](../db/repositories.ts#L388))
พอ Odoo มีผู้ติดต่อจริงแล้ว sync กลับมา (ทุก ~10 นาที) Arm 3 จะหลบให้แถวจริง ⇒ `contact_id` ของ local
หายจาก view ⇒ **คอลัมน์ I ว่าง** · และเพราะขั้น 3 ของ 5.6 เกิดก่อนขั้น 4 เสมอ นี่จึงเป็น
**ผลลัพธ์ปกติของทุกใบที่ออกให้ผู้ติดต่อใหม่ ไม่ใช่เคสหายาก**

**ทางแก้ที่เลือก:** ตรึง `sales_team` ลงในใบตอน confirm แล้ว export อ่านจากค่าที่ตรึงก่อน

```sql
-- migrations/changes/2026-09-XX_05_quotations_customer_sales_team.sql
ALTER TABLE public.quotations ADD COLUMN IF NOT EXISTS customer_sales_team text;
```

```sql
-- db/repositories.ts — ODOO_EXPORT_SALES_TEAM_JOIN คงไว้ทั้งดุ้นเป็น "ทางถอย"
-- ใบเก่าที่ยืนยันก่อน deploy ไม่มีค่าที่ตรึง → COALESCE ตกกลับไปใช้ join สดแบบเดิมทุกบิต
COALESCE(q.customer_sales_team, st.sales_team)   -- ← ที่จุดประกอบแถว export
```

**⚠️ นี่เป็นการเปลี่ยนพฤติกรรมของเส้นทางเดิม ต้องรู้ตัว:**
* กระทบ **ใบที่ออกจาก LINE ด้วย** ไม่ใช่แค่เว็บ — เป็นข้อยกเว้นข้อเดียวของกติกา "แยกโหมดด้วย `web:%`"
* ใบที่ยืนยันแล้วแต่ยังไม่ export จะ**ไม่รับ**ค่าทีมขายที่เปลี่ยนใน Odoo ภายหลังอีกต่อไป
  — สอดคล้องกับ snapshot ช่องอื่นทั้งหมด (ชื่อ/ที่อยู่/เครดิต/ราคา ตรึงตอนสร้างร่างอยู่แล้ว)
  แต่ถ้าธุรกิจต้องการให้เป็นค่าล่าสุดเสมอ ต้องกลับไปเลือกทางอื่น
* จุดที่แตะ: `confirmQuotationAtomic()` (เส้นทางที่อ่อนไหวที่สุดของระบบ) + `ODOO_EXPORT_SALES_TEAM_JOIN`
  ⇒ **ด่านบังคับ: `npm run diag:confirm-race` + `npm run diag:odoo-export` ทั้งก่อนและหลัง**
* ต้อง resolve ทีมขายใน **transaction เดียวกับการออกเลข** ไม่ใช่หลังจากนั้น ไม่งั้นใบที่ confirm
  สำเร็จแต่ resolve ล้มจะได้ค่า NULL แล้วตกไปใช้ join สด ซึ่งพาปัญหาเดิมกลับมาเงียบ ๆ

### 5.8 เคสข้างเคียง

* **Odoo สร้างคนนี้จริงในภายหลัง** → sync กลับมาเป็นแถว `source='odoo'` (คนละ `contact_id`)
  ⇒ Arm 3 หลบให้เองด้วย `NOT EXISTS` ⇒ ไม่มีชื่อซ้ำใน picker
  · คอลัมน์ I ไม่ได้รับผลอีกแล้วเพราะตรึงไว้ตอน confirm (5.7)
  · เก็บแถว `local_contacts` ไว้ไม่ลบ เพื่อให้ตามรอยย้อนหลังได้
* **แอดมินลบผู้ติดต่อที่เพิ่งเพิ่ม** → ลบทั้ง `local_contacts` และแถวใน `customers_data_view`
  **ปฏิเสธถ้ามีใบเสนอราคาอ้างอยู่แล้ว** (`quotations.contact_id`) — คืน `409`
* **บริษัทเดียวกันในหลาย `company_id` (นิติบุคคลเดียวกัน)** → ผู้ติดต่อใหม่ผูกกับ `company_id`
  ที่แอดมินเลือกเท่านั้น · `getRelatedContactsByCustomerId()` จะพาไปโผล่ในพี่น้องเองตามกติกาเดิม

---

## 6. งานทีละขั้น

### 6.0 แผนที่เฟส — หน่วยส่งมอบเวลาสลับเครื่อง dev ↔ server

> งานนี้จะถูกหยิบทำสลับกันระหว่าง **เครื่อง dev (`C:\Users\bcozf\Downloads\chatbot`)**
> กับ **server (`/home/app_sales/salechatbot/chatbot`)** ⇒ "ขั้น 1–11" ด้านล่างเป็น *เนื้องาน*
> แต่ **หน่วยที่หยิบ/วางได้จริงคือเฟส** ในหัวข้อนี้

#### กติกา 4 ข้อของการสลับเครื่อง

1. **หน่วยส่งมอบ = commit ที่ `push` ขึ้น `origin/dev` แล้ว** — ของที่ค้างใน working directory
   ไม่มีอยู่จริงสำหรับเครื่องอีกฝั่ง · วางมือกลางทางให้ commit เป็น WIP แล้ว push เสมอ
2. **หนึ่งเฟส = จบในตัว** — merge เข้า `main` แล้ว deploy ได้ทันทีโดยไม่ต้องรอเฟสถัดไป
   ⇒ ไม่มีสถานะครึ่ง ๆ ที่ค้างข้ามเครื่อง
3. **migration ของเฟสไหนอยู่ในเฟสนั้น** และต้องตรวจได้ด้วย probe ข้างล่าง
   ห้ามมี migration ที่ต้องรอโค้ดของเฟสหลังถึงจะใช้ได้
4. **commit message ขึ้นต้นด้วย `feat(web): เฟส X — ...`** — `git log --grep` จะกลายเป็น
   บัญชีสถานะที่ไม่มีวันไม่ตรงกับของจริง โดยไม่ต้องไปจดที่อื่น

#### ตารางเฟส

**ตารางนี้เป็นของ v5 แล้ว** — เฟส C/D/E ถูกนิยามใหม่ตาม §0 · เฟสที่เหลือเนื้องานเท่าเดิมแต่เลื่อนตัวอักษร

| เฟส | เนื้องาน | migration | ต้องมีเฟสไหนก่อน | ขึ้น prod เดี่ยวได้ | เครื่องที่เหมาะ | สถานะ |
| --- | --- | --- | --- | --- | --- | --- |
| ~~**A**~~ | ~~เปิดช่องฉีด reply client~~ — **v5 ไม่ใช้แล้ว** โค้ดยังอยู่แต่ไม่มีใครเรียก ถอยออกที่เฟส K | — | — | ✅ ไม่เปลี่ยนพฤติกรรม | — | ⚪ ยกเลิก |
| **B** | ตัวตนพร็อกซี + route ตั้งชื่อผู้จัดทำ (ขั้น 2 · ขั้น 8 เฉพาะ `makers`/`me`) | 1 | — | ✅ | dev | ✅ |
| **C** | **ย้ายตัวสกัดออกเป็น `services/quoteExtraction.ts`** (ขั้น 1′ — ผ่าตัดทางเดินหลักของ LINE) | — | — (อิสระ) | ✅ ย้ายล้วน พฤติกรรมเท่าเดิม | dev เขียน · **ด่าน LINE จริงที่ server** | ⬜ |
| **D** | หลังบ้านของหน้าเว็บ · `services/webQuoteService.ts` + route `/api/admin/webquote/*` (ขั้น 3′ · ขั้น 8′) | — | B **และ** C | ✅ ยังไม่มี UI เรียก | dev | ⬜ |
| **E** | **หน้าเว็บหน้าเดียว** `frontend/src/admin/QuoteRequest.tsx` (ขั้น 9′) | — | D | ✅ **← ฟีเจอร์ใช้งานได้จริงครั้งแรก** | dev | ⬜ |
| **F** | โหมด advise + บันทึกคำเตือน + ป้าย "ข้ามกฎ" (ขั้น 4 · 4b — เดิมเฟส E) | 1 | E | ✅ | dev | ⬜ |
| **G** | override เครดิต + ค่าขนส่ง (ขั้น 5 · ขั้น 7 บางส่วน — เดิมเฟส F) | 2 | E | ✅ | dev | ⬜ |
| **H** | **ตรึงทีมขาย (ขั้น 6c — เดิมเฟส G)** | 1 | — (อิสระ) | ✅ | **server** — กระทบใบ LINE ด้วย | ⬜ |
| **I** | ผู้ติดต่อใหม่ + รายการงานค้างคีย์ Odoo (ขั้น 6 · 6b · ขั้น 7 ที่เหลือ — เดิมเฟส H) | 1 ก้อน (แก้ view) | E **และ H** | ✅ | dev เขียน · **rebuild view ทั้งสองเครื่อง** | ⬜ |
| **J** | ตัวกรอง "ออกจากเว็บ / ออกจาก LINE" (ขั้น 10 — เดิมเฟส I) | — | — (อิสระ) | ✅ | **เครื่องไหนก็ได้** — เฟสสั้นสุด | ⬜ |
| **K** | เอกสาร (ขั้น 11) + **ถอยเฟส A ออก** + ปิดแผน | — | ทุกเฟส | — | เครื่องไหนก็ได้ | ⬜ |

> **ความหมายของสถานะ:** ⬜ ยังไม่เริ่ม · 🟨 โค้ดเสร็จและ push ขึ้น `dev` แล้ว แต่ยังมีด่านที่
> **ทำบนเครื่อง dev ไม่ได้** ค้างอยู่ · ✅ ผ่านด่านครบทุกตัวของเฟสนั้น · ⚪ ยกเลิก (v5 ไม่ใช้แล้ว)
>
> **เฟส A = ⚪ ยกเลิก** — โค้ดเสร็จและ push แล้ว (`70adfd3`) แต่ v5 ไม่เรียก `handleEvent` จากเว็บ
> อีกต่อไป ⇒ `services/chatChannel.ts` และ `opts.client` กลายเป็นทางเข้าที่ไม่มีใครใช้
> **ไม่ต้องปิดด่าน LINE ของเฟส A แล้ว** เพราะจะถูกถอยออกทั้งก้อนที่เฟส K
> (ไม่ถอยทันทีเพราะไม่มีอันตราย ค่าปริยายเท่าของเดิม และเฟส C กำลังจะแตะไฟล์เดียวกันอยู่แล้ว —
> ถอยตอน K ทีเดียวจะได้ไม่ต้องแก้ไฟล์นั้นสามรอบ)
>
> **เฟส B เสร็จแล้ว (✅)** 2026-09-07 — migration ลงบน DB dev แล้ว (probe ข้างล่างขึ้น `ลงแล้ว`)
> · `tsc` ผ่าน · Manual ข้อ 9 + ข้อ 16 ยิงผ่าน HTTP จริงแล้วผ่านหมด · `ensureWebProxy` ทดสอบสร้าง–
> เรียกซ้ำ–ลบจริงบน DB แล้วไม่มีแถวตกค้าง
> ⚠️ **บน server ยังต้องรัน `migrations/changes/2026-09-07_05_admin_users_employee_quotation_id.sql`
> ก่อน deploy โค้ดของเฟสนี้** — ไม่งั้น route `me` จะพังเพราะคอลัมน์ยังไม่มี

**ลำดับที่บังคับจริง ๆ มีแค่นี้ — นอกนั้นสลับได้ตามใจ:**

```
B ─┐
   ├─→ D → E ─┬─→ F
C ─┘          ├─→ G
              └─→ I          (I ต้องมี H ด้วย ไม่งั้นคอลัมน์ I ว่างทันทีที่ผู้ติดต่อเข้า Odoo)
H ────────────────┘          H อิสระจาก B–E ทำเมื่อไหร่ก็ได้ ขอแค่ก่อน I
J                            อิสระทั้งหมด · K ปิดท้าย
```

> **B กับ C ทำสลับกันหรือพร้อมกันก็ได้** — คนละไฟล์กันคนละเรื่องกัน (B = `webIdentity` + route,
> C = ย้ายตัวสกัดใน `lineHandler`) · ถ้าทำพร้อมกันต้องแยก `git worktree` ตามกติกาข้างบน
>
> **ทำไม H ต้องมาก่อน I** — ผู้ติดต่อที่แอดมินเพิ่มเองจะ "หลบ" ให้แถวจริงทันทีที่ Odoo sync กลับมา
> ⇒ `contact_id` หายจาก view ⇒ คอลัมน์ I ว่าง (§5.7) · ถ้าปล่อย I ขึ้นก่อน H จะเกิดกับ**ทุกใบ**
> ที่ออกให้ผู้ติดต่อใหม่ ไม่ใช่เคสหายาก

#### ตรวจว่า "เครื่องที่นั่งอยู่ตอนนี้" ตามถึงไหนแล้ว

**ระบบนี้ไม่มีตารางบัญชี migration** — [`scripts/runMigration.ts`](../scripts/runMigration.ts) แค่รันไฟล์ SQL
ที่ป้อนให้เท่านั้น ไม่จดว่ารันอะไรไปแล้ว ⇒ **ต้องถาม schema เอาเอง** และ probe ข้างล่างคือบัญชีเดียวที่มี

```sql
-- ตรวจ migration ของทุกเฟสในคำสั่งเดียว (อ่านอย่างเดียว รันบน production ได้)
SET statement_timeout = '10s';
SELECT phase AS "เฟส", item AS "ของที่ต้องมีใน DB",
       CASE WHEN ok THEN 'ลงแล้ว' ELSE '- ยัง -' END AS "สถานะ"
FROM (
  SELECT 'B' AS phase, 'admin_users.employee_quotation_id' AS item,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='admin_users'
                    AND column_name='employee_quotation_id') AS ok
  UNION ALL SELECT 'E', 'ตาราง quotation_issue_warnings',
         to_regclass('public.quotation_issue_warnings') IS NOT NULL
  UNION ALL SELECT 'F', 'ตาราง quotation_overrides',
         to_regclass('public.quotation_overrides') IS NOT NULL
  UNION ALL SELECT 'F', 'ตาราง shipping_fee_name_presets',
         to_regclass('public.shipping_fee_name_presets') IS NOT NULL
  UNION ALL SELECT 'G', 'quotations.customer_sales_team',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='quotations'
                    AND column_name='customer_sales_team')
  UNION ALL SELECT 'H', 'ตาราง local_contacts',
         to_regclass('public.local_contacts') IS NOT NULL
  UNION ALL SELECT 'H', 'local_contacts.odoo_added_at',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='local_contacts'
                    AND column_name='odoo_added_at')
  UNION ALL SELECT 'H', 'Arm 3 ใน view customers_data_build',
         COALESCE((SELECT pg_get_viewdef(oid) LIKE '%local_contacts%'
                     FROM pg_class WHERE relname='customers_data_build' AND relkind='v'), false)
) t ORDER BY phase, item;
```

รันที่ไหนอย่างไร:

```bash
# server (DB อยู่ในคอนเทนเนอร์)
docker compose exec -T db psql -U postgres -d chatbot_primus -f - < probe.sql
```
```powershell
# dev (PostgreSQL ลงบนเครื่อง)
psql -U postgres -d chatbot_primus -f probe.sql
```

> ✅ ทดสอบ probe นี้กับ DB จริงแล้ว 2026-09-07 — คืน 8 แถว ทุกแถวเป็น `- ยัง -` ตามที่ควรเป็นก่อนเริ่มงาน

#### รายการก่อนเริ่ม (ทุกครั้งที่นั่งลงทำ ไม่ว่าเครื่องไหน)

```bash
git fetch origin && git status --short              # ต้องสะอาด — ของค้างจากรอบก่อนคือสัญญาณว่ามีอะไรยังไม่ push
git log --oneline --grep='^feat(web): เฟส' -20      # เฟสไหนเสร็จไปแล้วบ้าง (บัญชีฝั่งโค้ด)
<probe SQL ข้างบน>                                  # DB ของเครื่องนี้ตามโค้ดทันหรือยัง (บัญชีฝั่ง DB)
npx tsc --noEmit                                    # ฐานสะอาดก่อนเริ่ม ไม่ใช่ไปเจอตอนจบว่าพังมาแต่แรก
```

**ถ้าสองบัญชีไม่ตรงกัน** (โค้ดมีเฟส F แล้วแต่ probe บอกว่าตาราง `quotation_overrides` ยังไม่มี)
⇒ **รัน migration ที่ขาดบนเครื่องนี้ก่อน** อย่าเพิ่งเขียนโค้ด — อาการจะออกมาหน้าตาเหมือนบั๊กในโค้ด

#### รายการก่อนวางมือ (ห้ามข้าม)

1. `git push origin dev` — **ของที่ไม่ push = ไม่มีอยู่จริง** สำหรับเครื่องอีกฝั่ง
2. ถ้าเฟสนี้มี migration → เขียนชื่อไฟล์ไว้บรรทัดสุดท้ายของ commit message
   เช่น `migration: migrations/changes/2026-09-XX_02_quotation_overrides.sql`
3. อัปเดตช่อง "สถานะ" ในตารางเฟสข้างบน (⬜ → ✅) แล้ว commit ไปด้วยในเฟสนั้น
4. วางมือกลางเฟส → commit เป็น WIP **พร้อมบรรทัดเดียวว่าค้างตรงไหนและเหลืออะไร**

#### กับดักที่เกิดเฉพาะตอนสลับเครื่อง

| กับดัก | ทำไมอันตราย | กัน |
| --- | --- | --- |
| **DB สองเครื่องไม่ migrate ตามกันเอง** | `git pull` ได้โค้ดใหม่ แต่ DB ยังเป็นของเก่า ⇒ error หน้าตาเหมือนบั๊กในโค้ด และเสียเวลาไล่ผิดทาง | probe ทุกครั้งที่นั่งลง (บังคับ) |
| **restore dump ทับ = ถอย migration เงียบ ๆ** | เครื่อง dev ที่ restore dump จาก server ซึ่งยังไม่มี migration ของเฟสที่ทำไปแล้ว จะ**ถอยหลัง**โดยไม่มี error ใด ๆ | หลัง `db:restore` ทุกครั้ง → รัน probe → รัน migration ที่ขาดซ้ำ |
| **เฟส H rebuild view ไม่ข้ามเครื่อง** | `customers_data_view` ต้อง rebuild ด้วย `force: true` **แยกทีละเครื่อง** — merge โค้ดมาแล้ว view ไม่ขยับเอง | ในเฟส H เขียนขั้นตอน rebuild ไว้ใน commit message ด้วย |
| **สองสายทำในเครื่องเดียวกันแต่ checkout เดียว** | เคสจริงที่เคยเกิด: amend/rebase ทับกันแล้วงานที่ยังไม่ commit หายเงียบ | แยก `git worktree` — branch `dev` เดียวกันได้ แต่ *working directory* ต้องคนละอัน |
| **`.env` / `docker-compose.override.yml` คนละค่า** | dev ใช้ `PG_HOST=localhost` + `APP_URL=http://localhost:3011` · server ใช้ `db` + โดเมนจริง | ทั้งสองไฟล์ถูก `.gitignore` อยู่แล้ว — อย่าไปปลดออก |
| **migration ขึ้น prod ล่วงหน้าก่อนโค้ด** | ทุกไฟล์เป็น additive จึงปลอดภัย **ยกเว้นเฟส H ที่แก้นิยาม view** | เฟส H ต้องนับแถวก่อน–หลังทันที (82,512 / odoo 78,206 / saleorder 4,306) |

#### ด่าน LINE จริงของเฟส C — เฟสเดียวของ v5 ที่ต้องมี

**v5 มีเฟสเดียวที่แตะทางเดินของ LINE คือเฟส C** (ย้ายตัวสกัดออกเป็น service) — เฟสอื่นทั้งหมด
เป็นไฟล์ใหม่ที่ LINE ไม่รู้จัก จึงไม่ต้องมีด่านนี้

ด่านคือ *"ยิงข้อความขอใบเสนอราคาจริงใน LINE 1 รอบก่อนย้ายและหลังย้าย ต้องได้ผลเหมือนกันเป๊ะ"* —
ต้องครอบ 3 เคสเป็นอย่างน้อยเพราะเป็นสามทางออกของ `slots`:

1. ข้อความปกติที่รุ่นถูกทุกตัว → ต้องได้การ์ดสรุปเหมือนเดิม
2. รุ่นกำกวม → ต้องได้การ์ดให้กดเลือกรุ่นเหมือนเดิม (ทดสอบ `pending_product` ที่ยังต้องทำงาน)
3. รุ่นพิมพ์ผิด → ต้องได้รายงาน + ปุ่มค้นหาสินค้าเหมือนเดิม

**ทำบนเครื่อง dev ไม่ได้ฟรี ๆ** เพราะต้องสลับ webhook ของ LINE channel มาที่ ngrok
= บอท production หยุดรับข้อความระหว่างนั้น

⇒ ทางที่ถูกกว่า: **deploy เฟส C ขึ้น server ก่อน แล้วทักบอทที่ใช้งานอยู่จริง** — webhook ชี้ที่นั่น
อยู่แล้ว ไม่ต้องสลับอะไร ไม่มี downtime · ส่วน "ก่อนย้าย" ใช้ผลจากบอทตัวเดิมที่ยังรันอยู่ก่อน deploy
· ถ้าจำเป็นต้องทดสอบที่ dev จริง ๆ ต้องนัดช่วงที่ยอมให้บอทเงียบได้ และคืน webhook กลับทุกครั้ง

> **นี่คือเฟสที่เสี่ยงที่สุดของทั้งแผน** — ย้ายโค้ด ~265 บรรทัดออกจากทางเดินหลักของบอทที่ใช้งานจริง
> ⇒ commit ของเฟส C ต้องเป็น **"ย้ายล้วน"** ห้ามปรับปรุงอะไรไปพร้อมกันแม้แต่นิดเดียว
> อยากปรับ ให้แยกเป็น commit ถัดไปหลังด่านผ่านแล้ว จะได้ `git revert` ก้อนเดียวจบถ้าพัง

---

### ~~ขั้น 1~~ — เปิดช่องฉีด reply client  **[เฟส A — v5 ยกเลิก]**

ทำไปแล้ว (`70adfd3`) แต่ v5 ไม่เรียก `handleEvent` จากเว็บอีกแล้ว ⇒ `services/chatChannel.ts`
และ `opts.client` ไม่มีใครเรียก · **ถอยออกที่เฟส K** · รายละเอียดที่ §0.5

---

### ขั้น 1′ — ย้ายตัวสกัดออกเป็น `services/quoteExtraction.ts` (ใหม่)  **[เฟส C]**

**หัวใจของ v5** — ยกโค้ด "ข้อความดิบ → ร่างใบ" ออกจาก `handleEvent` มาเป็น service ที่ทั้ง LINE
และเว็บเรียกร่วมกัน · ขอบเขตที่วัดไว้แล้วอยู่ใน §0.4

**ย้ายอะไรบ้าง** (จาก [`handlers/lineHandler.ts`](../handlers/lineHandler.ts))

| จาก | เนื้อหา |
| --- | --- |
| 1524–1556 | ประกอบ `historyContext` (15 นาทีล่าสุด · ตัดที่ยกเลิก/ยืนยัน) |
| 1557–1638 | prompt สกัด ~80 บรรทัด + กฎ 15 ข้อ |
| 1639–1710 | `parseAiJson` + retry 3 ครั้ง + fallback `UNCLEAR` (`extraction_failed`) |
| 1722–1801 | `findProduct` ทุกรายการ · ซ่อมรหัสที่ถูกตัดบรรทัด · สร้าง `slots` |
| 86–118 | `buildResolvedItem()` — helper บริสุทธิ์ ย้ายไปด้วย |

**หน้าตาที่ต้องการ**

```ts
// services/quoteExtraction.ts (ใหม่)
export interface QuoteSlot {
  resolved: boolean;
  itemForDb?: any;                 // resolved = true
  item?: any;                      // resolved = false — ของที่ AI สกัดมาได้
  candidates?: Array<{ model: string; sales_price: number; /* ... */ }>;
                                   // มี candidate = กำกวม · ไม่มี = พิมพ์ผิด
}

export interface ExtractedQuote {
  intent: 'QUOTATION' | 'REGISTER' | 'UNCLEAR' | string;
  extraction_failed?: boolean;     // UNCLEAR เพราะระบบล่ม ไม่ใช่เพราะเซลส์พิมพ์ไม่ชัด
  reply_message?: string;
  quoteData?: any;                 // quotation_data ดิบจาก AI (customer_query / contact_query / …)
  slots?: QuoteSlot[];             // เรียงตามลำดับที่เซลส์พิมพ์เสมอ
  successReport?: string;          // ข้อความสรุปรายการที่ resolve ได้
  itemReports?: string;            // รายงานรายการที่มีปัญหา
}

export async function extractQuoteFromText(params: {
  userId: string;                  // ใช้ดึงประวัติแชท — เว็บส่ง web:<admin>:<sp> เข้ามา
  text: string;
  remainingMs?: () => number;      // งบเวลา — ไม่ส่ง = ไม่จำกัด
  checkpoint?: (step: string) => void;   // ด่านตรวจของ C.3 — ไม่ส่ง = ไม่ตรวจ
}): Promise<ExtractedQuote>;
```

> ⚠️ **`remainingMs` / `checkpoint` ต้องเป็น optional และค่าปริยายต้องไม่จำกัด/ไม่ตรวจ**
> ของเดิมสองตัวนี้เป็น closure ใน `handleEvent` ที่ผูกกับ `opts.deadlineAt` / `opts.signal`
> ถ้าทำเป็น required เส้นทางเว็บจะต้องปลอมขึ้นมา และเส้น CLI/diag ที่เรียกโดยไม่มี deadline จะพัง

**`lineHandler` เหลืออะไร** — เรียก `extractQuoteFromText()` 1 ครั้ง แล้วเอา `slots` ไปตัดสินใจ
ส่ง Flex เหมือนเดิมทุกบรรทัด (บรรทัด 1802 เป็นต้นไปไม่ต้องแตะ) · branch `REGISTER` ยังอยู่ที่เดิม

> **กติกาเหล็กของเฟสนี้: ย้ายล้วน ห้ามปรับปรุงอะไรไปพร้อมกัน**
> prompt ต้องเหมือนเดิมทุกตัวอักษร (รวมช่องว่าง/ย่อหน้า — มันเป็นส่วนหนึ่งของ input ที่โมเดลเห็น)
> · ตัวเลข `MAX_EXTRACTION_ATTEMPTS = 3` และเกณฑ์ `remainingMs() < 8_000` ห้ามขยับ
> · ลำดับการเรียก `findProduct` ต้องยัง `Promise.all` พร้อมกันเหมือนเดิม
>
> **ด่าน:** `diag:extraction-reliability` · `diag:customer-search` (ก่อน–หลัง) · `diag:queue-sim` ·
> `npx tsc --noEmit` · **ยิงข้อความจริงใน LINE 3 เคส** (ดูท้าย §6.0)

### ขั้น 2 — migration + ตัวตนพร็อกซี · `services/webIdentity.ts` (ใหม่)  **[เฟส B]**

migration: `admin_users.employee_quotation_id` (ดู 2.5) แล้วยุบเข้า `migrations/schema.sql`

```
buildWebUserId(adminId, spUserId)  → `web:${adminId}:${spUserId}`
ensureWebProxy(admin, spUserId)    → upsert แถวพร็อกซี — ก๊อป name/phone/salesperson_id จากเซลส์
                                     · employee_quotation_id จาก admin · ไม่ก๊อป branch · ไม่แตะ status
listActingSalespersons()           → เซลส์ status='active' + has_sale_sig สำหรับ dropdown "ออกในนาม"
listOdooQuotationMakers()          → 70 ชื่อผู้จัดทำจาก sale_orders (invoice_status='invoiced')
```
+ แก้ `GET /api/admin/salespersons` เติมเงื่อนไขกรอง `user_id NOT LIKE 'web:%'`

> **`listOdooQuotationMakers()` เป็นการอ่านหนักจุดเดียวของแผน — และอยู่นอกเส้นทางออกใบ/export**
> วัดจริง 2026-09-04 ด้วย `EXPLAIN (ANALYZE, BUFFERS)`:
> `sale_orders` 317,069 แถว (invoiced 170,110) → **Parallel Seq Scan 5 workers · 212 ms · buffers 43,913 (~344 MB)**
> ⇒ **cache TTL** แบบเดียวกับ `services/rules/cache.ts` + ตั้ง `statement_timeout`
> **`sale_orders` ไม่ถูกแตะเลยทั้งตอนออกใบและตอน export**

### ขั้น 3′ — หลังบ้านของหน้าเว็บ · `services/webQuoteService.ts` (ใหม่)  **[เฟส D]**

ไฟล์ใหม่ทั้งก้อน · **ไม่แตะ `handleEvent` ไม่มี Flex ไม่มี replyToken** · คืน "ข้อมูลดิบ" ให้ frontend
เรนเดอร์เอง · ทุกฟังก์ชันรับ `adminId` + `spUserId` แล้วแปลงเป็น `webUserId` ด้วย `ensureWebProxy()`
จาก §2 ก่อนเสมอ (กัน FK 23503 + refresh ชื่อ/ลายเซ็นเซลส์ให้ทันปัจจุบัน)

```ts
// 1) ข้อความ → ร่าง (ยังไม่เขียน quotations)
proposeFromText({ adminId, spUserId, text })
  → { slots, quoteData, customerCandidates, contactCandidates, unresolvedCount, extractionFailed }
  ใช้ extractQuoteFromText() จากขั้น 1′ + findCustomerCandidates/findContactCandidates
  ⚠️ ยังไม่ deletePendingQuotations และยังไม่ insert — ให้แอดมินเห็นฟอร์มก่อนตัดสินใจ

// 2) ฟอร์มที่แอดมินเคาะแล้ว → ร่างจริงใน DB
createDraft({ adminId, spUserId, customerId, contactId, items })
  → { quotes }           ใช้ processQuotationRequest() / insertDraftQuotations() ตัวเดิม

// 3) บันทึกการแก้ในฟอร์ม — ใช้ PUT /api/quotation/:id เดิม ไม่เขียนใหม่

// 4) ยืนยัน / ยกเลิก — ใช้ POST /api/quotation/:id/confirm | /cancel เดิม ไม่เขียนใหม่

// 5) revise
reviseQuotation({ adminId, spUserId, quotationNo })
  → { draftQuoteId }
  ทำตามลำดับเดียวกับ quotationAgent.handleQuotationEditRequest() เป๊ะ:
  loadActiveQuotation → validateQuotationItems → ยกเลิกร่างค้าง → insertDraftQuotations(appendReviseFrom)
  ต่างกันแค่ **คืน id ของร่าง แทนที่จะคืน Flex** ⇒ frontend เปิดฟอร์มร่างนั้นต่อในหน้าเดิม
```

**คิว** — `new KeyedTaskQueue(4)` ของตัวเอง **ห้ามใช้ instance เดียวกับ `/callback`**
ไม่งั้นแอดมิน 1 คนวางข้อความยาว ๆ จะไปกินสล็อตของเซลส์ที่รอ LINE ตอบอยู่
· ใช้ `runWithDeadline` ตัวเดิม งบ `WEB_BUDGET_MS = 60_000` (เว็บไม่มี replyToken 30 วิมาบีบ)

> **ทำไมแยก `propose` กับ `createDraft` เป็นสองก้าว** — ของเดิมใน LINE ทำรวดเดียว
> (`deletePendingQuotations` แล้ว insert ทันที) เพราะแชทไม่มีที่ให้ "ดูก่อนแล้วค่อยกด"
> ฟอร์มมี ⇒ แยกก้าวได้ **และต้องแยก** ไม่งั้นแค่วางข้อความผิดก็ไปลบร่างที่ค้างอยู่ทิ้งแล้ว

### ขั้น 4 — โหมด advise · `services/quotePolicy.ts` (ใหม่) + จุดต่อ 3 จุด  **[เฟส F]**

ดูรายละเอียดใน §3.2 — `validateQuotationItems` (+~8 บรรทัด) · call site 8 จุด (property เดียวต่อจุด) ·
`getQuotationSummaryMessage` (+~6 บรรทัด)

### ขั้น 4b — บันทึกคำเตือนถาวรตอนยืนยัน  **[เฟส F]**

ดู §3.5 — ตาราง `quotation_issue_warnings` + `confirmQuotationAtomic(quoteId, quote, { warnings })`
(ไม่ส่ง `warnings` = ไม่เขียนอะไร ⇒ LINE ไม่เปลี่ยน) · ป้าย + ตัวกรองในหน้าประวัติทำรวมกับขั้น 10

### ขั้น 5 — override · `services/quoteOverrides.ts` (ใหม่) + 2 migration  **[เฟส G]**

ดู §4 — ตาราง `quotation_overrides` + `shipping_fee_name_presets` ·
เปลี่ยน `applyShippingFeeToQuoteGroup` → `applyQuoteGroupRules` 4 จุด ·
แทนที่การกำหนด `shouldHave` ใน `shippingFee.ts` (~5 บรรทัด)

### ขั้น 6 — ผู้ติดต่อ · `services/localContacts.ts` (ใหม่) + Arm 3  **[เฟส I]**

ดู §5 — ตาราง `local_contacts` + sequence + Arm 3 ใน `customers_data_build` +
watermark 1 บรรทัดใน `refreshCustomerDirectory.ts` + rebuild `customers_data_view` (`force: true`)

### ขั้น 6b — รายการงานค้าง "คีย์ผู้ติดต่อเข้า Odoo" (อยู่ใน `services/localContacts.ts`)  **[เฟส I]**

ดู §5.6 — คอลัมน์ `local_contacts.odoo_added_at` + รายการงานค้างพร้อมปุ่มคัดลอกรายช่อง +
ปุ่มดาวน์โหลด xlsx/csv (หัวคอลัมน์ไทย ไม่ใช่ฟิลด์ Odoo) + pre-flight เตือนตอน export ใบเสนอราคา
**ไม่มีไฟล์ service ใหม่** — งานเล็กพอที่จะอยู่ใน `localContacts.ts` ได้

### ขั้น 6c — ตรึงทีมขายตอนยืนยันใบ  **[เฟส H]**

ดู §5.7 — คอลัมน์ `quotations.customer_sales_team` + resolve ใน `confirmQuotationAtomic()`
+ `COALESCE(snapshot, join สด)` ที่จุดประกอบแถว export

> **ขั้นนี้เป็นขั้นเดียวของแผนที่เปลี่ยนพฤติกรรมของใบที่ออกจาก LINE** — แยก commit ออกมาต่างหาก
> เพื่อให้ย้อนกลับได้เดี่ยว ๆ โดยไม่ต้องถอยทั้งแผน

### ขั้น 7 — audit ของตารางใหม่  **[เฟส G + I]**

เติม 3 ตารางใหม่เข้า loop ของ [2026-09-03_04_audit_logs.sql](../migrations/changes/2026-09-03_04_audit_logs.sql#L330)
(migration ใหม่ที่ใช้ฟังก์ชัน `audit_stmt()` ตัวเดิม — ไม่แก้ไฟล์เก่า):

```
('quotation_overrides',       'quote_override', 'payment_terms', 'quotation_id'),
('local_contacts',            'local_contact',  'contact_name',  'contact_id'),
('shipping_fee_name_presets', 'ship_preset',    'label',         'id')
```
ทั้งสามเขียนเฉพาะตอนแอดมินกดปุ่ม ⇒ ไม่เข้าข่ายกฎห้ามติด trigger (ตารางที่ sync/แชทเขียนรัว)

### ขั้น 8′ — route · `index.ts` (ต่อท้ายกลุ่ม `/api/admin/*`)  **[เฟส B + D + F + G + I]**

> **เปลี่ยนชื่อกลุ่มจาก `webchat` เป็น `webquote`** — v5 ไม่ใช่แชทแล้ว ชื่อเดิมจะทำให้เข้าใจผิดถาวร
> · เฟส B ปล่อย `webchat/makers` กับ `webchat/me` ไปแล้วบน `dev` **แต่ยังไม่เคยขึ้น production**
> ⇒ **เฟส D ย้ายสองตัวนี้ไป `webquote/` ด้วย** ไม่ต้องทำ backward-compat ให้เปลือง

| route | เฟส | สิทธิ์ | หน้าที่ |
| --- | --- | --- | --- |
| `GET /api/admin/webquote/makers` | B→D | admin, subadmin | 70 ชื่อผู้จัดทำจาก Odoo |
| `GET/PUT /api/admin/webquote/me` | B→D | admin, subadmin | อ่าน/ตั้ง `employee_quotation_id` — **PUT 400 ถ้าไม่อยู่ในรายชื่อ** |
| `GET /api/admin/webquote/salespersons` | D | admin, subadmin | รายชื่อ "ออกในนาม" + สถานะลายเซ็น (`listActingSalespersons()` มีแล้วจากเฟส B) |
| `POST /api/admin/webquote/propose` | D | admin, subadmin | **วางข้อความ → คืน `slots` + candidates** (ยังไม่เขียน DB) |
| `POST /api/admin/webquote/drafts` | D | admin, subadmin | ฟอร์มที่เคาะแล้ว → สร้างร่างจริง คืน `quotes` |
| `POST /api/admin/webquote/revise` | D | admin, subadmin | `quotationNo` → ร่าง revision คืน `draftQuoteId` |
| `GET /api/admin/webquote/payment-terms` | F | admin, subadmin | 15 ค่าเครดิตที่มีจริง (ฟีเจอร์ 1) |
| `PUT /api/admin/webquote/quotes/:id/credit` | G | admin, subadmin | เขียนทับเครดิตของใบนั้น — **400 ถ้าค่าไม่อยู่ในชุด** |
| `GET/POST/DELETE /api/admin/webquote/shipping-presets` | G | admin, subadmin | dropdown ชื่อค่าขนส่ง (ฟีเจอร์ 2) |
| `PUT /api/admin/webquote/quotes/:id/shipping` | G | admin, subadmin | ตั้ง `shipping_mode` (`force_on`/`force_off`/ล้าง) + ชื่อ/ราคาของบรรทัด |
| `POST /api/admin/webquote/contacts` | I | admin, subadmin | เพิ่มผู้ติดต่อใหม่ (ฟีเจอร์ 3) |
| `DELETE /api/admin/webquote/contacts/:id` | I | admin, subadmin | ลบผู้ติดต่อที่เพิ่งเพิ่ม (409 ถ้ามีใบอ้างอยู่) |
| `GET /api/admin/webquote/contacts/pending` | I | admin, subadmin | รายการงานค้างคีย์เข้า Odoo (`scope=pending\|all`) + ธง "ค้างเกิน 7 วัน" |
| `GET /api/admin/webquote/contacts/pending.xlsx\|.csv` | I | admin, subadmin | ดาวน์โหลดรายการเดียวกัน หัวคอลัมน์ภาษาไทย (ไม่ใช่ไฟล์ import ของ Odoo) |
| `POST /api/admin/webquote/contacts/mark-added` | I | admin, subadmin | ประทับ/ถอน `odoo_added_at` (ถอน = set NULL) · รับหลาย id พร้อมกัน |
| `GET /api/admin/quotations/export/preflight` | I | admin, subadmin | นับใบที่อ้างผู้ติดต่อซึ่งยังไม่เข้า Odoo → ให้ UI เตือนก่อนดาวน์โหลด |

**หายไปจาก v4 (ไม่ต้องทำแล้ว):** `webchat/history` · `webchat/message` · `webchat/postback`
· `GET /web/quote-edit` + `window.liff` shim — ฟอร์มอยู่ในหน้าเดียวกันแล้ว ไม่ต้องเสิร์ฟหน้า LIFF ซ้ำ

**endpoint เดิมที่หน้าใหม่ใช้ตรง ๆ โดยไม่ต้องแก้อะไร** (ตรวจแล้วว่าไม่มี LINE — §0.3)
`PUT /api/quotation/:id` · `POST /api/quotation/:id/confirm` · `/cancel` ·
`POST /api/quotations/delivery-preview` · `GET /api/products/search` · `/api/products/:code/blocked` ·
`/api/customers/search` · `/api/customer/:id/contacts` · `/api/shipping-fee/config`

> ⚠️ **endpoint ใหม่ในกลุ่ม `/api/admin/webquote/*` ต้องผ่าน `adminAuthMiddleware` + `requireRole` ทุกตัว**
> — โหมด advise (เฟส F) ทำให้ "ใครยิง `POST /webquote/drafts` ได้ = ออกใบข้ามกฎได้ทุกข้อ"
> จึงเป็นเส้นที่ต้องรัดกว่าเส้น LIFF เดิม ไม่ใช่เท่ากัน
>
> ⚠️ **แต่ endpoint เดิม 9 ตัวข้างบนยังตรวจสิทธิ์ด้วย `isQuotationOwner()` จาก `userId` ใน body เหมือนเดิม**
> ([index.ts:1146](../index.ts#L1146)) — หน้าใหม่ต้องส่ง `webUserId` ที่ได้จาก `/webquote/drafts` ไปด้วย
> ระดับความปลอดภัยของเส้นเหล่านี้ **เท่าเดิม ไม่ได้เปิดช่องใหม่** (วันนี้ `/liff/quote-edit` ก็เปิดสาธารณะอยู่)
> ถ้าจะรัดเพิ่มให้ทำเป็นงานแยก ไม่ใช่ของแผนนี้

### ขั้น 9′ — Frontend หน้าเดียว · `frontend/src/admin/QuoteRequest.tsx` (ใหม่) + `AdminApp.tsx`  **[เฟส E + F + G + I]**

* แท็บใหม่ `{ key: 'quoterequest', label: 'ขอใบเสนอราคา', roles: ['admin','subadmin'] }`
* **หน้าเดียว 3 ส่วนเรียงลงมา ไม่มีการเปลี่ยนหน้า ไม่มีแท็บซ้อน**

**ส่วนที่ 0 — แถบตั้งค่า (บนสุด)**
* ยังไม่ตั้ง `employee_quotation_id` → บล็อกทั้งหน้า ให้เลือกชื่อจาก dropdown ก่อน (ครั้งเดียว)
  — dropdown ค้นหาได้อย่างเดียว **ไม่มีช่องพิมพ์ชื่ออิสระ** (ฝั่ง server ตอบ 400 อยู่แล้ว)
* dropdown "ออกในนาม" (บังคับเลือกก่อนพิมพ์) + ป้ายเตือนถ้าเซลส์คนนั้นยังไม่มีลายเซ็น
* ป้ายเล็ก ๆ ว่า "ผู้จัดทำ: &lt;ชื่อแอดมิน&gt;" — ให้เห็นตลอดว่าใบนี้จะถูกบันทึกในนามใคร

**ส่วนที่ 1 — ช่องพิมพ์ข้อความ**
* `textarea` วางข้อความยาว ๆ + ปุ่ม "สร้างร่าง" → `POST /webquote/propose`
* ระหว่างรอ: สปินเนอร์ + ข้อความว่ากำลังสกัด (งบ 60 วิ)
* `extraction_failed` → แถบแดง "ระบบไม่ว่างชั่วคราว" + ปุ่มลองใหม่ **โดยไม่ล้างข้อความที่พิมพ์ไว้**

**ส่วนที่ 2 — ฟอร์มร่าง (หัวใจของ v5)**
* หัวฟอร์ม: บริษัท / ผู้ติดต่อ / เครดิต / เงื่อนไขจัดส่ง — เป็น dropdown ที่ **เติมค่าที่ AI เดาไว้ให้ก่อน**
  * บริษัทกำกวม (มี `customerCandidates` หลายตัว) = dropdown ที่ยังไม่เลือกให้ + ไฮไลต์ว่าต้องเคาะ
  * ค้นหาเพิ่มได้ผ่าน `/api/customers/search` เดิม
* ตารางสินค้า — 1 แถวต่อ 1 `slot` **เรียงตามที่เซลส์พิมพ์เสมอ**:

  | สถานะ slot | หน้าตาในตาราง |
  | --- | --- |
  | `resolved` | แถวปกติ แก้จำนวน/ราคา/ส่วนลดได้ |
  | ไม่ resolved + มี `candidates` (กำกวม) | **dropdown ในแถวนั้น** เลือกรุ่นแล้วแถวกลายเป็นปกติทันที |
  | ไม่ resolved + ไม่มี `candidates` (พิมพ์ผิด) | แถวสีแดง + ช่องค้นหาสินค้า (`/api/products/search`) |

  ⇒ **ไม่ต้องมี state `pending_product` ใน DB เลย** — ความกำกวมถูกแก้ในหน้าเดียวก่อนสร้างร่าง
* เพิ่มแถวสินค้าเอง / ลบแถว / จัดลำดับ ได้ตลอด
* ปุ่ม "สร้างร่าง" → `POST /webquote/drafts` → ได้ `quotes` แล้วฟอร์มสลับเป็นโหมดแก้ใบร่าง
  ซึ่งบันทึกด้วย `PUT /api/quotation/:id` เดิม
* ปุ่ม **ยืนยัน** → `POST /api/quotation/:id/confirm` เดิม → แสดงเลขที่ + ลิงก์ PDF ในหน้าเดียวกัน
* ปุ่ม **ยกเลิก** → `/cancel` เดิม

**ส่วนที่ 3 — revise**
* ช่องกรอกเลขที่ใบ (หรือปุ่มจากหน้าประวัติ) → `POST /webquote/revise` → ได้ `draftQuoteId`
  → **โหลดเข้าฟอร์มส่วนที่ 2 ในหน้าเดิม** ไม่เปลี่ยนหน้า

**ของที่มาทีหลัง (ต่อยอดบนฟอร์มเดิม ไม่ใช่หน้าใหม่)**
* เฟส F — **แถบคำเตือนเหลือง** เหนือปุ่มยืนยัน (จาก `warnings`) · `SYSTEM_ERROR` เป็นแถบแดงแยกชนิด (§3.1)
* เฟส G — 💳 เครดิต: dropdown 15 ค่า + ปุ่ม "คืนค่าเดิม" แสดงค่าจริงของลูกค้ากำกับไว้ให้เทียบ
  · 🚚 ค่าขนส่ง: แถวในตารางสินค้าเลย ช่องชื่อเป็น combobox (เลือก preset หรือพิมพ์ใหม่ +
  ติ๊ก "บันทึกไว้ใช้ครั้งหน้า") + หมายเหตุว่าชื่อนี้ขึ้น PDF แต่ไม่ไป Odoo
* เฟส I — 👤 เพิ่มผู้ติดต่อ: ปุ่มข้าง dropdown ผู้ติดต่อ → ฟอร์ม (ชื่อ*/ตำแหน่ง/โทร/อีเมล) → เลือกให้อัตโนมัติ

> **ไม่มี `FlexRenderer`** — เป็นสิ่งที่ v5 ตัดทิ้งทั้งก้อน (~200 บรรทัดที่ v4 ต้องเขียน)

### ขั้น 10 — ตัวกรอง "ออกจากเว็บ / ออกจาก LINE" · หน้าประวัติใบเสนอราคา  **[เฟส J]**

**ที่มาของค่า:** `quotations.user_id` ขึ้นต้นด้วย `web:` = ออกจากเว็บ · นอกนั้น = ออกจาก LINE
⇒ **ไม่ต้องเพิ่มคอลัมน์และไม่ต้อง backfill**

**ทำตามแบบเดียวกับตัวกรอง "สถานะ Odoo" ที่มีอยู่** (ห้ามเขียน SQL ซ้ำสองที่ — หน้าจอกับปุ่มส่งออก
ต้องกรองตรงกันเสมอ ตามคอมเมนต์ที่ [index.ts:3251](../index.ts#L3251)):

```ts
// db/repositories.ts — วางถัดจาก exportedFilterCondition()
export type SourceFilter = 'all' | 'web' | 'line';
export function parseSourceFilter(raw: any, fallback: SourceFilter): SourceFilter { /* เหมือน parseExportedFilter */ }
export function sourceFilterCondition(filter: SourceFilter): string {
  if (filter === 'web')  return "q.user_id LIKE 'web:%'";
  if (filter === 'line') return "(q.user_id IS NULL OR q.user_id NOT LIKE 'web:%')";
  return '';
}
```

> ⚠️ **กับดัก NULL** — `quotations.user_id` เป็น nullable (FK เป็น `ON DELETE SET NULL`)
> ถ้าเขียนสาย `line` แค่ `q.user_id NOT LIKE 'web:%'` แถวที่ `user_id IS NULL` จะได้ผล NULL → หลุดหายทั้งสองตัวกรอง
> แล้วยอด "เว็บ + LINE" จะไม่เท่ากับ "ทั้งหมด" โดยไม่มีใครสังเกต ⇒ ต้องมี `IS NULL` ในสายนี้เสมอ
> (วัด 2026-09-07: 1,458 ใบ · NULL 0 แถว — แต่เกิดได้ทุกเมื่อที่แอดมินลบพนักงาน)

จุดที่ต้องแก้ (3 ไฟล์):
* `index.ts` — `GET /api/admin/quotations` และ `/export` เพิ่ม `parseSourceFilter` + push condition ทั้งสอง
* `frontend/src/admin/Quotations.tsx` — state + `<select>` + param ทั้ง fetch และ export +
  เพิ่มเข้าเงื่อนไขปุ่ม "ล้างตัวกรอง" ([Quotations.tsx:601](../frontend/src/admin/Quotations.tsx#L601))
* ค่าตั้งต้น `all` ⇒ ผู้เรียกเดิมที่ไม่ส่ง param ได้ผลเหมือนเดิมทุกบิต

**ไม่ต้องเพิ่ม index** — ตาราง 1,458 แถว มี `idx_quotations_user_id` อยู่แล้ว

### ขั้น 11 — เอกสาร + ถอยเฟส A ออก  **[เฟส K]**

เติมหัวข้อสั้นใน `AGENTS.md` (แผนที่งาน + โครงสร้าง + กติกา "โหมด advise ห้อยกับ `web:%` เท่านั้น")
— ไม่มี env ใหม่ จึงไม่ต้องแตะ `DEPLOY.md`

**ถอยเฟส A ออก** (§0.5) — ลบ `services/chatChannel.ts` · ถอน `opts.client` และบรรทัด
`const lineClient = opts.client ?? defaultLineClient` ใน `handleEvent` · คืน `import { lineClient }`
กับ `handleImage` เป็นของเดิม
⇒ **แตะไฟล์เดียวกับเฟส C ⇒ ต้องรันด่านของเฟส C ซ้ำอีกรอบ** (รวมยิงข้อความจริงใน LINE)
· ถ้ายังไม่อยากรันด่านหนักรอบสอง จะเก็บโค้ดเฟส A ไว้เฉย ๆ ก็ได้ ไม่มีอันตราย
(ค่าปริยายเท่าของเดิมทุกบิต) แต่ต้องเขียนคอมเมนต์กำกับว่าไม่มีใครเรียกแล้ว
ไม่งั้นคนอ่านทีหลังจะนึกว่ามีเส้นทางที่ยังใช้อยู่

---

## 7. สิ่งที่ *ไม่* ทำ (กัน regression)

* ไม่แตะ `POST /callback`, `KeyedTaskQueue` instance ของ LINE, `BUDGET_MS`
* ไม่เติม `express.json()` แบบ global (ใช้ per-route เหมือนของเดิม — เผลอใส่ = บอทหยุดตอบทั้งระบบ)
* ไม่ใช้ push message
* **ไม่ก๊อปตรรกะราคา/โปรโมชัน/ราคาขั้นต่ำ/blacklist/เครดิต/สต็อก** — ไหลผ่านเส้นเดิมทั้งหมด
  โหมด advise คือการ **ลดชั้นผลลัพธ์** ของกฎเดิม ไม่ใช่การเขียนกฎชุดใหม่
* ไม่แก้ `productService.ts` · `customerService.ts` · `pdfGenerator.ts` ·
  `quote-edit.html` · `blacklistService.ts` · `creditHoldService.ts`
  — **`quote-edit.html` ไม่ถูกแตะเลยใน v5 เช่นกัน** หน้าใหม่เขียนฟอร์มของตัวเอง
  ไม่ได้ยืมหน้านั้นมาใช้ (v4 เคยจะยืม + ใส่ `window.liff` shim — v5 ตัดทิ้ง)
* ⚠️ **ข้อยกเว้น 2 ข้อ:**
  * ขั้น 6c (ตรึงทีมขาย · เฟส H) แตะ `confirmQuotationAtomic()` และจุดประกอบแถวของ
    `odooSaleOrderExport` — เปลี่ยนพฤติกรรมของใบที่ออกจาก LINE ด้วยโดยตั้งใจ (เหตุผลใน §5.7)
    จึงต้องแยก commit และมีด่าน `diag:confirm-race` + `diag:odoo-export` กำกับ
  * **ขั้น 1′ (ย้ายตัวสกัด · เฟส C)** แตะ `handlers/lineHandler.ts` ~265 บรรทัด
    — ตั้งใจให้ผลลัพธ์เท่าเดิมทุกบิต แต่เป็นการผ่าตัดทางเดินหลัก จึงต้องเป็น commit "ย้ายล้วน"
    และพิสูจน์ด้วยการยิงข้อความจริงใน LINE 3 เคส ไม่ใช่พิสูจน์ด้วยการอ่านโค้ด
* **ไม่แก้ตาราง `customers`** — ผู้ติดต่อใหม่อยู่ในตารางของตัวเอง (จะถูก sync ทับ)
* **ไม่ลบ/แก้ค่าเครดิตของลูกค้าในฐานข้อมูล** — override เป็นของใบนั้นใบเดียว

---

## 8. ความเสี่ยงและการกัน

| ความเสี่ยง | การกัน |
| --- | --- |
| **ย้ายตัวสกัด ~265 บรรทัดออกจาก `handleEvent` แล้วบอททำงานเพี้ยน** (เฟส C — ความเสี่ยงอันดับ 1 ของ v5) | commit "ย้ายล้วน" ห้ามปรับปรุงอะไรพร้อมกัน · prompt ต้องเหมือนเดิมทุกตัวอักษรรวมช่องว่าง · `diag:extraction-reliability` + `diag:customer-search` ก่อน–หลัง · **ยิงข้อความจริงใน LINE 3 เคส** · ถอยได้ด้วย `git revert` ก้อนเดียว |
| **prompt กลายเป็น 2 ชุดแล้วแก้ไม่ครบ** | ไม่ copy — ย้ายออกมาชุดเดียวให้ทั้ง LINE และเว็บเรียก (§0.4) · ถ้าเห็น prompt สกัดโผล่ในไฟล์ที่สองเมื่อไหร่ = ผิดกติกาแผนนี้ |
| **`remainingMs`/`checkpoint` ถูกทำเป็น required แล้วเส้น CLI/diag พัง** | ทั้งคู่ optional · ค่าปริยาย = ไม่จำกัด/ไม่ตรวจ · `diag:web-quote` ข้อ 1 เรียกโดยไม่ส่งทั้งสองตัว |
| โหลดจากเว็บแย่ง slot คิว LINE | คิวคนละ instance, concurrency 4 |
| **ก้าว propose ไปลบร่างที่ค้างอยู่** | `propose` ห้ามเขียน DB เลย · `deletePendingQuotations` ย้ายไปอยู่ที่ `createDraft` เท่านั้น · Manual ข้อ 8b + `diag:web-quote` ข้อ 2 |
| แอดมินลบร่างของเซลส์ใน LINE | `user_id` คนละค่า ⇒ `deletePendingQuotations` แตะเฉพาะร่างของคู่ (admin × เซลส์) นั้น |
| แถวพร็อกซีโผล่ปนในหน้าจัดการพนักงาน | กรอง `NOT LIKE 'web:%'` |
| โปรไฟล์พร็อกซีค้างเก่า | `ensureWebProxy()` refresh ทุก request (1 query) |
| ก๊อป `status` มาจากเซลส์แล้ว flow เพี้ยน | คัดลอกเฉพาะ 5 ช่องโปรไฟล์ ระบุชัดในโค้ด + คอมเมนต์เหตุผล |
| **บันทึกคำเตือนล้มหลัง commit → ได้ใบที่ข้ามกฎโดยไม่มีหลักฐาน** | เขียนใน transaction เดียวกับการออกเลข (§3.5) · ด่าน `diag:confirm-race` |
| **โหมด advise หลุดไปโดนใบของ LINE** | โหมดตัดสินจาก prefix `web:` ที่ LINE user id (`U`+hex32) เป็นไม่ได้ · ด่าน: `diag:quote-validation` ต้องยืนยันว่า userId แบบ LINE ยัง enforce · และ **grep ต้องไม่เจอ `resolveQuotePolicy` นอก 3 จุดที่ระบุ** |
| **ถังพักคำเตือนสลับกันข้ามผู้ใช้** | key = userId + `KeyedTaskQueue` การันตี 1 งาน/key · TTL 5 นาที + เพดานจำนวน key |
| **เครดิตที่ทับไปทำค่าขนส่งอัตโนมัติเปลี่ยน** | ตั้งใจ (ดู 4.4) · หน้าจอต้องบอกผลนี้ตอนแอดมินกดบันทึก |
| **กฎค่าขนส่งลบบรรทัดที่แอดมินสั่งให้มี** | `shipping_mode='force_on'` ทับคำตอบ `shouldHave` · ด่าน: `diag:shipping-fee` ต้องผ่านเหมือนเดิม + เคสใหม่ force_on/force_off |
| **override ค้างข้ามใบ** | FK `ON DELETE CASCADE` กับ `quotations` — ร่างถูกลบ override หายตาม |
| **contact_id ของ local ชนกับ Odoo** | เริ่มที่ 900,000,000 · Odoo อยู่ที่ 1.03M · ห่างกัน ~900 เท่า และยังห่างเพดาน int4 อีกเท่าตัว |
| **Arm 3 ทำ view ที่มีอยู่เปลี่ยนผล** | ตารางว่าง = ผลเดิมทุกแถว · ด่าน: นับแถว/`source` ก่อน–หลัง migration ต้องเท่ากันเป๊ะ (82,512 / odoo 78,206 / saleorder 4,306) |
| **ผู้ติดต่อใหม่ทำผลค้นหาลูกค้าเปลี่ยน** | ด่าน: `npm run diag:customer-search` ก่อน–หลัง (ห้ามใช้ `--mine` เพราะจะเทียบกันไม่ได้) |
| **ผู้ติดต่อใหม่ยังไม่มีใน Odoo ตอนนำเข้าไฟล์** | รายการงานค้าง + `odoo_added_at` + pre-flight เตือนให้ยืนยันซ้ำตอน export ใบเสนอราคา (§5.6) |
| **คีย์ชื่อใน Odoo ไม่ตรงตัวอักษร → ผู้ติดต่อซ้ำ 2 แถวถาวร** | ปุ่มคัดลอกรายช่อง (paste ไม่พิมพ์) · trim ชื่อใหม่ตั้งแต่บันทึก · รายงาน "ค้างเกิน 7 วัน" · เคส diag ข้อ 8 ยืนยันพฤติกรรมนี้ไว้ให้เป็นสิ่งที่รู้ล่วงหน้า |
| **ทีมขาย (คอลัมน์ I) ว่างหลังผู้ติดต่อเข้า Odoo** | ตรึง `customer_sales_team` ตอน confirm + `COALESCE(snapshot, join สด)` (§5.7) |
| **ขั้น 6c ทำให้ทีมขายของใบ LINE ไม่อัปเดตตาม Odoo อีก** | ตั้งใจ (สอดคล้องกับ snapshot ช่องอื่น) · แยก commit ให้ย้อนได้เดี่ยว · ใบเก่าไม่มีค่าที่ตรึง → COALESCE ตกกลับไป join สดเหมือนเดิมเป๊ะ |
| **resolve ทีมขายล้มหลัง confirm สำเร็จ → ได้ NULL เงียบ ๆ** | resolve ใน transaction เดียวกับการออกเลข ไม่ใช่หลังจากนั้น (§5.7) |
| endpoint ใหม่เป็นทางลัดข้ามกฎทั้งหมด | ทุก route ต้องผ่าน JWT + role guard ของ Admin Portal · audit trigger ที่ตารางใหม่ทั้ง 3 |

---

## 9. วิธีทดสอบ

### 9.0 ด่านของแต่ละเฟส — ไม่ต้องรันครบทุกตัวทุกเฟส

รันทุก diag ทุกเฟสคือการเผาเวลา · ตารางนี้บอกว่า**เฟสไหนต้องผ่านอะไรจริง ๆ**
(ทุกเฟสต้องผ่าน `npx tsc --noEmit` เสมอ · เฟสที่แตะ frontend เพิ่ม `npm --prefix frontend run lint && build`)

| เฟส | ด่านบังคับ |
| --- | --- |
| ~~**A**~~ | ยกเลิก — ไม่ต้องปิดด่านแล้ว (§0.5) |
| **B** | ✅ ผ่านแล้ว — Manual ข้อ 9 (`PUT /me` ชื่อมั่ว → 400) + ข้อ 16 (ไม่มี JWT → 401) |
| **C** | **หนักที่สุดของแผน** — `diag:extraction-reliability` · `diag:customer-search` **ก่อน–หลัง** · `diag:queue-sim` · **ยิงข้อความจริงใน LINE 3 เคส** (ปกติ / รุ่นกำกวม / รุ่นพิมพ์ผิด — ดูท้าย §6.0) |
| **D** | `diag:web-quote` ข้อ 1–3 (ใหม่) · Manual 1 ด้วย curl ล้วน ยังไม่มี UI |
| **E** | `frontend lint + build` · Manual 1–6 |
| **F** | `diag:quote-validation` (+เคสใหม่ enforce/advise) · `diag:confirm-race` · Manual 7 · 7b |
| **G** | `diag:shipping-fee` (+เคส force_on/force_off) · `diag:odoo-export` (คอลัมน์ G · M) · `diag:pdf-render` · Manual 10 · 11 |
| **H** | **`diag:confirm-race` + `diag:odoo-export` ทั้งก่อนและหลัง** (เฟสเดียวนอกจาก C ที่กระทบใบ LINE) · Manual 6 ของ webModeSmoke |
| **I** | `diag:customer-search` **ก่อน–หลัง** · `diag:contact-scope` · `diag:orphan-contacts` · นับแถว view ก่อน–หลัง · Manual 12 · 12b–12d · 13 · 14 |
| **J** | Manual 15 (เว็บ + LINE = ทั้งหมด พอดี) |
| **K** | รันด่านของ C ซ้ำอีกรอบหลังถอยเฟส A ออก (แตะไฟล์เดียวกัน) |

**สคริปต์ใหม่ `scripts/diag/webQuoteSmoke.ts` (`npm run diag:web-quote`)** — เขียนเพิ่มทีละส่วนตามเฟส:
1. `extractQuoteFromText()` ด้วยข้อความจริง → ต้องได้ `slots` ครบ 3 แบบ (resolved / กำกวมมี candidate /
   พิมพ์ผิดไม่มี candidate) และ**เรียงตามลำดับที่พิมพ์** · เรียกโดยไม่ส่ง `remainingMs`/`checkpoint` ต้องทำงานได้ **[C]**
2. `proposeFromText()` — ต้อง**ไม่**เขียน `quotations` และ**ไม่**เรียก `deletePendingQuotations` **[D]**
3. `createDraft()` → `PUT /api/quotation/:id` → `confirm` ครบวงจรด้วย `webUserId` **[D]**
4. `reviseQuotation()` — ใบที่ยืนยันแล้ว → ได้ร่าง revision · ใบร่าง (ยังไม่มีเลข) → ต้องปฏิเสธ **[D]**

`scripts/diag/webModeSmoke.ts` ของ v4 ยังใช้ตามเดิมสำหรับเฟส F–J (ข้อ 1–2 ที่ F · 3–4 ที่ G ·
6 ที่ H · 5 · 7–9 ที่ I)

### 9.1 คำสั่งทั้งหมด (อ้างอิงรวม)

```bash
npx tsc --noEmit
npm --prefix frontend run lint && npm --prefix frontend run build

# ── ด่านที่พิสูจน์ว่าเส้นทาง LINE ไม่ขยับ (ต้องผ่านเหมือนก่อนแก้ทุกตัว) ──
npm run diag:queue-sim
npm run diag:quote-validation      # + เคสใหม่: userId LINE = enforce, userId web: = advise
npm run diag:shipping-fee          # + เคสใหม่: force_on/force_off ทับเกณฑ์ได้ · ชื่อ/ราคาที่ตั้งไว้ต้องอยู่รอด
npm run diag:credit-hold
npm run diag:pdf-render
npm run diag:odoo-export           # ช่อง H/J + คอลัมน์ G (เครดิตที่ทับ) + M (รหัสค่าขนส่ง)
npm run diag:contact-scope
npm run diag:orphan-contacts
npm run diag:customer-search       # Arm 3 แตะ customers_data_view → ต้องรันก่อน/หลัง
npm run diag:confirm-race
```

**สคริปต์ใหม่ที่ต้องเขียน:** `scripts/diag/webModeSmoke.ts` (`npm run diag:web-mode`)
1. `resolveQuotePolicy` — `undefined` / LINE id / `web:1:U...` → `enforce / enforce / advise`
2. ยิง `validateQuotationItems` ด้วยรายการที่ผิดกฎทุกชนิด ทั้งสองโหมด →
   enforce ต้องได้ violations ครบ · advise ต้องได้ `violations: []` + `warnings` ครบเท่ากัน
2b. **บันทึกคำเตือน** — ยืนยันใบที่ติดกฎในโหมด advise → ต้องมีแถวใน `quotation_issue_warnings`
   ที่ `warned_count` ตรงกับจำนวน warnings · ยืนยันใบเดียวกันซ้ำ (idempotent) ต้องไม่เกิดแถวซ้ำ ·
   ยืนยันใบจาก LINE → ต้อง**ไม่**มีแถว · ลบใบร่าง → แถวหายตาม CASCADE
3. `applyQuoteGroupRules` — เขียน DB จริงในกลุ่มร่างทดสอบ: เครดิตทับแล้ว snapshot ต้องเปลี่ยน
   และค่าขนส่งอัตโนมัติต้องถอดออกตามเครดิตใหม่ · แล้ว ROLLBACK
4. `force_on` ตอนยอดถึงเกณฑ์/ลูกค้ามีเครดิต → ต้องมีบรรทัด · `force_off` ตอนเข้าเงื่อนไข → ต้องไม่มี ·
   รัน `applyQuoteGroupRules` ซ้ำ 3 รอบ ชื่อและราคาที่ตั้งไว้ต้องไม่ขยับ · ลบแถว override → กลับไปตามเกณฑ์
5. Arm 3 — `INSERT local_contacts` → `getContactsByCustomerId()` ต้องเห็นทันที ·
   rebuild view ด้วย `force:true` แล้วต้องยังเห็น · ใส่ชื่อซ้ำกับผู้ติดต่อ Odoo แล้วต้อง**ไม่**ซ้ำใน view
6. **ตรึงทีมขาย** — ใบที่ยืนยันก่อน migration (`customer_sales_team IS NULL`) ต้องได้คอลัมน์ I
   **เท่าเดิมทุกใบ** ผ่าน COALESCE · ใบใหม่ต้องได้ค่าที่ตรึง · จำลอง "ผู้ติดต่อ local หายจาก view"
   แล้วคอลัมน์ I ต้องยังมีค่า
7. **รายการงานค้างคีย์ Odoo** — `scope=pending` ต้องได้เฉพาะ `odoo_added_at IS NULL` ·
   mark-added แล้วหายจาก pending · ถอน (set NULL) แล้วกลับมา
8. **ชื่อไม่ตรงตอนคีย์มือ** — สร้างแถว Odoo ปลอมที่ชื่อต่างกัน 1 ตัวอักษร แล้วยืนยันว่า Arm 3
   **ไม่**หลบ (ได้ 2 แถว) — พฤติกรรมนี้ต้องเป็นสิ่งที่ทดสอบยืนยันไว้ ไม่ใช่เซอร์ไพรส์หน้างาน
9. **trim ชื่อใหม่** — ส่งชื่อที่มีช่องว่างหัว/ท้ายเข้า `POST /contacts` → ค่าที่เก็บต้องถูก trim แล้ว ·
   และต้องไม่ไปแตะชื่อของผู้ติดต่อที่มาจาก Odoo (ตรวจว่า `customers` ไม่ถูกเขียนเลย)

**เคสบังคับ (ด่านของเฟส C):** ยิงข้อความจริงใน LINE **3 เคส** ก่อนย้ายและหลังย้าย ต้องได้ผลเหมือนกันเป๊ะ
— (1) รุ่นถูกทุกตัว → การ์ดสรุปเดิม · (2) รุ่นกำกวม → การ์ดเลือกรุ่นเดิม · (3) รุ่นพิมพ์ผิด → รายงานเดิม

**Manual บนหน้าเว็บ (ปรับเป็น v5 — ฟอร์ม ไม่ใช่แชท):**
1. วางข้อความปกติ → กด "สร้างร่าง" → ฟอร์มมีรายการครบและเรียงตามที่พิมพ์ → ยืนยัน → ได้เลข + PDF
2. เปิด PDF เช็คว่าชื่อ+ลายเซ็นเป็นของ**เซลส์ที่เลือก** ไม่ใช่แอดมิน
2b. export Odoo: ช่อง H = ชื่อเซลส์ · ช่อง J = ชื่อแอดมิน (สังกัด `(PM)`/`(THT)` ถูกต้อง)
3. **รุ่นกำกวม → แถวนั้นเป็น dropdown** เลือกแล้วกลายเป็นแถวปกติทันที ไม่ต้องรีเฟรช
4. **รุ่นพิมพ์ผิด → แถวสีแดง + ช่องค้นหาสินค้า** เลือกได้จากผลค้นหา
5. **บริษัทซ้ำ → dropdown บริษัทที่หัวฟอร์ม** ยังไม่เลือกให้ + ไฮไลต์ว่าต้องเคาะ
5b. **เพิ่ม/ลบแถวสินค้าเอง** แล้วยอดรวมต้องอัปเดตตรง
6. ลูกค้าไม่มีในระบบ → ฟอร์มให้กรอกข้อมูลลูกค้าในหน้าเดียวกัน (ไม่เด้งออกไปหน้าอื่น)
6b. **revise:** ใส่เลขใบที่ยืนยันแล้ว → ร่างใหม่โหลดเข้าฟอร์มในหน้าเดิม · ใบที่ยังไม่มีเลข → ต้องปฏิเสธ
7. **ลูกค้าถูกระงับ / ติดเครดิต / สินค้าติดกฎ / ต่ำกว่าราคาขั้นต่ำ / สต็อกไม่พอ**
   → ต้องเห็น**คำเตือน** และ**ยังมีปุ่มยืนยัน** และกดแล้วออกเลขได้จริง (ฟีเจอร์ 0)
7b. เปิดหน้าประวัติใบเสนอราคา → ใบจากข้อ 7 ต้องมีป้าย **⚠️ ข้ามกฎ N ข้อ** · คลิกแล้วเห็นข้อความ
   ตรงกับที่เห็นในฟอร์ม · ตัวกรอง "เฉพาะที่ข้ามกฎ" ต้องได้ใบนั้น · ค่าตั้งต้น "ทั้งหมด" ต้องได้ผลเดิม ·
   ไฟล์ export Odoo ต้องยังมี 20 คอลัมน์ A–T เท่าเดิม
8. เซลส์คนเดียวกันพิมพ์ใน LINE พร้อมกับแอดมินทำในเว็บ — ร่างของทั้งสองฝั่งต้องไม่ลบกัน
8b. **วางข้อความผิดแล้วกด "สร้างร่าง" ต้องไม่ไปลบร่างที่ค้างอยู่** (ก้าว propose ห้ามเขียน DB)
9. `PUT /api/admin/webquote/me` ด้วยชื่อมั่ว (curl ข้าม UI) ต้องได้ `400`
10. `PUT .../credit` ด้วยค่าเครดิตมั่ว (curl) ต้องได้ `400` · ค่าที่ถูกต้องต้องขึ้น PDF + Odoo คอลัมน์ G
11. ตั้งชื่อค่าขนส่งเป็นข้อความเอง + สั่ง `force_on` → บันทึก → เปิดหน้าแก้ไขใบ บันทึกซ้ำ →
    **ชื่อและบรรทัดต้องอยู่ครบ** · ชื่อต้องขึ้นบน PDF · Odoo คอลัมน์ M ต้องยังเป็น `SOFBLDXXXX0010`
12. เพิ่มผู้ติดต่อใหม่ → ต้องโผล่ใน picker **ทันทีในบทสนทนาเดียวกัน** → ออกใบ → ชื่อขึ้น PDF + Odoo คอลัมน์ C
12b. **วงจรเต็มของ §5.6:** เพิ่มผู้ติดต่อ → ออกใบ+ยืนยัน → เปิดรายการงานค้าง → **คัดลอกทีละช่อง
   ไปคีย์ใน Odoo จริง** → ติ๊ก ✅ → `sync:customers` → ยืนยันว่าแถว local หลบให้แถวจริงใน picker
   → export ใบเสนอราคา → **คอลัมน์ I ต้องมีทีมขาย ไม่ว่าง** และคอลัมน์ C ต้องเป็นชื่อเดิม
12c. กด export ใบเสนอราคาโดยมีใบที่อ้างผู้ติดต่อยังไม่ติ๊ก → ต้องขึ้น dialog เตือน + เลือก
   "ส่งออกทั้งหมด/ข้ามใบเหล่านั้น" ได้จริงทั้งสองทาง
12d. ปุ่มดาวน์โหลด xlsx/csv ของรายการงานค้าง → เปิดใน Excel แล้วภาษาไทยไม่เพี้ยน (BOM) ·
   หัวคอลัมน์เป็นภาษาไทย · แถวตรงกับที่เห็นบนหน้าจอ
13. เพิ่มผู้ติดต่อชื่อซ้ำกับที่มีอยู่ → `409` พร้อมเสนอแถวเดิม
14. ลบผู้ติดต่อที่มีใบอ้างอยู่ → `409`
15. ตัวกรองแหล่งที่มา: **เว็บ + LINE = ทั้งหมด** พอดี (ทดสอบซ้ำหลัง `UPDATE` แถวหนึ่งเป็น `user_id = NULL`
    ใน transaction ที่จบด้วย ROLLBACK) · ปุ่มส่งออกต้องกรองตรงกับตารางที่เห็น
16. **ยิง endpoint `/api/admin/webquote/*` โดยไม่มี JWT → ต้องได้ 401 ทุกตัว**

---

## 10. ประเมินขนาด

**ปรับเป็น v5 แล้ว**

| ประเภท | ไฟล์ |
| --- | --- |
| **ย้ายออกจากไฟล์เดิม (เฟส C)** | `handlers/lineHandler.ts` **−~265 บรรทัด** → `services/quoteExtraction.ts` แล้วเหลือจุดเรียก ~10 บรรทัด · **ย้ายล้วน ไม่ปรับปรุงอะไร** |
| แก้ไฟล์เดิม (จุดต่อ) | `services/quotationService.ts` (+~12 · **+~12 ที่ `confirmQuotationAtomic` ในขั้น 6c**) · `utils/flexTemplates.ts` (+~6) · `services/shippingFee.ts` (+3) · `services/quotationAgent.ts` (+1) · `scripts/sync/refreshCustomerDirectory.ts` (+1) · `db/repositories.ts` (+~20 · รวม COALESCE ของคอลัมน์ I) |
| แก้ไฟล์เดิม (route/UI) | `index.ts` (+~350 · น้อยกว่า v4 เพราะไม่มี `/web/quote-edit` + shim และไม่มี route แชท) · `frontend/src/admin/AdminApp.tsx` (+~5) · `frontend/src/admin/Quotations.tsx` (+~95 · รวม dialog pre-flight + ป้าย/ตัวกรอง "ข้ามกฎ") |
| ไฟล์ใหม่ (service) | **`quoteExtraction.ts`** · `webIdentity.ts` ✅ · **`webQuoteService.ts`** · `quotePolicy.ts` · `quoteOverrides.ts` · `localContacts.ts` |
| ไฟล์ใหม่ (frontend) | **`QuoteRequest.tsx`** (หน้าเดียว: ช่องพิมพ์ + ตารางสินค้าแก้ได้ + หัวฟอร์ม + revise) + แผงเครื่องมือแอดมิน 3 ตัว + แผงรายการงานค้างคีย์ Odoo |
| ไฟล์ใหม่ (diag) | **`scripts/diag/webQuoteSmoke.ts`** + `scripts/diag/webModeSmoke.ts` |
| ~~ตัดทิ้งจาก v4~~ | ~~`chatChannel.ts`~~ (ถอยที่ K) · ~~`webChatService.ts`~~ · ~~`FlexRenderer.tsx`~~ (~200 บรรทัด) · ~~`/web/quote-edit` + liff shim~~ |
| migration | 7 ไฟล์ เท่าเดิม — `admin_users.employee_quotation_id` ✅ · `quotation_overrides` · `shipping_fee_name_presets` · `local_contacts` + `odoo_added_at` + Arm 3 · **`quotations.customer_sales_team`** · **`quotation_issue_warnings`** · audit triggers ของตารางใหม่ (ทั้งหมด additive) |

**v5 แลกอะไรกับอะไร** — เขียน frontend เองมากขึ้น (ฟอร์มจริง แทนที่จะเรนเดอร์ Flex) แต่ได้คืนมาคือ
ตัดโค้ดตัวกลางทิ้งทั้งก้อน (`webChatService` + `FlexRenderer` + state machine + route แชท 3 เส้น)
และ**ได้ UX ที่ตรงกับที่ต้องการจริง** · ราคาที่ต้องจ่ายเพิ่มคือเฟส C ซึ่งเป็นการผ่าตัดทางเดินหลักของบอท
ครั้งเดียว แล้วจบ

---

## 11. ข้อตัดสินใจที่ปิดแล้ว

* **ตัวตน** — ตัวตนเว็บแยกต่อ (admin × เซลส์) ไม่ใช้ `user_id` ของเซลส์ตรง ๆ (§2.3, §2.6)
* **หน้าแก้ไขใบ** — reuse `quote-edit.html` เดิมเป็น web mode ไม่สร้างหน้าใหม่
* **ชื่อผู้จัดทำ (Odoo ช่อง J)** — บังคับเลือกจากรายชื่อที่มีจริง + ตรวจซ้ำฝั่ง server (§2.3)
* **สิทธิ์เลือกเซลส์** — subadmin เลือก "ออกในนาม" ได้ทุกคนที่ `status='active'` เท่ากับ admin
* **ตัวกรองแหล่งที่มา** — ทำ "ออกจากเว็บ / ออกจาก LINE" ในหน้าประวัติ (ขั้น 10)
* **ไม่ก๊อป `branch`** เข้าแถวพร็อกซี ปล่อย NULL (§2.4)
* **ไม่ snapshot ช่อง J** — คงการอ่านสดจาก `salesperson` ไว้เหมือนเดิม (§1.4)
* **โหมดไม่บล็อก ห้อยกับ `user_id LIKE 'web:%'` เท่านั้น** — ไม่มี flag ระดับระบบ ไม่มีตัวแปร env (§3.2)
* **`SYSTEM_ERROR` ก็ลดชั้นเป็นคำเตือน** แต่เรนเดอร์แยกสีจากคำเตือนอื่น (§3.1)
* **ด่านแข็งที่เหลือ 3 ข้อ** — ต้องผูกลูกค้าก่อนยืนยัน · 409 · 403 (§3.1)
* **บันทึกคำเตือนถาวร + ติดป้ายในหน้าประวัติ** (ทางเลือก ค. · ยืนยัน 2026-09-07) —
  ตาราง `quotation_issue_warnings` เขียนใน tx เดียวกับการออกเลข · ไม่ใส่ลงไฟล์ export Odoo (§3.5)
* **เครดิตเลือกจาก 15 ค่าที่มีจริง ไม่ใช่ช่องพิมพ์อิสระ** เพราะไหลตรงเข้า Odoo คอลัมน์ G (§4.4)
* **ค่าขนส่งใช้สินค้าระบบตัวเดิม** (`SOFBLDXXXX0010`) ไม่สร้างรหัสใหม่ใน Odoo (§4.6)
* **ค่าขนส่งยังเป็น 1 บรรทัดต่อกลุ่มร่างเหมือนเดิม** — override ทับแค่คำตอบ "มี/ไม่มี"
  (`force_on`/`force_off`) · ชื่อกับราคายังอยู่ใน `item_details` ที่กฎเดิมรักษาไว้ให้อยู่แล้ว (§4.5)
* **ไม่เปิดให้แก้จำนวน (quantity) ของบรรทัดค่าขนส่ง** — คงเป็น `cfg.feeQuantity` (§4.5)
* **ชื่อค่าขนส่ง preset ใช้ร่วมทั้งองค์กร** ไม่แยกรายแอดมิน (§4.5)
* **ผู้ติดต่อใหม่อยู่ในตารางของตัวเอง + Arm 3** ไม่เขียนลง `customers` (§5.2)
* **`contact_id` ของ local เริ่มที่ 900,000,000** ห้ามใช้เลขติดลบ (§5.2)
* **ตำแหน่งงาน: ไม่ขึ้น PDF** (ยืนยัน 2026-09-07) — เก็บใน `local_contacts` แล้วแสดงในรายการงานค้าง
  พร้อมปุ่มคัดลอก ให้แอดมินกรอกช่อง Job Position ตอนคีย์ผู้ติดต่อใน Odoo เอง (§5.5)
* **ทำแผนนี้หลัง `plan-product-block-rules.md` จบทั้ง 5 เฟส** (กล่องบนสุดของเอกสาร)
* **ผู้ติดต่อใหม่เข้า Odoo ด้วยการคีย์มือ ไม่ใช่ไฟล์ import** ⇒ ไม่ต้องมี template `res.partner`
  · ระบบให้แค่รายการงานค้าง + ปุ่มคัดลอก + ติ๊กว่าทำแล้ว + ดาวน์โหลด xlsx/csv (หัวคอลัมน์ไทย) (§5.6)
* **ไม่มีตาราง log ของการติ๊ก** — audit trigger บน `local_contacts` ครอบให้แล้ว (§5.6)
* **ชื่อผู้ติดต่อใหม่ trim ตั้งแต่บันทึก** (ต่างจากชื่อที่ Odoo เป็นเจ้าของ ซึ่งห้ามแตะ) (§5.6)
* **ตอน export ใบเสนอราคา: เตือนแล้วให้ยืนยันซ้ำ** ไม่บล็อก (§5.6)
* **ตรึงทีมขาย (คอลัมน์ I) ตอนยืนยันใบ** ด้วย `COALESCE(snapshot, join สด)` — ยอมรับว่าเป็น
  ขั้นเดียวที่เปลี่ยนพฤติกรรมของใบ LINE ด้วย จึงแยก commit (§5.7)

## 12. คำถามที่ยังค้าง

**v5 เปิดคำถามใหม่ 2 ข้อ ที่ตั้งใจให้ตอบตอนถึงเฟสนั้น ไม่ใช่ตอนนี้:**

| คำถาม | ตอบเมื่อ |
| --- | --- |
| ยังต้องมี "ถังพักคำเตือน" (`recordWarnings`/`drainWarnings`) ไหม เมื่อ `webQuoteService` เรียก `validateQuotationItems` เองได้ — เหลือแค่เส้น `confirm` ที่ตรวจกฎอยู่ข้างใน endpoint | **เฟส F** ตอนเห็นโค้ดจริง (§3.3) |
| ฟอร์มควรเก็บร่างที่ยังไม่กด "สร้างร่าง" ไว้ข้ามการรีเฟรชหน้าไหม (ตอนนี้แผนบอกว่าไม่เก็บ — หายก็พิมพ์ใหม่) | **เฟส E** ตอนลองใช้จริง |

**ที่ปิดไปแล้วเมื่อ 2026-09-07:**

| คำถาม | คำตอบ |
| --- | --- |
| ผู้ติดต่อที่แอดมินเพิ่มเองจะเข้า Odoo อย่างไร | คีย์มือ + รายการงานค้าง (§5.6) |
| ชุดคอลัมน์ไฟล์ `res.partner` | ไม่ต้องใช้ เพราะไม่ได้ import |
| ตำแหน่งงานต้องขึ้น PDF ไหม | ไม่ขึ้น — ไปถึง Odoo ผ่านมือแอดมิน (§5.5) |
| ทีมขาย (คอลัมน์ I) ว่างหลังผู้ติดต่อเข้า Odoo | ตรึงตอนยืนยันใบ (§5.7) |
| ใบที่อ้างผู้ติดต่อยังไม่เข้า Odoo ตอน export | เตือนแล้วให้ยืนยันซ้ำ (§5.6) |
| เก็บคำเตือนย้อนหลังไหม | เก็บ + ติดป้ายในหน้าประวัติ (§3.5) |
| ลำดับกับ `plan-product-block-rules.md` | แผนนั้นก่อน (กล่องบนสุด) |

**✅ สถานะปัจจุบัน: ตัวบล็อกหมดแล้ว — `plan-product-block-rules.md` จบครบ 5 เฟสและขึ้น production
เมื่อ 2026-09-07 (`413a721`)** ⇒ เริ่มเฟส A ได้ทันทีที่ได้รับอนุมัติ

**เริ่มที่ไหน:** [§6.0](#60-แผนที่เฟส--หน่วยส่งมอบเวลาสลับเครื่อง-dev--server) → รายการก่อนเริ่ม → เฟส A
(diff 3 บรรทัด ไม่มี migration ไม่เปลี่ยนพฤติกรรม — เป็นเฟสที่ถอยง่ายที่สุดของทั้งแผน)
