import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schemaPath = join(__dirname, 'schema.sql');

// Create MySQL connection pool
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
  timezone: 'Z',
  multipleStatements: true
});

pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'", (error) => {
    if (error) {
      console.warn('Warning setting MySQL session timezone to UTC:', error.message);
    }
  });
  // Set 1 lần cho MỖI connection trong pool — chạy `SET SESSION` qua pool.query
  // ở route chỉ trúng 1 connection ngẫu nhiên, query báo cáo sau đó thường chạy
  // trên connection khác vẫn ở mặc định 1024 byte → GROUP_CONCAT bị cắt cụt
  connection.query('SET SESSION group_concat_max_len = 10000', (error) => {
    if (error) {
      console.warn('Warning setting group_concat_max_len:', error.message);
    }
  });
});

// Initialize database - create database if not exists and execute schema
async function initializeDatabase() {
  try {
    // First, connect without database to create it if needed
    const tempConnection = await mysql.createConnection({
      host: process.env.MYSQL_HOST || 'localhost',
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || ''
    });

    const dbName = process.env.MYSQL_DATABASE || 'laundry66';
    await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await tempConnection.end();

    // Read and execute schema
    const schema = readFileSync(schemaPath, 'utf-8');
    
    // Remove CREATE INDEX IF NOT EXISTS and replace with comment
    let processedSchema = schema.replace(
      /CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)\(([^)]+)\)/gi,
      (match, indexName, tableName, columns) => {
        return `-- Index ${indexName} will be created separately if needed`;
      }
    );
    
    // Split by semicolon and execute each statement.
    // Strip comment lines inside each chunk instead of discarding the whole
    // chunk — a leading "-- comment" would otherwise drop the statement below it.
    const statements = processedSchema
      .split(';')
      .map(s => s
        .split('\n')
        .filter(line => !line.trim().startsWith('--'))
        .join('\n')
        .trim())
      .filter(s => s.length > 0);

    const connection = await pool.getConnection();
    try {
      // Execute all CREATE TABLE and ALTER TABLE statements
      for (const statement of statements) {
        if (statement) {
          try {
            await connection.query(statement);
          } catch (error) {
            // Ignore table already exists errors
            // Ignore duplicate foreign key constraint errors (will be handled separately)
            if (error.code !== 'ER_TABLE_EXISTS_ERROR' && 
                error.code !== 'ER_FK_DUP_NAME' &&
                !error.message.includes('already exists') &&
                !error.message.includes('Duplicate foreign key constraint name')) {
              throw error;
            }
          }
        }
      }
      
      // Add foreign keys to stores table after users table is created
      // Check if foreign keys already exist before adding
      const foreignKeyStatements = [
        { name: 'fk_stores_admin_id', table: 'stores', column: 'admin_id', refTable: 'users', refColumn: 'id' },
        { name: 'fk_stores_shared_account_id', table: 'stores', column: 'shared_account_id', refTable: 'users', refColumn: 'id' }
      ];
      
      for (const fk of foreignKeyStatements) {
        try {
          // Check if foreign key exists
          const [existing] = await connection.query(`
            SELECT COUNT(*) as count 
            FROM information_schema.table_constraints 
            WHERE table_schema = ? 
            AND table_name = ? 
            AND constraint_name = ?
            AND constraint_type = 'FOREIGN KEY'
          `, [dbName, fk.table, fk.name]);
          
          if (existing[0].count === 0) {
            await connection.query(`
              ALTER TABLE ${fk.table} 
              ADD CONSTRAINT ${fk.name} 
              FOREIGN KEY (${fk.column}) REFERENCES ${fk.refTable}(${fk.refColumn}) ON DELETE SET NULL
            `);
          }
        } catch (error) {
          // Ignore if foreign key already exists or table doesn't exist
          if (error.code !== 'ER_FK_DUP_NAME' && error.code !== 'ER_NO_SUCH_TABLE' && error.code !== 'ER_CANT_CREATE_TABLE') {
            console.warn(`Warning adding foreign key ${fk.name}: ${error.message}`);
          }
        }
      }
      
      // Now create indexes separately, checking if they exist first
      // Các cột thêm sau này qua migration — đảm bảo tồn tại trên DB CŨ
      // (CREATE TABLE IF NOT EXISTS trong schema.sql là no-op với bảng có sẵn,
      // nên thiếu bước này thì deploy lên DB cũ sẽ 500 hàng loạt)
      const ensureColumns = [
        { table: 'employees', column: 'password_hash', ddl: 'VARCHAR(255) NULL' },
        { table: 'employees', column: 'hourly_rate', ddl: 'DECIMAL(12, 2) NULL' },
        { table: 'employees', column: 'shift_rate', ddl: 'DECIMAL(12, 2) NULL' },
        { table: 'employees', column: 'failed_login_attempts', ddl: 'INT NOT NULL DEFAULT 0' },
        { table: 'employees', column: 'locked_until', ddl: 'DATETIME NULL' },
        { table: 'products', column: 'commission_percent', ddl: 'DECIMAL(5, 2) NULL' },
        { table: 'orders', column: 'employee_id', ddl: 'INT NULL' },
        { table: 'store_zalo_accounts', column: 'qr_image', ddl: 'LONGTEXT NULL' },
        { table: 'timesheets', column: 'check_in_ip', ddl: 'VARCHAR(45) NULL' },
        { table: 'timesheets', column: 'auto_closed', ddl: 'TINYINT(1) NOT NULL DEFAULT 0' },
        { table: 'stores', column: 'latitude', ddl: 'DECIMAL(10, 7) NULL' },
        { table: 'stores', column: 'longitude', ddl: 'DECIMAL(10, 7) NULL' },
        // Cột generated cho unique index chống double check-in: ca mở = 1,
        // ca đã đóng = NULL (NULL không tính vào unique) — hai request check-in
        // đồng thời cùng (store, employee) thì request sau fail ER_DUP_ENTRY
        { table: 'timesheets', column: 'open_slot_flag', ddl: 'TINYINT AS (IF(check_out IS NULL, 1, NULL)) STORED' },
        // MySQL coi NULL != NULL trong unique index — index theo employee_id
        // thẳng sẽ KHÔNG chặn được ca "tài khoản chung, chưa chọn tên nhân
        // viên" (employee_id NULL), chính là ca dễ double check-in nhất (mọi
        // nhân viên chưa có login riêng đều check-in qua slot này). Quy đổi
        // NULL → -1 (employee.id luôn dương) để 2 row cùng NULL vẫn va chạm.
        // VIRTUAL (không STORED): employee_id có FOREIGN KEY tới employees(id)
        // — thêm cột STORED phụ thuộc cột có FK bị MySQL/InnoDB từ chối với
        // lỗi 1215 "Cannot add foreign key constraint" (giới hạn đã biết của
        // InnoDB, đã test tái hiện). VIRTUAL vẫn index được bình thường.
        { table: 'timesheets', column: 'employee_slot_key', ddl: 'INT AS (COALESCE(employee_id, -1)) VIRTUAL' },
        // Cột generated cho unique index chống gửi Zalo trùng: row 'sent' = 1,
        // row 'failed' = NULL (không ràng buộc, cho phép thử lại)
        { table: 'order_notifications', column: 'sent_flag', ddl: "TINYINT AS (IF(status = 'sent', 1, NULL)) STORED" },
      ];
      for (const col of ensureColumns) {
        try {
          const [existing] = await connection.query(`
            SELECT COUNT(*) AS count FROM information_schema.columns
            WHERE table_schema = ? AND table_name = ? AND column_name = ?
          `, [dbName, col.table, col.column]);
          if (existing[0].count === 0) {
            await connection.query(`ALTER TABLE \`${col.table}\` ADD COLUMN \`${col.column}\` ${col.ddl}`);
            console.log(`✅ Added missing column ${col.table}.${col.column}`);
          }
        } catch (error) {
          if (error.code !== 'ER_NO_SUCH_TABLE') {
            console.warn(`Warning ensuring column ${col.table}.${col.column}: ${error.message}`);
          }
        }
      }

      // Dọn index chống-double-check-in phiên bản cũ (lỗi: không chặn được
      // slot vô danh employee_id NULL) nếu một lần chạy trước đã lỡ tạo nó
      try {
        const [oldIdx] = await connection.query(`
          SELECT COUNT(*) AS count FROM information_schema.statistics
          WHERE table_schema = ? AND table_name = 'timesheets' AND index_name = 'uq_timesheets_open_slot'
        `, [dbName]);
        if (oldIdx[0].count > 0) {
          await connection.query('DROP INDEX uq_timesheets_open_slot ON timesheets');
          console.log('✅ Dropped outdated index uq_timesheets_open_slot (replaced by uq_timesheets_open_slot_v2)');
        }
      } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
          console.warn(`Warning dropping outdated index uq_timesheets_open_slot: ${error.message}`);
        }
      }

      const indexStatements = [
        { name: 'idx_orders_status', table: 'orders', columns: 'status' },
        { name: 'idx_orders_assigned_to', table: 'orders', columns: 'assigned_to' },
        { name: 'idx_orders_customer_id', table: 'orders', columns: 'customer_id' },
        { name: 'idx_orders_created_at', table: 'orders', columns: 'created_at' },
        { name: 'idx_orders_employee_id', table: 'orders', columns: 'employee_id' },
        { name: 'idx_timesheets_user_id', table: 'timesheets', columns: 'user_id' },
        { name: 'idx_timesheets_check_in', table: 'timesheets', columns: 'check_in' },
        // Composite cho các query "ca đang mở" (user_id = ? AND check_out IS NULL)
        // chạy trên mọi lượt /open-shifts, check-in, check-out
        { name: 'idx_timesheets_user_checkout', table: 'timesheets', columns: 'user_id, check_out' },
        { name: 'idx_audit_logs_user_id', table: 'audit_logs', columns: 'user_id' },
        { name: 'idx_audit_logs_entity', table: 'audit_logs', columns: 'entity, entity_id' },
        { name: 'idx_employees_phone', table: 'employees', columns: 'phone' },
        { name: 'idx_salary_adjustments_employee', table: 'salary_adjustments', columns: 'employee_id, adjust_date' },
        // Đường nóng báo cáo & hoa hồng: lọc theo cửa hàng + khoảng thời gian
        { name: 'idx_orders_store_created', table: 'orders', columns: 'store_id, created_at' },
        { name: 'idx_order_payments_paid_at', table: 'order_payments', columns: 'paid_at' },
        { name: 'idx_cash_drawer_store_occurred', table: 'cash_drawer_transactions', columns: 'store_id, occurred_at' },
        // UNIQUE: chặn 2 ca mở cùng lúc cho cùng 1 nhân viên (hoặc cùng 1 slot
        // vô danh) tại 1 tiệm — race double check-in từ 2 thiết bị. Dùng
        // employee_slot_key (đã quy đổi NULL→-1) thay vì employee_id thẳng.
        { name: 'uq_timesheets_open_slot_v2', table: 'timesheets', columns: 'store_id, employee_slot_key, open_slot_flag', unique: true },
        // UNIQUE: mỗi đơn chỉ có 1 row 'sent' cho mỗi loại sự kiện Zalo —
        // 2 request đồng thời thì request sau fail ER_DUP_ENTRY, khách không nhận tin trùng
        { name: 'uq_order_notifications_sent', table: 'order_notifications', columns: 'order_id, event_type, sent_flag', unique: true }
      ];
      
      for (const idx of indexStatements) {
        try {
          // Check if index exists
          const [existing] = await connection.query(`
            SELECT COUNT(*) as count 
            FROM information_schema.statistics 
            WHERE table_schema = ? AND table_name = ? AND index_name = ?
          `, [dbName, idx.table, idx.name]);
          
          if (existing[0].count === 0) {
            await connection.query(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} ON ${idx.table}(${idx.columns})`);
          }
        } catch (error) {
          // Ignore if table doesn't exist yet or index creation fails
          if (error.code !== 'ER_NO_SUCH_TABLE' && error.code !== 'ER_DUP_KEYNAME') {
            console.warn(`Warning creating index ${idx.name}: ${error.message}`);
          }
        }
      }
      // Seed a root admin when the users table is empty (fresh database), so a
      // bare `npm run dev` yields a loginable system without requiring init-db.
      // Guarded by UNIQUE(phone): a concurrent seeder loses with ER_DUP_ENTRY.
      try {
        const [userCount] = await connection.query('SELECT COUNT(*) AS count FROM users');
        if (userCount[0].count === 0) {
          const passwordHash = await bcrypt.hash('admin123', await bcrypt.genSalt(10));
          await connection.query(`
            INSERT INTO users (name, phone, password_hash, role, status, store_id)
            VALUES (?, ?, ?, 'root', 'active', NULL)
          `, ['Root Admin', 'admin', passwordHash]);
          console.log('✅ Users table was empty — created default root admin (phone: admin, password: admin123)');
          console.log('⚠️  Change this password before exposing the server to anyone else.');
        }
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') {
          console.warn(`Warning seeding default root admin: ${error.message}`);
        }
      }
    } finally {
      connection.release();
    }

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

// Auto-init DB in development; require explicit opt-in in production.
// This prevents races when running `npm run init-db` on a VPS.
const shouldAutoInit =
  process.env.DB_AUTO_INIT === 'true' || process.env.NODE_ENV !== 'production';

if (shouldAutoInit) {
  initializeDatabase().catch(err => {
    console.error('❌ Failed to initialize database:', err.message);
    console.error('💡 Make sure MySQL is running and credentials are correct');
    console.error('💡 Check your .env file or environment variables');
    // Don't exit - let server start and show error on first request
  });
}

// Helper function to prepare and execute queries
export const query = async (sql, params = []) => {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (error) {
    console.error('Query error:', error);
    throw error;
  }
};

// Helper function to get single row
export const queryOne = async (sql, params = []) => {
  const rows = await query(sql, params);
  return rows[0] || null;
};

// Helper function to execute (for INSERT, UPDATE, DELETE)
export const execute = async (sql, params = []) => {
  try {
    const [result] = await pool.query(sql, params);
    return result;
  } catch (error) {
    console.error('Execute error:', error);
    throw error;
  }
};

// Helper function for transactions
export const transaction = async (callback) => {
  const connection = await pool.getConnection();

  try {
    // beginTransaction phải nằm TRONG try — throw ở đây mà nằm ngoài thì
    // connection không bao giờ release, cạn pool (limit 10) là treo cả app
    await connection.beginTransaction();
    const result = await callback({
      query: async (sql, params) => {
        const [rows] = await connection.query(sql, params);
        return rows;
      },
      queryOne: async (sql, params) => {
        const [rows] = await connection.query(sql, params);
        return rows[0] || null;
      },
      execute: async (sql, params) => {
        const [result] = await connection.query(sql, params);
        return result;
      }
    });
    
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// Export pool for direct access if needed
export default pool;
