import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { generateOrderCode, normalizeCustomerPhoneForIdentity } from '../utils/helpers.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get all orders
router.get('/', async (req, res) => {
  try {
    const { status, assigned_to, customer_phone, my_orders, date, store_id, debt_only } = req.query;
    let querySql = `
      SELECT o.*, 
        c.name as customer_name, 
        c.phone as customer_phone,
        u.name as assigned_to_name,
        creator.name as created_by_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users creator ON o.created_by = creator.id
      WHERE 1=1
    `;
    const params = [];

    // For employer, filter by store_id (their own store)
    if (req.user.role === 'employer') {
      // Use store_id from user (stores.id) to filter orders
      if (req.user.store_id) {
        querySql += ' AND o.store_id = ?';
        params.push(req.user.store_id);
      } else {
        // Fallback: filter by user id if no store_id
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    }

    // For admin (not root), filter by stores owned by this admin
    // Support store_id from query param for filtering
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      if (store_id && store_id !== 'all') {
        // Filter by specific store (must belong to admin)
        // Prefer o.store_id (stores.id). Fallback to legacy matching if o.store_id is NULL.
        querySql += ` AND (
          (o.store_id = ? AND EXISTS (SELECT 1 FROM stores WHERE id = ? AND admin_id = ?))
          OR (
            o.store_id IS NULL AND (
              o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
              OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
            )
          )
        )`;
        params.push(
          parseInt(store_id),
          parseInt(store_id),
          req.user.id,
          parseInt(store_id),
          parseInt(store_id)
        );
      } else {
        // Show all stores owned by admin
        // Prefer o.store_id (stores.id). Fallback to legacy matching if o.store_id is NULL.
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
      }
    } else if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return empty
      return res.json({ data: [] });
    }

    if (my_orders === 'true' && req.user.role === 'employer') {
      querySql += ' AND o.assigned_to = ?';
      params.push(req.user.id);
    }

    if (status) {
      querySql += ' AND o.status = ?';
      params.push(status);
    }

    if (assigned_to) {
      querySql += ' AND o.assigned_to = ?';
      params.push(assigned_to);
    }

    if (customer_phone) {
      querySql += ' AND c.phone LIKE ?';
      params.push(`%${customer_phone}%`);
    }

    // Filter by date (YYYY-MM-DD format)
    if (date) {
      querySql += ' AND DATE(o.created_at) = ?';
      params.push(date);
    }

    // Ghi nợ: debt_only=1 => chỉ đơn đã đánh dấu ghi nợ (is_debt=1). Đơn mới tạo luôn is_debt=0, không hiện tab Ghi nợ.
    if (debt_only === '1' || debt_only === 'true') {
      querySql += ' AND COALESCE(o.is_debt, 0) = 1';
    } else {
      querySql += ' AND (o.is_debt = 0 OR o.is_debt IS NULL)';
    }

    // Filter by date range (for month view)
    const { start_date, end_date } = req.query;
    if (start_date && end_date) {
      querySql += ' AND DATE(o.created_at) >= ? AND DATE(o.created_at) <= ?';
      params.push(start_date, end_date);
    }

    querySql += ' ORDER BY o.created_at DESC';

    const orders = await query(querySql, params);

    // Batch query order items to avoid N+1 problem
    if (orders.length === 0) {
      return res.json({ data: [] });
    }

    const orderIds = orders.map(o => o.id);
    const placeholders = orderIds.map(() => '?').join(',');
    const allItems = await query(`
      SELECT oi.*, p.name as product_name, p.unit as product_unit
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id IN (${placeholders})
      ORDER BY oi.order_id, oi.id
    `, orderIds);

    // Group items by order_id
    const itemsByOrder = {};
    allItems.forEach(item => {
      if (!itemsByOrder[item.order_id]) {
        itemsByOrder[item.order_id] = [];
      }
      itemsByOrder[item.order_id].push(item);
    });

    // Combine orders with their items
    const ordersWithItems = orders.map(order => ({
      ...order,
      items: itemsByOrder[order.id] || []
    }));

    res.json({ data: ordersWithItems });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single order
router.get('/:id', async (req, res) => {
  try {
    let querySql = `
      SELECT o.*, 
        c.name as customer_name, 
        c.phone as customer_phone,
        u.name as assigned_to_name,
        creator.name as created_by_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users creator ON o.created_by = creator.id
      WHERE o.id = ?
    `;
    const params = [req.params.id];

    // For admin, verify order belongs to selected store
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      // Prefer o.store_id (stores.id). Fallback to legacy matching if o.store_id is NULL.
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
      // Root admin is software vendor, not store operator - return 404
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = await queryOne(querySql, params);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = await query(`
      SELECT oi.*, p.name as product_name, p.unit as product_unit
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [order.id]);

    const statusHistory = await query(`
      SELECT osh.*, u.name as changed_by_name
      FROM order_status_history osh
      LEFT JOIN users u ON osh.changed_by = u.id
      WHERE osh.order_id = ?
      ORDER BY osh.created_at DESC
    `, [order.id]);

    res.json({ data: { ...order, items, statusHistory } });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create order
router.post('/', auditLog('create', 'order'), async (req, res) => {
  try {
    const { customer_name, customer_phone, items, note, assigned_to, promotion_id } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Items are required' });
    }

    const identityPhone = normalizeCustomerPhoneForIdentity(customer_phone);

    // Use transaction for atomicity
    const result = await transaction(async (db) => {
      // Get or create customer
      let customer = null;
      
      if (identityPhone) {
        customer = await db.queryOne('SELECT * FROM customers WHERE phone = ?', [identityPhone]);
        
        if (!customer) {
          const customerResult = await db.execute(`
            INSERT INTO customers (name, phone)
            VALUES (?, ?)
          `, [customer_name || '', identityPhone]);
          customer = await db.queryOne('SELECT * FROM customers WHERE id = ?', [customerResult.insertId]);
        } else if (customer_name && customer.name !== customer_name) {
          await db.execute('UPDATE customers SET name = ? WHERE id = ?', [customer_name, customer.id]);
          customer.name = customer_name;
        }
      } else {
        // If no phone, create customer with unique temporary phone
        const tempPhone = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const customerResult = await db.execute(`
          INSERT INTO customers (name, phone)
          VALUES (?, ?)
        `, [customer_name || 'Khách vãng lai', tempPhone]);
        customer = await db.queryOne('SELECT * FROM customers WHERE id = ?', [customerResult.insertId]);
      }

      // Generate order code
      const code = await generateOrderCode();

      // Calculate total
      let total = 0;
      const orderItems = [];

      for (const item of items) {
        // Validate product_id
        if (!item.product_id) {
          throw new Error('Product ID is required for all items');
        }

        // Validate quantity
        const quantity = parseFloat(item.quantity);
        if (isNaN(quantity) || !isFinite(quantity) || quantity <= 0) {
          throw new Error(`Số lượng phải là số dương hợp lệ (item product_id: ${item.product_id})`);
        }

        // Get product and validate it exists and is active
        const product = await db.queryOne('SELECT * FROM products WHERE id = ? AND status = ?', [item.product_id, 'active']);
        if (!product) {
          throw new Error(`Sản phẩm ${item.product_id} không tồn tại hoặc đã bị vô hiệu hóa`);
        }

        const itemTotal = product.price * quantity;
        if (!isFinite(itemTotal) || itemTotal < 0) {
          throw new Error(`Tính toán giá trị đơn hàng không hợp lệ cho sản phẩm ${product.name}`);
        }

        total += itemTotal;
        orderItems.push({
          product_id: product.id,
          quantity: quantity,
          unit_price: product.price,
          note: item.note ? item.note.trim() : null
        });
      }

      // Calculate discount if promotion is applied
      // Note: orderStoreId will be determined later, so we'll validate promotion after store_id is determined
      let discountAmount = 0;
      let finalAmount = total;
      let finalPromotionId = null;
      let promotionValidated = false;
      if (promotion_id) {
        const promotionIdInt = parseInt(promotion_id);
        if (isNaN(promotionIdInt)) {
          throw new Error('Invalid promotion_id');
        }
        // Initial promotion fetch - will validate store_id later
        const promotion = await db.queryOne('SELECT * FROM promotions WHERE id = ? AND status = "active"', [promotionIdInt]);
        if (promotion) {
          const now = new Date();
          const startDate = new Date(promotion.start_date);
          const endDate = new Date(promotion.end_date);
          
          // Check if promotion is active by date
          if (now >= startDate && now <= endDate) {
            // Check if customer meets promotion criteria
            const orderCount = customer.total_orders || 0;
            // Chỉ hỗ trợ khuyến mãi theo giá trị đơn hàng
            if (promotion.type === 'bill_amount' && promotion.min_bill_amount <= total) {
              // Store promotion for later validation after store_id is determined
              promotionValidated = true;
              finalPromotionId = promotion.id;
              
              // Calculate discount
              if (promotion.discount_type === 'percentage') {
                discountAmount = (total * promotion.discount_value) / 100;
                if (promotion.max_discount_amount && discountAmount > promotion.max_discount_amount) {
                  discountAmount = promotion.max_discount_amount;
                }
              } else {
                discountAmount = promotion.discount_value;
              }
              
              finalAmount = total - discountAmount;
              if (finalAmount < 0) finalAmount = 0;
            }
          }
        }
      }

      // Auto-assign to creator if employer and no assigned_to
      // For admin, verify assigned_to belongs to their store chain
      let finalAssignedTo = assigned_to;
      if (req.user.role === 'admin' && req.user.role !== 'root') {
        // If assigned_to is provided, verify it belongs to admin's store chain
        if (assigned_to) {
          const assignedUser = await db.queryOne(`
            SELECT u.id 
            FROM users u
            INNER JOIN stores s ON u.store_id = s.id
            WHERE u.id = ? AND s.admin_id = ?
          `, [assigned_to, req.user.id]);
          
          if (!assignedUser) {
            return res.status(403).json({ error: 'Bạn chỉ có thể gán đơn hàng cho nhân viên trong chuỗi cửa hàng của mình' });
          }
        }
        // If no assigned_to, find an employer user from the store
        if (!finalAssignedTo && req.user.store_id) {
          const employerUser = await db.queryOne(
            'SELECT id FROM users WHERE store_id = ? AND role = ? LIMIT 1',
            [req.user.store_id, 'employer']
          );
          if (employerUser) {
            finalAssignedTo = employerUser.id;
          }
        }
      } else if (!finalAssignedTo && req.user.role === 'employer') {
        finalAssignedTo = req.user.id;
      }

      // Get store_id for the order
      let orderStoreId = null;
      if (finalAssignedTo) {
        const assignedUser = await db.queryOne('SELECT store_id FROM users WHERE id = ?', [finalAssignedTo]);
        if (assignedUser && assignedUser.store_id) {
          orderStoreId = assignedUser.store_id;
        }
      }
      if (!orderStoreId && req.user.store_id) {
        orderStoreId = req.user.store_id;
      }

      // Validate promotion belongs to the store (after store_id is determined)
      if (promotionValidated && finalPromotionId) {
        let promotionQuery = 'SELECT * FROM promotions WHERE id = ?';
        const promotionParams = [finalPromotionId];
        
        if (orderStoreId) {
          // If store_id is known, check if promotion belongs to this store or is global (NULL)
          promotionQuery += ' AND (store_id = ? OR store_id IS NULL)';
          promotionParams.push(orderStoreId);
        } else {
          // If no store_id, only allow global promotions (store_id IS NULL)
          promotionQuery += ' AND store_id IS NULL';
        }
        
        const promotion = await db.queryOne(promotionQuery, promotionParams);
        if (!promotion) {
          // Promotion doesn't belong to this store, reset promotion
          finalPromotionId = null;
          discountAmount = 0;
          finalAmount = total;
        }
      }

      // Create order - is_debt=0 để đơn mới không xuất hiện trong tab Ghi nợ
      const orderResult = await db.execute(`
        INSERT INTO orders (customer_id, code, status, assigned_to, note, total_amount, discount_amount, final_amount, promotion_id, store_id, created_by, is_debt)
        VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `, [
        customer.id,
        code,
        finalAssignedTo || null,
        note || null,
        total,
        discountAmount,
        finalAmount,
        finalPromotionId,
        orderStoreId,
        req.user.id
      ]);

      const orderId = orderResult.insertId;

      // Create order items
      for (const item of orderItems) {
        await db.execute(`
          INSERT INTO order_items (order_id, product_id, quantity, unit_price, note)
          VALUES (?, ?, ?, ?, ?)
        `, [orderId, item.product_id, item.quantity, item.unit_price, item.note]);
      }

      // Add status history
      await db.execute(`
        INSERT INTO order_status_history (order_id, status, changed_by)
        VALUES (?, 'created', ?)
      `, [orderId, req.user.id]);

      // Update customer stats (use final_amount for total_spent)
      await db.execute(`
        UPDATE customers
        SET total_orders = total_orders + 1,
            total_spent = total_spent + ?
        WHERE id = ?
      `, [finalAmount, customer.id]);

      return orderId;
    });

    const newOrder = await queryOne(`
      SELECT o.*, 
        c.name as customer_name, 
        c.phone as customer_phone,
        u.name as assigned_to_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.assigned_to = u.id
      WHERE o.id = ?
    `, [result]);

    const orderItemsWithProduct = await query(`
      SELECT oi.*, p.name as product_name, p.unit as product_unit
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [result]);

    res.status(201).json({ data: { ...newOrder, items: orderItemsWithProduct } });
  } catch (error) {
    console.error('Create order error:', error);
    const errorMessage = error.message || 'Server error';
    res.status(500).json({ error: errorMessage });
  }
});

// Mark order as debt (ghi nợ) - phải khai báo trước PATCH /:id để path /:id/debt khớp
router.patch('/:id/debt', async (req, res) => {
  try {
    const order = await queryOne('SELECT id, status, is_debt, store_id, assigned_to, created_by FROM orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Chỉ đơn hàng đã hoàn thành mới có thể ghi nợ' });
    }
    if (order.is_debt === 1) {
      return res.status(400).json({ error: 'Đơn hàng đã ở trạng thái ghi nợ' });
    }
    if (req.user.role === 'employer') {
      if (req.user.store_id && order.store_id !== req.user.store_id) {
        return res.status(403).json({ error: 'Bạn không có quyền ghi nợ đơn hàng này' });
      }
      if (!req.user.store_id && order.assigned_to !== req.user.id && order.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Bạn không có quyền ghi nợ đơn hàng này' });
      }
    }
    await execute('UPDATE orders SET is_debt = 1, debt_paid_at = NULL WHERE id = ?', [req.params.id]);
    const updated = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    res.json({ data: updated });
  } catch (error) {
    console.error('Mark order debt error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark debt as paid (đã thanh toán) - phải khai báo trước PATCH /:id để path /:id/debt/paid khớp
router.patch('/:id/debt/paid', async (req, res) => {
  try {
    const { payment_method } = req.body;
    if (!payment_method || !['cash', 'transfer'].includes(payment_method)) {
      return res.status(400).json({ error: 'Vui lòng chọn phương thức thanh toán (tiền mặt hoặc chuyển khoản).' });
    }
    const order = await queryOne('SELECT id, status, is_debt, store_id, assigned_to, created_by FROM orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.is_debt !== 1) {
      return res.status(400).json({ error: 'Đơn hàng không ở trạng thái ghi nợ' });
    }
    if (req.user.role === 'employer') {
      if (req.user.store_id && order.store_id !== req.user.store_id) {
        return res.status(403).json({ error: 'Bạn không có quyền thao tác đơn hàng này' });
      }
      if (!req.user.store_id && order.assigned_to !== req.user.id && order.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Bạn không có quyền thao tác đơn hàng này' });
      }
    }
    await execute(
      'UPDATE orders SET is_debt = 0, debt_paid_at = NOW(), payment_method = ?, updated_by = ? WHERE id = ?',
      [payment_method, req.user.id, req.params.id]
    );
    const updated = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    res.json({ data: updated });
  } catch (error) {
    console.error('Mark debt paid error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update order (generic - khai báo sau các route con /:id/debt, /:id/debt/paid)
router.patch('/:id', auditLog('update', 'order'), async (req, res) => {
  try {
    const { status, assigned_to, note, items, customer_name, customer_phone } = req.body;

    const order = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Use transaction to ensure atomicity
    await transaction(async (db) => {
      const updates = [];
      const values = [];

      if (status !== undefined) {
        updates.push('status = ?');
        values.push(status);
        
        // Add status history
        await db.execute(`
          INSERT INTO order_status_history (order_id, status, changed_by)
          VALUES (?, ?, ?)
        `, [req.params.id, status, req.user.id]);
      }

      if (assigned_to !== undefined) {
        updates.push('assigned_to = ?');
        values.push(assigned_to);
      }

      if (note !== undefined) {
        updates.push('note = ?');
        values.push(note);
      }

      // Update customer info if provided (sửa đơn - nhân viên)
      if (customer_name !== undefined || customer_phone !== undefined) {
        const nameVal = customer_name !== undefined ? String(customer_name).trim() : null;
        const phoneVal = customer_phone !== undefined ? String(customer_phone).trim() || null : null;
        if (order.customer_id) {
          await db.execute(
            'UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ?',
            [nameVal, phoneVal, order.customer_id]
          );
        } else {
          const tempPhone = phoneVal || `temp_${Date.now()}`;
          const insertRes = await db.execute(
            'INSERT INTO customers (name, phone) VALUES (?, ?)',
            [nameVal || 'Khách vãng lai', tempPhone]
          );
          const newCustomerId = insertRes.insertId;
          updates.push('customer_id = ?');
          values.push(newCustomerId);
        }
      }

      // Update items if provided
      if (items && Array.isArray(items)) {
        // Delete old items
        await db.execute('DELETE FROM order_items WHERE order_id = ?', [req.params.id]);

        // Calculate new total
        let total = 0;
        for (const item of items) {
          // Validate product_id
          if (!item.product_id) {
            throw new Error('Product ID is required for all items');
          }

          // Validate quantity
          const quantity = parseFloat(item.quantity);
          if (isNaN(quantity) || !isFinite(quantity) || quantity <= 0) {
            throw new Error(`Số lượng phải là số dương hợp lệ (item product_id: ${item.product_id})`);
          }

          // Get product and validate it exists and is active
          const product = await db.queryOne('SELECT * FROM products WHERE id = ? AND status = ?', [item.product_id, 'active']);
          if (!product) {
            throw new Error(`Sản phẩm ${item.product_id} không tồn tại hoặc đã bị vô hiệu hóa`);
          }

          const itemTotal = product.price * quantity;
          if (!isFinite(itemTotal) || itemTotal < 0) {
            throw new Error(`Tính toán giá trị đơn hàng không hợp lệ cho sản phẩm ${product.name}`);
          }

          total += itemTotal;
          await db.execute(`
            INSERT INTO order_items (order_id, product_id, quantity, unit_price, note)
            VALUES (?, ?, ?, ?, ?)
          `, [req.params.id, item.product_id, quantity, product.price, item.note ? item.note.trim() : null]);
        }

        updates.push('total_amount = ?', 'discount_amount = 0', 'final_amount = ?', 'promotion_id = ?');
        values.push(total, total, null);
      }

      updates.push('updated_by = ?');
      values.push(req.user.id);
      values.push(req.params.id);

      if (updates.length > 1) {
        await db.execute(`
          UPDATE orders
          SET ${updates.join(', ')}
          WHERE id = ?
        `, values);
      }
    });

    const updatedOrder = await queryOne(`
      SELECT o.*, 
        c.name as customer_name, 
        c.phone as customer_phone,
        u.name as assigned_to_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.assigned_to = u.id
      WHERE o.id = ?
    `, [req.params.id]);

    const orderItems = await query(`
      SELECT oi.*, p.name as product_name, p.unit as product_unit
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [req.params.id]);

    res.json({ data: { ...updatedOrder, items: orderItems } });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update order status
router.post('/:id/status', async (req, res) => {
  try {
    const { status, payment_method, withdrawn_amount } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['created', 'washing', 'drying', 'waiting_pickup', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Allowed: created, washing, drying, waiting_pickup, completed, cancelled.' });
    }

    const order = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update status, payment_method, withdrawn_amount
    const updates = ['status = ?', 'updated_by = ?'];
    const values = [status, req.user.id];
    
    if (status === 'completed' && payment_method) {
      if (!['cash', 'transfer'].includes(payment_method)) {
        return res.status(400).json({ error: 'Invalid payment_method. Only "cash" and "transfer" are allowed.' });
      }
      updates.push('payment_method = ?');
      values.push(payment_method);
    }

    if (status === 'completed' && withdrawn_amount !== undefined && withdrawn_amount !== null && withdrawn_amount !== '') {
      const amount = parseFloat(withdrawn_amount);
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ error: 'Số tiền rút phải là số không âm.' });
      }
      updates.push('withdrawn_amount = ?');
      values.push(amount);
    }
    
    values.push(req.params.id);
    
    await execute(`
      UPDATE orders
      SET ${updates.join(', ')}
      WHERE id = ?
    `, values);

    // Add status history
    await execute(`
      INSERT INTO order_status_history (order_id, status, changed_by)
      VALUES (?, ?, ?)
    `, [req.params.id, status, req.user.id]);

    const updatedOrder = await queryOne(`
      SELECT o.*, 
        c.name as customer_name, 
        c.phone as customer_phone,
        u.name as assigned_to_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.assigned_to = u.id
      WHERE o.id = ?
    `, [req.params.id]);

    const orderItems = await query(`
      SELECT oi.*, p.name as product_name, p.unit as product_unit
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [req.params.id]);

    res.json({ data: { ...updatedOrder, items: orderItems } });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete order (Admin only)
router.delete('/:id', authorize('admin'), auditLog('delete', 'order'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - cannot delete orders
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xóa đơn hàng' });
    }

    const order = await queryOne('SELECT id FROM orders WHERE id = ?', [req.params.id]);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await execute('DELETE FROM orders WHERE id = ?', [req.params.id]);
    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
