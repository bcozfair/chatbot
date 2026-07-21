import { pool } from '../config/db.js';
import { validateProductPriceWithPromotions, getRelevantPromotion } from './promotionValidator.js';
import { calcNetPrice } from './pricing.js';

export function createListFlexMessage(
  title: string,
  description: string,
  options: Array<{ label: string; data: string; displayText?: string }>
) {
  const items: any[] = options.map(opt => ({
    type: "box",
    layout: "vertical",
    backgroundColor: "#F3F4F6",
    cornerRadius: "md",
    paddingAll: "12px",
    margin: "sm",
    action: {
      type: "postback",
      data: opt.data,
      displayText: opt.displayText
    },
    contents: [
      {
        type: "text",
        text: opt.label,
        wrap: true,
        weight: "bold",
        size: "sm",
        color: "#1F2937"
      }
    ]
  }));

  items.push({
    type: "button",
    action: {
      type: "postback",
      label: "❌ ยกเลิกรายการนี้",
      data: "action=cancel_pending",
      displayText: "ยกเลิก"
    },
    style: "link",
    color: "#EF4444",
    height: "sm",
    margin: "md"
  });

  return {
    type: "flex",
    altText: title,
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1D4ED8",
        contents: [
          {
            type: "text",
            text: title,
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: description,
            wrap: true,
            size: "sm",
            color: "#4B5563"
          },
          {
            type: "box",
            layout: "vertical",
            margin: "lg",
            spacing: "sm",
            contents: items
          }
        ]
      }
    }
  };
}

export function createBranchSelectionFlex(selectedCodesStr = '', userId = '') {
  const liffId = process.env.LIFF_ID || '';
  let liffUrl = `https://liff.line.me/${liffId}`;
  if (userId) {
    liffUrl += `?userId=${userId}`;
  }

  return {
    type: "flex",
    altText: "ลงทะเบียนพนักงานขาย",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1D4ED8",
        contents: [
          {
            type: "text",
            text: "📝 ลงทะเบียนพนักงานขาย",
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "ยินดีต้อนรับครับ! ก่อนเริ่มต้นใช้งาน กรุณากดปุ่มสีน้ำเงินด้านล่างเพื่อกรอกข้อมูลผู้ลงทะเบียนและเลือกสาขา/พื้นที่ดูแลของคุณครับ 👇",
            wrap: true,
            size: "sm",
            color: "#4B5563"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "🌐 ลงทะเบียนใช้งาน",
              uri: liffUrl
            },
            style: "primary",
            color: "#2563EB",
            height: "sm"
          }
        ]
      }
    }
  };
}

/**
 * URL หน้า LIFF แก้ไขใบเสนอราคา — จุดเดียวที่ประกอบลิงก์นี้
 *
 * ⚠️ ต้องแนบ userId เสมอ: หน้า LIFF ใช้ userId ยืนยันความเป็นเจ้าของใบตอน PUT/cancel
 * (`isQuotationOwner` ใน index.ts) ถ้าไม่แนบ หน้าเว็บต้องไปพึ่ง `liff.getProfile()`
 * ซึ่งพลาดได้ (scope ไม่ครบ / เปิดนอก LINE client) แล้วผู้ใช้จะเจอ 403 "ไม่มีสิทธิ์เข้าถึงใบเสนอราคานี้"
 * ตอนกดบันทึก — ไม่ใช่ security boundary (ดูคอมเมนต์ที่ isQuotationOwner) แต่ต้องมีให้ครบ
 */
export function buildQuoteEditLiffUrl(quoteIdsStr: string, userId?: string | null) {
  const liffQuoteId = process.env.LIFF_QUOTE_ID || process.env.LIFF_ID || '';
  const params = new URLSearchParams({ quoteIds: quoteIdsStr });
  if (userId) params.set('userId', userId);
  return `https://liff.line.me/${liffQuoteId}?${params.toString()}`;
}

export function createUnregisteredCustomerFlex(companyName: string, quoteIdsStr: string, userId?: string | null) {
  const liffUrl = buildQuoteEditLiffUrl(quoteIdsStr, userId);

  return {
    type: "flex",
    altText: "ไม่พบชื่อบริษัทในระบบ",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#EF4444",
        contents: [
          {
            type: "text",
            text: "⚠️ ไม่พบชื่อบริษัทในฐานข้อมูล",
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: `ไม่พบชื่อบริษัท "${companyName}" ในฐานข้อมูลครับ`,
            wrap: true,
            size: "sm",
            weight: "bold",
            color: "#1F2937"
          },
          {
            type: "text",
            text: "สามารถกดปุ่มด้านล่างเพื่อค้นหาด้วยตนเอง หรือกดยกเลิกรายการเสนอราคานี้ได้เลยครับ",
            wrap: true,
            size: "sm",
            color: "#6B7280"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "🔎 เลือกบริษัท/ผู้ติดต่อเอง",
              uri: liffUrl
            },
            style: "primary",
            color: "#2563EB",
            height: "sm"
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "❌ ยกเลิกรายการเสนอราคานี้",
              data: "action=cancel_pending",
              displayText: "ยกเลิก"
            },
            style: "link",
            color: "#EF4444",
            height: "sm"
          }
        ]
      }
    }
  };
}

export function createEditMenuFlex(userId = '') {
  const liffId = process.env.LIFF_ID || '';
  let liffUrl = `https://liff.line.me/${liffId}`;
  if (userId) {
    liffUrl += `?userId=${userId}`;
  }

  return {
    type: "flex",
    altText: "เมนูแก้ไขข้อมูล",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1D4ED8",
        contents: [
          {
            type: "text",
            text: "⚙️ เมนูแก้ไขข้อมูล",
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "ท่านสามารถปรับปรุงข้อมูลส่วนตัว สาขาดูแล หรือแก้ไขใบเสนอราคาที่เคยออกไปแล้วได้ด้านล่างนี้ครับ 👇",
            wrap: true,
            size: "sm",
            color: "#4B5563"
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "button",
                action: {
                  type: "uri",
                  label: "📝 แก้ไขข้อมูลส่วนตัวและสาขา",
                  uri: liffUrl
                },
                style: "primary",
                color: "#2563EB",
                height: "sm"
              },
              {
                type: "button",
                action: {
                  type: "postback",
                  label: "📄 แก้ไขใบเสนอราคา",
                  data: "action=edit_menu&sub=quotation",
                  displayText: "แก้ไขใบเสนอราคา"
                },
                style: "primary",
                color: "#10B981",
                height: "sm",
                margin: "sm"
              }
            ]
          }
        ]
      }
    }
  };
}

export function createSalespersonProfileFlex(
  salesperson: { name?: string; phone?: string; salesperson_id?: string; branch_code?: string },
  branches: any[] = []
) {
  const selectedCodes = salesperson.branch_code ? salesperson.branch_code.split(',').map(c => c.trim()).filter(Boolean) : [];
  const branchNames = selectedCodes.map(code => {
    const found = branches.find(b => b.branch_code === code);
    return found ? found.name : code;
  }).join(', ') || 'ไม่ได้ระบุ';

  return {
    type: "flex",
    altText: "ข้อมูลส่วนตัวของคุณ",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#10B981",
        contents: [
          {
            type: "text",
            text: "👤 ข้อมูลส่วนตัวพนักงานขาย",
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 4,
                contents: [
                  { type: "text", text: "ชื่อ-นามสกุล", size: "xs", color: "#9CA3AF" },
                  { type: "text", text: salesperson.name || "ไม่ได้ระบุ", weight: "bold", size: "sm", color: "#1F2937", wrap: true }
                ]
              },
              {
                type: "button",
                action: {
                  type: "postback",
                  label: "📝 แก้ไข",
                  data: "action=edit_btn&target=salesperson&field=name",
                  displayText: "แก้ไขชื่อ"
                },
                style: "secondary",
                height: "sm",
                flex: 2
              }
            ]
          },
          { type: "separator" },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 4,
                contents: [
                  { type: "text", text: "เบอร์โทรศัพท์", size: "xs", color: "#9CA3AF" },
                  { type: "text", text: salesperson.phone || "ไม่ได้ระบุ", weight: "bold", size: "sm", color: "#1F2937" }
                ]
              },
              {
                type: "button",
                action: {
                  type: "postback",
                  label: "📝 แก้ไข",
                  data: "action=edit_btn&target=salesperson&field=phone",
                  displayText: "แก้ไขเบอร์โทร"
                },
                style: "secondary",
                height: "sm",
                flex: 2
              }
            ]
          },
          { type: "separator" },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "box",
                layout: "vertical",
                flex: 4,
                contents: [
                  { type: "text", text: "รหัสพนักงาน", size: "xs", color: "#9CA3AF" },
                  { type: "text", text: salesperson.salesperson_id || "ไม่ได้ระบุ", weight: "bold", size: "sm", color: "#1F2937" }
                ]
              },
              {
                type: "button",
                action: {
                  type: "postback",
                  label: "📝 แก้ไข",
                  data: "action=edit_btn&target=salesperson&field=salesperson_id",
                  displayText: "แก้ไขรหัสพนักงาน"
                },
                style: "secondary",
                height: "sm",
                flex: 2
              }
            ]
          },
          { type: "separator" },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            contents: [
              { type: "text", text: "สาขาที่รับผิดชอบดูแล", size: "xs", color: "#9CA3AF" },
              { type: "text", text: branchNames, weight: "bold", size: "sm", color: "#1F2937", wrap: true }
            ]
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "🏢 ปรับปรุงสาขาดูแล",
              data: "action=edit_menu&sub=branches",
              displayText: "ปรับปรุงสาขาดูแล"
            },
            style: "primary",
            color: "#2563EB",
            height: "sm",
            margin: "sm"
          }
        ]
      }
    }
  };
}

export function createProfileConfirmationFlex(
  salesperson: { name?: string; phone?: string; salesperson_id?: string; branch_code?: string },
  branches: any[] = []
) {
  const selectedCodes = salesperson.branch_code ? salesperson.branch_code.split(',').map(c => c.trim()).filter(Boolean) : [];
  const branchNames = selectedCodes.map(code => {
    const found = branches.find(b => b.branch_code === code);
    return found ? found.name : code;
  }).join(', ') || 'ไม่ได้ระบุ';

  return {
    type: "flex",
    altText: "ยืนยันข้อมูลการลงทะเบียน",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#2563EB",
        contents: [
          {
            type: "text",
            text: "📋 ตรวจสอบข้อมูลลงทะเบียน",
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "กรุณาตรวจสอบความถูกต้องของข้อมูลของท่านก่อนกดยืนยันครับ",
            size: "sm",
            color: "#4B5563",
            wrap: true
          },
          { type: "separator" },
          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "👤 คุณ:", size: "sm", color: "#6B7280", flex: 2 },
                  { type: "text", text: salesperson.name || "-", weight: "bold", size: "sm", color: "#1F2937", flex: 5, wrap: true }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                margin: "sm",
                contents: [
                  { type: "text", text: "🏢 สาขาที่ดูแล:", size: "sm", color: "#6B7280", flex: 2 },
                  { type: "text", text: branchNames, weight: "bold", size: "sm", color: "#1F2937", flex: 5, wrap: true }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                margin: "sm",
                contents: [
                  { type: "text", text: "🏢 รหัสพนักงาน:", size: "sm", color: "#6B7280", flex: 2 },
                  { type: "text", text: salesperson.salesperson_id || "-", weight: "bold", size: "sm", color: "#1F2937", flex: 5 }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                margin: "sm",
                contents: [
                  { type: "text", text: "📞 เบอร์โทร:", size: "sm", color: "#6B7280", flex: 2 },
                  { type: "text", text: salesperson.phone || "-", weight: "bold", size: "sm", color: "#1F2937", flex: 5 }
                ]
              }
            ]
          },
          { type: "separator", margin: "md" },
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            margin: "md",
            contents: [
              {
                type: "button",
                action: {
                  type: "postback",
                  label: "✅ ยืนยันข้อมูล",
                  data: "action=confirm_profile",
                  displayText: "ยืนยันข้อมูลถูกต้อง"
                },
                style: "primary",
                color: "#10B981",
                height: "sm",
                flex: 1
              },
              {
                type: "button",
                action: {
                  type: "postback",
                  label: "❌ แก้ไขข้อมูล",
                  data: "action=edit_profile",
                  displayText: "ต้องการแก้ไขข้อมูล"
                },
                style: "secondary",
                color: "#EF4444",
                height: "sm",
                flex: 1
              }
            ]
          }
        ]
      }
    }
  };
}

// ข้อความที่ใช้แสดงแทนค่าลูกค้าที่ยังไม่มีข้อมูล (ค่าจริงใน DB เป็น null — ระบบไม่มี "ลูกค้าทั่วไป" แล้ว)
export const CUSTOMER_PLACEHOLDER = '-';

function parseCustomerNameMeta(fullName: string) {
  const empty = { company: '', contact: '', phone: '', email: '', address: '', delivery: '', tax_id: '' };
  if (!fullName) return empty;
  const parts = fullName.split(' | ');
  const company = (parts[0] || '').trim();
  const contact = (parts[1] || '').trim();
  let meta: Record<string, string> = {};
  if (parts[2]) {
    try {
      meta = Object.fromEntries(new URLSearchParams(parts[2]));
    } catch (e) {
      console.error("Error parsing meta:", e);
    }
  }
  return {
    company,
    contact,
    phone: meta.phone || '',
    email: meta.email || '',
    address: meta.address || '',
    delivery: meta.delivery || meta.address || '',
    tax_id: meta.tax_id || ''
  };
}

/**
 * ใบเสนอราคาที่ยังไม่ได้ผูกลูกค้า (เช่น ร่างที่สร้างจากตะกร้าหน้า product-search)
 * ใบแบบนี้ห้ามยืนยันออกเอกสาร — ต้องเข้าไปเลือกบริษัท/ผู้ติดต่อในหน้า LIFF ก่อน
 *
 * เช็คแค่ status + ชื่อบริษัท ไม่เช็ค customer_id/contact_id เพราะใบเก่าบางใบไม่มี id
 * (enrich เติมให้จาก display_name เท่านั้น) เช็คเกินจะทำใบปกติเสียปุ่มยืนยันไปด้วย
 * ส่วนกฎ "ลูกค้าต้องมีในฐานข้อมูล" บังคับตอนบันทึกแทน (PUT /api/quotation/:id → 400
 * และปุ่มบันทึกในหน้า LIFF ที่ต้องมี customer_id ก่อน)
 */
export function isCustomerInfoIncomplete(quote: any): boolean {
  if (!quote) return true;
  if (quote.status === 'pending_company' || quote.status === 'pending_contact') return true;
  const company = parseCustomerNameMeta(quote.customer_name).company;
  // ข้อมูลเก่าใน DB อาจยังมีคำว่า "ลูกค้าทั่วไป" ค้างอยู่ — ถือว่ายังไม่ได้ระบุลูกค้าเช่นกัน
  return !company || company === 'ลูกค้าทั่วไป';
}

/**
 * ข้อความกำหนดส่งของใบหนึ่งใบ — ใช้ค่าที่ enrichQuotationData คำนวณมาให้แล้ว
 * (delivery_days_auto / delivery_all_in_stock) และค่าที่เซลล์ตั้งทับไว้ (delivery_days_override)
 *
 * fallback 3/7 วัน กับคำว่า In_stock./Make to order. ตรงกับ pdfGenerator และหน้า LIFF
 * เซลล์จะได้เห็นเลขเดียวกันทั้งในแชท ในหน้าแก้ไข และในไฟล์ PDF
 */
function formatDeliveryTime(quote: any): { text: string; allInStock: boolean } {
  const raw = quote?.delivery_days_override;
  const overrideDays = (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)))
    ? null
    : Number(raw);
  const allInStock = quote?.delivery_all_in_stock !== false;
  const autoRaw = Number(quote?.delivery_days_auto);
  const autoDays = Number.isFinite(autoRaw) ? autoRaw : (allInStock ? 3 : 7);
  const days = overrideDays !== null ? overrideDays : autoDays;
  const mode = allInStock ? 'In_stock.' : 'Make to order.';
  return {
    text: `${mode} ภายใน ${days} วัน${overrideDays !== null ? ' (ตั้งค่าเอง)' : ''}`,
    allInStock
  };
}

export async function getQuotationSummaryMessage(quotes: any[]) {
  const quoteIds = quotes.map(q => q.id).join(',');

  // Fetch current stock for all items in the quotes
  const productCodes: string[] = [];
  quotes.forEach(quote => {
    if (quote.items && Array.isArray(quote.items)) {
      quote.items.forEach((item: any) => {
        const itemKey = item.model || item.product_code;
        if (itemKey) {
          productCodes.push(itemKey);
        }
      });
    }
  });

  const stockMap: Record<string, number> = {};
  const minPriceMap: Record<string, number> = {};
  if (productCodes.length > 0) {
    try {
      const { rows: productsData } = await pool.query(
        'SELECT model AS code, actual_quantity AS stock, minimum_sales_price FROM products WHERE model = ANY($1)',
        [productCodes]
      );

      if (productsData) {
        productsData.forEach((p: any) => {
          const currentStock = stockMap[p.code] || 0;
          const newStock = p.stock !== undefined && p.stock !== null ? p.stock : 0;
          if (newStock > currentStock || stockMap[p.code] === undefined) {
            stockMap[p.code] = newStock;
          }
          
          const currentMinPrice = minPriceMap[p.code] || 0;
          const newMinPrice = parseFloat(p.minimum_sales_price) || 0;
          if (newMinPrice > currentMinPrice || minPriceMap[p.code] === undefined) {
            minPriceMap[p.code] = newMinPrice;
          }
        });
      }
    } catch (err) {
      console.error('Error fetching stock for summary message:', err);
    }
  }

  // Track minimum price violations
  let hasMinPriceViolation = false;

  // Parse customer info
  const meta = parseCustomerNameMeta(quotes[0].customer_name);

  // ใบที่ยังไม่ได้ผูกลูกค้าจากฐานข้อมูล → แสดงข้อมูลลูกค้าเป็น placeholder และซ่อนปุ่มยืนยัน
  const customerIncomplete = isCustomerInfoIncomplete(quotes[0]);
  if (customerIncomplete && meta.company === 'ลูกค้าทั่วไป') meta.company = '';

  // ค่าที่ไม่มีข้อมูล (null/ว่าง) แสดงเป็น placeholder เสมอ
  const show = (v: any) => (v === null || v === undefined || v === '' || v === '-') ? CUSTOMER_PLACEHOLDER : v;

  // Try to enrich with customer_details data (has phone, email, address, tax_id)
  const customerDetails = quotes[0].customer_details;
  if (customerDetails) {
    if (customerDetails.phone && customerDetails.phone !== '-') meta.phone = customerDetails.phone;
    if (customerDetails.email && customerDetails.email !== '-') meta.email = customerDetails.email;
    if (customerDetails.address && customerDetails.address !== '-') meta.address = customerDetails.address;
    if (customerDetails.customer_tax_id && customerDetails.customer_tax_id !== '-') meta.tax_id = customerDetails.customer_tax_id;
  }

  // เครดิตเทอม — ใบที่ enrich แล้วมี payment_terms ติดมาจาก customers_view
  // ถ้าไม่มี (ใบเก่า/เส้นทางอื่น) ค่อยถอยไปอ่าน snapshot customer_details
  let paymentTerms = quotes[0].payment_terms || '';
  if ((!paymentTerms || paymentTerms === '-') && customerDetails?.payment_terms && customerDetails.payment_terms !== '-') {
    paymentTerms = customerDetails.payment_terms;
  }

  // คิวรีข้อมูลลูกค้า (customer_type, reference) ด้วย pool.query (งด Supabase-style)
  let customerData = null;
  if (meta.company) {
    try {
      const custRes = await pool.query(
        'SELECT customer_type, reference FROM customers_view WHERE display_name = $1 LIMIT 1',
        [meta.company]
      );
      if (custRes.rows.length > 0) {
        customerData = {
          customer_type: custRes.rows[0].customer_type,
          reference: custRes.rows[0].reference
        };
      }
    } catch (err) {
      console.error("Error fetching customer in getQuotationSummaryMessage:", err);
    }
  }

  // คิวรีข้อมูลโปรโมชันที่กำลัง active ทั้งหมด ด้วย pool.query (งด Supabase-style)
  let activePromos: any[] = [];
  try {
    const promoRes = await pool.query(
      'SELECT * FROM promotions WHERE is_active = true'
    );
    activePromos = promoRes.rows;
  } catch (err) {
    console.error("Error fetching promotions in getQuotationSummaryMessage:", err);
  }

  // Generate plain text summary
  let summaryText = '';
  const refText = show(customerData?.reference);
  summaryText += `📝 ร่างใบเสนอราคา\n`;
  if (customerIncomplete) {
    summaryText += `⚠️ ยังไม่ได้ระบุลูกค้า — กรุณากรอกข้อมูลลูกค้าก่อนยืนยัน\n`;
  }
  summaryText += `🔖 Ref: ${refText}\n`;
  summaryText += `🆔 เลขเสียภาษี: ${show(meta.tax_id)}\n`;
  summaryText += `🏢 ${show(meta.company)}\n`;
  summaryText += `👤 ${show(meta.contact)}\n`;
  summaryText += `📞 ${show(meta.phone)}\n`;
  summaryText += `📧 ${show(meta.email)}\n`;
  summaryText += `📍 ${show(meta.address)}\n`;
  summaryText += `💳 เครดิต: ${show(paymentTerms)}\n`;
  summaryText += `───────────────\n`;

  // Flex body contents array
  const customerBoxContents: any[] = [
    {
      type: "text",
      text: `📋 รายละเอียดลูกค้า`,
      size: "sm",
      weight: "bold",
      color: "#374151",
      wrap: true
    }
  ];

  if (customerIncomplete) {
    customerBoxContents.push({
      type: "text",
      text: `⚠️ ยังไม่ได้ระบุลูกค้า — กรุณากดปุ่มด้านล่างเพื่อกรอกข้อมูลก่อนยืนยัน`,
      size: "xs",
      color: "#DC2626",
      weight: "bold",
      wrap: true
    });
  }

  customerBoxContents.push(
    {
      type: "text",
      text: `🔖 Ref: ${refText}`,
      size: "xs",
      color: "#4B5563",
      wrap: true
    },
    {
      type: "text",
      text: `🆔 เลขเสียภาษี: ${show(meta.tax_id)}`,
      size: "xs",
      color: "#4B5563",
      wrap: true
    },
    {
      type: "text",
      text: `🏢 ชื่อบริษัท: ${show(meta.company)}`,
      size: "xs",
      color: "#4B5563",
      wrap: true
    },
    {
      type: "text",
      text: `👤 ผู้ติดต่อ: ${show(meta.contact)}`,
      size: "xs",
      color: "#4B5563",
      wrap: true
    },
    {
      type: "text",
      text: `📞 โทร: ${show(meta.phone)}`,
      size: "xs",
      color: "#4B5563",
      wrap: true
    },
    {
      type: "text",
      text: `📧 อีเมล: ${show(meta.email)}`,
      size: "xs",
      color: "#4B5563",
      wrap: true
    },
    {
      type: "text",
      text: `📍 ที่อยู่: ${show(meta.address)}`,
      size: "xs",
      color: "#4B5563",
      wrap: true
    },
    {
      type: "text",
      text: `💳 เครดิต: ${show(paymentTerms)}`,
      size: "xs",
      color: "#4B5563",
      wrap: true
    }
  );

  const bodyContents: any[] = [
    {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      contents: customerBoxContents
    },
    {
      type: "separator",
      color: "#E5E7EB",
      margin: "md"
    }
  ];

  for (const quote of quotes) {
    let isTht = false;
    try {
      const { resolveQuoteCompany } = await import('../services/quotationService.js');
      if (quote.items && quote.items.length > 0) {
        const company = await resolveQuoteCompany(quote.items[0]);
        isTht = (company === 'THT');
      }
    } catch (err) {
      console.error("Error resolving company in summary:", err);
      isTht = quote.items.some((item: any) => item.production === 'Import(PM)');
    }
    const companyLabel = isTht ? 'Themtech (THT)' : 'Primus (PM)';
    
    summaryText += `🏭 ${companyLabel}\n`;
    bodyContents.push({
      type: "text",
      text: `🏭 ${companyLabel}`,
      weight: "bold",
      size: "sm",
      color: isTht ? "#4F46E5" : "#1D4ED8",
      margin: "md"
    });

    quote.items.forEach((item: any, itemIdx: number) => {
      const qty = item.quantity;
      const price = item.price;
      const disc1 = item.discount_1 || 0;
      const disc2 = item.discount_2 || 0;
      const netPrice = calcNetPrice(price, disc1, disc2);
      const itemTotal = qty * netPrice;
      
      let discDesc = '';
      if (disc1 > 0 || disc2 > 0) {
        const discountAmount = (price - netPrice) * qty;
        if (disc1 > 0 && disc2 > 0) {
          discDesc = ` (ลด ${disc1}+${disc2}% = ${discountAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บ.)`;
        } else if (disc1 > 0) {
          discDesc = ` (ลด ${disc1}% = ${discountAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บ.)`;
        }
      }
      
      // สต๊อกโชว์ทุกรายการ ไม่ใช่เฉพาะตอนของไม่พอ — เซลล์จะได้เห็นของที่พร้อมส่งด้วย
      // (ของที่ไม่มีใน products จะไม่มีใน stockMap → นับเป็น 0 = ไม่พอ ตามเดิม)
      const itemKey = item.model || item.product_code;
      const stock = stockMap[itemKey] !== undefined ? stockMap[itemKey] : 0;
      const isOut = qty > stock;
      const stockText = isOut
        ? `⚠️ สินค้าไม่พอ คงเหลือ ${stock} ชิ้น`
        : `✅ พร้อมส่ง คงเหลือ ${stock} ชิ้น`;

      // Add to plain text summary
      summaryText += `${itemIdx + 1}. ${itemKey}\n   ${qty} x ${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${discDesc} = ${itemTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บ.\n   (${stockText})\n`;

      // Add to Flex body
      const itemBoxContents: any[] = [
        {
          type: "text",
          text: `${itemIdx + 1}. ${itemKey}`,
          weight: "bold",
          size: "sm",
          color: "#1F2937",
          wrap: true
        },
        {
          type: "text",
          text: `   ${qty} x ${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${discDesc} = ${itemTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บ.`,
          size: "xs",
          color: "#4B5563",
          wrap: true
        }
      ];

      // ไฮไลท์สถานะสต๊อก: ไม่พอ = แดง / พร้อมส่ง = เขียว
      itemBoxContents.push({
        type: "box",
        layout: "vertical",
        margin: "xs",
        paddingAll: "xs",
        cornerRadius: "md",
        backgroundColor: isOut ? "#FEF2F2" : "#ECFDF5",
        contents: [
          {
            type: "text",
            text: stockText,
            size: "xs",
            color: isOut ? "#DC2626" : "#059669",
            weight: "bold",
            wrap: true
          }
        ]
      });

      // ตรวจสอบราคาหลังหักส่วนลดเทียบกับราคาขั้นต่ำ
      const minPrice = minPriceMap[itemKey] || 0;
      if (minPrice > 0 && netPrice < minPrice - 0.01) {
        // เช็คว่าผ่านเงื่อนไขโปรโมชันใดๆ หรือไม่ (ถ้าผ่านสิทธิ์โปรโมชันจริง ก็ไม่ต้องแจ้งเตือนและไม่บล็อก)
        const promoResult = validateProductPriceWithPromotions(
          itemKey,
          qty || 1,
          netPrice,
          minPrice,
          customerData,
          activePromos
        );

        if (!promoResult.allowed) {
          hasMinPriceViolation = true;
          
          // หาโปรโมชันที่เกี่ยวข้องเพื่อนำมาแสดงราคาเป้าหมายในคำเตือน
          const relevantPromo = getRelevantPromotion(itemKey, customerData, activePromos);
          let minPriceWarning = '';
          
          if (relevantPromo) {
            let allowedMinPrice = minPrice;
            const discValue = parseFloat(relevantPromo.discount_value as string) || 0;
            if (relevantPromo.discount_type === 'override') {
              allowedMinPrice = 0;
            } else if (relevantPromo.discount_type === 'percent') {
              allowedMinPrice = minPrice * (1 - discValue / 100);
            } else if (relevantPromo.discount_type === 'fixed') {
              allowedMinPrice = Math.max(0, minPrice - discValue);
            }
            minPriceWarning = `   ⚠️ ราคา < โปรโมชัน (${relevantPromo.code}) ฿${allowedMinPrice.toFixed(2)}`;
          } else {
            minPriceWarning = `   ⚠️ ราคา < ขั้นต่ำ ฿${minPrice.toFixed(2)}`;
          }

          summaryText += `${minPriceWarning}\n`;
          itemBoxContents.push({
            type: "text",
            text: minPriceWarning.trim(),
            size: "xs",
            color: "#DC2626",
            weight: "bold",
            wrap: true
          });
        }
      }

      bodyContents.push({
        type: "box",
        layout: "vertical",
        margin: "sm",
        spacing: "none",
        contents: itemBoxContents
      });
    });

    // กำหนดส่งเป็นค่าระดับ "ใบ" (ช้าสุดของทุกรายการ) จึงโชว์ท้ายรายการของแต่ละใบ
    // ไฮไลท์: In_stock. = น้ำเงิน / Make to order. = เหลือง
    const delivery = formatDeliveryTime(quote);
    summaryText += `🚚 กำหนดส่ง: ${delivery.text}\n`;

    bodyContents.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      paddingAll: "xs",
      cornerRadius: "md",
      backgroundColor: delivery.allInStock ? "#EFF6FF" : "#FFFBEB",
      contents: [
        {
          type: "text",
          text: `🚚 กำหนดส่ง: ${delivery.text}`,
          size: "xs",
          color: delivery.allInStock ? "#1D4ED8" : "#B45309",
          weight: "bold",
          wrap: true
        }
      ]
    });

    const totalSumVal = typeof quote.total_sum === 'number' ? quote.total_sum : (parseFloat(quote.total_sum) || 0);
    summaryText += `💰 รวม: ${totalSumVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท\n`;

    bodyContents.push({
      type: "text",
      text: `💰 รวม: ${totalSumVal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`,
      weight: "bold",
      size: "sm",
      color: "#111827",
      align: "end",
      margin: "md"
    });
  }

  if (quotes.length > 1) {
    const combinedSum = quotes.reduce((sum, q) => {
      const val = typeof q.total_sum === 'number' ? q.total_sum : (parseFloat(q.total_sum) || 0);
      return sum + val;
    }, 0);
    summaryText += `───────────────\n💰 ยอดรวมทั้งหมด: ${combinedSum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท\n`;

    bodyContents.push({
      type: "separator",
      color: "#D1D5DB",
      margin: "md"
    });
    bodyContents.push({
      type: "text",
      text: `💰 ยอดรวมทั้งหมด: ${combinedSum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`,
      weight: "bold",
      size: "md",
      color: "#2563EB",
      align: "end",
      margin: "md"
    });
  }

  // Build LIFF URL for editing (แนบ userId เจ้าของใบ ไม่งั้นหน้า LIFF บันทึกไม่ผ่าน 403)
  const liffUrl = buildQuoteEditLiffUrl(quoteIds, quotes[0].user_id);

  // Build unified Flex Message
  const combinedFlexMessage = {
    type: "flex",
    altText: "สรุปรายละเอียดร่างใบเสนอราคา",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#2563EB",
        contents: [
          {
            type: "text",
            text: "📝 ร่างใบเสนอราคา",
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: bodyContents
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: (() => {
          const footerButtons: any[] = [
            {
              type: "button",
              action: {
                type: "uri",
                label: customerIncomplete ? "🏢 กรอกข้อมูลลูกค้า" : "🔧 แก้ไขรายละเอียด",
                uri: liffUrl
              },
              style: "primary",
              color: "#2563EB",
              height: "sm"
            }
          ];

          if (customerIncomplete || hasMinPriceViolation) {
            // แสดงข้อความเตือนแทนปุ่มยืนยัน
            footerButtons.push({
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: customerIncomplete
                    ? "⚠️ ยังยืนยันไม่ได้ — ต้องกรอกข้อมูลลูกค้าก่อน"
                    : "⚠️ ไม่สามารถยืนยันได้ — มีสินค้าราคาต่ำกว่าขั้นต่ำ",
                  size: "xs",
                  color: "#DC2626",
                  weight: "bold",
                  wrap: true,
                  align: "center"
                }
              ],
              margin: "sm",
              paddingAll: "sm",
              backgroundColor: "#FEF2F2",
              cornerRadius: "md"
            });
          } else {
            footerButtons.push({
              type: "button",
              action: {
                type: "postback",
                label: "✅ ยืนยันออกใบเสนอราคา",
                data: `action=confirm&id=${quoteIds}`,
                displayText: "ยืนยันการออกเอกสาร"
              },
              style: "primary",
              color: "#10B981",
              height: "sm"
            });
          }

          footerButtons.push({
            type: "button",
            action: {
              type: "postback",
              label: "❌ ยกเลิก",
              data: `action=cancel&id=${quoteIds}`,
              displayText: "ยกเลิก"
            },
            style: "link",
            color: "#EF4444",
            height: "sm"
          });

          return footerButtons;
        })()
      }
    }
  };

  const messages = [
    combinedFlexMessage
  ];

  return { summaryText, messages };
}

export function appendReviseFrom(customerName: string, originalQuoteNo: string) {
  if (!customerName) return ` |  | revise_from=${originalQuoteNo}`;
  const parts = customerName.split(' | ');
  const company = parts[0] || '';
  const contact = parts[1] || '';
  let metaStr = parts[2] || '';
  if (metaStr) {
    try {
      const params = new URLSearchParams(metaStr);
      params.set('revise_from', originalQuoteNo);
      metaStr = params.toString();
    } catch (e) {
      metaStr = `${metaStr}&revise_from=${originalQuoteNo}`;
    }
  } else {
    metaStr = `revise_from=${originalQuoteNo}`;
  }
  return `${company} | ${contact} | ${metaStr}`;
}

export function createRevisionFlex(quoteNo: string, quoteId: string, userId?: string | null) {
  const liffUrl = buildQuoteEditLiffUrl(quoteId, userId);
  return {
    type: "flex",
    altText: "ดึงข้อมูลใบเสนอราคาสำเร็จ",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#2563EB",
        contents: [
          {
            type: "text",
            text: "📄 ดึงข้อมูลใบเสนอราคาสำเร็จ",
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: `ดึงข้อมูลใบเสนอราคาเลขที่ "${quoteNo}" เรียบร้อยแล้วครับ`,
            wrap: true,
            size: "sm",
            weight: "bold",
            color: "#1F2937"
          },
          {
            type: "text",
            text: "ข้อมูลที่ดึงกลับมา: รายการสินค้า จำนวน และส่วนลด ซึ่งสามารถแก้ไขได้ในหน้าถัดไป (ข้อมูลลูกค้า/ผู้ติดต่อไม่สามารถแก้ไขได้)",
            wrap: true,
            size: "sm",
            color: "#6B7280"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "⚙️ ดำเนินการแก้ไขใบเสนอราคา",
              uri: liffUrl
            },
            style: "primary",
            color: "#2563EB",
            height: "sm"
          }
        ]
      }
    }
  };
}

export function createCartConfirmationFlex(quoteIdsStr: string, itemCount: number, userId?: string | null) {
  const liffUrl = buildQuoteEditLiffUrl(quoteIdsStr, userId);

  return {
    type: "flex",
    altText: "🛒 บันทึกสินค้าลงตะกร้าเรียบร้อยแล้ว",
    contents: {
      type: "bubble",
      size: "giga",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#10B981",
        contents: [
          {
            type: "text",
            text: "🛒 บันทึกสินค้าลงตะกร้าสำเร็จ",
            weight: "bold",
            color: "#FFFFFF",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: `🛒 บันทึกสินค้าลงตะกร้าเรียบร้อยแล้วครับ! (ทั้งหมด ${itemCount} รายการ)`,
            wrap: true,
            size: "sm",
            weight: "bold",
            color: "#1F2937"
          },
          {
            type: "text",
            text: "ขั้นตอนถัดไป: รบกวนพิมพ์ชื่อบริษัท/ลูกค้า เพื่อเริ่มทำใบเสนอราคาต่อได้เลยครับ 🏢\n\nหรือกดปุ่มด้านล่างเพื่อเลือกบริษัท/ผู้ติดต่อและแก้ไขข้อมูลใบเสนอราคาครับ 👇",
            wrap: true,
            size: "sm",
            color: "#4B5563"
          },
          {
            type: "button",
            action: {
              type: "uri",
              label: "✏️ กรอก/แก้ไขข้อมูลลูกค้า",
              uri: liffUrl
            },
            style: "primary",
            color: "#2563EB",
            height: "sm"
          },
          {
            type: "button",
            action: {
              type: "postback",
              label: "❌ ยกเลิกรายการเสนอราคานี้",
              data: "action=cancel_pending",
              displayText: "ยกเลิก"
            },
            style: "link",
            color: "#EF4444",
            height: "sm"
          }
        ]
      }
    }
  };
}
