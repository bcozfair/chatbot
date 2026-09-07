# แผนงาน: หน้าเว็บขอใบเสนอราคาสำหรับ admin/subadmin (วางข้อความเหมือนคุยใน LINE)

> **สถานะ: v1 — ตัดสินใจครบทุกข้อแล้ว รออนุมัติลงมือ**
> สำรวจจากโค้ดจริง + วัดกับ DB จริง 2026-09-04

---

## สรุปสำหรับตัดสินใจ (อ่านหน้านี้พอ)

**จะทำ:** แท็บใหม่ใน Admin Portal ให้ admin/subadmin **วางข้อความชุดเดียวกับที่เซลส์พิมพ์ใน LINE**
แล้วไหลเข้า pipeline เดิมทั้งเส้น — LLM สกัด → `findProduct` → `processQuotationRequest` → การ์ดสรุปร่าง
→ กดยืนยัน/ยกเลิก → ได้เลขที่ + PDF **โดยไม่มีตรรกะธุรกิจใหม่แม้แต่บรรทัดเดียว**

**หัวใจของแผน 2 ข้อ:**

1. **Adapter ไม่ใช่ refactor** — ตรรกะทั้งหมดอยู่ใน `handleEvent()` ซึ่งผูกกับ LINE แค่จุดเดียวคือ
   `lineClient.replyMessage()` (52 จุด / 50 จุดอยู่ในฟังก์ชันนี้) ⇒ ไม่แตะ 50 จุดนั้น แต่ **shadow ตัวแปร**
   ที่หัวฟังก์ชันแล้วฉีด client ปลอมที่ "เก็บข้อความแทนส่ง" เข้าไป
   ⇒ diff ที่ไฟล์เสี่ยงที่สุดของระบบเหลือ **3 บรรทัด**

2. **ตัวตนพร็อกซี (proxy identity)** — แอดมินไม่ต้องมีรหัสพนักงานขาย/ลายเซ็นของตัวเอง เพราะแอดมิน
   ไม่ใช่ **ผู้ขาย (Odoo ช่อง H)** แต่เป็น **ผู้จัดทำใบ (Odoo ช่อง J `employee_quotations`)** ซึ่งเป็นบทบาท
   ที่มีอยู่จริงในข้อมูล Odoo อยู่แล้ว (41 จาก 70 ชื่อผู้จัดทำไม่ได้เป็นเซลส์ในระบบบอท และเป็นกลุ่มยอดสูงสุด)
   ⇒ บังคับเลือก **ออกในนามเซลส์** ทุกครั้ง แล้วสร้างแถว `salesperson` พร็อกซีที่ก๊อปโปรไฟล์เซลส์มา
   **ยกเว้นช่อง `employee_quotation_id` ที่เป็นชื่อแอดมินเอง** (รายละเอียดหัวข้อ 1.3 + 2)

**migration เดียว: `admin_users.employee_quotation_id` · ไม่แตะ `/callback` · ไม่แตะ `quotationService` / `pdfGenerator` / `odooSaleOrderExport`**

| เฟส | ทำอะไร | เปลี่ยนพฤติกรรมของเดิมไหม |
| --- | --- | --- |
| 1 | เปิดช่องฉีด reply client ใน `lineHandler` (3 บรรทัด) | ❌ ไม่ (ยิงข้อความจริงใน LINE เทียบก่อน/หลัง) |
| 2 | คอลัมน์ `admin_users.employee_quotation_id` + ตัวตนพร็อกซี | ❌ ไม่ (คอลัมน์ใหม่ไม่มีใครอ่านนอกหน้าใหม่) |
| 3 | `webChatService` + route `/api/admin/webchat/*` | ❌ ไม่ (คิวแยก ไม่แย่ง slot LINE) |
| 4 | หน้า React + Flex renderer | ❌ ไม่ |
| 5 | `/web/quote-edit` (reuse ไฟล์ LIFF เดิม + liff shim) | ❌ ไม่ (ไฟล์ HTML ไม่แก้เลย) |
| 6 | ตัวกรอง "ออกจากเว็บ / ออกจาก LINE" ในหน้าประวัติ | ❌ ไม่ (ค่าตั้งต้น `all` = ผลเหมือนเดิม) |

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
| `salesperson` | PK = `user_id` (LINE user id) · `status` ทำหน้าที่ 2 อย่าง: สถานะลงทะเบียน **และ** state machine ของบทสนทนา (`edit_*`, `custom_quote:*`) · `salesperson_id` = รหัสพนักงาน = **ชื่อไฟล์ลายเซ็น** · **ไม่มี unique constraint บน `salesperson_id`** (รหัสซ้ำได้โดยดีไซน์ — [index.ts:2198](../index.ts#L2198) เตือนแต่ไม่บล็อก) |
| `quotations` | `user_id` มี **FK → salesperson(user_id)** (ON DELETE SET NULL) · `employee_details` = snapshot ชื่อ/เบอร์/รหัส ที่ตรึงตอนสร้างร่าง |
| `messages` | ประวัติแชท ไม่มี FK · key ด้วย `user_id` |

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

---

## 2. ตัวตนของใบที่ออกจากเว็บ

### 2.1 โจทย์

แอดมินต้องมีแถวใน `salesperson` ก่อน (เพราะ FK ของ `quotations.user_id`) แต่แอดมิน **ไม่ใช่ผู้ขาย**
ไม่มีรหัสพนักงานขายให้ผูกลายเซ็น และไม่ควรไปโผล่เป็นเจ้าของลูกค้า

### 2.2 คำตอบ — แอดมินคือ **ผู้จัดทำ (ช่อง J)** ไม่ใช่ผู้ขาย (ช่อง H)

เรื่องลายเซ็นและรหัสพนักงาน **หายไปทั้งก้อน** เพราะแอดมินไม่ได้เป็นคนเซ็น:

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
> ฝั่ง server ตรวจซ้ำตอน `PUT` ว่าค่าที่ส่งมาอยู่ในรายชื่อจริง ไม่อยู่ = `400` (ห้ามเชื่อ dropdown ฝั่งเดียว)
> เหตุผล: กันชื่อที่ Odoo ไม่รู้จักไม่ให้หลุดเข้าไฟล์ export ตั้งแต่ต้น
> (ไม่ใช่เพราะแก้ทีหลังไม่ได้ — ช่อง J อ่านสด จึงแก้ย้อนหลังได้ ดู 1.4)
> **ผลที่ต้องยอมรับ:** แอดมินที่ยังไม่เคยมีใบ invoiced ในชื่อตัวเองจะยังใช้หน้านี้ไม่ได้จนกว่าชื่อจะโผล่ในรายชื่อ
> (รายชื่ออัปเดตตามรอบ `npm run sync:saleorders`) — ระหว่างนั้นให้แอดมินคนที่มีชื่อแล้วเป็นคนออกใบให้ไปก่อน

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
>   ให้ LLM ตัดสินตอนบริษัทกำกวม ([customerService.ts:1217](../services/customerService.ts#L1217))
>   **ไม่ได้อยู่ในคะแนน Fuse / ไม่อยู่ใน SQL / ไม่อยู่ใน deterministic evidence boost**
> * **`branch_code` ไม่ถูกใช้เลย** — มีแค่ `console.log` ([customerService.ts:931](../services/customerService.ts#L931))
>   และโค้ดกำกับไว้เองว่า `NO branch_code filter` · [customerService.ts:1474](../services/customerService.ts#L1474)
>   ยืนยันซ้ำว่า **จงใจไม่กรองเขต** เพื่อให้ค้นข้ามเขตได้
> ⇒ **แถวพร็อกซีจึงไม่ก๊อป `branch` มาเลย ปล่อยเป็น NULL** — ไม่ก๊อปข้อมูลที่ไม่มีใครอ่านในเส้นทางนี้
>
> `salesperson.branch` ถูกอ่านเฉพาะใน flow โปรไฟล์/ลงทะเบียนของ LINE
> ([lineHandler.ts:1188](../handlers/lineHandler.ts#L1188) · [flexTemplates.ts:316](../utils/flexTemplates.ts#L316))
> ซึ่งทั้งสองที่มี fallback รองรับค่าว่างอยู่แล้ว (`'ไม่ได้เลือกสาขา'`) ⇒ NULL ไม่ทำอะไรพัง
> ส่วนฝั่งใบเสนอราคา/Odoo มีคอมเมนต์ห้ามใช้ `salesperson.branch` กำกับไว้ชัด 2 จุด
> ([odooSaleOrderExport.ts:98](../services/odooSaleOrderExport.ts#L98) — ทีมขายเป็นคุณสมบัติของ*ลูกค้า* ·
> [repositories.ts:381](../db/repositories.ts#L381))

`pdfGenerator.ts` / `odooSaleOrderExport.ts` / หน้าประวัติ **ไม่ต้องแก้แม้แต่บรรทัดเดียว**
(รหัสพนักงานซ้ำระหว่างแถวจริงกับแถวพร็อกซีเป็นสภาพที่ระบบรองรับอยู่แล้ว — ดู 1.2)

### 2.5 migration เดียวของแผนนี้

```sql
-- migrations/changes/2026-09-XX_01_admin_users_employee_quotation_id.sql
-- ชื่อผู้จัดทำใบฝั่ง Odoo ของแอดมินคนนี้ (ช่อง J ตอน export)
-- ค่าที่ถูกต้องต้องมีอยู่ใน sale_orders.employee_quotations ของแถว invoice_status='invoiced'
ALTER TABLE public.admin_users ADD COLUMN IF NOT EXISTS employee_quotation_id character varying(255);
```
NULL = ยังไม่ได้ตั้งค่า → หน้าเว็บบล็อกไม่ให้เริ่มแชทจนกว่าจะเลือกชื่อตัวเอง
(ไม่มีผลกับผู้ใช้เดิมทั้งหมด เพราะไม่มีโค้ดไหนอ่านคอลัมน์นี้นอกจากหน้าใหม่) · แล้วยุบเข้า `migrations/schema.sql`

### 2.6 ทางเลือกที่พิจารณาแล้วตัดทิ้ง

| ทางเลือก | ทำไมไม่เอา |
| --- | --- |
| ให้แอดมินใช้ `user_id` ของเซลส์ตรง ๆ | `deletePendingQuotations(userId)` จะลบร่างที่เซลส์กำลังทำใน LINE ทิ้งเงียบ ๆ + `status` ชนกัน = regression กับของเดิม |
| แจกรหัสพนักงานขายสมมติให้แอดมิน + อัปโหลดลายเซ็นแอดมิน | ผิดความหมายของช่อง H (แอดมินไม่ใช่ผู้ขาย) และไม่จำเป็น เพราะช่อง J รองรับอยู่แล้ว |
| ก๊อป `employee_quotation_id` จากเซลส์มาด้วย | Odoo จะบันทึกว่าเซลส์คีย์ใบเอง = ข้อมูลผู้จัดทำผิด |

### 2.7 เคสข้างเคียง

* **เซลส์ที่เลือกยังไม่มีลายเซ็น** → ใบไม่มีลายเซ็น = **พฤติกรรมเดิมตอนเซลส์คนนั้นออกใบเอง** ไม่ใช่ปัญหาใหม่
  หน้าเว็บเตือนตั้งแต่ตอนเลือกด้วย flag `has_sale_sig` ที่มีอยู่แล้ว
* **แอดมินคนนั้นเป็นเซลส์จริงด้วย** → ลงทะเบียนแถว `salesperson` ตามปกติ แล้วเลือกตัวเองในช่อง "ออกในนาม"
  (ชื่อจะไปทั้ง H และ J เหมือนตอนพิมพ์ใน LINE)
* **ตามรอยว่าใครกรอก** → ช่อง J บอกอยู่แล้วว่าใครจัดทำ + `user_id LIKE 'web:%'` แยกใบที่ออกจากเว็บได้
  และ `admin_id` ฝังอยู่ใน `user_id` ⇒ ไม่ต้องเพิ่มคอลัมน์ audit อีก

### 2.8 ผลข้างเคียงที่ต้องจัดการ

* `GET /api/admin/salespersons` ต้องกรอง `user_id NOT LIKE 'web:%'` ออก
  ไม่งั้นหน้า "จัดการข้อมูลพนักงาน" จะเต็มไปด้วยแถวพร็อกซีและขึ้นเตือนรหัสซ้ำ
  (`/api/salespeople` ไม่กระทบ — อ่านจาก `sale_orders` ไม่ใช่ตารางนี้)
* `quotation_count` ที่ใช้เตือนตอนลบพนักงาน จะไม่นับใบที่ออกผ่านเว็บของคนนั้น — ยอมรับได้ในเฟสแรก
* **1 คู่ (admin × เซลส์) = ร่างได้ครั้งละ 1 ใบ** เหมือน LINE เป๊ะ (`deletePendingQuotations`)

---

## 3. งานทีละขั้น

### ขั้น 1 — เปิดช่องฉีด reply client · `handlers/lineHandler.ts` (แก้ 3 บรรทัด)

1. บรรทัด 1: `import { lineClient as defaultLineClient, createChatCompletion } from '../config/clients.js';`
2. [lineHandler.ts:281](../handlers/lineHandler.ts#L281) ใน `handleImage` → `defaultLineClient`
3. **บรรทัดแรกสุดของ `handleEvent`**: `const lineClient = opts.client ?? defaultLineClient;`
   + เพิ่ม `client?: ReplyClient` เข้า type ของ `opts`

```ts
// services/chatChannel.ts (ใหม่ ~15 บรรทัด)
export interface ReplyClient {
  replyMessage(p: { replyToken: string; messages: any[] }): Promise<any>;
}
export function createCaptureClient() {
  const captured: any[] = [];
  return {
    captured,
    client: {
      async replyMessage(p: { replyToken: string; messages: any[] }) {
        captured.push(...p.messages);   // เก็บแทนส่งออก LINE
        return null;
      }
    } as ReplyClient
  };
}
```

> ⚠️ **TDZ** — ต้องเป็นบรรทัดแรกจริง ๆ ถ้ามีการอ้าง `lineClient` ก่อนบรรทัดประกาศจะพังตอนรัน
> ไม่ใช่ตอน compile ⇒ ด่านตรวจคือ `npx tsc --noEmit` **บวก** ยิงข้อความจริงใน LINE 1 รอบ
> 50 จุดที่เหลือใน `handleEvent` ไม่ต้องแตะเลย

### ขั้น 2 — migration + ตัวตนพร็อกซี · `services/webIdentity.ts` (ใหม่)

migration: `admin_users.employee_quotation_id` (ดูหัวข้อ 2.5) แล้วยุบเข้า `migrations/schema.sql`

```
buildWebUserId(adminId, spUserId)  → `web:${adminId}:${spUserId}`
ensureWebProxy(admin, spUserId)    → upsert แถวพร็อกซี — ก๊อป name/phone/salesperson_id จากเซลส์
                                     · employee_quotation_id จาก admin · ไม่ก๊อป branch · ไม่แตะ status
listActingSalespersons()           → เซลส์ status='active' + has_sale_sig (ตรรกะเดิมจาก
                                     /api/admin/salespersons) สำหรับ dropdown "ออกในนาม"
listOdooQuotationMakers()          → 70 ชื่อผู้จัดทำจาก sale_orders (invoice_status='invoiced')
                                     ตัดวงเล็บสังกัด + dedupe + เรียงตามงานล่าสุด
                                     → dropdown ให้แอดมินเลือกชื่อตัวเองครั้งเดียว
```
+ แก้ `GET /api/admin/salespersons` เติมเงื่อนไขกรอง `user_id NOT LIKE 'web:%'`

> **`listOdooQuotationMakers()` เป็นการอ่านหนักจุดเดียวของแผน — และอยู่นอกเส้นทางออกใบ/export**
> วัดจริง 2026-09-04 ด้วย `EXPLAIN (ANALYZE, BUFFERS)`:
> `sale_orders` 317,069 แถว (invoiced 170,110) → **Parallel Seq Scan 5 workers · 212 ms · buffers 43,913 (~344 MB)**
> (ไม่มี index ช่วย และไม่ควรสร้างเพื่อ dropdown ที่เรียกครั้งเดียวต่อแอดมิน)
>
> ⇒ **cache TTL** แบบเดียวกับ `services/rules/cache.ts` — รายชื่อเปลี่ยนเฉพาะหลัง `npm run sync:saleorders`
> จึงตั้งยาวได้ · และ **ตั้ง `statement_timeout`** กันของค้างตัวเดียวไปบล็อก rebuild `customers_data_view`
>
> เทียบกับการอ่านอื่นในแผนเพื่อให้เห็นสัดส่วน:
> `LEFT JOIN salesperson` ตอน export = 37 แถว · `ensureWebProxy` = upsert ด้วย PK 1 แถว
> **`sale_orders` ไม่ถูกแตะเลยทั้งตอนออกใบและตอน export** — ค่าที่เลือกถูกตรึงลง
> `admin_users.employee_quotation_id` แล้วก๊อปเข้าแถวพร็อกซี ปลายทางจึงอ่านจาก `salesperson` เท่านั้น

### ขั้น 3 — ตัวกลาง · `services/webChatService.ts` (ใหม่)

`runWebChat({ adminId, spUserId, kind: 'text'|'postback', text?, data? })`

* `ensureWebProxy()` ก่อนเสมอ (กัน FK 23503 + refresh โปรไฟล์)
* ประกอบ synthetic event หน้าตาเดียวกับที่ LINE ส่งมา · `replyToken = 'web-<uuid>'`
* `createCaptureClient()` → `handleEvent(event, { client, deadlineAt, signal })`
* **คิวแยกของตัวเอง** `new KeyedTaskQueue(4)` — ห้ามใช้ instance เดียวกับ `/callback`
  ไม่งั้นโหลดจากเว็บไปแย่ง slot จนเซลส์ใน LINE ตอบไม่ทัน (โดมิโนตัวเดิมที่แผน C แก้ไปแล้ว)
* ใช้ `runWithDeadline` ตัวเดิม แต่ส่งงบ `WEB_BUDGET_MS = 60_000` (เว็บไม่มี replyToken หมดอายุ)
* แปลง action ที่เป็น `uri` ชี้ `liff.line.me/...` → `/web/quote-edit?quoteIds=..&userId=..` **ที่จุดเดียว**

### ขั้น 4 — route · `index.ts` (ต่อท้ายกลุ่ม `/api/admin/*`)

| route | สิทธิ์ | หน้าที่ |
| --- | --- | --- |
| `GET /api/admin/webchat/makers` | admin, subadmin | 70 ชื่อผู้จัดทำจาก Odoo ให้แอดมินเลือกชื่อตัวเอง |
| `GET/PUT /api/admin/webchat/me` | admin, subadmin | อ่าน/ตั้ง `employee_quotation_id` ของตัวเอง — **PUT ปฏิเสธ (400) ถ้าค่าไม่อยู่ในรายชื่อจาก `/makers`** |
| `GET /api/admin/webchat/salespersons` | admin, subadmin | รายชื่อให้เลือก "ออกในนาม" + สถานะลายเซ็น |
| `GET /api/admin/webchat/history?spUserId=` | admin, subadmin | โหลดบทสนทนาเดิมจาก `messages` |
| `POST /api/admin/webchat/message` | admin, subadmin | วางข้อความ → คืน messages ที่ capture ได้ |
| `POST /api/admin/webchat/postback` | admin, subadmin | ยืนยัน/ยกเลิก/เลือกบริษัท/เลือกรุ่น |
| `GET /web/quote-edit` | เท่ากับ `/liff/quote-edit` | เสิร์ฟ `quote-edit.html` เดิม + inject `window.liff` shim |

**เรื่อง auth ของ `/web/quote-edit`** — หน้านี้เรียก `PUT /api/quotation/:id`, `/confirm`, `/cancel`
ซึ่ง **ไม่ได้ตรวจ LINE token อยู่แล้ว** (ใช้ `isQuotationOwner()` จาก `userId` ใน body — [index.ts:1146](../index.ts#L1146))
และ `/liff/quote-edit` ก็เปิดสาธารณะอยู่ตอนนี้ ⇒ ระดับความปลอดภัย **เท่าเดิม ไม่ได้เปิดช่องใหม่**
(ถ้าจะรัดกุมกว่านี้เป็นงานแยกที่ต้องแก้ฝั่ง LIFF ด้วย ไม่ควรพ่วงมาในแผนนี้)

### ขั้น 5 — Frontend · `frontend/src/admin/QuoteChat.tsx` (ใหม่) + `AdminApp.tsx`

* แท็บใหม่ `{ key: 'quotechat', label: 'ขอใบเสนอราคา', roles: ['admin','subadmin'] }`
* ถ้ายังไม่ได้ตั้ง `employee_quotation_id` ของตัวเอง → บล็อกหน้าไว้ ให้เลือกชื่อจาก dropdown ก่อน (ครั้งเดียว)
  — เป็น dropdown ค้นหาได้อย่างเดียว **ไม่มีช่องพิมพ์ชื่ออิสระ** · ถ้าไม่เจอชื่อตัวเองให้ขึ้นข้อความบอกว่า
  ต้องรอชื่อปรากฏใน Odoo ก่อน (หรือให้แอดมินคนอื่นออกใบให้) ไม่ใช่ปล่อยให้พิมพ์เอง
* แถบบน: dropdown "ออกในนาม" (บังคับเลือกก่อนพิมพ์) + ป้ายเตือนถ้าเซลส์คนนั้นยังไม่มีลายเซ็น
  + แสดงตัวเล็ก ๆ ว่า "ผู้จัดทำ: <ชื่อแอดมิน>" ให้เห็นว่าจะถูกบันทึกเข้า Odoo ช่องไหน
* textarea วางข้อความ + สายฟองแชท + ปุ่มจากการ์ด
* `FlexRenderer` เล็ก ๆ รองรับเฉพาะ subset ที่ระบบใช้จริง:
  `bubble(header/body/footer)` · `box(vertical/horizontal)` · `text` · `separator` · `filler` ·
  `button(postback/uri/message)` · `quickReply` (~200 บรรทัด)
* ปุ่ม `uri` ที่ชี้ `/web/quote-edit` → เปิดแท็บใหม่ + ปุ่ม "โหลดสถานะล่าสุด" กลับมาที่แชท

### ขั้น 6 — ตัวกรอง "ออกจากเว็บ / ออกจาก LINE" · หน้าประวัติใบเสนอราคา

**ที่มาของค่า:** `quotations.user_id` ขึ้นต้นด้วย `web:` = ออกจากเว็บ · นอกนั้น = ออกจาก LINE
⇒ **ไม่ต้องเพิ่มคอลัมน์และไม่ต้อง backfill** ใบเก่าทั้งหมดตกเป็น "LINE" โดยอัตโนมัติซึ่งถูกต้องอยู่แล้ว

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

> ⚠️ **กับดัก NULL** — `quotations.user_id` เป็น nullable (FK เป็น `ON DELETE SET NULL` เมื่อพนักงานถูกลบ)
> ถ้าเขียนสาย `line` แค่ `q.user_id NOT LIKE 'web:%'` แถวที่ `user_id IS NULL` จะได้ผล NULL → หลุดหายทั้งสองตัวกรอง
> แล้วยอด "เว็บ + LINE" จะไม่เท่ากับ "ทั้งหมด" โดยไม่มีใครสังเกต ⇒ ต้องมี `IS NULL` ในสายนี้เสมอ
> (ตอนนี้ยังไม่มีแถว NULL — วัดจริง 2026-09-04: 1,405 ใบ, NULL 0 — แต่เกิดได้ทุกเมื่อที่แอดมินลบพนักงาน)

จุดที่ต้องแก้ (3 ไฟล์):
* `index.ts` — `GET /api/admin/quotations` และ `GET /api/admin/quotations/export` เพิ่ม
  `const source = parseSourceFilter(req.query.source, 'all')` + push condition ทั้งสอง endpoint
* `frontend/src/admin/Quotations.tsx` — state `sourceFilter` + `<select>` ข้างตัวกรองสถานะ Odoo +
  ใส่ param ทั้งใน fetch รายการและใน export + เพิ่มเข้าเงื่อนไขปุ่ม "ล้างตัวกรอง" ([Quotations.tsx:601](../frontend/src/admin/Quotations.tsx#L601))
* ค่าตั้งต้น `all` ⇒ ผู้เรียกเดิมที่ไม่ส่ง param ได้ผลเหมือนเดิมทุกบิต

**ไม่ต้องเพิ่ม index** — ตาราง 1,405 แถว มี `idx_quotations_user_id` อยู่แล้วและ seq scan ก็ถูกกว่า

### ขั้น 7 — เอกสาร

เติมหัวข้อสั้นใน `AGENTS.md` (แผนที่งาน + โครงสร้าง) — ไม่มี env ใหม่ จึงไม่ต้องแตะ `DEPLOY.md`

---

## 4. สิ่งที่ *ไม่* ทำ (กัน regression)

* ไม่แตะ `POST /callback`, `KeyedTaskQueue` instance ของ LINE, `BUDGET_MS`
* ไม่เติม `express.json()` แบบ global (ใช้ per-route เหมือนของเดิม — เผลอใส่ = บอทหยุดตอบทั้งระบบ)
* ไม่ใช้ push message
* ไม่ก๊อปตรรกะราคา/โปรโมชัน/ราคาขั้นต่ำ/blacklist/เครดิต — ไหลผ่านเส้นเดิมทั้งหมด
* ไม่แก้ `quotationService.ts` · `productService.ts` · `customerService.ts` · `pdfGenerator.ts` ·
  `odooSaleOrderExport.ts` · `quote-edit.html`

---

## 5. ความเสี่ยงและการกัน

| ความเสี่ยง | การกัน |
| --- | --- |
| shadow ตัวแปรใน `handleEvent` ทำของเดิมพัง | diff 3 บรรทัด + typecheck + ยิงข้อความจริงใน LINE ก่อน/หลัง |
| โหลดจากเว็บแย่ง slot คิว LINE | คิวคนละ instance, concurrency 4 |
| แอดมินลบร่างของเซลส์ใน LINE | `user_id` คนละค่า ⇒ `deletePendingQuotations` แตะเฉพาะร่างของคู่ (admin × เซลส์) นั้น |
| แถวพร็อกซีโผล่ปนในหน้าจัดการพนักงาน | กรอง `NOT LIKE 'web:%'` |
| โปรไฟล์พร็อกซีค้างเก่าหลังแอดมินแก้ข้อมูลเซลส์ | `ensureWebProxy()` refresh ทุก request (1 query) |
| ก๊อป `status` มาจากเซลส์แล้ว flow เพี้ยน | คัดลอกเฉพาะ 5 ช่องโปรไฟล์ ระบุชัดในโค้ด + คอมเมนต์เหตุผล |

---

## 6. วิธีทดสอบ

```bash
npx tsc --noEmit
npm --prefix frontend run lint && npm --prefix frontend run build
npm run diag:queue-sim          # คิว LINE ต้องเหมือนเดิม
npm run diag:quote-validation
npm run diag:pdf-render
npm run diag:odoo-export        # ช่อง H/J ของใบที่ออกจากเว็บต้องเป็นชื่อเซลส์จริง
```

**เคสบังคับ (ด่านของขั้น 1):** ยิงข้อความจริงใน LINE 1 รอบก่อนแก้และหลังแก้ ต้องได้ผลเหมือนกันเป๊ะ

**Manual 8 เคสบนหน้าเว็บ:**
1. ข้อความปกติ → การ์ดสรุป → ยืนยัน → ได้เลข + PDF
2. **เปิด PDF แล้วเช็คว่าชื่อและลายเซ็นเป็นของเซลส์ที่เลือก ไม่ใช่แอดมิน**
2b. **export Odoo แล้วเช็คช่อง H = ชื่อเซลส์ + ช่อง J = ชื่อแอดมิน** (พร้อมสังกัด `(PM)`/`(THT)` ถูกต้อง)
3. รุ่นกำกวม → ปุ่มเลือกรุ่น
4. รุ่นพิมพ์ผิด → รายงานพร้อมปุ่มค้นหาสินค้า
5. บริษัทซ้ำหลายราย → ปุ่มเลือกบริษัท
6. ลูกค้าไม่มีในระบบ → การ์ดกรอกข้อมูลลูกค้า → `/web/quote-edit`
7. ลูกค้าถูกระงับ / ติดเครดิต → ไม่มีปุ่มยืนยัน
8. **เซลส์คนเดียวกันกำลังพิมพ์ใน LINE พร้อมกัน — ร่างของทั้งสองฝั่งต้องไม่ลบกัน**
9. `PUT /api/admin/webchat/me` ด้วยชื่อมั่ว (ยิงตรงด้วย curl ข้าม UI) ต้องได้ `400` ไม่ใช่บันทึกผ่าน
10. ตัวกรองแหล่งที่มา: จำนวนใบของ **เว็บ + LINE ต้องเท่ากับ ทั้งหมด** พอดี (ทดสอบซ้ำหลัง `UPDATE` แถวหนึ่ง
    ให้ `user_id = NULL` ใน transaction ที่จบด้วย ROLLBACK) · และปุ่มส่งออกต้องกรองตรงกับตารางที่เห็น

---

## 7. ประเมินขนาด

| ประเภท | ไฟล์ |
| --- | --- |
| แก้ไฟล์เดิม | `handlers/lineHandler.ts` (3 บรรทัด) · `index.ts` (+~210) · `db/repositories.ts` (+~15) · `frontend/src/admin/AdminApp.tsx` (+~5) · `frontend/src/admin/Quotations.tsx` (+~25) |
| ไฟล์ใหม่ | `services/chatChannel.ts` · `services/webIdentity.ts` · `services/webChatService.ts` · `frontend/src/admin/QuoteChat.tsx` |
| migration | 1 ไฟล์ — `admin_users.employee_quotation_id` (คอลัมน์เดียว, additive) |

---

## 8. ข้อตัดสินใจที่ปิดแล้ว

* **ตัวตน** — ตัวตนเว็บแยกต่อ (admin × เซลส์) ไม่ใช้ `user_id` ของเซลส์ตรง ๆ (หัวข้อ 2.3, 2.6)
* **หน้าแก้ไขใบ** — reuse `quote-edit.html` เดิมเป็น web mode ไม่สร้างหน้าใหม่ (ขั้น 5)
* **ชื่อผู้จัดทำ (Odoo ช่อง J)** — บังคับเลือกจากรายชื่อที่มีจริงเท่านั้น ไม่มีช่องพิมพ์เอง + ตรวจซ้ำฝั่ง server (หัวข้อ 2.3)

* **สิทธิ์เลือกเซลส์** — subadmin เลือก "ออกในนาม" ได้ทุกคนที่ `status='active'` เท่ากับ admin ไม่จำกัดกลุ่ม
* **ตัวกรองแหล่งที่มา** — ทำ "ออกจากเว็บ / ออกจาก LINE" ในหน้าประวัติ (ขั้น 6)
* **ไม่ก๊อป `branch`** เข้าแถวพร็อกซี ปล่อย NULL (หัวข้อ 2.4)
* **ไม่ snapshot ช่อง J** — คงการอ่านสดจาก `salesperson` ไว้เหมือนเดิม ไม่แตะ `quotationService.ts`
  และ `odooSaleOrderExport.ts` (หัวข้อ 1.4)

## 9. คำถามที่ยังค้าง

ไม่มี — พร้อมเริ่มขั้น 1 เมื่อได้รับอนุมัติ
