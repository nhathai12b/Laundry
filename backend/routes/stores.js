import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { hashPassword } from '../utils/helpers.js';
import { validatePasswordStrength, containsUserInfo } from '../utils/passwordValidator.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get all stores
router.get('/', async (req, res) => {
  try {
    let stores;
    if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return empty
      stores = [];
    } else if (req.user.role === 'admin') {
      // Admin can ONLY see stores from their chain (admin_id = user.id)
      // No fallback - strict filtering to prevent seeing other admins' stores
      // Try query with all columns first
      try {
        stores = await query(`
          SELECT s.*, 
                 u_shared.id as shared_account_user_id,
                 u_shared.name as shared_account_name,
                 u_shared.phone as shared_account_phone,
                 u_own.id as own_account_user_id,
                 u_own.name as own_account_name,
                 u_own.phone as own_account_phone
          FROM stores s
          LEFT JOIN users u_shared ON s.shared_account_id = u_shared.id
          LEFT JOIN users u_own ON s.id = u_own.store_id AND u_own.role = 'employer'
          WHERE s.admin_id = ? AND s.status = 'active'
          ORDER BY s.name
        `, [req.user.id]);
      } catch (error) {
        // If shared_account_id or admin_id column doesn't exist, try simpler query
        if (error.code === 'ER_BAD_FIELD_ERROR') {
          // Log removed for security
          try {
            // Try with admin_id but without shared_account_id
            stores = await query(`
              SELECT s.*, 
                     u_own.id as own_account_user_id,
                     u_own.name as own_account_name,
                     u_own.phone as own_account_phone
              FROM stores s
              LEFT JOIN users u_own ON s.id = u_own.store_id AND u_own.role = 'employer'
              WHERE s.admin_id = ? AND s.status = 'active'
              ORDER BY s.name
            `, [req.user.id]);
          } catch (error2) {
            // If admin_id also doesn't exist, get all stores
            if (error2.code === 'ER_BAD_FIELD_ERROR' && error2.message.includes('admin_id')) {
              // Warning log removed for security
              stores = await query(`
                SELECT s.*, 
                       u_own.id as own_account_user_id,
                       u_own.name as own_account_name,
                       u_own.phone as own_account_phone
                FROM stores s
                LEFT JOIN users u_own ON s.id = u_own.store_id AND u_own.role = 'employer'
                WHERE s.status = 'active'
                ORDER BY s.name
              `);
            } else {
              throw error2;
            }
          }
        } else {
          throw error;
        }
      }
    } else {
      // For employer or other roles, return empty array (they don't manage stores)
      stores = [];
    }
    res.json({ data: stores });
  } catch (error) {
    // If stores table doesn't exist, return empty array
    if (error.message && error.message.includes("doesn't exist")) {
      // Log removed for security
      return res.json({ data: [] });
    }
    // If admin_id column doesn't exist, return empty array for admin
    if (error.code === 'ER_BAD_FIELD_ERROR' || error.message.includes('admin_id')) {
      // Warning log removed for security
      if (req.user.role === 'admin') {
        return res.json({ data: [] });
      }
    }
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
      `SELECT id, shared_account_id FROM stores WHERE admin_id = ? AND status = 'active'`,
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

      // employees.store_id references the store's employer account (users.id):
      // dedicated accounts have users.store_id = stores.id; shared accounts are
      // referenced via stores.shared_account_id
      const employerRows = await query(
        `SELECT id FROM users WHERE role = 'employer' AND store_id IN (?)`,
        [storeIds]
      );
      const employerIds = [
        ...new Set([
          ...employerRows.map((u) => u.id),
          ...stores.map((s) => s.shared_account_id).filter(Boolean)
        ])
      ];

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

    let querySql = 'SELECT * FROM stores WHERE id = ?';
    const params = [req.params.id];

    // For admin, only allow access to their own stores
    if (req.user.role === 'admin') {
      querySql += ' AND admin_id = ?';
      params.push(req.user.id);
    }

    const store = await queryOne(querySql, params);
    
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

// Create store (Admin only)
router.post('/', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - cannot create stores
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể tạo cửa hàng' });
    }

    const { name, address, phone, account_name, account_phone, account_password, shared_account_id } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Tên cửa hàng là bắt buộc' });
    }

    // If shared_account_id is provided, use it. Otherwise, create new account (đăng nhập bằng SĐT + mật khẩu; tên hiển thị = tên cửa hàng)
    if (!shared_account_id) {
      if (!account_phone || !account_password) {
        return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin tài khoản (SĐT đăng nhập, Mật khẩu) hoặc chọn tài khoản chung' });
      }
    } else {
      // Verify shared account exists and is an employer
      const sharedAccount = await queryOne('SELECT id, role FROM users WHERE id = ?', [shared_account_id]);
      if (!sharedAccount) {
        return res.status(400).json({ error: 'Tài khoản chung không tồn tại' });
      }
      if (sharedAccount.role !== 'employer') {
        return res.status(400).json({ error: 'Tài khoản chung phải là tài khoản employer' });
      }
    }

    // Admin can only create stores for their chain
    let adminId = req.user.id;

    // Check if phone exists
    const trimmedPhone = account_phone.trim();
    const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [trimmedPhone]);
    if (existing) {
      return res.status(400).json({ 
        error: `Số điện thoại "${trimmedPhone}" đã được sử dụng` 
      });
    }

    // Create store first
    let storeId;
    try {
      // Try to insert with admin_id and shared_account_id
      const result = await execute(`
        INSERT INTO stores (name, address, phone, admin_id, shared_account_id, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `, [name.trim(), address?.trim() || null, phone?.trim() || null, adminId, shared_account_id || null]);
      storeId = result.insertId;
      // Debug log removed for security
    } catch (error) {
      // If columns don't exist, try without them
      if (error.code === 'ER_BAD_FIELD_ERROR') {
        // Warning log removed for security
        try {
          // Try with admin_id but without shared_account_id
          const result = await execute(`
            INSERT INTO stores (name, address, phone, admin_id, status)
            VALUES (?, ?, ?, ?, 'active')
          `, [name.trim(), address?.trim() || null, phone?.trim() || null, adminId]);
          storeId = result.insertId;
          // Debug log removed for security
        } catch (error2) {
          if (error2.code === 'ER_BAD_FIELD_ERROR') {
            // If admin_id column doesn't exist, insert without it and update later
            const result = await execute(`
              INSERT INTO stores (name, address, phone, status)
              VALUES (?, ?, ?, 'active')
            `, [name.trim(), address?.trim() || null, phone?.trim() || null]);
            storeId = result.insertId;
            // Debug log removed for security
            // Try to update admin_id if column exists
            try {
              await execute('UPDATE stores SET admin_id = ? WHERE id = ?', [adminId, storeId]);
              // Debug log removed for security
            } catch (updateError) {
              // Warning log removed for security
            }
          } else {
            throw error2;
          }
        }
      } else {
        throw error;
      }
    }

    // Create user account for the store only if not using shared account
    if (!shared_account_id) {
      try {
        // Password validation removed - no requirements

        const password_hash = await hashPassword(account_password);
        const employerDisplayName =
          (account_name && String(account_name).trim()) || name.trim() || 'Chủ cửa hàng';

        await execute(`
          INSERT INTO users (name, phone, password_hash, role, store_id, status)
          VALUES (?, ?, ?, 'employer', ?, 'active')
        `, [employerDisplayName, trimmedPhone, password_hash, storeId]);
        
        // Debug log removed for security
      } catch (error) {
        // If user creation fails, delete the store
        await execute('DELETE FROM stores WHERE id = ?', [storeId]);
        console.error('Error creating user account:', error);
        return res.status(500).json({ error: 'Lỗi khi tạo tài khoản. Vui lòng thử lại.' });
      }
    } else {
      // Debug log removed for security
    }

    // Return store with account info (same format as GET endpoint)
    let store;
    try {
      store = await queryOne(`
        SELECT s.*, 
               u_shared.id as shared_account_user_id,
               u_shared.name as shared_account_name,
               u_shared.phone as shared_account_phone,
               u_own.id as own_account_user_id,
               u_own.name as own_account_name,
               u_own.phone as own_account_phone
        FROM stores s
        LEFT JOIN users u_shared ON s.shared_account_id = u_shared.id
        LEFT JOIN users u_own ON s.id = u_own.store_id AND u_own.role = 'employer'
        WHERE s.id = ?
      `, [storeId]);
    } catch (error) {
      // If shared_account_id column doesn't exist, use simpler query
      if (error.code === 'ER_BAD_FIELD_ERROR') {
        store = await queryOne(`
          SELECT s.*, 
                 u_own.id as own_account_user_id,
                 u_own.name as own_account_name,
                 u_own.phone as own_account_phone
          FROM stores s
          LEFT JOIN users u_own ON s.id = u_own.store_id AND u_own.role = 'employer'
          WHERE s.id = ?
        `, [storeId]);
      } else {
        throw error;
      }
    }
    
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

    const { name, address, phone, status, shared_account_id } = req.body;

    const store = await queryOne('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Admin can only update stores from their chain
    if (req.user.role === 'admin') {
      // Check if store belongs to admin's chain
      if (!store.admin_id || store.admin_id !== req.user.id) {
        return res.status(403).json({ error: 'Bạn chỉ có thể sửa cửa hàng trong chuỗi của mình' });
      }
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
    if (shared_account_id !== undefined) {
      // Verify shared account exists if provided
      if (shared_account_id) {
        const sharedAccount = await queryOne('SELECT id, role FROM users WHERE id = ?', [shared_account_id]);
        if (!sharedAccount) {
          return res.status(400).json({ error: 'Tài khoản chung không tồn tại' });
        }
        if (sharedAccount.role !== 'employer') {
          return res.status(400).json({ error: 'Tài khoản chung phải là tài khoản employer' });
        }
      }
      updates.push('shared_account_id = ?');
      values.push(shared_account_id || null);
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
    if (req.user.role === 'admin') {
      // Check if store belongs to admin's chain
      if (!store.admin_id || store.admin_id !== req.user.id) {
        return res.status(403).json({ error: 'Bạn chỉ có thể xóa cửa hàng trong chuỗi của mình' });
      }
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
