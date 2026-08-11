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

async function addStoreIdToPromotions() {
  const connection = await pool.getConnection();
  try {
    console.log('Checking promotions table for store_id column...');
    
    // Check if column already exists
    const [columns] = await connection.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? 
      AND TABLE_NAME = 'promotions' 
      AND COLUMN_NAME = 'store_id'
    `, [process.env.MYSQL_DATABASE || 'laundry66']);
    
    if (columns && columns.length > 0) {
      console.log('✅ Column store_id already exists in promotions table');
      
      // Check if foreign key exists
      const [fkCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_schema = ?
          AND table_name = 'promotions'
          AND constraint_name = 'fk_promotions_store_id'
          AND constraint_type = 'FOREIGN KEY'
      `, [process.env.MYSQL_DATABASE || 'laundry66']);
      
      if (fkCheck[0].count === 0) {
        console.log('Adding foreign key constraint...');
        try {
          await connection.query(`
            ALTER TABLE promotions 
            ADD CONSTRAINT fk_promotions_store_id
            FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
          `);
          console.log('✅ Added foreign key constraint');
        } catch (error) {
          if (error.code !== 'ER_FK_DUP_NAME' && error.code !== 'ER_DUP_KEYNAME') {
            console.warn(`Warning adding foreign key: ${error.message}`);
          }
        }
      } else {
        console.log('✅ Foreign key constraint already exists');
      }
      
      process.exit(0);
    }
    
    // Add store_id column
    console.log('Adding store_id column to promotions table...');
    await connection.query(`
      ALTER TABLE promotions 
      ADD COLUMN store_id INT NULL AFTER created_by
    `);
    console.log('✅ Added store_id column to promotions table');
    
    // Add foreign key constraint
    try {
      await connection.query(`
        ALTER TABLE promotions 
        ADD CONSTRAINT fk_promotions_store_id
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
      `);
      console.log('✅ Added foreign key constraint');
    } catch (error) {
      console.warn(`Warning: Could not add foreign key (may already exist or stores table not ready): ${error.message}`);
    }
    
    console.log('✅ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Error adding store_id to promotions:', error);
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

addStoreIdToPromotions()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
