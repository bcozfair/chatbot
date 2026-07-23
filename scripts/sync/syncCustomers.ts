import { pathToFileURL } from 'url';
import { pool } from '../../config/db.js';
import { createGatewayGet, sleep } from './gatewayClient.js';
import { decidePageTransition, MAX_STALL_RETRIES } from './syncPagination.js';

const INITIAL_SINCE = '1970-01-01T00:00:00.000Z';
const PAGE_LIMIT = 200; // Keep the original limit of 200 for customer sync

const gatewayGet = createGatewayGet(['Customer_full_sync', 'customer_updates', 'GATEWAY_API_KEY']);

async function ensureSyncState(dbClient: any) {
  await dbClient.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      resource TEXT PRIMARY KEY,
      sync_cursor TEXT,
      sync_cursor_timestamp TEXT,
      sync_mode TEXT NOT NULL DEFAULT 'full',
      pages_synced INTEGER NOT NULL DEFAULT 0,
      records_synced INTEGER NOT NULL DEFAULT 0,
      last_success_at TIMESTAMPTZ
    )
  `);

  await dbClient.query(`
    ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS sync_cursor_timestamp TEXT;
  `);
  await dbClient.query(`
    ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS sync_mode TEXT NOT NULL DEFAULT 'full';
  `);
  await dbClient.query(`
    ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS pages_synced INTEGER NOT NULL DEFAULT 0;
  `);
  await dbClient.query(`
    ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS records_synced INTEGER NOT NULL DEFAULT 0;
  `);

  await dbClient.query(`
    ALTER TABLE sync_state ALTER COLUMN sync_cursor DROP NOT NULL;
  `);
  await dbClient.query(`
    ALTER TABLE sync_state ALTER COLUMN sync_cursor_timestamp DROP NOT NULL;
  `);

  await dbClient.query(`
    INSERT INTO sync_state (
      resource,
      sync_cursor,
      sync_cursor_timestamp,
      sync_mode,
      pages_synced,
      records_synced
    )
    VALUES ('res_partner', NULL, NULL, 'full', 0, 0)
    ON CONFLICT (resource) DO NOTHING
  `);
}

async function loadSyncState(dbClient: any) {
  const result = await dbClient.query(`
    SELECT
      sync_cursor,
      sync_cursor_timestamp,
      sync_mode,
      pages_synced,
      records_synced
    FROM sync_state
    WHERE resource = 'res_partner'
  `);

  if (result.rows.length === 0) {
    return {
      cursorToken: null,
      cursorTimestamp: null,
      syncMode: 'full',
      pagesSynced: 0,
      recordsSynced: 0
    };
  }

  const row = result.rows[0];
  return {
    cursorToken: row.sync_cursor || null,
    cursorTimestamp: row.sync_cursor_timestamp || null,
    syncMode: row.sync_mode === 'incremental' ? 'incremental' : 'full',
    pagesSynced: Number(row.pages_synced || 0),
    recordsSynced: Number(row.records_synced || 0)
  };
}

async function saveSyncState(dbClient: any, nextState: any) {
  await dbClient.query(`
    UPDATE sync_state
    SET
      sync_cursor = $1,
      sync_cursor_timestamp = $2,
      sync_mode = $3,
      pages_synced = $4,
      records_synced = $5,
      last_success_at = NOW()
    WHERE resource = 'res_partner'
  `, [
    nextState.cursorToken,
    nextState.cursorTimestamp,
    nextState.syncMode,
    nextState.pagesSynced,
    nextState.recordsSynced
  ]);
}

async function upsertCustomerRows(dbClient: any, rows: any[]) {
  let batchIndex = 0;
  for (const row of rows) {
    batchIndex++;
    const companyId = row["Company ID"];
    const contactId = row["Contact ID"] || 0; // Prevent primary key from being NULL
    const companyName = row["Customer/Name"] || 'N/A';
    const contactName = row["Contact/Name"] || 'N/A';

    const progressPercent = ((batchIndex / rows.length) * 100).toFixed(2);
    console.log(`   [${batchIndex}/${rows.length}] (${progressPercent}%) Saving -> Company: ${companyName.substring(0, 30)} (ID: ${companyId}) | Contact: ${contactName} (ID: ${contactId})`);

    const query = `
      INSERT INTO customers (
        company_id, contact_id, sync_updated_at, company_updated_at, contact_updated_at,
        customer_reference, customer_tax_id, customer_name, contact_name, contact_mobile,
        contact_phone, contact_email, invoice_street, invoice_district, invoice_sub_district,
        invoice_state, invoice_zip, salesperson, salesperson_phone, sales_team,
        customer_sale_area, customer_type, tags, industry_type, customer_payment_terms,
        main_income, company_capital, source_name, customer_status, phone,
        mobile, email, fax, website_link, line,
        facebook, company_employee, special, language, referred_by,
        business_type, zone, opportunity_to_buy, branch, customer_no_tax_id,
        type, grade, date_last, date_paid, to_envelope, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, NOW()
      ) ON CONFLICT (company_id, contact_id) DO UPDATE SET
        sync_updated_at = EXCLUDED.sync_updated_at,
        company_updated_at = EXCLUDED.company_updated_at,
        contact_updated_at = EXCLUDED.contact_updated_at,
        customer_reference = EXCLUDED.customer_reference,
        customer_tax_id = EXCLUDED.customer_tax_id,
        customer_name = EXCLUDED.customer_name,
        contact_name = EXCLUDED.contact_name,
        contact_mobile = EXCLUDED.contact_mobile,
        contact_phone = EXCLUDED.contact_phone,
        contact_email = EXCLUDED.contact_email,
        invoice_street = EXCLUDED.invoice_street,
        invoice_district = EXCLUDED.invoice_district,
        invoice_sub_district = EXCLUDED.invoice_sub_district,
        invoice_state = EXCLUDED.invoice_state,
        invoice_zip = EXCLUDED.invoice_zip,
        salesperson = EXCLUDED.salesperson,
        salesperson_phone = EXCLUDED.salesperson_phone,
        sales_team = EXCLUDED.sales_team,
        customer_sale_area = EXCLUDED.customer_sale_area,
        customer_type = EXCLUDED.customer_type,
        tags = EXCLUDED.tags,
        industry_type = EXCLUDED.industry_type,
        customer_payment_terms = EXCLUDED.customer_payment_terms,
        main_income = EXCLUDED.main_income,
        company_capital = EXCLUDED.company_capital,
        source_name = EXCLUDED.source_name,
        customer_status = EXCLUDED.customer_status,
        phone = EXCLUDED.phone,
        mobile = EXCLUDED.mobile,
        email = EXCLUDED.email,
        fax = EXCLUDED.fax,
        website_link = EXCLUDED.website_link,
        line = EXCLUDED.line,
        facebook = EXCLUDED.facebook,
        company_employee = EXCLUDED.company_employee,
        special = EXCLUDED.special,
        language = EXCLUDED.language,
        referred_by = EXCLUDED.referred_by,
        business_type = EXCLUDED.business_type,
        zone = EXCLUDED.zone,
        opportunity_to_buy = EXCLUDED.opportunity_to_buy,
        branch = EXCLUDED.branch,
        customer_no_tax_id = EXCLUDED.customer_no_tax_id,
        type = EXCLUDED.type,
        grade = EXCLUDED.grade,
        date_last = EXCLUDED.date_last,
        date_paid = EXCLUDED.date_paid,
        to_envelope = EXCLUDED.to_envelope,
        updated_at = NOW();
    `;

    const values = [
      companyId,
      contactId,
      row["Sync Updated At"] ? new Date(row["Sync Updated At"]) : null,
      row["Company Updated At"] ? new Date(row["Company Updated At"]) : null,
      row["Contact Updated At"] ? new Date(row["Contact Updated At"]) : null,
      row["Customer/Reference"],
      row["Customer/Tax ID"],
      row["Customer/Name"],
      row["Contact/Name"],
      row["Contact/Mobile"],
      row["Contact/Phone"],
      row["Contact/Email"],
      row["Invoice Address/Street"],
      row["Invoice Address/District"],
      row["Invoice Address/Sub District"],
      row["Invoice Address/State"],
      row["Invoice Address/Zip"],
      row["Salesperson"],
      row["Salesperson/Phone"],
      row["Sales Team"],
      row["Customer/Sale Area"],
      row["Customer Type"],
      row["Tags"],
      row["Industry Type"],
      row["Customer Payment Terms"],
      row["Main Income"],
      row["Company Capital"] || 0,
      row["Source/Source Name"],
      row["Customer type"],
      row["Phone"],
      row["Mobile"],
      row["Email"],
      row["Fax"],
      row["Website Link"],
      row["Line"],
      row["Facebook"],
      row["Company Employee"],
      row["Special"],
      row["Language"],
      row["Referred By"],
      row["Business Type"],
      row["Zone"],
      row["Opportunity To Buy"],
      row["Branch"],
      row["Customer No TAX-ID"] === true,
      row["Type"],
      row["Grade"],
      row["Date Last"] ? new Date(row["Date Last"]) : null,
      row["Date Paid"] ? new Date(row["Date Paid"]) : null,
      row["To Envelope"]
    ];

    await dbClient.query(query, values);
  }
}

function buildRecordsPath(cursorToken: string | null) {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_LIMIT));

  if (cursorToken) {
    params.set('cursor', cursorToken);
  } else {
    params.set('since', INITIAL_SINCE);
  }

  return `/api/odoo/customer_updated_records_v2?${params.toString()}`;
}

// ============================================================
// Main Sync Function
// ============================================================
export async function syncCustomers(opts?: { forceFull?: boolean }) {
  let dbClient: any;
  const startTime = Date.now();
  const syncedCompanyIds = new Set();

  try {
    console.log('🔌 Connecting to PostgreSQL database using pool...');
    dbClient = await pool.connect();
    console.log('✅ Database client acquired from pool.');

    // 1. ตรวจสอบหรือสร้างตาราง customers และ sync_state
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS customers (
        company_id INT NOT NULL,
        contact_id INT NOT NULL,
        sync_updated_at TIMESTAMP WITH TIME ZONE,
        company_updated_at TIMESTAMP WITH TIME ZONE,
        contact_updated_at TIMESTAMP WITH TIME ZONE,
        customer_reference TEXT,
        customer_tax_id TEXT,
        customer_name TEXT,
        contact_name TEXT,
        contact_mobile TEXT,
        contact_phone TEXT,
        contact_email TEXT,
        invoice_street TEXT,
        invoice_district TEXT,
        invoice_sub_district TEXT,
        invoice_state TEXT,
        invoice_zip TEXT,
        salesperson TEXT,
        salesperson_phone TEXT,
        sales_team TEXT,
        customer_sale_area TEXT,
        customer_type TEXT,
        tags TEXT,
        industry_type TEXT,
        customer_payment_terms TEXT,
        main_income TEXT,
        company_capital NUMERIC DEFAULT 0,
        source_name TEXT,
        customer_status TEXT,
        phone TEXT,
        mobile TEXT,
        email TEXT,
        fax TEXT,
        website_link TEXT,
        line TEXT,
        facebook TEXT,
        company_employee TEXT,
        special TEXT,
        language TEXT,
        referred_by TEXT,
        business_type TEXT,
        zone TEXT,
        opportunity_to_buy TEXT,
        branch TEXT,
        customer_no_tax_id BOOLEAN,
        type TEXT,
        grade TEXT,
        date_last TIMESTAMP WITH TIME ZONE,
        date_paid TIMESTAMP WITH TIME ZONE,
        to_envelope TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, contact_id)
      );
    `);

    await ensureSyncState(dbClient);

    // force-full: reset cursor เพื่อกวาดใหม่ทั้งหมดจาก since=1970 (npm run sync:customers -- --full)
    // ทำก่อนโหลด state และ persist ทันที เพื่อว่า crash กลางคันจะไม่ค้างชี้ cursor เก่า
    if (opts?.forceFull) {
      await dbClient.query(
        `UPDATE sync_state SET sync_cursor = NULL, sync_cursor_timestamp = NULL, sync_mode = 'full' WHERE resource = 'res_partner'`
      );
      console.log('♻️  force-full: reset cursor ของ res_partner แล้ว — จะกวาดใหม่ทั้งหมด');
    }

    // 2. โหลด cursor จาก DB
    const localState = await loadSyncState(dbClient);
    let cursorToken = localState.cursorToken || null;
    let cursorTimestamp = localState.cursorTimestamp || null;

    let syncMode = localState.syncMode || 'full';

    console.log(`⏳ Sync Mode: ${syncMode} | Cursor: ${cursorToken} | Timestamp: ${cursorTimestamp}`);

    let totalExpected = null;

    // 4. Pagination Loop
    console.log('📥 Starting to fetch updated records using v2 API...');
    let page = 0;
    let totalSynced = 0;
    let stallRetries = 0; // นับ retry ตอน cursor ไม่ขยับ — reset เป็น 0 ทุกครั้งที่ cursor ขยับจริง

    while (true) {
      const path = buildRecordsPath(cursorToken);
      page += 1;
      console.log(`\n🔄 Fetching page ${page}...`);
      console.log(`📤 REQUEST: GET ${path}`);

      const body = await gatewayGet(path);
      const payload = body?.payload;

      if (!payload || !Array.isArray(payload.data)) {
        throw new Error('Invalid gateway response: payload.data is missing');
      }

      console.log(`📥 RESPONSE:`, {
        cursor_position: payload.cursor_position,
        next_position: payload.next_position,
        next_cursor: payload.next_cursor ? `${payload.next_cursor.substring(0, 40)}...` : null,
        has_more: payload.has_more,
        company_count: payload.company_count,
        count: payload.count
      });

      // === BEGIN TRANSACTION FOR THIS PAGE ===
      await dbClient.query('BEGIN');

      try {
        if (payload.data.length > 0) {
          console.log(`📦 Received ${payload.data.length} contact rows (represents ${payload.company_count || 0} companies).`);

          for (const row of payload.data) {
            if (row["Company ID"]) {
              syncedCompanyIds.add(row["Company ID"]);
            }
          }

          await upsertCustomerRows(dbClient, payload.data);
          totalSynced += payload.data.length;

          // Progress log
          const elapsed = ((Date.now() - startTime) / 1000);
          const minutes = Math.floor(elapsed / 60);
          const seconds = (elapsed % 60).toFixed(2);
          const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
          const percent = totalExpected
            ? `${((syncedCompanyIds.size / totalExpected) * 100).toFixed(2)}%`
            : 'N/A';

          console.log(`✅ Saved ${payload.data.length} contact rows to DB.`);
          console.log(`📊 Progress -> ข้อมูลทั้งหมด: ${totalExpected !== null ? totalExpected + ' companies' : 'Unknown'} | ดึงไปแล้ว: ${syncedCompanyIds.size} companies (${percent}) | เวลา: ${timeStr} | (รวม ${totalSynced} contact rows)`);
        }

        // === Step 2: ตัดสินใจหน้าถัดไป (logic รวม + unit test ที่ syncPagination.ts) ===
        const previousCursor = cursorToken;
        const nextCursor = payload.next_cursor;
        const transition = decidePageTransition({
          hasMore: !!payload.has_more,
          nextCursor,
          previousCursor,
          stallRetries,
          maxStallRetries: MAX_STALL_RETRIES,
        });

        // cursor ไม่ขยับทั้งที่ has_more=true / next_cursor หาย → throw (จะถูกบันทึกเป็น failed
        // ไม่ใช่ break เงียบ ๆ ที่ startSync เข้าใจผิดว่า success ทั้งที่กวาดไม่ครบ)
        if (transition.action === 'error') {
          throw new Error(transition.reason);
        }

        if (transition.action === 'retry-stall') {
          stallRetries += 1;
          await dbClient.query('ROLLBACK'); // ทิ้งหน้านี้ (upsert idempotent) แล้วดึง cursor เดิมซ้ำ
          console.warn(`⚠️ next_cursor ไม่ขยับ (has_more=true) — retry ${stallRetries}/${MAX_STALL_RETRIES}`);
          await sleep(2000);
          continue;
        }

        if (transition.action === 'complete') {
          // กวาดจบจริง (has_more=false) → flip เป็น incremental แล้วบันทึก cursor สุดท้าย
          if (nextCursor) {
            const ts = payload.next_position?.updated_at || cursorTimestamp;
            await saveSyncState(dbClient, {
              cursorToken: nextCursor,
              cursorTimestamp: ts,
              syncMode: 'incremental',
              pagesSynced: page,
              recordsSynced: totalSynced
            });
            console.log(`💾 Saved final cursor: ${nextCursor}`);
          }
          await dbClient.query('COMMIT');
          console.log('\n🏁 No more pages to fetch. Customer sync completed successfully.');
          break;
        }

        // transition.action === 'advance' — เลื่อน cursor ไปหน้าถัดไป
        stallRetries = 0;
        const nextTimestamp = payload.next_position?.updated_at || cursorTimestamp;
        await saveSyncState(dbClient, {
          cursorToken: nextCursor,
          cursorTimestamp: nextTimestamp,
          syncMode: syncMode,
          pagesSynced: page,
          recordsSynced: totalSynced
        });
        console.log(`💾 Saved cursor: ${nextCursor} | Timestamp: ${nextTimestamp}`);
        await dbClient.query('COMMIT');
        cursorToken = nextCursor;
        cursorTimestamp = nextTimestamp;

      } catch (transactionError) {
        await dbClient.query('ROLLBACK');
        console.error(`❌ Page transaction failed. Changes rolled back for page ${page}.`);
        throw transactionError;
      }

      await sleep(1200);
    }

    const totalElapsed = ((Date.now() - startTime) / 1000);
    const totalMin = Math.floor(totalElapsed / 60);
    const totalSec = (totalElapsed % 60).toFixed(2);
    console.log(`\n🎉 Sync Summary: ${syncedCompanyIds.size} unique companies | ${totalSynced} total contact rows | ${page} pages | Time: ${totalMin}m ${totalSec}s`);

  } catch (error: any) {
    console.error('❌ Customer Sync failed:', error.message);
    throw error;
  } finally {
    if (dbClient) {
      dbClient.release();
      console.log('🔌 Database connection released back to pool.');
    }
  }
}

// รันเป็น CLI เฉพาะเมื่อถูกเรียกตรง ๆ (npm run sync:customers) — ไม่รันเมื่อถูก import จาก backend
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const forceFull = process.argv.includes('--full') || process.env.SYNC_FULL === '1';
  syncCustomers({ forceFull }).catch((error) => {
    console.error('[customer-sync] failed', error);
    process.exit(1);
  });
}
