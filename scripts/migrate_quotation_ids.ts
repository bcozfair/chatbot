import { pool } from '../config/db.js';

async function migrateQuotationIds() {
  console.log("=== Starting Quotation IDs Backfill Migration ===");
  const client = await pool.connect();
  try {
    const quotesRes = await client.query(
      "SELECT id, customer_details FROM quotations ORDER BY created_at DESC"
    );
    console.log(`Found ${quotesRes.rows.length} quotations to process.`);

    let successCount = 0;
    let failCount = 0;

    for (const row of quotesRes.rows) {
      const quoteId = row.id;
      const customerDetails = row.customer_details;

      if (!customerDetails) {
        console.log(`[Quote ${quoteId}] Skipped: No customer_details snapshot.`);
        continue;
      }

      let companyName = customerDetails.customer_name || '';
      let contactName = customerDetails.contact_name || '';

      // Handle legacy pipe-delimited format inside customer_name if present
      if (companyName && companyName.includes(' | ')) {
        const parts = companyName.split(' | ');
        companyName = parts[0].trim();
        if (parts[1] && (!contactName || contactName === '-' || contactName === 'ลูกค้าทั่วไป')) {
          contactName = parts[1].trim();
        }
      }

      companyName = companyName.trim();
      contactName = contactName.trim();

      if (!companyName || companyName === 'ลูกค้าทั่วไป') {
        console.log(`[Quote ${quoteId}] General customer, skipped.`);
        continue;
      }

      let customerId: number | null = null;
      let contactId: number | null = null;

      // 1. Find Customer ID
      try {
        const custRes = await client.query(
          "SELECT id FROM customers_view WHERE TRIM(display_name) = TRIM($1) LIMIT 1",
          [companyName]
        );
        if (custRes.rows[0]) {
          customerId = custRes.rows[0].id;
        } else {
          // Try ILIKE match as fallback
          const fuzzyCustRes = await client.query(
            "SELECT id, display_name FROM customers_view WHERE display_name ILIKE $1 LIMIT 1",
            [`%${companyName}%`]
          );
          if (fuzzyCustRes.rows[0]) {
            customerId = fuzzyCustRes.rows[0].id;
            console.log(`[Quote ${quoteId}] Customer matched fuzzy: "${companyName}" -> "${fuzzyCustRes.rows[0].display_name}"`);
          }
        }
      } catch (err) {
        console.error(`[Quote ${quoteId}] Error querying customer_view:`, err);
      }

      // 2. Find Contact ID if customer was resolved and contact is valid
      if (customerId && contactName && contactName !== '-' && contactName !== 'ลูกค้าทั่วไป') {
        try {
          const contactRes = await client.query(
            "SELECT id FROM contacts_view WHERE customer_id = $1 AND TRIM(name) = TRIM($2) LIMIT 1",
            [customerId, contactName]
          );
          if (contactRes.rows[0]) {
            contactId = contactRes.rows[0].id;
          } else {
            // Try matching without title/prefix or fuzzy
            const cleanPrefix = (name: string) => name.replace(/^(คุณ|นาย|นางสาว|นาง|k\s+|k)/gi, '').trim();
            const cleanedContactName = cleanPrefix(contactName);
            
            const fuzzyContactRes = await client.query(
              "SELECT id, name FROM contacts_view WHERE customer_id = $1 AND (name ILIKE $2 OR name ILIKE $3) LIMIT 1",
              [customerId, `%${contactName}%`, `%${cleanedContactName}%`]
            );
            if (fuzzyContactRes.rows[0]) {
              contactId = fuzzyContactRes.rows[0].id;
              console.log(`[Quote ${quoteId}] Contact matched fuzzy: "${contactName}" -> "${fuzzyContactRes.rows[0].name}"`);
            }
          }
        } catch (err) {
          console.error(`[Quote ${quoteId}] Error querying contacts_view:`, err);
        }
      }

      // 3. Update Quotation
      if (customerId) {
        await client.query(
          "UPDATE quotations SET customer_id = $1, contact_id = $2, updated_at = NOW() WHERE id = $3",
          [customerId, contactId, quoteId]
        );
        successCount++;
        console.log(`[Quote ${quoteId}] Backfilled: customer_id = ${customerId}, contact_id = ${contactId || 'NULL'} ("${companyName}" | "${contactName}")`);
      } else {
        failCount++;
        console.log(`[Quote ${quoteId}] Failed to resolve customer: "${companyName}"`);
      }
    }

    console.log("=== Backfill Migration Finished ===");
    console.log(`Success: ${successCount} rows backfilled.`);
    console.log(`Failed/Skipped: ${failCount} rows.`);

  } catch (error) {
    console.error('Fatal backfill migration error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateQuotationIds().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
