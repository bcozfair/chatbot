import { pathToFileURL } from 'url';
import { pool } from '../../config/db.js';
import { createGatewayGet, sleep } from './gatewayClient.js';

const INITIAL_SINCE = '1970-01-01T00:00:00.000Z';
const PAGE_LIMIT = 500;

const gatewayGet = createGatewayGet(['Saleorder_full_sync', 'GATEWAY_API_KEY']);

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
    VALUES ('sale_order', NULL, NULL, 'full', 0, 0)
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
    WHERE resource = 'sale_order'
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
    WHERE resource = 'sale_order'
  `, [
    nextState.cursorToken,
    nextState.cursorTimestamp,
    nextState.syncMode,
    nextState.pagesSynced,
    nextState.recordsSynced
  ]);
}

async function upsertSaleOrderRows(dbClient: any, rows: any[]) {
  // Deduplicate rows in-memory to only keep one row per 'Order Reference'
  const uniqueRowsMap = new Map<string, any>();
  for (const row of rows) {
    const orderRef = row['Order Reference'];
    if (orderRef) {
      if (!uniqueRowsMap.has(orderRef)) {
        uniqueRowsMap.set(orderRef, row);
      }
    }
  }

  const uniqueRows = Array.from(uniqueRowsMap.values());

  for (const row of uniqueRows) {
    const modelCode = row['Model Code'] || 'N/A';
    const modelName = row['Model'] || 'N/A';

    await dbClient.query(`
      INSERT INTO sale_orders (
        order_reference, customer_reference, customer_tax_id, customer_name,
        contact_name, contact_mobile, contact_phone, invoice_street,
        invoice_district, invoice_sub_district, invoice_state, invoice_zip,
        order_date, customer_reference_po, delivery_street, delivery_district,
        delivery_sub_district, delivery_state, delivery_zip, employee_quotations,
        employee_quotations_phone, salesperson, salesperson_phone, sales_team,
        customer_sale_area, invoice_status, last_updated,
        sale_order_id, company_id, contact_id, salesperson_id,
        total_amount, total_discount, amount_after_discount, vat, net_amount,
        model, model_code, quantity, product_category, product_group,
        product_sub_category, product_series, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
        $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, NOW()
      )
      ON CONFLICT (order_reference) DO UPDATE SET
        customer_reference = EXCLUDED.customer_reference,
        customer_tax_id = EXCLUDED.customer_tax_id,
        customer_name = EXCLUDED.customer_name,
        contact_name = EXCLUDED.contact_name,
        contact_mobile = EXCLUDED.contact_mobile,
        contact_phone = EXCLUDED.contact_phone,
        invoice_street = EXCLUDED.invoice_street,
        invoice_district = EXCLUDED.invoice_district,
        invoice_sub_district = EXCLUDED.invoice_sub_district,
        invoice_state = EXCLUDED.invoice_state,
        invoice_zip = EXCLUDED.invoice_zip,
        order_date = EXCLUDED.order_date,
        customer_reference_po = EXCLUDED.customer_reference_po,
        delivery_street = EXCLUDED.delivery_street,
        delivery_district = EXCLUDED.delivery_district,
        delivery_sub_district = EXCLUDED.delivery_sub_district,
        delivery_state = EXCLUDED.delivery_state,
        delivery_zip = EXCLUDED.delivery_zip,
        employee_quotations = EXCLUDED.employee_quotations,
        employee_quotations_phone = EXCLUDED.employee_quotations_phone,
        salesperson = EXCLUDED.salesperson,
        salesperson_phone = EXCLUDED.salesperson_phone,
        sales_team = EXCLUDED.sales_team,
        customer_sale_area = EXCLUDED.customer_sale_area,
        invoice_status = EXCLUDED.invoice_status,
        last_updated = EXCLUDED.last_updated,
        sale_order_id = EXCLUDED.sale_order_id,
        company_id = EXCLUDED.company_id,
        contact_id = EXCLUDED.contact_id,
        salesperson_id = EXCLUDED.salesperson_id,
        total_amount = EXCLUDED.total_amount,
        total_discount = EXCLUDED.total_discount,
        amount_after_discount = EXCLUDED.amount_after_discount,
        vat = EXCLUDED.vat,
        net_amount = EXCLUDED.net_amount,
        model = EXCLUDED.model,
        model_code = EXCLUDED.model_code,
        quantity = EXCLUDED.quantity,
        product_category = EXCLUDED.product_category,
        product_group = EXCLUDED.product_group,
        product_sub_category = EXCLUDED.product_sub_category,
        product_series = EXCLUDED.product_series,
        updated_at = NOW()
    `, [
      row['Order Reference'],
      row['Customer/Reference'],
      row['Customer/Tax ID'],
      row['Customer/Name'],
      row['Contact/Name'],
      row['Contact/Mobile'],
      row['Contact/Phone'],
      row['Invoice Address/Street'],
      row['Invoice Address/District'],
      row['Invoice Address/Sub District'],
      row['Invoice Address/State'],
      row['Invoice Address/Zip'],
      row['Order Date'] ? new Date(row['Order Date']) : null,
      row['Customer Reference'],
      row['Delivery Address/Street'],
      row['Delivery Address/District'],
      row['Delivery Address/Sub District'],
      row['Delivery Address/State'],
      row['Delivery Address/Zip'],
      row['Employee Quotations'],
      row['Employee Quotations/Work Phone'],
      row['Salesperson'],
      row['Salesperson/Phone'],
      row['Sales Team'],
      row['Customer/Sale Area'],
      row['Invoice Status'],
      row['Last Updated'] ? new Date(row['Last Updated']) : null,
      row['Sale Order ID'],
      row.company_id,
      row.contact_id,
      row.salesperson_id,
      row['ยอดรวม'] ? parseFloat(row['ยอดรวม']) : 0,
      row['ยอดรวมส่วนลด'] ? parseFloat(row['ยอดรวมส่วนลด']) : 0,
      row['มูลค่าหลังหักส่วนลด'] ? parseFloat(row['มูลค่าหลังหักส่วนลด']) : 0,
      row.VAT ? parseFloat(row.VAT) : 0,
      row['ยอดเงินสุทธิ'] ? parseFloat(row['ยอดเงินสุทธิ']) : 0,
      modelName,
      modelCode,
      row.Quantity ? parseFloat(row.Quantity) : 0,
      row['Product Category'],
      row['Product Group'],
      row['Product Sub Category'],
      row['Product Series']
    ]);
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

  return `/api/odoo/sale_order_updated_records_v2?${params.toString()}`;
}

// ============================================================
// Main Sync Function
// ============================================================
export async function syncSaleOrders() {
  let dbClient: any;
  const startTime = Date.now();
  const syncedOrderIds = new Set();

  try {
    console.log('🔌 Connecting to PostgreSQL database using pool...');
    dbClient = await pool.connect();
    console.log('✅ Database client acquired from pool.');

    // 1. เตรียม sync_state
    await ensureSyncState(dbClient);

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
        sale_order_count: payload.sale_order_count,
        count: payload.count
      });

      // === BEGIN TRANSACTION FOR THIS PAGE ===
      await dbClient.query('BEGIN');

      try {
        if (payload.data.length > 0) {
          console.log(`📦 Received ${payload.data.length} rows (${payload.sale_order_count} sale orders).`);

          for (const row of payload.data) {
            if (row["Sale Order ID"]) syncedOrderIds.add(row["Sale Order ID"]);
          }

          await upsertSaleOrderRows(dbClient, payload.data);
          totalSynced += payload.data.length;

          // Progress log
          const elapsed = ((Date.now() - startTime) / 1000);
          const minutes = Math.floor(elapsed / 60);
          const seconds = (elapsed % 60).toFixed(2);
          const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
          const percent = totalExpected
            ? `${((syncedOrderIds.size / totalExpected) * 100).toFixed(2)}%`
            : 'N/A';

          console.log(`✅ Saved ${payload.data.length} rows to DB.`);
          console.log(`📊 Progress -> ข้อมูลทั้งหมด: ${totalExpected || 'Unknown'} orders | ดึงไปแล้ว: ${syncedOrderIds.size} orders (${percent}) | เวลา: ${timeStr} | (รวม ${totalSynced} lines)`);
        }

        // === Step 2: ตรวจสอบ has_more และบันทึก State ใน Transaction ===
        if (!payload.has_more) {
          if (payload.next_cursor) {
            const ts = payload.next_position?.updated_at || cursorTimestamp;
            await saveSyncState(dbClient, {
              cursorToken: payload.next_cursor,
              cursorTimestamp: ts,
              syncMode: 'incremental',
              pagesSynced: page,
              recordsSynced: totalSynced
            });
            console.log(`💾 Saved final cursor: ${payload.next_cursor}`);
          }
          await dbClient.query('COMMIT');
          console.log('\n🏁 No more pages to fetch. Sync completed successfully.');
          break;
        }

        // === Step 3: ตรวจสอบ next_cursor ===
        const previousCursor = cursorToken;
        const nextCursor = payload.next_cursor;

        if (!nextCursor || typeof nextCursor !== 'string') {
          throw new Error('has_more=true but next_cursor is missing from response');
        }

        if (nextCursor === previousCursor) {
          console.warn('⚠️ Warning: next_cursor did not advance (same as previous). Stopping to prevent infinite loop.');
          console.warn(`   previousCursor: ${previousCursor}`);
          console.warn(`   nextCursor:     ${nextCursor}`);
          await dbClient.query('COMMIT');
          break;
        }

        // === Step 4: บันทึก cursor ลง DB ใน Transaction ===
        const nextTimestamp = payload.next_position?.updated_at || cursorTimestamp;
        await saveSyncState(dbClient, {
          cursorToken: nextCursor,
          cursorTimestamp: nextTimestamp,
          syncMode: syncMode,
          pagesSynced: page,
          recordsSynced: totalSynced
        });
        console.log(`💾 Saved cursor: ${nextCursor} | Timestamp: ${nextTimestamp}`);

        // === COMMIT TRANSACTION FOR THIS PAGE ===
        await dbClient.query('COMMIT');

        // === Step 5: เลื่อน cursor ===
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
    console.log(`\n🎉 Sync Summary: ${syncedOrderIds.size} unique orders | ${totalSynced} total rows | ${page} pages | Time: ${totalMin}m ${totalSec}s`);

  } catch (error: any) {
    console.error('❌ Sync failed:', error.message);
    throw error;
  } finally {
    if (dbClient) {
      dbClient.release();
      console.log('🔌 Database connection released back to pool.');
    }
  }
}

// รันเป็น CLI เฉพาะเมื่อถูกเรียกตรง ๆ (npm run sync:saleorders) — ไม่รันเมื่อถูก import จาก backend
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncSaleOrders().catch((error) => {
    console.error('[sale-order-sync] failed', error);
    process.exit(1);
  });
}
