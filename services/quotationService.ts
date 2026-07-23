import { pool, withTransaction, type DbExecutor } from '../config/db.js';
import { getCustomerByDisplayName, getFirstContact, getCompanyAddressRows, getContactById } from '../db/repositories.js';
import {
  findCustomerCandidates,
  findContactCandidates,
  findCustomerByContactName,
  formatLineLabel,
  cleanContactName,
  splitCustomerContact
} from './customerService.js';
import { 
  createListFlexMessage, 
  createUnregisteredCustomerFlex
} from '../utils/flexTemplates.js';
import { expandOptionalProducts, checkStockRules, StockViolation } from './productService.js';
import { sumLineTotals, calcNetPrice } from '../utils/pricing.js';
import { validateProductPriceWithPromotions } from '../utils/promotionValidator.js';
import {
  loadQuotationRules,
  resolveQuotationRule,
  resolveDeliveryOutOfStockDays,
  findBlockingRule,
  findCompanyRule,
  buildBlockedMessage,
  normalizeProductScope
} from './rules/index.js';

const cleanState = (s: any) => String(s || '').replace(/\s*\(.*/, '').split(/\s+/)[0].trim();

const cleanAddressField = (fieldVal: any, rawState: any, zip: any) => {
  if (!fieldVal) return '';
  const cleanZip = String(zip || '').trim();
  const cleanStateVal = String(rawState || '').replace(/\s*\(.*/, '').trim();
  const words = fieldVal.split(/[\s,]+/).map((w: any) => w.trim()).filter(Boolean);
  const filtered = words.filter((word: any) => {
    const wordLower = word.toLowerCase();
    if (cleanZip && wordLower === cleanZip.toLowerCase()) return false;
    if (['thailand', 'th', 'china', 'taiwan', 'malaysia', 'singapore', 'israel'].includes(wordLower)) return false;
    if (cleanStateVal) {
      const stateLower = cleanStateVal.toLowerCase();
      if (stateLower.includes(wordLower) || wordLower.includes(stateLower)) return false;
    }
    return true;
  });
  return filtered.join(' ');
};

/**
 * เพิ่มตัวนับของ key แล้วคืนลำดับใหม่แบบ atomic (row lock ผ่าน ON CONFLICT DO UPDATE)
 * ต้องเรียกภายใน transaction (executor = PoolClient) เพื่อให้ lock ถูกถือจนกว่าจะ COMMIT
 */
async function bumpCounter(key: string, executor: DbExecutor): Promise<number> {
  const { rows } = await executor.query(
    `INSERT INTO quotation_counters (counter_key, last_seq) VALUES ($1, 1)
     ON CONFLICT (counter_key) DO UPDATE
       SET last_seq = quotation_counters.last_seq + 1, updated_at = NOW()
     RETURNING last_seq`,
    [key]
  );
  return rows[0].last_seq;
}

/**
 * จองเลขที่ใบเสนอราคาแบบ atomic ผ่านตาราง quotation_counters (แทนการ COUNT-then-INSERT ที่ race)
 * ต้องเรียกภายใน transaction เท่านั้น (executor = PoolClient) เพราะ row lock ของ counter
 * ต้องถูกถือไว้จนกว่าจะ COMMIT พร้อมกับการ UPDATE status
 *
 * เดือนของเลขยึด quoteData.created_at (วันที่ร่าง) ตามเดิม — จึงต้องไม่เขียนทับ created_at ตอนยืนยัน
 */
export async function allocateQuotationNo(quoteData: any, executor: DbExecutor): Promise<string> {
  // 1) revision → นับต่อจากเลขฐาน (แกะ revise_from จาก customer_name)
  let reviseFrom: string | null = null;
  if (quoteData?.customer_name && quoteData.customer_name.includes(' | ')) {
    const parts = quoteData.customer_name.split(' | ');
    if (parts[2]) {
      try {
        reviseFrom = Object.fromEntries(new URLSearchParams(parts[2])).revise_from || null;
      } catch (err) {
        console.warn(`[allocateQuotationNo] parse metadata ไม่สำเร็จ (quote id=${quoteData.id})`, err);
      }
    }
  }
  if (reviseFrom) {
    const m = reviseFrom.match(/^((?:QP|QT)-\d+)(-\d+)$/i);
    const baseQuoteNo = m ? m[1] : reviseFrom;
    const seq = await bumpCounter(`REV:${baseQuoteNo}`, executor);
    return `${baseQuoteNo}-${String(seq).padStart(2, '0')}`;
  }

  // 2) เลขปกติ — prefix จากสินค้ารายการแรก, เดือนจาก created_at (วันที่ร่าง)
  if (!quoteData?.created_at) {
    throw new Error('[allocateQuotationNo] quoteData.created_at ไม่มีค่า — ไม่สามารถออกเลขได้');
  }
  let isThemtech = false;
  if (quoteData.items && quoteData.items.length > 0) {
    isThemtech = (await resolveQuoteCompany(quoteData.items[0], executor)) === 'THT';
  }
  const prefix = isThemtech ? 'QT' : 'QP';
  const dateObj = new Date(quoteData.created_at);
  const yy = String(dateObj.getFullYear()).slice(-2);
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const period = `${yy}${mm}`;
  const seq = await bumpCounter(`${prefix}:${period}`, executor);
  return `${prefix}-${period}05${String(seq).padStart(3, '0')}`;
}

export type ConfirmResult =
  | { outcome: 'confirmed';         quotationNo: string }
  | { outcome: 'already_confirmed'; quotationNo: string }
  | { outcome: 'cancelled' }
  | { outcome: 'not_found' };

/**
 * ยืนยันใบเสนอราคาแบบ atomic + idempotent — จุดเดียวในระบบที่เปลี่ยน status เป็น confirmed
 *
 * ต้องเรียก "หลัง" enrich + ตรวจราคาขั้นต่ำ/โปรโมชันเสร็จแล้ว (ทำนอก transaction) เพราะ
 * enrichQuotationData ผูกกับ pool ตรง ๆ ถ้าดึงเข้ามาในนี้จะขอ connection ซ้อนขณะถือ row lock จนตัน
 *
 * @param enrichedQuote ผลจาก enrichQuotationData ใช้แค่ items/customer_name/created_at สำหรับออกเลข
 *                      + ตัดสิน revision — status ในนี้ห้ามเชื่อ อ่านใหม่ใต้ row lock เสมอ
 */
export async function confirmQuotationAtomic(
  quoteId: string,
  enrichedQuote: any
): Promise<ConfirmResult> {
  return withTransaction(async (client) => {
    // 1) ล็อกแถว — ผู้กดยืนยันพร้อมกันคนที่ 2 จะรอตรงนี้จนคนแรก COMMIT แล้วจึงเห็น status ล่าสุด
    const cur = await client.query(
      `SELECT id, status, quotation_no FROM quotations WHERE id = $1 FOR UPDATE`,
      [quoteId]
    );
    if (cur.rowCount === 0) return { outcome: 'not_found' as const };

    const row = cur.rows[0];
    if (row.status === 'cancelled') return { outcome: 'cancelled' as const };
    if (row.status === 'confirmed') {
      return { outcome: 'already_confirmed' as const, quotationNo: row.quotation_no || '-' };
    }

    // 2) จองเลข (ใช้เลขเดิมถ้ามีอยู่แล้ว เพื่อไม่เผาเลขซ้ำ) — created_at ยึดของ enrichedQuote (วันที่ร่าง)
    const quotationNo = row.quotation_no
      || await allocateQuotationNo(enrichedQuote, client);

    // 3) UPDATE แบบมีเงื่อนไข status + เช็ค rowCount (ห้ามเขียนทับ created_at เพราะเลขคำนวณจากมัน)
    const upd = await client.query(
      `UPDATE quotations
          SET status = 'confirmed',
              quotation_no = COALESCE(quotation_no, $1),
              updated_at = NOW()
        WHERE id = $2 AND status <> 'confirmed' AND status <> 'cancelled'
      RETURNING quotation_no`,
      [quotationNo, quoteId]
    );
    if (upd.rowCount === 0) {
      // มี FOR UPDATE แล้วยังโดน 0 แถว = มีทางเขียน status ที่เรายังไม่รู้ ให้ rollback ทั้งชุด
      throw new Error(`[confirmQuotationAtomic] UPDATE ไม่โดนแถวใด (id=${quoteId}) — สถานะเปลี่ยนระหว่างล็อก`);
    }

    // 4) ยกเลิกใบเก่ากรณี revision — อยู่ใน tx เดียวกัน ล้มแล้ว rollback ทั้งการยืนยัน
    const custName = enrichedQuote?.customer_name;
    if (custName && custName.includes('revise_from=')) {
      await cancelOldRevision(custName, client);
    }

    return { outcome: 'confirmed' as const, quotationNo: upd.rows[0].quotation_no };
  });
}

export async function resolveQuoteCompany(item: any, executor: DbExecutor = pool): Promise<'PM' | 'THT'> {
  let rules: any[] = [];
  try {
    rules = await loadQuotationRules(executor);
  } catch (err) {
    console.error('Error fetching quotation rules for company resolution:', err);
  }

  // ไม่มีกฏที่ระบุค่ายเลย → ข้ามการ query สินค้าไปเลย (เหมือนเดิม)
  const hasCompanyRule = rules.some((r: any) => r.quote_company != null);
  const code = item.product_code || item.model || item.code;
  if (code && hasCompanyRule) {
    const prod = await getProductInfo(code, executor);
    if (prod) {
      const rule = findCompanyRule(rules, normalizeProductScope(prod));
      if (rule) {
        if (rule.quote_company === 'PM') return 'PM';
        if (rule.quote_company === 'THT') return 'THT';
      }
    }
  }

  // fallback: logic เดิม
  return item.production === 'Import(PM)' ? 'THT' : 'PM';
}

/**
 * สร้าง snapshot ของรายการสินค้าเพื่อ freeze ลง quotations.item_details
 *
 * เป็นจุดเดียวในระบบที่สร้าง snapshot — ทั้ง LINE flow (insertDraftQuotations)
 * และ PUT /api/quotation/:id ใช้ตัวนี้ร่วมกัน field ใหม่ทุกตัวต้องเพิ่มที่นี่ที่เดียว
 */
export async function buildItemSnapshots(rawItems: any[], executor: DbExecutor = pool): Promise<any[]> {
  let quotationRules: any[] = [];
  try {
    quotationRules = await loadQuotationRules(executor);
  } catch (err) {
    console.error('[buildItemSnapshots] Error fetching quotation rules:', err);
  }

  const { isShippingFeeItem, loadShippingFeeConfig, buildShippingFeeSnapshot } =
    await import('./shippingFee.js');
  const shippingCfg = await loadShippingFeeConfig(executor);

  const snapshotItems: any[] = [];
  for (const item of rawItems) {
    // บรรทัดค่าขนส่งมีกติกาคนละชุด: ชื่อ/ราคาเป็นของที่เซลล์ตั้งเอง (ห้ามให้ชื่อ 'ค่าบริการ'
    // จาก products ทับ) จำนวนกับส่วนลดถูกล็อก และไม่มีวันจัดส่ง/การรับประกัน
    // มอบงานให้ผู้สร้างบรรทัดนั้นโดยตรง เพื่อให้ shape ออกมาจากที่เดียวเสมอ
    if (isShippingFeeItem(item, shippingCfg)) {
      snapshotItems.push(buildShippingFeeSnapshot(shippingCfg, item));
      continue;
    }

    const code = item.product_code || item.model || item.code || '';
    let dbProduct: any = null;
    try {
      const prodRes = await executor.query(
        'SELECT product_template_id AS product_id, internal_reference, name, sales_description, brand, series, production FROM products WHERE model = $1 ORDER BY actual_quantity DESC LIMIT 1',
        [code]
      );
      dbProduct = prodRes.rows[0];
    } catch (err) {
      console.warn(`[buildItemSnapshots] ดึงข้อมูลสินค้าไม่สำเร็จ (model="${code}") — ใช้ค่าจาก item แทน`, err);
    }

    const finalInternalRef = dbProduct?.internal_reference || code;
    const finalProductId = dbProduct?.product_id || item.product_id || null;
    const finalName = dbProduct?.name || item.name || '';
    const finalSalesDesc = dbProduct?.sales_description || item.sales_description || '';
    const iBrand = dbProduct?.brand || item.brand || '';
    const iSeries = dbProduct?.series || item.series || '';
    const iProduction = dbProduct?.production || item.production || '';

    const outcome = resolveQuotationRule(
      quotationRules,
      normalizeProductScope({ production: iProduction, brand: iBrand, series: iSeries })
    );

    // วันส่งกรณีสต็อกไม่พอขึ้นกับจำนวนที่สั่งของรายการนี้ (tier) — freeze ค่าที่ผ่าน tier แล้วลง snapshot
    // ทำที่นี่ได้เพราะ tier ขึ้นกับจำนวนล้วน ๆ ไม่ขึ้นกับสต็อก (สต็อกเป็นตัวเลือกว่าจะใช้ in หรือ out)
    const quantity = Number(item.quantity ?? item.qty) || 0;
    const outOfStock = resolveDeliveryOutOfStockDays(outcome, quantity);

    snapshotItems.push({
      internal_reference: finalInternalRef,
      product_id: finalProductId,
      model: code,
      name: finalName,
      sales_description: finalSalesDesc,
      price: Number(item.price) || 0,
      quantity,
      discount_1: Number(item.discount_1) || 0,
      discount_2: Number(item.discount_2) || 0,
      remark: item.remark || '',
      brand: iBrand,
      series: iSeries,
      production: iProduction,
      warranty_display: outcome.warranty_display,
      delivery_in_stock_days: outcome.delivery_in_stock_days,
      delivery_out_of_stock_days: outOfStock.days,
      delivery_source: outOfStock.source,
      is_optional: !!item.is_optional,
      // ผูกสินค้าเสริมกลับไปยังสินค้าหลัก — ต้อง persist ลง snapshot ด้วย
      // ไม่งั้นหายตอน round-trip แล้วฝั่งแสดงผล (Flex/LIFF) แยกสินค้าพ่วงไม่ออก
      linked_to_product_id: item.linked_to_product_id ?? null
    });
  }
  return snapshotItems;
}

// ค่าตั้งต้นเมื่อ snapshot ไม่มีวันจัดส่งติดมา (ใบเก่าก่อนมี rule engine) — ตรงกับ QUOTATION_RULE_DEFAULTS
const DELIVERY_DAYS_FALLBACK_IN_STOCK = 3;
const DELIVERY_DAYS_FALLBACK_OUT_OF_STOCK = 7;

/**
 * จำนวนวันจัดส่งของ "ทั้งใบ" = ค่ามากสุดของทุกรายการ (รายการที่ช้าสุดเป็นตัวกำหนดวันส่งทั้งใบ)
 *
 * อ่านจาก snapshot ที่ freeze ไว้ตอนสร้าง/บันทึกใบ (delivery_in_stock_days /
 * delivery_out_of_stock_days ผ่าน tier มาแล้ว) โดยใช้สต๊อกจาก items เป็นตัวเลือกว่าจะใช้ in หรือ out
 *
 * ⚠️ เป็นจุดเดียวที่คำนวณเลขนี้ — ทั้ง enrichQuotationData (ที่หน้า LIFF เอาไปโชว์)
 * และ pdfGenerator (ที่พิมพ์ลงเอกสาร) ต้องเรียกตัวนี้ ไม่งั้นเซลล์เห็นเลขคนละตัวกับในไฟล์
 *
 * บรรทัดค่าขนส่งถูกข้ามทั้งการนับวันและการตัดสิน all_in_stock — มันไม่ใช่ของที่ต้องผลิต/ส่ง
 * ถ้านับด้วย สต๊อก 0 ของมันจะดึงทั้งใบไปเป็น "ของไม่พอ" แล้วดันวันส่งขึ้นเป็นเคสสต๊อกขาด
 */
export function resolveQuotationDeliveryDays(
  items: any[],
  snapshots: any[]
): { days: number; all_in_stock: boolean } {
  const list = Array.isArray(items) ? items : [];
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  // snapshot จับคู่กับ items ตาม index ได้ต่อเมื่อจำนวนตรงกัน (เหมือนที่ pdfGenerator เช็ค)
  const snapsUsable = snaps.length > 0 && snaps.length === list.length;

  let allInStock = true;
  const perItemDays: number[] = [];

  list.forEach((item: any, idx: number) => {
    const snap = snapsUsable ? snaps[idx] : null;
    // ฟังก์ชันนี้เป็น sync (pdfGenerator เรียกตรง) จึงอ่าน config มาเทียบไม่ได้ —
    // ใช้มาร์กที่ buildShippingFeeSnapshot ปั๊มไว้ใน snapshot แทน
    if (snap?.delivery_source === 'shipping_fee') return;

    const qty = Number(item.quantity ?? item.qty) || 0;
    const stock = item.stock !== undefined && item.stock !== null ? Number(item.stock) : 0;
    const hasStock = qty <= stock;
    if (!hasStock) allInStock = false;

    const inDays = snap && snap.delivery_in_stock_days !== undefined && snap.delivery_in_stock_days !== null
      ? Number(snap.delivery_in_stock_days)
      : DELIVERY_DAYS_FALLBACK_IN_STOCK;
    const outDays = snap && snap.delivery_out_of_stock_days !== undefined && snap.delivery_out_of_stock_days !== null
      ? Number(snap.delivery_out_of_stock_days)
      : DELIVERY_DAYS_FALLBACK_OUT_OF_STOCK;

    perItemDays.push(hasStock ? inDays : outDays);
  });

  const fallback = allInStock ? DELIVERY_DAYS_FALLBACK_IN_STOCK : DELIVERY_DAYS_FALLBACK_OUT_OF_STOCK;
  return {
    days: perItemDays.length > 0 ? Math.max(...perItemDays) : fallback,
    all_in_stock: allInStock
  };
}

/**
 * วันจัดส่งของรายการที่ "ยังไม่ได้บันทึก" — หน้า LIFF เรียกระหว่างเซลล์แก้จำนวน/เพิ่มสินค้า
 *
 * สร้าง snapshot ชั่วคราวด้วย buildItemSnapshots ตัวเดียวกับตอนบันทึกจริง แล้วอ่านสต๊อกสดจาก DB
 * (ไม่เชื่อ stock ที่ client ส่งมา เพราะอาจค้างตั้งแต่ตอนเปิดหน้า) → เลขที่โชว์ระหว่างแก้
 * จึงเท่ากับเลขที่จะได้หลังกดบันทึก ทั้งใน Flex และใน PDF
 */
export async function previewQuotationDeliveryDays(
  rawItems: any[]
): Promise<{ days: number; all_in_stock: boolean }> {
  const snapshots = await buildItemSnapshots(rawItems);

  const stockKeys = snapshots.map((s: any) => s.model || s.internal_reference).filter(Boolean);
  const stockMap: Record<string, number> = {};
  if (stockKeys.length > 0) {
    try {
      const { rows } = await pool.query(
        'SELECT model AS code, actual_quantity AS stock FROM products WHERE model = ANY($1)',
        [stockKeys]
      );
      rows.forEach((p: any) => {
        const s = p.stock !== undefined && p.stock !== null ? Number(p.stock) : 0;
        // เผื่อมีหลายแถวชื่อ model เดียวกัน ให้ใช้สต๊อกสูงสุด (เหมือนที่ enrichQuotationData ทำ)
        if (stockMap[p.code] === undefined || s > stockMap[p.code]) stockMap[p.code] = s;
      });
    } catch (err) {
      console.error('[previewQuotationDeliveryDays] ดึงสต๊อกสดไม่สำเร็จ — ใช้ค่าที่ client ส่งมาแทน', err);
    }
  }

  const itemsWithStock = snapshots.map((snap: any, idx: number) => {
    const key = snap.model || snap.internal_reference;
    const clientStock = rawItems[idx]?.stock;
    return {
      quantity: snap.quantity,
      stock: stockMap[key] !== undefined
        ? stockMap[key]
        : (clientStock !== undefined && clientStock !== null ? Number(clientStock) : 0)
    };
  });

  return resolveQuotationDeliveryDays(itemsWithStock, snapshots);
}

/**
 * ตรวจค่า "วันจัดส่งที่เซลล์แก้เอง" ที่ส่งมาจาก client
 * คืน number = ใช้ค่านี้, null = ล้างกลับไปใช้ค่าอัตโนมัติ, undefined = client ไม่ได้ส่งมา (คงค่าเดิม)
 * โยน Error พร้อมข้อความภาษาไทยเมื่อค่าไม่ผ่าน — ผู้เรียกเอาไปตอบ 400
 */
export function parseDeliveryDaysOverride(raw: any): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3650) {
    throw new Error('จำนวนวันจัดส่งต้องเป็นจำนวนเต็ม 0–3650 วัน');
  }
  return n;
}

export async function insertDraftQuotations(
  userId: string,
  customerName: string,
  itemsForDb: any[] | null,
  status: string,
  customerId?: number | null,
  contactId?: number | null,
  preserveDrafts: boolean = false
): Promise<any[] | null> {
  // การลบร่างเดิม (pending/draft) ย้ายไปทำใน transaction เดียวกับ INSERT ด้านล่าง
  // เพื่อให้ DELETE+INSERT เป็น atomic — ถ้า INSERT ล้ม ร่างเดิมจะไม่ถูกลบทิ้งไปฟรี ๆ

  // บรรทัดค่าขนส่งต้องไม่เข้าการแบ่ง PM/THT — มันไม่มี production/brand/series ให้ตัดสิน
  // resolveQuoteCompany จึงจะตอบ 'PM' เสมอ แล้วสร้างใบ PM เปล่า ๆ ขึ้นมาในเคสที่สั่ง THT ล้วน
  // ตัดทิ้งตรงนี้แล้วให้ applyShippingFeeToQuoteGroup เติมกลับเองหลัง INSERT
  const { isShippingFeeItem, loadShippingFeeConfig, applyShippingFeeToQuoteGroup } =
    await import('./shippingFee.js');
  const shippingCfg = await loadShippingFeeConfig();
  const items = (itemsForDb || []).filter((item: any) => !isShippingFeeItem(item, shippingCfg));
  const pmItems: any[] = [];
  const thtItems: any[] = [];

  for (const item of items) {
    const company = await resolveQuoteCompany(item);
    if (company === 'THT') {
      thtItems.push(item);
    } else {
      pmItems.push(item);
    }
  }

  // 1. ดึงข้อมูลทีมขาย
  let employeeDetails: any = {
    salesperson_id: null,
    saleperson: '',
    sale_phone: ''
  };
  let salespersonIdStr: string | null = null;

  if (userId) {
    try {
      const spRes = await pool.query(
        'SELECT salesperson_id, name, phone FROM salesperson WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      const spData = spRes.rows[0];
      if (spData) {
        salespersonIdStr = spData.salesperson_id ? String(spData.salesperson_id).trim() : null;
        employeeDetails = {
          salesperson_id: salespersonIdStr,
          saleperson: spData.name || '',
          sale_phone: spData.phone || ''
        };
      }
    } catch (err) {
      console.error('[insertDraftQuotations] Error fetching salesperson info:', err);
    }
  }

  // 2. ดึงข้อมูลรายละเอียดลูกค้าและจัด format ที่อยู่
  let companyName = (customerName || '').trim();
  let contactNameQuery = '';
  let customMeta: any = {};
  let reviseFrom: string | null = null;
  let customMetaStr = '';

  if (customerName && customerName.includes(' | ')) {
    const parts = customerName.split(' | ');
    companyName = parts[0].trim();
    contactNameQuery = parts[1].trim();
    if (parts[2]) {
      customMetaStr = parts.slice(2).join(' | ').trim();
      try {
        customMeta = Object.fromEntries(new URLSearchParams(customMetaStr));
        reviseFrom = customMeta.revise_from || null;
      } catch (err) {
        console.warn(`[insertDraftQuotations] parse metadata ไม่สำเร็จ (userId=${userId}) meta="${customMetaStr}"`, err);
      }
    }
  }

  let customerCode = '';
  let customerTaxId = '';
  let contactName = contactNameQuery || '';
  let contactPhone = '';
  let contactEmail = '';
  let contactAddress = '';
  let paymentTerms = '';

  if (companyName) {
    try {
      let custData = null;

      // 2.1 ใช้ ID ดึงตรงจาก customers_data_view (ครอบคลุม orphan จาก sale_orders + enrich payment/type)
      // เฉพาะ path ที่มี company_id (ID-based) → ใช้ view; path ค้นด้วยชื่อ (ด้านล่าง) คง customers เพราะเร็วกว่า
      // และ orphan มี customerId+contactId เสมอจึงเข้า path นี้ (view lookup by (company_id,contact_id) = ~3ms)
      if (customerId && contactId) {
        const custRes = await pool.query(
          'SELECT * FROM customers_data_view WHERE company_id = $1 AND contact_id = $2 LIMIT 1',
          [customerId, contactId]
        );
        custData = custRes.rows[0];
      }
      if (customerId && !custData) {
        if (contactNameQuery) {
          const custRes = await pool.query(
            'SELECT * FROM customers_data_view WHERE company_id = $1 AND TRIM(contact_name) = TRIM($2) LIMIT 1',
            [customerId, contactNameQuery]
          );
          custData = custRes.rows[0];
        }
        if (!custData) {
          const custRes = await pool.query(
            'SELECT * FROM customers_data_view WHERE company_id = $1 LIMIT 1',
            [customerId]
          );
          custData = custRes.rows[0];
        }
      }

      // 2.2 Fallback: ค้นหาด้วยชื่อแบบ TRIM ป้องกันช่องว่างส่วนเกิน
      if (!custData) {
        if (contactNameQuery) {
          const custRes = await pool.query(
            'SELECT * FROM customers WHERE TRIM(customer_name) = TRIM($1) AND TRIM(contact_name) = TRIM($2) LIMIT 1',
            [companyName, contactNameQuery]
          );
          custData = custRes.rows[0];
        }
        if (!custData) {
          const custRes = await pool.query(
            'SELECT * FROM customers WHERE TRIM(customer_name) = TRIM($1) LIMIT 1',
            [companyName]
          );
          custData = custRes.rows[0];
        }
      }

      if (custData) {
        customerCode = custData.customer_reference || '';
        customerTaxId = custData.customer_tax_id || '';
        contactName = custData.contact_name || contactNameQuery || '';
        paymentTerms = custData.customer_payment_terms || '';

        if (custData.contact_mobile && custData.contact_mobile.trim()) {
          contactPhone = custData.contact_mobile.trim();
        } else if (custData.contact_phone && custData.contact_phone.trim()) {
          contactPhone = custData.contact_phone.trim();
        } else if (custData.phone && custData.phone.trim()) {
          contactPhone = custData.phone.trim();
        } else if (custData.mobile && custData.mobile.trim()) {
          contactPhone = custData.mobile.trim();
        }

        const emails = [];
        if (custData.contact_email && custData.contact_email.trim()) {
          emails.push(custData.contact_email.trim());
        }
        if (custData.email && custData.email.trim()) {
          emails.push(custData.email.trim());
        }
        const uniqueEmails = Array.from(new Set(emails));
        contactEmail = uniqueEmails.length > 0 ? uniqueEmails.join(', ') : '';

        // ที่อยู่ดึงจาก customers_data_view (ผ่าน getContactById) เพราะ view blend อำเภอ/ตำบลที่ขาดจาก sale_orders ล่าสุดให้
        let addrSrc: any = custData;
        if (custData.contact_id) {
          const viewContact = await getContactById(custData.contact_id);
          if (viewContact) addrSrc = viewContact;
        }

        const stateCleaned = cleanState(addrSrc.invoice_state);
        const districtCleaned = cleanAddressField(addrSrc.invoice_district, addrSrc.invoice_state, addrSrc.invoice_zip);
        const subDistrictCleaned = cleanAddressField(addrSrc.invoice_sub_district, addrSrc.invoice_state, addrSrc.invoice_zip);

        const addr = [
          addrSrc.invoice_street,
          districtCleaned,
          subDistrictCleaned,
          stateCleaned,
          addrSrc.invoice_zip
        ].map(s => String(s || '').trim()).filter(Boolean).join(' ');

        contactAddress = addr || '';
      }
    } catch (err) {
      console.error('[insertDraftQuotations] Error fetching customer details:', err);
    }
  }

  if (customMeta) {
    if (customMeta.tax_id) customerTaxId = customMeta.tax_id;
    if (customMeta.phone) contactPhone = customMeta.phone;
    if (customMeta.email) contactEmail = customMeta.email;
    if (customMeta.address) contactAddress = customMeta.address;
  }

  // ยังไม่ได้ผูกลูกค้า = null (ระบบอนุญาตเฉพาะลูกค้าที่มีในฐานข้อมูล ไม่มีค่า default อีกแล้ว)
  const customerDetails = {
    customer_name: companyName || null,
    customer_code: customerCode,
    customer_tax_id: customerTaxId,
    contact_name: contactName || null,
    phone: contactPhone,
    email: contactEmail,
    address: contactAddress,
    payment_terms: paymentTerms,
    revise_from: reviseFrom,
    custom_meta: customMetaStr
  };

  const draftQuotesToInsert: any[] = [];

  if (pmItems.length > 0) {
    const pmSum = sumLineTotals(pmItems);
    const itemDetails = await buildItemSnapshots(pmItems);
    draftQuotesToInsert.push({
      user_id: userId,
      total_sum: pmSum,
      status: status,
      customer_details: customerDetails,
      item_details: itemDetails,
      salesperson_id: salespersonIdStr,
      employee_details: employeeDetails,
      customer_id: customerId || null,
      contact_id: contactId || null
    });
  }

  if (thtItems.length > 0) {
    const thtSum = sumLineTotals(thtItems);
    const itemDetails = await buildItemSnapshots(thtItems);
    draftQuotesToInsert.push({
      user_id: userId,
      total_sum: thtSum,
      status: status,
      customer_details: customerDetails,
      item_details: itemDetails,
      salesperson_id: salespersonIdStr,
      employee_details: employeeDetails,
      customer_id: customerId || null,
      contact_id: contactId || null
    });
  }

  // DELETE ร่างเดิม + INSERT ใบใหม่ ใน transaction เดียว (atomic) — enrich ทำนอก tx เสมอ
  // เพราะ enrichQuotationData ผูกกับ pool ตรง ๆ ถ้าเรียกใน tx จะขอ connection ซ้อนจนตัน
  let insertedRaw: any[];
  try {
    insertedRaw = await withTransaction(async (client) => {
      if (!preserveDrafts) {
        await client.query(
          "DELETE FROM quotations WHERE user_id = $1 AND status IN ('pending_company', 'pending_contact', 'draft')",
          [userId]
        );
      }
      const rows: any[] = [];
      for (const q of draftQuotesToInsert) {
        const res = await client.query(`
          INSERT INTO quotations (
            user_id, total_sum, status,
            customer_details, item_details, salesperson_id, employee_details,
            customer_id, contact_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `, [
          q.user_id, q.total_sum, q.status,
          JSON.stringify(q.customer_details), JSON.stringify(q.item_details), q.salesperson_id, JSON.stringify(q.employee_details),
          q.customer_id,
          q.contact_id
        ]);
        if (res.rows[0]) rows.push(res.rows[0]);
      }
      return rows;
    });
  } catch (err) {
    console.error("[insertDraftQuotations] Database Insert Error:", err);
    return null;
  }

  // ค่าขนส่งอัตโนมัติ — ต้องทำหลัง COMMIT เพราะกฎคิดจากยอดรวมของ "ทุกใบในกลุ่ม"
  // ซึ่งเพิ่งมีครบตอนนี้ แล้วอ่านแถวกลับมาใหม่เพื่อให้ผู้เรียกได้ item_details ล่าสุด
  await applyShippingFeeToQuoteGroup(userId);
  const insertedIds = insertedRaw.map((row: any) => row.id);
  if (insertedIds.length > 0) {
    try {
      const { rows: refreshed } = await pool.query(
        'SELECT * FROM quotations WHERE id = ANY($1)',
        [insertedIds]
      );
      // เรียงตามลำดับที่ INSERT ไว้เดิม (ผู้เรียกใช้ insertedQuotes[0] เป็นใบหลัก)
      const byId = new Map(refreshed.map((row: any) => [row.id, row]));
      insertedRaw = insertedIds.map((id: any) => byId.get(id) ?? insertedRaw.find((r: any) => r.id === id));
    } catch (err) {
      console.error('[insertDraftQuotations] อ่านใบกลับหลังปรับค่าขนส่งไม่สำเร็จ — ใช้ค่าก่อนปรับ', err);
    }
  }

  const insertedQuotes: any[] = [];
  for (const row of insertedRaw) {
    insertedQuotes.push(await enrichQuotationData(row));
  }
  return insertedQuotes;
}

/**
 * ค้นหาข้อมูลสินค้าจากรหัสสินค้า (Product Code)
 */
export async function getProductInfo(code: string, executor: DbExecutor = pool): Promise<any> {
  try {
    const { rows } = await executor.query(`
      SELECT 
        model AS code, 
        name, 
        brand, 
        series, 
        production, 
        product_template_id
      FROM products
      WHERE model = $1
      ORDER BY actual_quantity DESC
      LIMIT 1
    `, [code]);
    return rows[0] || null;
  } catch (err) {
    console.error(`Error fetching product info for code ${code}:`, err);
    return null;
  }
}

/**
 * ค้นหาข้อมูลสินค้าและตรวจสอบว่ามีสินค้าใดติดกฎล็อกเสนอราคา (is_locked) หรือไม่
 */
export async function getBlockedProductError(items: any[] | null): Promise<string | null> {
  if (!items || items.length === 0) return null;

  let rules: any[] = [];
  try {
    rules = await loadQuotationRules();
  } catch (err) {
    console.error('Error fetching quotation rules for blocking validation:', err);
    return null;
  }

  if (!rules.some((r: any) => r.is_locked === true)) return null;

  for (const item of items) {
    const code = item.product_code || item.model || item.code;
    if (!code) continue;

    const prod = await getProductInfo(code);
    if (!prod) continue;

    const matchedRule = findBlockingRule(rules as any, normalizeProductScope(prod));
    if (matchedRule) {
      return buildBlockedMessage(matchedRule, prod.code);
    }
  }

  return null;
}

export interface MoqViolation {
  type: 'MOQ_VIOLATION';
  model: string;
  name: string;
  qty: number;
  min_order_qty: number;
  warn_msg: string;
}

export async function checkMinOrderQty(
  items: any[] | null
): Promise<MoqViolation[]> {
  if (!items || items.length === 0) return [];

  const productIds = items
    .map(i => i.product_template_id ?? i.product_id)
    .filter(Boolean);

  if (!productIds.length) return [];

  const { rows } = await pool.query(`
    SELECT
      p.product_template_id AS product_id,
      pmr.min_order_qty,
      pmr.sale_line_warn_msg,
      p.model,
      p.name
    FROM product_moq_rules pmr
    JOIN products p ON p.internal_reference = pmr.internal_reference
    WHERE p.product_template_id = ANY($1)
      AND pmr.is_active = true
  `, [productIds]);

  if (!rows.length) return [];

  const ruleMap = new Map(rows.map((r: any) => [r.product_id, r]));
  const violations: MoqViolation[] = [];

  for (const item of items) {
    const pid = item.product_template_id ?? item.product_id;
    const rule = ruleMap.get(pid);
    if (!rule) continue;

    const qty = item.qty ?? item.quantity ?? 0;
    if (qty >= rule.min_order_qty) continue;

    violations.push({
      type: 'MOQ_VIOLATION' as const,
      model: rule.model,
      name: rule.name,
      qty,
      min_order_qty: rule.min_order_qty,
      warn_msg: rule.sale_line_warn_msg,
    });
  }

  return violations;
}

export interface MinPriceViolation {
  type: 'MIN_PRICE_VIOLATION';
  model: string;
  price: number;      // ราคาต่อหน่วยหลังหักส่วนลดแล้ว
  min_price: number;  // minimum_sales_price ของสินค้า
  warn_msg: string;
}

/**
 * ตรวจว่าราคาหลังหักส่วนลดของทุกบรรทัด >= minimum_sales_price ของสินค้านั้น
 * ยกเว้นเข้าเงื่อนไขโปรโมชันที่ active อยู่ (validateProductPriceWithPromotions)
 *
 * ⚠️ เป็นจุดเดียวของกฎ "ห้ามขายต่ำกว่าราคาขั้นต่ำ" — ใช้ทั้งตอนบันทึกจาก LIFF (PUT /api/quotation/:id)
 * และตอนยืนยันออกเอกสาร (POST /api/quotation/:id/confirm, postback action=confirm)
 * ห้ามก๊อปตรรกะนี้ไปเขียนซ้ำที่อื่น ไม่งั้นกฎจะเพี้ยนกันคนละที่
 *
 * โยน error เมื่อดึงราคาขั้นต่ำไม่ได้ (fail-closed — ห้ามปล่อยผ่านทั้งที่ยังไม่ได้ตรวจ)
 * ส่วนข้อมูลลูกค้า/โปรโมชันถ้าดึงไม่ได้จะถือว่าไม่มีโปรโมชันช่วย (เข้มไว้ก่อน)
 */
export async function checkMinSalesPrice(
  items: any[] | null,
  customerName?: string | null
): Promise<MinPriceViolation[]> {
  if (!items || items.length === 0) return [];

  const productCodes = items.map((item: any) => item.model || item.product_code).filter(Boolean);
  if (productCodes.length === 0) return [];

  const prodRes = await pool.query(
    'SELECT model AS code, minimum_sales_price FROM products WHERE model = ANY($1)',
    [productCodes]
  );
  const minPriceMap: Record<string, number> = {};
  prodRes.rows.forEach((p: any) => {
    minPriceMap[p.code] = parseFloat(p.minimum_sales_price) || 0;
  });

  // ชื่อบริษัทใช้เช็คสิทธิ์โปรโมชัน (customer_type / reference)
  let companyName = (customerName || '').trim();
  if (companyName.includes(' | ')) {
    companyName = companyName.split(' | ')[0].trim();
  }

  let customerData = null;
  if (companyName) {
    try {
      const custRes = await pool.query(
        `SELECT DISTINCT ON (company_id) customer_type, customer_reference AS reference
         FROM customers_data_view WHERE customer_name = $1 ORDER BY company_id, contact_id LIMIT 1`,
        [companyName]
      );
      if (custRes.rows.length > 0) {
        customerData = {
          customer_type: custRes.rows[0].customer_type,
          reference: custRes.rows[0].reference
        };
      }
    } catch (err) {
      console.error('[checkMinSalesPrice] fetch customer error:', err);
    }
  }

  let activePromos: any[] = [];
  try {
    const promoRes = await pool.query('SELECT * FROM promotions WHERE is_active = true');
    activePromos = promoRes.rows;
  } catch (err) {
    console.error('[checkMinSalesPrice] fetch promotions error:', err);
  }

  const violations: MinPriceViolation[] = [];
  for (const item of items) {
    const itemKey = item.model || item.product_code;
    if (!itemKey) continue;
    const minPrice = minPriceMap[itemKey] || 0;
    if (minPrice <= 0) continue;

    const discountedPrice = calcNetPrice(item.price, item.discount_1, item.discount_2);
    if (discountedPrice >= minPrice - 0.01) continue;

    // ไม่ผ่านขั้นต่ำปกติ → ยังผ่านได้ถ้าเข้าเงื่อนไขโปรโมชัน
    const promoResult = validateProductPriceWithPromotions(
      itemKey,
      item.quantity || 1,
      discountedPrice,
      minPrice,
      customerData,
      activePromos
    );
    if (promoResult.allowed) continue;

    violations.push({
      type: 'MIN_PRICE_VIOLATION',
      model: itemKey,
      price: discountedPrice,
      min_price: minPrice,
      warn_msg: `ราคาหลังลด ฿${discountedPrice.toFixed(2)} ต่ำกว่าขั้นต่ำ ฿${minPrice.toFixed(2)} และไม่เข้าเงื่อนไขโปรโมชัน`
    });
  }

  return violations;
}

export type ValidationError = StockViolation | MoqViolation;

export async function validateAndPrepareItems(items: any[] | null): Promise<{
  items: any[];
  errors: ValidationError[];
}> {
  if (!items || items.length === 0) {
    return { items: [], errors: [] };
  }

  // Step 1: Expand optional products (F2)
  const expanded = await expandOptionalProducts(items);

  // Step 2: Check stock rules (F4)
  const stockErrors = await checkStockRules(expanded);

  // Step 3: Check MOQ (F3)
  const moqErrors = await checkMinOrderQty(expanded);

  const errors: ValidationError[] = [...stockErrors, ...moqErrors];

  return { items: expanded, errors };
}

export async function processQuotationRequest(userId: string, rawCustomerQuery: string, rawContactQuery: string, itemsForDb: any[] | null, salesperson: any): Promise<any> {
  const blockedError = await getBlockedProductError(itemsForDb);
  if (blockedError) {
    return { text: blockedError };
  }

  // เรียกใช้ Validation Pipeline (F2, F3, F4)
  const { items: expanded, errors } = await validateAndPrepareItems(itemsForDb);
  if (errors && errors.length > 0) {
    const stockErrors = errors.filter(e => e.type === 'OUT_OF_STOCK');
    const moqErrors = errors.filter(e => e.type === 'MOQ_VIOLATION');
    
    let errorText = '❌ ระงับการเสนอราคา ตามเงื่อนไขด้านล่าง\nกรุณาแก้ไข หรือติดต่อแอดมิน\n\n';
    
    if (stockErrors.length > 0) {
      errorText += '📦 สินค้านี้ถูกระงับเมื่อไม่มีสต็อก:\n';
      stockErrors.forEach(e => {
        if (e.is_optional && e.linked_to_model) {
          errorText += ` - [${e.model}] (สินค้าเสริมของ ${e.linked_to_model}): ${e.warn_msg}\n`;
        } else {
          errorText += ` - [${e.model}]: ${e.warn_msg}\n`;
        }
      });
      errorText += '\n';
    }
    
    if (moqErrors.length > 0) {
      errorText += '⬇️ จำนวนไม่ถึงขั้นต่ำ (MOQ):\n';
      moqErrors.forEach(e => {
        errorText += ` - [${e.model}]: ${e.warn_msg}\n`;
      });
    }
    
    return { text: errorText.trim() };
  }

  let cleanCust = String(rawCustomerQuery || '').trim();
  let cleanCont = String(rawContactQuery || '').trim();

  // Backstop: ลูกค้า+ผู้ติดต่อพิมพ์มาบรรทัด/ก้อนเดียว เช่น "บ.เคยู  คุณจิตติพงษ์" —
  // แยกส่วน คุณY ออกเป็น contact เฉพาะเมื่อยังไม่มี contact query (AI prompt rule 14 เป็นด่านแรก นี่คือด่านกันเหนียว)
  if (cleanCust && !cleanCont) {
    const split = splitCustomerContact(cleanCust);
    if (split.contact) {
      console.log(`[processQuotationRequest] split same-line customer/contact: "${split.customer}" + "${split.contact}"`);
      cleanCust = split.customer;
      cleanCont = split.contact;
    }
  }

  if (!cleanCust && !cleanCont) {
    return { text: "รบกวนระบุชื่อบริษัท/ลูกค้า และชื่อผู้ติดต่อด้วยครับ 🏢👤" };
  }

  // Case 1: No company query provided, only contact query (e.g. cleanCont = "อธิชาต")
  if (!cleanCust) {
    const rawName = ` | ${cleanCont}`;
    const insertedQuotes = await insertDraftQuotations(userId, rawName, expanded, 'pending_company');
    if (!insertedQuotes || insertedQuotes.length === 0) {
      return { text: "❌ ไม่สามารถบันทึกข้อมูลใบเสนอราคาได้" };
    }
    return { text: "รบกวนระบุชื่อบริษัท/ลูกค้าด้วยครับ 🏢" };
  }

  // Find customer candidates
  const customerCandidates = await findCustomerCandidates(cleanCust, salesperson, cleanCont);

  // Case 2: No customer candidates found
  if (customerCandidates.length === 0) {
    // Try to see if this represents a contact query in the database instead
    const customerCandidatesFromContact = await findCustomerByContactName(cleanCust, salesperson);

    if (customerCandidatesFromContact.length === 1 && customerCandidatesFromContact[0].score < 0.45) {
      // Automatically match!
      const selectedCompany = customerCandidatesFromContact[0].display_name;
      const selectedCustomerId = customerCandidatesFromContact[0].id;
      const matchedContactName = customerCandidatesFromContact[0].contact_name;

      return await resolveContactFlow(userId, null, selectedCustomerId, selectedCompany, matchedContactName, expanded, salesperson);
    }

    if (customerCandidatesFromContact.length > 1) {
      // Ambiguous contact matches across multiple companies
      const rawName = ` | ${cleanCust}`; // Save cleanCust as contact query
      const insertedQuotes = await insertDraftQuotations(userId, rawName, expanded, 'pending_company');
      if (!insertedQuotes || insertedQuotes.length === 0) {
        return { text: "❌ ไม่สามารถบันทึกข้อมูลใบเสนอราคาได้" };
      }

      return createListFlexMessage(
        "🏢 เลือกบริษัทที่ต้องการเสนอราคา",
        `พบผู้ติดต่อชื่อ "${cleanCust}" ในหลายบริษัทดังนี้ครับ กรุณาเลือกบริษัทที่ต้องการเสนอราคาครับ 👇`,
        customerCandidatesFromContact.slice(0, 12).map((c: any) => ({
          label: formatLineLabel(c.display_name),
          data: `action=select_company&custId=${c.id}`,
          displayText: `เลือก ${c.display_name}`
        }))
      );
    }

    // Fallback: Save as pending company query
    const rawName = `${cleanCust} | ${cleanCont}`;
    const insertedQuotes = await insertDraftQuotations(userId, rawName, expanded, 'pending_company');
    if (!insertedQuotes || insertedQuotes.length === 0) {
      return { text: "❌ ไม่สามารถบันทึกข้อมูลใบเสนอราคาได้" };
    }
    return createUnregisteredCustomerFlex(cleanCust, insertedQuotes.map((q: any) => q.id).join(','), userId);
  }

  // Case 3: Multiple customer candidates found
  if (customerCandidates.length > 1) {
    // Auto-select if the top candidate is a clear winner (exact/reference/contains match)
    const topScore = customerCandidates[0].score;
    const secondScore = customerCandidates[1].score;
    console.log('[processQuotationRequest] Top candidate:', customerCandidates[0].item.display_name, 'score:', topScore, '| 2nd:', customerCandidates[1].item.display_name, 'score:', secondScore);
    if (topScore <= 0.05 && (secondScore - topScore) > 0.05) {
      console.log('[processQuotationRequest] Auto-selected:', customerCandidates[0].item.display_name);
      const selectedCompany = customerCandidates[0].item.display_name;
      const selectedCustomerId = customerCandidates[0].item.id;
      return await resolveContactFlow(userId, null, selectedCustomerId, selectedCompany, cleanCont, expanded, salesperson);
    }

    const rawName = `${cleanCust} | ${cleanCont}`;
    const insertedQuotes = await insertDraftQuotations(userId, rawName, expanded, 'pending_company');
    if (!insertedQuotes || insertedQuotes.length === 0) {
      return { text: "❌ ไม่สามารถบันทึกข้อมูลใบเสนอราคาได้" };
    }

    return createListFlexMessage(
      "🏢 เลือกบริษัทที่ถูกต้อง",
      `พบชื่อบริษัทใกล้เคียงกับ "${cleanCust}" หลายบริษัทเลยครับ กรุณาเลือกบริษัทที่ถูกต้องด้านล่างนี้ครับ 👇`,
      customerCandidates.slice(0, 12).map((c: any) => ({
        label: formatLineLabel(c.item.display_name),
        data: `action=select_company&custId=${c.item.id}`,
        displayText: `เลือก ${c.item.display_name}`
      }))
    );
  }

  // Case 4: Exactly one customer candidate found
  const selectedCompany = customerCandidates[0].item.display_name;
  const selectedCustomerId = customerCandidates[0].item.id;

  return await resolveContactFlow(userId, null, selectedCustomerId, selectedCompany, cleanCont, expanded, salesperson);
}

export async function resolveContactFlow(
  userId: string,
  existingQuoteIdsStr: string | null,
  customerId: any,
  companyName: string,
  contactQuery: string,
  itemsForDb: any[] | null,
  salesperson: any
): Promise<any> {
  const contactCandidates = await findContactCandidates(customerId, contactQuery);

  // ค้นหาผู้ติดต่อที่ชื่อตรงเป๊ะ (Exact Match) หลังทำความสะอาดชื่อ (ตัดคำนำหน้าออก)
  const exactMatch = contactCandidates.find((c: any) => {
    const nameA = cleanContactName(c.item.name);
    const nameB = cleanContactName(contactQuery);
    return nameA && nameB && nameA.toLowerCase() === nameB.toLowerCase();
  });

  let finalCandidates = contactCandidates;
  if (exactMatch) {
    // หากเจอสะกดตรงเป๊ะ ให้บังคับใช้คนนี้เป็น candidate หลักคนเดียวทันที
    finalCandidates = [{
      ...exactMatch,
      score: 0 // บังคับ score เป็น 0 เพื่อให้ผ่าน auto-match
    }];
  }

  if (finalCandidates.length === 1 && finalCandidates[0].score < 0.45) {
    const matchedContactName = finalCandidates[0].item.name;
    const contactId = finalCandidates[0].item.id;
    const finalCustomerName = `${companyName} | ${matchedContactName}`;

    let quotes;
    if (existingQuoteIdsStr) {
      const ids = existingQuoteIdsStr.split(',').filter(Boolean);
      quotes = await updateQuotationCustomerSnapshot(ids, finalCustomerName, 'draft', salesperson, customerId, contactId);
    } else {
      quotes = await insertDraftQuotations(userId, finalCustomerName, itemsForDb, 'draft', customerId, contactId);
    }

    if (!quotes || quotes.length === 0) {
      return { text: "❌ ไม่สามารถบันทึกข้อมูลใบเสนอราคาได้" };
    }

    return {
      success: true,
      quotes: quotes
    };
  }

  let quoteIdsStr = existingQuoteIdsStr;
  if (!quoteIdsStr) {
    const rawName = `${companyName} | ${contactQuery}`;
    const insertedQuotes = await insertDraftQuotations(userId, rawName, itemsForDb, 'pending_contact', customerId, null);
    if (!insertedQuotes || insertedQuotes.length === 0) {
      return { text: "❌ ไม่สามารถบันทึกข้อมูลใบเสนอราคาได้" };
    }
    quoteIdsStr = insertedQuotes.map((q: any) => q.id).join(',');
  } else {
    const ids = quoteIdsStr.split(',').filter(Boolean);
    const customerDetailsTemp = {
      customer_name: `${companyName} | ${contactQuery}`,
      customer_code: '',
      customer_tax_id: '',
      contact_name: contactQuery || '-',
      phone: '-',
      email: '-',
      address: '-',
      payment_terms: '-',
      revise_from: null,
      custom_meta: ''
    };
    
    try {
      const compRes = await pool.query(
        `SELECT DISTINCT ON (company_id) customer_reference AS reference, customer_tax_id AS tax_id, customer_payment_terms AS payment_terms
         FROM customers_data_view WHERE TRIM(customer_name) = TRIM($1) ORDER BY company_id, contact_id LIMIT 1`,
        [companyName]
      );
      if (compRes.rows.length > 0) {
        const row = compRes.rows[0];
        customerDetailsTemp.customer_code = row.reference || '';
        customerDetailsTemp.customer_tax_id = row.tax_id || '';
        customerDetailsTemp.payment_terms = row.payment_terms || '-';
      }
    } catch (err) {
      console.error("Error fetching temp customer in resolveContactFlow:", err);
    }

    try {
      await pool.query(
        `UPDATE quotations 
         SET customer_details = $1, 
             status = 'pending_contact',
             customer_id = $2,
             contact_id = NULL,
             updated_at = NOW()
         WHERE id = ANY($3)`,
        [JSON.stringify(customerDetailsTemp), customerId, ids]
      );
    } catch (err) {
      console.error("Error updating temp contact status in resolveContactFlow:", err);
    }
  }

  const options: any[] = [];

  if (contactCandidates.length > 0) {
    contactCandidates.slice(0, 11).forEach((c: any) => {
      options.push({
        label: c.item.name.substring(0, 30),
        data: `action=select_contact&contactId=${c.item.id}`,
        displayText: `เลือกผู้ติดต่อ: ${c.item.name}`
      });
    });
  }

  // ไม่เพิ่มปุ่ม ใช้ชื่อ (Custom Contact Name) ตามคำสั่งของบริษัท เพื่อจำกัดให้เลือกเฉพาะที่มีอยู่ในฐานข้อมูลเท่านั้น

  let responseText = '';
  if (!contactQuery) {
    if (contactCandidates.length > 0) {
      responseText = `กรุณาเลือกผู้ติดต่อสำหรับบริษัท "${companyName}" จากรายการด้านล่างนี้ได้เลยครับ 👇`;
    } else {
      responseText = `ไม่พบข้อมูลผู้ติดต่อสำหรับบริษัท "${companyName}" ในระบบ\n\nรบกวนติดต่อแอดมินเพื่อเพิ่มข้อมูล หรือพิมพ์ "ยกเลิก" เพื่อยกเลิกใบเสนอราคาครับ`;
    }
  } else {
    if (contactCandidates.length > 0) {
      responseText = `ไม่พบชื่อผู้ติดต่อ "${contactQuery}" ที่ตรงกับฐานข้อมูลของบริษัท "${companyName}" ครับ\n\nกรุณาเลือกรายชื่อผู้ติดต่อจากรายการด้านล่างนี้ หรือติดต่อแอดมินเพื่อเพิ่มข้อมูลก่อนนะครับ 👇`;
    } else {
      responseText = `ไม่พบชื่อผู้ติดต่อ "${contactQuery}" ที่ตรงกับฐานข้อมูลของบริษัท "${companyName}" ในฐานข้อมูลครับ\n\nรบกวนติดต่อแอดมินเพื่อเพิ่มข้อมูลก่อนนะครับ`;
    }
  }

  if (options.length > 0) {
    return createListFlexMessage(
      "👤 เลือกผู้ติดต่อ",
      responseText,
      options
    );
  }

  return {
    text: responseText
  };
}

export async function updateQuotationCustomerSnapshot(
  quoteIds: string[],
  finalCustomerName: string,
  status: string,
  salesperson: any,
  customerId?: number | null,
  contactId?: number | null
): Promise<any[]> {
  const parts = finalCustomerName.split(' | ');
  const companyName = parts[0] ? parts[0].trim() : '';
  const contactName = parts[1] ? parts[1].trim() : '';
  const metaStr = parts[2] || '';

  const customerDetails: any = {
    customer_name: companyName || null,
    customer_code: '',
    customer_tax_id: '',
    contact_name: contactName || null,
    phone: null,
    email: null,
    address: null,
    payment_terms: null,
    revise_from: null,
    custom_meta: metaStr
  };

  if (metaStr) {
    try {
      const params = new URLSearchParams(metaStr);
      customerDetails.phone = params.get('phone') || null;
      customerDetails.email = params.get('email') || null;
      customerDetails.address = params.get('address') || null;
      customerDetails.customer_tax_id = params.get('tax_id') || '';
      customerDetails.revise_from = params.get('revise_from') as any || null;
    } catch (e) {
      console.warn(`[updateQuotationCustomerSnapshot] parse metadata ไม่สำเร็จ meta="${metaStr}"`, e);
    }
  }

  try {
    let custRes = null;

    // 1. ถ้ามี ID ส่งมา ให้ดึงข้อมูลตรงจาก ID ผ่าน customers_data_view (บริษัท+ผู้ติดต่ออยู่แถวเดียวกัน ไม่ต้อง JOIN)
    if (customerId) {
      if (contactId) {
        custRes = await pool.query(
          `SELECT customer_reference AS reference, customer_tax_id AS tax_id, customer_payment_terms AS payment_terms,
                  COALESCE(contact_phone, phone) AS contact_phone, COALESCE(contact_email, email) AS contact_email,
                  invoice_street AS contact_address,
                  invoice_district, invoice_sub_district, invoice_state, invoice_zip
           FROM customers_data_view
           WHERE company_id = $1 AND contact_id = $2 LIMIT 1`,
          [customerId, contactId]
        );
      }
      if (!custRes || custRes.rows.length === 0) {
        custRes = await pool.query(
          `SELECT DISTINCT ON (company_id) customer_reference AS reference, customer_tax_id AS tax_id,
                  customer_payment_terms AS payment_terms
           FROM customers_data_view
           WHERE company_id = $1 ORDER BY company_id, contact_id LIMIT 1`,
          [customerId]
        );
      }
    }

    // 2. Fallback: ค้นหาด้วยชื่อแบบ TRIM เพื่อป้องกันสะกดสลับแถวหรือมีช่องว่างต่อท้าย
    if (!custRes || custRes.rows.length === 0) {
      custRes = await pool.query(
        `SELECT customer_reference AS reference, customer_tax_id AS tax_id, customer_payment_terms AS payment_terms,
                COALESCE(contact_phone, phone) AS contact_phone, COALESCE(contact_email, email) AS contact_email,
                invoice_street AS contact_address,
                invoice_district, invoice_sub_district, invoice_state, invoice_zip
         FROM customers_data_view
         WHERE TRIM(customer_name) = TRIM($1) AND TRIM(contact_name) = TRIM($2) LIMIT 1`,
        [companyName, contactName]
      );
    }
    if (!custRes || custRes.rows.length === 0) {
      custRes = await pool.query(
        `SELECT DISTINCT ON (company_id) customer_reference AS reference, customer_tax_id AS tax_id,
                customer_payment_terms AS payment_terms
         FROM customers_data_view WHERE TRIM(customer_name) = TRIM($1) ORDER BY company_id, contact_id LIMIT 1`,
        [companyName]
      );
    }

    if (custRes && custRes.rows.length > 0) {
      const row = custRes.rows[0];
      if (row.reference) customerDetails.customer_code = row.reference;
      if (row.tax_id && !customerDetails.customer_tax_id) customerDetails.customer_tax_id = row.tax_id;
      if (row.contact_phone && !customerDetails.phone) customerDetails.phone = row.contact_phone;
      if (row.contact_email && !customerDetails.email) customerDetails.email = row.contact_email;
      if (row.contact_address && !customerDetails.address) {
        const stateCleaned = cleanState(row.invoice_state);
        const districtCleaned = cleanAddressField(row.invoice_district, row.invoice_state, row.invoice_zip);
        const subDistrictCleaned = cleanAddressField(row.invoice_sub_district, row.invoice_state, row.invoice_zip);
        const fullAddr = [row.contact_address, districtCleaned, subDistrictCleaned, stateCleaned, row.invoice_zip]
          .map((s: any) => String(s || '').trim()).filter(Boolean).join(' ');
        if (fullAddr) customerDetails.address = fullAddr;
      }
      if (row.payment_terms) customerDetails.payment_terms = row.payment_terms;
    }
  } catch (err) {
    console.error("Error updating customer snapshot in helper:", err);
  }

  const employeeDetails = {
    salesperson_id: salesperson.salesperson_id || null,
    saleperson: salesperson.name || '',
    sale_phone: salesperson.phone || ''
  };

  await pool.query(
    `UPDATE quotations 
     SET customer_details = $1, 
         employee_details = $2, 
         salesperson_id = $3,
         status = $4,
         customer_id = $5,
         contact_id = $6,
         updated_at = NOW()
     WHERE id = ANY($7)`,
    [JSON.stringify(customerDetails), JSON.stringify(employeeDetails), salesperson.salesperson_id || null, status, customerId || null, contactId || null, quoteIds]
  );

  const selectRes = await pool.query(
    `SELECT * FROM quotations WHERE id = ANY($1)`,
    [quoteIds]
  );
  
  const enrichPromises = selectRes.rows.map(q => enrichQuotationData(q));
  return await Promise.all(enrichPromises);
}

export async function cancelOldRevision(customerName: string, executor: DbExecutor = pool): Promise<void> {
  // เมื่อถูกเรียกภายใน transaction (executor เป็น client) ต้องโยน error ออกไปให้ caller rollback
  // ไม่งั้น transaction จะ commit ทั้งที่ยกเลิกใบเก่าไม่สำเร็จ
  const inTransaction = executor !== pool;

  if (!customerName || !customerName.includes(' | ')) return;
  const parts = customerName.split(' | ');
  if (!parts[2]) return;

  let reviseFrom: string | null = null;
  try {
    const meta = Object.fromEntries(new URLSearchParams(parts[2]));
    reviseFrom = meta.revise_from || null;
  } catch (err) {
    console.error("[cancelOldRevision] Error parsing customer metadata for cancellation:", err);
    if (inTransaction) throw err;
    return;
  }

  if (!reviseFrom) return;

  console.log(`[cancelOldRevision] Attempting to cancel old quotation with quotation_no: ${reviseFrom}`);
  try {
    // ตั้งใจยกเลิกใบเก่าที่ confirmed อยู่ (revise = ออกใบใหม่แทนใบเดิม) quotation_no ไม่ซ้ำอยู่แล้ว
    // จึงไม่ต้องมี status guard — การใส่ AND status <> 'confirmed' จะทำให้ไม่ยกเลิกใบเก่าเลย
    await executor.query(
      "UPDATE quotations SET status = 'cancelled' WHERE quotation_no = $1",
      [reviseFrom]
    );
    console.log(`[cancelOldRevision] Successfully cancelled old quotation: ${reviseFrom}`);
  } catch (err) {
    console.error(`[cancelOldRevision] Error cancelling old quotation ${reviseFrom}:`, err);
    if (inTransaction) throw err;
  }
}

// Helper to enrich quotation data with full customer and contact information from database/snapshots
export async function enrichQuotationData(quoteDb: any): Promise<any> {
  if (!quoteDb) return null;

  const customerDetails = quoteDb.customer_details;
  const itemDetails = quoteDb.item_details;
  const employeeDetails = quoteDb.employee_details;
  const salespersonId = quoteDb.salesperson_id;
  const customerIdFromDb = quoteDb.customer_id;
  const contactIdFromDb = quoteDb.contact_id;

  // 1. หากข้อมูล Snapshot ครบถ้วนแล้ว ให้อ่านและส่งออกได้ทันทีโดยไม่ต้อง Query ตารางหลัก
  if (customerDetails && itemDetails && employeeDetails) {
    // Snapshot ควรเก็บเฉพาะชื่อบริษัท แต่ข้อมูลเก่าอาจปนเปื้อนเป็น "company | contact" — split กันเหนียว
    // ยังไม่ได้ผูกลูกค้า = ค่าว่าง (null ใน DB) ไม่มีการเติมชื่อ default ให้อีกแล้ว
    const rawCustomerName = customerDetails.customer_name || '';
    const companyName = rawCustomerName.split(' | ')[0].trim();
    const contactName = customerDetails.contact_name || '';

    // จัด format customer_name เก่าเพื่อส่งกลับไปให้ frontend
    let oldCustomerNameFormat = companyName;
    if (contactName) {
      oldCustomerNameFormat += ` | ${contactName}`;
    }

    const reviseFrom = customerDetails.revise_from || null;
    const customMetaStr = customerDetails.custom_meta || '';
    if (customMetaStr) {
      oldCustomerNameFormat += ` | ${customMetaStr}`;
    }

    // ดึง customer_id จริงจากระบบ
    let customerId = customerIdFromDb || null;
    if (!customerId && companyName) {
      try {
        const custRes = await pool.query(
          `SELECT DISTINCT ON (company_id) company_id AS id
           FROM customers_data_view WHERE customer_name = $1 ORDER BY company_id, contact_id LIMIT 1`,
          [companyName]
        );
        if (custRes.rows.length > 0) {
          customerId = custRes.rows[0].id;
        }
      } catch (err) {
        console.error("Error fetching customer_id for enrichment:", err);
      }
    }

    // หาสังกัดบริษัท (PM หรือ THT) โดยใช้ resolveQuoteCompany ที่เช็คจาก quotation_rules
    let quoteCompany: 'PM' | 'THT' = 'PM';
    if (itemDetails.length > 0) {
      try {
        quoteCompany = await resolveQuoteCompany(itemDetails[0]);
      } catch (err) {
        console.error("Error resolving quote company in enrichQuotationData:", err);
        quoteCompany = 'PM';
      }
    } else {
      quoteCompany = quoteDb.quotation_no?.toUpperCase()?.startsWith('QT') ? 'THT' : 'PM';
    }

    // ดึงสต๊อกสด (actual_quantity) จากตารางสินค้า เพื่อให้คำเตือน "สินค้าคงเหลือ" ใน PDF
    // ตรงกับที่แสดงใน flex message — snapshot ไม่ได้เก็บ stock ไว้ จึงต้อง query สดตอน enrich
    const stockMap: Record<string, number> = {};
    const stockKeys = itemDetails
      .map((item: any) => item.model || item.internal_reference)
      .filter(Boolean);
    if (stockKeys.length > 0) {
      try {
        const { rows: stockRows } = await pool.query(
          `SELECT model AS code, actual_quantity AS stock
             FROM products
            WHERE model = ANY($1)`,
          [stockKeys]
        );
        stockRows.forEach((p: any) => {
          const s = p.stock !== undefined && p.stock !== null ? Number(p.stock) : 0;
          // เผื่อมีหลายแถวชื่อ model เดียวกัน ให้ใช้สต๊อกสูงสุด (เหมือน ORDER BY actual_quantity DESC)
          if (stockMap[p.code] === undefined || s > stockMap[p.code]) {
            stockMap[p.code] = s;
          }
        });
      } catch (err) {
        console.error('Error fetching live stock for snapshot enrichment:', err);
      }
    }

    // ค่าขนส่งใช้ config ตัวเดียวกับฝั่งเขียน — is_shipping_fee ที่ส่งออกไปเป็นค่า "คำนวณสด"
    // ทุกครั้ง ไม่ใช่ field ที่เก็บไว้ จึงไม่ต้องพึ่ง whitelist ด้านล่างในการเดินทางกลับ
    const { isShippingFeeItem: isShippingFeeLine, loadShippingFeeConfig: loadShippingCfg } =
      await import('./shippingFee.js');
    const shippingCfgForEnrich = await loadShippingCfg();

    // จัดระเบียบ items เพื่อความเข้ากันได้ย้อนหลังกับ Frontend
    //
    // ⚠️ นี่เป็น whitelist — field ที่ไม่อยู่ในลิสต์นี้จะหายตอน round-trip ผ่าน LIFF editor
    // เกณฑ์ว่าต้องเพิ่มหรือไม่:
    //   - field ที่ buildItemSnapshots() คำนวณใหม่ได้เอง (warranty_display, delivery_*_days,
    //     delivery_source) → ไม่ต้องเพิ่ม เพราะ input ของมัน (quantity, production/brand/series)
    //     อยู่ในลิสต์นี้แล้ว หายไปก็สร้างใหม่ได้ค่าเดิม
    //   - field ที่เป็นข้อเท็จจริงของบรรทัดนั้นเองและสร้างใหม่ไม่ได้ → **ต้องเพิ่ม**
    //     ไม่งั้นข้อมูลหายถาวร (ตัวอย่าง: name ของบรรทัดค่าขนส่งที่เซลล์ตั้งเอง — มีในลิสต์แล้ว)
    const legacyItems = itemDetails.map((item: any) => {
      const stockKey = item.model || item.internal_reference;
      const liveStock = stockKey !== undefined && stockMap[stockKey] !== undefined
        ? stockMap[stockKey]
        : (item.stock !== undefined ? item.stock : 0);
      return {
        product_id: item.product_id,
        model: item.model || item.internal_reference,
        product_code: item.model || item.internal_reference,
        name: item.name,
        // ธงสำหรับฝั่งแสดงผล (LIFF / PDF / Flex) — ล็อกช่องจำนวน ซ่อนปุ่มลบ ซ่อนสถานะสต๊อก
        is_shipping_fee: isShippingFeeLine(item, shippingCfgForEnrich),
        sales_description: item.sales_description || '',
        price: item.price,
        quantity: item.quantity,
        discount_1: item.discount_1 || 0,
        discount_2: item.discount_2 || 0,
        remark: item.remark || '',
        brand: item.brand || '',
        series: item.series || '',
        production: item.production || '',
        stock: liveStock,
        is_optional: !!item.is_optional,
        linked_to_product_id: item.linked_to_product_id || null
      };
    });

    // วันจัดส่งที่ระบบคำนวณได้ — ส่งไปให้หน้า LIFF โชว์เป็นค่าตั้งต้น/ค่าอ้างอิงคู่กับ
    // delivery_days_override (มาจาก ...quoteDb) ที่เซลล์ตั้งทับไว้
    const deliverySummary = resolveQuotationDeliveryDays(legacyItems, itemDetails);

    return {
      ...quoteDb,
      delivery_days_auto: deliverySummary.days,
      delivery_all_in_stock: deliverySummary.all_in_stock,
      customer_id: customerId,
      contact_id: contactIdFromDb || null,
      customer_name: oldCustomerNameFormat,
      company_name: companyName,
      customer_code: customerDetails.customer_code || '',
      customer_tax_id: customerDetails.customer_tax_id || '',
      contact_name: contactName,
      contact_phone: customerDetails.phone || '',
      contact_email: customerDetails.email || '',
      contact_address: customerDetails.address || '',
      delivery_address: customerDetails.address || '',
      payment_terms: customerDetails.payment_terms || '',
      salesperson_name: employeeDetails.saleperson || '',
      salesperson_phone: employeeDetails.sale_phone || '',
      salesperson_employee_code: salespersonId || null,
      items: legacyItems,
      revise_from: reviseFrom,
      quote_company: quoteCompany
    };
  }

  // 2. Fallback: หากไม่มีข้อมูล Snapshot (ใบเสนอราคาตกหล่น หรือขั้นตอนแรก) ให้ใช้การ Query ตารางหลักแบบเดิม
  let customerCode = '';
  let customerTaxId = '';
  let contactName = '';
  let contactPhone = '';
  let contactEmail = '';
  let contactAddress = '';
  let deliveryAddress = '';
  let customerId = null;

  let companyName = (quoteDb.customer_name || '').trim();
  let contactNameQuery = '';
  let customMeta: any = {};
  let paymentTerms = '';

  if (quoteDb.customer_name && quoteDb.customer_name.includes(' | ')) {
    const parts = quoteDb.customer_name.split(' | ');
    companyName = parts[0].trim();
    contactNameQuery = parts[1].trim();
    if (parts[2]) {
      try {
        const metaStr = parts.slice(2).join(' | ').trim();
        customMeta = Object.fromEntries(new URLSearchParams(metaStr));
      } catch (err) {
        console.error("Error parsing custom metadata:", err);
      }
    }
  }

  if (companyName) {
    try {
      const custData = await getCustomerByDisplayName(companyName);

      if (custData) {
        customerId = custData.id;
        customerCode = custData.reference || '';
        customerTaxId = custData.tax_id || '';
        paymentTerms = custData.customer_payment_terms || '';

        const contactData = await getFirstContact(custData.id, contactNameQuery || null);

        if (contactData) {
          contactName = contactData.name || '';
          
          const hasAddr = (contactData.invoice_street && contactData.invoice_street.trim()) || (contactData.invoice_state && contactData.invoice_state.trim());
          let target = contactData;

          if (!hasAddr) {
            const companyRows = await getCompanyAddressRows(custData.id);

            if (companyRows && companyRows.length > 0) {
              target = companyRows.find((r: any) => r.invoice_street && r.invoice_street.trim()) || 
                       companyRows.find((r: any) => r.invoice_state && r.invoice_state.trim()) || 
                       companyRows[0];
            }
          }

          const stateCleaned = cleanState(target.invoice_state);
          const districtCleaned = cleanAddressField(target.invoice_district, target.invoice_state, target.invoice_zip);
          const subDistrictCleaned = cleanAddressField(target.invoice_sub_district, target.invoice_state, target.invoice_zip);

          const addr = [
            target.invoice_street,
            districtCleaned,
            subDistrictCleaned,
            stateCleaned,
            target.invoice_zip
          ].map(s => String(s || '').trim()).filter(Boolean).join(' ');
          contactAddress = addr || '';
          deliveryAddress = addr || '';
        } else if (contactNameQuery) {
          contactName = contactNameQuery;
        }

        let resolvedPhone = '';
        if (contactData) {
          if (contactData.mobile && contactData.mobile.trim()) {
            resolvedPhone = contactData.mobile.trim();
          } else if (contactData.phone && contactData.phone.trim()) {
            resolvedPhone = contactData.phone.trim();
          }
        }

        if (!resolvedPhone) {
          if (custData && custData.phone && custData.phone.trim()) {
            resolvedPhone = custData.phone.trim();
          }
        }
        contactPhone = resolvedPhone;

        const emails = [];
        if (contactData && contactData.email && contactData.email.trim()) {
          emails.push(contactData.email.trim());
        }
        if (custData.email && custData.email.trim()) {
          emails.push(custData.email.trim());
        }
        const uniqueEmails = Array.from(new Set(emails));
        contactEmail = uniqueEmails.length > 0 ? uniqueEmails.join(', ') : '';
      }
    } catch (err) {
      console.error('Error fetching customer/contact metadata fallback:', err);
    }
  }

  if (customMeta) {
    if (customMeta.tax_id) customerTaxId = customMeta.tax_id;
    if (customMeta.phone) contactPhone = customMeta.phone;
    if (customMeta.email) contactEmail = customMeta.email;
    if (customMeta.address) contactAddress = customMeta.address;
    if (customMeta.delivery) deliveryAddress = customMeta.delivery;
    else if (customMeta.address) deliveryAddress = customMeta.address;
  }

  if (contactName === '' && contactNameQuery) {
    contactName = contactNameQuery;
  }

  // Enrich items details
  let enrichedItems = quoteDb.items || [];
  if (Array.isArray(enrichedItems) && enrichedItems.length > 0) {
    const productKeys = enrichedItems.map((item: any) => item.model || item.product_code).filter(Boolean);
    if (productKeys.length > 0) {
      try {
        const { rows: productsData } = await pool.query(
          `SELECT 
             model AS code, 
             actual_quantity AS stock, 
             model, 
             product_sub_category, 
             sales_description, 
             brand, 
             series, 
             production 
           FROM products 
           WHERE model = ANY($1)`,
          [productKeys]
        );

        const stockMap: Record<string, number> = {};
        const modelMap: Record<string, string> = {};
        const subCatMap: Record<string, string> = {};
        const descMap: Record<string, string> = {};
        const brandMap: Record<string, string> = {};
        const seriesMap: Record<string, string> = {};
        const productionMap: Record<string, string> = {};
        
        if (productsData && productsData.length > 0) {
          productsData.forEach((p: any) => {
            const currentStock = stockMap[p.code] || 0;
            const newStock = p.stock !== undefined && p.stock !== null ? p.stock : 0;
            if (newStock > currentStock || stockMap[p.code] === undefined) {
              stockMap[p.code] = newStock;
              modelMap[p.code] = p.model || '';
              subCatMap[p.code] = p.product_sub_category || '';
              descMap[p.code] = p.sales_description || '';
              brandMap[p.code] = p.brand || '';
              seriesMap[p.code] = p.series || '';
              productionMap[p.code] = p.production || '';
            }
          });
        }
        enrichedItems = enrichedItems.map((item: any) => {
          const key = item.model || item.product_code;
          return {
            ...item,
            stock: stockMap[key] !== undefined ? stockMap[key] : 0,
            model: modelMap[key] || '',
            product_sub_category: subCatMap[key] || '',
            sales_description: descMap[key] || '',
            brand: brandMap[key] || '',
            series: seriesMap[key] || '',
            production: productionMap[key] || ''
          };
        });
      } catch (err) {
        console.error('Error enriching items stock fallback:', err);
        enrichedItems = enrichedItems.map((item: any) => ({ ...item, stock: 0, brand: '', series: '', production: '' }));
      }
    }
  }

  let quoteCompany: 'PM' | 'THT' = 'PM';
  try {
    if (enrichedItems && enrichedItems.length > 0) {
      quoteCompany = await resolveQuoteCompany(enrichedItems[0]);
    } else {
      quoteCompany = quoteDb.quotation_no?.toUpperCase()?.startsWith('QT') ? 'THT' : 'PM';
    }
  } catch (err) {
    quoteCompany = quoteDb.quotation_no?.toUpperCase()?.startsWith('QT') ? 'THT' : 'PM';
  }

  // ใบเก่าที่ไม่มี snapshot → ไม่มี delivery_*_days ให้อ่าน helper จึงคืนค่าตั้งต้น 3/7 ตามสถานะสต๊อก
  const deliverySummaryFallback = resolveQuotationDeliveryDays(enrichedItems, quoteDb.item_details);

  return {
    ...quoteDb,
    delivery_days_auto: deliverySummaryFallback.days,
    delivery_all_in_stock: deliverySummaryFallback.all_in_stock,
    customer_id: customerId,
    customer_name: companyName,
    company_name: companyName,
    customer_code: customerCode,
    customer_tax_id: customerTaxId,
    contact_name: contactName,
    contact_phone: contactPhone,
    contact_email: contactEmail,
    contact_address: contactAddress,
    delivery_address: deliveryAddress,
    payment_terms: paymentTerms,
    items: enrichedItems,
    revise_from: customMeta.revise_from || null,
    quote_company: quoteCompany
  };
}
