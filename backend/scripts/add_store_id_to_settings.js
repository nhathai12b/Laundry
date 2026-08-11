import { pool, query, queryOne, execute } from '../database/db.js';
import dotenv from 'dotenv';

dotenv.config();

async function addStoreIdToSettings() {
  let connection;
  try {
    connection = await pool.getConnection();
    
    const DB_NAME = process.env.MYSQL_DATABASE || 'laundry66';
    
    console.log('Checking settings table for missing store_id column...');
    
    // Check if settings table exists
    const [tableCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'settings'
      `,
      [DB_NAME]
    );

    if (!tableCheck?.[0] || tableCheck[0].count === 0) {
      console.log('❌ Settings table does not exist! Please run npm run init-db first.');
      return;
    }

    // Check if store_id column exists
    const [check] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'settings' AND column_name = 'store_id'
      `,
      [DB_NAME]
    );

    if (check?.[0]?.count > 0) {
      console.log('✅ Column settings.store_id already exists');
      
      // Check unique constraint
      const [uniqueCheck] = await connection.query(
        `
        SELECT COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_schema = ? AND table_name = 'settings' AND constraint_name = 'unique_key_store'
        `,
        [DB_NAME]
      );
      
      if (uniqueCheck?.[0]?.count > 0) {
        console.log('✅ Unique constraint unique_key_store already exists');
      } else {
        // Drop old UNIQUE constraint on key if exists
        const [oldUniqueCheck] = await connection.query(
          `
          SELECT COUNT(*) as count
          FROM information_schema.table_constraints
          WHERE table_schema = ? AND table_name = 'settings' AND constraint_name = 'key'
          `,
          [DB_NAME]
        );
        
        if (oldUniqueCheck?.[0]?.count > 0) {
          try {
            await connection.query(`ALTER TABLE settings DROP INDEX \`key\``);
            console.log('✅ Dropped old unique constraint on key');
          } catch (dropError) {
            if (dropError.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
              console.warn(`Warning dropping old constraint: ${dropError.message}`);
            }
          }
        }
        
        // Add new unique constraint
        try {
          await connection.query(`ALTER TABLE settings ADD UNIQUE KEY unique_key_store (\`key\`, store_id)`);
          console.log('✅ Added unique constraint unique_key_store');
        } catch (uniqueError) {
          if (uniqueError.code === 'ER_DUP_KEYNAME') {
            console.log('✅ Unique constraint unique_key_store already exists');
          } else {
            console.warn(`Warning adding unique constraint: ${uniqueError.message}`);
          }
        }
      }
      
      // Check foreign key
      const [fkCheck] = await connection.query(
        `
        SELECT COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_schema = ? AND table_name = 'settings' AND constraint_name = 'fk_settings_store_id'
        `,
        [DB_NAME]
      );
      
      if (fkCheck?.[0]?.count > 0) {
        console.log('✅ Foreign key fk_settings_store_id already exists');
        console.log('✅ Migration not needed - all columns and constraints are present');
        return;
      } else {
        console.log('Adding foreign key constraint for store_id...');
        await connection.query(`
          ALTER TABLE settings 
          ADD CONSTRAINT fk_settings_store_id 
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        `);
        console.log('✅ Added foreign key constraint for store_id');
        console.log('✅ Migration completed successfully!');
        return;
      }
    }

    console.log('Adding store_id column to settings table...');
    await connection.query(`
      ALTER TABLE settings 
      ADD COLUMN store_id INT NULL AFTER value
    `);
    console.log('✅ Added store_id column');
    
    // Drop old UNIQUE constraint on key if exists
    const [oldUniqueCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.table_constraints
      WHERE table_schema = ? AND table_name = 'settings' AND constraint_name = 'key'
      `,
      [DB_NAME]
    );
    
    if (oldUniqueCheck?.[0]?.count > 0) {
      try {
        await connection.query(`ALTER TABLE settings DROP INDEX \`key\``);
        console.log('✅ Dropped old unique constraint on key');
      } catch (dropError) {
        if (dropError.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
          console.warn(`Warning dropping old constraint: ${dropError.message}`);
        }
      }
    }
    
    // Add new unique constraint
    try {
      await connection.query(`ALTER TABLE settings ADD UNIQUE KEY unique_key_store (\`key\`, store_id)`);
      console.log('✅ Added unique constraint unique_key_store');
    } catch (uniqueError) {
      if (uniqueError.code === 'ER_DUP_KEYNAME') {
        console.log('✅ Unique constraint unique_key_store already exists');
      } else {
        console.warn(`Warning adding unique constraint: ${uniqueError.message}`);
      }
    }
    
    // Add foreign key
    await connection.query(`
      ALTER TABLE settings 
      ADD CONSTRAINT fk_settings_store_id 
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    `);
    console.log('✅ Added foreign key constraint for store_id');
    console.log('✅ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Error adding store_id to settings:', error);
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// Run migration
addStoreIdToSettings()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
