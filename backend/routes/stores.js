import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { hashPassword } from '../utils/helpers.js';
import { validatePasswordStrength } from '../utils/passwordValidator.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Mỗi cửa hàng có ĐÚNG một tài khoản đăng nhập riêng (users.role = 'employer',
// users.store_id = stores.id). Không có cơ chế "dùng chung tài khoản" giữa các
// cửa hàng — chấm công, két tiền, báo cáo tách biệt hoàn toàn theo từng tiệm.
const STORE_WITH_ACCOUNT_SQL = `
  SELECT s.*,
         u_own.id as own_account_user_id,
         u_own.name as own_account_name,
         u_own.phone as own_account_phone
  FROM stores s
  LEFT JOIN users u_own ON s.id = u_own.store_id AND u_own.role = 'employer'
`;

// Get all stores
router.get('/', async (req, res) => {
  try {
    let stores = [];
    if (req.user.role === 'admin') {
      // Admin can ONLY see stores from their chain (admin_id = user.id).
      // Root là vendor phần mềm (không vận hành cửa hàng), employer không quản
      // lý cửa hàng → cả hai nhận mảng rỗng.
      stores = await query(
        `${STORE_WITH_ACCOUNT_SQL} WHERE s.admin_id = ? AND s.status = 'active' ORDER BY s.name`,
        [req.user.id]
      );
    }
    res.json({ data: stores });
  } catch (error) {
    console.error('Get stores error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Setup status for onboarding checklist: does this admin have a store,
// products in their stores, and employees under their store accounts?
router.get('/setup-status', authorize('admin'), async (req, res) => {
  try {
    // Root admin is the software vendor: no store setup applies
    if (req.user.role === 'root') {
      return res.json({ data: { storeCount: 0, productCount: 0, employeeCount: 0, complete: true } });
    }

    const stores = await query(
      `SELECT id FROM stores WHERE admin_id = ? AND status = 'active'`,
      [req.user.id]
    );
    const storeIds = stores.map((s) => s.id);

    let productCount = 0;
    let employeeCount = 0;

    if (storeIds.length > 0) {
      const productRow = await queryOne(
        `SELECT COUNT(*) AS count FROM products
         WHERE status = 'active' AND (store_id IN (?) OR created_by = ?)`,
        [storeIds, req.user.id]
      );
      productCount = productRow?.count || 0;

      // employees.store_id references the store's employer account (users.id)
      const employerRows = await query(
        `SELECT id FROM users WHERE role = 'employer' AND store_id IN (?)`,
        [storeIds]
      );
      const employerIds = employerRows.map((u) => u.id);

      if (employerIds.length > 0) {
        const employeeRow = await queryOne(
          `SELECT COUNT(*) AS count FROM employees WHERE status = 'active' AND store_id IN (?)`,
          [employerIds]
        );
        employeeCount = employeeRow?.count || 0;
      }
    }

    const storeCount = storeIds.length;
    res.json({
      data: {
        storeCount,
        productCount,
        employeeCount,
        complete: storeCount > 0 && productCount > 0 && employeeCount > 0
      }
    });
  } catch (error) {
    console.error('Setup status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single store
router.get('/:id', async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return 404
    if (req.user.role === 'root') {
      return res.status(404).json({ error: 'Store not found' });
    }

    let store;
    if (req.user.role === 'admin') {
      store = await queryOne('SELECT * FROM stores WHERE id = ? AND admin_id = ?', [req.params.id, req.user.id]);
    } else if (req.user.role === 'employer') {
      // Tài khoản tiệm chỉ đọc được ĐÚNG cửa hàng của mình (users.store_id trong
      // token = stores.id). Thiếu nhánh này thì bất kỳ tài khoản tiệm nào cũng
      // đọc được store BẤT KỲ bằng cách dò id tuần tự.
      if (!req.user.store_id || Number(req.params.id) !== Number(req.user.store_id)) {
        return res.status(404).json({ error: 'Store not found' });
      }
      store = await queryOne('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    } else {
      return res.status(404).json({ error: 'Store not found' });
    }

    if (!store) {
      // Return 404 for both "not found" and "access denied" to prevent information leakage
      return res.status(404).json({ error: 'Store not found' });
    }

    res.json({ data: store });
  } catch (error) {
    console.error('Get store error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create store (Admin only) — luôn tạo kèm tài khoản đăng nhập riêng cho tiệm
router.post('/', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - cannot create stores
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể tạo cửa hàng' });
    }

    const { name, address, phone, account_name, account_phone, account_password } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Tên cửa hàng là bắt buộc' });
    }
    if (!account_phone || !account_password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin tài khoản (SĐT đăng nhập, Mật khẩu)' });
    }
    // Validate mật khẩu TRƯỚC khi insert store — validate sau insert rồi
    // return 400 sớm sẽ để lại store mồ côi (không có tài khoản), mỗi lần
    // retry lại tạo thêm một bản
    const passwordCheck = validatePasswordStrength(account_password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.errors.join(' ') });
    }

    // Admin can only create stores for their chain
    const adminId = req.user.id;

    const trimmedPhone = String(account_phone).trim();
    const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [trimmedPhone]);
    if (existing) {
      return res.status(400).json({
        error: `Số điện thoại "${trimmedPhone}" đã được sử dụng`
      });
    }

    // Create store first
    const result = await execute(`
      INSERT INTO stores (name, address, phone, admin_id, status)
      VALUES (?, ?, ?, ?, 'active')
    `, [name.trim(), address?.trim() || null, phone?.trim() || null, adminId]);
    const storeId = result.insertId;

    // Create user account for the store (đăng nhập bằng SĐT + mật khẩu; tên
    // hiển thị = account_name hoặc tên cửa hàng)
    try {
      const password_hash = await hashPassword(account_password);
      const employerDisplayName =
        (account_name && String(account_name).trim()) || name.trim() || 'Chủ cửa hàng';

      await execute(`
        INSERT INTO users (name, phone, password_hash, role, store_id, status)
        VALUES (?, ?, ?, 'employer', ?, 'active')
      `, [employerDisplayName, trimmedPhone, password_hash, storeId]);
    } catch (error) {
      // If user creation fails, delete the store
      await execute('DELETE FROM stores WHERE id = ?', [storeId]);
      console.error('Error creating user account:', error);
      return res.status(500).json({ error: 'Lỗi khi tạo tài khoản. Vui lòng thử lại.' });
    }

    // Return store with account info (same format as GET endpoint)
    const store = await queryOne(`${STORE_WITH_ACCOUNT_SQL} WHERE s.id = ?`, [storeId]);
    if (!store) {
      return res.status(500).json({ error: 'Không thể lấy thông tin cửa hàng sau khi tạo' });
    }

    res.status(201).json({
      data: store,
      message: 'Tạo cửa hàng và tài khoản thành công!'
    });
  } catch (error) {
    console.error('Create store error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Update store (Admin only)
router.patch('/:id', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - cannot update stores
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể sửa cửa hàng' });
    }

    const { name, address, phone, status, latitude, longitude } = req.body;

    const store = await queryOne('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Admin can only update stores from their chain
    if (!store.admin_id || store.admin_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn chỉ có thể sửa cửa hàng trong chuỗi của mình' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (address !== undefined) {
      updates.push('address = ?');
      values.push(address);
    }
    if (phone !== undefined) {
      updates.push('phone = ?');
      values.push(phone);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    // Tọa độ tiệm cho kiểm soát check-in/check-out bằng GPS
    // (gửi null/'' để xóa — tắt kiểm soát vị trí cho cửa hàng này)
    if (latitude !== undefined && longitude !== undefined) {
      if (latitude === null || latitude === '' || longitude === null || longitude === '') {
        updates.push('latitude = ?', 'longitude = ?');
        values.push(null, null);
      } else {
        const lat = Number.parseFloat(latitude);
        const lng = Number.parseFloat(longitude);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
          return res.status(400).json({ error: 'Tọa độ không hợp lệ' });
        }
        updates.push('latitude = ?', 'longitude = ?');
        values.push(lat, lng);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // MySQL handles updated_at automatically
    values.push(req.params.id);

    await execute(`UPDATE stores SET ${updates.join(', ')} WHERE id = ?`, values);

    const updated = await queryOne('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    res.json({ data: updated });
  } catch (error) {
    console.error('Update store error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete store (Admin only)
router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - cannot delete stores
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xóa cửa hàng' });
    }

    const store = await queryOne('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Admin can only delete stores from their chain
    if (!store.admin_id || store.admin_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn chỉ có thể xóa cửa hàng trong chuỗi của mình' });
    }

    // Soft delete: set status inactive (preserves orders, products, history)
    await execute('UPDATE stores SET status = ? WHERE id = ?', ['inactive', req.params.id]);
    res.json({ message: 'Đã ngừng hoạt động cửa hàng', action: 'deactivated' });
  } catch (error) {
    console.error('Delete store error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

export default router;
