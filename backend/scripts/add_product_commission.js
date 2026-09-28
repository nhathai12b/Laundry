// Migration: hoa hồng sản phẩm cho nhân viên
// - products.commission_percent: % hoa hồng trên giá bán (admin đặt trên sản phẩm)
// - products.commission_amount: hoa hồng tiền cố định (đ) cho mỗi đơn vị bán ra
//   (mỗi sản phẩm chỉ dùng MỘT trong hai, hoặc không có hoa hồng)
// - orders.employee_id: nhân viên tạo/xử lý đơn (để quy hoa hồng đúng người)
// Chạy: npm run migrate-commission
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
    if (await columnExists('products', 'commission_percent')) {
      console.log('- products.commission_percent đã tồn tại, bỏ qua');
    } else {
      await pool.query('ALTER TABLE products ADD COLUMN commission_percent DECIMAL(5, 2) NULL');
      console.log('✅ Đã thêm products.commission_percent');
    }

    if (await columnExists('products', 'commission_amount')) {
      console.log('- products.commission_amount đã tồn tại, bỏ qua');
    } else {
      await pool.query('ALTER TABLE products ADD COLUMN commission_amount DECIMAL(12, 2) NULL');
      console.log('✅ Đã thêm products.commission_amount');
    }

    if (await columnExists('orders', 'employee_id')) {
      console.log('- orders.employee_id đã tồn tại, bỏ qua');
    } else {
      await pool.query('ALTER TABLE orders ADD COLUMN employee_id INT NULL');
      await pool.query('CREATE INDEX idx_orders_employee_id ON orders(employee_id)');
      console.log('✅ Đã thêm orders.employee_id + index');
    }

    console.log('🎉 Migration hoàn tất');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration lỗi:', error.message);
    process.exit(1);
  }
}

run();
