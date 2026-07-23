# Unified Quotation Validation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทุกเส้นทางสร้าง/แก้/ยืนยันใบเสนอราคาเรียกด่านตรวจกฎเดียว (`validateQuotationItems`) ที่ตรวจ blocked/stock/MOQ/min-price ครบทุกบรรทัด ทุก stage แบบ fail-closed และ server สร้างข้อความพร้อมโชว์ให้ client บล็อกจริง

**Architecture:** เพิ่ม `validateQuotationItems()` ใน `services/quotationService.ts` ครอบ helper เดิม 4 ตัว (`getBlockedProductError`, `checkStockRules`, `checkMinOrderQty`, `checkMinSalesPrice`) คืน `Violation[]` ที่แต่ละตัวมี `display_message` ที่ server สร้าง ทุก REST endpoint ตอบ `422 {violations}` LINE flow ใช้ `buildViolationText()` client โชว์ `display_message` ตรง ๆ และบล็อกจริง

**Tech Stack:** Node.js + TypeScript (ESM, `.js` import specifiers), Express, pg, vanilla JS LIFF pages (ไม่มี bundler), tsx สำหรับ diag smoke

## Global Constraints

- ESM: import จากไฟล์ในโปรเจกต์ต้องลงท้าย `.js` เสมอ (เช่น `'./productService.js'`)
- LIFF HTML เป็น vanilla JS ไม่มี bundler — แก้ในไฟล์ตรง ๆ; `formatViolation`/`trySendTrigger` เป็น hand-mirror
- นิยาม "สต็อกไม่พอ" = `quantity_on_hand_unreserved < จำนวนที่สั่ง` (ไม่ใช่ `actual_quantity <= 0`)
- fail-closed: check ใด throw ต้อง reject ทุก stage ห้าม proceed
- match item ด้วย `product_template_id ?? product_id`
- ทุก smoke script วางที่ `scripts/diag/` รันด้วย `tsx` และ register ใน `package.json`
- typecheck ต้องผ่าน: `npx tsc --noEmit` = exit 0 ทุก task
- commit message ปิดท้าย: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- ทำงานบน branch `unified-quotation-validation`

---

## File Structure

- `services/productService.ts` — มี `evaluateStockViolation`, `checkStockRules`, `StockViolation`, `RuleStock` อยู่แล้ว; จะเพิ่ม `internal_reference` ไม่ต้อง; ไม่แก้ไฟล์นี้มากนอกจาก re-export type ถ้าจำเป็น
- `services/quotationService.ts` — **หัวใจ**: เพิ่ม `Violation`, `ValidationStage`, `buildViolationDisplay`, `buildViolationText`, `validateQuotationItems`; แก้ `processQuotationRequest` ให้เรียกด่านกลาง
- `index.ts` — แก้ 4 endpoint (`POST /api/quotations`, `POST /api/quotation/draft-cart`, `PUT /api/quotation/:id`, `POST /api/quotation/:id/confirm`) + `GET /api/products/search` (unreserved)
- `handlers/lineHandler.ts` — แก้ `action=confirm` (fail-closed) + legacy inline revision
- `services/quotationAgent.ts` — แก้ `handleQuotationEditRequest` (revision) ให้ตรวจก่อน insert
- `liff_pages/product-search.html` — บล็อกจริง + ลบ `formatViolation` + ใช้ `display_message`
- `liff_pages/quote-edit.html` — บล็อกจริง + ลบ `formatViolation` + ใช้ `display_message`
- `scripts/diag/quoteValidationSmoke.ts` — smoke ใหม่
- `package.json` — register `diag:quote-validation`

---

### Task 1: Violation type + display/text builders (pure, ไม่เปลี่ยนพฤติกรรม)

**Files:**
- Modify: `services/quotationService.ts` (เพิ่ม type + 2 ฟังก์ชัน หลัง import block ~บรรทัด 30)
- Create: `scripts/diag/quoteValidationSmoke.ts`
- Modify: `package.json` (เพิ่ม script)

**Interfaces:**
- Produces: `interface Violation`, `type ValidationStage = 'draft'|'save'|'confirm'`, `function buildViolationDisplay(v: Omit<Violation,'display_message'>): string`, `function buildViolationText(violations: Violation[]): string`

- [ ] **Step 1: เขียน type + builders** ใน `services/quotationService.ts` วางหลัง import block (ก่อน `const cleanState` ถ้ามี หรือหลัง import สุดท้าย)

```ts
export type ValidationStage = 'draft' | 'save' | 'confirm';

export interface Violation {
  type: 'BLOCKED' | 'OUT_OF_STOCK' | 'MOQ_VIOLATION' | 'MIN_PRICE_VIOLATION' | 'SYSTEM_ERROR';
  model: string;
  display_message: string;
  warn_msg?: string;
  is_optional?: boolean;
  linked_to_model?: string;
  // เฉพาะชนิด (คงไว้เผื่อผู้ใช้)
  price?: number;
  min_price?: number;
  min_order_qty?: number;
  qty?: number;
  actual_quantity?: number;
}

/** สร้างข้อความพร้อมโชว์จาก violation — ถ้อยคำเดียวของทั้งระบบ (server เป็น source of truth) */
export function buildViolationDisplay(v: Omit<Violation, 'display_message'>): string {
  const model = v.model || '-';
  const optionalNote = v.is_optional && v.linked_to_model ? ` (สินค้าเสริมของ ${v.linked_to_model})` : '';
  switch (v.type) {
    case 'BLOCKED':
      return v.warn_msg || `❌ ระงับการเสนอราคาสินค้า ${model} กรุณาติดต่อแอดมิน`;
    case 'OUT_OF_STOCK': {
      const detail = v.warn_msg ? `: ${v.warn_msg}` : '';
      return `📦 ระงับเมื่อสต็อกไม่พอ รายการ ${model}${optionalNote}${detail}`;
    }
    case 'MOQ_VIOLATION': {
      const detail = v.warn_msg
        ? `: ${v.warn_msg}`
        : ` (สั่งขั้นต่ำ ${v.min_order_qty ?? '-'} ชิ้น, ใส่มา ${v.qty ?? '-'} ชิ้น)`;
      return `⬇️ จำนวนไม่ถึงขั้นต่ำ รายการ ${model}${detail}`;
    }
    case 'MIN_PRICE_VIOLATION': {
      const price = Number(v.price ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const minPrice = Number(v.min_price ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return `💰 ห้ามขายต่ำกว่าราคาขั้นต่ำ รายการ ${model} (ราคาหลังลด ฿${price} < ขั้นต่ำ ฿${minPrice})`;
    }
    case 'SYSTEM_ERROR':
      return '⚠️ ตรวจสอบกฎไม่สำเร็จ กรุณาลองใหม่หรือติดต่อแอดมิน';
    default:
      return v.warn_msg || '';
  }
}

/** ประกอบหลาย violation เป็นข้อความเดียวสำหรับ LINE (หัวข้อ + รายการ) */
export function buildViolationText(violations: Violation[]): string {
  if (!violations || violations.length === 0) return '';
  const lines = violations.map(v => ` - ${v.display_message}`).join('\n');
  return `❌ ระงับการเสนอราคา ตามเงื่อนไขด้านล่าง\nกรุณาแก้ไข หรือติดต่อแอดมิน\n\n${lines}`;
}
```

- [ ] **Step 2: เขียน failing smoke** `scripts/diag/quoteValidationSmoke.ts`

```ts
// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของด่านตรวจกฎรวม — ส่วน pure (ถ้อยคำ) ไม่แตะ DB
//  รัน:  npx tsx scripts/diag/quoteValidationSmoke.ts
//  ให้รันซ้ำทุกครั้งที่แตะ validateQuotationItems / buildViolationDisplay
// ─────────────────────────────────────────────────────────────────────────────
import { buildViolationDisplay, buildViolationText } from '../../services/quotationService.js';

let failures = 0;
const ok = (label: string, cond: boolean) => { if (!cond) failures++; console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`); };

ok('OUT_OF_STOCK ใส่ warn_msg', buildViolationDisplay({ type: 'OUT_OF_STOCK', model: 'ECOM0010', warn_msg: 'ของว่างขายได้ 1 ชิ้น ไม่พอกับจำนวนที่สั่ง 2 ชิ้น' }).includes('ECOM0010') && buildViolationDisplay({ type: 'OUT_OF_STOCK', model: 'ECOM0010', warn_msg: 'ของว่างขายได้ 1 ชิ้น ไม่พอกับจำนวนที่สั่ง 2 ชิ้น' }).includes('ไม่พอกับจำนวนที่สั่ง'));
ok('OUT_OF_STOCK optional note', buildViolationDisplay({ type: 'OUT_OF_STOCK', model: 'X', is_optional: true, linked_to_model: 'Y' }).includes('สินค้าเสริมของ Y'));
ok('MIN_PRICE โชว์ราคา', buildViolationDisplay({ type: 'MIN_PRICE_VIOLATION', model: 'X', price: 80, min_price: 100 }).includes('80.00') && buildViolationDisplay({ type: 'MIN_PRICE_VIOLATION', model: 'X', price: 80, min_price: 100 }).includes('100.00'));
ok('MOQ fallback', buildViolationDisplay({ type: 'MOQ_VIOLATION', model: 'X', min_order_qty: 10, qty: 3 }).includes('10') );
ok('BLOCKED ใช้ warn_msg', buildViolationDisplay({ type: 'BLOCKED', model: 'X', warn_msg: '❌ ระงับ X' }) === '❌ ระงับ X');
ok('SYSTEM_ERROR', buildViolationDisplay({ type: 'SYSTEM_ERROR', model: '-' }).includes('ตรวจสอบกฎไม่สำเร็จ'));
ok('buildViolationText ว่าง = ""', buildViolationText([]) === '');
ok('buildViolationText รวมหลายรายการ', buildViolationText([{ type: 'OUT_OF_STOCK', model: 'A', display_message: 'msgA' }, { type: 'MOQ_VIOLATION', model: 'B', display_message: 'msgB' }]).includes('msgA') );

console.log(failures === 0 ? '\n✅ ผ่านทั้งหมด' : `\n❌ FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: register script** — ใน `package.json` เพิ่มบรรทัดหลัง `"diag:stock-rule-put"`:

```json
    "diag:quote-validation": "tsx scripts/diag/quoteValidationSmoke.ts",
```

- [ ] **Step 4: รัน smoke + typecheck**

Run: `npx tsx scripts/diag/quoteValidationSmoke.ts 2>&1 | grep -v 'injected env' | tail -2 && npx tsc --noEmit; echo "tsc:$?"`
Expected: `✅ ผ่านทั้งหมด` และ `tsc:0`

- [ ] **Step 5: Commit**

```bash
git add services/quotationService.ts scripts/diag/quoteValidationSmoke.ts package.json
git commit -m "feat: Violation type + display/text builders for unified validation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `validateQuotationItems()` ครอบ helper เดิม (fail-closed)

**Files:**
- Modify: `services/quotationService.ts` (เพิ่มฟังก์ชันหลัง `validateAndPrepareItems` ~บรรทัด 938)
- Modify: `scripts/diag/quoteValidationSmoke.ts` (เพิ่ม integration section)

**Interfaces:**
- Consumes: `Violation`, `ValidationStage`, `buildViolationDisplay` (Task 1); `getBlockedProductError`, `checkStockRules`, `checkMinOrderQty`, `checkMinSalesPrice`, `expandOptionalProducts` (มีอยู่แล้ว); `getProductInfo`/`findBlockingRule` ผ่าน `getBlockedProductError`
- Produces: `async function validateQuotationItems(items, opts: { customerName?; stage }): Promise<{ items: any[]; violations: Violation[] }>`

- [ ] **Step 1: เขียน integration test (RED)** — เพิ่มท้าย `scripts/diag/quoteValidationSmoke.ts` ก่อน `console.log(failures...)`:

```ts
// ── integration (แตะ DB): ECOM0010 ของว่าง 1 สั่ง 2 ต้องได้ OUT_OF_STOCK พร้อม display_message ──
import { validateQuotationItems } from '../../services/quotationService.js';
import { pool } from '../../config/db.js';
{
  const r = await validateQuotationItems(
    [{ product_id: 16543, product_template_id: 16543, model: 'ECOM0010', quantity: 2, price: 100 }],
    { stage: 'save' }
  );
  const stockV = r.violations.find(v => v.type === 'OUT_OF_STOCK');
  ok('validate: ECOM0010 สั่ง 2 → OUT_OF_STOCK', !!stockV);
  ok('validate: มี display_message พร้อมโชว์', !!stockV && stockV.display_message.includes('ECOM0010'));
}
await pool.end();
```

- [ ] **Step 2: รัน (verify RED)**

Run: `npx tsx scripts/diag/quoteValidationSmoke.ts 2>&1 | grep -v 'injected env'`
Expected: FAIL ตรง `validate: ...` เพราะ `validateQuotationItems` ยังไม่มี (import error หรือ not a function)

- [ ] **Step 3: เขียน `validateQuotationItems`** ใน `services/quotationService.ts` หลัง `validateAndPrepareItems`:

```ts
/**
 * ด่านตรวจกฎเดียวของทั้งระบบ — ทุกเส้นทาง draft/save/confirm/revision เรียกตัวนี้
 * ลำดับ: expand optional → blocked → stock → MOQ → min-price เหนือ "ทุกบรรทัด"
 * fail-closed: check ใด throw → คืน SYSTEM_ERROR violation ให้ผู้เรียก reject เสมอ
 * stage เป็น metadata สำหรับ log เท่านั้น (ชุดกฎเท่ากันทุก stage)
 */
export async function validateQuotationItems(
  items: any[] | null,
  opts: { customerName?: string | null; stage: ValidationStage }
): Promise<{ items: any[]; violations: Violation[] }> {
  if (!items || items.length === 0) return { items: [], violations: [] };
  const violations: Violation[] = [];
  let expanded: any[] = items;
  try {
    expanded = await expandOptionalProducts(items);

    // blocked (is_locked)
    const blockedMsg = await getBlockedProductError(expanded);
    if (blockedMsg) {
      const v: Omit<Violation, 'display_message'> = { type: 'BLOCKED', model: '-', warn_msg: blockedMsg };
      violations.push({ ...v, display_message: buildViolationDisplay(v) });
    }

    // stock
    const stockErrors = await checkStockRules(expanded);
    for (const e of stockErrors) {
      const v: Omit<Violation, 'display_message'> = {
        type: 'OUT_OF_STOCK', model: e.model, warn_msg: e.warn_msg,
        is_optional: e.is_optional, linked_to_model: e.linked_to_model, actual_quantity: e.actual_quantity
      };
      violations.push({ ...v, display_message: buildViolationDisplay(v) });
    }

    // MOQ
    const moqErrors = await checkMinOrderQty(expanded);
    for (const e of moqErrors) {
      const v: Omit<Violation, 'display_message'> = {
        type: 'MOQ_VIOLATION', model: e.model, warn_msg: e.warn_msg, min_order_qty: e.min_order_qty, qty: e.qty
      };
      violations.push({ ...v, display_message: buildViolationDisplay(v) });
    }

    // min-price
    const priceErrors = await checkMinSalesPrice(expanded, opts.customerName ?? null);
    for (const e of priceErrors) {
      const v: Omit<Violation, 'display_message'> = {
        type: 'MIN_PRICE_VIOLATION', model: e.model, warn_msg: e.warn_msg, price: e.price, min_price: e.min_price
      };
      violations.push({ ...v, display_message: buildViolationDisplay(v) });
    }
  } catch (err) {
    console.error(`[validateQuotationItems] stage=${opts.stage} check failed (fail-closed):`, err);
    const v: Omit<Violation, 'display_message'> = { type: 'SYSTEM_ERROR', model: '-' };
    return { items: expanded, violations: [{ ...v, display_message: buildViolationDisplay(v) }] };
  }
  return { items: expanded, violations };
}
```

- [ ] **Step 4: รัน (verify GREEN) + typecheck**

Run: `npx tsx scripts/diag/quoteValidationSmoke.ts 2>&1 | grep -v 'injected env' | tail -3 && npx tsc --noEmit; echo "tsc:$?"`
Expected: `✅ ผ่านทั้งหมด` และ `tsc:0`

- [ ] **Step 5: Commit**

```bash
git add services/quotationService.ts scripts/diag/quoteValidationSmoke.ts
git commit -m "feat: validateQuotationItems unified gate (all rules, fail-closed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: เปลี่ยน `POST /api/quotations` + `POST /api/quotation/draft-cart` ให้ผ่านด่านกลาง

**Files:**
- Modify: `index.ts` (`POST /api/quotations` ~บรรทัด 234-274; `draft-cart` ~บรรทัด 625-705)

**Interfaces:**
- Consumes: `validateQuotationItems` (Task 2)

- [ ] **Step 1: แก้ `POST /api/quotations`** — แทน block ตรวจเดิม (getBlockedProductError + validateAndPrepareItems) ด้วย:

หา block นี้ (ประมาณบรรทัด 241-257):
```ts
    const { insertDraftQuotations, getBlockedProductError, validateAndPrepareItems } =
      await import('./services/quotationService.js');
    const blockedErrorOnCreate = await getBlockedProductError(items);
    if (blockedErrorOnCreate) {
      return res.status(400).json({ error: blockedErrorOnCreate });
    }
    const { items: expandedOnCreate, errors: createErrors } = await validateAndPrepareItems(items);
    if (createErrors.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: createErrors });
    }
```
แทนด้วย:
```ts
    const { insertDraftQuotations, validateQuotationItems } =
      await import('./services/quotationService.js');
    const { items: expandedOnCreate, violations: createViolations } =
      await validateQuotationItems(items, { customerName, stage: 'draft' });
    if (createViolations.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: createViolations });
    }
```

- [ ] **Step 2: แก้ `POST /api/quotation/draft-cart`** — หา block (ประมาณบรรทัด 680-690):
```ts
    const { insertDraftQuotations, getBlockedProductError, validateAndPrepareItems } = await import('./services/quotationService.js');
    const blockedError = await getBlockedProductError(itemsForDb);
    if (blockedError) {
      return res.status(400).json({ error: blockedError });
    }
    const { items: expanded, errors } = await validateAndPrepareItems(itemsForDb);
    if (errors.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: errors });
    }
```
แทนด้วย:
```ts
    const { insertDraftQuotations, validateQuotationItems } = await import('./services/quotationService.js');
    const { items: expanded, violations } = await validateQuotationItems(itemsForDb, { stage: 'draft' });
    if (violations.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations });
    }
```

- [ ] **Step 3: typecheck + smoke**

Run: `npx tsc --noEmit; echo "tsc:$?" && npx tsx scripts/diag/quoteValidationSmoke.ts 2>&1 | grep -v 'injected env' | tail -1`
Expected: `tsc:0` และ `✅ ผ่านทั้งหมด`

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "refactor: route POST /api/quotations + draft-cart through unified gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: เปลี่ยน `PUT /api/quotation/:id` ให้ผ่านด่านกลางเหนือ resultItems ทั้งหมด

**Files:**
- Modify: `index.ts` (`PUT /api/quotation/:id` ~บรรทัด 709-811)

**Interfaces:**
- Consumes: `validateQuotationItems` (Task 2)

หมายเหตุ: task ก่อนหน้า (2 รอบที่แล้ว) เพิ่ม `checkStockRules(resultItems)` และ `checkMinSalesPrice(resultItems)` ไว้แล้ว งานนี้รวมทั้งหมดเป็นด่านกลางเดียว และคง `validateAndPrepareItems(newItems)` ไว้เฉพาะส่วน expand optional/MOQ ที่ผูกกับสินค้าใหม่ **แต่ย้าย stock/MOQ/min-price/blocked ทั้งหมดไปที่ด่านกลางเหนือ resultItems**

- [ ] **Step 1: แก้ตรรกะ** — เป้าหมาย: หลังประกอบ `resultItems` เสร็จ (หลัง `resultItems.push(...expandedNew)`) เรียกด่านกลางเหนือ `resultItems` ทั้งหมด และลบ block ตรวจย่อยที่ซ้ำ

1a. หา block ตรวจ blocked เดิม (~บรรทัด 725-728) แล้วลบ (blocked จะไปตรวจในด่านกลาง):
```ts
    const { getBlockedProductError: getBlockedProductErrorPut, validateAndPrepareItems } = await import('./services/quotationService.js');
    const blockedError = await getBlockedProductErrorPut(items);
    if (blockedError) {
      return res.status(400).json({ error: blockedError });
    }
```
แทนด้วย (คงเฉพาะ import ที่ยังใช้):
```ts
    const { validateAndPrepareItems, validateQuotationItems } = await import('./services/quotationService.js');
```

1b. คง block `validateAndPrepareItems(newItems)` ไว้ (มันทำ expand optional + MOQ ของสินค้าใหม่ และคืน expandedNew ที่ push เข้า resultItems) — **แต่เปลี่ยนให้ไม่ return จาก errors ของมัน** (ด่านกลางจะตรวจซ้ำเหนือ resultItems ทั้งหมด) หา:
```ts
    const { items: expandedNew, errors } = await validateAndPrepareItems(newItems);
    if (errors.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: errors });
    }
```
แทนด้วย:
```ts
    // ใช้ validateAndPrepareItems เฉพาะเพื่อ expand optional ของสินค้าใหม่ (ผลไป push ใน resultItems)
    // การตัดสินกฎจริงทำที่ด่านกลางเหนือ resultItems ทั้งหมดด้านล่าง
    const { items: expandedNew } = await validateAndPrepareItems(newItems);
```

1c. หา block stock + min-price ที่เพิ่มไว้ก่อนหน้า (หลัง `resultItems.push(...expandedNew);`):
```ts
    // ระงับเมื่อสต็อกไม่พอ — ตรวจ "ทุกบรรทัด" ...
    const { checkStockRules: checkStockRulesOnPut } = await import('./services/productService.js');
    const stockViolations = await checkStockRulesOnPut(resultItems);
    if (stockViolations.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: stockViolations });
    }

    // ราคาหลังหักส่วนลดต้องไม่ต่ำกว่าขั้นต่ำ ...
    const minPriceViolations = await checkMinSalesPrice(resultItems, customer_name ?? quote.customer_name);
    if (minPriceViolations.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: minPriceViolations });
    }
```
แทนทั้งสอง block ด้วยด่านกลางเดียว:
```ts
    // ด่านตรวจกฎรวม — blocked/stock/MOQ/min-price เหนือทุกบรรทัด (fail-closed)
    const { violations: putViolations } = await validateQuotationItems(resultItems, {
      customerName: customer_name ?? quote.customer_name, stage: 'save'
    });
    if (putViolations.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: putViolations });
    }
```

- [ ] **Step 2: ตรวจว่า `checkMinSalesPrice` import เดิมยังถูกใช้ที่อื่นในไฟล์ไหม** ถ้าไม่ ปล่อยไว้ได้ (import ที่ top ของ index.ts) — ไม่ลบเพื่อลดความเสี่ยง

- [ ] **Step 3: typecheck + smoke ทั้งชุดสต็อก**

Run: `npx tsc --noEmit; echo "tsc:$?" && npx tsx scripts/diag/stockRulePutSmoke.ts 2>&1 | grep -v 'injected env' | tail -1`
Expected: `tsc:0` และ `✅ scenario proven`

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "refactor: PUT /api/quotation/:id validates all rules via unified gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: confirm ทั้ง 2 เส้นทางผ่านด่านกลาง fail-closed

**Files:**
- Modify: `index.ts` (`POST /api/quotation/:id/confirm` ~บรรทัด 1061-1145)
- Modify: `handlers/lineHandler.ts` (`action=confirm` ~บรรทัด 542-575)

**Interfaces:**
- Consumes: `validateQuotationItems`, `buildViolationText` (Task 1-2)

- [ ] **Step 1: แก้ REST confirm** — หา block min-price + stock ที่ confirm (~บรรทัด 1102-1145) แทนด้วยด่านกลางเดียว:

หา (ตั้งแต่ `let minPriceViolationsOnConfirm;` ถึงจบ stock block ~บรรทัด 1103-1145) แล้วแทนด้วย:
```ts
    // ด่านตรวจกฎรวมก่อนออกเลข (fail-closed) — blocked/stock/MOQ/min-price
    const { validateQuotationItems: validateOnConfirm } = await import('./services/quotationService.js');
    const { violations: confirmViolations } = await validateOnConfirm(quote.items, {
      customerName: quote.customer_name, stage: 'confirm'
    });
    if (confirmViolations.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: confirmViolations });
    }
```
(ต้องคง `checkMinSalesPrice` import ที่ top ของ index.ts ไว้เผื่อที่อื่นใช้ — ไม่ลบ)

- [ ] **Step 2: แก้ LINE confirm (fail-closed)** ใน `handlers/lineHandler.ts` — หา block min-price + stock (~บรรทัด 542-573) แทนด้วย:

```ts
          // ด่านตรวจกฎรวมก่อนออกเลข (fail-closed — throw ในด่านกลางกลายเป็น SYSTEM_ERROR violation)
          let confirmViolations;
          try {
            const { validateQuotationItems } = await import('../services/quotationService.js');
            const r = await validateQuotationItems(currentQuote.items, {
              customerName: currentQuote.customer_name, stage: 'confirm'
            });
            confirmViolations = r.violations;
          } catch (valErr) {
            console.error('validateQuotationItems on confirm error:', valErr);
            confirmViolations = [{ type: 'SYSTEM_ERROR', model: '-', display_message: '⚠️ ตรวจสอบกฎไม่สำเร็จ กรุณาลองใหม่หรือติดต่อแอดมิน' }];
          }
          if (confirmViolations.length > 0) {
            const { buildViolationText } = await import('../services/quotationService.js');
            replyMessages.push({ type: 'text', text: buildViolationText(confirmViolations) });
            continue;
          }
```

- [ ] **Step 3: ลบ import ที่ไม่ใช้แล้วใน lineHandler.ts** — ตรวจว่า `checkStockRules`, `StockViolation`, `checkMinSalesPrice`, `MinPriceViolation` ยังถูกใช้ที่อื่นไหม (grep) ถ้าไม่ใช้แล้วให้ลบออกจาก import (Task 5 ทำให้ไม่ใช้ทั้ง 4)

Run เพื่อเช็ค: `grep -n "checkStockRules\|StockViolation\|checkMinSalesPrice\|MinPriceViolation" handlers/lineHandler.ts`
ถ้าเหลือแค่บรรทัด import → ลบออกจาก import statement

- [ ] **Step 4: typecheck**

Run: `npx tsc --noEmit; echo "tsc:$?"`
Expected: `tsc:0` (ถ้า error unused import ให้ลบตาม Step 3)

- [ ] **Step 5: Commit**

```bash
git add index.ts handlers/lineHandler.ts
git commit -m "refactor: both confirm paths validate all rules via unified gate (fail-closed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `processQuotationRequest` + revision 2 เส้นทางผ่านด่านกลาง

**Files:**
- Modify: `services/quotationService.ts` (`processQuotationRequest` ~บรรทัด 940-974)
- Modify: `services/quotationAgent.ts` (`handleQuotationEditRequest` ~บรรทัด 110-121)
- Modify: `handlers/lineHandler.ts` (legacy inline revision ~บรรทัด 1409)

**Interfaces:**
- Consumes: `validateQuotationItems`, `buildViolationText`

- [ ] **Step 1: แก้ `processQuotationRequest`** — หา block (`getBlockedProductError` + `validateAndPrepareItems` + การประกอบ errorText ~บรรทัด 941-974) แทนด้วย:

```ts
  const { items: expanded, violations } = await validateQuotationItems(itemsForDb, { stage: 'draft' });
  if (violations && violations.length > 0) {
    return { text: buildViolationText(violations) };
  }
```
(ลบ block เดิมทั้งหมดที่ประกอบ errorText เอง — `stockErrors`/`moqErrors`/`getBlockedProductError`)

- [ ] **Step 2: แก้ revision ใน `quotationAgent.ts`** — ก่อน `insertDraftQuotations` (~บรรทัด 110) เพิ่มการตรวจ:

```ts
  // ตรวจกฎก่อนสร้างร่าง revision (เดิมข้ามการตรวจ — สินค้าที่ติดกฎหลุดเข้าร่างได้)
  const { validateQuotationItems } = await import('./quotationService.js');
  const { violations: revViolations } = await validateQuotationItems(activeQuote.items, { stage: 'draft' });
  if (revViolations.length > 0) {
    const { buildViolationText } = await import('./quotationService.js');
    const t = buildViolationText(revViolations);
    return { messages: [{ type: 'text', text: t }], replyText: t };
  }
```
(หมายเหตุ: import จาก `'./quotationService.js'` เพราะ quotationAgent อยู่ใน services/ เดียวกัน — ระวัง circular import: ใช้ dynamic import ตามตัวอย่าง)

- [ ] **Step 3: แก้ legacy inline revision ใน lineHandler.ts** — handler นี้ตอบ error ด้วย `lineClient.replyMessage({ replyToken, messages: [...] })` แล้ว `return` หา block (~บรรทัด 1396-1405):

```ts
          const revisedCustomerName = appendReviseFrom(quote.customer_name, quote.quotation_no);

          try {
            await pool.query(
              "UPDATE quotations SET status = 'cancelled' WHERE user_id = $1 AND status = ANY($2)",
              [userId, ['pending_company', 'pending_contact', 'draft']]
            );
          } catch (err) {
            console.error("Error cancelling pending quotations:", err);
          }
```
แทรกการตรวจ **ก่อน** บรรทัด `const revisedCustomerName` (ตรวจก่อนยกเลิกร่างเดิม จะได้ไม่ยกเลิกทิ้งถ้าติดกฎ) → เปลี่ยนเป็น:

```ts
          // ตรวจกฎก่อนสร้างร่าง revision (เดิมข้ามการตรวจ) — reply แบบเดียวกับ error อื่นใน handler นี้
          {
            const { validateQuotationItems, buildViolationText } = await import('../services/quotationService.js');
            const { violations: revV } = await validateQuotationItems(quote.items, { stage: 'draft' });
            if (revV.length > 0) {
              return lineClient.replyMessage({
                replyToken: replyToken,
                messages: [{ type: 'text', text: buildViolationText(revV) }]
              });
            }
          }

          const revisedCustomerName = appendReviseFrom(quote.customer_name, quote.quotation_no);

          try {
            await pool.query(
              "UPDATE quotations SET status = 'cancelled' WHERE user_id = $1 AND status = ANY($2)",
              [userId, ['pending_company', 'pending_contact', 'draft']]
            );
          } catch (err) {
            console.error("Error cancelling pending quotations:", err);
          }
```

- [ ] **Step 4: ลบ import/ฟังก์ชันที่ไม่ใช้แล้ว** — ตรวจ `quotationService.ts`: `getBlockedProductError` ยังถูกใช้ไหม (grep) ถ้าเหลือแค่ภายใน `validateQuotationItems` และ export ก็ปล่อยไว้ (ยัง export ได้) แต่ถ้ามี unused var ให้ล้าง

Run: `grep -rn "validateAndPrepareItems\|getBlockedProductError" index.ts handlers/ services/ | grep -v "export\|function validateAndPrepareItems\|function getBlockedProductError"`
รายงานว่าที่ไหนยังเรียก — ถ้าไม่มีแล้วนอกจาก validateQuotationItems ก็เก็บ helper ไว้เป็น internal ได้

- [ ] **Step 5: typecheck + full smoke suite**

Run: `npx tsc --noEmit; echo "tsc:$?" && for s in quoteValidationSmoke stockRuleSmoke stockRulePutSmoke; do npx tsx scripts/diag/$s.ts 2>&1 | grep -v 'injected env' | tail -1; done`
Expected: `tsc:0` และทุก smoke ขึ้น ✅

- [ ] **Step 6: Commit**

```bash
git add services/quotationService.ts services/quotationAgent.ts handlers/lineHandler.ts
git commit -m "refactor: chat draft + revision paths validate via unified gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `GET /api/products/search` ใช้ unreserved

**Files:**
- Modify: `index.ts` (`GET /api/products/search` SQL ~บรรทัด 356-379 และ mapping ~บรรทัด 467-490)

**Interfaces:** ไม่มี consumer ใหม่ — เปลี่ยน field `stock` ที่คืน

- [ ] **Step 1: แก้ SQL** — ใน SELECT ของ `/api/products/search` หา `p.actual_quantity AS stock,` เปลี่ยนเป็น:
```sql
        p.quantity_on_hand_unreserved AS stock,
```
(คง `p.actual_quantity` บรรทัดอื่นไว้ถ้ามี — เปลี่ยนเฉพาะตัวที่ alias เป็น `stock`)

- [ ] **Step 2: แก้ mapping `is_blocked_no_stock`** — หา:
```ts
      const actualQty = Number(item.actual_quantity) || 0;
      const isBlocked = (actualQty <= 0 && item.stock_rule_active);
```
เปลี่ยนเป็น (ใช้ unreserved ที่ตอนนี้อยู่ใน item.stock):
```ts
      const availableQty = Number(item.stock) || 0;
      const isBlocked = (availableQty <= 0 && item.stock_rule_active);
```

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit; echo "tsc:$?"`
Expected: `tsc:0`

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "fix: product search stock reflects unreserved availability

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: product-search.html — บล็อกจริง + ลบ formatViolation

**Files:**
- Modify: `liff_pages/product-search.html`

**Interfaces:** consume `v.display_message` จาก server

- [ ] **Step 1: บล็อกจริงใน `addToCart`** — หา (~บรรทัด 925-928):
```js
      if (stock <= 0) {
        showAlert(`สินค้าไม่เพียงพอ (พร้อมส่ง ${stock} ชิ้น)`);
      }
      cart.push({ product_code: code, model: code, name: prod.name, price: Number(prod.price)||0, quantity: 1, stock });
```
เปลี่ยนเป็น (return หลัง alert = บล็อก):
```js
      if (1 > stock) {
        showAlert(`สินค้าไม่เพียงพอ (พร้อมส่ง ${stock} ชิ้น) — เพิ่มลงตะกร้าไม่ได้`);
        return;
      }
      cart.push({ product_code: code, model: code, name: prod.name, price: Number(prod.price)||0, quantity: 1, stock });
```

- [ ] **Step 2: บล็อกจริงใน `changeQty`** — หา (~บรรทัด 939-942):
```js
      if (item.quantity <= item.stock && newQty > item.stock) {
        showAlert(`สินค้าไม่เพียงพอ (พร้อมส่ง ${item.stock} ชิ้น)`);
      }
      item.quantity = newQty;
```
เปลี่ยนเป็น:
```js
      if (newQty > item.stock) {
        showAlert(`สินค้าไม่เพียงพอ (พร้อมส่ง ${item.stock} ชิ้น) — เพิ่มจำนวนไม่ได้`);
        return;
      }
      item.quantity = newQty;
```

- [ ] **Step 3: บล็อกจริงใน `setQty`** — หา (~บรรทัด 953-956) แก้แบบเดียวกับ Step 2 (เปลี่ยนเงื่อนไขเป็น `if (newQty > item.stock) { showAlert(...); return; }` ก่อน `item.quantity = newQty;`)

- [ ] **Step 4: ลบ formatViolation + ใช้ display_message** — หา `function formatViolation(v) { ... }` (~บรรทัด 1051-1065) ลบทั้งฟังก์ชัน; แล้วหา (~บรรทัด 1101-1103):
```js
          const violations = Array.isArray(result.violations)
            ? result.violations.map(formatViolation).filter(Boolean)
            : [];
```
เปลี่ยนเป็น:
```js
          const violations = Array.isArray(result.violations)
            ? result.violations.map(v => v.display_message || v.warn_msg || '').filter(Boolean)
            : [];
```

- [ ] **Step 5: verify — เปิดไฟล์ตรวจว่าไม่มี formatViolation เหลือ**

Run: `grep -n "formatViolation" liff_pages/product-search.html; echo "exit:$?"`
Expected: `exit:1` (grep ไม่เจอ = ลบหมดแล้ว)

- [ ] **Step 6: Commit**

```bash
git add liff_pages/product-search.html
git commit -m "fix: product-search blocks out-of-stock adds, uses server display_message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: quote-edit.html — บล็อกจริง + ลบ formatViolation

**Files:**
- Modify: `liff_pages/quote-edit.html`

**Interfaces:** consume `v.display_message`

- [ ] **Step 1: บล็อกจริงใน qty-change (`onFieldChange`)** — หา (~บรรทัด 2758-2769):
```js
        if (field === "quantity") {
          val = Math.max(1, Math.round(val));
          const item = quotesData[qIdx].items[iIdx];
          if (
            item.quantity <= (Number(item.stock) || 0) &&
            val > (Number(item.stock) || 0)
          ) {
            showCustomAlert(
              `สินค้าไม่เพียงพอ (พร้อมส่ง ${item.stock} ชิ้น)`,
            );
          }
          item.quantity = val;
```
เปลี่ยนเป็น (บล็อก: ไม่ commit val ถ้าเกิน stock — คืนช่อง input กลับค่าเดิม):
```js
        if (field === "quantity") {
          val = Math.max(1, Math.round(val));
          const item = quotesData[qIdx].items[iIdx];
          if (val > (Number(item.stock) || 0)) {
            showCustomAlert(
              `สินค้าไม่เพียงพอ (พร้อมส่ง ${item.stock} ชิ้น) — เพิ่มจำนวนไม่ได้`,
            );
            e.target.value = item.quantity; // คืนค่าเดิมในช่อง
            return;
          }
          item.quantity = val;
```

- [ ] **Step 2: บล็อกจริงใน `addProductToQuote`** — หา (~บรรทัด 3454-3457):
```js
        if (1 > stock)
          showCustomAlert(
            `สินค้าไม่เพียงพอ (พร้อมส่ง ${stock} ชิ้น)`,
          );
```
เปลี่ยนเป็น:
```js
        if (1 > stock) {
          showCustomAlert(
            `สินค้าไม่เพียงพอ (พร้อมส่ง ${stock} ชิ้น) — เพิ่มลงใบเสนอราคาไม่ได้`,
          );
          return;
        }
```
(หมายเหตุ: `newItem` ถูกสร้างก่อนบรรทัดนี้ — การ `return` ทำให้ไม่ push/ไม่ POST ปลอดภัย)

- [ ] **Step 3: ลบ formatViolation + ใช้ display_message** — หา `function formatViolation(v) { ... }` (~บรรทัด 2871-2902) ลบทั้งฟังก์ชัน; แล้วหา 2 จุดที่เรียก `.map(formatViolation)`:

จุดที่ 1 (~บรรทัด 2948-2950 ใน saveChangesToServer):
```js
              const violations = Array.isArray(errBody.violations)
                ? errBody.violations.map(formatViolation).filter(Boolean)
                : [];
```
จุดที่ 2 (~บรรทัด 3495-3497 ใน addProductToQuote split branch): เหมือนกัน

ทั้ง 2 จุดเปลี่ยน `.map(formatViolation)` เป็น `.map(v => v.display_message || v.warn_msg || '')`

- [ ] **Step 4: verify ไม่มี formatViolation เหลือ**

Run: `grep -n "formatViolation" liff_pages/quote-edit.html; echo "exit:$?"`
Expected: `exit:1`

- [ ] **Step 5: Commit**

```bash
git add liff_pages/quote-edit.html
git commit -m "fix: quote-edit blocks over-stock qty/adds, uses server display_message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Verification รวม + parity + red-green

**Files:** ไม่แก้โค้ด (verification เท่านั้น) — อาจเพิ่ม parity assertion ใน smoke

**Interfaces:** —

- [ ] **Step 1: parity assertion** — เพิ่มใน `scripts/diag/quoteValidationSmoke.ts` ก่อน `await pool.end();`:

```ts
{
  // parity: display_message เท่ากันไม่ว่าเรียกจาก stage ไหน
  const base = [{ product_id: 16543, product_template_id: 16543, model: 'ECOM0010', quantity: 2, price: 100 }];
  const a = await validateQuotationItems(base, { stage: 'draft' });
  const b = await validateQuotationItems(base, { stage: 'confirm' });
  const msgA = a.violations.find(v => v.type === 'OUT_OF_STOCK')?.display_message;
  const msgB = b.violations.find(v => v.type === 'OUT_OF_STOCK')?.display_message;
  ok('parity: draft vs confirm ข้อความ OUT_OF_STOCK ตรงกัน', !!msgA && msgA === msgB);
}
```

- [ ] **Step 2: รัน smoke ทั้งหมด + typecheck**

Run: `npx tsc --noEmit; echo "tsc:$?" && for s in quoteValidationSmoke stockRuleSmoke stockRulePutSmoke; do echo "-- $s"; npx tsx scripts/diag/$s.ts 2>&1 | grep -v 'injected env' | tail -1; done`
Expected: `tsc:0` และทุก smoke ✅

- [ ] **Step 3: red-green ด่านกลาง** — ชั่วคราวแก้ `evaluateStockViolation` ใน productService.ts บรรทัด `if (available >= requested) return null;` เป็น `if (available > 0) return null;` รัน `npx tsx scripts/diag/quoteValidationSmoke.ts` ต้องเห็น FAIL ตรงเคส ECOM0010 → คืนกลับ → รันอีกครั้งต้องผ่าน

- [ ] **Step 4: ตรวจ grep ว่าไม่มี path ไหน insertDraftQuotations โดยไม่ผ่านด่านกลาง**

Run: `grep -rn "insertDraftQuotations(" index.ts handlers/ services/ | grep -v "function insertDraftQuotations\|export"`
รายงานทุก call site แล้วยืนยันว่าแต่ละตัวมี validateQuotationItems นำหน้าใน flow เดียวกัน (POST /api/quotations, draft-cart, processQuotationRequest, revision x2)

- [ ] **Step 5: verify grep ไม่มี formatViolation เหลือทั้ง 2 หน้า + ไม่มี actual_quantity AS stock**

Run: `grep -rn "formatViolation" liff_pages/; echo "fv exit:$?"; grep -n "actual_quantity AS stock" index.ts; echo "aq exit:$?"`
Expected: `fv exit:1` และ `aq exit:1`

- [ ] **Step 6: Commit parity + final**

```bash
git add scripts/diag/quoteValidationSmoke.ts
git commit -m "test: parity assertion for unified validation across stages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes สำหรับผู้ทำ implement

- ทุก endpoint แก้แล้วต้อง `tsc --noEmit` = 0 ก่อน commit
- ถ้า tsc ฟ้อง unused import (`getBlockedProductError`, `checkStockRules`, `validateAndPrepareItems`, `checkMinSalesPrice`, `StockViolation`, `MinPriceViolation`) หลัง refactor → ลบ import ที่ไม่ใช้ออก (แต่คง export ของฟังก์ชันไว้เพราะ validateQuotationItems ยังเรียกภายใน)
- `checkStockRules`/`checkMinOrderQty`/`checkMinSalesPrice`/`getBlockedProductError` ยัง export ได้ (validateQuotationItems เรียกภายใน) — ไม่ต้องลบ
- LIFF pages ไม่มี test runner — verification คือ grep + manual review + tsc (ไม่กระทบ) เพราะเป็น HTML
- ระวัง circular import: quotationAgent.ts เรียก quotationService.ts ด้วย dynamic `import()` ตามตัวอย่าง (ไม่ใช่ static top-level) เพื่อกัน cycle
