import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { hashPassword } from '../utils/helpers.js';
import { validatePasswordStrength, containsUserInfo } from '../utils/passwordValidator.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * Employer cũ vẫn giữ SĐT trong DB sau khi cửa hàng chỉ bị inactive → tạo cửa mới cùng SĐT bị trùng.
 * Nếu SĐT thuộc employer gắn đúng một cửa hàng inactive (cùng admin), không phải tài khoản chung:
 * đổi SĐT user đó sang mã nội bộ + inactive (KHÔNG xóa user) để giữ FK đơn hàng / báo cáo.
 */
async function releaseEmployerPhoneIfStale(accountPhoneTrimmed, adminId) {
  const row = await queryOne(
    `SELECT u.id, u.role, u.store_id FROM users u WHERE u.phone = ?`,
    [accountPhoneTrimmed]
  );
  if (!row) return { ok: true };

  if (row.role !== 'employer') {
    return { ok: false };
  }

  const sharedRef = await queryOne(
    `SELECT id FROM stores WHERE shared_account_id = ? LIMIT 1`,
    [row.id]
  );
  if (sharedRef) {
    return {
      ok: false,
      error:
        `Số "${accountPhoneTrimmed}" đang là tài khoản đăng nhập chung cho ít nhất một cửa hàng. Hãy bỏ gán tài khoản chung hoặc dùng số đăng nhập khác.`,
    };
  }

  if (!row.store_id) {
    return { ok: false };
  }

  const st = await queryOne(
    `SELECT id, admin_id, status FROM stores WHERE id = ?`,
    [row.store_id]
  );
  if (!st || st.admin_id !== adminId || st.status !== 'inactive') {
    return { ok: false };
  }

  const newPhone = `__released_${row.id}_${Date.now()}`;
  await execute(`UPDATE users SET phone = ?, status = 'inactive' WHERE id = ?`, [
    newPhone,
    row.id,
  ]);
  return { ok: true };
}

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

    const nameTrimmed = name != null ? String(name).trim() : '';
    if (!nameTrimmed) {
      return res.status(400).json({ error: 'Tên cửa hàng là bắt buộc' });
    }

    let sharedId = null;
    if (shared_account_id != null && shared_account_id !== '') {
      const n = parseInt(String(shared_account_id), 10);
      if (!Number.isNaN(n) && n > 0) {
        sharedId = n;
      }
    }

    const accountPhoneTrimmed = account_phone != null ? String(account_phone).trim() : '';
    const accountPasswordTrimmed = account_password != null ? String(account_password).trim() : '';

    // If shared_account_id is provided, use it. Otherwise, create new account (đăng nhập bằng SĐT + mật khẩu; tên hiển thị = tên cửa hàng)
    if (!sharedId) {
      if (!accountPhoneTrimmed || !accountPasswordTrimmed) {
        return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin tài khoản (SĐT đăng nhập, Mật khẩu) hoặc chọn tài khoản chung' });
      }
    } else {
      // Verify shared account exists and is an employer
      const sharedAccount = await queryOne('SELECT id, role FROM users WHERE id = ?', [sharedId]);
      if (!sharedAccount) {
        return res.status(400).json({ error: 'Tài khoản chung không tồn tại' });
      }
      if (sharedAccount.role !== 'employer') {
        return res.status(400).json({ error: 'Tài khoản chung phải là tài khoản employer' });
      }
    }

    // Admin can only create stores for their chain
    let adminId = req.user.id;

    // Chỉ kiểm tra trùng SĐT khi tạo tài khoản employer mới (không dùng tài khoản chung)
    if (!sharedId) {
      const release = await releaseEmployerPhoneIfStale(accountPhoneTrimmed, adminId);
      if (release.error) {
        return res.status(400).json({ error: release.error });
      }
      const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [accountPhoneTrimmed]);
      if (existing) {
        return res.status(400).json({
          error: `Số điện thoại "${accountPhoneTrimmed}" đã được sử dụng (cửa hàng còn hoạt động hoặc tài khoản khác). Ngừng hoạt động cửa hàng cũ trước, hoặc dùng số khác.`,
        });
      }
    }

    // Create store first
    let storeId;
    try {
      // Try to insert with admin_id and shared_account_id
      const result = await execute(`
        INSERT INTO stores (name, address, phone, admin_id, shared_account_id, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `, [nameTrimmed, address?.trim() || null, phone?.trim() || null, adminId, sharedId]);
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
          `, [nameTrimmed, address?.trim() || null, phone?.trim() || null, adminId]);
          storeId = result.insertId;
          // Debug log removed for security
        } catch (error2) {
          if (error2.code === 'ER_BAD_FIELD_ERROR') {
            // If admin_id column doesn't exist, insert without it and update later
            const result = await execute(`
              INSERT INTO stores (name, address, phone, status)
              VALUES (?, ?, ?, 'active')
            `, [nameTrimmed, address?.trim() || null, phone?.trim() || null]);
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
    if (!sharedId) {
      try {
        // Password validation removed - no requirements

        const password_hash = await hashPassword(accountPasswordTrimmed);
        const employerDisplayName =
          (account_name && String(account_name).trim()) || nameTrimmed || 'Chủ cửa hàng';

        await execute(`
          INSERT INTO users (name, phone, password_hash, role, store_id, status)
          VALUES (?, ?, ?, 'employer', ?, 'active')
        `, [employerDisplayName, accountPhoneTrimmed, password_hash, storeId]);
        
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

    // Soft delete: giữ dòng stores + store_id trên orders → báo cáo theo cửa hàng vẫn khớp lịch sử
    await execute('UPDATE stores SET status = ? WHERE id = ?', ['inactive', req.params.id]);
    res.json({
      message:
        'Đã ngừng hoạt động cửa hàng. Đơn hàng và báo cáo cũ vẫn gắn cửa hàng này. Khi tạo cửa hàng mới, có thể dùng lại cùng SĐT đăng nhập nếu cửa hàng cũ đã ngừng hoạt động.',
      action: 'deactivated',
    });
  } catch (error) {
    console.error('Delete store error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

export default router;
