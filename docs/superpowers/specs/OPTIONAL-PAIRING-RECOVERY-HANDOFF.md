# Optional-Pairing Recovery Handoff

**Context:** งาน optional-product-pairing ของทีมนี้ทำขนานกับงาน unified-quotation-validation บน branch `unified-quotation-validation` เดียวกัน แล้วโดน amend/rebase ของอีกสายทับ (วินิจฉัยผิดว่าเป็น hallucination). งานนี้แยกออกมาบน branch `optional-product-pairing` (ฐานจาก `bbd69db`).

## กู้คืนได้แล้ว (อยู่บน branch นี้)

1. **Design spec** — `docs/superpowers/specs/2026-07-24-optional-product-pairing-everywhere-design.md` (จาก commit เดิม 042a781) ✅ ครบ
2. **index.ts — confirm hunk** — `POST /api/quotation/:id/confirm` เรียก `expandOptionalProducts(quote.items)` ก่อน validate ✅ commit แล้ว (self-contained เพราะ `expandOptionalProducts` มีอยู่แล้วใน productService.ts)

## ต้อง RE-APPLY เอง (ไม่เคย commit — อยู่แค่ working tree ที่โดน discard, กู้ตรงไม่ได้)

งาน 6 ไฟล์ต่อไปนี้หายจาก working tree (ไม่มี commit) — ทีมมี state ในเซสชันเดิม ให้ re-apply บน branch นี้:

1. **`services/productService.ts`** — เพิ่ม `export async function resolveOptionalProductsFor(product)` (index.ts search hunk ที่กู้ไม่ได้ต้องพึ่งตัวนี้ — ผม revert search hunk ออกเพราะไม่มีฟังก์ชันนี้แล้ว tsc พัง; re-apply ฟังก์ชันนี้ก่อน แล้วค่อยเติม search hunk กลับ)
2. **`index.ts` — search hunk** (เติมกลับหลังมี `resolveOptionalProductsFor`): import + `const optionalProducts = await resolveOptionalProductsFor(item);` + field `optional_products: optionalProducts` ใน `/api/products/search` response (ดู commit เดิม 454b9a1 diff เป็น reference — เนื้อหาอยู่ในบทสนทนา controller ด้วย)
3. **`liff_pages/product-search.html`** — client mirror: badge สินค้าพ่วง, `is_optional`/`linked_to_product_id` ใน cart item, mirror expandOptionalProducts (~104 บรรทัด)
4. **`liff_pages/quote-edit.html`** — client mirror: การ์ด optional โทนส้ม, badge 🔗 สินค้าพ่วง, ปิด qty stepper/remove ของ optional (~193 บรรทัด)
5. **`handlers/lineHandler.ts`** — เพิ่มการ expand optional ในเส้น revision/chat (~24 บรรทัด)
6. **`services/quotationAgent.ts`** — expand optional ในเส้น revision (~21 บรรทัด)
7. **`scripts/diag/optionalPairSmoke.ts`** (ใหม่) + `package.json` เพิ่ม `"diag:optional-pair"`

## หมายเหตุการ merge ในอนาคต

งาน unified-quotation-validation (branch `unified-quotation-validation`) แตะ `index.ts` (search + confirm + PUT + draft), `handlers/lineHandler.ts`, `services/quotationService.ts`, และ 2 หน้า LIFF ด้วย — **จะชนกับงานนี้เมื่อ merge** ต้องประสาน 2 ทีม โดยเฉพาะ:
- `/api/products/search`: validation-gate เปลี่ยน `stock` เป็น unreserved; optional-pairing เพิ่ม `optional_products` → รวมได้ ไม่ขัดกัน
- `/api/quotation/:id/confirm`: validation-gate เพิ่ม `validateQuotationItems` fail-closed; optional-pairing เพิ่ม `expandOptionalProducts` ก่อน validate → ต้องวางลำดับ expand ก่อน validate
- 2 หน้า LIFF: validation-gate ทำ block จริง+display_message; optional-pairing เพิ่ม UI สินค้าพ่วง → คนละส่วน รวมได้
