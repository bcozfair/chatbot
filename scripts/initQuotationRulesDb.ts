import { pool } from '../config/db.js';

async function initQuotationRulesDb() {
  const client = await pool.connect();
  try {
    console.log('--- Database Initialization Started: Quotation Rules ---');

    // 1. Create quotation_rules table
    console.log('Creating "quotation_rules" table if it doesn\'t exist...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS quotation_rules (
        id SERIAL PRIMARY KEY,
        production TEXT DEFAULT NULL,
        brand TEXT DEFAULT NULL,
        series TEXT DEFAULT NULL,
        warranty_years INT NOT NULL DEFAULT 1,
        warranty_unit VARCHAR(10) NOT NULL DEFAULT 'year' CHECK (warranty_unit IN ('month', 'year')),
        is_locked BOOLEAN NOT NULL DEFAULT FALSE,
        delivery_in_stock_days INT NOT NULL DEFAULT 3,
        delivery_out_of_stock_days INT NOT NULL DEFAULT 7,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);
    console.log('Table "quotation_rules" created or already exists.');

    // 2. Default quotation rules to seed
    const defaultRules = [
      // Production based rules
      { production: 'Production 1', brand: null, series: null, warranty_years: 2, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 7 },
      { production: 'Production 2', brand: null, series: null, warranty_years: 0, is_locked: true,  delivery_in_stock_days: 0, delivery_out_of_stock_days: 0 },
      { production: 'PE',           brand: null, series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 7 },
      { production: 'LM',           brand: null, series: null, warranty_years: 2, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 7 },
      
      // Import Brand based rules
      { production: 'Import', brand: 'AECO',         series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 150 },
      { production: 'Import', brand: 'ANA',          series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 180 },
      { production: 'Import', brand: 'CAMYORK',      series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 90 },
      { production: 'Import', brand: 'CELDUC',       series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 300 },
      { production: 'Import', brand: 'COMMONWEALTH', series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 150 },
      { production: 'Import', brand: 'ECOFIT',       series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 300 },
      { production: 'Import', brand: 'GEFRAN',       series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 120 },
      { production: 'Import', brand: 'HONEST',       series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 150 },
      { production: 'Import', brand: 'KLEMSAN',      series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 180 },
      { production: 'Import', brand: 'OPKON',        series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 120 },
      { production: 'Import', brand: 'OPTEX',        series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 90 },
      { production: 'Import', brand: 'PROFOLATTI',  series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 180 },
      { production: 'Import', brand: 'SMARTSCAN',    series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 120 },
      { production: 'Import', brand: 'TOHO',         series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 120 },
      { production: 'Import', brand: 'TRAFAG',       series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 150 },
      { production: 'Import', brand: 'UNITRONICS',   series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 180 },
      { production: 'Import', brand: 'ZONZEN',       series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 180 },
      { production: 'Import', brand: 'LIGENT',       series: null, warranty_years: 1, is_locked: false, delivery_in_stock_days: 3, delivery_out_of_stock_days: 120 }
    ];

    for (const rule of defaultRules) {
      let checkRes;
      if (rule.brand) {
        checkRes = await client.query('SELECT id FROM quotation_rules WHERE brand = $1', [rule.brand]);
      } else {
        checkRes = await client.query('SELECT id FROM quotation_rules WHERE production = $1 AND brand IS NULL', [rule.production]);
      }

      if (checkRes.rows.length === 0) {
        console.log(`Inserting quotation rule for: ${rule.brand || rule.production}...`);
        await client.query(`
          INSERT INTO quotation_rules (production, brand, series, warranty_years, warranty_unit, is_locked, delivery_in_stock_days, delivery_out_of_stock_days)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          rule.production,
          rule.brand,
          rule.series,
          rule.warranty_years,
          'year',
          rule.is_locked,
          rule.delivery_in_stock_days,
          rule.delivery_out_of_stock_days
        ]);
      } else {
        console.log(`Quotation rule for ${rule.brand || rule.production} already exists. Skipping.`);
      }
    }

    console.log('--- Database Initialization Completed: Quotation Rules ---');
  } catch (error) {
    console.error('Error initializing quotation rules database:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

initQuotationRulesDb().catch(err => {
  console.error('Fatal quotation rules initialization error:', err);
  process.exit(1);
});
