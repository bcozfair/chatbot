# แผนงาน: บล็อกสินค้าได้ 5 ระดับ (production > brand > series > model > internal_reference)

> **สถานะ: ร่าง v1 — รอการตัดสินใจ ยังไม่ลงมือ**
> สำรวจจากโค้ดจริง 2026-09-03

---

## สรุปสำหรับตัดสินใจ (อ่านหน้านี้พอ)

**ตอนนี้:** บล็อกสินค้าอยู่ที่ช่อง `is_locked` ในตาราง `quotation_rules` (หน้า "เงื่อนไขหลัก")
ตารางนั้นมี scope แค่ `production / brand / series` → **บล็อกละเอียดกว่า series ไม่ได้**

**จะทำ:** ย้ายกฎบล็อกออกมาเป็น **ตารางของตัวเอง `product_block_rules`** ที่มี scope ครบ 5 ระดับ
พร้อม **หน้าแอดมินใหม่ "กฎบล็อกสินค้า"** วางเป็น sub-tab ข้าง ๆ MOQ / Stock

**ทำไมต้องแยกตาราง ไม่ใช่เพิ่มคอลัมน์ในตารางเดิม — นี่คือเหตุผลหลักของแผนนี้:**

`resolveQuotationRule()` เลือกกฎที่ **จำเพาะที่สุดเพียงแถวเดียว** แล้วอ่านทั้ง warranty / วันจัดส่ง / ค่าย
จากแถวนั้น ถ้าเราเพิ่ม `model` + `internal_reference` เข้าไปใน `quotation_rules` แล้วแอดมินสร้างแถว
"บล็อกสินค้า SOFBLD0123" แถวนั้นจะกลายเป็นแถวที่จำเพาะที่สุดของสินค้าตัวนั้นทันที แล้ว **ไปทับ
การรับประกันกับวันจัดส่งของ brand ด้วยค่า default (1 ปี / 3-7 วัน)** ทั้งที่แอดมินแค่อยากบล็อก
⇒ regression เงียบ ๆ ในใบเสนอราคา ซึ่งเป็นเส้นทางที่ห้ามพัง

แยกตารางแล้วปัญหานี้หายไปทั้งก้อน เพราะกฎบล็อกไม่ได้อยู่ในชุดเดียวกับกฎ warranty/delivery อีกต่อไป
และยังเข้ารูปเดียวกับ `product_moq_rules` / `product_stock_rules` ที่แยกตารางอยู่แล้ว

**ความต้องการนี้มีอยู่จริงในงานประจำวันแล้ว ไม่ใช่ฟีเจอร์เผื่ออนาคต:**
ตรวจ `product_moq_rules` เจอ 4 แถวที่ตั้ง `min_order_qty` เป็น 9999/99999 พร้อมข้อความว่า
"สินค้านี้ห้ามเสนอราคา" / "รหัสนี้ขายไม่ได้" — คือแอดมินใช้ MOQ ปลอมเป็นกฎบล็อก
เพราะอยากบล็อก 4 ตัวจากซีรีส์ที่มี 24 ตัว แต่ระบบเดิมบล็อกได้แค่ทั้งซีรีส์ (ดู §3.2)

**สมบัติสำคัญที่ทำให้แผนนี้ปลอดภัย:**
การขยาย engine เป็น 5 ระดับ **ไม่กระทบการตัดสินของ `quotation_rules` เลยแม้แต่แถวเดียว**
เพราะแถวใน `quotation_rules` ไม่มีคอลัมน์ `model` / `internal_reference` → เป็น `undefined` →
ไม่ถูกนำมา match และบวก specificity เป็น 0 ⇒ ผลลัพธ์ warranty / วันจัดส่ง / ค่าย เหมือนเดิมทุกบิต
(จะพิสูจน์ด้วย `diag:rule-engine` + `ruleResolutionDiff` ก่อนขึ้น)

**แบ่งเป็น 5 เฟส แต่ละเฟสขึ้นแยกได้ ย้อนกลับได้:**

| เฟส | ทำอะไร | เปลี่ยนพฤติกรรมไหม |
| --- | --- | --- |
| 1 | ขยาย rule engine เป็น 5 ระดับ | ❌ ไม่ (พิสูจน์ด้วย diag) |
| 2 | สร้างตาราง + ก๊อปข้อมูล `is_locked` เดิมเข้ามา (ยังไม่ใช้) | ❌ ไม่ |
| 3 | สลับ 3 จุดที่บล็อกจริงให้อ่านตารางใหม่ + API แอดมิน | ✅ เริ่มใช้ตารางใหม่ |
| 3.5 | ปิดช่องโหว่ฝั่งแสดงผล 6 จุด + ข้อความใช้ template เดียวกับ MOQ | ✅ ข้อความที่เซลล์เห็นเปลี่ยน |
| 4 | หน้าแอดมิน "กฎบล็อกสินค้า" | ✅ ตั้งค่าได้ 5 ระดับ |
| 5 | ลบ `is_locked` ออกจาก `quotation_rules` (หลัง soak) | ❌ ไม่ (ตอนนั้นไม่มีใครอ่านแล้ว) |

---

## 1. ของเดิมอยู่ตรงไหนบ้าง

### 1.1 ตาราง

`quotation_rules` — [migrations/schema.sql:770](../migrations/schema.sql#L770)
มี `production, brand, series` + `is_locked` ปนอยู่กับ `warranty_*`, `delivery_*`, `quote_company`

### 1.2 Rule engine (ใช้ร่วมกันทุกกฎ)

| ไฟล์ | หน้าที่ |
| --- | --- |
| [services/rules/types.ts](../services/rules/types.ts) | `ScopeKey` (scope ของกฎ) · `ProductScope` (scope ของสินค้า) |
| [services/rules/scopeMatch.ts](../services/rules/scopeMatch.ts) | match + specificity bitmask + `selectRule()` |
| [services/rules/quotationRules.ts](../services/rules/quotationRules.ts) | โหลด/resolve `quotation_rules` · `findBlockingRule` · `buildBlockedMessage` |
| [services/rules/cache.ts](../services/rules/cache.ts) | TTL cache ต่อตาราง + `invalidateRuleCache` |

specificity ปัจจุบัน: `series=4, brand=2, production=1` — [scopeMatch.ts:49](../services/rules/scopeMatch.ts#L49)

### 1.3 จุดที่ "บล็อก" ทำงานจริง — มี 3 จุด

| # | ที่ | โค้ด |
| --- | --- | --- |
| 1 | API เช็คตอนเลือกสินค้าใน LIFF | [index.ts:604](../index.ts#L604) `GET /api/products/:code/blocked` |
| 2 | ด่านตรวจก่อนออกใบ (LINE + LIFF) | [services/quotationService.ts:863](../services/quotationService.ts#L863) `getBlockedProductError()` |
| 3 | ตอนสร้าง PDF (fail-safe ชั้นสุดท้าย) | [pdfGenerator.ts:191](../pdfGenerator.ts#L191) `outcome.is_locked` |

> จุดที่ 3 อ่าน `is_locked` ผ่าน `resolveQuotationRule()` (resolve ทั้งชุดแล้วดูตัวชนะ)
> ส่วนจุดที่ 1-2 ใช้ `findBlockingRule()` (filter `is_locked` ก่อนแล้วค่อย match)
> **สอง semantics นี้ให้ผลต่างกัน** ตามที่ comment ใน [quotationRules.ts:149](../services/rules/quotationRules.ts#L149) เตือนไว้
> แผนนี้ทำให้ทั้ง 3 จุดใช้ `findBlockingRule` เหมือนกันหมด = แก้ความไม่สอดคล้องนี้ไปในตัว

### 1.4 หน้าแอดมิน

- [frontend/src/admin/QuotationRules.tsx](../frontend/src/admin/QuotationRules.tsx) — สวิตช์ "ระงับการเสนอราคา" อยู่บรรทัด ~1026
- [frontend/src/admin/ProductMoqRules.tsx](../frontend/src/admin/ProductMoqRules.tsx) — ต้นแบบที่จะลอก: `ProductComboBox` ยิง `/api/products/search`
- [frontend/src/admin/AdminApp.tsx:567-571](../frontend/src/admin/AdminApp.tsx#L567) — จุดต่อ sub-tab

---

## 2. เฟส 1 — ขยาย rule engine เป็น 5 ระดับ  ✅ **ทำแล้ว**

**ไม่แตะ DB · ไม่เปลี่ยนพฤติกรรม · merge เดี่ยว ๆ ได้**

### 2.1 `services/rules/types.ts`

```ts
export interface ScopeKey {
  production?: string | null;
  brand?: string | null;
  series?: string | null;
  model?: string | null;                // ← เพิ่ม
  internal_reference?: string | null;   // ← เพิ่ม
}

export interface ProductScope {
  production: string;
  brand: string;
  series: string;
  model: string;                        // ← เพิ่ม
  internal_reference: string;           // ← เพิ่ม
}
```

### 2.2 `services/rules/scopeMatch.ts`

```ts
export function normalizeProductScope(src: any): ProductScope {
  return {
    production: norm(src?.production),
    brand: norm(src?.brand),
    series: norm(src?.series),
    // snapshot ใช้ product_code, แถวจาก products ใช้ model — รับทั้งสองแบบ
    model: norm(src?.model ?? src?.product_code),
    internal_reference: norm(src?.internal_reference)
  };
}
```

`ruleMatchesScope()` เพิ่มท้ายสุด 2 บรรทัด (exact match เหมือน brand/series):

```ts
if (rule.model && norm(rule.model) !== scope.model) return false;
if (rule.internal_reference && norm(rule.internal_reference) !== scope.internal_reference) return false;
```

`scopeSpecificity()` ขยาย bitmask — **ต้องคงลำดับ ⊂ เดิมไว้** (internal_reference ⊂ model ⊂ series ⊂ brand ⊂ production):

```ts
return (rule.internal_reference ? 16 : 0)
     + (rule.model              ?  8 : 0)
     + (rule.series             ?  4 : 0)
     + (rule.brand              ?  2 : 0)
     + (rule.production         ?  1 : 0);
```

### 2.3 สิ่งที่ต้องระวังตอนทำ

1. **`ProductScope` มี field เพิ่ม → TypeScript จะฟ้องทุกที่ที่สร้าง object นี้ตรง ๆ**
   ต้องไล่ `grep -rn "ProductScope" --include="*.ts"` แล้วแก้ให้ครบ (ส่วนใหญ่สร้างผ่าน `normalizeProductScope` อยู่แล้ว)
2. **`RULES_ORDER_BY` ใน `quotationRules.ts`** อ้าง `series/brand/production` เท่านั้น — **ไม่ต้องแก้**
   เพราะตารางนั้นไม่มีคอลัมน์ใหม่ (และ ORDER BY นี้ไม่ได้ใช้ตัดสินจริงอยู่แล้ว)
3. **ไม่แตะ `productionMatchKind`** — prefix-match `'import'` ยังใช้กับ production เท่านั้นเหมือนเดิม
4. **บิตใหม่ต้องอยู่ "เหนือ" ของเดิม** (`ref=16, model=8`) ห้ามแทรกกลาง
   ค่า series=4 / brand=2 / production=1 ต้องคงเดิมเป๊ะ ลำดับของกฎ 3 ระดับเดิมจึงไม่ขยับแม้แต่คู่เดียว

### 2.3.1 ตรวจแล้ว: engine นี้มีตารางเดียวที่ใช้จริง

`grep -rn "selectRule\|ruleMatchesScope\|scopeSpecificity"` ได้ผลว่า **มีแค่ `quotationRules.ts`**
ที่เรียก `selectRule()` (3 จุด: `resolveQuotationRule`, `findBlockingRule`, `findCompanyRule`)

อีก 2 ตารางที่ใช้ `RuleCacheKey` ร่วมกันไม่ได้ผ่าน engine เลย — ทั้งคู่เป็นแถวเดียว `WHERE id = 1`:

| ตาราง | อ่านที่ | ผ่าน scope matching? |
| --- | --- | --- |
| `shipping_fee_config` | [services/shippingFee.ts:69](../services/shippingFee.ts#L69) | ❌ `id = 1` |
| `quotation_credit_policy` | [services/creditHoldService.ts:70](../services/creditHoldService.ts#L70) | ❌ `id = 1` |

⇒ การขยาย `ScopeKey` เป็น 5 ระดับกระทบได้แค่ `quotation_rules` ตารางเดียว
และตารางนั้นไม่มีคอลัมน์ `model` / `internal_reference` → `undefined` → `ruleMatchesScope` ข้าม
และ `scopeSpecificity` บวก 0 ⇒ **ผลลัพธ์เดิมทุกบิต**

`grep` ยังยืนยันว่า**ไม่มีที่ไหนสร้าง `ProductScope` เป็น object literal ตรง ๆ เลย** (สร้างผ่าน
`normalizeProductScope()` ทั้งหมด) การเพิ่ม field จึงไม่ทำ TypeScript พังสักจุด

### 2.4 พิสูจน์ว่าไม่พัง

```bash
npm run diag:rule-engine        # เพิ่มเคส 5 ระดับใน scripts/diag/ruleEngineSmoke.ts ด้วย
npx tsx scripts/diag/ruleResolutionDiff.ts
npm run diag:quote-validation
npm run diag:pdf-render
```

เคสใหม่ที่ต้องเพิ่มใน `ruleEngineSmoke.ts`:

| เคส | ผลที่ต้องได้ |
| --- | --- |
| กฎ `{internal_reference}` ชนะกฎ `{production,brand,series,model}` | ✅ ref ชนะ (16 > 15) |
| กฎ `{model}` ชนะกฎ `{production,brand,series}` | ✅ model ชนะ (8 > 7) |
| กฎ `{series}` ยังชนะ `{production,brand}` | ✅ เหมือนเดิม (4 > 3) |
| แถวไม่มี `model`/`internal_reference` เลย → specificity เท่าเดิมทุกค่า | ✅ 0-7 เท่าเดิม |
| `normalizeProductScope` อ่าน `product_code` เป็น model ได้ | ✅ |

### 2.5 ผลการทดสอบจริง (รันแล้ว)

รันในคอนเทนเนอร์ชั่วคราวจาก image `primus-chatbot-app` (ต่อ network + DB จริงแบบอ่านอย่างเดียว)
แล้วลบคอนเทนเนอร์ทิ้ง — ไม่แตะคอนเทนเนอร์ที่รันอยู่

| ชุด | ผล |
| --- | --- |
| `npx tsc --noEmit` | ✅ ไม่มี error (ยืนยันว่าการเพิ่ม field ใน `ProductScope` ไม่พังที่ไหนเลย) |
| `ruleEngineSmoke.ts` | ✅ ผ่านทั้งหมด — รวมเคสใหม่ 14 เคส ไม่มี FAIL |
| `ruleResolutionDiff.ts` | ✅ **929 scope ที่มีสินค้าจริง · ไม่มี scope ใดเปลี่ยนผลลัพธ์** เทียบกับ `legacyMatch()` |
| `quoteValidationSmoke.ts` | ✅ ผ่านทั้งหมด |
| `pdfRenderSmoke.ts` | ✅ ผ่านทั้งหมด |

เคสกันถอยหลังที่เพิ่มเข้าไปนอกเหนือจากตารางข้างบน:

- ไล่ bitmask ครบทั้ง 8 ค่าของกฎ 3 ระดับเดิม เทียบกับสูตรเก่าแบบ hard-code ⇒ `0..7` ตรงกันทุกค่า
- `'import'` prefix-match ไม่ลามไป `model` / `internal_reference` (exact เท่านั้น)
- กฎที่ระบุ `model` แต่สินค้าไม่มี `model` ⇒ ไม่ match (fail-closed ไม่ใช่ fail-open)

**หมายเหตุที่ต่างจากแผน:** `normalizeProductScope` ใช้ `src?.model || src?.product_code`
(ไม่ใช่ `??`) เพื่อให้ `model: ''` ตกไปใช้ `product_code` — ตรงกับสำนวนที่ใช้อยู่แล้วทั่วโค้ด
(`services/shippingFee.ts:128`, `utils/flexTemplates.ts:653`)

ยังไม่แตะ `src?.code` ตามที่ §7.0 ตัดสินไว้ — 2 จุดที่ query alias `model AS code`
จะแก้ที่ตัว query ในเฟส 3 ไม่ใช่ให้ engine เดา

---

## 3. เฟส 2 — ตารางใหม่ + ย้ายข้อมูล

`migrations/changes/2026-09-XX_01_product_block_rules.sql`

```sql
BEGIN;

CREATE TABLE public.product_block_rules (
    id                 serial PRIMARY KEY,
    production         text,
    brand              text,
    series             text,
    model              text,
    internal_reference text,
    warn_msg           text NOT NULL,                         -- บังคับกรอก เหมือน sale_line_warn_msg ของ MOQ
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- กันแถวว่างทั้งแถว ซึ่งจะบล็อกสินค้าทั้งคลัง
    --
    -- ⚠️ ต้องใช้ NULLIF(btrim(...),'') ไม่ใช่ IS NOT NULL เฉย ๆ
    -- engine ฝั่ง TS ตัดสิน wildcard ด้วย truthy (`if (rule.production)`) แปลว่า '' = wildcard เท่ากับ NULL
    -- ถ้า CHECK ดูแค่ IS NOT NULL แถวที่ทุกช่องเป็น '' จะผ่าน constraint
    -- แล้วกลายเป็นกฎ wildcard ที่บล็อกสินค้าทุกตัวในระบบ
    CONSTRAINT product_block_rules_scope_not_empty CHECK (
        NULLIF(btrim(production), '')         IS NOT NULL
     OR NULLIF(btrim(brand), '')              IS NOT NULL
     OR NULLIF(btrim(series), '')             IS NOT NULL
     OR NULLIF(btrim(model), '')              IS NOT NULL
     OR NULLIF(btrim(internal_reference), '') IS NOT NULL
    ),
    -- NOT NULL อย่างเดียวไม่พอ — '' หรือ '   ' ผ่าน NOT NULL ได้ แล้วเซลล์จะเห็นข้อความว่างเปล่า
    CONSTRAINT product_block_rules_warn_msg_not_blank CHECK (btrim(warn_msg) <> '')
);

-- กฎซ้ำ scope เดียวกันไม่มีประโยชน์ และทำให้ผลลัพธ์ขึ้นกับ id
-- lower(btrim(...)) เพราะ engine เทียบแบบ trim + lowercase — 'ACME' กับ 'acme ' คือกฎเดียวกัน
-- ถ้าใช้ COALESCE เฉย ๆ จะสร้างกฎซ้ำที่ระบบมองว่าเหมือนกันได้ แล้วผลลัพธ์ไปขึ้นกับ id
CREATE UNIQUE INDEX product_block_rules_scope_uniq
    ON public.product_block_rules (
        lower(btrim(COALESCE(production, ''))),
        lower(btrim(COALESCE(brand, ''))),
        lower(btrim(COALESCE(series, ''))),
        lower(btrim(COALESCE(model, ''))),
        lower(btrim(COALESCE(internal_reference, '')))
    );

-- ถ้ามีแถว is_locked ที่ scope ว่างทั้งหมด = บล็อกทั้งคลัง ต้องหยุดให้คนมาดู ไม่ใช่ข้ามเงียบ ๆ
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.quotation_rules
   WHERE is_locked = true
     AND NULLIF(btrim(production), '') IS NULL
     AND NULLIF(btrim(brand), '')      IS NULL
     AND NULLIF(btrim(series), '')     IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'พบกฎ is_locked ที่ scope ว่างทั้งแถว % แถว — ต้องตัดสินใจก่อนย้าย', n;
  END IF;
END $$;

-- ── ย้ายกฎบล็อกเดิม 4 แถว พร้อมข้อความ (ตอนนี้ยังไม่มีใครอ่านตารางนี้) ──
-- warn_msg ต่อ scope อยู่ใน VALUES ให้เห็นชัดตอน review — ไม่ใช่ค่า default ลอย ๆ
-- NULLIF(btrim(..)) ตอน SELECT ด้วย เพื่อไม่ให้ '' หรือ '  ' หลุดเข้าตารางใหม่
INSERT INTO public.product_block_rules (production, brand, series, warn_msg)
SELECT NULLIF(btrim(r.production), ''),
       NULLIF(btrim(r.brand), ''),
       NULLIF(btrim(r.series), ''),
       w.warn_msg
  FROM public.quotation_rules r
  JOIN (VALUES
    ('production 2(pm)', '', '',
     'สินค้ากลุ่มผลิต Production 2 ไม่เปิดให้เสนอราคาผ่านระบบ กรุณาติดต่อแอดมินเพื่อขอราคาเป็นรายกรณี'),
    ('production 3(pm)', '', 'ecm',
     'สินค้าซีรีส์ ECM ไม่เปิดให้เสนอราคาผ่านระบบ กรุณาติดต่อแอดมินเพื่อขอราคาเป็นรายกรณี'),
    ('buy to sell', '', '',
     'สินค้ากลุ่ม Buy to Sell ต้องเช็คราคาและระยะเวลาสั่งซื้อกับแอดมินก่อนทุกครั้ง'),
    ('buy to sell(tht)', '', '',
     'สินค้ากลุ่ม Buy to Sell (THT) ต้องเช็คราคาและระยะเวลาสั่งซื้อกับแอดมินก่อนทุกครั้ง')
  ) AS w(production, brand, series, warn_msg)
    ON lower(btrim(coalesce(r.production, ''))) = w.production
   AND lower(btrim(coalesce(r.brand, '')))      = w.brand
   AND lower(btrim(coalesce(r.series, '')))     = w.series
 WHERE r.is_locked = true;

-- ── กฎระดับ ref ที่แอดมินทำ workaround ไว้ในตาราง MOQ ──
-- 4 แถวนี้ตั้ง min_order_qty 9999/99999 เพื่อ "บล็อก" เพราะบล็อกได้แค่ระดับ series
-- ข้อความที่แอดมินเขียนเองอยู่แล้ว ยกมาใช้เป็น warn_msg ตรง ๆ (ดู §3.2)
-- ⚠️ แถวใน product_moq_rules ยัง active อยู่ในเฟสนี้ — ปิดตอนเฟส 3 เท่านั้น (ดู §4.4)
INSERT INTO public.product_block_rules (internal_reference, warn_msg)
SELECT m.internal_reference, btrim(m.sale_line_warn_msg)
  FROM public.product_moq_rules m
 WHERE m.internal_reference IN
       ('FAFC4FP1080001', 'FAFC4FP1080003', 'FAFC4FP1080009', 'FAFC4FP1080016')
   AND btrim(m.sale_line_warn_msg) <> '';

-- ── ด่านสุดท้าย: ต้องย้ายครบ ไม่มีแถวไหนหล่น ──
DO $$
DECLARE n_locked int; n_moved int; n_refs int; n_extra int;
BEGIN
  SELECT count(*) INTO n_locked FROM public.quotation_rules WHERE is_locked = true;
  SELECT count(*) INTO n_moved  FROM public.product_block_rules
   WHERE internal_reference IS NULL;
  IF n_locked <> n_moved THEN
    RAISE EXCEPTION 'กฎ is_locked มี % แถว แต่ย้ายได้ % แถว — มีกฎที่ยังไม่ได้เขียน warn_msg ใน VALUES',
      n_locked, n_moved;
  END IF;

  -- กันเคส sale_line_warn_msg ว่าง แล้วแถวถูกกรองทิ้งเงียบ ๆ
  SELECT count(*) INTO n_refs FROM public.product_block_rules
   WHERE internal_reference IS NOT NULL;
  IF n_refs <> 4 THEN
    RAISE EXCEPTION 'กฎระดับ ref ที่ย้ายมาจาก MOQ ได้ % แถว (ต้องได้ 4) — เช็ค sale_line_warn_msg ว่างหรือ ref หาย', n_refs;
  END IF;

  -- มี MOQ ที่ทำหน้าที่บล็อกเพิ่มมาหลังจากเขียนแผนนี้ไหม
  SELECT count(*) INTO n_extra FROM public.product_moq_rules
   WHERE min_order_qty >= 9999
     AND internal_reference NOT IN
         ('FAFC4FP1080001', 'FAFC4FP1080003', 'FAFC4FP1080009', 'FAFC4FP1080016');
  IF n_extra > 0 THEN
    RAISE EXCEPTION 'พบกฎ MOQ ที่ใช้บล็อกเพิ่มมาอีก % แถว — ต้องเพิ่มเข้ารายการก่อนรัน', n_extra;
  END IF;
END $$;

COMMIT;
```

**ต้องเช็คก่อนรัน** (บน DB จริง):

```sql
SET statement_timeout = '10s';
SELECT id,
       production, brand, series,
       (NULLIF(btrim(production),'') IS NULL
        AND NULLIF(btrim(brand),'')  IS NULL
        AND NULLIF(btrim(series),'') IS NULL) AS blocks_everything
  FROM quotation_rules WHERE is_locked = true;

-- MOQ ที่จริง ๆ แล้วเป็นกฎบล็อก
SELECT internal_reference, min_order_qty, sale_line_warn_msg
  FROM product_moq_rules WHERE min_order_qty >= 9999;
```

### 3.1.1 ข้อความที่จะได้ (ตรวจก่อนขึ้น)

ต่อกับ template ของ §4.5.0 แล้วเซลล์จะเห็นแบบนี้:

```
❌ ระงับการเสนอราคา รายการ CH-02 12x170-110-350W-S003: สินค้ากลุ่มผลิต Production 2 ไม่เปิดให้เสนอราคาผ่านระบบ กรุณาติดต่อแอดมินเพื่อขอราคาเป็นรายกรณี
❌ ระงับการเสนอราคา รายการ ECM-13000 SUS: สินค้าซีรีส์ ECM ไม่เปิดให้เสนอราคาผ่านระบบ กรุณาติดต่อแอดมินเพื่อขอราคาเป็นรายกรณี
❌ ระงับการเสนอราคา รายการ FP-108-1 220 V.U1BW: สินค้านี้ห้ามเสนอราคา
❌ ระงับการเสนอราคา รายการ FP-108/DC 24 VDC.U1BW: รหัสนี้ขายไม่ได้ใช้อีกรหัส ครับ
```

**ข้อความของ 4 กฎเดิมเป็นร่างที่เขียนจาก scope ของกฎ** ไม่ใช่เหตุผลทางธุรกิจจริง
(ระบบเดิมไม่มีที่ให้เก็บ — `quotation_rules` ไม่มีคอลัมน์ `warn_msg` เลย)
ให้แอดมิน/ฝ่ายขายอ่านแล้วแก้ก่อนขึ้นเฟส 3 — แก้ในไฟล์ migration ก่อนรัน
หรือแก้ทีหลังผ่านหน้าแอดมินในเฟส 4 ก็ได้
ส่วนข้อความของ 4 ref ยกมาจากที่แอดมินเขียนเองใน MOQ ไม่ต้องแก้

### 3.1.2 ทดลองรันแล้ว (ยังไม่ commit)

รัน SQL ทั้งก้อนบน DB จริงใน transaction แล้ว `ROLLBACK` (`lock_timeout=5s`, `statement_timeout=30s`)
— ยืนยันว่าไม่มีอะไรค้าง: `to_regclass('public.product_block_rules')` คืน NULL หลังจบ

```
CREATE TABLE · CREATE INDEX · DO (ผ่าน) · INSERT 0 4 · INSERT 0 4 · DO (ผ่าน)
```

ได้ 8 แถวตามนี้:

| id | production | series | internal_reference | warn_msg |
| --- | --- | --- | --- | --- |
| 1 | Production 2(PM) | | | สินค้ากลุ่มผลิต Production 2 ไม่เปิดให้เสนอราคาผ่านระบบ กรุณาติดต่อแอดมินเพื่อขอราคาเป็นรายกรณี |
| 2 | Buy to Sell | | | สินค้ากลุ่ม Buy to Sell ต้องเช็คราคาและระยะเวลาสั่งซื้อกับแอดมินก่อนทุกครั้ง |
| 3 | Buy to Sell(THT) | | | สินค้ากลุ่ม Buy to Sell (THT) ต้องเช็คราคาและระยะเวลาสั่งซื้อกับแอดมินก่อนทุกครั้ง |
| 4 | Production 3(PM) | ECM | | สินค้าซีรีส์ ECM ไม่เปิดให้เสนอราคาผ่านระบบ กรุณาติดต่อแอดมินเพื่อขอราคาเป็นรายกรณี |
| 5 | | | FAFC4FP1080001 | รหัสนี้ขายไม่ได้ใช้อีกรหัส ครับ |
| 6 | | | FAFC4FP1080003 | สินค้านี้ห้ามเสนอราคา |
| 7 | | | FAFC4FP1080009 | ใช้รุ่นอื่น |
| 8 | | | FAFC4FP1080016 | รหัสนี้ขายไม่ได้ครับ |

**ไม่มีแถวไหน `warn_msg` ว่าง** — ทั้ง 3 ด่านใน `DO $$` ผ่านหมด
ตอนรันจริงยังต้อง dump ก่อนตามกฎใน [DEPLOY.md:512](../DEPLOY.md#L512)

### 3.2 เจอตอนตรวจ: แอดมินทำ workaround ไว้ในตาราง MOQ แล้ว

`product_moq_rules` มี 156 แถว ในนั้น **4 แถวไม่ใช่กฎ MOQ จริง** — ตั้ง `min_order_qty`
เป็น 9999/99999 เพื่อให้สั่งไม่ได้ เท่ากับใช้ MOQ ปลอมเป็นกฎบล็อก:

| internal_reference | model | min_order_qty | sale_line_warn_msg |
| --- | --- | --- | --- |
| FAFC4FP1080001 | FP-108/DC 24 VDC.U1BW | 9999 | รหัสนี้ขายไม่ได้ใช้อีกรหัส ครับ |
| FAFC4FP1080003 | FP-108-1 220 V.U1BW | 9999 | สินค้านี้ห้ามเสนอราคา |
| FAFC4FP1080009 | FP-108 CX/DC 24 VS1B | 99999 | ใช้รุ่นอื่น |
| FAFC4FP1080016 | FP-108C-S1-B AC220/240V | 9999 | รหัสนี้ขายไม่ได้ครับ |

ทั้ง 4 ตัวอยู่ใน `Import(PM) > COMMONWEALTH > FP-108` ซึ่งซีรีส์นั้นมีสินค้า **24 ตัว**
⇒ แอดมินอยากบล็อก 4 จาก 24 แต่ระบบเดิมบล็อกได้แค่ทั้งซีรีส์ จึงต้องเลี่ยงไปใช้ MOQ

**นี่คือหลักฐานตรงว่าความต้องการ "บล็อกราย ref" มีอยู่จริงในงานประจำวันแล้ว** ไม่ใช่ฟีเจอร์เผื่ออนาคต
และเป็นเหตุผลที่ migration ข้างบนย้ายทั้ง 4 แถวเข้ามาเป็นกฎบล็อกระดับ ref ตั้งแต่เฟส 2

ผลข้างเคียงที่ต้องรู้: ตอนนี้เซลล์เห็นข้อความพวกนี้เป็น `⬇️ จำนวนไม่ถึงขั้นต่ำ ...`
ซึ่งอ่านแล้วสับสน (สินค้าไม่ได้ห้ามขายเพราะจำนวน) — หลังเฟส 3 จะเปลี่ยนเป็น
`❌ ระงับการเสนอราคา ...` ที่ตรงกับความเป็นจริง

### 3.1 ต้องขึ้นทะเบียนตารางใหม่กับ externalSync ด้วย

[services/externalSync.ts:88-92](../services/externalSync.ts#L88) มีรายชื่อตารางที่ sync ออกไปปลายทาง
ตารางกฎอื่นอยู่ในนั้นครบ (`product_moq_rules`, `product_stock_rules`, `quotation_rules`)
ถ้าลืมเพิ่มตัวใหม่ ระบบยังทำงานถูกทุกอย่าง — แต่ข้อมูลกฎบล็อกจะไม่ถูกส่งออกเลย และไม่มี error ให้เห็น

```ts
{ table: 'product_block_rules',      mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
```

ทำในเฟส 2 พร้อมกับ migration (แถวยังว่างอยู่ ยังไม่มีผลอะไร)

---

> **`is_locked` ยังอยู่ในตารางเดิมตลอดเฟส 2-4** — ตั้งใจให้ rollback ได้ด้วยการ revert โค้ดอย่างเดียว
> ไม่ต้องแตะ DB · จะลบตอนเฟส 5

---

## 4. เฟส 3 — resolver ใหม่ + สลับ 3 จุด + API แอดมิน

### 4.1 ไฟล์ใหม่ `services/rules/blockRules.ts`

```ts
export interface ProductBlockRule extends ScopedRule {
  warn_msg: string | null;
  is_active: boolean;
}

export async function loadProductBlockRules(exec: DbExecutor = pool): Promise<ProductBlockRule[]>
// → loadCached('product_block_rules', ...) — SELECT * FROM product_block_rules WHERE is_active

export function findBlockingRule(rules: ProductBlockRule[], scope: ProductScope): ProductBlockRule | null
// → selectRule(rules.filter(r => r.is_active), scope)

/** ข้อความที่แอดมินกรอกไว้ — ไม่มีก็คืน null ให้ buildViolationDisplay เติม default เอง */
export function blockWarnText(rule: ProductBlockRule): string | null
```

`cache.ts` — เพิ่ม `'product_block_rules'` ใน `RuleCacheKey`
`rules/index.ts` — export ตัวใหม่, เอา `findBlockingRule` / `buildBlocked*Message` ออกจาก `quotationRules`

**`buildBlockedMessage` / `buildBlockedPdfMessage` ถูกลบทิ้งทั้งคู่** — ข้อความไปรวมที่
`buildViolationDisplay()` ที่เดียวแบบเดียวกับ MOQ (ดู §4.5.0) `scopeLabel()` ยังอยู่ได้
แต่ใช้กับ **log และหน้าแอดมิน** เท่านั้น ห้ามโผล่ในข้อความที่เซลล์เห็น

### 4.2 สลับจุดเรียกทั้ง 3

**จุดที่ 1** — [index.ts:604](../index.ts#L604) `GET /api/products/:code/blocked`
query ต้องดึงคอลัมน์ใหม่มาด้วย:
```sql
SELECT model, model AS code, brand, series, production, internal_reference
  FROM products WHERE model = $1 ORDER BY quantity_on_hand_unreserved DESC LIMIT 1
```
เปลี่ยน `loadQuotationRules()` → `loadProductBlockRules()` และตัด guard `rules.some(r => r.is_locked)`
เหลือ `if (rules.length === 0) return res.json({ blocked: false })`

**จุดที่ 2** — [services/quotationService.ts:863](../services/quotationService.ts#L863) `getBlockedProductError()`
`getProductInfo()` (~บรรทัด 845) ต้อง SELECT `internal_reference` และ `model` เพิ่ม
เปลี่ยนแหล่งกฎเป็น `loadProductBlockRules()` เหมือนกัน
**เพิ่ม guard:** ข้าม item ที่ `is_shipping_fee` — ค่าขนส่งมี `internal_reference` จริง (`SOFBLDXXXX0010`)
กฎระดับ ref อาจไปบล็อกค่าขนส่งโดยไม่ตั้งใจ (pdfGenerator ข้ามอยู่แล้ว แต่ด่านนี้ยังไม่ข้าม)

**จุดที่ 3** — [pdfGenerator.ts:191](../pdfGenerator.ts#L191)
เลิกใช้ `outcome.is_locked` แล้วเรียกแยก:
```ts
const blockRules = await loadProductBlockRules();   // โหลดคู่กับ quotationRules ที่ต้นฟังก์ชัน
...
const blockingRule = findBlockingRule(blockRules, scope);
if (blockingRule) {
  throw new Error(buildViolationDisplay({
    type: 'BLOCKED',
    model: item.product_code || item.model,
    warn_msg: blockWarnText(blockingRule)
  }));
}
```
> ผลข้างเคียงที่ตั้งใจ: จุดนี้เปลี่ยนจาก "resolve แล้วดูตัวชนะ" เป็น "filter ก่อนแล้ว match"
> = สอดคล้องกับอีก 2 จุดแล้ว (ดูข้อ 1.3)

**ลบออกจาก `quotationRules.ts`:** `is_locked` ใน `QuotationRule` / `QuotationRuleOutcome` /
`QUOTATION_RULE_DEFAULTS` / `resolveQuotationRule()` — โค้ดอ่าน `outcome.is_locked` เหลือ 0 จุดแล้ว
(คอลัมน์ใน DB ยังอยู่ ไม่พัง เพราะ `SELECT *` ก็แค่ได้ field เกินมาที่ไม่มีใครใช้)

### 4.3 API แอดมิน — ลอกโครงจาก moq-rules ([index.ts:3701](../index.ts#L3701))

| Method | Path | หมายเหตุ |
| --- | --- | --- |
| GET | `/api/admin/block-rules` | เรียง specificity DESC, id ASC |
| POST | `/api/admin/block-rules` | validate: ต้องมีอย่างน้อย 1 ช่อง **+ ต้องมี `warn_msg`** · เช็คซ้ำก่อนตอบ 400 ภาษาไทย |
| PUT | `/api/admin/block-rules/:id` | |
| DELETE | `/api/admin/block-rules/:id` | |
| PATCH | `/api/admin/block-rules/:id/active` | สลับ is_active (ปุ่มในตาราง) |

ทุก write path **ต้องเรียก `invalidateRuleCache('product_block_rules')`** — ลืมแล้วแอดมินกดบันทึกแต่ไม่มีผล 60 วิ
ทุกตัว `adminAuthMiddleware, requireRole('admin')` เหมือน moq-rules

**normalize ค่าก่อน insert/update ทุกครั้ง** — ห้ามส่ง `''` หรือ `'  '` ลง DB:

```ts
const nz = (v: unknown) => { const t = String(v ?? '').trim(); return t === '' ? null : t; };
// ...แล้วใช้ nz(production), nz(brand), nz(series), nz(model), nz(internal_reference)
```

ของเดิมที่ [index.ts:2807](../index.ts#L2807) ใช้ `production || null` ซึ่งกัน `''` ได้ แต่ไม่กัน `'  '`
(กฎที่มีแต่ช่องว่างจะไม่ match อะไรเลย = กฎตายเงียบ ๆ) — ตัวใหม่ใช้ `nz()` ให้ตรงกับ `CHECK` ในเฟส 2
API ต้อง `return 400` เมื่อทุกช่องเป็น null แทนที่จะปล่อยให้ constraint โยน 500

**`warn_msg` เป็นช่องบังคับ** เหมือน `sale_line_warn_msg` ของ MOQ ([index.ts:3742](../index.ts#L3742))
— ตอบ 400 ถ้าไม่ส่งมา เพราะข้อความที่เซลล์เห็นมาจากช่องนี้ที่เดียว (ดู §4.5.0)

### 4.4 ปิด MOQ ปลอม 4 แถว — **ต้องอยู่ในเฟส 3 เท่านั้น**

`migrations/changes/2026-09-XX_02_retire_fake_moq_blocks.sql`

```sql
BEGIN;

UPDATE public.product_moq_rules
   SET is_active = false, updated_at = now()
 WHERE internal_reference IN
       ('FAFC4FP1080001', 'FAFC4FP1080003', 'FAFC4FP1080009', 'FAFC4FP1080016');

COMMIT;
```

⚠️ **ห้ามเอาไปไว้ในเฟส 2** — เฟส 2 ยังไม่มีใครอ่าน `product_block_rules`
ถ้าปิด MOQ ตั้งแต่ตอนนั้น สินค้า 4 ตัวนี้จะ**ขายได้**ในช่วงคาบเกี่ยวจนกว่าเฟส 3 จะขึ้น
ต้องรันหลังโค้ดเฟส 3 deploy แล้วเท่านั้น

**ทำไมต้องปิด:** ถ้าปล่อยไว้ เซลล์จะโดน 2 ข้อความพร้อมกันสำหรับสินค้าตัวเดียว
(`❌ ระงับการเสนอราคา ...` + `⬇️ จำนวนไม่ถึงขั้นต่ำ ...`) ซึ่งอันหลังไม่จริง

**rollback:** `UPDATE ... SET is_active = true WHERE internal_reference IN (...)`
(ไม่ลบแถวทิ้ง เพื่อให้ย้อนได้ด้วยคำสั่งเดียว และเก็บ `min_order_qty` เดิมไว้เป็นหลักฐาน)

---

## 4.5 เฟส 3.5 — แก้ฝั่งแสดงผลให้ครบทุกจุด

**ที่มา:** ตรวจ 3 หน้าจริง (product-search · quote-edit · Flex) แล้วเจอช่องโหว่ 6 จุด
ทั้งหมดเป็นของเดิมที่มีมาก่อนแผนนี้ ไม่ได้เกิดจากเฟส 1 — แต่พอบล็อกได้ถึงระดับ ref
ผลกระทบจะแรงขึ้นมาก (กฎเยอะขึ้น เซลล์เจอบ่อยขึ้น) จึงต้องปิดพร้อมกับเฟส 3

ผลการตรวจที่เป็นหลักฐาน (รันจริงกับ DB production แบบอ่านอย่างเดียว):

| ตรวจ | ผล |
| --- | --- |
| `GET /api/products/:code/blocked` ยิงจริง 5 เคส | ✅ ถูกทั้ง production-level และ series-level |
| ด่านกลาง 3 stage (draft/save/confirm) | ✅ ข้อความ BLOCKED ตรงกันเป๊ะทั้ง 3 |
| ด่านกลาง vs PDF fail-safe บน 929 scope จริง | ✅ ไม่มี scope ไหนให้ผลต่างกัน (85 scope = 39,840 สินค้า) |
| ทางเข้าเรียกด่านกลางครบ 6 เส้น | ✅ POST `/api/quotations` · POST `draft-cart` · PUT `/api/quotation/:id` · POST `confirm` · postback `action=confirm` · revision |

### 4.5.0 ต้นแบบข้อความ = MOQ (ใช้กับ **ทุก** จุดที่แจ้งเตือน)

MOQ ทำถูกอยู่แล้ว ให้ลอกโครงมาทั้งดุ้น:

| MOQ (ต้นแบบ) | BLOCKED (ต้องเปลี่ยนเป็นแบบนี้) |
| --- | --- |
| `checkMinOrderQty()` คืน **array** 1 violation ต่อ 1 บรรทัดที่ผิด | `checkBlockedProducts()` คืน array เหมือนกัน |
| `violation.model` = รหัสสินค้าจริงจาก DB | เหมือนกัน (เดิมเป็น `'-'`) |
| `warn_msg` มาจากช่องที่แอดมินกรอก (`sale_line_warn_msg`) API บังคับกรอก | `product_block_rules.warn_msg` API บังคับกรอกเหมือนกัน |
| ข้อความ **บรรทัดเดียว** ประกอบที่ `buildViolationDisplay()` ที่เดียว | เหมือนกัน |
| ไม่มีการเปิดเผย scope/กฎภายในให้เซลล์เห็น | เลิกพิมพ์ `เงื่อนไข: x > y > z` |

```ts
// services/quotationService.ts — buildViolationDisplay()
case 'BLOCKED': {
  const detail = v.warn_msg ? `: ${v.warn_msg}` : ' กรุณาติดต่อแอดมิน';
  return `❌ ระงับการเสนอราคา รายการ ${model}${detail}`;
}
```

เทียบของเดิมกับของใหม่ (ข้อความจริงที่ดึงมาจากระบบ):

```
เดิม  ❌ ระงับการเสนอราคา ⏎ CH-02 12x170-110-350W-S003 ⏎ เงื่อนไข: Production 2(PM) >  >  ⏎ กรุณาติดต่อแอดมิน
ใหม่  ❌ ระงับการเสนอราคา รายการ CH-02 12x170-110-350W-S003: <ข้อความที่แอดมินกรอก>
```

**จุดที่ต้องเปลี่ยนให้ใช้ตัวเดียวกันทั้งหมด:**

1. ด่านกลาง `validateQuotationItems` → ผ่าน `buildViolationDisplay` อยู่แล้ว
2. `GET /api/products/:code/blocked` → `message: buildViolationDisplay({ type:'BLOCKED', model, warn_msg })`
   (เดิมเรียก `buildBlockedMessage` ที่มีฟอร์แมตของตัวเอง)
3. PDF fail-safe → `throw new Error(buildViolationDisplay({...}))`
   (เดิมเรียก `buildBlockedPdfMessage` ที่ฟอร์แมตต่างจากข้อ 2 อีกแบบ)

⇒ ลบ `buildBlockedMessage` + `buildBlockedPdfMessage` ทิ้งทั้งคู่ เหลือถ้อยคำเดียวทั้งระบบ
ตรงตามคอมเมนต์ที่เขียนไว้แล้วที่ [quotationService.ts:54](../services/quotationService.ts#L54)
ว่า `buildViolationDisplay` คือ "ถ้อยคำเดียวของทั้งระบบ"

⚠️ **นี่คือการเปลี่ยนข้อความที่เซลล์เห็น** — ต้องแจ้งทีมขายก่อนขึ้น
และต้องมี `warn_msg` ครบทุกกฎก่อน ไม่งั้นเซลล์จะได้แต่ default ที่ไม่บอกเหตุผล
(migration ในเฟส 2 ย้าย `is_locked` มาโดยไม่มี `warn_msg` → ต้องเติมให้ครบก่อนสลับ)

### 4.5.1 รายงานให้ครบทุกบรรทัด (ตอนนี้บอกได้ทีละ 1 รายการ)

[getBlockedProductError()](../services/quotationService.ts#L863) `return` ทันทีที่เจอตัวแรก
ใส่สินค้าที่ถูกบล็อก 2 ตัว ได้ violation เดียว (ทดสอบแล้ว) — ต่างจาก MOQ/สต๊อก/min-price
ที่รายงานครบทุกบรรทัด และ `violation.model` เป็น `'-'` ไม่ใช่รหัสสินค้า

เปลี่ยนเป็นทรง MOQ เป๊ะ:

```ts
export interface BlockViolation {
  type: 'BLOCKED';
  model: string;      // รหัสจริงจาก products ไม่ใช่ '-'
  name: string;
  warn_msg: string | null;
}

export async function checkBlockedProducts(items: any[] | null): Promise<BlockViolation[]>
// - ข้าม item ที่ is_shipping_fee (ดู §4.2 จุดที่ 2)
// - loop ทุก item ไม่ return กลางทาง
// - lookup รอบเดียวด้วย ANY($1) แบบ checkMinOrderQty ไม่ใช่ getProductInfo ทีละตัวในลูป
```

แล้วใน `validateQuotationItems` เปลี่ยนจากบล็อกเดียว เป็น loop แบบเดียวกับ MOQ:

```ts
for (const e of await checkBlockedProducts(expanded)) {
  const v = { type: 'BLOCKED' as const, model: e.model, warn_msg: e.warn_msg };
  violations.push({ ...v, display_message: buildViolationDisplay(v) });
}
```

> ผลพลอยได้: ตัดการ query แบบ N+1 ทิ้ง (เดิมเรียก `getProductInfo` ทีละ item ในลูป)

### 4.5.2 Flex สรุปร่าง — ไม่บอกเลยว่าถูกบล็อก และปุ่มยืนยันยังโผล่

ทดสอบด้วยใบจำลองที่มีสินค้าติดกฎ #2 ราคาปกติ:

```
มีคำว่า "ระงับ" ในการ์ด: false
มีปุ่ม "ยืนยันออกใบเสนอราคา": true      ← กดแล้วเด้ง error แน่นอน
```

[flexTemplates.ts:1176](../utils/flexTemplates.ts#L1176) ซ่อนปุ่มยืนยันให้อยู่แล้วสำหรับ
`customerIncomplete` / `customerBlacklisted` / `creditHoldText` / `hasMinPriceViolation`
— ขาดแค่ blocked ตัวเดียว

ต้องทำ 2 อย่างใน `getQuotationSummaryMessage()`:

1. โหลด block rules ครั้งเดียวต่อใบ แล้วมาร์คต่อบรรทัด — แถบแดงใต้รายการแบบเดียวกับแถบสต๊อก
   ข้อความในแถบ = `buildViolationDisplay({type:'BLOCKED', ...})` ตัวเดียวกับที่อื่น
2. เพิ่ม `hasBlockedItem` เข้าเงื่อนไขซ่อนปุ่ม + ข้อความเตือนแทนปุ่ม

```ts
if (customerIncomplete || hasBlockedItem || hasMinPriceViolation || customerBlacklisted || creditHoldText) {
```

**ลำดับข้อความเตือน** ให้ blocked มาก่อน min-price (บล็อกแก้เองไม่ได้ ต้องไปหาแอดมิน
ส่วนราคาต่ำกว่าขั้นต่ำเซลล์แก้เองได้) แต่หลัง `customerIncomplete` / blacklist / credit
ที่เป็นระดับลูกค้าซึ่งครอบทั้งใบ

⚠️ ต้อง `try/catch` แล้ว **ปล่อยผ่าน** เหมือนที่ blacklist ทำอยู่ ([flexTemplates.ts:717](../utils/flexTemplates.ts#L717))
— การ์ดสรุปเป็นแค่ตัวเตือนต้นทาง ตัวบล็อกจริงคือด่านตอนกดยืนยัน ถ้าโหลดกฎล้มต้องไม่ทำให้การ์ดพัง

### 4.5.3 `quote-edit.html` — ไม่เคยเรียก `/blocked` เลย

[addProductToQuote()](../liff_pages/quote-edit.html#L3717) เพิ่มสินค้าเข้าใบตรง ๆ
ไปเจอ error ตอนกดบันทึกเท่านั้น (ต่างจาก product-search ที่เช็คตั้งแต่ใส่ตะกร้า)
คลาส `.is-blocked` ที่มีอยู่ในไฟล์เป็นของ dropdown **ลูกค้า** ไม่ใช่สินค้า

- `onSheetStep()` → เรียก `/api/products/:code/blocked` ก่อน `addProductToQuote()`
  ถูกบล็อก = `showCustomAlert(message)` แล้ว return (แบบเดียวกับ `addToCart` ใน product-search)
- `renderSheetResults()` → ป้าย 🚫 ในแถวผลค้นหา ใช้สไตล์ `.is-blocked` เดิมซ้ำได้
- ต้อง `catch` แล้วปล่อยผ่าน — client เช็คไม่ได้ไม่ควรกันเซลล์ทำงาน ด่านจริงอยู่ที่ server

### 4.5.4 `product-search.html` — สินค้าพ่วงไม่ถูกเช็ค

[product-search.html:987](../liff_pages/product-search.html#L987) — `optionals.forEach`
push เข้าตะกร้าโดยข้าม `/blocked` (เช็คเฉพาะสินค้าหลัก)
⇒ เช็คสินค้าพ่วงด้วย ถ้าตัวพ่วงถูกบล็อกให้ข้ามตัวพ่วง + `showAlert` บอกว่าข้ามเพราะอะไร
(ไม่ต้องบล็อกสินค้าหลักตาม — สินค้าหลักไม่ผิดอะไร)

### 4.5.5 ล้างช่องว่างค้างในข้อความ

ของเดิม `เงื่อนไข: Production 2(PM) >  > ` — หายไปเองเมื่อทำ §4.5.0 เพราะเลิกพิมพ์ scope แล้ว
ไม่ต้องแก้ `scopeLabel` ให้ยุ่ง (ยังใช้กับ log/หน้าแอดมินได้ตามเดิม)

### 4.5.6 ทดสอบเฟส 3.5

| ตรวจ | วิธี |
| --- | --- |
| ข้อความตรงทั้ง 3 จุด | ยิง `/blocked` + เรียก `validateQuotationItems` + สร้าง PDF ของสินค้าตัวเดียวกัน → string ต้องเท่ากันเป๊ะ |
| รายงานครบทุกบรรทัด | ใส่สินค้าถูกบล็อก 3 ตัว → ต้องได้ 3 violations พร้อมรหัสสินค้าครบ |
| Flex ซ่อนปุ่ม | ใบจำลองที่มีสินค้าถูกบล็อก → `ยืนยันออกใบเสนอราคา` ต้องไม่อยู่ใน JSON |
| Flex ไม่พังตอนโหลดกฎล้ม | mock ให้ `loadProductBlockRules` throw → การ์ดยังออกปกติ |
| ค่าขนส่งไม่โดนบล็อก | `npm run diag:block-parity` |
| ของเดิมไม่พัง | `npm run diag:quote-validation` · `npm run diag:pdf-render` |

---

## 5. เฟส 4 — หน้าแอดมิน `BlockRules.tsx`

ต่อเป็น sub-tab `'block'` ใน [AdminApp.tsx:567](../frontend/src/admin/AdminApp.tsx#L567) ข้าง ๆ `moq`

### 5.1 ฟอร์ม — dropdown "ระดับ" 1 ช่อง แล้วค่อยแตกช่องกรอกตามระดับ

| ระดับที่เลือก | ช่องที่โผล่ | แหล่งข้อมูล |
| --- | --- | --- |
| ฝ่ายผลิต | dropdown production | `/api/admin/quotation-rules/options` (มีอยู่แล้ว ใช้ซ้ำได้เลย) |
| ยี่ห้อ | production (ไม่บังคับ) + brand | ↑ ใช้ `relations` กรอง cascade เหมือนหน้าเงื่อนไขหลัก |
| ซีรีส์ | production/brand (ไม่บังคับ) + series | ↑ |
| **รุ่น (model)** | `ProductComboBox` | `/api/products/search` — เก็บ `model` ของสินค้าที่เลือก |
| **รหัสสินค้า (ref)** | `ProductComboBox` | `/api/products/search` — เก็บ `internal_reference` |

`ProductComboBox` ลอกจาก [ProductMoqRules.tsx:52-195](../frontend/src/admin/ProductMoqRules.tsx#L52)
→ **ควรแยกเป็น component กลาง** `frontend/src/admin/ProductComboBox.tsx` แล้วให้ทั้ง MOQ และ Block ใช้ร่วมกัน
(ตอนนี้มันอยู่ในไฟล์ MOQ ตัวเดียว — ก๊อปเป็นตัวที่สองแล้วต้องแก้สองที่ตลอดไป)

ระดับ model / ref **ไม่ต้องกรอก production/brand/series** — `internal_reference` unique อยู่แล้ว
([schema.sql:1352](../migrations/schema.sql#L1352)) และ `model` ก็จำเพาะพอ

ช่อง "ข้อความแจ้งเซลล์" (`warn_msg`) — ไม่บังคับ เว้นว่าง = ใช้ข้อความมาตรฐาน

### 5.2 ตาราง

คอลัมน์: ระดับ (badge) · ขอบเขต · ข้อความ · สถานะ (toggle) · แก้ไข/ลบ
ค้นหา + เรียง + แบ่งหน้า — ลอกโครงจาก `ProductMoqRules.tsx` ทั้งดุ้น

### 5.3 เอาสวิตช์เดิมออกจากหน้าเงื่อนไขหลัก

ลบบล็อก `is_locked` ใน [QuotationRules.tsx:1026-1050](../frontend/src/admin/QuotationRules.tsx#L1026)
และเงื่อนไข `{!formData.is_locked && ...}` ที่บรรทัด 1052 / 1123 (ซ่อนช่อง warranty ตอนล็อก)
รวมทั้งคอลัมน์ "สถานะ" ในตาราง (บรรทัด 613, 659-702)
→ ใส่ลิงก์/ข้อความสั้น ๆ ชี้ไปแท็บใหม่แทน เพื่อไม่ให้แอดมินหาไม่เจอ

---

## 6. เฟส 5 — เก็บกวาด (ทำหลัง soak อย่างน้อย 1 สัปดาห์)

`migrations/changes/2026-XX-XX_01_quotation_rules_drop_is_locked.sql`

```sql
ALTER TABLE public.quotation_rules DROP COLUMN is_locked;
```

ก่อนรัน: `grep -rn "is_locked" --include="*.ts" --include="*.tsx" .` ต้องเหลือ 0 (ยกเว้น migration เก่า)
ตอนนั้น POST/PUT `/api/admin/quotation-rules` ต้องถอด `is_locked` ออกจาก INSERT/UPDATE ด้วย
([index.ts:2756, 2783, 2795, 2845, 2863](../index.ts#L2756))

---

## 7. การทดสอบ

### 7.0 ⚠️ 4 จุดที่พังแบบ "เงียบ" — ไม่มี error ให้เห็น แต่บล็อกไม่ทำงาน

ทั้ง 4 จุดเป็น **fail-open**: ระบบตอบ `blocked: false` / ปล่อยใบเสนอราคาผ่าน โดยไม่มี log ผิดปกติ
ต้องมีเคส diag ยืนยันทีละจุด ห้ามอาศัยการอ่านโค้ดอย่างเดียว

| # | จุด | ถ้าลืม | ตรวจด้วย |
| --- | --- | --- | --- |
| 1 | [index.ts:627](../index.ts#L627) fast-path `if (!rules.some(r => r.is_locked === true))` | ตารางใหม่มีกฎ แต่ endpoint ตอบ `blocked:false` ทุกครั้ง | เคส LIFF ข้อ 7.3.1 |
| 2 | [quotationService.ts:874](../services/quotationService.ts#L874) fast-path เดียวกัน | ด่านกลางปล่อยผ่านหมด | `diag:quote-validation` |
| 3 | [index.ts:632](../index.ts#L632) query `SELECT model AS code, ...` — **ไม่มี `model` และ `internal_reference`** | กฎ 2 ระดับใหม่ไม่มีวัน match ที่ด่าน LIFF | เคส blockRuleSmoke ระดับ ref |
| 4 | [getProductInfo()](../services/quotationService.ts#L838) — ไม่ SELECT `internal_reference` | กฎ ref ไม่ทำงานที่ด่านกลาง | เคส blockRuleSmoke ระดับ ref |

จุด 3 กับ 4 เป็นเรื่องเดียวกัน: `model` ถูก alias เป็น `code` ทิ้งไปในทั้งสอง query
`normalizeProductScope()` จะอ่านไม่เจอ → `scope.model = ''` → กฎระดับ model/ref ไม่ match
**แก้ที่ query ให้คืน `model` ตรง ๆ อย่าไปเดา field `code` ใน `normalizeProductScope`** —
`code` ในบริบทอื่นของระบบไม่ได้แปลว่า model เสมอไป

> ด่านที่ 3 ([pdfGenerator.ts:191](../pdfGenerator.ts#L191)) ไม่มีปัญหานี้ —
> item จาก snapshot มี `model` และ `internal_reference` ครบอยู่แล้ว
> ([buildItemSnapshots](../services/quotationService.ts#L318))
> แต่ใบเก่าที่ freeze ไว้ก่อนมี `internal_reference` จะบล็อกได้แค่ถึงระดับ model — ยอมรับได้
> เพราะด่าน 1/2 จับไปก่อนแล้ว ด่าน 3 เป็นแค่ fail-safe

### 7.0.1 เก็บ baseline ก่อนแตะโค้ด

รันชุดใน 7.2 **ก่อน** เริ่มเฟส 1 แล้วเก็บ output ไว้เทียบ
โดยเฉพาะ `ruleResolutionDiff` ซึ่งเทียบ engine ปัจจุบันกับ matcher เดิม
([scripts/diag/ruleResolutionCore.ts](../scripts/diag/ruleResolutionCore.ts) เก็บสำเนา matcher เก่าไว้ verbatim)
— **ห้ามแก้ `legacyMatch()`** เด็ดขาด มันคือหลักฐานว่า `quotation_rules` ยังตัดสินเหมือนเดิม
ถ้าเฟส 1 ทำอะไรพัง สคริปต์นี้จะเห็นทันที

### 7.1 ชุดใหม่ `scripts/diag/blockRuleSmoke.ts` (+ `"diag:block-rule"` ใน package.json)

| กลุ่ม | เคส |
| --- | --- |
| specificity | ref > model > series > brand > production ครบทุกคู่ |
| match | กฎ ref ตรงตัวเดียว ไม่โดนสินค้าอื่นในรุ่นเดียวกัน |
| match | กฎ model โดนทุก ref ในรุ่นนั้น |
| match | กฎ brand ไม่โดนสินค้าต่าง brand |
| is_active | กฎที่ปิดอยู่ต้องไม่บล็อก |
| ข้อความ | ทรง MOQ เป๊ะ: `❌ ระงับการเสนอราคา รายการ <model>: <warn_msg>` · ไม่มี `warn_msg` → ` กรุณาติดต่อแอดมิน` · ไม่มี scope โผล่ในข้อความ |
| ข้อความ | 3 จุด (endpoint · ด่านกลาง · PDF) ให้สตริงเดียวกันเป๊ะสำหรับสินค้าตัวเดียวกัน |
| รายงานครบ | สินค้าถูกบล็อก 3 ตัว → 3 violations · `model` เป็นรหัสจริงไม่ใช่ `'-'` |
| cache | แก้แล้ว invalidate เห็นผลทันที |
| ค่าขนส่ง | item `is_shipping_fee` ไม่ถูกบล็อกไม่ว่ากฎจะเป็นอะไร |
| สินค้าจริง | สุ่มสินค้าจาก DB มาผ่าน findBlockingRule ไม่ throw |

### 7.2 ชุดเดิมที่ต้องรันซ้ำทุกเฟส (ต้องได้ผลเดิมเป๊ะ)

```bash
npm run diag:rule-engine
npm run diag:quote-validation
npm run diag:pdf-render
npm run diag:stock-rule
npm run diag:shipping-fee
npm run diag:credit-hold
npm run diag:block-parity
npx tsx scripts/diag/ruleResolutionDiff.ts
```

`diag:block-parity` ([scripts/diag/blockParity.ts](../scripts/diag/blockParity.ts)) เป็นชุดถาวรที่เพิ่มมาพร้อมแผนนี้
เฝ้า 3 อย่าง: ด่านกลาง vs PDF ให้ผลตรงกันทุก scope จริง · บรรทัดค่าขนส่งไม่ถูกกฎครอบ ·
ความครอบคลุมของกฎ (กี่ scope/กี่สินค้า) ไว้เทียบก่อน-หลัง migration เฟส 2

### 7.3 ทดสอบมือ (LIFF)

1. บล็อกระดับ ref → ค้นสินค้าตัวนั้นใน `product-search.html` ต้องขึ้นข้อความบล็อก · สินค้ารุ่นเดียวกันคนละ ref ต้องผ่าน
2. บล็อกระดับ model → ทุก ref ในรุ่นต้องโดน
3. ใบที่มีสินค้าถูกบล็อกอยู่แล้ว → กดออก PDF ต้องถูกปฏิเสธพร้อมข้อความ (ด่านที่ 3)
4. `quote-edit.html` → เพิ่มสินค้าที่ถูกบล็อกจากช่องค้นหา ต้องเด้งทันทีตั้งแต่กด `+` ไม่ใช่ตอนกดบันทึก (§4.5.3)
5. `product-search.html` → สินค้าที่มีของพ่วงซึ่ง**ตัวพ่วง**ถูกบล็อก ต้องเพิ่มสินค้าหลักได้แต่ข้ามตัวพ่วงพร้อมบอกเหตุผล (§4.5.4)
6. Flex สรุปร่างของใบที่มีสินค้าถูกบล็อก → ต้องมีแถบแดงใต้รายการนั้น และ**ไม่มี**ปุ่ม "ยืนยันออกใบเสนอราคา" (§4.5.2)
7. ข้อความจาก 3 จุด (LIFF alert · ด่านกลาง · PDF) ของสินค้าตัวเดียวกัน ต้องเป็นสตริงเดียวกันเป๊ะ (§4.5.0)
4. คุยผ่าน LINE สั่งสินค้าที่ถูกบล็อก → บอทต้องตอบข้อความบล็อก

---

## 8. ความเสี่ยงที่เหลือ

| ความเสี่ยง | ระดับ | กัน |
| --- | --- | --- |
| กฎระดับ ref ไปบล็อกค่าขนส่ง (`SOFBLDXXXX0010`) | กลาง | ข้าม `is_shipping_fee` ในด่านที่ 2 + เคส diag |
| แอดมินสร้างกฎ brand แล้วบล็อกสินค้าหลายร้อยตัวโดยไม่รู้ | กลาง | (ทำทีหลังได้) endpoint `preview` บอกจำนวนสินค้าที่กฎครอบ ก่อนกดบันทึก |
| ลืม `invalidateRuleCache` ใน write path ใหม่ | ต่ำ | เคส cache ใน `blockRuleSmoke.ts` |
| ข้อความบล็อกที่เซลล์เห็นเปลี่ยนรูปแบบ (ไปใช้ template MOQ) | **กลาง** | แจ้งทีมขายก่อนขึ้นเฟส 3.5 · `warn_msg` เขียนครบทุกกฎแล้วใน migration §3 (ไม่มีกฎไหนตกไปใช้ default) |
| ถ้อยคำร่างของ 4 กฎเดิมไม่ตรงเหตุผลธุรกิจจริง | **กลาง** | §3.1.1 — ให้ฝ่ายขายอ่านแล้วแก้ในไฟล์ migration ก่อนรัน · แก้ทีหลังผ่านหน้าแอดมินเฟส 4 ได้ |
| ลืมปิด MOQ ปลอม 4 แถว → เซลล์เห็น 2 ข้อความพร้อมกัน | ต่ำ | §4.4 เป็น migration แยกที่ผูกกับเฟส 3 · rollback ด้วย UPDATE บรรทัดเดียว |
| ปิด MOQ ปลอมเร็วไป (ไปอยู่ในเฟส 2) → สินค้า 4 ตัวขายได้ช่วงคาบเกี่ยว | **กลาง** | §4.4 เขียนกำกับไว้ชัดว่าห้ามอยู่ในเฟส 2 · migration แยกไฟล์กันคนละเฟส |
| Flex ซ่อนปุ่มยืนยันเพิ่ม 1 เงื่อนไข → ใบที่เคยกดได้อาจกดไม่ได้ | ต่ำ | เป็นใบที่กดไปก็ถูกปฏิเสธที่ด่านจริงอยู่แล้ว · โหลดกฎล้ม = ปล่อยผ่าน ปุ่มยังโผล่ตามเดิม |
| quote-edit ยิง `/blocked` เพิ่มทุกครั้งที่เพิ่มสินค้า | ต่ำ | endpoint มี fast-path + cache 60 วิ · client `catch` แล้วปล่อยผ่าน ด่านจริงอยู่ที่ server |
| ลืมเพิ่ม `product_block_rules` ใน `externalSync` | ต่ำ | ข้อ 3.1 — ระบบไม่พัง แต่ข้อมูลไม่ถูกส่งออกและไม่มี error |
| frontend เก่าที่ค้างในเบราว์เซอร์ยังส่ง `is_locked` หลัง drop คอลัมน์ | ต่ำ | เฟส 5 ต้องห่างจากเฟส 4 อย่างน้อย 1 สัปดาห์ · backend เลิกอ่าน field นี้ตั้งแต่เฟส 4 (ส่งมาก็แค่ถูกละเลย ไม่ 500) |
| ระหว่างเฟส 2-4 มีข้อมูล 2 ที่ (`is_locked` + ตารางใหม่) | ต่ำ | เฟส 3 ขึ้นแล้วไม่มีใครอ่าน `is_locked` อีก · เฟส 4 เอา UI ออกทันทีในรอบเดียวกัน |

---

## 9. สิ่งที่ **ไม่** ทำในแผนนี้

- ไม่เพิ่มคอลัมน์ `priority` (engine รองรับอยู่แล้วถ้าจะเพิ่มทีหลัง — ไม่ใส่ก่อนเพราะยังไม่มีคนต้องการ)
- ไม่แตะ `product_moq_rules` / `product_stock_rules` (ถ้าอยากให้ 2 ตัวนี้เป็น 5 ระดับด้วย เป็นงานแยก
  ที่ทำได้ง่ายขึ้นมากหลังเฟส 1 เพราะ engine พร้อมแล้ว)
- ไม่ทำ audit log ของการแก้กฎบล็อก (อยู่ในแผน `plan-logging-audit-compliance.md`)
