import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Create connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'laundry66',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  multipleStatements: true
});

async function addOrdersColumns() {
  const connection = await pool.getConnection();
  try {
    console.log('Checking orders table for missing columns...');
    
    const DB_NAME = process.env.MYSQL_DATABASE || 'laundry66';
    
    // Check if store_id column exists
    const [storeIdCheck] = await connection.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? 
      AND TABLE_NAME = 'orders' 
      AND COLUMN_NAME = 'store_id'
    `, [DB_NAME]);
    
    // Check if payment_method column exists
    const [paymentMethodCheck] = await connection.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? 
      AND TABLE_NAME = 'orders' 
      AND COLUMN_NAME = 'payment_method'
    `, [DB_NAME]);
    
    if (storeIdCheck && storeIdCheck.length > 0 && paymentMethodCheck && paymentMethodCheck.length > 0) {
      console.log('✅ All columns already exist in orders table');
      process.exit(0);
    }
    
    // Add store_id column if missing
    if (!storeIdCheck || storeIdCheck.length === 0) {
      console.log('Adding store_id column to orders table...');
      await connection.query(`
        ALTER TABLE orders 
        ADD COLUMN store_id INT NULL AFTER promotion_id
      `);
      console.log('✅ Added store_id column');
      
      // Add foreign key constraint
      try {
        await connection.query(`
          ALTER TABLE orders 
          ADD CONSTRAINT fk_orders_store_id
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
        `);
        console.log('✅ Added foreign key constraint for store_id');
      } catch (error) {
        if (error.code !== 'ER_FK_DUP_NAME' && error.code !== 'ER_DUP_KEYNAME') {
          console.warn(`Warning adding foreign key: ${error.message}`);
        }
      }
    } else {
      console.log('✅ store_id column already exists');
    }
    
    // Add payment_method column if missing
    if (!paymentMethodCheck || paymentMethodCheck.length === 0) {
      console.log('Adding payment_method column to orders table...');
      await connection.query(`
        ALTER TABLE orders 
        ADD COLUMN payment_method ENUM('cash', 'transfer') DEFAULT NULL AFTER store_id
      `);
      console.log('✅ Added payment_method column');
    } else {
      console.log('✅ payment_method column already exists');
    }
    
    console.log('✅ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Error adding columns to orders:', error);
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

addOrdersColumns()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
