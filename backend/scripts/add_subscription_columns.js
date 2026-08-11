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

async function addSubscriptionColumns() {
  const connection = await pool.getConnection();
  try {
    console.log('Checking for subscription columns...');
    
    // Check if subscription_package column exists
    const [packageCheck] = await connection.query(`
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'users'
        AND column_name = 'subscription_package'
    `, [process.env.MYSQL_DATABASE || 'laundry66']);
    
    if (packageCheck[0].count === 0) {
      console.log('Adding subscription_package column...');
      await connection.query(`
        ALTER TABLE users
        ADD COLUMN subscription_package VARCHAR(50) NULL
        AFTER store_id
      `);
      console.log('✓ subscription_package column added');
    } else {
      console.log('✓ subscription_package column already exists');
    }
    
    // Check if subscription_expires_at column exists
    const [expiresCheck] = await connection.query(`
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'users'
        AND column_name = 'subscription_expires_at'
    `, [process.env.MYSQL_DATABASE || 'laundry66']);
    
    if (expiresCheck[0].count === 0) {
      console.log('Adding subscription_expires_at column...');
      await connection.query(`
        ALTER TABLE users
        ADD COLUMN subscription_expires_at DATETIME NULL
        AFTER subscription_package
      `);
      console.log('✓ subscription_expires_at column added');
    } else {
      console.log('✓ subscription_expires_at column already exists');
    }
    
    console.log('Migration complete!');
  } catch (error) {
    console.error('Error adding subscription columns:', error);
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

addSubscriptionColumns()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
