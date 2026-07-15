import dotenv from 'dotenv';
import { pathToFileURL } from 'url';
import { pool } from '../../config/db.js';

dotenv.config();

const INITIAL_SINCE = '1970-01-01T00:00:00.000Z';
const PAGE_LIMIT = 500;

function requiredEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  throw new Error(`Missing required environment variable. Expected one of: ${names.join(', ')}`);
}

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

const GATEWAY_BASE_URL = trimTrailingSlash(requiredEnv('GATEWAY_BASE_URL', 'gateway_host'));
const GATEWAY_API_KEY = requiredEnv('Product_full_sync', 'product_updates', 'GATEWAY_API_KEY');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function gatewayGet(path: string) {
  const url = `${GATEWAY_BASE_URL}${path}`;
  const maxAttempts = 5;
  let attempts = 0;
  let delay = 2000;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': GATEWAY_API_KEY
        }
      });

      if (response.status === 429 || response.status === 503 || response.status === 504) {
        if (attempts >= maxAttempts) {
          throw new Error(`Gateway API Error: ${response.status} - ${response.statusText} (max attempts reached)`);
        }
        console.warn(`[gateway] temporary ${response.status}, retrying in ${delay / 1000}s (${attempts}/${maxAttempts})`);
        await sleep(delay);
        delay *= 2;
        continue;
      }

      const body: any = await response.json();
      if (!response.ok) {
        const err: any = new Error(body?.message || body?.error || `Gateway API Error: ${response.status}`);
        err.status = response.status;
        throw err;
      }

      return body;
    } catch (error: any) {
      if (error?.status && [400, 401, 403, 404].includes(error.status)) {
        throw error;
      }
      if (attempts >= maxAttempts) {
        throw error;
      }
      console.warn(`[gateway] request failed: ${error.message}. retrying in ${delay / 1000}s (${attempts}/${maxAttempts})`);
      await sleep(delay);
      delay *= 2;
    }
  }

  throw new Error('Gateway request failed unexpectedly');
}

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
    VALUES ('product_template', NULL, NULL, 'full', 0, 0)
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
    WHERE resource = 'product_template'
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
    WHERE resource = 'product_template'
  `, [
    nextState.cursorToken,
    nextState.cursorTimestamp,
    nextState.syncMode,
    nextState.pagesSynced,
    nextState.recordsSynced
  ]);
}

async function upsertProductRows(dbClient: any, rows: any[]) {
  let batchIndex = 0;
  for (const row of rows) {
    batchIndex++;
    const templateId = row["Product Template ID"];
    const name = row["Name"] || 'N/A';
    const internalRef = row["Internal Reference"] || 'N/A';
    const salesPrice = row["Sales Price"] ? parseFloat(row["Sales Price"]) : 0;

    const progressPercent = ((batchIndex / rows.length) * 100).toFixed(2);
    console.log(`   [${batchIndex}/${rows.length}] (${progressPercent}%) Saving -> Name: ${name.substring(0, 30)} (ID: ${templateId}) | Ref: ${internalRef} | Price: ${salesPrice}`);

    const query = `
      INSERT INTO products (
        product_template_id, sync_updated_at, sequence, internal_reference, name,
        brand, series, model, sales_price, minimum_sales_price,
        product_group, product_category, product_sub_category, production, quantity_on_hand,
        quantity_on_hand_unreserved, actual_quantity, incoming, outgoing, unit_of_measure,
        costing_method, activity_exception_decoration, optional_products, sales_description, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, NOW()
      ) ON CONFLICT (product_template_id) DO UPDATE SET
        sync_updated_at = EXCLUDED.sync_updated_at,
        sequence = EXCLUDED.sequence,
        internal_reference = EXCLUDED.internal_reference,
        name = EXCLUDED.name,
        brand = EXCLUDED.brand,
        series = EXCLUDED.series,
        model = EXCLUDED.model,
        sales_price = EXCLUDED.sales_price,
        minimum_sales_price = EXCLUDED.minimum_sales_price,
        product_group = EXCLUDED.product_group,
        product_category = EXCLUDED.product_category,
        product_sub_category = EXCLUDED.product_sub_category,
        production = EXCLUDED.production,
        quantity_on_hand = EXCLUDED.quantity_on_hand,
        quantity_on_hand_unreserved = EXCLUDED.quantity_on_hand_unreserved,
        actual_quantity = EXCLUDED.actual_quantity,
        incoming = EXCLUDED.incoming,
        outgoing = EXCLUDED.outgoing,
        unit_of_measure = EXCLUDED.unit_of_measure,
        costing_method = EXCLUDED.costing_method,
        activity_exception_decoration = EXCLUDED.activity_exception_decoration,
        optional_products = EXCLUDED.optional_products,
        sales_description = EXCLUDED.sales_description,
        updated_at = NOW();
    `;

    const values = [
      templateId,
      row["Sync Updated At"] ? new Date(row["Sync Updated At"]) : null,
      row["Sequence"] ? parseInt(row["Sequence"]) : null,
      row["Internal Reference"],
      row["Name"],
      row["Brand"],
      row["Series"],
      row["Model"],
      salesPrice,
      row["Minimum Sales Price"] ? parseFloat(row["Minimum Sales Price"]) : 0,
      row["Product Group"],
      row["Product Category"],
      row["Product Sub Category"],
      row["Production"],
      row["Quantity On Hand"] ? parseFloat(row["Quantity On Hand"]) : 0,
      row["Quantity On Hand Unreserved"] ? parseFloat(row["Quantity On Hand Unreserved"]) : 0,
      row["Actual Quantity"] ? parseFloat(row["Actual Quantity"]) : 0,
      row["Incoming"] ? parseFloat(row["Incoming"]) : 0,
      row["Outgoing"] ? parseFloat(row["Outgoing"]) : 0,
      row["Unit of Measure"],
      row["Costing Method"],
      row["Activity Exception Decoration"],
      row["Optional Products"],
      row["Sales Description"]
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

  return `/api/odoo/product_updated_records_v2?${params.toString()}`;
}

// ============================================================
// Main Sync Function
// ============================================================
export async function syncProducts() {
  let dbClient: any;
  const startTime = Date.now();
  const syncedTemplateIds = new Set();

  try {
    console.log('🔌 Connecting to PostgreSQL database using pool...');
    dbClient = await pool.connect();
    console.log('✅ Database client acquired from pool.');

    // 1. ตรวจสอบหรือสร้างตาราง products และ sync_state
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS products (
        product_template_id INT PRIMARY KEY,
        sync_updated_at TIMESTAMP WITH TIME ZONE,
        sequence INT,
        internal_reference TEXT,
        name TEXT,
        brand TEXT,
        series TEXT,
        model TEXT,
        sales_price NUMERIC,
        minimum_sales_price NUMERIC,
        product_group TEXT,
        product_category TEXT,
        product_sub_category TEXT,
        production TEXT,
        quantity_on_hand NUMERIC DEFAULT 0,
        quantity_on_hand_unreserved NUMERIC DEFAULT 0,
        actual_quantity NUMERIC DEFAULT 0,
        incoming NUMERIC DEFAULT 0,
        outgoing NUMERIC DEFAULT 0,
        unit_of_measure TEXT,
        costing_method TEXT,
        activity_exception_decoration TEXT,
        optional_products TEXT,
        sales_description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

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
        product_count: payload.product_count,
        count: payload.count
      });

      // === BEGIN TRANSACTION FOR THIS PAGE ===
      await dbClient.query('BEGIN');

      try {
        if (payload.data.length > 0) {
          console.log(`📦 Received ${payload.data.length} product rows (represents ${payload.product_count || 0} templates).`);

          const validData = payload.data.filter((row: any) => {
            const prod = row["Production"];
            if (prod === null || prod === undefined || prod === '') return false;
            if (typeof prod === 'string' && (prod.toUpperCase() === 'NULL' || prod.toUpperCase() === 'NONE')) return false;
            return true;
          });

          const skippedCount = payload.data.length - validData.length;
          if (skippedCount > 0) {
            console.log(`🧹 Filtered: Skipped ${skippedCount} product rows with NULL/empty Production. (${validData.length} rows remaining)`);
          }

          for (const row of validData) {
            if (row["Product Template ID"]) {
              syncedTemplateIds.add(row["Product Template ID"]);
            }
          }

          await upsertProductRows(dbClient, validData);
          totalSynced += validData.length;

          // Progress log
          const elapsed = ((Date.now() - startTime) / 1000);
          const minutes = Math.floor(elapsed / 60);
          const seconds = (elapsed % 60).toFixed(2);
          const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
          const percent = totalExpected
            ? `${((syncedTemplateIds.size / totalExpected) * 100).toFixed(2)}%`
            : 'N/A';

          console.log(`✅ Saved ${payload.data.length} product rows to DB.`);
          console.log(`📊 Progress -> ข้อมูลทั้งหมด: ${totalExpected !== null ? totalExpected + ' templates' : 'Unknown'} | ดึงไปแล้ว: ${syncedTemplateIds.size} templates (${percent}) | เวลา: ${timeStr} | (รวม ${totalSynced} rows)`);
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
          console.log('\n🏁 No more pages to fetch. Product sync completed successfully.');
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
    console.log(`\n🎉 Sync Summary: ${syncedTemplateIds.size} unique templates | ${totalSynced} total rows | ${page} pages | Time: ${totalMin}m ${totalSec}s`);

  } catch (error: any) {
    console.error('❌ Product Sync failed:', error.message);
    throw error;
  } finally {
    if (dbClient) {
      dbClient.release();
      console.log('🔌 Database connection released back to pool.');
    }
  }
}

// รันเป็น CLI เฉพาะเมื่อถูกเรียกตรง ๆ (npm run sync:products) — ไม่รันเมื่อถูก import จาก backend
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncProducts().catch((error) => {
    console.error('[product-sync] failed', error);
    process.exit(1);
  });
}
