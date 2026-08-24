// Migration: lưu ảnh QR đăng nhập Zalo trong database (base64)
// thay vì chỉ lưu file trên đĩa — sống sót qua redeploy/multi-instance.
// Chạy: npm run migrate-zalo-qr
import pool from '../database/db.js';

async function run() {
  try {
    const [rows] = await pool.query(`
      SELECT COUNT(*) AS count FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'store_zalo_accounts' AND column_name = 'qr_image'
    `);
    if (rows[0].count > 0) {
      console.log('- store_zalo_accounts.qr_image đã tồn tại, bỏ qua');
    } else {
      await pool.query('ALTER TABLE store_zalo_accounts ADD COLUMN qr_image LONGTEXT NULL');
      console.log('✅ Đã thêm store_zalo_accounts.qr_image');
    }
    console.log('🎉 Migration hoàn tất');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration lỗi:', error.message);
    process.exit(1);
  }
}

run();
