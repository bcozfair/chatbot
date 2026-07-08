import { pool } from '../config/db.js';

async function initPromotionsDb() {
  const client = await pool.connect();
  try {
    console.log('--- Database Initialization Started: Promotions ---');

    // 1. Create promotions table
    console.log('Creating "promotions" table if it doesn\'t exist...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        discount_type VARCHAR(20) NOT NULL,
        discount_value NUMERIC(10, 2) NOT NULL,
        product_code TEXT,
        customer_type TEXT,
        customer_refs TEXT,
        min_qty INTEGER DEFAULT 0 NOT NULL,
        start_date TIMESTAMP WITH TIME ZONE,
        end_date TIMESTAMP WITH TIME ZONE,
        is_active BOOLEAN DEFAULT TRUE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);
    console.log('Table "promotions" created or already exists.');

    // Add customer_refs column if it doesn't exist (for existing tables)
    console.log('Adding "customer_refs" column if not exists...');
    await client.query(`
      ALTER TABLE promotions ADD COLUMN IF NOT EXISTS customer_refs TEXT;
    `);
    console.log('Column "customer_refs" added or already exists.');

    // Alter product_code and customer_type to TEXT for existing tables to support unlimited comma-separated values
    console.log('Upgrading columns "product_code" and "customer_type" to TEXT...');
    await client.query(`
      ALTER TABLE promotions ALTER COLUMN product_code TYPE TEXT;
      ALTER TABLE promotions ALTER COLUMN customer_type TYPE TEXT;
    `);
    console.log('Columns "product_code" and "customer_type" upgraded successfully.');

    // 2. Insert default promotions if they don't exist
    const defaultPromos = [
      {
        code: 'FACTORY_10',
        name: 'ส่วนลดกลุ่มโรงงาน 10%',
        description: 'ส่วนลด 10% สำหรับกลุ่มลูกค้าประเภทโรงงาน',
        discount_type: 'percent',
        discount_value: 10.00,
        product_code: null,
        customer_type: 'โรงงาน',
        min_qty: 1
      },
      {
        code: 'CABINET_500',
        name: 'ส่วนลดกลุ่มประกอบตู้ 500 บาท',
        description: 'ลดราคา 500 บาท สำหรับลูกค้ากลุ่มประกอบตู้',
        discount_type: 'fixed',
        discount_value: 500.00,
        product_code: null,
        customer_type: 'ประกอบตู้',
        min_qty: 1
      },
      {
        code: 'OVERRIDE_SPECIAL',
        name: 'ปลดล็อกราคาพิเศษ (ข้าม Min. Price)',
        description: 'อนุญาตให้ผู้ขายคีย์ราคาสินค้าได้ต่ำกว่าราคาควบคุมขั้นต่ำ (Min. Price)',
        discount_type: 'override',
        discount_value: 0.00,
        product_code: null,
        customer_type: null,
        min_qty: 1
      }
    ];

    for (const promo of defaultPromos) {
      const checkRes = await client.query('SELECT id FROM promotions WHERE code = $1', [promo.code]);
      if (checkRes.rows.length === 0) {
        console.log(`Inserting sample promotion: ${promo.code}...`);
        await client.query(`
          INSERT INTO promotions (code, name, description, discount_type, discount_value, product_code, customer_type, min_qty)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          promo.code,
          promo.name,
          promo.description,
          promo.discount_type,
          promo.discount_value,
          promo.product_code,
          promo.customer_type,
          promo.min_qty
        ]);
        console.log(`Sample promotion ${promo.code} created successfully.`);
      } else {
        console.log(`Promotion ${promo.code} already exists. Skipping.`);
      }
    }

    console.log('--- Database Initialization Completed: Promotions ---');
  } catch (error) {
    console.error('Error initializing promotions database:', error);
  } finally {
    client.release();
    // Close the pool so the node script exits cleanly
    await pool.end();
  }
}

initPromotionsDb().catch(err => {
  console.error('Fatal promotions initialization error:', err);
  process.exit(1);
});