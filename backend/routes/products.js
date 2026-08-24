import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';
import { validatePositiveNumber, validateRequiredString, validateEnum } from '../utils/validators.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// % hoa hồng nhân viên (tùy chọn, 0-100). Trả về:
// {skip} nếu không gửi, {value} (null khi xóa) hoặc {error}
const parseCommissionPercent = (value) => {
  if (value === undefined) return { skip: true };
  if (value === null || value === '') return { value: null };
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    return { error: 'Hoa hồng phải là số từ 0 đến 100 (%)' };
  }
  return { value: Math.round(num * 100) / 100 };
};

// Get all products
router.get('/', async (req, res) => { 
  try {
    const { status } = req.query;
    let querySql = `
      SELECT p.*, s.name as store_name, s.admin_id as store_admin_id
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE 1=1
    `;
    const params = [];

    // Filter by role
    if (req.user.role === 'employer') {
      // Employer: only show products from their store
      // Get the actual store_id from users table (users.store_id references stores.id)
      const user = await queryOne('SELECT store_id FROM users WHERE id = ? AND role = ?', [req.user.id, 'employer']);
      
      // Debug log removed for security
      
      if (user && user.store_id) {
        querySql += ' AND p.store_id = ?';
        params.push(user.store_id);
        // Debug log removed for security
      } else {
        // If employer has no store_id, return empty (no products)
        // Warning log removed for security
        return res.json({ data: [] });
      }
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      // Admin: only show products from stores owned by this admin
      querySql += ' AND s.admin_id = ?';
      params.push(req.user.id);
    } else if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return empty
      return res.json({ data: [] });
    }

    if (status) {
      querySql += ' AND p.status = ?';
      params.push(status);
    }

    querySql += ' ORDER BY p.created_at DESC';

    const products = await query(querySql, params);
    res.json({ data: products });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single product
router.get('/:id', async (req, res) => {
  try {
    let querySql = `
      SELECT p.*, s.name as store_name, s.admin_id as store_admin_id
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id = ?
    `;
    const params = [req.params.id];

    // Filter by role
    if (req.user.role === 'employer') {
      // Employer: only show products from their store
      const user = await queryOne('SELECT store_id FROM users WHERE id = ? AND role = ?', [req.user.id, 'employer']);
      
      if (user && user.store_id) {
        querySql += ' AND p.store_id = ?';
        params.push(user.store_id);
      } else {
        return res.status(404).json({ error: 'Product not found' });
      }
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      // Admin: only show products from stores owned by this admin
      querySql += ' AND s.admin_id = ?';
      params.push(req.user.id);
    } else if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return 404
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = await queryOne(querySql, params);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ data: product });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create product (Admin only)
router.post('/', authorize('admin'), auditLog('create', 'product'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - cannot create products
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể tạo sản phẩm' });
    }

    // Verify user still exists in database
    const currentUser = await queryOne('SELECT id, role, store_id FROM users WHERE id = ?', [req.user.id]);
    if (!currentUser) {
      return res.status(401).json({ error: 'Tài khoản không tồn tại. Vui lòng đăng xuất và đăng nhập lại.' });
    }

    const { name, unit, price, status, store_id, commission_percent } = req.body;

    const commission = parseCommissionPercent(commission_percent);
    if (commission.error) {
      return res.status(400).json({ error: commission.error });
    }
    const commissionValue = commission.skip ? null : commission.value;

    // Validate name
    const nameValidation = validateRequiredString(name, 'Tên sản phẩm');
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }

    // Validate unit
    const unitValidation = validateEnum(unit, ['kg', 'cai', 'don'], 'Đơn vị');
    if (!unitValidation.valid) {
      return res.status(400).json({ error: unitValidation.error });
    }

    // Validate price
    const priceValidation = validatePositiveNumber(price, false);
    if (!priceValidation.valid) {
      return res.status(400).json({ error: `Giá sản phẩm: ${priceValidation.error}` });
    }

    // Determine store_id: use provided store_id or default to user's store_id
    let finalStoreId = store_id || currentUser.store_id || null;

    // For admin, verify store belongs to them
    if (currentUser.role === 'admin' && finalStoreId) {
      const store = await queryOne('SELECT admin_id FROM stores WHERE id = ?', [finalStoreId]);
      if (!store) {
        return res.status(404).json({ error: 'Store not found' });
      }
      if (store.admin_id !== currentUser.id) {
        return res.status(403).json({ error: 'Bạn chỉ có thể tạo sản phẩm cho cửa hàng trong chuỗi của mình' });
      }
    }

    const nameKey = nameValidation.value.trim();
    const dupCreate = await queryOne(
      `SELECT id FROM products
       WHERE store_id <=> ?
         AND status = 'active'
         AND LOWER(TRIM(name)) = LOWER(?)`,
      [finalStoreId, nameKey],
    );
    if (dupCreate) {
      return res.status(400).json({
        error: 'Tên sản phẩm đã tồn tại trong cửa hàng này (sản phẩm đang bán). Vui lòng đặt tên khác.',
      });
    }

    const result = await execute(`
      INSERT INTO products (name, unit, price, commission_percent, eta_minutes, status, created_by, updated_by, store_id)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `, [
      nameValidation.value,
      unitValidation.value,
      priceValidation.value,
      commissionValue,
      status || 'active',
      currentUser.id,
      currentUser.id,
      finalStoreId,
    ]);

    const newProduct = await queryOne('SELECT * FROM products WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: newProduct });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update product (Admin only)
router.patch('/:id', authorize('admin'), auditLog('update', 'product'), async (req, res) => {
  try {
    const { name, unit, price, status, commission_percent } = req.body;

    const oldProduct = await queryOne(`
      SELECT p.*, s.admin_id as store_admin_id
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id = ?
    `, [req.params.id]);
    
    if (!oldProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // For admin (not root), verify product belongs to their store chain
    if (req.user.role === 'admin' && oldProduct.store_admin_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn chỉ có thể sửa sản phẩm trong chuỗi cửa hàng của mình' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      const nameValidation = validateRequiredString(name, 'Tên sản phẩm');
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error });
      }
      const nameKey = nameValidation.value.trim();
      const dupUpdate = await queryOne(
        `SELECT id FROM products
         WHERE store_id <=> ?
           AND status = 'active'
           AND LOWER(TRIM(name)) = LOWER(?)
           AND id != ?`,
        [oldProduct.store_id, nameKey, req.params.id],
      );
      if (dupUpdate) {
        return res.status(400).json({
          error: 'Tên sản phẩm đã tồn tại trong cửa hàng này (sản phẩm đang bán). Vui lòng đặt tên khác.',
        });
      }
      updates.push('name = ?');
      values.push(nameValidation.value);
    }
    
    if (unit !== undefined) {
      const unitValidation = validateEnum(unit, ['kg', 'cai', 'don'], 'Đơn vị');
      if (!unitValidation.valid) {
        return res.status(400).json({ error: unitValidation.error });
      }
      updates.push('unit = ?');
      values.push(unitValidation.value);
    }
    
    if (price !== undefined) {
      const priceValidation = validatePositiveNumber(price, false);
      if (!priceValidation.valid) {
        return res.status(400).json({ error: `Giá sản phẩm: ${priceValidation.error}` });
      }
      updates.push('price = ?');
      values.push(priceValidation.value);
    }
    
    if (status !== undefined) {
      const statusValidation = validateEnum(status, ['active', 'inactive'], 'Trạng thái');
      if (!statusValidation.valid) {
        return res.status(400).json({ error: statusValidation.error });
      }
      updates.push('status = ?');
      values.push(statusValidation.value);
    }

    const commission = parseCommissionPercent(commission_percent);
    if (commission.error) {
      return res.status(400).json({ error: commission.error });
    }
    if (!commission.skip) {
      updates.push('commission_percent = ?');
      values.push(commission.value);
    }

    updates.push('updated_by = ?');
    values.push(req.user.id);
    // MySQL handles updated_at automatically
    values.push(req.params.id);

    await execute(`
      UPDATE products
      SET ${updates.join(', ')}
      WHERE id = ?
    `, values);

    const updatedProduct = await queryOne('SELECT * FROM products WHERE id = ?', [req.params.id]);
    res.json({ data: updatedProduct });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete product (Admin only)
router.delete('/:id', authorize('admin'), auditLog('delete', 'product'), async (req, res) => {
  try {
    const product = await queryOne(`
      SELECT p.id, s.admin_id as store_admin_id
      FROM products p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id = ?
    `, [req.params.id]);
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Root admin is software vendor, not store operator - cannot delete products
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xóa sản phẩm' });
    }

    // For admin, verify product belongs to their store chain
    if (req.user.role === 'admin' && product.store_admin_id !== req.user.id) {
      return res.status(403).json({ error: 'Bạn chỉ có thể xóa sản phẩm trong chuỗi cửa hàng của mình' });
    }

    // Quy ước: "Xóa" = luôn chỉ đổi sang inactive, không DELETE để giữ lịch sử đơn hàng và báo cáo
    await execute('UPDATE products SET status = ? WHERE id = ?', ['inactive', req.params.id]);
    return res.json({
      message: 'Đã ngừng kinh doanh sản phẩm. Sản phẩm được ẩn khỏi danh sách chọn khi tạo đơn.',
      action: 'deactivated'
    });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

export default router;
