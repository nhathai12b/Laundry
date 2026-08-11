import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

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

async function addTimesheetsWithdrawn() {
  const connection = await pool.getConnection();
  try {
    const dbName = process.env.MYSQL_DATABASE || 'laundry66';
    console.log('Checking timesheets.withdrawn_amount...');

    const [check] = await connection.query(`
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'timesheets'
        AND column_name = 'withdrawn_amount'
    `, [dbName]);

    if (check[0].count === 0) {
      console.log('Adding timesheets.withdrawn_amount column...');
      await connection.query(`
        ALTER TABLE timesheets
        ADD COLUMN withdrawn_amount DECIMAL(10, 2) DEFAULT NULL
        AFTER expected_revenue
      `);
      console.log('✓ timesheets.withdrawn_amount added');
    } else {
      console.log('✓ timesheets.withdrawn_amount already exists');
    }

    console.log('Migration complete!');
  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

addTimesheetsWithdrawn();
