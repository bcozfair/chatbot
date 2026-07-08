import { pool } from '../config/db.js';

async function main() {
  try {
    const res = await pool.query(`
      SELECT 
        id, 
        quotation_no, 
        customer_details, 
        item_details->0 as first_item, 
        salesperson_id, 
        employee_details 
      FROM quotations 
      LIMIT 2;
    `);

    console.log('>>> Verification Results:');
    res.rows.forEach((row, idx) => {
      console.log(`\nRow ${idx + 1}:`);
      console.log(`- ID: ${row.id}`);
      console.log(`- Quote No: ${row.quotation_no}`);
      console.log(`- Salesperson ID: ${row.salesperson_id}`);
      console.log(`- Customer Details:`, JSON.stringify(row.customer_details, null, 2));
      console.log(`- Employee Details:`, JSON.stringify(row.employee_details, null, 2));
      console.log(`- First Item:`, JSON.stringify(row.first_item, null, 2));
    });

  } catch (err) {
    console.error('Verification failed:', err);
  } finally {
    await pool.end();
  }
}

main();
