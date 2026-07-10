import { db } from '../config/clients.js';
import { pool, type DbExecutor } from '../config/db.js';
import { 
  findCustomerCandidates, 
  findContactCandidates, 
  findCustomerByContactName,
  formatLineLabel,
  cleanContactName
} from './customerService.js';
import { 
  createListFlexMessage, 
  createUnregisteredCustomerFlex
} from '../utils/flexTemplates.js';
import { expandOptionalProducts, checkStockRules, StockViolation } from './productService.js';

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

export async function getNextRevisionNo(baseQuoteNo: string, executor: DbExecutor = pool): Promise<string> {
  let data: any[] = [];
  try {
    const res = await executor.query(
      "SELECT quotation_no FROM quotations WHERE quotation_no IS NOT NULL AND quotation_no ILIKE $1",
      [`${baseQuoteNo}-%`]
    );
    data = res.rows;
  } catch (error) {
    console.error("Error fetching revisions:", error);
    return `${baseQuoteNo}-01`;
  }

  let maxRev = 0;
  if (data && data.length > 0) {
    data.forEach((q: any) => {
      const match = q.quotation_no.match(/-\d+$/);
      if (match) {
        const rev = parseInt(match[0].substring(1));
        if (rev > maxRev) {
          maxRev = rev;
        }
      }
    });
  }

  const nextRev = maxRev + 1;
  const nextRevStr = String(nextRev).padStart(2, '0');
  return `${baseQuoteNo}-${nextRevStr}`;
}

export async function getQuotationNo(quoteData: any, executor: DbExecutor = pool): Promise<string> {
  if (!quoteData || !quoteData.created_at) {
    return "QP-XXXX05000";
  }
  
  // ตรวจสอบว่าเป็นใบเสนอราคาแก้ไข (Revision) หรือไม่
  let reviseFrom: string | null = null;
  if (quoteData.customer_name && quoteData.customer_name.includes(' | ')) {
    const parts = quoteData.customer_name.split(' | ');
    if (parts[2]) {
      try {
        const meta = Object.fromEntries(new URLSearchParams(parts[2]));
        reviseFrom = meta.revise_from || null;
      } catch (err) {
        console.warn(`[getQuotationNo] parse metadata ไม่สำเร็จ (quote id=${quoteData.id}) meta="${parts[2]}"`, err);
      }
    }
  }
  
  if (reviseFrom) {
    let baseQuoteNo = reviseFrom;
    const match = reviseFrom.match(/^((?:QP|QT)-\d+)(-\d+)$/i);
    if (match) {
      baseQuoteNo = match[1];
    }
    return await getNextRevisionNo(baseQuoteNo, executor);
  }

  let isThemtech = false;
  if (quoteData.items && quoteData.items.length > 0) {
    const firstItem = quoteData.items[0];
    const company = await resolveQuoteCompany(firstItem, executor);
    isThemtech = (company === 'THT');
  }
  const prefix = isThemtech ? 'QT' : 'QP';
  const dateObj = new Date(quoteData.created_at);
  const yy = String(dateObj.getFullYear()).slice(-2);
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const datePart = `${yy}${mm}`;
  const startOfMonth = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1).toISOString();
  const endOfMonth = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 1).toISOString();
  
  // ดึงรายการในเดือนนี้ที่มีรหัส quotation_no แล้วของแบรนด์นี้เท่านั้น
  let monthQuotes: any[] = [];
  try {
    const res = await executor.query(
      `SELECT id, quotation_no FROM quotations
       WHERE status <> 'draft' AND quotation_no IS NOT NULL AND quotation_no ILIKE $1
         AND created_at >= $2 AND created_at < $3
       ORDER BY created_at ASC, id ASC`,
      [`${prefix}-%`, startOfMonth, endOfMonth]
    );
    monthQuotes = res.rows;
  } catch (countError) {
    console.error(`Error counting ${prefix} quotes:`, countError);
    return `${prefix}-${datePart}05999`;
  }
  
  // ค้นหาตำแหน่งของตัวนี้ถ้ามีอยู่แล้ว
  const index = monthQuotes.findIndex((q: any) => q.id === quoteData.id);
  const sequenceNum = index !== -1 ? (index + 1) : (monthQuotes.length + 1);
  const sequenceStr = String(sequenceNum).padStart(3, '0');
  return `${prefix}-${datePart}05${sequenceStr}`;
}

export async function resolveQuoteCompany(item: any, executor: DbExecutor = pool): Promise<'PM' | 'THT'> {
  let companyRules: any[] = [];
  try {
    const rulesRes = await executor.query('SELECT * FROM quotation_rules WHERE quote_company IS NOT NULL');
    companyRules = rulesRes.rows || [];
  } catch (err) {
    console.error('Error fetching quotation rules for company resolution:', err);
  }

  const code = item.product_code || item.model || item.code;
  if (code && companyRules.length > 0) {
    const prod = await getProductInfo(code, executor);
    if (prod) {
      const rule = matchRuleWithProduct(prod, companyRules);
      if (rule) {
        if (rule.quote_company === 'PM') return 'PM';
        if (rule.quote_company === 'THT') return 'THT';
      }
    }
  }

  // fallback: logic เดิม
  return item.production === 'Import(PM)' ? 'THT' : 'PM';
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
  // ลบร่างใบเสนอราคาเดิมที่ค้างอยู่ทั้งหมด ของผู้ใช้รายนี้ออกถาวรทันที
  // ยกเว้นกรณี preserveDrafts=true (เช่น การแยกใบเพิ่มระหว่างแก้ไข) ที่ต้องเก็บใบเดิมไว้
  if (!preserveDrafts) {
    try {
      await pool.query(
        "DELETE FROM quotations WHERE user_id = $1 AND status IN ('pending_company', 'pending_contact', 'draft')",
        [userId]
      );
    } catch (err) {
      console.error("[insertDraftQuotations] Exception during deleting old drafts:", err);
    }
  }

  const items = itemsForDb || [];
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
    sale_phone: '',
    employee_quotations: 'ชื่อแอดมิน',
    employee_quotations_phone: 'เบอร์โทร'
  };
  let salespersonIdStr: string | null = null;

  if (userId) {
    try {
      const spRes = await pool.query(
        'SELECT salesperson_id, name, phone, employee_quotations, employee_quotations_phone FROM salesperson WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      const spData = spRes.rows[0];
      if (spData) {
        salespersonIdStr = spData.salesperson_id ? String(spData.salesperson_id).trim() : null;
        employeeDetails = {
          salesperson_id: salespersonIdStr,
          saleperson: spData.name || '',
          sale_phone: spData.phone || '',
          employee_quotations: spData.employee_quotations || 'ชื่อแอดมิน',
          employee_quotations_phone: spData.employee_quotations_phone || 'เบอร์โทร'
        };
      }
    } catch (err) {
      console.error('[insertDraftQuotations] Error fetching salesperson info:', err);
    }
  }

  // 2. ดึงข้อมูลรายละเอียดลูกค้าและจัด format ที่อยู่
  let companyName = customerName || 'ลูกค้าทั่วไป';
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
  let contactName = contactNameQuery || 'ลูกค้าทั่วไป';
  let contactPhone = '';
  let contactEmail = '';
  let contactAddress = '';
  let paymentTerms = '';

  if (companyName && companyName !== 'ลูกค้าทั่วไป') {
    try {
      let custData = null;

      // 2.1 ใช้ ID ดึงตรงจาก Odoo (Option 2)
      if (customerId && contactId) {
        const custRes = await pool.query(
          'SELECT * FROM customers WHERE company_id = $1 AND contact_id = $2 LIMIT 1',
          [customerId, contactId]
        );
        custData = custRes.rows[0];
      }
      if (customerId && !custData) {
        if (contactNameQuery) {
          const custRes = await pool.query(
            'SELECT * FROM customers WHERE company_id = $1 AND TRIM(contact_name) = TRIM($2) LIMIT 1',
            [customerId, contactNameQuery]
          );
          custData = custRes.rows[0];
        }
        if (!custData) {
          const custRes = await pool.query(
            'SELECT * FROM customers WHERE company_id = $1 LIMIT 1',
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
        contactName = custData.contact_name || contactNameQuery || 'ลูกค้าทั่วไป';
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

        const stateCleaned = cleanState(custData.invoice_state);
        const districtCleaned = cleanAddressField(custData.invoice_district, custData.invoice_state, custData.invoice_zip);
        const subDistrictCleaned = cleanAddressField(custData.invoice_sub_district, custData.invoice_state, custData.invoice_zip);

        const addr = [
          custData.invoice_street,
          districtCleaned,
          subDistrictCleaned,
          stateCleaned,
          custData.invoice_zip
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

  const customerDetails = {
    customer_name: companyName,
    customer_code: customerCode,
    customer_tax_id: customerTaxId,
    contact_name: contactName,
    phone: contactPhone,
    email: contactEmail,
    address: contactAddress,
    payment_terms: paymentTerms,
    revise_from: reviseFrom,
    custom_meta: customMetaStr
  };

  // ดึงกฎการประกันสินค้ามาคำนวณ Snapshot
  let quotationRules: any[] = [];
  try {
    const rulesRes = await pool.query('SELECT * FROM quotation_rules');
    quotationRules = rulesRes.rows || [];
  } catch (err) {
    console.error('[insertDraftQuotations] Error fetching quotation rules:', err);
  }

  const mapItemsToSnapshot = async (rawItems: any[]) => {
    const snapshotItems: any[] = [];
    for (const item of rawItems) {
      const code = item.product_code || item.model || item.code || '';
      let dbProduct: any = null;
      try {
        const prodRes = await pool.query(
          'SELECT product_template_id AS product_id, internal_reference, name, sales_description, brand, series, production FROM products WHERE model = $1 ORDER BY actual_quantity DESC LIMIT 1',
          [code]
        );
        dbProduct = prodRes.rows[0];
      } catch (err) {
        console.warn(`[quotationService] ดึงข้อมูลสินค้าไม่สำเร็จ (model="${code}") — ใช้ค่าจาก item แทน`, err);
      }

      const finalInternalRef = dbProduct?.internal_reference || code;
      const finalProductId = dbProduct?.product_id || item.product_id || null;
      const finalName = dbProduct?.name || item.name || '';
      const finalSalesDesc = dbProduct?.sales_description || item.sales_description || '';
      const iBrand = dbProduct?.brand || item.brand || '';
      const iSeries = dbProduct?.series || item.series || '';
      const iProduction = dbProduct?.production || item.production || '';

      let matchedRule = null;
      const clean = (s: string) => s.replace(/\s+/g, '').toLowerCase();
      const pBrand = iBrand.trim().toLowerCase();
      const pSeries = iSeries.trim().toLowerCase();
      const pProduction = iProduction.trim().toLowerCase();

      matchedRule = quotationRules.find((r: any) => {
        if (r.production) {
          if (r.production === '__NULL__') {
            if (pProduction !== '') return false;
          } else {
            const rp = clean(r.production);
            const ip = clean(pProduction);
            const isImportMatch = (rp === 'import' && ip.startsWith('import'));
            const isExactMatch = (rp === ip);
            if (!isExactMatch && !isImportMatch) return false;
          }
        }
        if (r.brand && r.brand.trim().toLowerCase() !== pBrand) return false;
        if (r.series && r.series.trim().toLowerCase() !== pSeries) return false;
        return true;
      });

      const warrantyYears = matchedRule ? matchedRule.warranty_years : 1;
      const warrantyUnit = matchedRule ? (matchedRule.warranty_unit || 'year') : 'year';
      const warrantyDisplay = warrantyUnit === 'month' ? `${warrantyYears} เดือน` : `${warrantyYears} ปี`;
      const deliveryInStockDays = matchedRule ? matchedRule.delivery_in_stock_days : 3;
      const deliveryOutOfStockDays = matchedRule ? matchedRule.delivery_out_of_stock_days : 7;

      snapshotItems.push({
        internal_reference: finalInternalRef,
        product_id: finalProductId,
        model: code,
        name: finalName,
        sales_description: finalSalesDesc,
        price: Number(item.price) || 0,
        quantity: Number(item.quantity ?? item.qty) || 0,
        discount_1: Number(item.discount_1) || 0,
        discount_2: Number(item.discount_2) || 0,
        remark: item.remark || '',
        brand: iBrand,
        series: iSeries,
        production: iProduction,
        warranty_display: warrantyDisplay,
        delivery_in_stock_days: deliveryInStockDays,
        delivery_out_of_stock_days: deliveryOutOfStockDays,
        is_optional: !!item.is_optional
      });
    }
    return snapshotItems;
  };
  const draftQuotesToInsert: any[] = [];

  if (pmItems.length > 0) {
    const pmSum = pmItems.reduce((sum, item) => {
      const netPrice = item.price * (1 - item.discount_1 / 100) * (1 - item.discount_2 / 100);
      const quantity = item.quantity ?? item.qty ?? 0;
      return sum + (quantity * netPrice);
    }, 0);
    const itemDetails = await mapItemsToSnapshot(pmItems);
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
    const thtSum = thtItems.reduce((sum, item) => {
      const netPrice = item.price * (1 - item.discount_1 / 100) * (1 - item.discount_2 / 100);
      const quantity = item.quantity ?? item.qty ?? 0;
      return sum + (quantity * netPrice);
    }, 0);
    const itemDetails = await mapItemsToSnapshot(thtItems);
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

  const insertedQuotes: any[] = [];
  try {
    for (const q of draftQuotesToInsert) {
      const res = await pool.query(`
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
      if (res.rows[0]) {
        const enriched = await enrichQuotationData(res.rows[0]);
        insertedQuotes.push(enriched);
      }
    }
    return insertedQuotes;
  } catch (err) {
    console.error("[insertDraftQuotations] Database Insert Error:", err);
    return null;
  }
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
 * ค้นหา Rule ที่ตรงกับสินค้า (matching production, brand, series)
 */
export function matchRuleWithProduct(prod: any, rules: any[]): any {
  if (!prod) return null;

  const prodBrand      = prod.brand      ? String(prod.brand).trim().toLowerCase()      : '';
  const prodSeries     = prod.series     ? String(prod.series).trim().toLowerCase()     : '';
  const prodProduction = prod.production ? String(prod.production).trim().toLowerCase() : '';
  const clean = (s: string) => s.replace(/\s+/g, '').toLowerCase();

  return rules.find(r => {
    if (r.production) {
      if (r.production === '__NULL__') {
        if (prodProduction !== '') return false;
      } else {
        const rp = clean(r.production);
        const ip = clean(prodProduction);
        const isImportMatch = (rp === 'import' && ip.startsWith('import'));
        const isExactMatch = (rp === ip);
        if (!isExactMatch && !isImportMatch) return false;
      }
    }
    if (r.brand  && r.brand.trim().toLowerCase() !== prodBrand)   return false;
    if (r.series && r.series.trim().toLowerCase() !== prodSeries) return false;
    return true;
  });
}

/**
 * ค้นหา Rule จาก item โดยการ query สินค้าในตัว
 */
export async function getRuleForItem(item: any, rules: any[]): Promise<any> {
  const code = item.product_code || item.model || item.code;
  if (!code) return null;

  const prod = await getProductInfo(code);
  return matchRuleWithProduct(prod, rules);
}

/**
 * ค้นหาข้อมูลสินค้าและตรวจสอบว่ามีสินค้าใดติดกฎล็อกเสนอราคา (is_locked) หรือไม่
 */
export async function getBlockedProductError(items: any[] | null): Promise<string | null> {
  if (!items || items.length === 0) return null;

  let lockedRules: any[] = [];
  try {
    const rulesRes = await pool.query('SELECT * FROM quotation_rules WHERE is_locked = true');
    lockedRules = rulesRes.rows || [];
  } catch (err) {
    console.error('Error fetching quotation rules for blocking validation:', err);
    return null;
  }

  if (lockedRules.length === 0) return null;

  for (const item of items) {
    const code = item.product_code || item.model || item.code;
    if (!code) continue;

    const prod = await getProductInfo(code);
    if (!prod) continue;

    const matchedRule = matchRuleWithProduct(prod, lockedRules);
    if (matchedRule) {
      const prodLabel = matchedRule.production === '__NULL__' ? '(ไม่มีฝ่ายผลิต)' : (matchedRule.production || '');
      return `❌ ระงับการเสนอราคา\n${prod.code}\nเงื่อนไข: ${prodLabel} > ${matchedRule.brand || ''} > ${matchedRule.series || ''}\nกรุณาติดต่อแอดมิน`;
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

  const cleanCust = String(rawCustomerQuery || '').trim();
  const cleanCont = String(rawContactQuery || '').trim();

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
    return createUnregisteredCustomerFlex(cleanCust, insertedQuotes.map((q: any) => q.id).join(','));
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
        `SELECT reference, tax_id, customer_payment_terms as payment_terms FROM customers_view WHERE TRIM(display_name) = TRIM($1) LIMIT 1`,
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
  const companyName = parts[0] ? parts[0].trim() : 'ลูกค้าทั่วไป';
  const contactName = parts[1] ? parts[1].trim() : '-';
  const metaStr = parts[2] || '';

  const customerDetails = {
    customer_name: companyName,
    customer_code: '',
    customer_tax_id: '',
    contact_name: contactName,
    phone: '-',
    email: '-',
    address: '-',
    payment_terms: '-',
    revise_from: null,
    custom_meta: metaStr
  };

  if (metaStr) {
    try {
      const params = new URLSearchParams(metaStr);
      customerDetails.phone = params.get('phone') || '-';
      customerDetails.email = params.get('email') || '-';
      customerDetails.address = params.get('address') || '-';
      customerDetails.customer_tax_id = params.get('tax_id') || '';
      customerDetails.revise_from = params.get('revise_from') as any || null;
    } catch (e) {
      console.warn(`[updateQuotationCustomerSnapshot] parse metadata ไม่สำเร็จ meta="${metaStr}"`, e);
    }
  }

  try {
    let custRes = null;

    // 1. ถ้ามี ID ส่งมา ให้ดึงข้อมูลตรงจาก ID ผ่าน customers_view และ contacts_view (Option 2)
    if (customerId) {
      if (contactId) {
        custRes = await pool.query(
          `SELECT c.reference, c.tax_id, c.customer_payment_terms as payment_terms,
                  co.phone as contact_phone, co.email as contact_email, co.invoice_street as contact_address,
                  co.invoice_district, co.invoice_sub_district, co.invoice_state, co.invoice_zip
           FROM customers_view c
           LEFT JOIN contacts_view co ON co.customer_id = c.id
           WHERE c.id = $1 AND co.id = $2 LIMIT 1`,
          [customerId, contactId]
        );
      }
      if (!custRes || custRes.rows.length === 0) {
        custRes = await pool.query(
          `SELECT reference, tax_id, customer_payment_terms as payment_terms
           FROM customers_view
           WHERE id = $1 LIMIT 1`,
          [customerId]
        );
      }
    }

    // 2. Fallback: ค้นหาด้วยชื่อแบบ TRIM เพื่อป้องกันสะกดสลับแถวหรือมีช่องว่างต่อท้าย
    if (!custRes || custRes.rows.length === 0) {
      custRes = await pool.query(
        `SELECT c.reference, c.tax_id, c.customer_payment_terms as payment_terms,
                co.phone as contact_phone, co.email as contact_email, co.invoice_street as contact_address,
                co.invoice_district, co.invoice_sub_district, co.invoice_state, co.invoice_zip
         FROM customers_view c
         LEFT JOIN contacts_view co ON co.customer_id = c.id
         WHERE TRIM(c.display_name) = TRIM($1) AND TRIM(co.name) = TRIM($2) LIMIT 1`,
        [companyName, contactName]
      );
    }
    if (!custRes || custRes.rows.length === 0) {
      custRes = await pool.query(
        `SELECT reference, tax_id, customer_payment_terms as payment_terms FROM customers_view WHERE TRIM(display_name) = TRIM($1) LIMIT 1`,
        [companyName]
      );
    }

    if (custRes && custRes.rows.length > 0) {
      const row = custRes.rows[0];
      if (row.reference) customerDetails.customer_code = row.reference;
      if (row.tax_id && !customerDetails.customer_tax_id) customerDetails.customer_tax_id = row.tax_id;
      if (row.contact_phone && customerDetails.phone === '-') customerDetails.phone = row.contact_phone;
      if (row.contact_email && customerDetails.email === '-') customerDetails.email = row.contact_email;
      if (row.contact_address && customerDetails.address === '-') {
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
    sale_phone: salesperson.phone || '',
    employee_quotations: salesperson.employee_quotations || '',
    employee_quotations_phone: salesperson.employee_quotations_phone || ''
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
    const rawCustomerName = customerDetails.customer_name || 'ลูกค้าทั่วไป';
    const companyName = rawCustomerName.split(' | ')[0].trim() || 'ลูกค้าทั่วไป';
    const contactName = customerDetails.contact_name || '';

    // จัด format customer_name เก่าเพื่อส่งกลับไปให้ frontend
    let oldCustomerNameFormat = companyName;
    if (contactName && contactName !== 'ลูกค้าทั่วไป') {
      oldCustomerNameFormat += ` | ${contactName}`;
    }

    const reviseFrom = customerDetails.revise_from || null;
    const customMetaStr = customerDetails.custom_meta || '';
    if (customMetaStr) {
      oldCustomerNameFormat += ` | ${customMetaStr}`;
    }

    // ดึง customer_id จริงจากระบบ
    let customerId = customerIdFromDb || null;
    if (!customerId && companyName && companyName !== 'ลูกค้าทั่วไป') {
      try {
        const custRes = await pool.query(
          "SELECT id FROM customers_view WHERE display_name = $1 LIMIT 1",
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

    // จัดระเบียบ items เพื่อความเข้ากันได้ย้อนหลังกับ Frontend
    const legacyItems = itemDetails.map((item: any) => ({
      product_id: item.product_id,
      model: item.model || item.internal_reference,
      product_code: item.model || item.internal_reference,
      name: item.name,
      sales_description: item.sales_description || '',
      price: item.price,
      quantity: item.quantity,
      discount_1: item.discount_1 || 0,
      discount_2: item.discount_2 || 0,
      remark: item.remark || '',
      brand: item.brand || '',
      series: item.series || '',
      production: item.production || '',
      stock: item.stock !== undefined ? item.stock : 9999, // default fallback stock
      is_optional: !!item.is_optional,
      linked_to_product_id: item.linked_to_product_id || null
    }));

    return {
      ...quoteDb,
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
      employee_quotations: employeeDetails.employee_quotations || 'ชื่อแอดมิน',
      employee_quotations_phone: employeeDetails.employee_quotations_phone || 'เบอร์โทร',
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

  let companyName = quoteDb.customer_name || 'ลูกค้าทั่วไป';
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

  if (companyName && companyName !== 'ลูกค้าทั่วไป') {
    try {
      const { data: custData } = await (db.from('customers') as any)
        .select('id, reference, tax_id, phone, email, customer_payment_terms')
        .eq('display_name', companyName)
        .limit(1)
        .maybeSingle();

      if (custData) {
        customerId = custData.id;
        customerCode = custData.reference || '';
        customerTaxId = custData.tax_id || '';
        paymentTerms = custData.customer_payment_terms || '';

        let contactQueryBuilder = (db.from('contacts') as any)
          .select('*')
          .eq('customer_id', custData.id);

        if (contactNameQuery && contactNameQuery !== '') {
          contactQueryBuilder = contactQueryBuilder.eq('name', contactNameQuery);
        }

        const { data: contactList } = await contactQueryBuilder.limit(1);
        const contactData = contactList && contactList.length > 0 ? contactList[0] : null;

        if (contactData) {
          contactName = contactData.name || '';
          
          const hasAddr = (contactData.invoice_street && contactData.invoice_street.trim()) || (contactData.invoice_state && contactData.invoice_state.trim());
          let target = contactData;

          if (!hasAddr) {
            const { data: companyRows } = await (db.from('customers_raw') as any)
              .select('invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip')
              .eq('company_id', custData.id)
              .order('contact_id', { ascending: true });

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

  return {
    ...quoteDb,
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
