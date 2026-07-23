import * as line from '@line/bot-sdk';
import express from 'express';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
dotenv.config();

import { lineConfig, lineClient } from './config/clients.js';
import {
  searchCustomersAdmin,
  getContactsByCustomerId,
  getContactById,
  getCompanyAddressRows,
  deletePendingQuotations,
  getCustomerBranchesBySalesperson,
  listSalespeopleFromOrders,
  getSalespersonByUserId,
  insertSalesperson,
  updateSalespersonByUserId,
  getBranchesByCodes,
  getBranches,
  getProductUomByTemplateIds,
} from './db/repositories.js';
import { confirmQuotationAtomic, enrichQuotationData, buildItemSnapshots, checkMinSalesPrice } from './services/quotationService.js';
import {
  buildOdooSaleOrderRows,
  collectProductTemplateIds,
  loadOdooExportConfig,
  serializeOdooRowsToCsv,
  serializeOdooRowsToXlsx,
  type OdooExportFormat,
} from './services/odooSaleOrderExport.js';
import {
  loadQuotationRules,
  findBlockingRule,
  buildBlockedMessage,
  normalizeProductScope,
  invalidateRuleCache
} from './services/rules/index.js';
import { handleEvent } from './handlers/lineHandler.js';
import { generateQuotationPDF, closePdfBrowser } from './pdfGenerator.js';
import { Parser } from 'json2csv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from './config/db.js';
import { getJwtSecret } from './config/jwt.js';
import { adminAuthMiddleware } from './config/auth.js';
import { sumLineTotals } from './utils/pricing.js';
import { isCustomerInfoIncomplete } from './utils/flexTemplates.js';
import {
  startSync,
  isRunning,
  getStatus as getSyncStatus,
  saveSettings as saveSyncSettings,
  isValidResource,
  RESOURCE_IDS,
  initScheduler,
} from './services/syncService.js';

// ตรวจ JWT_SECRET ตั้งแต่ boot — ถ้าขาด ให้ล้มทันทีแทนที่จะไปพังตอนแอดมิน login ครั้งแรก
getJwtSecret();

const app = express();

// Serve static files from the public folder
app.use(express.static(path.join(process.cwd(), 'public')));

// Serve data folder dynamically for signature image previews
app.use('/data', express.static(path.join(process.cwd(), 'data')));

// Serve admin portal dashboard
app.get('/admin', (req: any, res: any) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

// API config endpoint to retrieve LIFF ID dynamically (prevents hardcoding in React)
app.get('/api/liff/config', (req: any, res: any) => {
  const page = req.query.page;
  let liffId = '';
  if (page === 'register' || page === 'branch-select') {
    liffId = process.env.LIFF_ID || '';
  } else if (page === 'quote-edit') {
    liffId = process.env.LIFF_QUOTE_ID || process.env.LIFF_ID || '';
  } else if (page === 'product-search') {
    liffId = process.env.LIFF_PRODUCT_SEARCH_ID || process.env.LIFF_QUOTE_ID || process.env.LIFF_ID || '';
  } else {
    liffId = process.env.LIFF_ID || '';
  }
  res.json({ liffId });
});

/**
 * คิวประมวลผล event แบบ FIFO ต่อ key (userId) — event ของผู้ใช้คนเดียวกันจะรันทีละตัว
 * ไม่ทับกัน (กันการกดปุ่มยืนยันรัว ๆ ชนกันเอง) ส่วนผู้ใช้คนละคนรันขนานกันได้
 * และจำกัดจำนวน key ที่ทำงานพร้อมกันทั้งระบบด้วย maxConcurrency
 */
class KeyedTaskQueue {
  private queues = new Map<string, (() => Promise<void>)[]>();
  private activeKeys = new Set<string>();
  private activeCount = 0;
  private maxConcurrency: number;

  constructor(maxConcurrency = 12) {
    this.maxConcurrency = maxConcurrency;
  }

  public push(key: string, task: () => Promise<void>) {
    const list = this.queues.get(key);
    if (list) list.push(task);
    else this.queues.set(key, [task]);
    this.next();
  }

  private next() {
    for (const [key, tasks] of this.queues) {
      if (this.activeCount >= this.maxConcurrency) return;
      // key ที่กำลังทำงานอยู่ให้ข้ามไป ไม่กินสล็อต จนกว่าตัวก่อนหน้าของ key นั้นจะเสร็จ
      if (this.activeKeys.has(key) || tasks.length === 0) continue;

      const task = tasks.shift()!;
      if (tasks.length === 0) this.queues.delete(key);

      this.activeKeys.add(key);
      this.activeCount++;
      task()
        .catch((err) => {
          console.error('[KeyedTaskQueue] Task error:', err);
        })
        .finally(() => {
          this.activeKeys.delete(key);
          this.activeCount--;
          this.next();
        });
    }
  }
}

const webhookQueue = new KeyedTaskQueue(12);

// --- Webhook สำหรับรับข้อความและเหตุการณ์จาก LINE ---
app.post('/callback', line.middleware(lineConfig), (req: any, res: any) => {
  res.sendStatus(200);

  console.log(">>> Webhook Received! Events:", JSON.stringify(req.body.events, null, 2));

  // Dynamically set APP_URL from incoming webhook request headers if not set in .env
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  if (!process.env.APP_URL) {
    process.env.APP_URL = `${protocol}://${host}`;
    console.log(`>>> Dynamically set APP_URL to: ${process.env.APP_URL}`);
  }

  if (Array.isArray(req.body.events)) {
    req.body.events.forEach((event: any) => {
      // key คิวด้วย userId เพื่อให้ event ของคนเดียวกันรันทีละตัว (groupId/anonymous เป็น fallback)
      const queueKey = event?.source?.userId || event?.source?.groupId || 'anonymous';
      webhookQueue.push(queueKey, async () => {
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Processing timeout')), 25000);
        });

        try {
          await Promise.race([
            handleEvent(event),
            timeoutPromise
          ]);
        } catch (err: any) {
          if (err.message === 'Processing timeout') {
            // ห้าม replyMessage ที่นี่ — reply token เป็น single-use และ handler เดิม (handleEvent)
            // ยังทำงานต่ออยู่ (Promise.race ไม่ได้ cancel มัน) การยิงซ้ำจะแย่ง token กับ handler
            // ที่กำลังจะตอบสำเร็จ ทำให้ผู้ใช้เห็นข้อความผิด และ Push Message ก็ถูกห้ามอยู่แล้ว
            console.warn(`[Queue] Timeout (event=${event?.type} user=${queueKey}) — ปล่อยให้ handler เดิมตอบเอง`);
          } else {
            console.error('[Queue] Error processing event:', err.message || err);
          }
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        }
      });
    });
  }
});

// --- Endpoint ตรวจเช็คสถานะการทำงานของเซิร์ฟเวอร์ ---
app.get('/', (req: any, res: any) => {
  res.send('Server is running');
});

// --- Endpoint ให้บริการหน้า LIFF สำหรับลงทะเบียน/เลือกสาขา ---
app.get(['/liff/branch-select', '/liff/branch-select/branch-select', '/liff/register', '/liff/register/register'], (req: any, res: any) => {
  try {
    const liffHtmlPath = path.join(process.cwd(), 'liff_pages', 'register.html');
    let html = fs.readFileSync(liffHtmlPath, 'utf8');
    html = html.replace('__LIFF_ID__', process.env.LIFF_ID || '');
    res.send(html);
  } catch (err) {
    console.error("Error serving LIFF page:", err);
    res.status(500).send("Internal Server Error");
  }
});

// --- Endpoint ให้บริการหน้า LIFF สำหรับแก้ไขใบเสนอราคา ---
app.get(['/liff/quote-edit', '/liff/quote-edit/quote-edit'], (req: any, res: any) => {
  try {
    const htmlPath = path.join(process.cwd(), 'liff_pages', 'quote-edit.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__LIFF_ID__', process.env.LIFF_QUOTE_ID || process.env.LIFF_ID || '');
    res.send(html);
  } catch (err) {
    console.error("Error serving quote-edit LIFF page:", err);
    res.status(500).send("Internal Server Error");
  }
});

// --- Endpoint ให้บริการหน้า LIFF สำหรับค้นหาสินค้า ---
app.get(['/liff/product-search', '/liff/product-search/product-search'], (req: any, res: any) => {
  try {
    const htmlPath = path.join(process.cwd(), 'liff_pages', 'product-search.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__LIFF_ID__', process.env.LIFF_PRODUCT_SEARCH_ID || process.env.LIFF_QUOTE_ID || process.env.LIFF_ID || '');
    res.send(html);
  } catch (err) {
    console.error("Error serving product-search LIFF page:", err);
    res.status(500).send("Internal Server Error");
  }
});


// --- API: สร้างใบเสนอราคาแบบร่างใหม่ ---
app.post('/api/quotations', express.json(), async (req: any, res: any) => {
  try {
    const { userId, customerName, items, status, customerId, contactId, preserveDrafts } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const { insertDraftQuotations, getBlockedProductError, validateAndPrepareItems } =
      await import('./services/quotationService.js');

    // ด่านตรวจกฎสินค้า — ชุดเดียวกับ /api/quotation/draft-cart และ PUT /api/quotation/:id
    //
    // endpoint นี้ไม่ได้ถูกเรียกแค่ตอนสร้างใบใหม่ธรรมดา แต่หน้า LIFF ใช้ตอน "แยกใบใหม่"
    // ด้วย (เพิ่มสินค้าคนละบริษัทกับใบที่เปิดอยู่ → addProductToQuote ยิงมาที่นี่)
    // เดิมเส้นทางนี้ไม่มีการตรวจเลย สินค้าที่ติดกฎห้ามเสนอราคา/ระงับเมื่อหมดสต็อก
    // จึงหลุดเข้าใบได้ทั้งที่เส้นทางอื่นดักไว้หมดแล้ว
    const blockedErrorOnCreate = await getBlockedProductError(items);
    if (blockedErrorOnCreate) {
      return res.status(400).json({ error: blockedErrorOnCreate });
    }
    const { items: expandedOnCreate, errors: createErrors } = await validateAndPrepareItems(items);
    if (createErrors.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: createErrors });
    }

    // ยังไม่ได้ระบุบริษัท = ร่างที่ยืนยันไม่ได้ ต้องคาสถานะ pending_company ไว้เสมอ
    const hasCompany = !!(customerName && customerName.split(' | ')[0].trim());
    const finalStatus = hasCompany ? (status || 'draft') : 'pending_company';
    const insertedQuotes = await insertDraftQuotations(userId, customerName || ' | ', expandedOnCreate, finalStatus, customerId, contactId, !!preserveDrafts);

    if (!insertedQuotes || insertedQuotes.length === 0) {
      return res.status(500).json({ error: 'Failed to create quotation' });
    }

    const enriched = await enrichQuotationData(insertedQuotes[0]);
    res.json(enriched);
  } catch (err: any) {
    console.error("API POST quotations error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: ดึงข้อมูลใบเสนอราคาหลายใบ ---
app.get('/api/quotations', async (req: any, res: any) => {
  try {
    const idsParam = req.query.ids;
    if (!idsParam) return res.status(400).json({ error: 'Missing ids parameter' });
    const ids = idsParam.split(',').map((id: any) => id.trim()).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: 'No valid ids' });

    let data: any[] = [];
    try {
      const res = await pool.query(
        "SELECT * FROM quotations WHERE id = ANY($1)",
        [ids]
      );
      data = res.rows;
    } catch (err: any) {
      console.error("Fetch quotations error:", err);
      return res.status(500).json({ error: err.message });
    }

    const enrichedData = await Promise.all((data || []).map((q: any) => enrichQuotationData(q)));
    res.json(enrichedData);
  } catch (err: any) {
    console.error("API GET quotations error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: คำนวณวันจัดส่งสด ระหว่างแก้ไขในหน้า LIFF (ยังไม่บันทึก) ---
// กฎ tier ตามจำนวนอยู่ใน quotation_rules ฝั่ง server หน้า LIFF คำนวณเองไม่ได้
// endpoint นี้ใช้ buildItemSnapshots ชุดเดียวกับตอน PUT → เลขที่โชว์ตอนแก้ = เลขที่ได้ตอนบันทึก
app.post('/api/quotations/delivery-preview', express.json(), async (req: any, res: any) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Missing items' });
    if (items.length > 200) return res.status(400).json({ error: 'รายการสินค้ามากเกินไป' });

    const { previewQuotationDeliveryDays } = await import('./services/quotationService.js');
    res.json(await previewQuotationDeliveryDays(items));
  } catch (err: any) {
    console.error('API delivery-preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: ค่าคงที่ของกฎค่าขนส่ง สำหรับหน้า LIFF จำลองกฎฝั่ง client ---
// หน้า LIFF ต้องโชว์/ถอดบรรทัดค่าขนส่งทันทีระหว่างเซลล์แก้จำนวน ยังไม่ได้บันทึก
// จึงต้องรู้เกณฑ์กับราคา — server ยังเป็นผู้ตัดสินจริงตอน PUT เสมอ (services/shippingFee.ts)
app.get('/api/shipping-fee/config', async (req: any, res: any) => {
  try {
    const { loadShippingFeeConfig } = await import('./services/shippingFee.js');
    const cfg = await loadShippingFeeConfig();
    res.json({
      is_active: cfg.isActive && cfg.productId !== null,
      threshold_before_vat: cfg.thresholdBeforeVat,
      fee_price: cfg.feePrice,
      fee_quantity: cfg.feeQuantity,
      default_item_name: cfg.defaultItemName,
      product_id: cfg.productId,
      product_model: cfg.productModel,
      internal_reference: cfg.productInternalReference
    });
  } catch (err: any) {
    console.error('GET /api/shipping-fee/config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: ค้นหาสินค้าแบบ Real-time ---
app.get('/api/products/search', async (req: any, res: any) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) return res.json([]);

    const qTrim = q.trim();
    const searchPattern = `%${qTrim}%`;
    const limit = req.query.limit ? parseInt(req.query.limit) : 30;
    const dbLimit = Math.max(150, limit);

    // คิวรีดึงข้อมูลด้วย pool.query และ LEFT JOIN product_stock_rules (ตามกฎ SQL standard)
    const { rows } = await pool.query(`
      SELECT 
        p.model AS code,
        p.name,
        p.sales_price AS price,
        p.production,
        p.actual_quantity AS stock,
        p.product_category AS category,
        p.model,
        p.sales_description,
        p.minimum_sales_price,
        p.actual_quantity,
        p.product_template_id AS product_id,
        p.internal_reference,
        p.brand,
        sr.is_active AS stock_rule_active
      FROM products p
      LEFT JOIN product_stock_rules sr ON p.internal_reference = sr.internal_reference
      WHERE (p.model ILIKE $1 OR p.name ILIKE $1 OR p.internal_reference ILIKE $1 OR p.brand ILIKE $1 OR p.product_template_id::text = $2)
        AND (p.production IS NULL OR LOWER(REPLACE(p.production, ' ', '')) NOT LIKE '%buytosell%')
        AND p.is_system_item = false
      ORDER BY p.actual_quantity DESC
      LIMIT $3
    `, [searchPattern, qTrim, dbLimit]);

    const qLower = qTrim.toLowerCase();
    
    // 1. Search model column: prefix match (starts with qTrim)
    const codePrefixMatches = rows.filter((p: any) => 
      String(p.code || '').toLowerCase().startsWith(qLower)
    );

    // 1.5. Search internal_reference match
    const refMatches = rows.filter((p: any) => 
      String(p.internal_reference || '').toLowerCase().includes(qLower)
    );

    // 2. Search model column: substring match (but not prefix match)
    const codeSubMatches = rows.filter((p: any) => {
      const codeStr = String(p.code || '').toLowerCase();
      return codeStr.includes(qLower) && !codeStr.startsWith(qLower);
    });

    // 2.5. Search brand column
    const brandMatches = rows.filter((p: any) => {
      const brandStr = String(p.brand || '').toLowerCase();
      return brandStr.includes(qLower);
    });

    // 3. Search name column
    const nameMatches = rows.filter((p: any) => {
      const codeStr = String(p.code || '').toLowerCase();
      const nameStr = String(p.name || '').toLowerCase();
      const brandStr = String(p.brand || '').toLowerCase();
      return nameStr.includes(qLower) && !codeStr.includes(qLower) && !brandStr.includes(qLower);
    });

    const results: any[] = [];
    const seenCodes = new Set<string>();
    const addUnique = (list: any[]) => {
      for (const p of list) {
        if (!seenCodes.has(p.code)) {
          seenCodes.add(p.code);
          results.push(p);
        }
      }
    };

    addUnique(codePrefixMatches);
    if (results.length < 30) {
      addUnique(refMatches);
    }
    if (results.length < 30) {
      addUnique(codeSubMatches);
    }
    if (results.length < 30) {
      addUnique(brandMatches);
    }
    if (results.length < 30) {
      addUnique(nameMatches);
    }

    // Sort to prioritize exact/closer matches of code (ignoring hyphens/case/whitespace)
    const normalizeCode = (str: any) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normQ = normalizeCode(qTrim);

    const sorted = results.sort((a: any, b: any) => {
      const normA = normalizeCode(a.code);
      const normB = normalizeCode(b.code);
      
      const exactA = normA === normQ;
      const exactB = normB === normQ;
      if (exactA && !exactB) return -1;
      if (!exactA && exactB) return 1;
      
      const startsA = normA.startsWith(normQ);
      const startsB = normB.startsWith(normQ);
      if (startsA && !startsB) return -1;
      if (!startsA && startsB) return 1;
      
      if (a.code.length !== b.code.length) {
        return a.code.length - b.code.length;
      }
      
      return a.code.localeCompare(b.code);
    });

    const { resolveQuoteCompany } = await import('./services/quotationService.js');

    // Map properties to match original output structure and enrich with stock block flags
    const mappedPromises = sorted.slice(0, limit).map(async (item: any) => {
      const actualQty = Number(item.actual_quantity) || 0;
      const isBlocked = (actualQty <= 0 && item.stock_rule_active);

      let qCompany: 'PM' | 'THT' = 'PM';
      try {
        qCompany = await resolveQuoteCompany(item);
      } catch (err) {
        console.error("Error resolving company in product search API:", err);
        qCompany = item.production === 'Import(PM)' ? 'THT' : 'PM';
      }

      return {
        code: item.code,
        name: item.name,
        price: item.price,
        production: item.production,
        stock: item.stock,
        category: item.category,
        model: item.model,
        sales_description: item.sales_description,
        minimum_sales_price: item.minimum_sales_price,
        product_id: item.product_id,
        is_blocked_no_stock: isBlocked,
        no_stock_warn_msg: isBlocked ? 'สินค้าหมด' : null,
        quote_company: qCompany,
        internal_reference: item.internal_reference,
        brand: item.brand
      };
    });

    const mapped = await Promise.all(mappedPromises);

    res.json(mapped);
  } catch (err: any) {
    console.error("API GET products search error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: ตรวจสอบว่าสินค้าถูกล็อกการเสนอราคาหรือไม่ ---
app.get('/api/products/:code/blocked', async (req: any, res: any) => {
  try {
    const code = req.params.code;
    if (!code) return res.status(400).json({ error: 'Missing product code' });

    const rules = await loadQuotationRules();
    if (!rules.some(r => r.is_locked === true)) return res.json({ blocked: false });

    // ดึงข้อมูลสินค้า
    const { rows } = await pool.query(
      'SELECT model AS code, brand, series, production FROM products WHERE model = $1 ORDER BY actual_quantity DESC LIMIT 1',
      [code]
    );
    const prod = rows[0] || null;

    if (!prod) return res.json({ blocked: false });

    const matchedRule = findBlockingRule(rules, normalizeProductScope(prod));
    if (matchedRule) {
      return res.json({ blocked: true, message: buildBlockedMessage(matchedRule, prod.code) });
    }

    res.json({ blocked: false });
  } catch (err: any) {
    console.error('API GET products/:code/blocked error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: ค้นหาลูกค้าแบบ Real-time (ค้นหาจากชื่อ หรือ รหัสอ้างอิง) ---
app.get('/api/customers/search', async (req: any, res: any) => {
  try {
    const q = req.query.q || '';

    const data = await searchCustomersAdmin(String(q), 30);
    res.json(data);
  } catch (err: any) {
    console.error("API GET customers search error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: ดึงรายชื่อผู้ติดต่อตาม ID ลูกค้า ---
app.get('/api/customer/:id/contacts', async (req: any, res: any) => {
  try {
    const data = await getContactsByCustomerId(req.params.id);

    let formatted: any[] = [];
    if (data) {
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

      // Fetch company default address once
      let companyDefaultAddr = null;
      const companyRows = await getCompanyAddressRows(req.params.id);

      if (companyRows && companyRows.length > 0) {
        companyDefaultAddr = companyRows.find((r: any) => r.invoice_street && r.invoice_street.trim()) || 
                             companyRows.find((r: any) => r.invoice_state && r.invoice_state.trim()) || 
                             companyRows[0];
      }

      formatted = data.map((c: any) => {
        const hasAddr = (c.invoice_street && c.invoice_street.trim()) || (c.invoice_state && c.invoice_state.trim());
        const target = hasAddr ? c : (companyDefaultAddr || c);

        const stateCleaned = cleanState(target.invoice_state);
        const districtCleaned = cleanAddressField(target.invoice_district, target.invoice_state, target.invoice_zip);
        const subDistrictCleaned = cleanAddressField(target.invoice_sub_district, target.invoice_state, target.invoice_zip);

        const addrComplete = [
          target.invoice_street,
          districtCleaned,
          subDistrictCleaned,
          stateCleaned,
          target.invoice_zip
        ].map(s => String(s || '').trim()).filter(Boolean).join(' ');

        return {
          id: c.id,
          name: c.name,
          mobile: c.mobile,
          phone: c.phone,
          email: c.email,
          invoice_street: target.invoice_street,
          invoice_district: districtCleaned,
          invoice_sub_district: subDistrictCleaned,
          invoice_state: stateCleaned,
          invoice_zip: target.invoice_zip,
          address_complete: addrComplete || ''
        };
      });
    }

    res.json(formatted);
  } catch (err: any) {
    console.error("API GET contacts error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: สร้างใบเสนอราคาแบบร่างจากตะกร้าสินค้า ---
app.post('/api/quotation/draft-cart', express.json(), async (req: any, res: any) => {
  try {
    const { userId, items } = req.body;
    if (!userId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // quotations.user_id มี FK ไป salesperson(user_id) — ถ้ายังไม่ลงทะเบียนจะ insert ไม่ผ่าน
    // ต้องดักไว้ก่อน เพื่อบอกสาเหตุที่แท้จริงแทนที่จะพังตอน insert แล้วขึ้น error กำกวม
    const spCheck = await pool.query('SELECT 1 FROM salesperson WHERE user_id = $1 LIMIT 1', [userId]);
    if (spCheck.rowCount === 0) {
      // log userId ที่ได้รับด้วย — เคสที่เจอบ่อยคือหน้า LIFF เปิดจากริชเมนู (ไม่มี ?userId=)
      // แล้ว fallback ไป liff.getProfile() ซึ่งอาจได้ id คนละตัวกับ Messaging API channel
      console.warn(`[draft-cart] 403 ไม่พบ salesperson: userId="${userId}" (len=${String(userId).length})`);
      return res.status(403).json({
        error: 'บัญชี LINE นี้ยังไม่ได้ลงทะเบียนเป็นพนักงานขาย\nกรุณาลงทะเบียนในแชทก่อนใช้งานครับ 🙏'
      });
    }

    // 1. ลบรายการใบเสนอราคาเก่าที่ยังค้างอยู่ทั้งหมดออกถาวร
    await deletePendingQuotations(userId);

    // 2. ตรวจสอบข้อมูลสินค้าและเตรียมนำข้อมูลที่ถูกต้องบันทึก
    const itemsForDb = [];
    for (const item of items) {
      const codeKey = item.model || item.product_code;
      const { rows } = await pool.query(
        'SELECT * FROM products WHERE model = $1 ORDER BY actual_quantity DESC LIMIT 1',
        [codeKey]
      );
      const prod = rows[0] || null;

      if (prod) {
        itemsForDb.push({
          product_id: prod.product_template_id,
          internal_reference: prod.internal_reference || '',
          product_code: prod.model,
          model: prod.model,
          name: prod.name,
          brand: prod.brand || '',
          series: prod.series || '',
          quantity: Number(item.quantity) || 1,
          price: Number(prod.sales_price) || 0,
          discount_1: 0,
          discount_2: 0,
          production: prod.production || ''
        });
      }
    }

    if (itemsForDb.length === 0) {
      return res.status(400).json({ error: 'No valid products found' });
    }

    // ตรวจสอบสินค้าที่บล็อก
    const { insertDraftQuotations, getBlockedProductError, validateAndPrepareItems } = await import('./services/quotationService.js');
    const blockedError = await getBlockedProductError(itemsForDb);
    if (blockedError) {
      return res.status(400).json({ error: blockedError });
    }

    // เรียกใช้ Validation Pipeline (F2, F3, F4)
    const { items: expanded, errors } = await validateAndPrepareItems(itemsForDb);
    if (errors.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: errors });
    }

    // 3. บันทึกลงฐานข้อมูลเป็นใบเสนอราคาฉบับร่าง (ใช้ expanded ที่รวมสินค้าเสริมแล้ว)
    const insertedQuotes = await insertDraftQuotations(userId, ' | ', expanded, 'pending_company');

    if (!insertedQuotes || insertedQuotes.length === 0) {
      return res.status(500).json({ error: 'Failed to create draft quotation' });
    }

    const quoteIds = insertedQuotes.map(q => q.id).join(',');
    res.json({ success: true, quoteIds });
  } catch (err: any) {
    console.error("API POST draft-cart error:", err);
    res.status(500).json({ error: err.message });
  }
});


// --- API: อัปเดตรายการสินค้าและข้อมูลลูกค้าในใบเสนอราคา ---
app.put('/api/quotation/:id', express.json(), async (req: any, res: any) => {
  try {
    const quoteId = req.params.id;
    const { items, total_sum, customer_name, customer_id, contact_id, userId, delivery_days_override } = req.body;
    if (!items) return res.status(400).json({ error: 'Missing items' });

    // วันจัดส่งที่เซลล์แก้เอง — undefined = client เก่าไม่ได้ส่งมา (คงค่าเดิม), null = รีเซ็ตกลับค่าอัตโนมัติ
    let parsedDeliveryOverride: number | null | undefined;
    try {
      const { parseDeliveryDaysOverride } = await import('./services/quotationService.js');
      parsedDeliveryOverride = parseDeliveryDaysOverride(delivery_days_override);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }

    // ตรวจสอบสินค้าที่บล็อก
    const { getBlockedProductError: getBlockedProductErrorPut, validateAndPrepareItems } = await import('./services/quotationService.js');
    const blockedError = await getBlockedProductErrorPut(items);
    if (blockedError) {
      return res.status(400).json({ error: blockedError });
    }

    // Fetch current quotation status and items using pool.query
    const quoteRes = await pool.query(
      'SELECT * FROM quotations WHERE id = $1',
      [quoteId]
    );

    if (quoteRes.rows.length === 0) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    if (!isQuotationOwner(quoteRes.rows[0], userId)) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงใบเสนอราคานี้' });
    }

    const { enrichQuotationData } = await import('./services/quotationService.js');
    const quote = await enrichQuotationData(quoteRes.rows[0]);

    // ยืนยัน/ยกเลิกไปแล้วแก้ไม่ได้ — ตอบ 409 พร้อมสถานะล่าสุด ให้ฝั่ง LIFF reload แทนค้างหน้าเดิม
    if (quote.status === 'confirmed' || quote.status === 'cancelled') {
      return res.status(409).json({
        error: 'ใบเสนอราคานี้ถูกยืนยันหรือยกเลิกไปแล้ว ไม่สามารถแก้ไขได้ กรุณาปิดหน้านี้แล้วเริ่มรายการใหม่',
        status: quote.status,
        quotation_no: quote.quotation_no || null
      });
    }

    // คัดกรองสินค้าใหม่ที่พึ่งเพิ่มเข้ามา (ไม่ได้อยู่ใน quote.items เดิม)
    const existingItemIds = (quote.items || []).map((i: any) => i.product_id).filter(Boolean);
    const newItems = items.filter((i: any) => {
      const id = i.product_id;
      return id && !existingItemIds.includes(id);
    });

    // เรียกใช้ Validation Pipeline เฉพาะสินค้าใหม่
    const { items: expandedNew, errors } = await validateAndPrepareItems(newItems);
    if (errors.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: errors });
    }

    // ประยุกต์ใช้กฎ Qty Sync และลบสินค้าเสริม สำหรับสินค้าเดิมที่ผู้ใช้ส่งกลับมา
    const resultItems: any[] = [];
    const currentOldItems = items.filter((i: any) => {
      const id = i.product_id;
      return id && existingItemIds.includes(id) && !i.is_optional;
    });
    const currentOldOptionals = items.filter((i: any) => {
      const id = i.product_id;
      return id && existingItemIds.includes(id) && i.is_optional;
    });

    for (const oldItem of currentOldItems) {
      resultItems.push(oldItem);
      const linkedOptionals = currentOldOptionals.filter((opt: any) => opt.linked_to_product_id === oldItem.product_id);
      const itemQty = oldItem.quantity ?? oldItem.qty ?? 1;
      linkedOptionals.forEach((opt: any) => {
        opt.qty = itemQty;
        opt.quantity = itemQty;
        resultItems.push(opt);
      });
    }

    // ผนวกรายการสินค้าใหม่ที่ผ่านการตรวจสอบแล้ว
    resultItems.push(...expandedNew);

    // ราคาหลังหักส่วนลดต้องไม่ต่ำกว่าขั้นต่ำ — ตรวจ "ทุกบรรทัด" ไม่ใช่แค่สินค้าที่เพิ่งเพิ่ม
    // เพราะเคสหลักคือผู้ใช้ไปลดราคา/เพิ่มส่วนลดของรายการเดิมในหน้า LIFF
    // (กฎเดียวกับตอนยืนยัน — ดักตั้งแต่ตอนบันทึก จะได้ไม่มีร่างที่ยืนยันไม่ได้ค้างอยู่)
    const minPriceViolations = await checkMinSalesPrice(resultItems, customer_name ?? quote.customer_name);
    if (minPriceViolations.length > 0) {
      return res.status(422).json({ error: 'VALIDATION_ERROR', violations: minPriceViolations });
    }

    // คำนวณราคายอดรวมสุทธิของใบเสนอราคาใหม่
    const finalSum = sumLineTotals(resultItems);

    // --------------------------------------------------
    // BUILD SNAPSHOT FOR UPDATED DATA
    // --------------------------------------------------
    const snapshotItems = await buildItemSnapshots(resultItems);

    let customerDetailsPayload = null;
    let finalStatus = quote.status;
    let resolvedCustomerId = customer_id || quote.customer_id || null;
    let resolvedContactId = contact_id || quote.contact_id || null;

    if (customer_name !== undefined) {
      let companyName = (customer_name || '').trim();
      let contactNameQuery = '';
      let customMeta: any = {};
      let reviseFrom: string | null = null;
      let customMetaStr = '';

      if (customer_name && customer_name.includes(' | ')) {
        const parts = customer_name.split(' | ');
        companyName = parts[0].trim();
        contactNameQuery = parts[1].trim();
        if (parts[2]) {
          customMetaStr = parts.slice(2).join(' | ').trim();
          try {
            customMeta = Object.fromEntries(new URLSearchParams(customMetaStr));
            reviseFrom = customMeta.revise_from || null;
          } catch (err) {
            console.warn(`[PUT /api/quotation/:id] parse metadata ไม่สำเร็จ meta="${customMetaStr}"`, err);
          }
        }
      }

      // ระบบอนุญาตเฉพาะลูกค้าที่มีในฐานข้อมูล — บันทึกโดยไม่ระบุบริษัท/ผู้ติดต่อไม่ได้
      if (!companyName || !contactNameQuery) {
        return res.status(400).json({
          error: 'กรุณาเลือกบริษัทและผู้ติดต่อจากฐานข้อมูลก่อนบันทึก'
        });
      }

      // ผูกลูกค้าได้แล้วถึงจะเลื่อนสถานะเป็นร่างที่ยืนยันได้
      if (quote.status === 'pending_company' || quote.status === 'pending_contact') {
        finalStatus = 'draft';
      }

      let customerCode = '';
      let customerTaxId = '';
      let contactName = contactNameQuery;
      let contactPhone = '';
      let contactEmail = '';
      let contactAddress = '';
      let paymentTerms = '';

      if (companyName) {
        try {
          let custData = null;
          
          // 2.1 ใช้ ID ดึงตรงจาก customers_data_view (ครอบคลุม orphan จาก sale_orders + enrich)
          // เฉพาะ path ที่มี company_id (ID-based) → ใช้ view; path ค้นด้วยชื่อ (2.2) คง customers เพราะเร็วกว่า
          if (resolvedCustomerId && resolvedContactId) {
            const custRes = await pool.query(
              'SELECT * FROM customers_data_view WHERE company_id = $1 AND contact_id = $2 LIMIT 1',
              [resolvedCustomerId, resolvedContactId]
            );
            custData = custRes.rows[0];
          }
          if (resolvedCustomerId && !custData) {
            if (contactNameQuery) {
              const custRes = await pool.query(
                'SELECT * FROM customers_data_view WHERE company_id = $1 AND TRIM(contact_name) = TRIM($2) LIMIT 1',
                [resolvedCustomerId, contactNameQuery]
              );
              custData = custRes.rows[0];
            }
            if (!custData) {
              const custRes = await pool.query(
                'SELECT * FROM customers_data_view WHERE company_id = $1 LIMIT 1',
                [resolvedCustomerId]
              );
              custData = custRes.rows[0];
            }
          }

          // 2.2 Fallback: ค้นหาด้วยชื่อแบบ TRIM
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
            resolvedCustomerId = custData.company_id || resolvedCustomerId;
            resolvedContactId = custData.contact_id || resolvedContactId;
            customerCode = custData.customer_reference || '';
            customerTaxId = custData.customer_tax_id || '';
            contactName = custData.contact_name || contactNameQuery;
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

            // Clean & format address
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
          console.error('Error fetching customer details in PUT API:', err);
        }
      }

      if (customMeta) {
        if (customMeta.tax_id) customerTaxId = customMeta.tax_id;
        if (customMeta.phone) contactPhone = customMeta.phone;
        if (customMeta.email) contactEmail = customMeta.email;
        if (customMeta.address) contactAddress = customMeta.address;
      }

      customerDetailsPayload = {
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
    } else {
      customerDetailsPayload = quote.customer_details;
    }

    // อัปเดตข้อมูลด้วย pool.query
    // เงื่อนไข status กัน TOCTOU: ระหว่าง SELECT ด้านบนกับ UPDATE นี้อาจมี confirm/cancel แทรก
    // ถ้าเขียนทับโดยไม่เช็ค จะดึง status ที่ยืนยันแล้วกลับเป็น draft (rowCount=0 = แพ้ race)
    const updRes = await pool.query(`
      UPDATE quotations
      SET
        total_sum = $1,
        status = $2,
        item_details = $3,
        customer_details = $4,
        customer_id = $5,
        contact_id = $6,
        delivery_days_override = $7,
        updated_at = NOW()
      WHERE id = $8 AND status <> 'confirmed' AND status <> 'cancelled'
    `, [
      finalSum,
      finalStatus,
      JSON.stringify(snapshotItems),
      JSON.stringify(customerDetailsPayload),
      resolvedCustomerId,
      resolvedContactId,
      // ค่าที่เซลล์ตั้งไว้ต้องอยู่ยงแม้จะเพิ่ม/ลบสินค้าหรือแก้จำนวน จนกว่าจะกดรีเซ็ตเอง
      parsedDeliveryOverride === undefined ? (quote.delivery_days_override ?? null) : parsedDeliveryOverride,
      quoteId
    ]);

    if (updRes.rowCount === 0) {
      // มีการยืนยัน/ยกเลิกแทรกระหว่างแก้ไข — ตอบ 409 ให้ฝั่ง LIFF reload แทนค้างหน้าเดิม
      return res.status(409).json({
        error: 'ใบเสนอราคานี้เพิ่งถูกยืนยันหรือยกเลิก ไม่สามารถบันทึกได้ กรุณาปิดหน้านี้แล้วเริ่มรายการใหม่'
      });
    }

    // ค่าขนส่งอัตโนมัติ — คิดจากยอดรวมทุกใบในกลุ่ม จึงต้องทำหลังใบนี้ถูกเขียนลงไปแล้ว
    // (หน้า LIFF บันทึกทีละใบ ใบสุดท้ายที่บันทึกจะเป็นตัวสรุปค่าที่ถูกต้อง)
    const { applyShippingFeeToQuoteGroup } = await import('./services/shippingFee.js');
    await applyShippingFeeToQuoteGroup(quoteRes.rows[0].user_id);

    res.json({ success: true });
  } catch (err: any) {
    console.error("API PUT quotation error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ตรวจว่า userId ที่ส่งมาเป็นเจ้าของใบเสนอราคาจริง
 * คืน true ถ้าใบไม่มีเจ้าของ (user_id หลุดเพราะ FK ON DELETE SET NULL = ข้อมูลเก่า)
 * หมายเหตุ: userId มาจาก request body จึงกันได้แค่ "ยิงผิดใบโดยไม่ตั้งใจ" ยังไม่ใช่ security เต็มรูปแบบ
 * (ต้อง verify LINE ID token ฝั่ง server — อยู่ใน backlog)
 */
function isQuotationOwner(quoteRaw: any, userId: string | undefined): boolean {
  if (!quoteRaw?.user_id) return true;
  return !!userId && quoteRaw.user_id === userId;
}

// --- API: ยืนยันใบเสนอราคา (ออกเลขที่ + เปลี่ยนสถานะ) ---
app.post('/api/quotation/:id/confirm', express.json(), async (req: any, res: any) => {
  try {
    const quoteId = req.params.id;
    const { userId } = req.body;

    const quoteRes = await pool.query('SELECT * FROM quotations WHERE id = $1', [quoteId]);
    const quoteRaw = quoteRes.rows[0];

    if (!quoteRaw) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    if (!isQuotationOwner(quoteRaw, userId)) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงใบเสนอราคานี้' });
    }

    if (quoteRaw.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot confirm a cancelled quotation' });
    }

    // ค่าขนส่งอัตโนมัติ — กันเหนียวก่อนออกเลขจริง เผื่อยอดเปลี่ยนหลังบันทึกครั้งสุดท้าย
    // ไม่แตะใบที่ยืนยัน/ยกเลิกไปแล้ว จึงไม่กระทบ idempotency ของ endpoint นี้
    const { applyShippingFeeToQuoteGroup: applyShippingFeeOnConfirm } = await import('./services/shippingFee.js');
    await applyShippingFeeOnConfirm(quoteRaw.user_id);
    const refreshedRes = await pool.query('SELECT * FROM quotations WHERE id = $1', [quoteId]);
    const quoteAfterFee = refreshedRes.rows[0] || quoteRaw;

    // Enrich ก่อนเพื่อให้ quote.items มีข้อมูลสำหรับตรวจราคาขั้นต่ำและ allocateQuotationNo
    const quote = await enrichQuotationData(quoteAfterFee);

    // กันการยืนยันใบเสนอราคาที่ไม่มีสินค้า (defense-in-depth เผื่อ frontend ถูก bypass)
    if (!quote.items || !Array.isArray(quote.items) || quote.items.length === 0) {
      return res.status(400).json({ error: 'ไม่สามารถยืนยันใบเสนอราคาที่ไม่มีสินค้าได้' });
    }

    // กันการยืนยันใบที่ยังไม่ได้ผูกลูกค้า — เลขที่เอกสารเดินหน้าแล้วย้อนคืนไม่ได้
    // (ใบที่ยืนยันไปแล้วต้องปล่อยผ่านเพื่อคง idempotency ของ endpoint นี้)
    if (quote.status !== 'confirmed' && isCustomerInfoIncomplete(quote)) {
      return res.status(400).json({ error: 'ไม่สามารถยืนยันใบเสนอราคาที่ยังไม่ได้ระบุลูกค้าได้ กรุณาเลือกบริษัทและผู้ติดต่อก่อน' });
    }

    // ราคาหลังหักส่วนลดต้อง >= minimum_sales_price หรือเข้าเงื่อนไขโปรโมชัน (กฎเดียวกับตอนบันทึก)
    let minPriceViolationsOnConfirm;
    try {
      minPriceViolationsOnConfirm = await checkMinSalesPrice(quote.items, quote.customer_name);
    } catch (minPriceErr) {
      console.error("Error fetching minimum_sales_price for confirmation:", minPriceErr);
      return res.status(500).json({ error: 'ไม่สามารถตรวจสอบราคาขั้นต่ำได้' });
    }
    if (minPriceViolationsOnConfirm.length > 0) {
      const v = minPriceViolationsOnConfirm[0];
      return res.status(400).json({
        error: `ไม่สามารถยืนยันได้เนื่องจากราคาหลังหักส่วนลดของสินค้า ${v.model} (฿${v.price.toFixed(2)}) ต่ำกว่าราคาขั้นต่ำที่กำหนด (฿${v.min_price.toFixed(2)}) และไม่เข้าเงื่อนไขโปรโมชันใดๆ`
      });
    }

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const reqUrl = process.env.APP_URL || `${protocol}://${req.get('host')}`;
    if (!process.env.APP_URL) {
      process.env.APP_URL = reqUrl;
      console.log(`>>> Dynamically set APP_URL from confirm API to: ${process.env.APP_URL}`);
    }
    const pdfLink = `${reqUrl}/download-pdf/${quoteId}?openExternalBrowser=1`;

    // ยืนยันแบบ atomic + idempotent (ออกเลข + เปลี่ยน status ใน transaction เดียวพร้อม row lock
    // cancelOldRevision กรณี revision อยู่ใน tx เดียวกัน และไม่เขียนทับ created_at เพราะเลขคำนวณจากมัน)
    let confirmResult;
    try {
      confirmResult = await confirmQuotationAtomic(quoteId, quote);
    } catch (updateError: any) {
      console.error("Confirm quotation error:", updateError);
      return res.status(500).json({ error: updateError.message });
    }

    if (confirmResult.outcome === 'not_found') {
      return res.status(404).json({ error: 'Quotation not found' });
    }
    if (confirmResult.outcome === 'cancelled') {
      return res.status(400).json({ error: 'Cannot confirm a cancelled quotation' });
    }

    // confirmed / already_confirmed → success เหมือนกัน (idempotent)
    console.log(`[Push Disabled] Confirm quotation no: ${confirmResult.quotationNo} for user: ${userId}`);
    res.json({ success: true, quotation_no: confirmResult.quotationNo, pdf_link: pdfLink });
  } catch (err: any) {
    console.error("API POST confirm error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: ยกเลิกใบเสนอราคา ---
app.post('/api/quotation/:id/cancel', express.json(), async (req: any, res: any) => {
  try {
    const quoteId = req.params.id;
    const { userId } = req.body || {};

    const quoteRes = await pool.query(
      'SELECT status, quotation_no, user_id FROM quotations WHERE id = $1',
      [quoteId]
    );

    if (quoteRes.rows.length === 0) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    const quote = quoteRes.rows[0];

    if (!isQuotationOwner(quote, userId)) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงใบเสนอราคานี้' });
    }

    if (quote.status === 'confirmed') {
      return res.status(400).json({ error: 'Cannot cancel a confirmed quotation' });
    }

    if (quote.status === 'cancelled') {
      return res.json({ success: true });
    }

    const hasQuotationNo = quote.quotation_no && quote.quotation_no.trim() !== '';

    if (!hasQuotationNo) {
      await pool.query(
        'DELETE FROM quotations WHERE id = $1',
        [quoteId]
      );
      return res.json({ success: true, deleted: true });
    } else {
      await pool.query(
        "UPDATE quotations SET status = 'cancelled' WHERE id = $1",
        [quoteId]
      );
      return res.json({ success: true });
    }
  } catch (err: any) {
    console.error("API POST cancel error:", err);
    res.status(500).json({ error: err.message });
  }
});


// --- API Endpoint แนะนำสาขาดูแลตามชื่อผู้แนะนำตัว ---
app.get('/api/salesperson/suggest-branches', async (req: any, res: any) => {
  try {
    const name = req.query.name || '';
    if (!name.trim()) return res.json([]);

    const cleanName = name.trim();
    const data = await getCustomerBranchesBySalesperson(cleanName);

    // การกรองแบบเข้มงวด (Strict filtering) ในระดับ JS
    const cleanInput = cleanName.toLowerCase()
      .replace(/^(คุณ|นาย|นางสาว|นาง)\s*/, '')
      .replace(/\s*\(.*?\)\s*$/, '')
      .trim();

    const matchedRows = (data || []).filter((row: any) => {
      if (!row.salesperson) return false;
      const dbClean = row.salesperson.toLowerCase()
        .replace(/^(คุณ|นาย|นางสาว|นาง)\s*/, '')
        .replace(/\s*\(.*?\)\s*$/, '')
        .trim();
      const dbFirstName = dbClean.split(/\s+/)[0];
      return dbClean === cleanInput || dbFirstName === cleanInput;
    });

    const branchCodes = Array.from(new Set(matchedRows.map((row: any) => row.branch_code).filter(Boolean)));
    res.json(branchCodes);
  } catch (err: any) {
    console.error("API GET suggest-branches error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API Endpoint ดึงรายชื่อพนักงานขายทั้งหมดจากฐานข้อมูล ---
app.get('/api/salespeople', async (req: any, res: any) => {
  try {
    const data = await listSalespeopleFromOrders();
    res.json(data);
  } catch (err: any) {
    console.error("API GET salespeople error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API Endpoint ดึงรายการสาขาทั้งหมดจากฐานข้อมูล ---
app.get('/api/branches', async (req: any, res: any) => {
  try {
    const branches = await getBranches();
    res.json(branches);
  } catch (err: any) {
    console.error("API GET branches error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API Endpoint ดึงประวัติสาขาและข้อมูลพนักงาน ---
app.get('/api/salesperson/:userId', async (req: any, res: any) => {
  try {
    const userId = req.params.userId;
    const data = await getSalespersonByUserId(userId);
    const result = data || {};
    res.json(result);
  } catch (err: any) {
    console.error("API GET salesperson error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- API Endpoint บันทึกสาขาและข้อมูลพนักงานขาย (ลงทะเบียนในขั้นตอนเดียว) ---
app.post('/api/salesperson/update-branches', express.json(), async (req: any, res: any) => {
  console.log(">>> POST /api/salesperson/update-branches received! body:", JSON.stringify(req.body, null, 2));
  try {
    const { userId, branchCodes, name, phone, salespersonId } = req.body;
    if (!userId || branchCodes === undefined) {
      return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    // 1. ดึงข้อมูลพนักงานเพื่อดูสถานะปัจจุบัน
    const sp = await getSalespersonByUserId(userId);

    // 2. ข้อมูลพนักงานและบันทึกข้อมูล
    let nextStatus = 'active';
    let isNew = false;
    if (!sp) {
      isNew = true;
    }

    const updateData: any = {
      branch_code: branchCodes,
      status: nextStatus
    };

    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone.trim();
    if (salespersonId !== undefined) updateData.salesperson_id = salespersonId;

    if (isNew) {
      updateData.user_id = userId;
      if (!updateData.name) updateData.name = 'รอดำเนินการ';
      const inserted = await insertSalesperson(updateData);
      if (!inserted) {
        return res.status(500).json({ success: false, message: 'insert salesperson failed' });
      }
    } else {
      const updated = await updateSalespersonByUserId(userId, updateData);
      if (!updated) {
        return res.status(500).json({ success: false, message: 'update salesperson failed' });
      }
    }

    // ส่ง Push Message ไปยังพนักงานขาย เพื่อแสดงรายละเอียดลงทะเบียน
    const selectedCodes = branchCodes ? branchCodes.split(',').map((c: any) => c.trim()).filter(Boolean) : [];
    let branchNames = branchCodes || 'ไม่ได้เลือกสาขา';
    if (selectedCodes.length > 0) {
      try {
        const branches = getBranchesByCodes(selectedCodes);
        if (branches && branches.length > 0) {
          branchNames = branches.map((b: any) => b.name).join(', ');
        }
      } catch (err) {
        console.error("Fetch branches for push notification error:", err);
      }
    }

    // พิจารณาข้อความส่งคืนบอท
    const isRegistering = isNew || !sp || sp.status === 'pending_branch' || sp.status === 'pending_profile' || !sp.name || sp.name === 'รอดำเนินการ';
    let msg = '';
    if (isRegistering) {
      const finalName = name || (sp ? sp.name : 'รอดำเนินการ');
      const finalEmpCode = salespersonId !== undefined ? salespersonId : (sp ? sp.salesperson_id : null);
      const finalPhone = phone !== undefined ? phone : (sp ? sp.phone : null);

      msg = `ลงทะเบียนสำเร็จเรียบร้อยแล้วครับ! 🎉\n\n👤 คุณ: ${finalName}\n🏢 สังกัดสาขา: ${branchNames}`;
      if (finalEmpCode) msg += `\n🆔 รหัสพนักงาน: ${finalEmpCode}`;
      if (finalPhone) msg += `\n📞 เบอร์โทร: ${finalPhone}`;
      msg += `\n\nตอนนี้ระบบพร้อมใช้งานแล้วครับ คุณสามารถพิมพ์สั่งเช็คสต็อกสินค้าหรือพิมพ์ขอให้ออกใบเสนอราคาได้ทันทีครับ 🤖✨`;
    } else {
      const finalName = name !== undefined ? name : (sp ? sp.name : '');
      const finalEmpCode = salespersonId !== undefined ? salespersonId : (sp ? sp.salesperson_id : null);
      const finalPhone = phone !== undefined ? phone : (sp ? sp.phone : null);

      msg = `✅ อัปเดตข้อมูลส่วนตัวและสาขาดูแลสำเร็จเรียบร้อยแล้วครับ!\n\n👤 คุณ: ${finalName}\n🏢 สาขาที่ดูแลในปัจจุบัน: ${branchNames}`;
      if (finalEmpCode) msg += `\n🆔 รหัสพนักงาน: ${finalEmpCode}`;
      if (finalPhone) msg += `\n📞 เบอร์โทร: ${finalPhone}`;
    }

    // Send LINE Push Message branch update confirmation disabled by request (ห้ามใช้ Push Message)
    console.log(`[Push Disabled] Branch update confirmation message for user: ${userId}`);

    res.json({ success: true });
  } catch (err: any) {
    console.error("POST update branches error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});


// --- Endpoint สำหรับสร้างและดาวน์โหลดไฟล์ใบเสนอราคา (PDF) แบบ On-the-fly ---
app.get('/download-pdf/:quoteId', async (req: any, res: any) => {
  try {
    const quoteId = req.params.quoteId;
    
    // 1. ดึงข้อมูลใบเสนอราคาจาก Database ด้วย pool.query
    let quoteDb: any = null;
    try {
      const dbRes = await pool.query('SELECT * FROM quotations WHERE id = $1', [quoteId]);
      quoteDb = dbRes.rows[0];
    } catch (err: any) {
      console.error('Error fetching quotation for PDF:', err);
      return res.status(500).send('Internal Server Error');
    }

    if (!quoteDb) {
      return res.status(404).send('Quotation not found or invalid ID.');
    }

    // Enrich ก่อนเพื่อให้ items มีข้อมูลสำหรับ resolveQuoteCompany ใน allocateQuotationNo และ pdfGenerator
    const enrichedQuote = await enrichQuotationData(quoteDb);

    // ใบที่ยังไม่ยืนยันจะยังไม่มีเลขที่ — แสดง DRAFT แทนการเจนเลขชั่วคราวที่ไม่ถูกบันทึก
    // (ถ้าเจนที่นี่ โหลดซ้ำจะได้คนละเลข และอาจชนกับเลขของใบที่ยืนยันจริงทีหลัง)
    // เลขจริงออกที่จุด confirm เท่านั้น
    const quoteNo = enrichedQuote.quotation_no || 'DRAFT';

    // ดึงข้อมูลพนักงานขาย (Salesperson) เพื่อนำชื่อและเบอร์โทรไปใส่ใน PDF
    let salespersonName = '';
    let salespersonPhone = '';
    let salespersonEmployeeCode = null;
    if (enrichedQuote.user_id) {
      try {
        const spRes = await pool.query(
          'SELECT name, phone, salesperson_id FROM salesperson WHERE user_id = $1 LIMIT 1',
          [enrichedQuote.user_id]
        );
        const spData = spRes.rows[0];
        if (spData) {
          salespersonName = spData.name || '';
          salespersonPhone = spData.phone || '';
          salespersonEmployeeCode = spData.salesperson_id || null;
        }
      } catch (err) {
        console.error('Error fetching salesperson details for PDF:', err);
      }
    }

    enrichedQuote.salesperson_name = salespersonName;
    enrichedQuote.salesperson_phone = salespersonPhone;
    enrichedQuote.salesperson_employee_code = salespersonEmployeeCode;

    // 2. สร้าง PDF สดๆ ณ ตอนดาวน์โหลด
    const pdfBuffer = await generateQuotationPDF(enrichedQuote, quoteNo);

    // 3. ส่งไฟล์ให้หน้าเว็บแสดงผลหรือดาวน์โหลด
    res.setHeader('Content-Disposition', `inline; filename="${quoteNo}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('Generate PDF error:', err);
    res.status(500).send('Internal Server Error');
  }
});


// --- API Endpoint: Admin Login ---
app.post('/api/admin/login', express.json(), async (req: any, res: any) => {
  console.log(">>> POST /api/admin/login received! username:", req.body.username);
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Query admin user from postgres database using the shared pool
    const result = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username.trim()]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const admin = result.rows[0];

    // Verify password with bcryptjs
    const isPasswordValid = await bcrypt.compare(password, admin.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role
      },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role
      }
    });
  } catch (err: any) {
    console.error("Admin Login Error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- API Endpoint: Verify Token (Auth test endpoint) ---
app.get('/api/admin/verify', adminAuthMiddleware, (req: any, res: any) => {
  res.json({ valid: true, admin: req.admin });
});

// --- API Endpoint: Upload Signature ---
app.post('/api/admin/signatures/upload', adminAuthMiddleware, express.json({ limit: '10mb' }), async (req: any, res: any) => {
  console.log(">>> POST /api/admin/signatures/upload received!");
  try {
    const { salespersonId, image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Missing required parameter: image' });
    }

    // ลายเซ็นพนักงานขายผูกกับ salesperson_id (ลายเซ็นรายบุคคล)
    if (!salespersonId) {
      return res.status(400).json({ error: 'Missing required parameter: salespersonId' });
    }
    // Check if salesperson exists in the salesperson table
    const checkRes = await pool.query('SELECT name FROM salesperson WHERE salesperson_id = $1', [salespersonId.trim()]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: `Salesperson with ID "${salespersonId}" not found in database.` });
    }
    const fileKey = salespersonId.trim();

    // Decode base64 image
    const matches = image.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: 'Invalid image format. Must be a base64 image data URL.' });
    }

    const ext = matches[1].toLowerCase();
    const dataBuffer = Buffer.from(matches[2], 'base64');

    // Enforce PNG or JPG format (Support PNG and JPG as requested)
    let cleanExt = ext;
    if (ext === 'jpeg') {
      cleanExt = 'jpg';
    }
    if (cleanExt !== 'png' && cleanExt !== 'jpg') {
      return res.status(400).json({ error: 'Only PNG and JPG/JPEG images are allowed for signatures.' });
    }

    const dir = 'sale_sigs';
    const targetDir = path.join(process.cwd(), 'data', dir);

    // Clean up alternate extensions first to avoid duplicate active files
    const alternateExts = ['.png', '.jpg', '.jpeg'];
    alternateExts.forEach(currExt => {
      const oldPath = path.join(targetDir, `${fileKey}${currExt}`);
      if (fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch (err) {
          console.error(`Failed to clean up old signature file: ${oldPath}`, err);
        }
      }
    });

    const targetPath = path.join(targetDir, `${fileKey}.${cleanExt}`);

    // Ensure the folder exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Save image to disk
    fs.writeFileSync(targetPath, dataBuffer);
    console.log(`Successfully saved signature to: ${targetPath}`);

    res.json({
      success: true,
      message: `Signature uploaded successfully as ${fileKey}.${cleanExt}`,
      key: fileKey,
      path: `/data/${dir}/${fileKey}.${cleanExt}`
    });
  } catch (err: any) {
    console.error("Signature Upload Error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- API Endpoint: Get All Salespersons with Signature Status ---
app.get('/api/admin/salespersons', adminAuthMiddleware, async (req: any, res: any) => {
  console.log(">>> GET /api/admin/salespersons received!");
  try {
    const result = await pool.query('SELECT user_id, name, status, phone, salesperson_id, branch, created_at, updated_at FROM salesperson ORDER BY name ASC');

    const saleSigsDir = path.join(process.cwd(), 'data', 'sale_sigs');
    const extensions = ['.png', '.jpg', '.jpeg'];

    const salespersons = result.rows.map((row: any) => {
      const spId = row.salesperson_id ? String(row.salesperson_id).trim() : null;
      let has_sale_sig = false;

      if (spId) {
        // Check if salesperson has signature
        has_sale_sig = extensions.some(ext => {
          const filepath = path.join(saleSigsDir, `${spId}${ext}`);
          return fs.existsSync(filepath);
        });
      }

      return {
        ...row,
        has_sale_sig
      };
    });

    res.json(salespersons);
  } catch (err: any) {
    console.error("GET salespersons error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- API Endpoint: Dashboard stats (counts for summary cards) ---
app.get('/api/admin/stats', adminAuthMiddleware, async (req: any, res: any) => {
  console.log(">>> GET /api/admin/stats received!");
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM quotations)             AS quotations,
        (SELECT COUNT(*) FROM promotions)             AS promotions,
        (SELECT COUNT(*) FROM salesperson)            AS salespersons,
        (SELECT COUNT(*) FROM quotation_rules)        AS quotation_rules,
        (SELECT COUNT(*) FROM product_optional_links) AS optional_links,
        (SELECT COUNT(*) FROM product_stock_rules)    AS stock_rules,
        (SELECT COUNT(*) FROM product_moq_rules)      AS moq_rules
    `);
    const row = result.rows[0];
    // COUNT(*) returns a string in pg — convert to number
    res.json({
      quotations: Number(row.quotations),
      promotions: Number(row.promotions),
      salespersons: Number(row.salespersons),
      quotation_rules: Number(row.quotation_rules),
      optional_links: Number(row.optional_links),
      stock_rules: Number(row.stock_rules),
      moq_rules: Number(row.moq_rules),
    });
  } catch (err: any) {
    console.error("GET /api/admin/stats error:", err);
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลสรุปได้' });
  }
});

// --- API Endpoint: Sync status (run-state + per-resource last-synced + schedule config) ---
app.get('/api/admin/sync/status', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const status = await getSyncStatus();
    res.json(status);
  } catch (err: any) {
    console.error('GET /api/admin/sync/status error:', err);
    res.status(500).json({ error: 'ไม่สามารถดึงสถานะการ sync ได้' });
  }
});

// --- API Endpoint: Trigger a sync now (manual) ---
app.post('/api/admin/sync/run', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const raw = req.body?.resources;
    // รับ ['products',...] หรือ 'all' (แปลว่าทั้งหมด)
    const resources: string[] =
      raw === 'all' || raw === undefined
        ? [...RESOURCE_IDS]
        : Array.isArray(raw)
        ? raw.filter(isValidResource)
        : [];

    if (resources.length === 0) {
      return res.status(400).json({ error: 'ไม่พบรายการข้อมูลที่จะ sync ที่ถูกต้อง' });
    }

    if (isRunning()) {
      return res.status(409).json({ error: 'มีการ sync กำลังทำงานอยู่ กรุณารอให้เสร็จก่อน' });
    }

    const started = startSync(resources as any, 'manual');
    if (!started) {
      return res.status(409).json({ error: 'ไม่สามารถเริ่ม sync ได้ (อาจกำลังทำงานอยู่)' });
    }

    const status = await getSyncStatus();
    res.status(202).json({ message: 'เริ่ม sync แล้ว', ...status });
  } catch (err: any) {
    console.error('POST /api/admin/sync/run error:', err);
    res.status(500).json({ error: 'ไม่สามารถเริ่ม sync ได้' });
  }
});

// --- API Endpoint: Save auto-sync schedule settings ---
app.put('/api/admin/sync/settings', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const settings = await saveSyncSettings(req.body || {});
    res.json({ message: 'บันทึกการตั้งค่าสำเร็จ', settings });
  } catch (err: any) {
    console.error('PUT /api/admin/sync/settings error:', err);
    res.status(500).json({ error: 'ไม่สามารถบันทึกการตั้งค่าได้' });
  }
});

// --- API Endpoint: Delete Signature ---
app.delete('/api/admin/signatures/:salespersonId', adminAuthMiddleware, async (req: any, res: any) => {
  const { salespersonId } = req.params;
  console.log(`>>> DELETE /api/admin/signatures/${salespersonId} received!`);
  try {
    const dir = 'sale_sigs';
    const targetDir = path.join(process.cwd(), 'data', dir);
    const extensions = ['.png', '.jpg', '.jpeg'];
    let deletedCount = 0;

    extensions.forEach(ext => {
      const filepath = path.join(targetDir, `${salespersonId.trim()}${ext}`);
      if (fs.existsSync(filepath)) {
        try {
          fs.unlinkSync(filepath);
          deletedCount++;
        } catch (err) {
          console.error(`Failed to delete file: ${filepath}`, err);
        }
      }
    });

    if (deletedCount === 0) {
      return res.status(404).json({ error: `Signature file for salesperson "${salespersonId}" was not found.` });
    }

    res.json({
      success: true,
      message: `Successfully deleted ${deletedCount} signature file(s) for salesperson "${salespersonId}"`
    });
  } catch (err: any) {
    console.error("DELETE signature error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- API Endpoints: Promotions CRUD ---

// 1. GET /api/admin/promotions - Get all promotions
app.get('/api/admin/promotions', adminAuthMiddleware, async (req: any, res: any) => {
  console.log(">>> GET /api/admin/promotions received!");
  try {
    const result = await pool.query('SELECT * FROM promotions ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err: any) {
    console.error("GET promotions error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- API Endpoint: Export promotions to CSV ---
app.get('/api/admin/promotions/export', adminAuthMiddleware, async (req: any, res: any) => {
  const code = req.query.code;
  console.log(`>>> GET /api/admin/promotions/export received! code: ${code || 'all'}`);
  try {
    let queryText = 'SELECT * FROM promotions';
    const params: any[] = [];
    if (code) {
      queryText += ' WHERE code = $1';
      params.push(String(code).trim());
    }
    queryText += ' ORDER BY created_at DESC';

    const result = await pool.query(queryText, params);

    const csvRows: any[] = [];
    for (const promo of result.rows) {
      const products = promo.product_code ? promo.product_code.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
      const customerTypes = promo.customer_type ? promo.customer_type.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
      const customerRefs = promo.customer_refs ? promo.customer_refs.split(',').map((s: string) => s.trim()).filter(Boolean) : [];

      const maxLines = Math.max(products.length, customerTypes.length, customerRefs.length, 1);

      for (let i = 0; i < maxLines; i++) {
        csvRows.push({
          code: promo.code,
          name: promo.name,
          description: promo.description || '',
          discount_type: promo.discount_type,
          discount_value: Number(promo.discount_value),
          product_code: products[i] || '',
          customer_type: customerTypes[i] || '',
          customer_refs: customerRefs[i] || '',
          min_qty: promo.min_qty,
          start_date: promo.start_date ? new Date(promo.start_date).toISOString().split('T')[0] : '',
          end_date: promo.end_date ? new Date(promo.end_date).toISOString().split('T')[0] : '',
          is_active: promo.is_active ? 'TRUE' : 'FALSE'
        });
      }
    }

    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(csvRows);

    // Add UTF-8 BOM for Thai characters
    const bom = '\uFEFF';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    const filename = code 
      ? `promotion_${String(code).trim()}_export_${new Date().toISOString().split('T')[0]}.csv`
      : `promotions_export_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bom + csv);
  } catch (err: any) {
    console.error("GET /api/admin/promotions/export error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. GET /api/admin/promotions/:id - Get specific promotion
app.get('/api/admin/promotions/:id', adminAuthMiddleware, async (req: any, res: any) => {
  const { id } = req.params;
  console.log(`>>> GET /api/admin/promotions/${id} received!`);
  try {
    const result = await pool.query('SELECT * FROM promotions WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promotion not found' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error("GET promotion by ID error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. POST /api/admin/promotions - Create new promotion
app.post('/api/admin/promotions', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  console.log(">>> POST /api/admin/promotions received! body:", JSON.stringify(req.body, null, 2));
  try {
    const {
      code,
      name,
      description,
      discount_type,
      discount_value,
      product_code,
      customer_type,
      customer_refs,
      min_qty,
      start_date,
      end_date,
      is_active
    } = req.body;

    if (!code || !name || !discount_type || discount_value === undefined) {
      return res.status(400).json({ error: 'Missing required fields (code, name, discount_type, discount_value)' });
    }

    if (discount_type !== 'percent' && discount_type !== 'fixed' && discount_type !== 'override') {
      return res.status(400).json({ error: 'Invalid discount_type. Must be "percent", "fixed", or "override"' });
    }

    // Check if code is unique
    const checkRes = await pool.query('SELECT id FROM promotions WHERE code = $1', [code.trim()]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: `Promotion code "${code}" already exists.` });
    }

    const queryText = `
      INSERT INTO promotions (
        code, name, description, discount_type, discount_value, 
        product_code, customer_type, customer_refs, min_qty, start_date, end_date, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const values = [
      code.trim(),
      name.trim(),
      description || null,
      discount_type,
      discount_value,
      product_code || null,
      customer_type || null,
      customer_refs || null,
      min_qty !== undefined ? min_qty : 0,
      start_date || null,
      end_date || null,
      is_active !== undefined ? is_active : true
    ];

    const result = await pool.query(queryText, values);
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    console.error("POST create promotion error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. PUT /api/admin/promotions/:id - Update promotion
app.put('/api/admin/promotions/:id', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  const { id } = req.params;
  console.log(`>>> PUT /api/admin/promotions/${id} received! body:`, JSON.stringify(req.body, null, 2));
  try {
    const {
      code,
      name,
      description,
      discount_type,
      discount_value,
      product_code,
      customer_type,
      customer_refs,
      min_qty,
      start_date,
      end_date,
      is_active
    } = req.body;

    if (!code || !name || !discount_type || discount_value === undefined) {
      return res.status(400).json({ error: 'Missing required fields (code, name, discount_type, discount_value)' });
    }

    if (discount_type !== 'percent' && discount_type !== 'fixed' && discount_type !== 'override') {
      return res.status(400).json({ error: 'Invalid discount_type. Must be "percent", "fixed", or "override"' });
    }

    // Check if code is unique (excluding current ID)
    const checkRes = await pool.query('SELECT id FROM promotions WHERE code = $1 AND id != $2', [code.trim(), id]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: `Promotion code "${code}" is already in use by another promotion.` });
    }

    const queryText = `
      UPDATE promotions SET 
        code = $1, 
        name = $2, 
        description = $3, 
        discount_type = $4, 
        discount_value = $5, 
        product_code = $6, 
        customer_type = $7, 
        customer_refs = $8, 
        min_qty = $9, 
        start_date = $10, 
        end_date = $11, 
        is_active = $12, 
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = $13 
      RETURNING *
    `;

    const values = [
      code.trim(),
      name.trim(),
      description || null,
      discount_type,
      discount_value,
      product_code || null,
      customer_type || null,
      customer_refs || null,
      min_qty !== undefined ? min_qty : 0,
      start_date || null,
      end_date || null,
      is_active !== undefined ? is_active : true,
      id
    ];

    const result = await pool.query(queryText, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promotion not found' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error("PUT update promotion error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 5. DELETE /api/admin/promotions/:id - Delete promotion
app.delete('/api/admin/promotions/:id', adminAuthMiddleware, async (req: any, res: any) => {
  const { id } = req.params;
  console.log(`>>> DELETE /api/admin/promotions/${id} received!`);
  try {
    const result = await pool.query('DELETE FROM promotions WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promotion not found' });
    }
    res.json({ success: true, message: 'Promotion deleted successfully', deletedPromotion: result.rows[0] });
  } catch (err: any) {
    console.error("DELETE promotion error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- API Endpoint: Import promotions from JSON array ---
app.post('/api/admin/promotions/import', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  console.log(">>> POST /api/admin/promotions/import received! count:", req.body?.length);
  try {
    const promotions = req.body;
    if (!Array.isArray(promotions) || promotions.length === 0) {
      return res.status(400).json({ error: 'Request body must be a non-empty array of promotion objects' });
    }

    const results: { upserted: number; errors: string[] } = { upserted: 0, errors: [] };

    for (const promo of promotions) {
      try {
        const {
          code,
          name,
          description,
          discount_type,
          discount_value,
          product_code,
          customer_type,
          customer_refs,
          min_qty,
          start_date,
          end_date,
          is_active
        } = promo;

        if (!code || !name || !discount_type || discount_value === undefined) {
          results.errors.push(`Promotion "${code || 'unknown'}": Missing required fields`);
          continue;
        }

        if (discount_type !== 'percent' && discount_type !== 'fixed' && discount_type !== 'override') {
          results.errors.push(`Promotion "${code}": Invalid discount_type "${discount_type}"`);
          continue;
        }

        // Upsert using code as the unique key
        await pool.query(`
          INSERT INTO promotions (code, name, description, discount_type, discount_value, product_code, customer_type, customer_refs, min_qty, start_date, end_date, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (code) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            discount_type = EXCLUDED.discount_type,
            discount_value = EXCLUDED.discount_value,
            product_code = EXCLUDED.product_code,
            customer_type = EXCLUDED.customer_type,
            customer_refs = EXCLUDED.customer_refs,
            min_qty = EXCLUDED.min_qty,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            is_active = EXCLUDED.is_active,
            updated_at = CURRENT_TIMESTAMP
        `, [
          code.trim(),
          name.trim(),
          description || null,
          discount_type,
          discount_value,
          product_code || null,
          customer_type || null,
          customer_refs || null,
          min_qty !== undefined ? min_qty : 0,
          start_date || null,
          end_date || null,
          is_active !== undefined ? is_active : true
        ]);

        results.upserted++;
      } catch (err: any) {
        results.errors.push(`Promotion "${promo.code || 'unknown'}": ${err.message}`);
      }
    }

    res.json({
      success: true,
      message: `Imported ${results.upserted} promotion(s) successfully${results.errors.length > 0 ? ` with ${results.errors.length} error(s)` : ''}`,
      results
    });
  } catch (err: any) {
    console.error("POST /api/admin/promotions/import error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================
//  API Endpoints: Quotation Rules (จัดการเงื่อนไขใบเสนอราคา)
// ============================================================

// 1. GET /api/admin/quotation-rules/options - ดึงข้อมูลตัวเลือกสำหรับแอดมิน (ฝ่ายผลิต, ยี่ห้อ, ซีรีส์)
app.get('/api/admin/quotation-rules/options', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const prodRes = await pool.query("SELECT DISTINCT production FROM products WHERE production IS NOT NULL AND production != '' ORDER BY production");
    const brandRes = await pool.query("SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != '' ORDER BY brand");
    const seriesRes = await pool.query("SELECT DISTINCT series FROM products WHERE series IS NOT NULL AND series != '' ORDER BY series");
    const relationsRes = await pool.query(
      `SELECT DISTINCT production, brand, series 
       FROM products 
       WHERE (production IS NOT NULL AND production != '')
          OR (brand IS NOT NULL AND brand != '')
          OR (series IS NOT NULL AND series != '')`
    );
    
    res.json({
      productions: prodRes.rows.map(r => r.production),
      brands: brandRes.rows.map(r => r.brand),
      series: seriesRes.rows.map(r => r.series),
      relations: relationsRes.rows
    });
  } catch (err: any) {
    console.error("Get quotation rules options error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. GET /api/admin/quotation-rules - ดึงรายการกฎเงื่อนไขทั้งหมด
app.get('/api/admin/quotation-rules', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const result = await pool.query('SELECT * FROM quotation_rules ORDER BY production NULLS LAST, brand NULLS LAST, series NULLS LAST, id');
    res.json(result.rows);
  } catch (err: any) {
    console.error("Get quotation rules error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// วันจัดส่งตามจำนวน (tier) — ว่าง/null = ไม่ใช้ tier ต้องเก็บเป็น NULL ไม่ใช่ 0
// คืน undefined เมื่อค่าที่ส่งมาไม่ถูกต้อง เพื่อให้ผู้เรียกตอบ 400 ได้
function parseDeliveryQtyDays(raw: any): number | null | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

// 3. POST /api/admin/quotation-rules - สร้างกฎเงื่อนไขใหม่
app.post('/api/admin/quotation-rules', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  const { production, brand, series, quote_company, warranty_years, warranty_unit, is_locked, delivery_in_stock_days, delivery_out_of_stock_days,
    delivery_days_qty_10, delivery_days_qty_20, delivery_days_qty_50, delivery_days_qty_100 } = req.body;

  if (warranty_unit && !['month', 'year'].includes(warranty_unit)) {
    return res.status(400).json({ error: 'warranty_unit must be "month" or "year"' });
  }

  const qtyDays = [delivery_days_qty_10, delivery_days_qty_20, delivery_days_qty_50, delivery_days_qty_100].map(parseDeliveryQtyDays);
  if (qtyDays.some(v => v === undefined)) {
    return res.status(400).json({ error: 'วันจัดส่งตามจำนวนต้องเป็นจำนวนเต็ม 0 ขึ้นไป หรือเว้นว่าง' });
  }

  try {
    // Check duplication
    const checkQuery = `
      SELECT id FROM quotation_rules 
      WHERE COALESCE(production, '') = COALESCE($1, '') 
        AND COALESCE(brand, '') = COALESCE($2, '') 
        AND COALESCE(series, '') = COALESCE($3, '')
    `;
    const checkRes = await pool.query(checkQuery, [production || null, brand || null, series || null]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: 'มีเงื่อนไขของฝ่ายผลิต ยี่ห้อ หรือซีรีส์นี้อยู่ในระบบแล้ว' });
    }

    const insertQuery = `
      INSERT INTO quotation_rules
        (production, brand, series, quote_company, warranty_years, warranty_unit, is_locked, delivery_in_stock_days, delivery_out_of_stock_days,
         delivery_days_qty_10, delivery_days_qty_20, delivery_days_qty_50, delivery_days_qty_100)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;
    const result = await pool.query(insertQuery, [
      production || null,
      brand || null,
      series || null,
      quote_company || null,
      warranty_years !== undefined ? parseInt(warranty_years) : 1,
      warranty_unit || 'year',
      is_locked || false,
      delivery_in_stock_days !== undefined ? parseInt(delivery_in_stock_days) : 3,
      delivery_out_of_stock_days !== undefined ? parseInt(delivery_out_of_stock_days) : 7,
      ...qtyDays
    ]);
    invalidateRuleCache('quotation_rules');
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    console.error("Create quotation rule error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 4. PUT /api/admin/quotation-rules/:id - แก้ไขกฎเงื่อนไข
app.put('/api/admin/quotation-rules/:id', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  const { id } = req.params;
  const { production, brand, series, quote_company, warranty_years, warranty_unit, is_locked, delivery_in_stock_days, delivery_out_of_stock_days,
    delivery_days_qty_10, delivery_days_qty_20, delivery_days_qty_50, delivery_days_qty_100 } = req.body;

  if (warranty_unit && !['month', 'year'].includes(warranty_unit)) {
    return res.status(400).json({ error: 'warranty_unit must be "month" or "year"' });
  }

  const qtyDays = [delivery_days_qty_10, delivery_days_qty_20, delivery_days_qty_50, delivery_days_qty_100].map(parseDeliveryQtyDays);
  if (qtyDays.some(v => v === undefined)) {
    return res.status(400).json({ error: 'วันจัดส่งตามจำนวนต้องเป็นจำนวนเต็ม 0 ขึ้นไป หรือเว้นว่าง' });
  }

  try {
    // Check duplication excluding current ID
    const checkQuery = `
      SELECT id FROM quotation_rules 
      WHERE COALESCE(production, '') = COALESCE($1, '') 
        AND COALESCE(brand, '') = COALESCE($2, '') 
        AND COALESCE(series, '') = COALESCE($3, '')
        AND id != $4
    `;
    const checkRes = await pool.query(checkQuery, [production || null, brand || null, series || null, id]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: 'มีเงื่อนไขของฝ่ายผลิต ยี่ห้อ หรือซีรีส์นี้อยู่ในระบบแล้ว' });
    }

    const updateQuery = `
      UPDATE quotation_rules SET
        production = $1,
        brand = $2,
        series = $3,
        quote_company = $4,
        warranty_years = $5,
        warranty_unit = $6,
        is_locked = $7,
        delivery_in_stock_days = $8,
        delivery_out_of_stock_days = $9,
        delivery_days_qty_10 = $10,
        delivery_days_qty_20 = $11,
        delivery_days_qty_50 = $12,
        delivery_days_qty_100 = $13,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $14
      RETURNING *
    `;
    const result = await pool.query(updateQuery, [
      production || null,
      brand || null,
      series || null,
      quote_company || null,
      warranty_years !== undefined ? parseInt(warranty_years) : 1,
      warranty_unit || 'year',
      is_locked || false,
      delivery_in_stock_days !== undefined ? parseInt(delivery_in_stock_days) : 3,
      delivery_out_of_stock_days !== undefined ? parseInt(delivery_out_of_stock_days) : 7,
      ...qtyDays,
      id
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบเงื่อนไขใบเสนอราคาที่ต้องการแก้ไข' });
    }
    invalidateRuleCache('quotation_rules');
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error("Update quotation rule error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 5. DELETE /api/admin/quotation-rules/:id - ลบกฎเงื่อนไข
app.delete('/api/admin/quotation-rules/:id', adminAuthMiddleware, async (req: any, res: any) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM quotation_rules WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบเงื่อนไขใบเสนอราคาที่ต้องการลบ' });
    }
    invalidateRuleCache('quotation_rules');
    res.json({ success: true, message: 'ลบเงื่อนไขใบเสนอราคาสำเร็จ', deletedRule: result.rows[0] });
  } catch (err: any) {
    console.error("Delete quotation rule error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================
//  API Endpoints: Shipping Fee Config (ค่าขนส่งอัตโนมัติ)
//  ตารางนี้มีแถวเดียว (id = 1) จึงไม่มี POST/DELETE — มีแค่ GET กับ PUT
// ============================================================

app.get('/api/admin/shipping-fee-config', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, p.product_template_id, p.model, p.name AS product_name,
             p.product_group, p.product_category, p.product_sub_category
        FROM shipping_fee_config c
        LEFT JOIN LATERAL (
          SELECT product_template_id, model, name, product_group, product_category, product_sub_category
            FROM products
           WHERE internal_reference = c.product_internal_reference AND is_system_item = true
           ORDER BY product_template_id
           LIMIT 1
        ) p ON true
       WHERE c.id = 1
    `);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'ยังไม่มีค่าตั้งค่าค่าขนส่ง — ต้องรัน migration 2026-07-22_01_shipping_fee.sql ก่อน' });
    }
    res.json(rows[0]);
  } catch (err: any) {
    console.error('GET /api/admin/shipping-fee-config error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.put('/api/admin/shipping-fee-config', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const { is_active, threshold_before_vat, fee_price, fee_quantity, default_item_name } = req.body;

    const threshold = Number(threshold_before_vat);
    const price = Number(fee_price);
    const qty = Number(fee_quantity);
    const name = String(default_item_name ?? '').trim();

    // ตรวจฝั่ง server ด้วย ไม่พึ่งแค่ฟอร์ม (CHECK constraint เป็นด่านสุดท้าย แต่ error จะอ่านไม่รู้เรื่อง)
    if (!Number.isFinite(threshold) || threshold < 0) {
      return res.status(400).json({ error: 'เกณฑ์ยอดก่อน VAT ต้องเป็นตัวเลขไม่ติดลบ' });
    }
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'ราคาค่าขนส่งต้องเป็นตัวเลขไม่ติดลบ' });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'จำนวนต้องมากกว่า 0' });
    }
    if (!name) {
      return res.status(400).json({ error: 'ต้องระบุชื่อรายการตั้งต้น' });
    }

    const { rows } = await pool.query(`
      UPDATE shipping_fee_config
         SET is_active = $1, threshold_before_vat = $2, fee_price = $3,
             fee_quantity = $4, default_item_name = $5, updated_at = NOW()
       WHERE id = 1
       RETURNING *
    `, [is_active !== false, threshold, price, qty, name]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'ยังไม่มีค่าตั้งค่าค่าขนส่ง — ต้องรัน migration ก่อน' });
    }

    // ต้องล้าง cache ทันที ไม่งั้นค่าที่เพิ่งบันทึกจะยังไม่มีผลไปอีกไม่เกิน 60 วินาที
    invalidateRuleCache('shipping_fee_config');

    res.json(rows[0]);
  } catch (err: any) {
    console.error('PUT /api/admin/shipping-fee-config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API Endpoints: Products and Customers Search (for Promotions Modal) ---

// 1. GET /api/admin/products/search - Search product models
app.get('/api/admin/products/search', adminAuthMiddleware, async (req: any, res: any) => {
  const query = req.query.q || '';
  try {
    const result = await pool.query(
      `SELECT DISTINCT model
       FROM products
       WHERE model IS NOT NULL AND model != '' AND model ILIKE $1
         AND is_system_item = false
       ORDER BY model
       LIMIT 30`,
      [`%${query}%`]
    );
    res.json(result.rows.map(row => row.model));
  } catch (err: any) {
    console.error("Search products error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. GET /api/admin/customers/search - Search customers by reference or display_name
app.get('/api/admin/customers/search', adminAuthMiddleware, async (req: any, res: any) => {
  const query = req.query.q || '';
  try {
    const result = await pool.query(
      `SELECT DISTINCT customer_reference AS reference, customer_name AS display_name 
       FROM customers 
       WHERE (customer_reference IS NOT NULL AND customer_reference != '' AND customer_reference ILIKE $1)
          OR (customer_name IS NOT NULL AND customer_name != '' AND customer_name ILIKE $1)
       ORDER BY customer_name 
       LIMIT 30`,
      [`%${query}%`]
    );
    res.json(result.rows);
  } catch (err: any) {
    console.error("Search customers error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. GET /api/admin/customers/types - Search customer types
app.get('/api/admin/customers/types', adminAuthMiddleware, async (req: any, res: any) => {
  const query = req.query.q || '';
  try {
    const result = await pool.query(
      `SELECT DISTINCT customer_type 
       FROM customers 
       WHERE customer_type IS NOT NULL AND customer_type != '' AND customer_type ILIKE $1 
       ORDER BY customer_type 
       LIMIT 30`,
      [`%${query}%`]
    );
    res.json(result.rows.map(row => row.customer_type));
  } catch (err: any) {
    console.error("Search customer types error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- API Endpoint: Admin Quotations List (with search, filter, pagination) ---
app.get('/api/admin/quotations', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const search = req.query.search || '';
    const status = req.query.status || '';
    const dateFrom = req.query.dateFrom || '';
    const dateTo = req.query.dateTo || '';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    // Validate sort fields and direction to prevent SQL injection
    const allowedSortFields: Record<string, string> = {
      quotation_no: 'q.quotation_no',
      created_at: 'q.created_at',
      customer_name: "(q.customer_details->>'customer_name')",
      salesperson_name: 's.name',
      total_sum: 'q.total_sum',
      status: 'q.status'
    };

    const sortByParam = req.query.sortBy || 'created_at';
    const sortOrderParam = String(req.query.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortBy = allowedSortFields[sortByParam] || 'q.created_at';

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (search.trim()) {
      conditions.push(`(q.quotation_no ILIKE $${paramIndex} OR (q.customer_details->>'customer_name') ILIKE $${paramIndex} OR s.name ILIKE $${paramIndex})`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    if (status.trim()) {
      conditions.push(`q.status = $${paramIndex}`);
      params.push(status.trim());
      paramIndex++;
    }

    if (dateFrom.trim()) {
      conditions.push(`q.created_at >= $${paramIndex}`);
      params.push(dateFrom.trim());
      paramIndex++;
    }

    if (dateTo.trim()) {
      conditions.push(`q.created_at <= $${paramIndex}`);
      params.push(dateTo.trim());
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total
    const countResult = await pool.query(`SELECT COUNT(*) FROM quotations q LEFT JOIN salesperson s ON q.user_id = s.user_id ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    // Fetch data with LEFT JOIN to get salesperson info directly
    const dataResult = await pool.query(
      `SELECT q.*, s.name AS salesperson_name, s.phone AS salesperson_phone, s.salesperson_id AS salesperson_employee_code FROM quotations q LEFT JOIN salesperson s ON q.user_id = s.user_id ${whereClause} ORDER BY ${sortBy} ${sortOrderParam} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    // Enrich with customer data
    const enrichedData = await Promise.all(
      (dataResult.rows || []).map((q: any) => enrichQuotationData(q))
    );

    // Ensure salesperson fields are set (fallback to '' if null from LEFT JOIN)
    const dataWithSalesperson = enrichedData.map((q: any) => ({
      ...q,
      salesperson_name: q.salesperson_name || '',
      salesperson_phone: q.salesperson_phone || '',
      salesperson_employee_code: q.salesperson_employee_code || null,
    }));

    res.json({ data: dataWithSalesperson, total });
  } catch (err: any) {
    console.error("GET /api/admin/quotations error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- API Endpoint: Admin Quotations Export (format นำเข้า Sale Order ของ Odoo) ---
//
// 1 แถว = 1 รายการสินค้า ตาม template "24.Sale order.xlsx" — ดูรายละเอียดการ map
// ที่ services/odooSaleOrderExport.ts (จุดเดียวที่รู้เรื่อง format นี้)
app.get('/api/admin/quotations/export', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const search = req.query.search || '';
    // ใบที่ยังไม่ยืนยันไม่ควรกลายเป็นใบสั่งขายใน Odoo — ค่าตั้งต้นจึงเป็น confirmed
    // แอดมินเปลี่ยนได้ด้วยตัวกรองสถานะบนหน้าจอ (ส่ง status มาตรง ๆ)
    const status = req.query.status || 'confirmed';
    const dateFrom = req.query.dateFrom || '';
    const dateTo = req.query.dateTo || '';
    const format: OdooExportFormat = req.query.format === 'csv' ? 'csv' : 'xlsx';

    // Validate sort fields and direction to prevent SQL injection
    const allowedSortFields: Record<string, string> = {
      quotation_no: 'q.quotation_no',
      created_at: 'q.created_at',
      customer_name: "(q.customer_details->>'customer_name')",
      salesperson_name: 's.name',
      total_sum: 'q.total_sum',
      status: 'q.status'
    };

    const sortByParam = req.query.sortBy || 'created_at';
    const sortOrderParam = String(req.query.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortBy = allowedSortFields[sortByParam] || 'q.created_at';

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (search.trim()) {
      conditions.push(`(q.quotation_no ILIKE $${paramIndex} OR (q.customer_details->>'customer_name') ILIKE $${paramIndex} OR s.name ILIKE $${paramIndex})`);
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    if (status.trim()) {
      conditions.push(`q.status = $${paramIndex}`);
      params.push(status.trim());
      paramIndex++;
    }

    if (dateFrom.trim()) {
      conditions.push(`q.created_at >= $${paramIndex}`);
      params.push(dateFrom.trim());
      paramIndex++;
    }

    if (dateTo.trim()) {
      conditions.push(`q.created_at <= $${paramIndex}`);
      params.push(dateTo.trim());
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT q.created_at, q.customer_details, q.item_details, q.employee_details,
              s.name AS salesperson_name, s.branch AS salesperson_branch
         FROM quotations q
         LEFT JOIN salesperson s ON q.user_id = s.user_id
         ${whereClause}
        ORDER BY ${sortBy} ${sortOrderParam}`,
      params
    );

    // ไม่เรียก enrichQuotationData() ที่นี่ — format นี้ไม่ใช้สต๊อกสด/วันจัดส่ง/กฎโปรโมชัน
    // และ enrich ยิง query หลายครั้งต่อใบ ทำให้ export หลายร้อยใบช้าโดยไม่จำเป็น
    const quotes = result.rows || [];
    const uomMap = await getProductUomByTemplateIds(collectProductTemplateIds(quotes));
    const rows = buildOdooSaleOrderRows(quotes, uomMap, loadOdooExportConfig());

    const stamp = new Date().toISOString().split('T')[0];
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="sale_order_odoo_${stamp}.csv"`);
      res.send(serializeOdooRowsToCsv(rows));
      return;
    }

    const xlsx = await serializeOdooRowsToXlsx(rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sale_order_odoo_${stamp}.xlsx"`);
    res.send(xlsx);
  } catch (err: any) {
    console.error("GET /api/admin/quotations/export error:", err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --- Admin CRUD: optional-links ---

// GET /api/admin/optional-links
app.get('/api/admin/optional-links', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        l.*,
        p_trig.model AS trigger_model,
        p_trig.name AS trigger_name,
        p_opt.model AS optional_model,
        p_opt.name AS optional_name
      FROM product_optional_links l
      LEFT JOIN products p_trig ON l.trigger_product_id = p_trig.internal_reference
      LEFT JOIN products p_opt ON l.optional_product_id = p_opt.internal_reference
      ORDER BY l.id DESC
    `);
    res.json(rows);
  } catch (err: any) {
    console.error("GET /api/admin/optional-links error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/optional-links
app.post('/api/admin/optional-links', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const { trigger_product_id, optional_product_id, is_active, note } = req.body;
    if (!trigger_product_id || !optional_product_id) {
      return res.status(400).json({ error: 'Missing trigger_product_id or optional_product_id' });
    }

    const { rows } = await pool.query(`
      INSERT INTO product_optional_links (trigger_product_id, optional_product_id, is_active, note)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [trigger_product_id, optional_product_id, is_active !== false, note || '']);
    res.json(rows[0]);
  } catch (err: any) {
    console.error("POST /api/admin/optional-links error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/optional-links/:id
app.put('/api/admin/optional-links/:id', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const linkId = req.params.id;
    const { trigger_product_id, optional_product_id, is_active, note } = req.body;
    if (!trigger_product_id || !optional_product_id) {
      return res.status(400).json({ error: 'Missing trigger_product_id or optional_product_id' });
    }

    const { rows } = await pool.query(`
      UPDATE product_optional_links
      SET trigger_product_id = $1, optional_product_id = $2, is_active = $3, note = $4
      WHERE id = $5
      RETURNING *
    `, [trigger_product_id, optional_product_id, is_active !== false, note || '', linkId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }
    res.json(rows[0]);
  } catch (err: any) {
    console.error("PUT /api/admin/optional-links error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/optional-links/:id
app.delete('/api/admin/optional-links/:id', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const linkId = req.params.id;
    const { rows } = await pool.query(`
      DELETE FROM product_optional_links
      WHERE id = $1
      RETURNING *
    `, [linkId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error("DELETE /api/admin/optional-links error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Admin CRUD: stock-rules ---

// GET /api/admin/stock-rules
app.get('/api/admin/stock-rules', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    // JOIN ตรง ๆ — internal_reference ไม่ซ้ำใน products (มี unique index บังคับไว้)
    // อย่าเปลี่ยนเป็น LEFT JOIN LATERAL: ที่ 5 พันกฎช้าจาก 95ms เป็น 61 วินาที
    const { rows } = await pool.query(`
      SELECT
        sr.*,
        p.model,
        p.name,
        p.brand,
        p.production,
        p.actual_quantity,
        p.product_template_id AS product_id
      FROM product_stock_rules sr
      LEFT JOIN products p ON sr.internal_reference = p.internal_reference
      ORDER BY sr.internal_reference DESC
    `);
    res.json(rows);
  } catch (err: any) {
    console.error("GET /api/admin/stock-rules error:", err);
    res.status(500).json({ error: err.message });
  }
});

// เงื่อนไขสินค้าที่นำมาตั้งกฎระงับได้ (ตัดกลุ่ม Buy to sell + สินค้าที่ระบบสร้างเอง
// ออกให้ตรงกับ /api/products/search)
const STOCK_RULE_PRODUCT_FILTER = `(p.production IS NULL OR LOWER(REPLACE(p.production, ' ', '')) NOT LIKE '%buytosell%') AND p.is_system_item = false`;
const STOCK_RULE_HAS_REF = `(p.internal_reference IS NOT NULL AND TRIM(p.internal_reference) <> '' AND p.internal_reference <> 'N/A')`;

// GET /api/admin/stock-rules/productions - รายชื่อสายการผลิตพร้อมจำนวนสินค้าที่ตั้งกฎได้
app.get('/api/admin/stock-rules/productions', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.production,
        COUNT(DISTINCT TRIM(p.internal_reference))::int AS total
      FROM products p
      WHERE p.production IS NOT NULL AND TRIM(p.production) <> ''
        AND ${STOCK_RULE_PRODUCT_FILTER}
        AND ${STOCK_RULE_HAS_REF}
      GROUP BY p.production
      ORDER BY p.production
    `);
    res.json(rows);
  } catch (err: any) {
    console.error("GET /api/admin/stock-rules/productions error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stock-rules/product-lookup - ค้นหาสินค้าเพื่อตั้งกฎ (ค้นได้ทั้งรุ่น ชื่อ แบรนด์ และสายการผลิต)
// การเลือกยกทั้งสายการผลิตไม่ผ่าน endpoint นี้ — ส่งชื่อ production ไปที่ POST แล้วให้ DB ขยายเอง
app.get('/api/admin/stock-rules/product-lookup', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.json({ items: [], total: 0, truncated: false });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 250, 1), 1000);
    const params: any[] = [`%${q}%`];
    const where = `${STOCK_RULE_PRODUCT_FILTER} AND (` +
      `p.model ILIKE $1 OR p.name ILIKE $1 OR p.internal_reference ILIKE $1 ` +
      `OR p.brand ILIKE $1 OR p.production ILIKE $1)`;

    // นับจากจำนวนสินค้าที่ถูก dedupe แล้ว เพื่อให้ตรงกับรายการที่ส่งกลับ
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT DISTINCT COALESCE(NULLIF(TRIM(p.internal_reference), ''), 'PID:' || p.product_template_id) AS dedupe_key
         FROM products p
         WHERE ${where}
       ) d`,
      params
    );
    const total = countRes.rows[0]?.total ?? 0;

    params.push(limit);
    const { rows } = await pool.query(
      `SELECT product_id, model, name, internal_reference, brand, production, actual_quantity
       FROM (
         SELECT DISTINCT ON (COALESCE(NULLIF(TRIM(p.internal_reference), ''), 'PID:' || p.product_template_id))
           p.product_template_id AS product_id,
           p.model,
           p.name,
           p.internal_reference,
           p.brand,
           p.production,
           p.actual_quantity
         FROM products p
         WHERE ${where}
         ORDER BY COALESCE(NULLIF(TRIM(p.internal_reference), ''), 'PID:' || p.product_template_id), p.product_template_id
       ) u
       ORDER BY production NULLS LAST, brand NULLS LAST, model
       LIMIT $${params.length}`,
      params
    );

    res.json({ items: rows, total, truncated: total > rows.length });
  } catch (err: any) {
    console.error("GET /api/admin/stock-rules/product-lookup error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/stock-rules
app.post('/api/admin/stock-rules', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const { internal_reference, internal_references, productions, is_active } = req.body;

    // ตั้งกฎยกทั้งสายการผลิต — ขยายรายการฝั่ง DB เลย ไม่ต้องส่ง reference หลักหมื่นตัวมาทาง payload
    if (productions && Array.isArray(productions) && productions.length > 0) {
      const names = productions.filter((p: unknown): p is string => typeof p === 'string' && p.trim() !== '');
      if (names.length === 0) {
        return res.status(400).json({ error: 'Missing productions' });
      }

      const extraRefs = Array.isArray(internal_references)
        ? internal_references.filter((r: unknown): r is string => typeof r === 'string' && r.trim() !== '').map((r: string) => r.trim())
        : [];

      const { rowCount } = await pool.query(`
        INSERT INTO product_stock_rules (internal_reference, is_active)
        SELECT DISTINCT TRIM(p.internal_reference), $3::boolean
        FROM products p
        WHERE (p.production = ANY($1::text[]) OR TRIM(p.internal_reference) = ANY($2::text[]))
          AND p.internal_reference IS NOT NULL
          AND TRIM(p.internal_reference) <> ''
          AND p.internal_reference <> 'N/A'
          AND p.is_system_item = false
        ON CONFLICT (internal_reference) DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = NOW()
      `, [names, extraRefs, is_active !== false]);

      return res.json({ count: rowCount, productions: names });
    }

    if (internal_references && Array.isArray(internal_references)) {
      // dedupe + ตัดค่าว่างออก ก่อน insert ทีเดียวด้วย UNNEST
      // (เลือกยกทั้งสายการผลิตอาจมีหลักหมื่นรายการ — วนยิงทีละ query ไม่ไหว)
      const refs = Array.from(new Set(
        internal_references
          .filter((ref: unknown): ref is string => typeof ref === 'string' && ref.trim() !== '')
          .map((ref: string) => ref.trim())
      ));

      if (refs.length === 0) {
        return res.status(400).json({ error: 'Missing internal_references' });
      }

      const { rows } = await pool.query(`
        INSERT INTO product_stock_rules (internal_reference, is_active)
        SELECT ref, $2 FROM UNNEST($1::text[]) AS ref
        ON CONFLICT (internal_reference) DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = NOW()
        RETURNING *
      `, [refs, is_active !== false]);
      return res.json(rows);
    }

    if (!internal_reference) {
      return res.status(400).json({ error: 'Missing internal_reference' });
    }

    const { rows } = await pool.query(`
      INSERT INTO product_stock_rules (internal_reference, is_active)
      VALUES ($1, $2)
      ON CONFLICT (internal_reference) DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = NOW()
      RETURNING *
    `, [internal_reference, is_active !== false]);
    res.json(rows[0]);
  } catch (err: any) {
    console.error("POST /api/admin/stock-rules error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/stock-rules/:internal_reference
app.put('/api/admin/stock-rules/:internal_reference', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const internalReference = req.params.internal_reference;
    const { is_active } = req.body;

    const { rows } = await pool.query(`
      UPDATE product_stock_rules
      SET is_active = $1, updated_at = NOW()
      WHERE internal_reference = $2
      RETURNING *
    `, [is_active !== false, internalReference]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Stock rule not found' });
    }
    res.json(rows[0]);
  } catch (err: any) {
    console.error("PUT /api/admin/stock-rules error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/stock-rules/:internal_reference
app.delete('/api/admin/stock-rules/:internal_reference', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const internalReference = req.params.internal_reference;
    const { rows } = await pool.query(`
      DELETE FROM product_stock_rules
      WHERE internal_reference = $1
      RETURNING *
    `, [internalReference]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Stock rule not found' });
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error("DELETE /api/admin/stock-rules error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Admin CRUD: moq-rules ---

// GET /api/admin/moq-rules
app.get('/api/admin/moq-rules', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        mr.*,
        p.model,
        p.name,
        p.product_template_id AS product_id
      FROM product_moq_rules mr
      LEFT JOIN products p ON mr.internal_reference = p.internal_reference
      ORDER BY mr.internal_reference DESC
    `);
    res.json(rows);
  } catch (err: any) {
    console.error("GET /api/admin/moq-rules error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/moq-rules
app.post('/api/admin/moq-rules', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const { internal_reference, min_order_qty, sale_line_warn_msg, is_active } = req.body;
    if (!internal_reference || !min_order_qty || !sale_line_warn_msg) {
      return res.status(400).json({ error: 'Missing internal_reference, min_order_qty or sale_line_warn_msg' });
    }

    const { rows } = await pool.query(`
      INSERT INTO product_moq_rules (internal_reference, min_order_qty, sale_line_warn_msg, is_active)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [internal_reference, min_order_qty, sale_line_warn_msg, is_active !== false]);
    res.json(rows[0]);
  } catch (err: any) {
    console.error("POST /api/admin/moq-rules error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/moq-rules/:internal_reference
app.put('/api/admin/moq-rules/:internal_reference', adminAuthMiddleware, express.json(), async (req: any, res: any) => {
  try {
    const internalReference = req.params.internal_reference;
    const { min_order_qty, sale_line_warn_msg, is_active } = req.body;
    if (!min_order_qty || !sale_line_warn_msg) {
      return res.status(400).json({ error: 'Missing min_order_qty or sale_line_warn_msg' });
    }

    const { rows } = await pool.query(`
      UPDATE product_moq_rules
      SET min_order_qty = $1, sale_line_warn_msg = $2, is_active = $3, updated_at = NOW()
      WHERE internal_reference = $4
      RETURNING *
    `, [min_order_qty, sale_line_warn_msg, is_active !== false, internalReference]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'MOQ rule not found' });
    }
    res.json(rows[0]);
  } catch (err: any) {
    console.error("PUT /api/admin/moq-rules error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/moq-rules/:internal_reference
app.delete('/api/admin/moq-rules/:internal_reference', adminAuthMiddleware, async (req: any, res: any) => {
  try {
    const internalReference = req.params.internal_reference;
    const { rows } = await pool.query(`
      DELETE FROM product_moq_rules
      WHERE internal_reference = $1
      RETURNING *
    `, [internalReference]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'MOQ rule not found' });
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error("DELETE /api/admin/moq-rules error:", err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3011;
const server = app.listen(port, () => {
  console.log(`listening on ${port}`);
  // เริ่มตัวตั้งเวลา auto-sync (อ่าน config จากตาราง sync_settings)
  initScheduler().catch((err) => console.error('[scheduler] init ล้มเหลว:', err));
});

// ปิด Chrome ที่ pdfGenerator ใช้ร่วมกัน ไม่งั้นจะค้างเป็น process กำพร้าทุกครั้งที่ restart
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`\n[shutdown] ได้รับ ${signal} — กำลังปิดอย่างสุภาพ`);
    server.close();
    closePdfBrowser().finally(() => process.exit(0));
  });
}
