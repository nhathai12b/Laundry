import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { sanitizeString, validateRequiredString } from '../utils/validators.js';
import { normalizeCustomerPhoneForIdentity } from '../utils/helpers.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * Kiểm tra user hiện tại có quyền truy cập khách hàng này không (dựa trên đơn
 * hàng thuộc chuỗi/cửa hàng của họ). Dùng chung cho GET/PATCH để tránh IDOR -
 * PATCH trước đây không kiểm tra gì, cho phép sửa khách hàng của chuỗi khác.
 */
async function canAccessCustomer(req, customerId) {
  if (req.user.role === 'root') {
    return false;
  }
  if (req.user.role === 'admin') {
    const hasOrderInChain = await queryOne(`
      SELECT 1 FROM orders o
      WHERE o.customer_id = ?
        AND (
          (o.store_id IN (SELECT id FROM stores WHERE admin_id = ?))
          OR (o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
            OR o.created_by IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
          ))
        )
    `, [customerId, req.user.id, req.user.id, req.user.id]);
    return !!hasOrderInChain;
  }
  if (req.user.role === 'employer') {
    const hasAccess = req.user.store_id
      ? await queryOne(
          `SELECT 1 FROM orders o WHERE o.customer_id = ? AND o.store_id = ? LIMIT 1`,
          [customerId, req.user.store_id]
        )
      : await queryOne(
          `SELECT 1 FROM orders o WHERE o.customer_id = ? AND (o.assigned_to = ? OR o.created_by = ?) LIMIT 1`,
          [customerId, req.user.id, req.user.id]
        );
    return !!hasAccess;
  }
  return false;
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
      // Employer: only customers with orders from their store
      // Use o.store_id (stores.id) to filter orders
      if (req.user.store_id) {
        querySql = `
          SELECT DISTINCT c.*
          FROM customers c
          INNER JOIN orders o ON c.id = o.customer_id
          WHERE o.store_id = ?
        `;
        params.push(req.user.store_id);
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

    querySql += ' ORDER BY c.total_spent DESC, c.created_at DESC';
    
    // Add limit for autocomplete (default 20, max 50)
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    querySql += ` LIMIT ${limit}`;

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

    // Admin chuỗi: chỉ trả về khách nếu khách có đơn tại cửa hàng trong chuỗi của admin
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      const hasOrderInChain = await queryOne(`
        SELECT 1 FROM orders o
        WHERE o.customer_id = ?
          AND (
            (o.store_id IN (SELECT id FROM stores WHERE admin_id = ?))
            OR (o.store_id IS NULL AND (
              o.assigned_to IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
              OR o.created_by IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
            ))
          )
      `, [customer.id, req.user.id, req.user.id, req.user.id]);
      if (!hasOrderInChain) {
        return res.json({ data: null });
      }
    } else if (req.user.role === 'employer') {
      const hasAccess = req.user.store_id
        ? await queryOne(
            `SELECT 1 FROM orders o WHERE o.customer_id = ? AND o.store_id = ? LIMIT 1`,
            [customer.id, req.user.store_id]
          )
        : await queryOne(
            `SELECT 1 FROM orders o WHERE o.customer_id = ? AND (o.assigned_to = ? OR o.created_by = ?) LIMIT 1`,
            [customer.id, req.user.id, req.user.id]
          );
      if (!hasAccess) {
        return res.json({ data: null });
      }
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

    // Admin chuỗi: chỉ trả về khách nếu khách có đơn tại cửa hàng trong chuỗi của admin
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      const hasOrderInChain = await queryOne(`
        SELECT 1 FROM orders o
        WHERE o.customer_id = ?
          AND (
            (o.store_id IN (SELECT id FROM stores WHERE admin_id = ?))
            OR (o.store_id IS NULL AND (
              o.assigned_to IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
              OR o.created_by IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
            ))
          )
      `, [customer.id, req.user.id, req.user.id, req.user.id]);
      if (!hasOrderInChain) {
        return res.status(404).json({ error: 'Customer not found' });
      }
    } else if (req.user.role === 'root') {
      return res.status(404).json({ error: 'Customer not found' });
    } else if (req.user.role === 'employer') {
      const hasAccess = req.user.store_id
        ? await queryOne(
            `SELECT 1 FROM orders o WHERE o.customer_id = ? AND o.store_id = ? LIMIT 1`,
            [customer.id, req.user.store_id]
          )
        : await queryOne(
            `SELECT 1 FROM orders o WHERE o.customer_id = ? AND (o.assigned_to = ? OR o.created_by = ?) LIMIT 1`,
            [customer.id, req.user.id, req.user.id]
          );
      if (!hasAccess) {
        return res.status(404).json({ error: 'Customer not found' });
      }
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
    if (req.user.role === 'employer' && req.user.store_id) {
      querySql += ' AND (o.store_id = ? OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?)))';
      params.push(req.user.store_id, req.user.id, req.user.id);
    } else if (req.user.role === 'employer') {
      // No store_id resolved for this employer - fall back to their own
      // orders instead of leaving the query unscoped (would leak every
      // store's orders for this customer).
      querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
      params.push(req.user.id, req.user.id);
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      querySql += ` AND (
        (o.store_id IS NOT NULL AND o.store_id IN (SELECT id FROM stores WHERE admin_id = ?))
        OR (
          o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
            OR o.created_by IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
          )
        )
      )`;
      params.push(req.user.id, req.user.id, req.user.id);
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

    // Sanitize name and note
    const nameSanitized = sanitizeString(name);
    const noteSanitized = sanitizeString(note);

    // Check if customer exists
    const existing = await queryOne('SELECT * FROM customers WHERE phone = ?', [phoneValidation.value]);

    if (existing) {
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
      `, [nameSanitized.value, phoneValidation.value, noteSanitized.value || null]);

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

    // Without this check, anyone could edit/overwrite any other store's
    // customer by guessing an id (IDOR) - GET already enforced this, PATCH did not.
    const hasAccess = await canAccessCustomer(req, customer.id);
    if (!hasAccess) {
      return res.status(404).json({ error: 'Customer not found' });
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
      
      // Check phone uniqueness (except current customer)
      if (phoneValidation.value !== customer.phone) {
        const existing = await queryOne('SELECT id FROM customers WHERE phone = ? AND id != ?', [phoneValidation.value, req.params.id]);
        if (existing) {
          return res.status(400).json({ error: 'Số điện thoại đã được sử dụng bởi khách hàng khác' });
        }
      }
      
      updates.push('phone = ?');
      values.push(phoneValidation.value);
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
