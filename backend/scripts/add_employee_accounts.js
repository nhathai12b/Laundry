// Migration: tài khoản đăng nhập riêng + thiết lập lương cho từng nhân viên
// - employees: thêm password_hash (đăng nhập riêng), hourly_rate, shift_rate
// - salary_adjustments: admin cộng/trừ tiền cho nhân viên theo ngày
// Chạy: npm run migrate-employee-accounts
import pool from '../database/db.js';

async function columnExists(table, column) {
  const [rows] = await pool.query(`
    SELECT COUNT(*) AS count FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
  `, [table, column]);
  return rows[0].count > 0;
}

async function run() {
  try {
    const columns = [
      ['password_hash', 'VARCHAR(255) NULL'],
      ['hourly_rate', 'DECIMAL(12, 2) NULL'],
      ['shift_rate', 'DECIMAL(12, 2) NULL'],
    ];
    for (const [name, def] of columns) {
      if (await columnExists('employees', name)) {
        console.log(`- employees.${name} đã tồn tại, bỏ qua`);
      } else {
        await pool.query(`ALTER TABLE employees ADD COLUMN ${name} ${def}`);
        console.log(`✅ Đã thêm employees.${name}`);
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS salary_adjustments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        store_id INT NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        reason VARCHAR(255),
        adjust_date DATE NOT NULL,
        created_by INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        INDEX idx_salary_adjustments_employee (employee_id, adjust_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Bảng salary_adjustments sẵn sàng');

    console.log('🎉 Migration hoàn tất');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration lỗi:', error.message);
    process.exit(1);
  }
}

run();
