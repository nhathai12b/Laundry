import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';
import { validatePositiveNumber, validatePositiveInteger, validateEnum, validateDateRange, sanitizeString, validateRequiredString } from '../utils/validators.js';
import { normalizeCustomerPhoneForIdentity } from '../utils/helpers.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get all promotions (Admin only)
router.get('/', authorize('admin'), async (req, res) => {
  try {
    const { status, type } = req.query;
    let querySql = `
      SELECT p.*, u.name as created_by_name, s.name as store_name
      FROM promotions p
      LEFT JOIN users u ON p.created_by = u.id
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE 1=1
    `;
    const params = [];

    // Filter by admin: only show promotions from stores owned by this admin
    // Support store_id from query param for filtering
    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      if (storeIdParam && storeIdParam !== 'all') {
        // Filter by specific store - verify store belongs to admin
        // Include promotions with this store_id that belong to admin, or NULLf store_id created by admin
        querySql += ` AND (
          (p.store_id = ? AND EXISTS (SELECT 1 FROM stores WHERE id = ? AND admin_id = ?))
          OR (p.store_id IS NULL AND p.created_by = ?)  
        )`;
        params.push(parseInt(storeIdParam), parseInt(storeIdParam), req.user.id, req.user.id);   
      } else {
        // Show all stores owned by admin (including promotions with NULL store_id if created by this admin)
        // Use EXISTS to check store ownership instead of relying on LEFT JOIN
        querySql += ` AND (
          (p.store_id IS NOT NULL AND EXISTS (SELECT 1 FROM stores WHERE id = p.store_id AND admin_id = ?))
          OR (p.store_id IS NULL AND p.created_by = ?)
        )`;
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return empty
      return res.json({ data: [] });
    }

    if (status) {
      querySql += ' AND p.status = ?';
      params.push(status);
    }

    if (type) {
      querySql += ' AND p.type = ?';
      params.push(type);
    }

    querySql += ' ORDER BY p.created_at DESC';

    const promotions = await query(querySql, params);
    res.json({ data: promotions });
  } catch (error) {
    console.error('Get promotions error:', error);
    // KHÔNG forward error.message ra ngoài: lỗi DB thật (SQL/tên cột) sẽ lộ
    // cấu trúc nội bộ cho client — chỉ 1 mã lỗi biết trước (thiếu bảng) mới an toàn để show
    const errorMessage = error.code === 'ER_NO_SUCH_TABLE'
      ? 'Bảng promotions chưa được tạo. Vui lòng kiểm tra cơ sở dữ liệu.'
      : 'Lỗi máy chủ. Vui lòng thử lại.';
    res.status(500).json({ error: errorMessage });
  }
});

// Get single promotion
router.get('/:id', authorize('admin'), async (req, res) => {
  try {
    let querySql = `
      SELECT p.*, u.name as created_by_name, s.name as store_name
      FROM promotions p
      LEFT JOIN users u ON p.created_by = u.id
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id = ?
    `;
    const params = [req.params.id];

    // Filter by admin: khuyến mãi thuộc store trong chuỗi HOẶC khuyến mãi
    // toàn chuỗi (store_id NULL) do chính admin tạo — danh sách hiển thị cả 2
    // loại, thiếu vế sau thì bấm vào khuyến mãi NULL-store bị 404 vô lý
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      querySql += ' AND (s.admin_id = ? OR (p.store_id IS NULL AND p.created_by = ?))';
      params.push(req.user.id, req.user.id);
    } else if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return 404
      return res.status(404).json({ error: 'Promotion not found' });
    }

    const promotion = await queryOne(querySql, params);

    if (!promotion) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    res.json({ data: promotion });
  } catch (error) {
    console.error('Get promotion error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create promotion (Admin only)
router.post('/', authorize('admin'), auditLog('create', 'promotion'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - cannot create promotions
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể tạo khuyến mãi' });
    }

    const {
      name,
      description,
      type,
      min_order_count,
      min_bill_amount,
      discount_type,
      discount_value,
      max_discount_amount,
      start_date,
      end_date,
      status,
      store_id
    } = req.body;

    // Validate required fields
    const nameValidation = validateRequiredString(name, 'Tên khuyến mãi');
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }

    // Chỉ hỗ trợ khuyến mãi theo giá trị đơn hàng
    const typeValidation = validateEnum(type, ['bill_amount'], 'Loại khuyến mãi');
    if (!typeValidation.valid) {
      return res.status(400).json({ error: 'Chỉ hỗ trợ khuyến mãi theo giá trị đơn hàng' });
    }

    const discountTypeValidation = validateEnum(discount_type, ['percentage', 'fixed'], 'Loại giảm giá');
    if (!discountTypeValidation.valid) {
      return res.status(400).json({ error: discountTypeValidation.error });
    }

    // Validate discount_value
    const discountValueValidation = validatePositiveNumber(discount_value, false);
    if (!discountValueValidation.valid) {
      return res.status(400).json({ error: `Giá trị khuyến mãi: ${discountValueValidation.error}` });
    }

    // Validate percentage discount (must be <= 100)
    if (discount_type === 'percentage' && discountValueValidation.value > 100) {
      return res.status(400).json({ error: 'Phần trăm giảm giá không được vượt quá 100%' });
    }

    // Validate type-specific fields - chỉ hỗ trợ bill_amount
    if (min_bill_amount === undefined || min_bill_amount === null || min_bill_amount === '') {
      return res.status(400).json({ error: 'Giá trị đơn hàng tối thiểu là bắt buộc' });
    }
    const minBillAmountValidation = validatePositiveNumber(min_bill_amount, false);
    if (!minBillAmountValidation.valid) {
      return res.status(400).json({ error: `Giá trị đơn hàng tối thiểu: ${minBillAmountValidation.error}` });
    }

    // Validate dates
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'Ngày bắt đầu và ngày kết thúc là bắt buộc' });
    }

    const dateRangeValidation = validateDateRange(start_date, end_date);
    if (!dateRangeValidation.valid) {
      return res.status(400).json({ error: dateRangeValidation.error });
    }

    // Validate max_discount_amount if provided
    let maxDiscountAmount = null;
    if (max_discount_amount !== undefined && max_discount_amount !== null && max_discount_amount !== '') {
      const maxDiscountValidation = validatePositiveNumber(max_discount_amount, false);
      if (!maxDiscountValidation.valid) {
        return res.status(400).json({ error: `Mức giảm giá tối đa: ${maxDiscountValidation.error}` });
      }
      maxDiscountAmount = maxDiscountValidation.value;
    }

    // Determine store_id: use provided store_id or default to user's store_id
    let finalStoreId = store_id || req.user.store_id || null;

    // For admin, if no store_id provided, try to get first store owned by admin
    if (req.user.role === 'admin' && !finalStoreId) {
      const firstStore = await queryOne('SELECT id FROM stores WHERE admin_id = ? LIMIT 1', [req.user.id]);
      if (firstStore) {
        finalStoreId = firstStore.id;
      }
    }

    // For admin, verify store belongs to them
    if (req.user.role === 'admin' && finalStoreId) {
      const store = await queryOne('SELECT admin_id FROM stores WHERE id = ?', [finalStoreId]);
      if (!store) {
        return res.status(404).json({ error: 'Store not found' });
      }
      if (store.admin_id !== req.user.id) {
        return res.status(403).json({ error: 'Bạn chỉ có thể tạo khuyến mãi cho cửa hàng trong chuỗi của mình' });
      }
    }

    const descriptionSanitized = sanitizeString(description);
    const statusValidation = status ? validateEnum(status, ['active', 'inactive'], 'Trạng thái') : { valid: true, value: 'active' };

    const result = await execute(`
      INSERT INTO promotions (
        name, description, type, min_bill_amount,
        discount_type, discount_value, max_discount_amount,
        start_date, end_date, status, created_by, store_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      nameValidation.value,
      descriptionSanitized.value || null,
      'bill_amount',
      minBillAmountValidation.value,
      discountTypeValidation.value,
      discountValueValidation.value,
      maxDiscountAmount,
      start_date,
      end_date,
      statusValidation.value,
      req.user.id,
      finalStoreId
    ]);

    const newPromotion = await queryOne(`
      SELECT p.*, u.name as created_by_name
      FROM promotions p
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.id = ?
    `, [result.insertId]);

    res.status(201).json({ data: newPromotion });
  } catch (error) {
    console.error('Create promotion error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sql: error.sql,
      sqlMessage: error.sqlMessage
    });
    res.status(500).json({ 
      error: 'Server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update promotion (Admin only)
router.patch('/:id', authorize('admin'), auditLog('update', 'promotion'), async (req, res) => {
  try {
    const promotion = await queryOne(`
      SELECT p.*, s.admin_id as store_admin_id
      FROM promotions p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id = ?
    `, [req.params.id]);
    
    if (!promotion) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    // Root là vendor phần mềm — không sửa khuyến mãi của tenant (đồng bộ với
    // POST/DELETE; thiếu check này root sửa được khuyến mãi của mọi chuỗi)
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể sửa khuyến mãi' });
    }
    // Thuộc chuỗi của admin, HOẶC khuyến mãi toàn chuỗi (store_id NULL) do chính admin tạo
    const ownsPromotion = promotion.store_admin_id === req.user.id
      || (promotion.store_id === null && promotion.created_by === req.user.id);
    if (!ownsPromotion) {
      return res.status(403).json({ error: 'Bạn chỉ có thể sửa khuyến mãi trong chuỗi cửa hàng của mình' });
    }

    const {
      name,
      description,
      type,
      min_order_count,
      min_bill_amount,
      discount_type,
      discount_value,
      max_discount_amount,
      start_date,
      end_date,
      status,
      store_id
    } = req.body;

    const updates = [];
    const values = [];

    // store_id trước đây bị bỏ qua im lặng: form sửa có ô "Cửa hàng" nhưng đổi
    // gì backend cũng không lưu (báo "Cập nhật thành công" mà không đổi gì)
    if (store_id !== undefined) {
      if (store_id) {
        const store = await queryOne('SELECT id FROM stores WHERE id = ? AND admin_id = ?', [store_id, req.user.id]);
        if (!store) {
          return res.status(400).json({ error: 'Cửa hàng không hợp lệ hoặc không thuộc quyền quản lý của bạn' });
        }
      }
      updates.push('store_id = ?');
      values.push(store_id || null);
    }

    if (name !== undefined) {
      const nameValidation = validateRequiredString(name, 'Tên khuyến mãi');
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error });
      }
      updates.push('name = ?');
      values.push(nameValidation.value);
    }
    
    if (description !== undefined) {
      const descSanitized = sanitizeString(description);
      updates.push('description = ?');
      values.push(descSanitized.value || null);
    }
    
    // Type luôn là 'bill_amount', không cho phép thay đổi
    // Không còn hỗ trợ min_order_count
    
    if (min_bill_amount !== undefined) {
      if (min_bill_amount === null || min_bill_amount === '') {
        updates.push('min_bill_amount = ?');
        values.push(null);
      } else {
        const validation = validatePositiveNumber(min_bill_amount, false);
        if (!validation.valid) {
          return res.status(400).json({ error: `Giá trị đơn hàng tối thiểu: ${validation.error}` });
        }
        updates.push('min_bill_amount = ?');
        values.push(validation.value);
      }
    }
    
    if (discount_type !== undefined) {
      const validation = validateEnum(discount_type, ['percentage', 'fixed'], 'Loại giảm giá');
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      updates.push('discount_type = ?');
      values.push(validation.value);
    }
    
    if (discount_value !== undefined) {
      const validation = validatePositiveNumber(discount_value, false);
      if (!validation.valid) {
        return res.status(400).json({ error: `Giá trị khuyến mãi: ${validation.error}` });
      }
      
      // Validate percentage discount (must be <= 100). Use the INCOMING
      // discount_type when it is being changed in the same request — otherwise
      // switching fixed→percentage with a value >100 slips past the cap
      const effectiveType = discount_type !== undefined ? discount_type : promotion.discount_type;
      if (effectiveType === 'percentage' && validation.value > 100) {
        return res.status(400).json({ error: 'Phần trăm giảm giá không được vượt quá 100%' });
      }
      
      updates.push('discount_value = ?');
      values.push(validation.value);
    }
    
    if (max_discount_amount !== undefined) {
      if (max_discount_amount === null || max_discount_amount === '') {
        updates.push('max_discount_amount = ?');
        values.push(null);
      } else {
        const validation = validatePositiveNumber(max_discount_amount, false);
        if (!validation.valid) {
          return res.status(400).json({ error: `Mức giảm giá tối đa: ${validation.error}` });
        }
        updates.push('max_discount_amount = ?');
        values.push(validation.value);
      }
    }
    if (start_date !== undefined) {
      updates.push('start_date = ?');
      values.push(start_date);
    }
    
    if (end_date !== undefined) {
      updates.push('end_date = ?');
      values.push(end_date);
    }
    
    // Validate date range if both dates are being updated
    if (start_date !== undefined && end_date !== undefined) {
      const dateRangeValidation = validateDateRange(start_date, end_date);
      if (!dateRangeValidation.valid) {
        return res.status(400).json({ error: dateRangeValidation.error });
      }
    } else if (start_date !== undefined && promotion.end_date) {
      const dateRangeValidation = validateDateRange(start_date, promotion.end_date);
      if (!dateRangeValidation.valid) {
        return res.status(400).json({ error: dateRangeValidation.error });
      }
    } else if (end_date !== undefined && promotion.start_date) {
      const dateRangeValidation = validateDateRange(promotion.start_date, end_date);
      if (!dateRangeValidation.valid) {
        return res.status(400).json({ error: dateRangeValidation.error });
      }
    }
    
    if (status !== undefined) {
      const statusValidation = validateEnum(status, ['active', 'inactive'], 'Trạng thái');
      if (!statusValidation.valid) {
        return res.status(400).json({ error: statusValidation.error });
      }
      updates.push('status = ?');
      values.push(statusValidation.value);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }


    values.push(req.params.id);

    await execute(`
      UPDATE promotions
      SET ${updates.join(', ')}
      WHERE id = ?
    `, values);

    const updated = await queryOne(`
      SELECT p.*, u.name as created_by_name
      FROM promotions p
      LEFT JOIN users u ON p.created_by = u.id
      WHERE p.id = ?
    `, [req.params.id]);

    res.json({ data: updated });
  } catch (error) {
    console.error('Update promotion error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete promotion (Admin only)
router.delete('/:id', authorize('admin'), auditLog('delete', 'promotion'), async (req, res) => {
  try {
    const promotion = await queryOne(`
      SELECT p.id, p.store_id, p.created_by, s.admin_id as store_admin_id
      FROM promotions p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.id = ?
    `, [req.params.id]);
    
    if (!promotion) {
      return res.status(404).json({ error: 'Promotion not found' });
    }

    // Root admin is software vendor, not store operator - cannot delete promotions
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xóa khuyến mãi' });
    }

    // For admin, verify promotion belongs to their store chain
    if (req.user.role === 'admin') {
      // If promotion has store_id, check if store belongs to admin
      if (promotion.store_id) {
        if (promotion.store_admin_id !== req.user.id) {
          return res.status(403).json({ error: 'Bạn chỉ có thể xóa khuyến mãi trong chuỗi cửa hàng của mình' });
        }
      } else {
        // If promotion has no store_id, check if it was created by this admin
        if (promotion.created_by !== req.user.id) {
          return res.status(403).json({ error: 'Bạn chỉ có thể xóa khuyến mãi trong chuỗi cửa hàng của mình' });
        }
      }
    }

    // Quy ước: "Xóa" = chỉ đổi sang inactive, không DELETE để giữ lịch sử đơn hàng và báo cáo
    await execute('UPDATE promotions SET status = ? WHERE id = ?', ['inactive', req.params.id]);
    return res.json({
      message: 'Đã ngừng áp dụng khuyến mãi. Khuyến mãi được ẩn khỏi danh sách chọn khi tạo đơn.',
      action: 'deactivated'
    });
  } catch (error) {
    console.error('Delete promotion error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get applicable promotions for a customer/order
router.post('/applicable', async (req, res) => {
  try {
    const { customer_id, customer_phone, bill_amount, store_id } = req.body;

    // Root admin is software vendor, not store operator - return empty
    if (req.user && req.user.role === 'root') {
      return res.json({ data: [] });
    }

    // Get customer order count (optional - if no customer info, use 0)
    let customer = null;
    let orderCount = 0;
    
    if (customer_id) {
      customer = await queryOne('SELECT total_orders FROM customers WHERE id = ?', [customer_id]);
      orderCount = customer?.total_orders || 0;
    } else {
      const ph = normalizeCustomerPhoneForIdentity(customer_phone);
      if (ph) {
        customer = await queryOne('SELECT total_orders FROM customers WHERE phone = ?', [ph]);
        orderCount = customer?.total_orders || 0;
      }
    }
    // If no customer info provided, orderCount remains 0
    // Ngày theo giờ VN (UTC+7) — toISOString thuần là ngày UTC: từ 0h đến 7h
    // sáng VN vẫn là "hôm qua", khuyến mãi bắt đầu hôm nay không hiện còn
    // khuyến mãi đã hết hạn hôm qua vẫn được áp
    const now = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Build query with store filter if provided
    let querySql = `
      SELECT p.*
      FROM promotions p
      LEFT JOIN stores s ON p.store_id = s.id
      WHERE p.status = 'active'
        AND DATE(p.start_date) <= ?
        AND DATE(p.end_date) >= ?
        AND p.type = 'bill_amount'
        AND p.min_bill_amount <= ?
    `;
    const params = [now, now, bill_amount || 0];

    // Determine effective store filter to prevent cross-store data leakage
    let effectiveStoreId = null;
    if (req.user && req.user.role === 'employer') {
      // Employer: always use their own store_id from token (ignore request store_id)
      effectiveStoreId = req.user.store_id || null;
    } else if (req.user && req.user.role === 'admin') {
      if (store_id) {
        // Admin: validate selected store belongs to admin before filtering
        const store = await queryOne('SELECT id FROM stores WHERE id = ? AND admin_id = ?', [parseInt(store_id), req.user.id]);
        if (!store) {
          return res.status(403).json({ error: 'Bạn không có quyền xem khuyến mãi của cửa hàng này' });
        }
        effectiveStoreId = parseInt(store_id);
      } else {
        // Admin without explicit store filter: only show promotions from their stores or global
        querySql += ' AND (s.admin_id = ? OR p.store_id IS NULL)';
        params.push(req.user.id);
      }
    } else if (store_id) {
      // Fallback (should be rare): allow explicit store filter for non-admin/employer roles
      effectiveStoreId = parseInt(store_id);
    }

    if (effectiveStoreId) {
      querySql += ' AND (p.store_id = ? OR p.store_id IS NULL)';
      params.push(effectiveStoreId);
    } else if (req.user && req.user.role === 'employer') {
      // Employer without store_id: only global promotions
      querySql += ' AND p.store_id IS NULL';
    }

    querySql += ` ORDER BY p.min_bill_amount DESC`;

    const promotions = await query(querySql, params);

    res.json({ data: promotions });
  } catch (error) {
    console.error('Get applicable promotions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
