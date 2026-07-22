import { queryOne } from '../database/db.js';

/**
 * Lấy stores.id cho employer: ưu tiên users.store_id; nếu NULL (tài khoản chung) → cửa hàng có shared_account_id = user.
 */
export async function resolveStoresIdForEmployerUser(userId) {
  const u = await queryOne('SELECT store_id FROM users WHERE id = ? AND role = ?', [userId, 'employer']);
  if (!u) return null;
  if (u.store_id != null && u.store_id !== '') {
    return Number(u.store_id);
  }
  let s = await queryOne(
    `SELECT id FROM stores WHERE shared_account_id = ? AND status = 'active' ORDER BY id LIMIT 1`,
    [userId]
  );
  if (!s) {
    s = await queryOne(
      `SELECT id FROM stores WHERE shared_account_id = ? ORDER BY id LIMIT 1`,
      [userId]
    );
  }
  return s?.id != null ? Number(s.id) : null;
}
