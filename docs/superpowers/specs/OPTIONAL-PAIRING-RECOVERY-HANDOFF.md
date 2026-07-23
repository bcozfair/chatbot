# Optional-Pairing Recovery Handoff

**Context:** งาน optional-product-pairing ของทีมนี้ทำขนานกับงาน unified-quotation-validation บน branch `unified-quotation-validation` เดียวกัน แล้วโดน amend/rebase ของอีกสายทับ (วินิจฉัยผิดว่าเป็น hallucination). งานนี้แยกออกมาบน branch `optional-product-pairing` (ฐานจาก `bbd69db`).

## ✅ RE-APPLY เสร็จสมบูรณ์แล้ว — commit `167f717` (2026-07-24)

ทั้งฟีเจอร์ถูกกู้และ commit ครบบน branch `optional-product-pairing` แล้ว. **ไม่มีอะไรค้างต้อง re-apply อีก.** แหล่งกู้: reference JS ที่แก้เสร็จ (scratchpad เซสชันเดิม) + agent summaries + git diff ในบทสนทนา (งานเดิมไม่เคย commit จึงกู้จาก git object ไม่ได้).

**ไฟล์ที่กู้แล้ว (commit `b5bf415` + `167f717`):**
1. **Design spec** — `docs/.../2026-07-24-optional-product-pairing-everywhere-design.md` ✅ (b5bf415)
2. **index.ts — confirm hunk** — `expandOptionalProducts(quote.items)` ก่อน validate ✅ (b5bf415)
3. **`services/productService.ts`** — `resolveOptionalProductsFor(product)` (7-field contract) ✅ (167f717)
4. **`index.ts` — search hunk** — import + `optional_products: optionalProducts` ใน `/api/products/search` ✅ (167f717)
5. **`liff_pages/product-search.html`** — client mirror + badge สินค้าพ่วง (byte-match reference) ✅ (167f717)
6. **`liff_pages/quote-edit.html`** — client mirror การ์ด optional โทนน้ำเงิน + badge 🔗 สินค้าพ่วง (byte-match reference) ✅ (167f717)
7. **`handlers/lineHandler.ts`** — chat revise ผ่าน `validateAndPrepareItems` (re-expand) ✅ (167f717)
8. **`services/quotationAgent.ts`** — revision path ผ่าน `validateAndPrepareItems` ✅ (167f717)
9. **`scripts/diag/optionalPairSmoke.ts`** (ใหม่) + `package.json` `"diag:optional-pair"` ✅ (167f717)

**Verify ที่รันจริงตอน commit:** `tsc --noEmit` exit 0 · `diag:optional-pair` 10/10 (คู่จริง 2GDS35→C.4 UF) · LIFF script ทั้ง 2 `node --check` ผ่าน · `diag:stock-rule` + `diag:stock-rule-put` เขียว (ไม่มี regression).

## หมายเหตุการ merge ในอนาคต

งาน unified-quotation-validation (branch `unified-quotation-validation`) แตะ `index.ts` (search + confirm + PUT + draft), `handlers/lineHandler.ts`, `services/quotationService.ts`, และ 2 หน้า LIFF ด้วย — **จะชนกับงานนี้เมื่อ merge** ต้องประสาน 2 ทีม โดยเฉพาะ:
- `/api/products/search`: validation-gate เปลี่ยน `stock` เป็น unreserved; optional-pairing เพิ่ม `optional_products` → รวมได้ ไม่ขัดกัน
- `/api/quotation/:id/confirm`: validation-gate เพิ่ม `validateQuotationItems` fail-closed; optional-pairing เพิ่ม `expandOptionalProducts` ก่อน validate → ต้องวางลำดับ expand ก่อน validate
- 2 หน้า LIFF: validation-gate ทำ block จริง+display_message; optional-pairing เพิ่ม UI สินค้าพ่วง → คนละส่วน รวมได้
