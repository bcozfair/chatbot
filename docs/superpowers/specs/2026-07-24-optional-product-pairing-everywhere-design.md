# สินค้าพ่วง (Main-Optional Pairing) ให้ทำงานครบทุกส่วน — Design

วันที่: 2026-07-24
สถานะ: รอ review

## ปัญหา

กฎ "คู่สินค้าหลัก-สินค้าเสริม (Optional)" — เมื่อเลือกสินค้าหลัก ระบบพ่วงเสนอขายสินค้าเสริมอัตโนมัติในจำนวนเท่ากัน และเมื่อไม่มีสินค้าหลักก็เอาสินค้าเสริมออก

ปัจจุบันทำงานได้ **ไม่ครบทุกส่วน**:
- ✅ ทำงานเฉพาะตอนเสนอราคาผ่านแชท หรือร่างผ่านตระกร้า (draft-cart) — สินค้าเสริมถูกพ่วงในร่างสรุปฝั่ง backend
- ❌ หน้า LIFF `quote-edit.html` และ `product-search.html` ไม่แสดง/ไม่จัดการสินค้าเสริมในตระกร้าเลย (ไม่พ่วงตอนกดเพิ่มสินค้าหลัก, ไม่ลบตอนเอาหลักออก, ไม่ sync จำนวน)
- ❌ backend บาง endpoint ยังไม่ expand (confirm, chat revise)

เป้าหมาย: ให้สินค้าพ่วงทำงานได้ **ทุกส่วน** — auto-add ลงตระกร้าเมื่อเพิ่มสินค้าหลักในจำนวนเท่ากัน และลบออกเมื่อไม่มีสินค้าหลัก ทั้งในหน้า `quote-edit.html` และ `product-search.html` พร้อมปิดช่องโหว่ฝั่ง backend

## สถาปัตยกรรมปัจจุบัน (ที่สำรวจแล้ว)

- **นิยามคู่พ่วง**: DB table `product_optional_links` (`migrations/schema.sql:380-387`) — `trigger_product_id` (สินค้าหลัก, เก็บเป็น `internal_reference`) → `optional_product_id` (สินค้าเสริม, เก็บเป็น `internal_reference`), `is_active`. มี admin CRUD UI ที่ `frontend/src/admin/OptionalLinks.tsx`.
- **auto-attach หลัก**: `expandOptionalProducts(items)` — `services/productService.ts:922-974`. เป็นที่เดียวที่พ่วงสินค้าเสริม. push สินค้าเสริมต่อท้ายสินค้าหลักด้วย `qty` เท่ากัน, tag `is_optional:true`, `linked_to_product_id:<product_id หลัก>`, `discount_1/2:0`. มี **de-dupe** (บรรทัด 946-951): ถ้าสินค้าเสริมถูกสั่งเป็นรายการอยู่แล้ว → ไม่พ่วงซ้ำ.
- **wrapper เดียว**: `validateAndPrepareItems(items)` — `services/quotationService.ts:918-938` — เรียก `expandOptionalProducts` เป็น step 1.
- **จุดที่เรียกอยู่แล้ว** (พ่วงทำงาน): POST `/api/quotations` (index.ts:254), POST `/api/quotation/draft-cart` (index.ts:687), PUT `/api/quotation/:id` เฉพาะ `newItems` (index.ts:766), chat `processQuotationRequest` (quotationService.ts:947).
- **qty-sync + removal ของ PUT**: `index.ts:771-794` — re-emit สินค้าหลักตามด้วยสินค้าเสริมที่ `linked_to_product_id` ตรงกัน โดย force `opt.qty = main.qty`; ลบหลัก → สินค้าเสริมไม่ถูก re-emit = หายไปเอง.
- **ช่องโหว่**: confirm endpoint (`index.ts:1072`) และ chat revise (`handlers/lineHandler.ts:1409`) ไม่เรียก expand.
- **หน้า LIFF**: ทั้ง 2 หน้าไม่มี logic pairing ฝั่ง client เลย — รู้จักแค่ `is_optional`/`linked_to_model` ที่ backend ส่งกลับมาใน validation error (`formatViolation`).

## หลักการออกแบบ

**Client mirror ของ `expandOptionalProducts()`** — หน้า LIFF (vanilla JS ไม่มี bundler ตาม AGENTS.md) ทำ auto-attach แบบเดียวกับ backend เป๊ะ ๆ เป็น duplication ที่ยอมรับโดยตั้งใจ แบบเดียวกับ `calcNetPrice`/`shippingFee` ที่ mirror อยู่แล้ว. backend ยังคงเป็น source of truth และ de-dupe กันซ้ำเมื่อ client ส่งสินค้าเสริมไปด้วย.

## การเปลี่ยนแปลง — 3 ชั้น

### ชั้น 1: Backend — ส่งคู่พ่วงไปให้ client ผ่าน search API

- เพิ่ม helper `resolveOptionalProductsFor(product)` ใน `services/productService.ts` — รับ product (มี `internal_reference`) → คืน array ของสินค้าเสริมที่ resolve แล้ว แต่ละตัวมีฟิลด์พอสร้าง line item: `product_id, model, name, price, stock, internal_reference, brand, quote_company`. ใช้ `getOptionalLinks` + `getProductByInternalRef` ที่มีอยู่.
- `/api/products/search` (`index.ts:345-504`) เพิ่มฟิลด์ `optional_products` ในแต่ละผลลัพธ์ (เรียก `resolveOptionalProductsFor`). ระวัง N+1: batch/parallel ตาม pattern `mappedPromises` ที่มีอยู่ (Promise.all).

### ชั้น 2: Backend — ปิดช่องโหว่ที่ยังไม่ expand

- **confirm endpoint** (`index.ts:1072`): expand ก่อน validate เพื่อกันเคสร่างที่ยังไม่เคยผ่าน expand. ต้องระวังไม่ให้ double-add (de-dupe ของ expand ครอบให้แล้ว).
- **chat revise** (`handlers/lineHandler.ts:1409`): เดินผ่าน `validateAndPrepareItems` ก่อน `insertDraftQuotations` เพื่อ re-expand สินค้าเสริมของใบเดิม.
- ตรวจ `services/quotationAgent.ts:111` ว่าเรียก expand หรือยัง — ถ้ายัง เพิ่มให้ครบ.

### ชั้น 3: Client — auto-pair ในหน้า LIFF

**พฤติกรรม (mirror `expandOptionalProducts` เป๊ะ):**

| การกระทำกับสินค้าหลัก | ผลกับสินค้าเสริม |
|---|---|
| เพิ่มสินค้าหลัก | พ่วงสินค้าเสริม qty เท่ากัน — เว้นแต่สินค้าเสริมถูกสั่งเป็นรายการปกติอยู่แล้ว (de-dupe) → ไม่พ่วง |
| เพิ่ม/ลดจำนวนสินค้าหลัก | สินค้าเสริม sync จำนวนตาม |
| ลบสินค้าหลัก / จำนวนเป็น 0 | ลบสินค้าเสริมที่ `linked_to_product_id` ตรงกันทั้งหมด |

**การแสดงผล:** สินค้าเสริมได้ badge แยก (เช่น "🔗 สินค้าพ่วง") โทนสีต่างจากสินค้าปกติ — pattern เดียวกับการ์ดค่าขนส่งสีส้ม. ช่องจำนวน + ปุ่มลบ ของสินค้าเสริม = disabled (แก้ผ่านสินค้าหลักเท่านั้น) mirror สิ่งที่ backend บังคับ. ราคา/ส่วนลดแก้ได้ตามปกติ.

**quote-edit.html — จุดที่ hook:**
- add: `addProductToQuote` (บรรทัด ~3429), `onSheetStep` (~3331) — หลัง push สินค้าหลัก ให้พ่วงสินค้าเสริมจาก `prod.optional_products` เข้าใบเดียวกัน
- remove: `onDeleteItem` (~2819), qty-0 branch ของ `onSheetStep` — ลบสินค้าเสริมที่ผูกด้วย
- qty: branch `quantity` ใน `onFieldChange` (~2758-2769) — sync จำนวนสินค้าเสริม โดย **mirror DOM update in-place** (จำนวน + total chip ของแถวสินค้าเสริม) ไม่ re-render เต็มหน้า เพื่อรักษา focus (ตามที่ `onFieldChange` จงใจทำ)
- de-dupe helper: ใช้/ต่อยอด `findQuoteItem` (~3245)

**สินค้าเสริมเข้าใบไหน:** เข้า **ใบเดียวกับสินค้าหลักเสมอ** (inherit ใบจากสินค้าหลัก ไม่ resolve บริษัทของสินค้าเสริมเอง) — ตรงกับที่ backend push ต่อท้ายหลักใน array เดียวกัน ไม่แยก PM/THT.

**product-search.html — จุดที่ hook:**
- add: `addToCart` (~906-931) — cart item ปัจจุบันผอม (ไม่มี `product_id`/`internal_reference`) → **เพิ่มฟิลด์ `product_id`, `internal_reference` ลง cart item** เพื่อให้ pairing + de-dupe ทำงาน และให้ backend expand ไม่พ่วงซ้ำตอน draft-cart. หลัง push สินค้าหลัก พ่วงสินค้าเสริมจาก `prod.optional_products`
- remove: `removeFromCart` (~962), qty-0 branch ของ `changeQty` (~938) — ลบสินค้าเสริมที่ผูก
- qty: `changeQty` (~933), `setQty` (~948) — sync (ทั้งคู่ `renderProducts()`/`renderSheet()` เต็มอยู่แล้ว จึง cascade เห็นทันที)

## Edge cases

1. **De-dupe:** ผู้ใช้เพิ่มสินค้าที่บังเอิญเป็นสินค้าเสริมของตัวอื่นเองเป็นรายการปกติ → ไม่พ่วงซ้ำ (เช็คแบบ backend บรรทัด 946-951: match by `product_id` หรือ `model`/`product_code`)
2. **สินค้าเสริมเข้าใบสินค้าหลัก** (ตัดสินแล้ว — ดูด้านบน)
3. **focus preservation ใน quote-edit:** sync จำนวนสินค้าเสริมด้วย DOM update in-place ไม่ re-render เต็ม
4. **ของเดิมในร่างที่โหลดมา:** สินค้าเสริมที่ backend พ่วงไว้แล้ว (มี `is_optional:true`) โหลดมาพร้อม flag → client รู้จัก treat เป็น read-only ทันที ไม่พ่วงซ้ำ
5. **Orphan optional ตอนโหลด** (ตัดสินแล้ว): สินค้าเสริมที่หาสินค้าหลักผูกไม่เจอ → **ไม่แตะตอนโหลด** กันลบข้อมูลที่ user อาจตั้งใจ ปล่อยให้ backend PUT logic จัดการตอน save (สินค้าเสริมที่ไม่มีหลักจะไม่ถูก re-emit)
6. **Double-expand กันได้:** client พ่วงแล้วส่งให้ backend — `expandOptionalProducts` de-dupe เห็นว่ามีแล้วไม่พ่วงซ้ำ ✅ (ยืนยันใน diag)

## Gate / Diag

เพิ่ม `diag:optional-pair` → `scripts/diag/optionalPairSmoke.ts` (ตามแบบ `ruleEngineSmoke.ts` — DB-touching read-only, และ `stockRuleSmoke.ts` — pure logic):
- อ่าน `product_optional_links` จริง
- ยืนยัน `expandOptionalProducts` พ่วงสินค้าเสริมที่จำนวนเท่ากับสินค้าหลัก
- ยืนยัน de-dupe: ถ้า input มีสินค้าเสริมอยู่แล้ว → ไม่พ่วงซ้ำ
- ยืนยัน `resolveOptionalProductsFor` คืนสินค้าเสริมชุดเดียวกับที่ expand ใช้
- `process.exit(failures)` เป็น gate
- เพิ่ม script ใน `package.json` ใต้ block `diag:*`

## ไม่ทำ (YAGNI)

- ไม่ทำ endpoint แยกสำหรับ optional-links (ใส่ใน search API แทน)
- ไม่ auto-ลบ orphan optional ตอนโหลด
- ไม่ล็อกราคา/ส่วนลดของสินค้าเสริม (backend ไม่ล็อก)
- ไม่ refactor `expandOptionalProducts` เป็น pure function (คงรูป DB-touching เดิม เพิ่มแค่ helper resolve)
