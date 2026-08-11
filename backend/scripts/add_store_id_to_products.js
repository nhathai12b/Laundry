import { pool, query, queryOne } from '../database/db.js';
import dotenv from 'dotenv';

dotenv.config();

async function addStoreIdToProducts() {
  let connection;
  try {
    connection = await pool.getConnection();
    
    console.log('Checking products table for missing store_id column...');
    
    // Check if store_id column exists
    const [check] = await connection.query(`
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'products' AND column_name = 'store_id'
    `, [process.env.MYSQL_DATABASE || 'laundry66']);

    if (check?.[0]?.count > 0) {
      console.log('✅ Column products.store_id already exists');
      
      // Check if foreign key exists
      const [fkCheck] = await connection.query(`
        SELECT COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_schema = ? AND table_name = 'products' AND constraint_name = 'fk_products_store_id'
      `, [process.env.MYSQL_DATABASE || 'laundry66']);
      
      if (fkCheck?.[0]?.count > 0) {
        console.log('✅ Foreign key fk_products_store_id already exists');
        console.log('✅ Migration not needed - all columns and constraints are present');
        return;
      } else {
        console.log('Adding foreign key constraint for store_id...');
        try {
          await connection.query(`
            ALTER TABLE products 
            ADD CONSTRAINT fk_products_store_id 
            FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
          `);
          console.log('✅ Added foreign key constraint for store_id');
        } catch (fkError) {
          if (fkError.code === 'ER_FK_DUP_NAME' || fkError.code === 'ER_DUP_KEYNAME') {
            console.log('✅ Foreign key fk_products_store_id already exists');
          } else {
            throw fkError;
          }
        }
        return;
      }
    }

    console.log('Adding store_id column to products table...');
    
    // Add store_id column
    await connection.query(`
      ALTER TABLE products 
      ADD COLUMN store_id INT NULL AFTER updated_by
    `);
    
    console.log('✅ Added store_id column');
    
    // Add foreign key constraint
    try {
      await connection.query(`
        ALTER TABLE products 
        ADD CONSTRAINT fk_products_store_id 
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
      `);
      console.log('✅ Added foreign key constraint for store_id');
    } catch (fkError) {
      if (fkError.code === 'ER_FK_DUP_NAME' || fkError.code === 'ER_DUP_KEYNAME') {
        console.log('✅ Foreign key fk_products_store_id already exists');
      } else {
        console.warn(`Warning adding foreign key: ${fkError.message}`);
      }
    }
    
    console.log('✅ Migration completed successfully!');
  } catch (error) {
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('✅ Column products.store_id already exists');
    } else {
      console.error('Error adding store_id to products:', error);
      throw error;
    }
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// Run migration
addStoreIdToProducts()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
