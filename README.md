## สรุปโครงสร้างโปรเจกต์ Primus Quotation System

---

### 1. API Endpoints ทั้งหมด

#### Public / LIFF Endpoints (ไม่ต้องผ่าน auth)

| Method | Path | คำอธิบาย |
|---|---|---|
| GET | `/` | health check |
| POST | `/callback` | LINE Webhook รับ events ทั้งหมด |
| GET | `/api/liff/config?page=` | ดึง LIFF ID แบบ dynamic (register, quote-edit, product-search) |
| GET | `/liff/register`, `/liff/branch-select` | Serve หน้า LIFF ลงทะเบียน |
| GET | `/liff/quote-edit` | Serve หน้า LIFF แก้ไขใบเสนอราคา |
| GET | `/liff/product-search` | Serve หน้า LIFF ค้นหาสินค้า |
| GET | `/api/quotations?ids=` | ดึงใบเสนอราคาหลายใบ (by IDs) |
| POST | `/api/quotations` | สร้างใบเสนอราคาใหม่ |
| PUT | `/api/quotation/:id` | อัปเดตสินค้า/ลูกค้าในใบเสนอราคา |
| POST | `/api/quotation/:id/confirm` | ยืนยันใบเสนอราคา (ออกเลขที่) |
| POST | `/api/quotation/draft-cart` | สร้าง draft จาก cart ที่มาจาก LIFF |
| GET | `/api/products/search?q=` | ค้นหาสินค้า real-time |
| GET | `/api/customers/search?q=` | ค้นหาลูกค้า |
| GET | `/api/customer/:id/contacts` | ดึง contacts ตาม customer ID |
| GET | `/download-pdf/:id` | สร้างและดาวน์โหลด PDF ใบเสนอราคา |

#### Admin Endpoints (ต้องผ่าน `adminAuthMiddleware` — Bearer JWT)

| Method | Path | คำอธิบาย |
|---|---|---|
| POST | `/api/admin/login` | Login ได้รับ JWT token |
| GET | `/api/admin/quotations` | ดึงใบเสนอราคาทั้งหมด (pagination, filter, sort) |
| GET | `/api/admin/quotations/export` | Export CSV ใบเสนอราคา |
| GET | `/api/admin/promotions` | ดึงโปรโมชันทั้งหมด |
| POST | `/api/admin/promotions` | สร้างโปรโมชันใหม่ |
| PUT | `/api/admin/promotions/:id` | แก้ไขโปรโมชัน |
| DELETE | `/api/admin/promotions/:id` | ลบโปรโมชัน |
| GET | `/api/admin/promotions/export` | Export CSV โปรโมชัน |
| GET | `/api/admin/salespersons` | ดึงรายชื่อพนักงานขายทั้งหมด |
| POST | `/api/admin/signatures/upload` | อัปโหลดลายเซ็น (sale/admin) |
| DELETE | `/api/admin/signatures/:type/:id` | ลบลายเซ็น |
| GET | `/api/admin/quotation-rules` | ดึง rules ทั้งหมด |
| GET | `/api/admin/quotation-rules/options` | ดึง production/brand/series options |
| POST | `/api/admin/quotation-rules` | สร้าง rule ใหม่ |
| PUT | `/api/admin/quotation-rules/:id` | แก้ไข rule |
| DELETE | `/api/admin/quotation-rules/:id` | ลบ rule |
| GET | `/api/admin/customers/search?q=` | ค้นหาลูกค้า (สำหรับ promotion form) |
| GET | `/api/admin/products/customer-types` | ดึงประเภทลูกค้า |
| GET | `/api/admin` | Serve Admin SPA |

---

### 2. Database Schema

#### ตาราง Application

**`quotations`** — ใบเสนอราคา
```
id (UUID PK), user_id (LINE user_id), customer_name (TEXT: "บริษัท | ผู้ติดต่อ | meta"),
items (JSONB), total_sum (NUMERIC), status (draft/pending_company/pending_contact/confirmed/cancelled),
quotation_no (TEXT: QP-YYMMXXXXX / QT-YYMMXXXXX), created_at, updated_at,
delivery_days_override (INT NULL) — จำนวนวันจัดส่งที่เซลล์แก้เองจากหน้า LIFF (NULL = ใช้ค่าที่คำนวณจาก quotation_rules)
```

**`admin_users`** — ผู้ดูแลระบบ
```
id (SERIAL PK), username (VARCHAR 50 UNIQUE), password_hash (VARCHAR 255),
name (VARCHAR 100), role (VARCHAR 20 DEFAULT 'admin'), created_at, updated_at
```

**`promotions`** — โปรโมชันส่วนลด
```
id (SERIAL PK), code (VARCHAR 50 UNIQUE), name (VARCHAR 100), description (TEXT),
discount_type (percent/fixed/override), discount_value (NUMERIC),
product_code (TEXT comma-separated), customer_type (TEXT comma-separated),
customer_refs (TEXT comma-separated), min_qty (INT),
start_date, end_date (TIMESTAMPTZ), is_active (BOOLEAN), created_at, updated_at
```

**`quotation_rules`** — เงื่อนไขใบเสนอราคาตามยี่ห้อ/ฝ่ายผลิต
```
id (SERIAL PK), production (TEXT), brand (TEXT), series (TEXT),
warranty_years (INT DEFAULT 1), warranty_unit (month/year DEFAULT year),
is_locked (BOOLEAN DEFAULT false),
delivery_in_stock_days (INT DEFAULT 3), delivery_out_of_stock_days (INT DEFAULT 7),
delivery_days_qty_10/20/50/100 (INT NULL) — วันจัดส่งเมื่อสั่ง >= N ชิ้นและสต็อกไม่พอ
                                            (NULL = ไม่ใช้ tier ขั้นนั้น)
created_at, updated_at
```

**`salesperson`** — พนักงานขาย (จาก LINE)
```
user_id (LINE user_id PK), name, phone, salesperson_id (รหัสพนักงาน),
status (pending_branch/pending_profile/pending_profile_confirm/active/edit_field:...),
branch_code (TEXT comma-separated), created_at, updated_at
```

**`messages`** — log การสนทนา LINE
```
user_id, message_id, type, content, reply_token, reply_content, created_at
```

#### ตาราง Sync จาก Odoo

**`customers`** (raw sync) — ข้อมูลลูกค้า+ผู้ติดต่อ PK: `(company_id, contact_id)`
- ฟิลด์สำคัญ: customer_reference, customer_tax_id, customer_name, contact_name, invoice_address (street/district/sub_district/state/zip), salesperson, branch, customer_type

**`customers_view`** (VIEW) — แสดงข้อมูลลูกค้าแบบ deduplicated
- ฟิลด์ที่ใช้: id (company_id), display_name, reference, branch_code (= branch), tax_id, phone, email

**`contacts_view`** (VIEW) — ผู้ติดต่อเชื่อมกับบริษัท
- ฟิลด์: id, name, customer_id, mobile, phone, email, invoice_address

**`products`** — ข้อมูลสินค้า PK: `product_template_id`
- ฟิลด์สำคัญ: model (= code), name, brand, series, sales_price (= price), minimum_sales_price, actual_quantity (= stock), product_sub_category (= category), production, sales_description

**`sale_orders`** — ประวัติใบสั่งซื้อ PK: `(order_reference, model_code, model)`
- ฟิลด์สำคัญ: salesperson, salesperson_id, salesperson_phone, employee_quotations, employee_quotations_phone, customer_sale_area, sales_team

**`sync_state`** — เก็บ cursor ของการ sync แต่ละ resource

---

### 3. Business Logic หลักของแต่ละ Service

#### `customerService.ts`
- **`findCustomerCandidates()`**: ค้นหาลูกค้าด้วย 3 วิธีตามลำดับ:
  1. Fast-path จากรหัส reference code (ถ้าพิมพ์เลขอ้างอิง)
  2. Pre-Search AI (DeepSeek) สกัด "Core Name" ออกจากชื่อบริษัทที่พิมพ์มา
  3. Fuzzy search ด้วย Fuse.js บน candidates ที่ดึงจาก DB
  4. AI Matching เลือก candidate ที่ดีสุด (จาก DeepSeek) เมื่อมีหลายตัวเลือก
- **`findContactCandidates()`**: ค้นหาผู้ติดต่อ — match phone ก่อน ถ้าไม่เจอค่อย fuzzy ชื่อด้วย Fuse.js
- **`buildDotInitialVariants()`**: จัดการชื่อบริษัทที่ใช้จุดย่อ เช่น "บ.เอ.เค.พลาสติก"

#### `productService.ts`
- **`findProduct()`**: ค้นหาสินค้า 3 stage:
  1. Exact match — normalize ทั้งสองฝั่ง ตัด `()` ออก
  2. pg_trgm fuzzy search — similarity > 0.25, ถ้า score ≥ 0.85 ยืนยันทันที
  3. AI Pick (DeepSeek) เมื่อ score ปานกลาง
  4. Legacy fallback เมื่อ pg_trgm ไม่พร้อม

#### `quotationService.ts`
- **`processQuotationRequest()`**: orchestrate การสร้างใบเสนอราคาจากแชท:
  - หาลูกค้า → ถ้าไม่เจอ/หลายตัว แสดง Flex Message ให้เลือก
  - หาผู้ติดต่อ → ถ้าไม่เจอ/หลายตัว แสดง Flex Message ให้เลือก
  - Auto-select เมื่อ top candidate ชนะชัดเจน (score gap > 0.05)
- **`insertDraftQuotations()`**: **แยก items เป็น 2 ใบอัตโนมัติ** ตาม `production === 'Import(PM)'` (QT=Themtech, QP=Primus)
- **`getQuotationNo()`**: สร้างเลขที่ `QP-YYMMXX001` หรือ `QT-YYMMXX001` นับตาม prefix ในเดือนนั้น
- **`getBlockedProductError()`**: ตรวจสอบสินค้าที่ถูก lock ใน `quotation_rules`
- **`cancelOldRevision()`**: ยกเลิกใบเสนอราคาเดิมเมื่อทำ revision

#### `promotionValidator.ts`
- **`validateProductPriceWithPromotions()`**: ตรวจสอบว่าราคาหลังลดผ่านเงื่อนไขโปรโมชันใดๆ หรือไม่ รองรับ 3 ประเภท: percent, fixed, override
- ตรวจสอบทั้ง qty ขั้นต่ำ, product_code, customer_type, customer_refs, วันที่มีผล
- ถูกเรียกทั้ง chatbot confirm flow และ LIFF summary message

#### `pdfGenerator.ts`
- ใช้ Puppeteer สร้าง PDF แบบ A4
- รองรับ pagination อัตโนมัติตาม weight ของ item (description ยาว = weight สูง)
- ดึง quotation_rules เพื่อคำนวณ warranty และ delivery time อัตโนมัติ
- ฝัง logo และลายเซ็นแบบ Base64
- แสดง 2 version: Primus (QP) และ Themtech (QT) โดยใช้ logo/address ต่างกัน

---

### 4. LIFF Pages และ Flow การทำงาน

#### `/liff/register` — ลงทะเบียนพนักงานขาย
- เปิด LIFF SDK → ดึง LINE Profile
- กรอกชื่อ, เบอร์โทร, รหัสพนักงาน
- เลือกสาขา (checkbox multiple)
- บันทึกผ่าน `PUT /api/liff/salesperson`
- ส่งข้อความ "บันทึกสาขาเรียบร้อยแล้ว" กลับไปยัง LINE chat

#### `/liff/product-search` — ค้นหาสินค้า + เพิ่มลงตะกร้า
- ค้นหาสินค้าแบบ real-time ผ่าน `/api/products/search`
- เลือกสินค้า → กำหนด qty → เพิ่มลง cart
- กด "💾 ร่างใบเสนอราคา" → เรียก `/api/quotation/draft-cart` (สร้างใบสถานะ `pending_company` ลูกค้าเป็น `null`)
- ส่งข้อความกลับ LINE chat พร้อมรหัส quote IDs เพื่อ trigger bot
- บอทตอบ **Flex สรุปร่าง** ทันที — ข้อมูลลูกค้าขึ้นเป็น `— ยังไม่ระบุ —` และยังไม่มีปุ่มยืนยัน
  ต้องกด "🏢 กรอกข้อมูลลูกค้า" เข้าหน้า quote-edit เลือกบริษัท/ผู้ติดต่อก่อน (หรือพิมพ์ชื่อบริษัทในแชทก็ได้)

#### `/liff/quote-edit` — แก้ไขใบเสนอราคา
- รับ `?quoteIds=` จาก URL
- ดึงข้อมูลใบเสนอราคาจาก `/api/quotations?ids=`
- ค้นหาและเลือกลูกค้า/ผู้ติดต่อ
- แก้ไข qty, ราคา, discount ของแต่ละสินค้า
- ไม่มี auto-save — บันทึกเมื่อกดปุ่ม "💾 บันทึก" เท่านั้น (`PUT /api/quotation/:id`)
- บันทึกสำเร็จ → ส่งข้อความ "📝 บันทึกร่างใบเสนอราคาแล้ว (รหัส: ...)" กลับ LINE → บอทตอบ Flex สรุปร่าง
- ยืนยันออกเอกสารทำผ่านปุ่มใน Flex สรุปนั้นเท่านั้น (postback `action=confirm`) — หน้า LIFF ไม่ยืนยันเอง
- ปุ่ม "❌ ยกเลิก" = ปิดหน้าแก้ไข (เตือนถ้ายังไม่ได้บันทึก) ไม่ใช่การยกเลิกร่างใบเสนอราคา

---

### 5. Frontend Admin Pages

| Page | Component | Features |
|---|---|---|
| Login | `Login.tsx` | Form username/password → POST `/api/admin/login` → JWT → localStorage |
| Dashboard | `AdminApp.tsx` | Welcome card, quick nav ไป tab ต่างๆ |
| ประวัติใบเสนอราคา | `Quotations.tsx` | ตาราง pagination, filter status/วันที่/search, expand แสดงสินค้า, download PDF, export CSV |
| โปรโมชัน | `Promotions.tsx` | CRUD promotion, multi-select product/customer/ref tags, sort, toggle active, import/export CSV |
| ลายเซ็นพนักงาน | `Salespersons.tsx` | ดู list พนักงาน, upload sale_sig/admin_sig (PNG/JPG ≤5MB), preview, delete, sort |
| เงื่อนไขใบเสนอราคา | `QuotationRules.tsx` | CRUD rules, ComboBox dropdown ที่ filter brand/series ตาม production ที่เลือก, is_locked toggle, warranty_unit (month/year) |

**Auth Context** (`AuthContext.tsx`): เก็บ JWT + user info ใน localStorage, expose `useAuth()` hook

---

### 6. Dependencies หลัก

#### Backend (`package.json`)
| Package | เวอร์ชัน | การใช้งาน |
|---|---|---|
| `express` | ^5.2.1 | Web framework |
| `pg` | ^8.21.0 | PostgreSQL client (pool) |
| `@line/bot-sdk` | ^11.0.0 | LINE Bot + LIFF |
| `openai` | ^6.38.0 | DeepSeek API (AI matching) |
| `puppeteer` | ^25.0.2 | PDF generation |
| `jsonwebtoken` | ^9.0.3 | JWT auth |
| `bcryptjs` | ^3.0.3 | Password hashing |
| `fuse.js` | ^6.6.2 | Fuzzy search |
| `thai-baht-text` | ^2.0.5 | แปลงตัวเลขเป็นตัวอักษรไทย |
| `dotenv` | ^17.4.2 | ENV config |
| `tsx` | ^4.22.4 | TypeScript runtime (dev) |

#### Frontend (`frontend/package.json`)
| Package | การใช้งาน |
|---|---|
| `react` + `react-dom` ^19 | UI framework |
| `tailwindcss` ^4 | Styling |
| `lucide-react` | Icons |
| `recharts` | Charts (ติดตั้งไว้แต่ยังไม่ใช้ใน Dashboard) |
| `vite` ^8 | Build tool |

---

### 7. สิ่งที่น่าสังเกตและจุดที่ควรระวัง

**🔴 Critical Issues**

1. **`enrichQuotationData()` และ endpoints LIFF ยังใช้ Supabase-style query** เช่น `db.from('customers').select().eq().maybeSingle()` ซึ่งผ่าน `dbClient.ts` wrapper — ขัดกับกฎที่ระบุใน AGENTS.md ว่าควรใช้ `pool.query()` ตรง ๆ เท่านั้น แต่ในทางปฏิบัติ wrapper นี้ทำงานได้ผ่าน pg pool อยู่แล้ว

2. **`customers_raw` → mapping ไปตาราง `customers`** ใน `dbClient.ts` — ชื่อตารางถูก map ใน TABLE_MAP ซึ่งอาจทำให้สับสนเมื่ออ่านโค้ด

3. **`enrichQuotationData()` มี logic ซับซ้อนมากใน `index.ts`** (~200 บรรทัด) ควรย้ายออกไปเป็น helper function แยกต่างหาก

**🟡 Design Concerns**

4. **`customer_name` field ใน quotations ถูกใช้เป็น encoded string** รูปแบบ `"บริษัท | ผู้ติดต่อ | key=val&key2=val2"` — เป็น pattern ที่เปราะบาง หาก format เปลี่ยนจะ break หลายจุด

5. **`salesperson.status` ถูกใช้เป็น state machine แบบ string** เช่น `"custom_quote:ชื่อบริษัท"`, `"edit_field:salesperson:phone"` — ควรระวังเมื่อ string มีตัวอักษรพิเศษ

6. **`sale_orders` table ถูกใช้เพื่อ lookup salesperson info** ใน `dbClient.ts` (salespeople query) ซึ่งหมายความว่าพนักงานขายที่ไม่มีประวัติใบสั่งซื้อจะไม่ปรากฏ

7. **`recharts` ถูก import ใน frontend แต่ Dashboard ไม่ได้ใช้ chart จริง** — dead dependency

8. **ไม่มี rate limiting บน `/callback`** — LINE webhook อาจถูก flood ได้ แม้มี `TaskQueue` ช่วยกันกระแทก

9. **`@supabase/supabase-js` ยังอยู่ใน dependencies** แต่ไม่มีการใช้งานตรงในโค้ดปัจจุบัน (ใช้ผ่าน `dbClient.ts` ที่เป็น custom wrapper แทน)

10. **Sync scripts ใช้ cursor-based pagination** รองรับทั้ง full sync และ incremental sync — ออกแบบมาดี แต่ต้องตั้ง env vars ที่ถูกต้อง (`GATEWAY_BASE_URL`, API keys แยกแต่ละ resource)

ศึกษาโปรเจกต์ครบแล้วครับ นี่คือสรุปภาพรวมทั้งหมดของระบบ **Primus Chatbot Quotation System**:

---

## สรุปโครงสร้างโปรเจกต์

### ภาพรวม
ระบบออกใบเสนอราคาออนไลน์ของ Primus Co., Ltd. มี 2 ส่วนหลัก: Admin Portal (React SPA) และ LINE LIFF Pages (HTML Vanilla JS)

---

### Backend (Express + TypeScript)

**entry point:** `index.ts` — Express app พร้อม TaskQueue สำหรับประมวลผล webhook LINE

**API Endpoints:**

| Method | Path | Auth | คำอธิบาย |
|--------|------|------|-----------|
| GET | `/api/liff/config?page=` | - | ดึง LIFF ID ตาม page |
| POST | `/api/quotations` | - | สร้างใบเสนอราคาใหม่ |
| GET | `/api/quotations?ids=` | - | ดึงใบเสนอราคาหลายใบ |
| GET | `/api/products/search?q=` | - | ค้นหาสินค้า real-time |
| GET | `/api/customers/search?q=` | - | ค้นหาลูกค้า |
| GET | `/api/customer/:id/contacts` | - | ดึงรายชื่อผู้ติดต่อ |
| POST | `/api/quotation/draft-cart` | - | สร้าง draft จากตะกร้า |
| PUT | `/api/quotation/:id` | - | อัปเดตรายการสินค้า |
| POST | `/api/quotation/:id/confirm` | - | ยืนยันและออกเลขที่ |
| GET | `/api/admin/quotations` | JWT | ดึงรายการ (pagination + filter) |
| GET | `/api/admin/quotations/export` | JWT | Export CSV |
| POST | `/api/admin/login` | - | เข้าสู่ระบบแอดมิน |
| GET | `/download-pdf/:id` | - | ดาวน์โหลด PDF |
| POST | `/api/admin/signatures/:type` | JWT | อัปโหลดลายเซ็น |
| CRUD | `/api/admin/promotions` | JWT | จัดการโปรโมชัน |
| CRUD | `/api/admin/quotation-rules` | JWT | จัดการเงื่อนไข |
| POST | `/callback` | LINE sig | Webhook LINE |

---

### Database Schema

**ตารางในระบบ (application tables):**
- `admin_users` — ผู้ดูแลระบบ (id, username, password_hash, name, role)
- `quotations` — ใบเสนอราคา (id, user_id, quotation_no, status, customer_name, items JSONB, total_sum, salesperson_name, salesperson_phone, salesperson_employee_code, delivery_days_override)
- `promotions` — โปรโมชัน (id, code, name, discount_type, discount_value, product_code, customer_type, customer_refs, min_qty, start_date, end_date)
- `quotation_rules` — เงื่อนไขใบเสนอ (id, production, brand, series, warranty_years, warranty_unit, is_locked, delivery_in_stock_days, delivery_out_of_stock_days, delivery_days_qty_10/20/50/100)
- `salesperson` — พนักงานขายที่ลงทะเบียนใน LINE (user_id, name, phone, salesperson_id, branch_code)

**ตาราง Odoo sync (read-only views):**
- `customers_view` / `customers` — ลูกค้า
- `contacts_view` / `contacts` — ผู้ติดต่อ
- `products` — สินค้า
- `sale_orders` — ใบสั่งซื้อจาก Odoo

---

### Business Logic หลัก

**ระบบเสนอราคา (flow หลัก):**
1. พนักงานขายพิมพ์คำสั่งใน LINE → LINE Webhook
2. `lineHandler.ts` รับ message → ค้นหาลูกค้า/สินค้าด้วย AI (DeepSeek) + Fuse.js
3. สร้าง quotation draft → แบ่งตาม production (`Import(PM)` → THT, อื่นๆ → PM)
4. แสดง Flex Message สรุป → ตรวจ min price + โปรโมชัน
5. ยืนยัน → ออกเลขที่ QP-YYMMXXX / QT-YYMMXXX → สร้าง PDF ด้วย Puppeteer → ส่งใน LINE

**PDF Generation:**
- Puppeteer render HTML เป็น A4
- รองรับ multi-page ตาม weight ของ items (sales_description, remark, stock warning)
- แยก logo/ข้อมูลบริษัท ตามว่าเป็น Primus (PM) หรือ Themtech (THT)
- ใส่ลายเซ็นพนักงานขาย + แอดมิน จากไฟล์ `{employee_code}.png`

**Customer Binding:**
- ใบเสนอราคาต้องผูกลูกค้าที่มีในฐานข้อมูลเท่านั้น — **ไม่มีค่า default `ลูกค้าทั่วไป` แล้ว** ยังไม่ผูก = `null`
- ใบที่ยังไม่ผูกลูกค้า (`isCustomerInfoIncomplete()` ใน `utils/flexTemplates.ts`) จะแสดงข้อมูลลูกค้าเป็น `— ยังไม่ระบุ —` และ **ไม่มีปุ่มยืนยัน** ใน Flex สรุป
- บังคับกฎ 3 ชั้น: ปุ่มบันทึกในหน้า LIFF (ต้องมี `customer_id` + ผู้ติดต่อ) → `PUT /api/quotation/:id` (400 ถ้าบริษัท/ผู้ติดต่อว่าง) → ตอนยืนยัน (`POST /api/quotation/:id/confirm` และ postback `action=confirm`)

**Promotion Validation:**
- ราคาหลังหักส่วนลดต้อง ≥ `minimum_sales_price` เว้นแต่เข้าเงื่อนไขโปรโมชัน — กฎอยู่ที่ `checkMinSalesPrice()` ใน `services/quotationService.ts` **ที่เดียว** ใช้ทั้งตอนบันทึกจาก LIFF (`PUT /api/quotation/:id` → 422) และตอนยืนยัน (`POST /api/quotation/:id/confirm`, postback `action=confirm`)
- รองรับ 3 ประเภท: `percent`, `fixed`, `override`
- กรองตาม product_code, customer_type, customer_refs, min_qty, start_date/end_date

---

### Frontend Admin (React + Vite)

**5 tabs:**
1. **Dashboard** — welcome card + quick links
2. **ประวัติใบเสนอราคา** — ตาราง paginate + filter + sort + export CSV + download PDF
3. **จัดการโปรโมชัน** — CRUD โปรโมชัน
4. **จัดการลายเซ็นพนักงาน** — อัปโหลดลายเซ็น sale_sigs + admin_sigs
5. **เงื่อนไขใบเสนอราคา** — CRUD quotation_rules (warranty, delivery days, is_locked)

Auth: JWT เก็บใน localStorage, `AuthContext` wrap app ทั้งหมด

---

### LIFF Pages (HTML + Vanilla JS)

- **register.html** — ลงทะเบียนพนักงาน + เลือกสาขา
- **quote-edit.html** — แก้ไขใบเสนอราคา (ค้นหา/เลือกลูกค้า, ผู้ติดต่อ, ปรับส่วนลด, remark)
- **product-search.html** — ค้นหาสินค้าแบบ real-time, เพิ่มลงตะกร้า

---

### Dependencies หลัก
- `@line/bot-sdk` — LINE bot + LIFF
- `puppeteer` — PDF generation
- `fuse.js` — fuzzy search ลูกค้า/ผู้ติดต่อ
- `openai` (DeepSeek) — AI matching ชื่อบริษัท + รหัสสินค้า
- `pg` — PostgreSQL
- `bcryptjs` + `jsonwebtoken` — auth แอดมิน
- `thai-baht-text` — แปลงตัวเลขเป็นตัวอักษรภาษาไทย
- `json2csv` + `xlsx` — export data

---

### จุดสำคัญที่ควรระวัง

1. **`dbClient.ts`** มี query builder ที่ทำ column mapping อัตโนมัติ (`branch_code` ↔ `branch`, `code` ↔ `model`, etc.) — ต้องเข้าใจ mapping ก่อนแก้ไขตาราง
2. **LIFF ID** ดึงจาก `/api/liff/config?page=` เสมอ — ไม่ hardcode
3. **ลายเซ็น** ใช้ `salesperson_employee_code` (ไม่ใช่ LINE user_id) เป็นชื่อไฟล์
4. **Production 2** (`is_locked = true`) ห้ามออกใบเสนอราคา — ตรวจทั้ง frontend + backend
5. **quotation_no** format: `QP-YYMMXXX` (Primus) / `QT-YYMMXXX` (Themtech) นับ sequence ต่อเดือน
6. **`public/`** เป็น build output — ห้ามแก้ตรง, แก้ที่ `frontend/src/`
7. **`linebot/`, `lineliff/`** ยังมีอยู่ในโปรเจกต์แต่ห้ามแตะ
8. **DeepSeek** ใช้แทน OpenAI ถ้ามี `DEEPSEEK_API_KEY` ใน .env

---