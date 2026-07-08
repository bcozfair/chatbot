import { pool } from '../config/db.js';
import bcrypt from 'bcryptjs';

async function initAdminDb() {
  const client = await pool.connect();
  try {
    console.log('--- Database Initialization Started ---');
    
    // 1. Create admin_users table
    console.log('Creating "admin_users" table if it doesn\'t exist...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(20) DEFAULT 'admin' NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
    `);
    console.log('Table "admin_users" created or already exists.');

    // 2. Check if default admin exists
    const checkRes = await client.query('SELECT id FROM admin_users WHERE username = $1', ['admin']);
    
    if (checkRes.rows.length === 0) {
      console.log('Inserting default admin user...');
      const defaultPassword = 'adminpassword';
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(defaultPassword, salt);
      
      await client.query(`
        INSERT INTO admin_users (username, password_hash, name, role)
        VALUES ($1, $2, $3, $4)
      `, ['admin', passwordHash, 'Administrator', 'admin']);
      
      console.log('Default admin user created successfully.');
      console.log('Username: admin');
      console.log('Password: adminpassword');
    } else {
      console.log('Default admin user already exists. Skipping insertion.');
    }
    
    console.log('--- Database Initialization Completed ---');
  } catch (error) {
    console.error('Error initializing database:', error);
  } finally {
    client.release();
    // Close the pool so the node script exits cleanly
    await pool.end();
  }
}

initAdminDb().catch(err => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
