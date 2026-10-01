import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { sanitizeString, validateRequiredString } from '../utils/validators.js';
import { normalizeCustomerPhoneForIdentity } from '../utils/helpers.js';
import { resolveCurrentStoreId } from '../services/workingStoreService.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Khách "thuộc phạm vi" người gọi khi có ít nhất 1 đơn trong chuỗi (admin)
// hoặc tại tiệm (employer/nhân viên). Root là vendor phần mềm — không xem khách.
// Thiếu check này thì tài khoản tiệm A dò id/SĐT đọc và SỬA được khách của tiệm B.
async function customerVisibleToActor(customerId, user) {
  if (user.role === 'root') return false;
  if (user.role === 'admin') {
    const row = await queryOne(`
      SELECT 1 FROM orders o
      WHERE o.customer_id = ?
        AND (
          (o.store_id IN (SELECT id FROM stores WHERE admin_id = ?))
          OR (o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
            OR o.created_by IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
          ))
        )
      LIMIT 1
    `, [customerId, user.id, user.id, user.id]);
    return Boolean(row);
  }
  // employer / employee_login (token role vẫn là 'employer') — scope theo cửa
  // hàng của tài khoản, cùng một nguồn với GET / (resolveCurrentStoreId) để
  // list và chi tiết không lệch nhau.
  const currentStoreId = await resolveCurrentStoreId(user);
  if (currentStoreId) {
    const row = await queryOne(`
      SELECT 1 FROM orders o
      WHERE o.customer_id = ?
        AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )
      LIMIT 1
    `, [customerId, currentStoreId, user.id, user.id]);
    return Boolean(row);
  }
  const row = await queryOne(
    'SELECT 1 FROM orders o WHERE o.customer_id = ? AND (o.assigned_to = ? OR o.created_by = ?) LIMIT 1',
    [customerId, user.id, user.id]
  );
  return Boolean(row);
}

// Get all customers
router.get('/', async (req, res) => {
  try {
    const { phone, search } = req.query;
    
    // For admin, only show customers who have orders from their store
    // For employer, only show customers who have orders from their store
    let querySql = '';
    const params = [];

    if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return empty
      return res.json({ data: [] });
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      // Admin: only customers with orders from stores in their chain
      // Validate store_id from query - chỉ chấp nhận cửa hàng thuộc chuỗi của admin
      const storeIdParam = req.query.store_id;
      let effectiveStoreId = null;
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [parseInt(storeIdParam), req.user.id]);
        if (store) effectiveStoreId = parseInt(storeIdParam);
      }
      if (effectiveStoreId) {
        querySql = `
          SELECT DISTINCT c.*
          FROM customers c
          INNER JOIN orders o ON c.id = o.customer_id
          WHERE o.store_id = ?
        `;
        params.push(effectiveStoreId);
      } else {
        querySql = `
          SELECT DISTINCT c.*
          FROM customers c
          INNER JOIN orders o ON c.id = o.customer_id
          WHERE o.store_id IN (SELECT id FROM stores WHERE admin_id = ?)
        `;
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      // Employer: only customers with orders from the account's store
      const currentStoreId = await resolveCurrentStoreId(req.user);
      if (currentStoreId) {
        querySql = `
          SELECT DISTINCT c.*
          FROM customers c
          INNER JOIN orders o ON c.id = o.customer_id
          WHERE o.store_id = ?
        `;
        params.push(currentStoreId);
      } else {
        // Fallback: filter by user id if no store_id
        querySql = `
          SELECT DISTINCT c.*
          FROM customers c
          INNER JOIN orders o ON c.id = o.customer_id
          WHERE (o.assigned_to = ? OR o.created_by = ?)
        `;
        params.push(req.user.id, req.user.id);
      }
    } else {
      // Fallback (should not happen)
      querySql = 'SELECT c.* FROM customers c WHERE 1=1';
    }

    if (phone) {
      querySql += ' AND c.phone LIKE ?';
      params.push(`%${phone}%`);
    }

    if (search) {
      querySql += ' AND (c.name LIKE ? OR c.phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // summary=true: chỉ đếm (thẻ "Tổng khách hàng" trên Dashboard) — trước đây
    // tải cả danh sách khách chỉ để lấy .length
    if (req.query.summary === '1' || req.query.summary === 'true') {
      const countSql = querySql.replace(/^\s*SELECT (DISTINCT )?c\.\*/, 'SELECT COUNT(DISTINCT c.id) AS count');
      const row = await queryOne(countSql, params);
      return res.json({ summary: { count: Number(row?.count || 0) } });
    }

    querySql += ' ORDER BY c.total_spent DESC, c.created_at DESC';
    
    // LIMIT chỉ áp khi client yêu cầu (autocomplete gửi limit=10, max 50).
    // Trước đây mặc định LIMIT 20 cho MỌI request — trang Khách hàng và số
    // "Tổng khách" trên Dashboard không bao giờ vượt quá 20 dù có hàng trăm khách
    const requestedLimit = parseInt(req.query.limit);
    if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
      querySql += ` LIMIT ${Math.min(requestedLimit, 50)}`;
    }

    const customers = await query(querySql, params);
    res.json({ data: customers });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get customer by phone (for auto-fill in order form)
router.get('/by-phone/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const identityPhone = normalizeCustomerPhoneForIdentity(phone);
    if (!identityPhone) {
      return res.json({ data: null });
    }

    const customer = await queryOne('SELECT id, name, phone, total_orders, total_spent FROM customers WHERE phone = ?', [identityPhone]);

    if (!customer) {
      return res.json({ data: null });
    }

    // Chỉ trả về khách trong phạm vi của người gọi (admin: chuỗi; employer: tiệm)
    if (!(await customerVisibleToActor(customer.id, req.user))) {
      return res.json({ data: null });
    }

    res.json({ data: customer });
  } catch (error) {
    console.error('Get customer by phone error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single customer
router.get('/:id', async (req, res) => {
  try {
    const customer = await queryOne('SELECT * FROM customers WHERE id = ?', [req.params.id]);

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Scope theo người gọi (admin: chuỗi; employer/nhân viên: tiệm; root: không xem)
    if (!(await customerVisibleToActor(customer.id, req.user))) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ data: customer });
  } catch (error) {
    console.error('Get customer error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get customer orders
router.get('/:id/orders', async (req, res) => {
  try {
    let querySql = `
      SELECT o.*, u.name as assigned_to_name
      FROM orders o
      LEFT JOIN users u ON o.assigned_to = u.id
      WHERE o.customer_id = ?
    `;
    const params = [req.params.id];

    // Filter by store based on user role
    if (req.user.role === 'employer') {
      const currentStoreId = await resolveCurrentStoreId(req.user);
      if (currentStoreId) {
        querySql += ' AND o.store_id = ?';
        params.push(currentStoreId);
      } else {
        // Không resolve được cửa hàng đang làm việc (vd tài khoản mất
        // store_id gốc) — PHẢI vẫn giới hạn theo chính actor này, không được
        // để WHERE o.customer_id = ? trần trụi lộ lịch sử đơn của KHÁCH HÀNG
        // ĐÓ ở MỌI tenant trong hệ thống (cùng luật fallback với GET / ở trên).
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      querySql += ' AND o.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
      params.push(req.user.id);
    } else if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return empty
      return res.json({ data: [] });
    }

    querySql += ' ORDER BY o.created_at DESC';

    const orders = await query(querySql, params);
    res.json({ data: orders });
  } catch (error) {
    console.error('Get customer orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create or update customer
router.post('/', async (req, res) => {
  try {
    const { name, phone, note } = req.body;

    // Validate phone
    const phoneValidation = validateRequiredString(phone, 'Số điện thoại');
    if (!phoneValidation.valid) {
      return res.status(400).json({ error: phoneValidation.error });
    }
    // Chuẩn hóa như luồng tạo đơn — nhận chuỗi bất kỳ (kể cả "0" placeholder)
    // sẽ ghi đè khách chung/phá định danh theo SĐT
    const identityPhone = normalizeCustomerPhoneForIdentity(phoneValidation.value);
    if (!identityPhone) {
      return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
    }

    // Sanitize name and note
    const nameSanitized = sanitizeString(name);
    const noteSanitized = sanitizeString(note);

    // Check if customer exists
    const existing = await queryOne('SELECT * FROM customers WHERE phone = ?', [identityPhone]);

    if (existing) {
      // customers là bảng DÙNG CHUNG toàn hệ thống (khóa theo SĐT, không có
      // store_id/admin_id) — nếu khách này chưa từng có đơn trong phạm vi của
      // actor thì KHÔNG được ghi đè tên/note: PATCH /:id đã chặn việc này,
      // POST (upsert) trước đây bỏ sót cùng lỗ hổng — tenant B gửi đúng SĐT
      // của khách tenant A là sửa được thông tin khách của A.
      if (!(await customerVisibleToActor(existing.id, req.user))) {
        return res.json({ data: existing });
      }

      // Update existing
      const updates = [];
      const values = [];

      if (name !== undefined) {
        updates.push('name = ?');
        values.push(nameSanitized.value);
      }
      if (note !== undefined) {
        updates.push('note = ?');
        values.push(noteSanitized.value || null);
      }
      
      if (updates.length === 0) {
        return res.json({ data: existing });
      }
      
      // MySQL handles updated_at automatically
      values.push(existing.id);

      await execute(`
        UPDATE customers
        SET ${updates.join(', ')}
        WHERE id = ?
      `, values);

      const updated = await queryOne('SELECT * FROM customers WHERE id = ?', [existing.id]);
      return res.json({ data: updated });
    } else {
      // Create new
      const result = await execute(`
        INSERT INTO customers (name, phone, note)
        VALUES (?, ?, ?)
      `, [nameSanitized.value, identityPhone, noteSanitized.value || null]);

      const newCustomer = await queryOne('SELECT * FROM customers WHERE id = ?', [result.insertId]);
      return res.status(201).json({ data: newCustomer });
    }
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update customer
router.patch('/:id', async (req, res) => {
  try {
    const { name, phone, note } = req.body;

    const customer = await queryOne('SELECT id, phone FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // PATCH trước đây KHÔNG có scope — bất kỳ tài khoản nào cũng sửa được
    // khách của tenant khác (đổi SĐT phá luôn định danh + thông báo Zalo của họ)
    if (!(await customerVisibleToActor(customer.id, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền sửa khách hàng này' });
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      const nameSanitized = sanitizeString(name);
      updates.push('name = ?');
      values.push(nameSanitized.value);
    }
    
    if (phone !== undefined) {
      const phoneValidation = validateRequiredString(phone, 'Số điện thoại');
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: phoneValidation.error });
      }
      // Chuẩn hóa như luồng tạo đơn — nhận chuỗi bất kỳ sẽ phá định danh theo SĐT
      const identityPhone = normalizeCustomerPhoneForIdentity(phoneValidation.value);
      if (!identityPhone) {
        return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
      }

      // Check phone uniqueness (except current customer)
      if (identityPhone !== customer.phone) {
        const existing = await queryOne('SELECT id FROM customers WHERE phone = ? AND id != ?', [identityPhone, req.params.id]);
        if (existing) {
          return res.status(400).json({ error: 'Số điện thoại đã được sử dụng bởi khách hàng khác' });
        }
      }

      updates.push('phone = ?');
      values.push(identityPhone);
    }
    
    if (note !== undefined) {
      const noteSanitized = sanitizeString(note);
      updates.push('note = ?');
      values.push(noteSanitized.value || null);
    }
    
    if (updates.length === 0) {
      const current = await queryOne('SELECT * FROM customers WHERE id = ?', [req.params.id]);
      return res.json({ data: current });
    }
    
    // MySQL handles updated_at automatically
    values.push(req.params.id);

    await execute(`
      UPDATE customers
      SET ${updates.join(', ')}
      WHERE id = ?
    `, values);

    const updated = await queryOne('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    res.json({ data: updated });
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
