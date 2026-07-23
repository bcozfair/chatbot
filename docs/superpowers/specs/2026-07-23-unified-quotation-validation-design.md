# Unified Quotation Validation Gate — Design

วันที่: 2026-07-23

## ปัญหา

กฎการตรวจใบเสนอราคา (blocked product, สต็อกไม่พอ, MOQ, ราคาขั้นต่ำ) ถูกก๊อปกระจายหลายที่ แต่ละที่ประกอบชุดกฎเอง ตรวจ item คนละชุด และหลายเส้นทางข้ามการตรวจ ทำให้สินค้าหลุดกฎได้ (เคสจริง: ECOM0010 มีของว่าง 1 ชิ้น สั่ง 2 ชิ้น ทะลุทั้ง draft/save/confirm)

### หลักฐานจากการสำรวจ (audit)

**ฝั่ง server — 6+ จุดตรวจ ไม่มีด่านกลาง:**
- `POST /api/quotations`, `POST /api/quotation/draft-cart`, `processQuotationRequest` → blocked + (stock+MOQ) แต่**ไม่ตรวจ min-price**
- `PUT /api/quotation/:id` → blocked(all) + (stock+MOQ) เฉพาะ newItems + stock(all) + min-price(all) — ชุดกฎ/ชุด item ไม่สม่ำเสมอ
- `POST /api/quotation/:id/confirm` → min-price + stock เท่านั้น (ไม่ตรวจ blocked/MOQ) ตอบ 400 string
- LINE `action=confirm` → min-price + stock **แบบ fail-open** (throw แล้ว log เฉย ปล่อยผ่าน)
- revision 2 เส้นทาง (`handleQuotationEditRequest`, legacy inline) → `insertDraftQuotations` โดย**ไม่ตรวจอะไรเลย**

**ฝั่ง client — เตือนลอย ไม่บล็อก + ข้อความ drift:**
- ทุกเช็ค qty ใน quote-edit.html และ product-search.html เป็น **cosmetic** (`showAlert` แล้ว push เข้าตะกร้าต่อ)
- `formatViolation` duplicate 2 หน้าและ drift แล้ว (OUT_OF_STOCK คนละข้อความ; min-price มีแค่หน้าเดียว)
- ป้าย/เช็คฝั่ง client อ่าน `actual_quantity` (ผิด column) ไม่ใช่ `quantity_on_hand_unreserved`

## เป้าหมาย

1. **ด่านกลางเดียว** ที่ทุกเส้นทางเรียก — ตรวจ**ทุกกฎ ทุก stage แบบ fail-closed**
2. **client บล็อกจริง** (ไม่ใช่แค่เตือน) และใช้เกณฑ์ unreserved ตรงกับ server
3. **server สร้างข้อความพร้อมใช้** (`display_message`) — เลิก `formatViolation` ซ้ำ 2 ที่

## นอกขอบเขต (YAGNI)

- ไม่แตะเรื่อง stale ของ `actual_quantity`/sync (คนละปัญหา)
- ไม่รวม/แยก LIFF pages เป็น bundle/shared module (vanilla JS ตาม AGENTS.md — ยอม duplicate `trySendTrigger`/`copyToClipboard` ต่อ)
- ไม่เปลี่ยนตรรกะการคำนวณวันจัดส่ง/ค่าขนส่ง

---

## สถาปัตยกรรม

### 1. ด่านกลาง server: `validateQuotationItems()`

ไฟล์: `services/quotationService.ts`

```ts
type ValidationStage = 'draft' | 'save' | 'confirm';

interface Violation {
  type: 'BLOCKED' | 'OUT_OF_STOCK' | 'MOQ_VIOLATION' | 'MIN_PRICE_VIOLATION' | 'SYSTEM_ERROR';
  model: string;                 // รหัสรุ่น ('-' ถ้าไม่มี)
  display_message: string;       // ★ ข้อความพร้อมโชว์ (server สร้าง)
  warn_msg?: string;             // ท่อนดิบ (debug/PDF)
  is_optional?: boolean;
  linked_to_model?: string;
  // field เฉพาะชนิดคงไว้: min_price, min_order_qty, qty, actual_quantity ...
}

async function validateQuotationItems(
  items: any[] | null,
  opts: { customerName?: string | null; stage: ValidationStage }
): Promise<{ items: any[]; violations: Violation[] }>;
```

พฤติกรรม:
- ลำดับคงที่: `expandOptional → blocked → stock → MOQ → min-price` เหนือ **items ทุกบรรทัดเสมอ** (เลิก newItems-only)
- คืน `items` ที่ expand optional แล้ว (ผู้เรียกใช้เซฟชุดนี้)
- **fail-closed:** ถ้า check ไหน throw → ใส่ violation `SYSTEM_ERROR` (`display_message` = "⚠️ ตรวจสอบกฎไม่สำเร็จ กรุณาลองใหม่หรือติดต่อแอดมิน") → ผู้เรียกต้อง reject เสมอ ห้าม proceed
- `stage` เป็น metadata สำหรับ log เท่านั้น — **ชุดกฎเท่ากันทุก stage**
  - ⚠️ **การเปลี่ยนพฤติกรรมที่ตั้งใจ:** เดิม min-price ไม่ตรวจตอน draft (POST /api/quotations, draft-cart) เลื่อนไปตรวจตอน save/confirm ตอนนี้จะตรวจตั้งแต่ draft ด้วย → ผู้ใช้จะโดนบล็อกเร็วขึ้นถ้าตั้งราคาต่ำกว่าขั้นต่ำตั้งแต่ร่าง (สอดคล้องเจตนา "ไม่ให้ทะลุ rule" และกันร่างที่ยืนยันไม่ได้ค้าง)
- 4 ฟังก์ชันเดิม (`getBlockedProductError`, `checkStockRules`, `checkMinOrderQty`, `checkMinSalesPrice`) กลายเป็น internal helper; ผู้เรียกภายนอกเลิกเรียกตรง เรียกผ่านด่านกลางแทน
- `display_message` ประกอบจาก helper เดียว `buildViolationDisplay(v)` (ย้ายถ้อยคำจาก client `formatViolation` มาไว้ที่ server)

### 2. Response contract (สม่ำเสมอทุก endpoint)

| เส้นทาง | เดิม | ใหม่ |
|--------|------|------|
| POST /api/quotations | 400 หรือ 422 | `422 { error:'VALIDATION_ERROR', violations }` |
| POST /api/quotation/draft-cart | 422 (client อ่าน result.violations) | `422 { error:'VALIDATION_ERROR', violations }` |
| PUT /api/quotation/:id | 400/422 หลายแบบ | `422 { error:'VALIDATION_ERROR', violations }` |
| POST /api/quotation/:id/confirm | 400 string | `422 { error:'VALIDATION_ERROR', violations }` |
| LINE draft/confirm | string บรรจงเอง | `buildViolationText(violations)` = `violations.map(v=>v.display_message).join('\n')` |

helper `buildViolationText(violations)` ตัวเดียวใช้ทั้ง LINE flow และ confirm

### 3. ทุกเส้นทางเรียกด่านกลาง

เพิ่ม/แทนที่การเรียกใน:
- `POST /api/quotations` — แทน getBlockedProductError+validateAndPrepareItems
- `POST /api/quotation/draft-cart` — เหมือนกัน
- `PUT /api/quotation/:id` — แทนชุดตรวจ 4 อัน เรียกด่านกลางเหนือ resultItems ทั้งหมด (เลิก newItems shortcut)
- `POST /api/quotation/:id/confirm` — เพิ่ม (เดิมตรวจแค่ stock+min-price) → เรียกด่านกลาง (fail-closed)
- LINE `action=confirm` (lineHandler.ts) — เปลี่ยน fail-open เป็น fail-closed ผ่านด่านกลาง
- `processQuotationRequest` — แทนชุดตรวจเดิม
- **revision 2 เส้นทาง** (`handleQuotationEditRequest` ใน quotationAgent.ts + legacy inline ใน lineHandler.ts) — เพิ่มด่านกลางก่อน `insertDraftQuotations`

หมายเหตุ `insertDraftQuotations` ยังไม่ตรวจเอง (เป็น INSERT ล้วน) แต่ผู้เรียกทุกตัวผ่านด่านกลางแล้ว

### 4. ฝั่ง client — บล็อกจริง + unreserved + เลิก format ซ้ำ

**4.1 บล็อกจริง:** เปลี่ยนทุกจุดเช็ค qty ที่เดิม `showAlert(...)` แล้วทำต่อ ให้ `return` หลัง alert
- product-search.html: `addToCart`, `changeQty`, `setQty`
- quote-edit.html: `addProductToQuote`, qty-change ใน `onFieldChange`
- ใช้เกณฑ์ `requested > stock` (stock = unreserved) สอดคล้อง server

**4.2 unreserved:** `GET /api/products/search` เปลี่ยน `stock` ให้ map จาก `quantity_on_hand_unreserved` (แทน `actual_quantity`) และ `is_blocked_no_stock` ใช้ unreserved `<= 0`
- ผลข้างเคียง: `deliverySignature` ใน quote-edit ใส่ `i.stock` ใน cache key → deploy แล้วจะ recompute วันจัดส่ง 1 รอบ (ไม่มีผลต่อค่าจริง เพราะ server คำนวณจาก DB เอง) — บันทึกไว้ไม่ให้ตกใจ

**4.3 เลิก formatViolation ซ้ำ:** ทั้ง 2 หน้าเปลี่ยน `violations.map(formatViolation)` → `violations.map(v => v.display_message)` แล้ว**ลบ `formatViolation` ทิ้งทั้ง 2 ไฟล์**

---

## Data flow (หลังแก้)

```
[LINE chat draft] processQuotationRequest ─┐
[product-search]  POST /draft-cart ────────┤
[quote-edit add]  POST /api/quotations ────┤
[quote-edit save] PUT /api/quotation/:id ──┼─→ validateQuotationItems(items, {stage})
[confirm REST]    POST /:id/confirm ───────┤        │ expandOptional→blocked→stock→MOQ→min-price
[confirm LINE]    action=confirm ──────────┤        │ (fail-closed)
[revision x2]     handleQuotationEdit... ──┘        ▼
                                            { violations: [{display_message, ...}] }
                                                    │
                REST → 422 {violations}   LINE → buildViolationText()
                                                    │
                client: บล็อก + โชว์ v.display_message ตรง ๆ (ไม่ format เอง)
```

## Error handling

- check ใด throw → `SYSTEM_ERROR` violation → reject (fail-closed) ทุก stage
- confirm ที่ fail-closed ป้องกันการออกเลขเอกสารทั้งที่ยังตรวจกฎไม่ผ่าน
- REST คืน 422 พร้อม violations; client โชว์ `display_message`

## Testing

ขยาย diag smoke (รูปแบบเดียวกับ `diag:stock-rule`, `diag:stock-rule-put` ที่มีอยู่):
1. **pure:** `buildViolationDisplay` แต่ละชนิด (BLOCKED/OUT_OF_STOCK/MOQ/MIN_PRICE/SYSTEM_ERROR) ให้ string ถูกต้อง
2. **integration (DB):** `validateQuotationItems` เคส ECOM0010 (ของ 1 สั่ง 2 → OUT_OF_STOCK), เคส fail-closed (จำลอง throw → SYSTEM_ERROR), เคสผ่านสะอาด
3. **parity:** ยืนยันข้อความ display_message เท่ากันไม่ว่าเรียกจาก stage ไหน
4. red-green: revert เป็นตรรกะเก่าต้องเห็น test แดง
5. `tsc --noEmit` = 0 errors ทุกครั้ง

Gate: `npm run diag:stock-rule`, `diag:stock-rule-put`, + smoke ใหม่ `diag:quote-validation`

## แผนการ implement (ทีละขั้น มี checkpoint)

1. server: `Violation` type + `buildViolationDisplay` + `buildViolationText` (+ pure smoke) — ไม่เปลี่ยนพฤติกรรม
2. server: `validateQuotationItems` ครอบ 4 helper เดิม (+ integration smoke)
3. เปลี่ยนผู้เรียกทีละ endpoint ให้ผ่านด่านกลาง (draft → save → confirm → LINE → revision) ทีละตัว รัน smoke
4. client: unreserved ใน search API
5. client: บล็อกจริง + ใช้ display_message + ลบ formatViolation (product-search, quote-edit)
6. verify รวม: tsc + smoke ทั้งหมด + ทดสอบ ECOM0010 ครบทุกเส้นทาง
