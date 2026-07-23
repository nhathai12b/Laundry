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
  // Only resolve to an active store. Falling back to an inactive one would let
  // a shared login account keep operating (check-in, settings, ...) against a
  // store an admin has deliberately deactivated. Callers already handle a
  // null result gracefully (e.g. timesheets check-in returns a clear error).
  const s = await queryOne(
    `SELECT id FROM stores WHERE shared_account_id = ? AND status = 'active' ORDER BY id LIMIT 1`,
    [userId]
  );
  return s?.id != null ? Number(s.id) : null;
}
