import { pool } from '../config/db.js';
import fs from 'fs';
import path from 'path';

// Helper functions for cleaning and formatting address
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

async function runSchemaMigration() {
  console.log('>>> Checking database schema for quotations...');
  const checkCol = await pool.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'quotations' AND column_name = 'customer_details';
  `);

  if (checkCol.rows.length === 0) {
    console.log('>>> Columns not found. Running SQL migration...');
    const sqlPath = path.join(process.cwd(), 'migrations', 'migration_007_quotation_snapshot.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sqlContent);
    console.log('>>> Database schema migrated successfully.');
  } else {
    console.log('>>> Schema already up to date. Skipping SQL migration.');
  }
}

async function migrateData() {
  console.log('>>> Fetching quotations to migrate...');
  
  // ดึงรายการ quotations ทั้งหมดเพื่อทับข้อมูลเก่าที่ยังไม่สมบูรณ์
  const quotesRes = await pool.query(`
    SELECT id, customer_name_old, items_old, user_id, status, quotation_no, created_at 
    FROM quotations
  `);

  const quotes = quotesRes.rows;
  console.log(`>>> Found ${quotes.length} quotations to migrate.`);

  // ดึงกฎเงื่อนไขรับประกัน/วันจัดส่งจาก quotation_rules มาถือไว้ล่วงหน้า
  const rulesRes = await pool.query('SELECT * FROM quotation_rules');
  const quotationRules = rulesRes.rows || [];

  for (const quote of quotes) {
    console.log(`\n--------------------------------------------------`);
    console.log(`📦 Migrating Quotation ID: ${quote.id} (No: ${quote.quotation_no || 'DRAFT'})`);
    
    // --------------------------------------------------
    // 1. PARSE & FETCH CUSTOMER DETAILS
    // --------------------------------------------------
    let companyName = quote.customer_name_old || 'ลูกค้าทั่วไป';
    let contactNameQuery = '';
    let customMeta: any = {};

    if (quote.customer_name_old && quote.customer_name_old.includes(' | ')) {
      const parts = quote.customer_name_old.split(' | ');
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

    let customerCode = '';
    let customerTaxId = '';
    let contactName = contactNameQuery || 'ลูกค้าทั่วไป';
    let contactPhone = '';
    let contactEmail = '';
    let contactAddress = '';
    let paymentTerms = '';

    if (companyName && companyName !== 'ลูกค้าทั่วไป') {
      try {
        // Query from VIEW customers which contains aggregated company and contact details
        let custData = null;
        
        if (contactNameQuery) {
          // ลองค้นหาแบบตรงตัวทั้งบริษัทและชื่อผู้ติดต่อ
          const custRes = await pool.query(`
            SELECT * FROM customers 
            WHERE customer_name = $1 AND contact_name = $2 
            LIMIT 1
          `, [companyName, contactNameQuery]);
          custData = custRes.rows[0];
        }
        
        if (!custData) {
          // ค้นหาเฉพาะชื่อบริษัท
          const custRes = await pool.query(`
            SELECT * FROM customers 
            WHERE customer_name = $1 
            LIMIT 1
          `, [companyName]);
          custData = custRes.rows[0];
        }

        if (custData) {
          customerCode = custData.customer_reference || '';
          customerTaxId = custData.customer_tax_id || '';
          contactName = custData.contact_name || contactNameQuery || 'ลูกค้าทั่วไป';
          paymentTerms = custData.customer_payment_terms || '';

          // ดึงเบอร์โทรผู้ติดต่อ หรือบริษัท
          if (custData.contact_mobile && custData.contact_mobile.trim()) {
            contactPhone = custData.contact_mobile.trim();
          } else if (custData.contact_phone && custData.contact_phone.trim()) {
            contactPhone = custData.contact_phone.trim();
          } else if (custData.phone && custData.phone.trim()) {
            contactPhone = custData.phone.trim();
          } else if (custData.mobile && custData.mobile.trim()) {
            contactPhone = custData.mobile.trim();
          }

          // รวมอีเมล
          const emails = [];
          if (custData.contact_email && custData.contact_email.trim()) {
            emails.push(custData.contact_email.trim());
          }
          if (custData.email && custData.email.trim()) {
            emails.push(custData.email.trim());
          }
          const uniqueEmails = Array.from(new Set(emails));
          contactEmail = uniqueEmails.length > 0 ? uniqueEmails.join(', ') : '';

          // ประกอบที่อยู่ออกใบกำกับภาษี
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
        console.error('Error fetching customer details from customers view:', err);
      }
    }

    // Apply custom overrides from old metadata string if present
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
      payment_terms: paymentTerms
    };

    console.log('>>> Mapped Customer Details:', JSON.stringify(customerDetails));

    // --------------------------------------------------
    // 2. MAP & ENRICH ITEM DETAILS
    // --------------------------------------------------
    const itemsOld = quote.items_old || [];
    const itemDetails: any[] = [];

    for (const item of itemsOld) {
      const code = item.product_code || item.model || item.code || '';
      
      // ดึงรายละเอียดเชิงลึกและ internal_reference ของสินค้าเพิ่มเติมจาก products
      let dbProduct: any = null;
      try {
        const prodRes = await pool.query(
          'SELECT product_template_id AS product_id, internal_reference, name, sales_description, brand, series, production FROM products WHERE model = $1 LIMIT 1',
          [code]
        );
        dbProduct = prodRes.rows[0];
      } catch (err) {
        console.error(`Error querying product details for code ${code}:`, err);
      }

      // ดึงค่า fallback
      const finalInternalRef = dbProduct?.internal_reference || code;
      const finalProductId = dbProduct?.product_id || item.product_id || null;
      const finalName = dbProduct?.name || item.name || '';
      const finalSalesDesc = dbProduct?.sales_description || item.sales_description || '';
      
      const iBrand = dbProduct?.brand || item.brand || '';
      const iSeries = dbProduct?.series || item.series || '';
      const iProduction = dbProduct?.production || item.production || '';

      // หาเงื่อนไขการรับประกันและระยะเวลาจัดส่งตาม quotation_rules
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

      // คำนวณวันจัดส่งตามสถานะสต็อก (สมมติว่าเป็น in-stock ในการย้ายข้อมูลประวัติ หรือดึงตามกฎ)
      const deliveryInStockDays = matchedRule ? matchedRule.delivery_in_stock_days : 3;
      const deliveryOutOfStockDays = matchedRule ? matchedRule.delivery_out_of_stock_days : 7;

      itemDetails.push({
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

    console.log(`>>> Mapped ${itemDetails.length} Items.`);

    // --------------------------------------------------
    // 3. FETCH & BUILD EMPLOYEE DETAILS
    // --------------------------------------------------
    let salespersonId = null;
    let employeeDetails = null;

    if (quote.user_id) {
      try {
        const spRes = await pool.query(
          'SELECT salesperson_id, name, phone, employee_quotations, employee_quotations_phone FROM salesperson WHERE user_id = $1 LIMIT 1',
          [quote.user_id]
        );
        const spData = spRes.rows[0];

        if (spData) {
          salespersonId = spData.salesperson_id ? String(spData.salesperson_id).trim() : null;
          employeeDetails = {
            salesperson_id: salespersonId,
            saleperson: spData.name || '',
            sale_phone: spData.phone || '',
            employee_quotations: spData.employee_quotations || 'ชื่อแอดมิน',
            employee_quotations_phone: spData.employee_quotations_phone || 'เบอร์โทร'
          };
        }
      } catch (err) {
        console.error('Error fetching salesperson details for migration:', err);
      }
    }

    if (!employeeDetails) {
      employeeDetails = {
        salesperson_id: null,
        saleperson: 'ชื่อพนักงานขาย',
        sale_phone: 'เบอร์โทร',
        employee_quotations: 'ชื่อแอดมิน',
        employee_quotations_phone: 'เบอร์โทร'
      };
    }

    console.log('>>> Mapped Employee Details:', JSON.stringify(employeeDetails));

    // --------------------------------------------------
    // 4. UPDATE RECORD IN DATABASE
    // --------------------------------------------------
    await pool.query(`
      UPDATE quotations
      SET 
        customer_details = $1,
        item_details = $2,
        salesperson_id = $3,
        employee_details = $4
      WHERE id = $5
    `, [
      JSON.stringify(customerDetails),
      JSON.stringify(itemDetails),
      salespersonId,
      JSON.stringify(employeeDetails),
      quote.id
    ]);

    console.log(`✅ Successfully migrated Quotation ID: ${quote.id}`);
  }

  console.log('\n>>> All migrations finished successfully!');
}

async function main() {
  try {
    await runSchemaMigration();
    await migrateData();
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
