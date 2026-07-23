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

**สถานะ (2026-07-24):** `optional-product-pairing` push ขึ้น remote แล้ว (origin). `unified-quotation-validation` **ยังทำไม่เสร็จ + ยังไม่ push** → ตัดสินใจ **ยังไม่ merge** จนกว่า unified จะเสร็จ.

**ผล dry-run `git merge-tree` (merge-base = `bbd69db` ทั้งคู่แตกจากจุดเดียวกัน):**
ไฟล์ทับซ้อน 8 ไฟล์ แต่ **conflict จริงมีแค่ 2**:
1. **`handlers/lineHandler.ts`** — conflict ที่ **import block** (บรรทัด ~26-46) เท่านั้น: unified ลบ `checkMinSalesPrice`/`checkStockRules`/`MinPriceViolation`/`StockViolation` (เปลี่ยนไปใช้ `validateQuotationItems`), ส่วนงานนี้เพิ่ม `validateAndPrepareItems`. **แก้: รวม import list** — เก็บ `validateAndPrepareItems` + เอา 4 ตัวที่ unified ลบออก. revise logic (ของเรา ~1409) กับ confirm logic (ของ unified ~541) อยู่คนละที่ ไม่ชนกันจริง.
2. **`package.json`** — conflict ที่ diag block: unified เพิ่ม `diag:quote-validation` (quoteValidationSmoke.ts), เราเพิ่ม `diag:optional-pair`. **แก้: เก็บทั้งสองบรรทัด.**

**auto-merge ได้หมด (ไม่ conflict):** `index.ts` (search+confirm คนละ hunk), `services/quotationService.ts` (unified แก้ gate, เราเพิ่ม linked_to_product_id ใน buildItemSnapshots — คนละบรรทัด), `services/quotationAgent.ts`, `utils/flexTemplates.ts`, `ruleEngineSmoke.ts`, และ 2 LIFF (คนละส่วน UI).

**หลัง merge ต้องตรวจ logic (auto-merge ผ่านไม่ได้แปลว่าถูก semantically):**
- `/api/quotation/:id/confirm`: unified เพิ่ม `validateQuotationItems` fail-closed; เราเพิ่ม `expandOptionalProducts` ก่อน validate → **ต้องวางลำดับ expand ก่อน validate** (ไม่งั้นสินค้าเสริมไม่ถูก stock-check).
- chat confirm ใน lineHandler (~541): unified ย้ายไป `validateQuotationItems` — ถ้า gate นั้นยัง expand optional ครบ ก็ OK; ถ้าไม่ ต้องเพิ่ม expand.
- รัน gate ทั้งหมดหลัง merge: `diag:optional-pair`, `diag:quote-validation`, `diag:stock-rule*`, `ruleEngineSmoke` (assertion linked_to_product_id), `diag:confirm-race`, + tsc + node --check 2 LIFF.
