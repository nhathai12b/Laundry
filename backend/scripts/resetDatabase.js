import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hashPassword } from '../utils/helpers.js';

dotenv.config();

// Create connection without database first
const tempPool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  multipleStatements: true
});

const dbName = process.env.MYSQL_DATABASE || 'laundry66';

async function ensureUserSubscriptionColumns(connection) {
  const requiredColumns = [
    { name: 'subscription_package', ddl: 'ALTER TABLE users ADD COLUMN subscription_package VARCHAR(50) NULL AFTER store_id' },
    { name: 'subscription_expires_at', ddl: 'ALTER TABLE users ADD COLUMN subscription_expires_at DATETIME NULL AFTER subscription_package' }
  ];

  for (const col of requiredColumns) {
    const [check] = await connection.query(
      `
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'users' AND column_name = ?
      `,
      [dbName, col.name]
    );

    if (check?.[0]?.count > 0) continue;

    try {
      await connection.query(col.ddl);
      console.log(`✓ Added column users.${col.name}`);
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') throw error;
    }
  }
}

async function resetDatabase() {
  const connection = await tempPool.getConnection();
  try {
    console.log('⚠️  WARNING: This will DELETE all data in the database!');
    console.log(`Database: ${dbName}`);
    console.log('Starting database reset...\n');

    // Drop database if exists
    console.log('Dropping existing database...');
    await connection.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    console.log('✓ Database dropped');

    // Create new database
    console.log('Creating new database...');
    await connection.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log('✓ Database created');

    connection.release();

    // Now connect to the new database
    const pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
      multipleStatements: true
    });

    const dbConnection = await pool.getConnection();
    try {
      // Read and execute schema
      console.log('Creating schema...');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const schemaPath = join(__dirname, '../database/schema.sql');
      const schema = readFileSync(schemaPath, 'utf-8');

      // Process schema
      let processedSchema = schema;
      
      // Replace CREATE INDEX IF NOT EXISTS
      processedSchema = processedSchema.replace(
        /CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)\(([^)]+)\)/gi,
        (match, indexName, tableName, columns) => {
          return `-- Index ${indexName} will be created separately`;
        }
      );

      // Remove ALTER TABLE statements
      processedSchema = processedSchema.replace(/ALTER TABLE[\s\S]*?;/gi, '-- ALTER TABLE removed;');

      // Remove comments and split statements
      const schemaWithoutComments = processedSchema
        .replace(/^\s*--.*$/gm, '')
        .trim();

      const statements = schemaWithoutComments
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // Execute CREATE TABLE statements
      for (const statement of statements) {
        if (!/^\s*CREATE\s+TABLE/i.test(statement)) continue;
        try {
          await dbConnection.query(statement + ';');
        } catch (error) {
          console.error(`Error executing: ${statement.substring(0, 50)}...`);
          throw error;
        }
      }

      // Ensure required columns exist even if schema.sql is outdated on VPS
      await ensureUserSubscriptionColumns(dbConnection);

      // Create indexes
      console.log('Creating indexes...');
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
          await dbConnection.query(`CREATE INDEX ${idx.name} ON ${idx.table}(${idx.columns})`);
        } catch (error) {
          console.warn(`Warning creating index ${idx.name}: ${error.message}`);
        }
      }

      console.log('✓ Schema created successfully');

      // Create default admin FIRST (before adding foreign keys)
      console.log('Creating default admin...');
      const password_hash = await hashPassword('admin123');
      await dbConnection.query(`
        INSERT INTO users (name, phone, password_hash, role, status)
        VALUES (?, ?, ?, ?, ?)
      `, ['Admin', 'admin', password_hash, 'admin', 'active']);
      console.log('✓ Default admin created (phone: admin, password: admin123)');

      // Ensure all admin_id in stores are NULL or valid before adding foreign key
      console.log('Cleaning stores table...');
      await dbConnection.query(`
        UPDATE stores 
        SET admin_id = NULL 
        WHERE admin_id IS NOT NULL 
        AND admin_id NOT IN (SELECT id FROM users)
      `);
      await dbConnection.query(`
        UPDATE stores 
        SET shared_account_id = NULL 
        WHERE shared_account_id IS NOT NULL 
        AND shared_account_id NOT IN (SELECT id FROM users)
      `);

      // Add foreign keys for stores table AFTER users table has data
      console.log('Adding foreign keys...');
      const storeForeignKeys = [
        { name: 'fk_stores_admin_id', column: 'admin_id' },
        { name: 'fk_stores_shared_account_id', column: 'shared_account_id' }
      ];

      for (const fk of storeForeignKeys) {
        try {
          // Check if foreign key already exists
          const [fkCheck] = await dbConnection.query(`
            SELECT COUNT(*) as count
            FROM information_schema.table_constraints
            WHERE table_schema = ?
              AND table_name = 'stores'
              AND constraint_name = ?
              AND constraint_type = 'FOREIGN KEY'
          `, [dbName, fk.name]);

          if (fkCheck[0].count === 0) {
            await dbConnection.query(`
              ALTER TABLE stores
              ADD CONSTRAINT ${fk.name}
              FOREIGN KEY (${fk.column}) REFERENCES users(id) ON DELETE SET NULL
            `);
            console.log(`✓ Foreign key ${fk.name} added`);
          } else {
            console.log(`✓ Foreign key ${fk.name} already exists`);
          }
        } catch (error) {
          console.warn(`Warning adding FK ${fk.name}: ${error.message}`);
        }
      }

      // Create sample products
      console.log('Creating sample products...');
      const products = [
        { name: 'Giặt thường', unit: 'kg', price: 20000, eta_minutes: 120 },
        { name: 'Giặt chăn', unit: 'cai', price: 50000, eta_minutes: 180 },
        { name: 'Sấy', unit: 'kg', price: 15000, eta_minutes: 60 },
        { name: 'Giặt + Sấy', unit: 'kg', price: 30000, eta_minutes: 180 },
        { name: 'Ủi', unit: 'cai', price: 10000, eta_minutes: 30 }
      ];

      const [adminRows] = await dbConnection.query('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      const adminId = adminRows[0]?.id || 1;

      for (const product of products) {
        await dbConnection.query(`
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
      console.log('✓ Sample products created');

      console.log('\n✅ Database reset complete!');
      console.log('\nDefault credentials:');
      console.log('  Phone: admin');
      console.log('  Password: admin123');
      
    } finally {
      dbConnection.release();
      await pool.end();
    }
  } catch (error) {
    console.error('❌ Error resetting database:', error);
    throw error;
  } finally {
    connection.release();
    await tempPool.end();
  }
}

// Confirm before proceeding
console.log('⚠️  WARNING: This will DELETE ALL DATA in the database!');
console.log(`Database: ${dbName}`);
console.log('\nTo proceed, run this script with --confirm flag:');
console.log('  node scripts/resetDatabase.js --confirm\n');

if (process.argv.includes('--confirm')) {
  resetDatabase()
    .then(() => {
      console.log('\n✅ Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Reset failed:', error);
      process.exit(1);
    });
} else {
  console.log('Exiting without changes. Use --confirm to proceed.');
  process.exit(0);
}
