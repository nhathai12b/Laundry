import { pool, query, queryOne } from '../database/db.js';
import dotenv from 'dotenv';

dotenv.config();

async function createLoginAttemptsTable() {
  let connection;
  try {
    connection = await pool.getConnection();
    
    console.log('Checking if login_attempts table exists...');
    
    const DB_NAME = process.env.MYSQL_DATABASE || 'laundry66';
    
    // Check if table exists
    const [check] = await connection.query(`
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'login_attempts'
    `, [DB_NAME]);

    if (check?.[0]?.count > 0) {
      console.log('✅ Table login_attempts already exists');
      return;
    }

    console.log('Creating login_attempts table...');
    
    // Create table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(50),
        ip_address VARCHAR(45),
        success BOOLEAN NOT NULL DEFAULT false,
        failure_reason TEXT,
        user_agent TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_phone (phone),
        INDEX idx_ip (ip_address),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    console.log('✅ Created login_attempts table');
    console.log('✅ Created indexes for login_attempts table');
    console.log('✅ Migration completed successfully!');
  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR' || error.code === 'ER_DUP_TABLE') {
      console.log('✅ Table login_attempts already exists');
    } else {
      console.error('Error creating login_attempts table:', error);
      throw error;
    }
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// Run migration
createLoginAttemptsTable()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
