import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
// Import bcrypt directly instead of utils/helpers.js: helpers pulls in database/db.js,
// whose auto-init would run CONCURRENTLY with this script's own initialization
import bcrypt from 'bcryptjs';

dotenv.config();

const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

const DB_NAME = process.env.MYSQL_DATABASE || 'laundry66';

// Create connection pool
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  multipleStatements: true
});

async function ensureUserSubscriptionColumns(connection) {
  const requiredColumns = [
    { name: 'subscription_package', ddl: 'ALTER TABLE users ADD COLUMN subscription_package VARCHAR(50) NULL AFTER store_id' },
    { name: 'subscription_expires_at', ddl: 'ALTER TABLE users ADD COLUMN subscription_expires_at DATETIME NULL AFTER subscription_package' },
    { name: 'daily_revenue_report_enabled', ddl: 'ALTER TABLE users ADD COLUMN daily_revenue_report_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER subscription_expires_at' },
    { name: 'daily_revenue_report_webhook_url', ddl: 'ALTER TABLE users ADD COLUMN daily_revenue_report_webhook_url TEXT NULL AFTER daily_revenue_report_enabled' },
    { name: 'daily_revenue_report_discord_guild_id', ddl: 'ALTER TABLE users ADD COLUMN daily_revenue_report_discord_guild_id VARCHAR(50) NULL AFTER daily_revenue_report_webhook_url' },
    { name: 'daily_revenue_report_discord_channel_id', ddl: 'ALTER TABLE users ADD COLUMN daily_revenue_report_discord_channel_id VARCHAR(50) NULL AFTER daily_revenue_report_discord_guild_id' }
  ];
  await ensureUsersColumns(connection, requiredColumns);
}

async function ensureUserSecurityColumns(connection) {
  const requiredColumns = [
    { name: 'failed_login_attempts', ddl: 'ALTER TABLE users ADD COLUMN failed_login_attempts INT NOT NULL DEFAULT 0 AFTER updated_at' },
    { name: 'last_failed_login', ddl: 'ALTER TABLE users ADD COLUMN last_failed_login DATETIME NULL AFTER failed_login_attempts' },
    { name: 'locked_until', ddl: 'ALTER TABLE users ADD COLUMN locked_until DATETIME NULL AFTER last_failed_login' }
  ];
  await ensureUsersColumns(connection, requiredColumns);
}

async function ensureUsersColumns(connection, requiredColumns) {

  for (const col of requiredColumns) {
    const [check] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'users' AND column_name = ?
      `,
      [DB_NAME, col.name]
    );

    if (check?.[0]?.count > 0) continue;

    try {
      await connection.query(col.ddl);
      console.log(`✓ Added column users.${col.name}`);
    } catch (error) {
      // If it was added concurrently or already exists, ignore
      if (error.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }

    // Verify it exists now (avoid silent partial init)
    const [verify] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'users' AND column_name = ?
      `,
      [DB_NAME, col.name]
    );
    if (!verify?.[0] || verify[0].count === 0) {
      throw new Error(`Failed to add required column users.${col.name}`);
    }
  }
}

async function cleanStoresForeignKeyValues(connection) {
  // Make sure existing data won't block FK creation
  await connection.query(`
    UPDATE stores
    SET admin_id = NULL
    WHERE admin_id IS NOT NULL
      AND admin_id NOT IN (SELECT id FROM users)
  `);
  await connection.query(`
    UPDATE stores
    SET shared_account_id = NULL
    WHERE shared_account_id IS NOT NULL
      AND shared_account_id NOT IN (SELECT id FROM users)
  `);
}

async function ensureStoresForeignKeys(connection) {
  const storeForeignKeys = [
    { name: 'fk_stores_admin_id', column: 'admin_id' },
    { name: 'fk_stores_shared_account_id', column: 'shared_account_id' }
  ];

  for (const fk of storeForeignKeys) {
    const [fkCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.table_constraints
      WHERE table_schema = ?
        AND table_name = 'stores'
        AND constraint_name = ?
        AND constraint_type = 'FOREIGN KEY'
      `,
      [DB_NAME, fk.name]
    );

    if (fkCheck?.[0]?.count > 0) continue;

    try {
      await connection.query(
        `
        ALTER TABLE stores
        ADD CONSTRAINT ${fk.name}
        FOREIGN KEY (${fk.column}) REFERENCES users(id) ON DELETE SET NULL
        `
      );
      console.log(`✓ Added foreign key ${fk.name}`);
    } catch (error) {
      // Retry once after cleaning invalid values (common cause)
      try {
        await cleanStoresForeignKeyValues(connection);
        await connection.query(
          `
          ALTER TABLE stores
          ADD CONSTRAINT ${fk.name}
          FOREIGN KEY (${fk.column}) REFERENCES users(id) ON DELETE SET NULL
          `
        );
        console.log(`✓ Added foreign key ${fk.name} (after cleanup)`);
      } catch (retryError) {
        // Ignore if FK already exists / partial init timing issues
        if (
          retryError.code !== 'ER_FK_DUP_NAME' &&
          retryError.code !== 'ER_NO_SUCH_TABLE' &&
          retryError.code !== 'ER_CANT_CREATE_TABLE' &&
          retryError.code !== 'ER_DUP_KEYNAME'
        ) {
          console.warn(`Warning adding foreign key ${fk.name}: ${retryError.message}`);
        }
      }

      if (
        error.code === 'ER_FK_DUP_NAME' ||
        error.code === 'ER_NO_SUCH_TABLE' ||
        error.code === 'ER_CANT_CREATE_TABLE' ||
        error.code === 'ER_DUP_KEYNAME'
      ) {
        continue;
      }
    }
  }
}

async function ensureProductsColumns(connection) {
  try {
    // First check if products table exists
    const [productsTableCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'products'
      `,
      [DB_NAME]
    );

    if (!productsTableCheck?.[0] || productsTableCheck[0].count === 0) {
      console.log('Products table does not exist yet, skipping column check');
      return;
    }

    const [check] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'products' AND column_name = 'store_id'
      `,
      [DB_NAME]
    );

    if (check?.[0]?.count > 0) {
      console.log(`✓ Column products.store_id already exists`);
      
      // Check foreign key
      const [fkCheck] = await connection.query(
        `
        SELECT COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_schema = ? AND table_name = 'products' AND constraint_name = 'fk_products_store_id'
        `,
        [DB_NAME]
      );
      
      if (fkCheck?.[0]?.count > 0) {
        console.log(`✓ Foreign key fk_products_store_id already exists`);
      } else {
        try {
          await connection.query(`
            ALTER TABLE products 
            ADD CONSTRAINT fk_products_store_id 
            FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
          `);
          console.log(`✓ Added foreign key fk_products_store_id`);
        } catch (fkError) {
          if (fkError.code === 'ER_FK_DUP_NAME' || fkError.code === 'ER_DUP_KEYNAME') {
            console.log(`✓ Foreign key fk_products_store_id already exists`);
          } else {
            console.warn(`Warning adding foreign key fk_products_store_id: ${fkError.message}`);
          }
        }
      }
      return;
    }

    // Add column
    try {
      await connection.query(`
        ALTER TABLE products 
        ADD COLUMN store_id INT NULL AFTER updated_by
      `);
      console.log(`✓ Added column products.store_id`);
      
      // Add foreign key
      try {
        await connection.query(`
          ALTER TABLE products 
          ADD CONSTRAINT fk_products_store_id 
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
        `);
        console.log(`✓ Added foreign key fk_products_store_id`);
      } catch (fkError) {
        if (fkError.code === 'ER_FK_DUP_NAME' || fkError.code === 'ER_DUP_KEYNAME') {
          console.log(`✓ Foreign key fk_products_store_id already exists`);
        } else {
          console.warn(`Warning adding foreign key fk_products_store_id: ${fkError.message}`);
        }
      }
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log(`✓ Column products.store_id already exists`);
      } else {
        console.error(`Error adding column products.store_id:`, error.message);
      }
    }
  } catch (error) {
    console.error('Error in ensureProductsColumns:', error.message);
  }
}

async function ensureOrdersColumns(connection) {
  try {
    // First check if orders table exists
    const [ordersTableCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'orders'
      `,
      [DB_NAME]
    );

    if (!ordersTableCheck?.[0] || ordersTableCheck[0].count === 0) {
      console.log('Orders table does not exist yet, skipping column check');
      return;
    }

    const requiredColumns = [
      { 
        name: 'store_id', 
        ddl: 'ALTER TABLE orders ADD COLUMN store_id INT NULL AFTER promotion_id',
        fk: {
          name: 'fk_orders_store_id',
          constraint: 'ALTER TABLE orders ADD CONSTRAINT fk_orders_store_id FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL'
        }
      },
      { 
        name: 'payment_method', 
        ddl: "ALTER TABLE orders ADD COLUMN payment_method ENUM('cash', 'transfer') DEFAULT NULL AFTER store_id"
      },
      { name: 'is_debt', ddl: 'ALTER TABLE orders ADD COLUMN is_debt TINYINT(1) NOT NULL DEFAULT 0 AFTER payment_method' },
      { name: 'debt_paid_at', ddl: 'ALTER TABLE orders ADD COLUMN debt_paid_at DATETIME DEFAULT NULL AFTER is_debt' },
      { name: 'withdrawn_amount', ddl: 'ALTER TABLE orders ADD COLUMN withdrawn_amount DECIMAL(10, 2) DEFAULT NULL AFTER debt_paid_at' },
      { name: 'expected_return_at', ddl: 'ALTER TABLE orders ADD COLUMN expected_return_at DATETIME DEFAULT NULL AFTER withdrawn_amount' },
      { name: 'processing_started_at', ddl: 'ALTER TABLE orders ADD COLUMN processing_started_at DATETIME DEFAULT NULL AFTER expected_return_at' },
      { name: 'ready_at', ddl: 'ALTER TABLE orders ADD COLUMN ready_at DATETIME DEFAULT NULL AFTER processing_started_at' },
      { name: 'delivered_at', ddl: 'ALTER TABLE orders ADD COLUMN delivered_at DATETIME DEFAULT NULL AFTER ready_at' },
      { name: 'delivery_method', ddl: "ALTER TABLE orders ADD COLUMN delivery_method ENUM('pickup', 'customer_ship', 'shop_delivery') DEFAULT NULL AFTER delivered_at" },
      { name: 'payment_status', ddl: "ALTER TABLE orders ADD COLUMN payment_status ENUM('unpaid', 'partial', 'paid', 'debt') NOT NULL DEFAULT 'unpaid' AFTER delivery_method" },
      { name: 'paid_amount', ddl: 'ALTER TABLE orders ADD COLUMN paid_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER payment_status' },
      { name: 'debt_amount', ddl: 'ALTER TABLE orders ADD COLUMN debt_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER paid_amount' }
    ];

    for (const col of requiredColumns) {
      try {
        const [check] = await connection.query(
          `
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_schema = ? AND table_name = 'orders' AND column_name = ?
          `,
          [DB_NAME, col.name]
        );

        if (check?.[0]?.count > 0) {
          console.log(`✓ Column orders.${col.name} already exists`);
          
          // Check foreign key if specified
          if (col.fk) {
            const [fkCheck] = await connection.query(
              `
              SELECT COUNT(*) as count
              FROM information_schema.table_constraints
              WHERE table_schema = ? AND table_name = 'orders' AND constraint_name = ?
              `,
              [DB_NAME, col.fk.name]
            );
            
            if (fkCheck?.[0]?.count === 0) {
              try {
                await connection.query(col.fk.constraint);
                console.log(`✓ Added foreign key ${col.fk.name}`);
              } catch (fkError) {
                if (fkError.code === 'ER_FK_DUP_NAME' || fkError.code === 'ER_DUP_KEYNAME') {
                  console.log(`✓ Foreign key ${col.fk.name} already exists`);
                } else {
                  console.warn(`Warning adding foreign key ${col.fk.name}: ${fkError.message}`);
                }
              }
            } else {
              console.log(`✓ Foreign key ${col.fk.name} already exists`);
            }
          }
          continue;
        }

        // Add column
        await connection.query(col.ddl);
        console.log(`✓ Added column orders.${col.name}`);
        
        // Add foreign key if specified
        if (col.fk) {
          try {
            const [fkCheck] = await connection.query(
              `
              SELECT COUNT(*) as count
              FROM information_schema.table_constraints
              WHERE table_schema = ? AND table_name = 'orders' AND constraint_name = ?
              `,
              [DB_NAME, col.fk.name]
            );
            
            if (fkCheck?.[0]?.count === 0) {
              await connection.query(col.fk.constraint);
              console.log(`✓ Added foreign key ${col.fk.name}`);
            } else {
              console.log(`✓ Foreign key ${col.fk.name} already exists`);
            }
          } catch (fkError) {
            if (fkError.code === 'ER_FK_DUP_NAME' || fkError.code === 'ER_DUP_KEYNAME') {
              console.log(`✓ Foreign key ${col.fk.name} already exists`);
            } else {
              console.warn(`Warning adding foreign key ${col.fk.name}: ${fkError.message}`);
            }
          }
        }
      } catch (error) {
        if (error.code === 'ER_DUP_FIELDNAME') {
          console.log(`✓ Column orders.${col.name} already exists`);
        } else {
          console.error(`Error adding column orders.${col.name}:`, error.message);
          // Don't throw - continue with other columns
        }
      }
    }
  } catch (error) {
    console.error('Error in ensureOrdersColumns:', error.message);
    // Don't throw - allow init to continue
  }
}

async function ensurePaymentLedgerTables(connection) {
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        store_id INT NULL,
        user_id INT NULL,
        employee_id INT NULL,
        timesheet_id INT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        payment_method ENUM('cash', 'transfer') NOT NULL,
        payment_type ENUM('order_payment', 'debt_payment') NOT NULL DEFAULT 'order_payment',
        paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        note TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
        FOREIGN KEY (timesheet_id) REFERENCES timesheets(id) ON DELETE SET NULL,
        INDEX idx_order_payments_order_id (order_id),
        INDEX idx_order_payments_store_id (store_id),
        INDEX idx_order_payments_paid_at (paid_at),
        INDEX idx_order_payments_method (payment_method)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Payment ledger tables ready');
  } catch (error) {
    console.error('Error ensuring payment ledger tables:', error.message);
  }
}

async function ensureTimesheetsColumns(connection) {
  try {
    const [tableCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'timesheets'
      `,
      [DB_NAME]
    );

    if (!tableCheck?.[0] || tableCheck[0].count === 0) {
      console.log('Timesheets table does not exist yet, skipping column check');
      return;
    }

    const columns = [
      { name: 'withdrawn_amount', ddl: 'ALTER TABLE timesheets ADD COLUMN withdrawn_amount DECIMAL(10, 2) DEFAULT NULL AFTER expected_revenue' },
      { name: 'opening_cash_amount', ddl: 'ALTER TABLE timesheets ADD COLUMN opening_cash_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER expected_revenue' },
      { name: 'expected_cash_amount', ddl: 'ALTER TABLE timesheets ADD COLUMN expected_cash_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER opening_cash_amount' },
      { name: 'actual_cash_amount', ddl: 'ALTER TABLE timesheets ADD COLUMN actual_cash_amount DECIMAL(10, 2) DEFAULT NULL AFTER expected_cash_amount' },
      { name: 'cash_difference', ddl: 'ALTER TABLE timesheets ADD COLUMN cash_difference DECIMAL(10, 2) DEFAULT NULL AFTER actual_cash_amount' },
      { name: 'cash_shortage_paid_amount', ddl: 'ALTER TABLE timesheets ADD COLUMN cash_shortage_paid_amount DECIMAL(10, 2) DEFAULT NULL AFTER cash_difference' },
    ];

    for (const column of columns) {
      const [check] = await connection.query(
        `
        SELECT COUNT(*) as count
        FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'timesheets' AND column_name = ?
        `,
        [DB_NAME, column.name]
      );

      if (check?.[0]?.count > 0) {
        console.log(`✓ Column timesheets.${column.name} already exists`);
        continue;
      }

      await connection.query(column.ddl);
      console.log(`✓ Added column timesheets.${column.name}`);
    }
  } catch (error) {
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('✓ Timesheets column already exists');
    } else {
      console.error('Error in ensureTimesheetsColumns:', error.message);
    }
  }
}

async function ensureCashDrawerTables(connection) {
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS cash_drawer_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        store_id INT NULL,
        timesheet_id INT NOT NULL,
        user_id INT NULL,
        employee_id INT NULL,
        order_id INT NULL,
        order_payment_id INT NULL,
        type ENUM('opening_float', 'cash_payment', 'cash_in', 'cash_out', 'shortage_reimbursement', 'closing_count') NOT NULL,
        direction ENUM('in', 'out', 'neutral') NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        reason TEXT,
        occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
        FOREIGN KEY (timesheet_id) REFERENCES timesheets(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
        FOREIGN KEY (order_payment_id) REFERENCES order_payments(id) ON DELETE SET NULL,
        INDEX idx_cash_drawer_timesheet_id (timesheet_id),
        INDEX idx_cash_drawer_store_id (store_id),
        INDEX idx_cash_drawer_occurred_at (occurred_at),
        INDEX idx_cash_drawer_type (type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Cash drawer tables ready');
  } catch (error) {
    console.error('Error ensuring cash drawer tables:', error.message);
  }
}

async function ensureSettingsColumns(connection) {
  try {
    // First check if settings table exists
    const [settingsTableCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'settings'
      `,
      [DB_NAME]
    );

    if (!settingsTableCheck?.[0] || settingsTableCheck[0].count === 0) {
      console.log('Settings table does not exist yet, skipping column check');
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
      console.log(`✓ Column settings.store_id already exists`);
      
      // Check unique constraint for (key, store_id)
      const [uniqueCheck] = await connection.query(
        `
        SELECT COUNT(*) as count
        FROM information_schema.table_constraints
        WHERE table_schema = ? AND table_name = 'settings' AND constraint_name = 'unique_key_store'
        `,
        [DB_NAME]
      );
      
      if (uniqueCheck?.[0]?.count === 0) {
        // Check if old UNIQUE constraint on key exists and drop it
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
            console.log(`✓ Dropped old unique constraint on key`);
          } catch (dropError) {
            // Ignore if constraint doesn't exist
            if (dropError.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
              console.warn(`Warning dropping old constraint: ${dropError.message}`);
            }
          }
        }
        
        // Add new unique constraint
        try {
          await connection.query(`ALTER TABLE settings ADD UNIQUE KEY unique_key_store (\`key\`, store_id)`);
          console.log(`✓ Added unique constraint unique_key_store`);
        } catch (uniqueError) {
          if (uniqueError.code === 'ER_DUP_KEYNAME' || uniqueError.code === 'ER_DUP_ENTRY') {
            console.log(`✓ Unique constraint unique_key_store already exists`);
          } else {
            console.warn(`Warning adding unique constraint: ${uniqueError.message}`);
          }
        }
      } else {
        console.log(`✓ Unique constraint unique_key_store already exists`);
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
      
      if (fkCheck?.[0]?.count === 0) {
        try {
          await connection.query(`
            ALTER TABLE settings 
            ADD CONSTRAINT fk_settings_store_id 
            FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
          `);
          console.log(`✓ Added foreign key fk_settings_store_id`);
        } catch (fkError) {
          if (fkError.code === 'ER_FK_DUP_NAME' || fkError.code === 'ER_DUP_KEYNAME') {
            console.log(`✓ Foreign key fk_settings_store_id already exists`);
          } else {
            console.warn(`Warning adding foreign key fk_settings_store_id: ${fkError.message}`);
          }
        }
      } else {
        console.log(`✓ Foreign key fk_settings_store_id already exists`);
      }
      return;
    }

    // Add column
    try {
      await connection.query(`
        ALTER TABLE settings 
        ADD COLUMN store_id INT NULL AFTER value
      `);
      console.log(`✓ Added column settings.store_id`);
      
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
          console.log(`✓ Dropped old unique constraint on key`);
        } catch (dropError) {
          if (dropError.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
            console.warn(`Warning dropping old constraint: ${dropError.message}`);
          }
        }
      }
      
      // Add new unique constraint
      try {
        await connection.query(`ALTER TABLE settings ADD UNIQUE KEY unique_key_store (\`key\`, store_id)`);
        console.log(`✓ Added unique constraint unique_key_store`);
      } catch (uniqueError) {
        if (uniqueError.code === 'ER_DUP_KEYNAME' || uniqueError.code === 'ER_DUP_ENTRY') {
          console.log(`✓ Unique constraint unique_key_store already exists`);
        } else {
          console.warn(`Warning adding unique constraint: ${uniqueError.message}`);
        }
      }
      
      // Add foreign key
      try {
        await connection.query(`
          ALTER TABLE settings 
          ADD CONSTRAINT fk_settings_store_id 
          FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
        `);
        console.log(`✓ Added foreign key fk_settings_store_id`);
      } catch (fkError) {
        if (fkError.code === 'ER_FK_DUP_NAME' || fkError.code === 'ER_DUP_KEYNAME') {
          console.log(`✓ Foreign key fk_settings_store_id already exists`);
        } else {
          console.warn(`Warning adding foreign key fk_settings_store_id: ${fkError.message}`);
        }
      }
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log(`✓ Column settings.store_id already exists`);
      } else {
        console.error(`Error adding column settings.store_id:`, error.message);
      }
    }
  } catch (error) {
    console.error('Error in ensureSettingsColumns:', error.message);
    // Don't throw - allow init to continue
  }
}

async function ensurePromotionsColumns(connection) {
  try {
    // Check if promotions table exists
    const [tableCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'promotions'
      `,
      [DB_NAME]
    );

    if (!tableCheck?.[0] || tableCheck[0].count === 0) {
      console.log('Promotions table does not exist yet, will be created from schema.sql');
      return;
    }

    // Check if min_order_count column exists - remove it if exists
    const [orderCountCheck] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'promotions' AND column_name = 'min_order_count'
      `,
      [DB_NAME]
    );

    if (orderCountCheck?.[0]?.count > 0) {
      console.log('Removing min_order_count column from promotions table...');
      try {
        await connection.query(`ALTER TABLE promotions DROP COLUMN min_order_count`);
        console.log('✓ Removed min_order_count column from promotions table');
      } catch (error) {
        if (error.code !== 'ER_CANT_DROP_FIELD_OR_KEY') {
          console.warn(`Warning removing min_order_count column: ${error.message}`);
        }
      }
    }

    // Check if type ENUM includes 'order_count' - need to update to only 'bill_amount'
    const [typeCheck] = await connection.query(
      `
      SELECT COLUMN_TYPE
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'promotions' AND column_name = 'type'
      `,
      [DB_NAME]
    );

    if (typeCheck?.[0]?.COLUMN_TYPE && typeCheck[0].COLUMN_TYPE.includes('order_count')) {
      console.log('Updating promotions.type ENUM to only allow bill_amount...');
      try {
        // First, delete any promotions with type 'order_count'
        await connection.query(`DELETE FROM promotions WHERE type = 'order_count'`);
        console.log('✓ Removed promotions with type order_count');
        
        // Update ENUM to only allow 'bill_amount'
        await connection.query(`ALTER TABLE promotions MODIFY COLUMN type ENUM('bill_amount') NOT NULL DEFAULT 'bill_amount'`);
        console.log('✓ Updated promotions.type ENUM to only allow bill_amount');
      } catch (error) {
        console.warn(`Warning updating promotions.type ENUM: ${error.message}`);
      }
    }

    // Ensure min_bill_amount is NOT NULL
    const [billAmountCheck] = await connection.query(
      `
      SELECT IS_NULLABLE, COLUMN_DEFAULT
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'promotions' AND column_name = 'min_bill_amount'
      `,
      [DB_NAME]
    );

    if (billAmountCheck?.[0] && billAmountCheck[0].IS_NULLABLE === 'YES') {
      console.log('Updating min_bill_amount to NOT NULL...');
      try {
        // Set default value for existing NULL records
        await connection.query(`UPDATE promotions SET min_bill_amount = 0 WHERE min_bill_amount IS NULL`);
        await connection.query(`ALTER TABLE promotions MODIFY COLUMN min_bill_amount DECIMAL(10, 2) NOT NULL`);
        console.log('✓ Updated min_bill_amount to NOT NULL');
      } catch (error) {
        console.warn(`Warning updating min_bill_amount: ${error.message}`);
      }
    }
  } catch (error) {
    console.error('Error in ensurePromotionsColumns:', error.message);
    // Don't throw - allow init to continue
  }
}

async function ensureLoginAttemptsTable(connection) {
  try {
    // Check if login_attempts table exists
    const [check] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'login_attempts'
      `,
      [DB_NAME]
    );

    if (check?.[0]?.count > 0) {
      console.log('✓ Table login_attempts already exists');
      
      // Verify indexes exist
      const indexes = [
        { name: 'idx_phone', column: 'phone' },
        { name: 'idx_ip', column: 'ip_address' },
        { name: 'idx_created_at', column: 'created_at' }
      ];
      for (const idx of indexes) {
        const [idxCheck] = await connection.query(
          `
          SELECT COUNT(*) as count
          FROM information_schema.statistics
          WHERE table_schema = ? AND table_name = 'login_attempts' AND index_name = ?
          `,
          [DB_NAME, idx.name]
        );
        
        if (idxCheck?.[0]?.count === 0) {
          try {
            await connection.query(`CREATE INDEX ${idx.name} ON login_attempts(${idx.column})`);
            console.log(`✓ Created index ${idx.name} on login_attempts`);
          } catch (idxError) {
            if (idxError.code !== 'ER_DUP_KEYNAME') {
              console.warn(`Warning creating index ${idx.name}: ${idxError.message}`);
            }
          }
        }
      }
      return;
    }

    // Create table
    console.log('Creating login_attempts table...');
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
    
    console.log('✓ Created login_attempts table');
    console.log('✓ Created indexes for login_attempts table');
  } catch (error) {
    if (error.code === 'ER_TABLE_EXISTS_ERROR' || error.code === 'ER_DUP_TABLE') {
      console.log('✓ Table login_attempts already exists');
    } else {
      console.error('Error creating login_attempts table:', error.message);
      // Don't throw - allow init to continue
    }
  }
}

async function ensureZaloTables(connection) {
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS store_zalo_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        store_id INT NOT NULL,
        zalo_user_id VARCHAR(100) NULL,
        zalo_name VARCHAR(255) NULL,
        credentials_json LONGTEXT NULL,
        status ENUM('not_logged_in', 'pending_qr', 'logged_in', 'expired', 'error') NOT NULL DEFAULT 'not_logged_in',
        qr_path VARCHAR(500) NULL,
        last_login_at DATETIME NULL,
        last_error TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_store_zalo (store_id),
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS zalo_phone_mappings (
        store_id INT NOT NULL,
        phone VARCHAR(20) NOT NULL,
        zalo_user_id VARCHAR(100) NOT NULL,
        display_name VARCHAR(255) NOT NULL DEFAULT '',
        last_resolved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (store_id, phone),
        INDEX idx_zalo_phone_user (zalo_user_id),
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        store_id INT NULL,
        channel ENUM('zalo') NOT NULL DEFAULT 'zalo',
        provider ENUM('zalo') NOT NULL DEFAULT 'zalo',
        event_type ENUM('order_created', 'ready_for_pickup', 'delivered', 'debt_payment_reminder') DEFAULT NULL,
        recipient_phone VARCHAR(50),
        message TEXT,
        status ENUM('sent', 'failed') NOT NULL,
        error TEXT NULL,
        sent_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
        INDEX idx_order_notifications_order_id (order_id),
        INDEX idx_order_notifications_store_id (store_id),
        INDEX idx_order_notifications_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    for (const column of [
      { name: 'provider', ddl: "ALTER TABLE order_notifications ADD COLUMN provider ENUM('zalo') NOT NULL DEFAULT 'zalo' AFTER channel" },
      { name: 'event_type', ddl: "ALTER TABLE order_notifications ADD COLUMN event_type ENUM('order_created', 'ready_for_pickup', 'delivered', 'debt_payment_reminder') DEFAULT NULL AFTER provider" },
    ]) {
      const [check] = await connection.query(
        `
        SELECT COUNT(*) as count
        FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'order_notifications' AND column_name = ?
        `,
        [DB_NAME, column.name]
      );
      if (check?.[0]?.count === 0) {
        await connection.query(column.ddl);
      }
    }

    console.log('✓ Zalo tables ready');
  } catch (error) {
    console.error('Error ensuring Zalo tables:', error.message);
  }
}

async function ensureIndexes(connection) {
  const indexStatements = [
    { name: 'idx_orders_status', table: 'orders', columns: 'status' },
    { name: 'idx_orders_assigned_to', table: 'orders', columns: 'assigned_to' },
    { name: 'idx_orders_customer_id', table: 'orders', columns: 'customer_id' },
    { name: 'idx_orders_created_at', table: 'orders', columns: 'created_at' },
    { name: 'idx_timesheets_user_id', table: 'timesheets', columns: 'user_id' },
    { name: 'idx_timesheets_check_in', table: 'timesheets', columns: 'check_in' },
    { name: 'idx_audit_logs_user_id', table: 'audit_logs', columns: 'user_id' },
    { name: 'idx_audit_logs_entity', table: 'audit_logs', columns: 'entity, entity_id' }
  ];

  for (const idx of indexStatements) {
    try {
      const [existing] = await connection.query(
        `
        SELECT COUNT(*) as count
        FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = ? AND index_name = ?
        `,
        [DB_NAME, idx.table, idx.name]
      );

      if (existing?.[0]?.count > 0) continue;
      await connection.query(`CREATE INDEX ${idx.name} ON ${idx.table}(${idx.columns})`);
      console.log(`✓ Created index ${idx.name}`);
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE' && error.code !== 'ER_DUP_KEYNAME') {
        console.warn(`Warning creating index ${idx.name}: ${error.message}`);
      }
    }
  }
}

// Ensure schema is created before proceeding
async function ensureSchema() {
  try {
    // Check if users table exists
    const [tables] = await pool.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = ? AND table_name = 'users'
    `, [DB_NAME]);
    
    if (tables[0].count === 0) {
      console.log('Creating database schema...');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const schemaPath = join(__dirname, '../database/schema.sql');
      
      const schema = readFileSync(schemaPath, 'utf-8');
      
      // Normalize schema for safe initialization:
      // - Remove CREATE INDEX IF NOT EXISTS (we create indexes separately)
      // - Remove any stores->users foreign keys inside CREATE TABLE stores (old schema versions)
      // - Ignore any ALTER TABLE statements (we add required FKs programmatically, idempotently)
      let processedSchema = schema;
      
      // Replace CREATE INDEX IF NOT EXISTS with a safer approach
      processedSchema = processedSchema.replace(
        /CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)\(([^)]+)\)/gi,
        (match, indexName, tableName, columns) => {
          return `-- Index ${indexName} will be created separately if needed`;
        }
      );

      // Strip any FK lines inside CREATE TABLE stores that reference users (for backward compatibility)
      // This prevents errno 150 when users table doesn't exist yet.
      processedSchema = processedSchema.replace(
        /(CREATE TABLE IF NOT EXISTS stores\s*\([\s\S]*?)(\s*,\s*FOREIGN KEY\s*\(\s*admin_id\s*\)[\s\S]*?\n)([\s\S]*?)(\s*,\s*FOREIGN KEY\s*\(\s*shared_account_id\s*\)[\s\S]*?\n)([\s\S]*?\)\s*ENGINE=InnoDB[\s\S]*?;)/i,
        (match, head, fk1, mid, fk2, tail) => `${head}${mid}${tail}`
      );

      // Remove all ALTER TABLE statements entirely (they may span multiple lines)
      processedSchema = processedSchema.replace(/ALTER TABLE[\s\S]*?;/gi, '-- ALTER TABLE removed (handled in code);');
      
      const connection = await pool.getConnection();
      try {
        // Split schema into individual statements and execute them one by one.
        // Use a robust comment stripper: remove all `-- ...` comment fragments first,
        // otherwise statement chunks may start with comments and get mishandled.
        const schemaWithoutLineComments = processedSchema
          .replace(/^\s*--.*$/gm, '')
          .trim();

        const statements = schemaWithoutLineComments
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        // Execute all CREATE TABLE statements one by one (ignore "already exists")
        for (const statement of statements) {
          if (!/^\s*CREATE\s+TABLE/i.test(statement)) continue;
          try {
            await connection.query(statement + ';');
          } catch (error) {
            // Ignore table already exists errors
            if (
              error.code !== 'ER_TABLE_EXISTS_ERROR' &&
              error.code !== 'ER_DUP_TABLE' &&
              !error.message.includes('already exists')
            ) {
              throw error;
            }
          }
        }

        // Sanity check: users table must exist now
        const [usersCheck] = await connection.query(
          `
          SELECT COUNT(*) as count
          FROM information_schema.tables
          WHERE table_schema = ? AND table_name = 'users'
          `,
          [DB_NAME]
        );
        if (!usersCheck?.[0] || usersCheck[0].count === 0) {
          throw new Error(
            "Schema init incomplete: table 'users' was not created. Please ensure VPS code is up-to-date and schema.sql is correct."
          );
        }
        
        // Ensure promotions table exists (it has FK to users, so must be created after users)
        const [promotionsCheck] = await connection.query(
          `
          SELECT COUNT(*) as count
          FROM information_schema.tables
          WHERE table_schema = ? AND table_name = 'promotions'
          `,
          [DB_NAME]
        );
        if (!promotionsCheck?.[0] || promotionsCheck[0].count === 0) {
          console.log('Creating promotions table...');
          try {
            await connection.query(`
              CREATE TABLE IF NOT EXISTS promotions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                type ENUM('bill_amount') NOT NULL DEFAULT 'bill_amount',
                min_bill_amount DECIMAL(10, 2) NOT NULL,
                discount_type ENUM('percentage', 'fixed') NOT NULL,
                discount_value DECIMAL(10, 2) NOT NULL,
                max_discount_amount DECIMAL(10, 2) DEFAULT NULL,
                start_date DATETIME NOT NULL,
                end_date DATETIME NOT NULL,
                status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
                created_by INT,
                store_id INT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
                FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
              ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            console.log('✓ Promotions table created');
          } catch (error) {
            if (error.code !== 'ER_TABLE_EXISTS_ERROR' && error.code !== 'ER_DUP_TABLE') {
              console.warn(`Warning creating promotions table: ${error.message}`);
            }
          }
        }
        
        console.log('Schema created successfully');
      } finally {
        connection.release();
      }
    } else {
      console.log('Schema already exists');
    }

    // Always ensure runtime-required schema bits exist (even if DB already existed)
    const connection = await pool.getConnection();
    try {
      // Wait a bit to avoid race conditions after CREATE TABLE on fresh init
      await new Promise((resolve) => setTimeout(resolve, 300));

      await ensureUserSubscriptionColumns(connection);
      await ensureUserSecurityColumns(connection);

      try {
        await cleanStoresForeignKeyValues(connection);
      } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
          console.warn(`Warning cleaning stores table: ${error.message}`);
        }
      }

      await ensureStoresForeignKeys(connection);
      
      // Ensure products table has store_id column
      await ensureProductsColumns(connection);
      
      // Ensure orders table has store_id and payment_method columns
      await ensureOrdersColumns(connection);
      
      await ensureTimesheetsColumns(connection);

      // Ensure payment ledger table exists
      await ensurePaymentLedgerTables(connection);

      await ensureCashDrawerTables(connection);
      
      // Ensure settings table has store_id column
      await ensureSettingsColumns(connection);
      
      // Ensure login_attempts table exists (for security logging)
      await ensureLoginAttemptsTable(connection);
      
      // Ensure promotions table has correct structure (only bill_amount type, no min_order_count)
      await ensurePromotionsColumns(connection);

      // Ensure Zalo integration tables exist
      await ensureZaloTables(connection);
      
      await ensureIndexes(connection);
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error ensuring schema:', error);
    throw error;
  }
}

// Create default root admin user
async function createDefaultAdmin() {
  try {
    // Check if root admin already exists
    const [rootRows] = await pool.query('SELECT id, name, phone, role FROM users WHERE role = ?', ['root']);
    const existingRoot = rootRows[0] || null;
    
    if (existingRoot) {
      console.log('Root admin already exists:');
      console.log(`  ID: ${existingRoot.id}`);
      console.log(`  Name: ${existingRoot.name}`);
      console.log(`  Phone: ${existingRoot.phone}`);
      return;
    }

    // Check if admin user with phone='admin' exists, convert it to root
    const [adminRows] = await pool.query('SELECT id, name, phone, role FROM users WHERE phone = ?', ['admin']);
    const existingAdmin = adminRows[0] || null;
    
    if (existingAdmin) {
      if (existingAdmin.role !== 'root') {
        console.log('Found existing admin user, converting to root...');
        await pool.query('UPDATE users SET role = ? WHERE id = ?', ['root', existingAdmin.id]);
        console.log('✅ Admin user converted to root admin!');
        console.log(`  Phone: ${existingAdmin.phone}`);
      } else {
        console.log('Root admin already exists (phone: admin)');
      }
      return;
    }

    // Create new root admin user
    const password_hash = await hashPassword('admin123');
    
    await pool.query(`
      INSERT INTO users (name, phone, password_hash, role, status, store_id)
      VALUES (?, ?, ?, ?, ?, NULL)
    `, ['Root Admin', 'admin', password_hash, 'root', 'active']);
    
    console.log('✅ Root admin user created successfully!');
    console.log('Phone: admin');
    console.log('Password: admin123');
    console.log('Note: Root admin không có store/employer account/employee');
    // Password shown in init script for initial setup
  } catch (error) {
    console.error('Error creating root admin:', error);
    // Don't throw - allow init to continue
  }
}

// Create sample products
async function createSampleProducts() {
  try {
    const products = [
      { name: 'Giặt thường', unit: 'kg', price: 20000, eta_minutes: 120 },
      { name: 'Giặt chăn', unit: 'cai', price: 50000, eta_minutes: 180 },
      { name: 'Sấy', unit: 'kg', price: 15000, eta_minutes: 60 },
      { name: 'Giặt + Sấy', unit: 'kg', price: 30000, eta_minutes: 180 },
      { name: 'Ủi', unit: 'cai', price: 10000, eta_minutes: 30 }
    ];

    // Find root admin first, then fallback to admin, then use id=1
    const [rootRows] = await pool.query('SELECT id FROM users WHERE role = ? LIMIT 1', ['root']);
    const root = rootRows[0] || null;
    let adminId = root ? root.id : null;
    
    if (!adminId) {
      const [adminRows] = await pool.query('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      const admin = adminRows[0] || null;
      adminId = admin ? admin.id : 1;
    }

    for (const product of products) {
      const [existingRows] = await pool.query('SELECT id FROM products WHERE name = ?', [product.name]);
      const existing = existingRows[0] || null;
      if (!existing) {
        await pool.query(`
          INSERT INTO products (name, unit, price, eta_minutes, status, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          product.name,
          product.unit,
          product.price,
          product.eta_minutes,
          'active',
          adminId,
          adminId
        ]);
      }
    }

    console.log('Sample products created');
  } catch (error) {
    console.error('Error creating products:', error);
  }
}

// Main initialization
async function init() {
  let tempConnection = null;
  try {
    console.log('========================================');
    console.log('Initializing database...');
    console.log(`Database: ${DB_NAME}`);
    console.log('========================================\n');
    
    // Ensure database exists
    tempConnection = await mysql.createConnection({
      host: process.env.MYSQL_HOST || 'localhost',
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || ''
    });
    
    const dbName = process.env.MYSQL_DATABASE || 'laundry66';
    await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✓ Database '${dbName}' ready\n`);
    await tempConnection.end();
    tempConnection = null;
    
    // Ensure schema is created
    await ensureSchema();
    
    // Wait a bit to ensure schema is fully created and all constraints are applied
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create default admin and sample data
    await createDefaultAdmin();
    await createSampleProducts();
    
    console.log('\n========================================');
    console.log('✅ Database initialization complete!');
    console.log('========================================');
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('\n========================================');
    console.error('❌ Initialization failed:');
    console.error('========================================');
    console.error(error);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    if (tempConnection) {
      try {
        await tempConnection.end();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    try {
      await pool.end();
    } catch (e) {
      // Ignore cleanup errors
    }
    process.exit(1);
  }
}

init();
