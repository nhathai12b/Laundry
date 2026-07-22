import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { hashPassword } from '../utils/helpers.js';
import { validatePasswordStrength, containsUserInfo } from '../utils/passwordValidator.js';

const router = express.Router();

/** Tránh 403 sai do JWT id (number) so với MySQL BIGINT (string) hoặc ngược lại. */
function sameChainAdmin(storeAdminId, userId) {
  return storeAdminId != null && Number(storeAdminId) === Number(userId);
}

/**
 * Xác nhận tài khoản dùng chung (shared_account_id) đã thuộc chuỗi của admin
 * này (là chủ một cửa hàng, hoặc đã là tài khoản chung của một cửa hàng khác,
 * trong chuỗi). Không kiểm tra sẽ cho phép gán bất kỳ employer id nào (kể cả
 * của chuỗi khác) làm tài khoản đăng nhập chung cho cửa hàng của mình.
 */
async function sharedAccountBelongsToAdminChain(sharedUserId, adminId) {
  const row = await queryOne(
    `SELECT 1
     FROM users u
     LEFT JOIN stores s_own ON u.store_id = s_own.id AND s_own.admin_id = ?
     LEFT JOIN stores s_shared ON s_shared.shared_account_id = u.id AND s_shared.admin_id = ?
     WHERE u.id = ? AND (s_own.id IS NOT NULL OR s_shared.id IS NOT NULL)`,
    [adminId, adminId, sharedUserId]
  );
  return !!row;
}

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
  if (!st || !sameChainAdmin(st.admin_id, adminId) || st.status !== 'inactive') {
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
          WHERE s.admin_id = ?
          ORDER BY (CASE WHEN s.status = 'active' THEN 0 ELSE 1 END), s.name
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
              WHERE s.admin_id = ?
              ORDER BY (CASE WHEN s.status = 'active' THEN 0 ELSE 1 END), s.name
            `, [req.user.id]);
          } catch (error2) {
          // If admin_id also doesn't exist, fail closed instead of exposing all stores
            if (error2.code === 'ER_BAD_FIELD_ERROR' && error2.message.includes('admin_id')) {
            stores = [];
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
    } else if (req.user.role === 'employer') {
      querySql += ' AND id = ?';
      params.push(req.user.store_id || 0);
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
      // Prevent attaching another chain's employer as a shared login (would
      // leak their identity/credentials access into this admin's store).
      if (!(await sharedAccountBelongsToAdminChain(sharedId, req.user.id))) {
        return res.status(403).json({ error: 'Tài khoản chung phải thuộc chuỗi cửa hàng của bạn' });
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

    let store = await queryOne('SELECT * FROM stores WHERE id = ?', [req.params.id]);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Admin can only update stores from their chain. Orphan stores
    // (admin_id IS NULL, from legacy data) are intentionally NOT
    // auto-claimed here: doing so let any admin who guesses/enumerates a
    // store id take permanent ownership of it. Assigning admin_id for
    // orphans should be done explicitly (e.g. via a migration script), not
    // as a side effect of an unrelated PATCH.
    if (req.user.role === 'admin' && !sameChainAdmin(store.admin_id, req.user.id)) {
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
      const s = String(status);
      if (s !== 'active' && s !== 'inactive') {
        return res.status(400).json({ error: 'Trạng thái phải là active hoặc inactive' });
      }
      updates.push('status = ?');
      values.push(s);
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
        if (req.user.role === 'admin' && !(await sharedAccountBelongsToAdminChain(shared_account_id, req.user.id))) {
          return res.status(403).json({ error: 'Tài khoản chung phải thuộc chuỗi cửa hàng của bạn' });
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

/**
 * Ngừng hoạt động (permanent=false) hoặc xóa hẳn bản ghi cửa hàng (permanent=true).
 * Xóa vĩnh viễn: gỡ store_id / xóa con phụ thuộc trước để tương thích DB cũ (FK RESTRICT / thiếu ON DELETE).
 */
async function handleStoreRemoval(req, res, permanent) {
  try {
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xóa cửa hàng' });
    }

    const storeId = parseInt(String(req.params.id), 10);
    if (Number.isNaN(storeId) || storeId < 1) {
      return res.status(400).json({ error: 'ID cửa hàng không hợp lệ' });
    }

    let store = await queryOne('SELECT * FROM stores WHERE id = ?', [storeId]);
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // See PATCH /:id for why orphan stores are not auto-claimed here.
    if (req.user.role === 'admin' && !sameChainAdmin(store.admin_id, req.user.id)) {
      return res.status(403).json({ error: 'Bạn chỉ có thể xóa cửa hàng trong chuỗi của mình' });
    }

    await transaction(async (db) => {
      const ownEmployerUsers = await db.query(
        `SELECT id
         FROM users
         WHERE store_id = ? AND role = 'employer'`,
        [storeId]
      );

      const ownEmployerUserIds = ownEmployerUsers.map((u) => u.id);

      if (ownEmployerUserIds.length > 0) {
        const placeholders = ownEmployerUserIds.map(() => '?').join(',');

        await db.execute(
          `DELETE FROM employees WHERE store_id IN (${placeholders})`,
          ownEmployerUserIds
        );

        await db.execute(
          `UPDATE users SET status = 'inactive' WHERE id IN (${placeholders})`,
          ownEmployerUserIds
        );
      }

      if (permanent) {
        await db.execute('UPDATE users SET store_id = NULL WHERE store_id = ?', [storeId]);
        await db.execute('UPDATE orders SET store_id = NULL WHERE store_id = ?', [storeId]);
        await db.execute('UPDATE products SET store_id = NULL WHERE store_id = ?', [storeId]);
        await db.execute('UPDATE timesheets SET store_id = NULL WHERE store_id = ?', [storeId]);
        try {
          await db.execute('DELETE FROM promotions WHERE store_id = ?', [storeId]);
        } catch (e) {
          if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
        }
        try {
          await db.execute('DELETE FROM settings WHERE store_id = ?', [storeId]);
        } catch (e) {
          if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
        }
        await db.execute('DELETE FROM stores WHERE id = ?', [storeId]);
      } else {
        await db.execute(
          `UPDATE products
           SET status = 'inactive', updated_by = ?
           WHERE store_id = ?`,
          [req.user.id, storeId]
        );

        await db.execute(
          `UPDATE promotions
           SET status = 'inactive'
           WHERE store_id = ?`,
          [storeId]
        );

        await db.execute(
          `UPDATE stores
           SET status = 'inactive'
           WHERE id = ?`,
          [storeId]
        );
      }
    });

    if (permanent) {
      return res.json({
        message:
          'Đã xóa vĩnh viễn cửa hàng khỏi hệ thống. Đơn hàng và sản phẩm cũ vẫn còn nhưng không còn gắn cửa hàng; khuyến mãi/cài đặt riêng của cửa đã được gỡ.',
        action: 'deleted',
      });
    }

    return res.json({
      message:
        'Đã ngừng hoạt động cửa hàng. Nhân viên thuộc account riêng của cửa hàng đã bị xóa; sản phẩm, khuyến mãi và tài khoản cửa hàng riêng đã bị ẩn/khóa để không còn xuất hiện ở các flow mới. Đơn hàng và báo cáo cũ vẫn được giữ.',
      action: 'deactivated',
    });
  } catch (error) {
    console.error('Delete store error:', error);
    if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) {
      return res.status(409).json({
        error:
          'Không thể xóa cửa hàng vì database còn ràng buộc tới bảng khác. Hãy cập nhật schema FK (ON DELETE SET NULL/CASCADE) hoặc gỡ dữ liệu liên quan.',
      });
    }
    return res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
}

// Xóa vĩnh viễn qua POST (tránh proxy/client bỏ query string trên DELETE).
router.post('/:id/delete-permanent', authorize('admin'), async (req, res) => {
  return handleStoreRemoval(req, res, true);
});

// Delete store (Admin only). Mặc định: ngừng hoạt động. ?permanent=1: xóa hẳn (tương thích API cũ).
router.delete('/:id', authorize('admin'), async (req, res) => {
  const permanent =
    req.query.permanent === 'true' ||
    req.query.permanent === '1' ||
    req.query.permanent === true;
  return handleStoreRemoval(req, res, permanent);
});

export default router;
