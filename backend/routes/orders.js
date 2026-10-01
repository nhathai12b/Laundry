import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { formatDateTimeUTC, generateOrderCode, normalizeCustomerPhoneForIdentity } from '../utils/helpers.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';
import {
  sendOrderCreatedNotification,
  sendReadyForPickupNotification,
} from '../services/zaloMessageService.js';
import {
  getOrderPaymentBalance,
  recordOrderPayment,
  recordOrderPaymentTx,
  syncOrderPaymentState,
  syncOrderPaymentStateTx,
} from '../services/orderPaymentService.js';
import { resolveCurrentStoreId, resolveCurrentEmployeeId } from '../services/workingStoreService.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

const isoToMysqlUtc = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTimeUTC(date);
};

// export: print.js dùng chung để chặn in bill chéo tenant
export async function userCanAccessOrder(order, user) {
  // Root là vendor phần mềm, không vận hành cửa hàng — mọi route khác trong
  // file này đều chặn root tường minh ("Root admin không thể..."). `return true`
  // ở đây làm NGƯỢC LẠI: root đọc/sửa/thu tiền/in bill được MỌI đơn của MỌI
  // tenant chỉ bằng cách dò id tuần tự.
  if (user.role === 'root') return false;

  if (user.role === 'admin') {
    if (order.store_id) {
      const row = await queryOne(
        'SELECT 1 FROM stores WHERE id = ? AND admin_id = ?',
        [order.store_id, user.id]
      );
      return Boolean(row);
    }
    const row = await queryOne(`
      SELECT 1 FROM users
      WHERE id IN (?, ?)
        AND store_id IN (SELECT id FROM stores WHERE admin_id = ?)
      LIMIT 1
    `, [order.assigned_to, order.created_by, user.id]);
    return Boolean(row);
  }

  if (user.role === 'employer') {
    // Tài khoản tiệm (và token nhân viên của tiệm) chỉ chạm được đơn của ĐÚNG
    // cửa hàng mình (users.store_id trong token = stores.id). Đơn không có
    // store_id (legacy) thì so theo người gán/người tạo.
    const currentStoreId = await resolveCurrentStoreId(user);
    if (currentStoreId) return order.store_id === currentStoreId;
    return order.assigned_to === user.id || order.created_by === user.id;
  }

  return false;
}

// Get all orders
router.get('/', async (req, res) => {
  try {
    const {
      status, assigned_to, customer_phone, my_orders, date, store_id, debt_only, active_only, pending_only,
      summary, customer_ids, start_at, end_at,
    } = req.query;
    let whereSql = ' WHERE 1=1';
    const params = [];

    // For employer, filter by the account's store (users.store_id in token)
    if (req.user.role === 'employer') {
      const currentStoreId = await resolveCurrentStoreId(req.user);
      if (currentStoreId) {
        whereSql += ' AND o.store_id = ?';
        params.push(currentStoreId);
      } else {
        // Fallback: filter by user id if no store_id
        whereSql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    }

    // For admin (not root), filter by stores owned by this admin
    // Support store_id from query param for filtering
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      if (store_id && store_id !== 'all') {
        // Filter by specific store (must belong to admin)
        // Prefer o.store_id (stores.id). Fallback to legacy matching if o.store_id is NULL.
        whereSql += ` AND (
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
        whereSql += ` AND (
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
      whereSql += ' AND o.assigned_to = ?';
      params.push(req.user.id);
    }

    if (status) {
      whereSql += ' AND o.status = ?';
      params.push(status);
    }

    if (assigned_to) {
      whereSql += ' AND o.assigned_to = ?';
      params.push(assigned_to);
    }

    if (customer_phone) {
      whereSql += ' AND c.phone LIKE ?';
      params.push(`%${customer_phone}%`);
    }

    if (start_at && end_at) {
      const startAt = isoToMysqlUtc(start_at);
      const endAt = isoToMysqlUtc(end_at);
      if (!startAt || !endAt) {
        return res.status(400).json({ error: 'Invalid date range' });
      }
      whereSql += ' AND o.created_at >= ? AND o.created_at < ?';
      params.push(startAt, endAt);
    } else if (date) {
      whereSql += ' AND DATE(o.created_at) = ?';
      params.push(date);
    }

    // Đơn đang xử lý (chưa xong/chưa hủy) — Dashboard chỉ cần đếm nhóm này
    if (active_only === '1' || active_only === 'true') {
      whereSql += " AND o.status IN ('created', 'washing', 'drying', 'waiting_pickup')";
    }

    // Trang "Tồn kho": mọi đơn CHƯA hoàn thành — kể cả đã hủy (trang giữ đơn hủy
    // hiển thị "Đã hủy"). Lọc ở DB thay vì tải toàn bộ lịch sử rồi lọc ở trình duyệt
    if (pending_only === '1' || pending_only === 'true') {
      whereSql += " AND o.status <> 'completed'";
    }

    if (debt_only === '1' || debt_only === 'true') {
      whereSql += " AND o.status = 'completed' AND (COALESCE(o.debt_amount, 0) > 0 OR o.payment_status IN ('debt', 'partial') OR COALESCE(o.is_debt, 0) = 1)";
    } else {
      whereSql += " AND NOT (o.status = 'completed' AND (COALESCE(o.debt_amount, 0) > 0 OR o.payment_status IN ('debt', 'partial') OR COALESCE(o.is_debt, 0) = 1))";
    }

    // Filter by date range (for month view)
    const { start_date, end_date } = req.query;
    if (!start_at && !end_at && start_date && end_date) {
      whereSql += ' AND DATE(o.created_at) >= ? AND DATE(o.created_at) <= ?';
      params.push(start_date, end_date);
    }

    const baseFrom = ' FROM orders o LEFT JOIN customers c ON o.customer_id = c.id';

    // summary=true: chỉ trả số đếm/tổng tiền theo đúng bộ lọc (Dashboard, dòng
    // tổng của trang Đơn hàng). Trước đây các nơi này tải TOÀN BỘ danh sách đơn
    // kèm items chỉ để đếm/cộng — đo được 45 MB/tiệm, 134 MB/chuỗi 3 tiệm với 2 năm dữ liệu
    if (summary === '1' || summary === 'true') {
      const row = await queryOne(`
        SELECT COUNT(*) AS order_count,
          COALESCE(SUM(o.total_amount), 0) AS total_amount,
          COALESCE(SUM(COALESCE(o.final_amount, o.total_amount)), 0) AS final_amount,
          COALESCE(SUM((SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id)), 0) AS item_count
        ${baseFrom}${whereSql}
      `, params);
      return res.json({
        summary: {
          order_count: Number(row?.order_count || 0),
          item_count: Number(row?.item_count || 0),
          total_amount: Number.parseFloat(row?.total_amount || 0) || 0,
          final_amount: Number.parseFloat(row?.final_amount || 0) || 0,
        },
      });
    }

    // customer_ids=true: chỉ trả customer_id của các đơn khớp bộ lọc (trang Khách
    // hàng lọc theo ngày/tháng/năm) — trước đây tải nguyên danh sách đơn kèm items
    // của cả kỳ chỉ để lấy customer_id
    if (customer_ids === '1' || customer_ids === 'true') {
      const rows = await query(
        `SELECT DISTINCT o.customer_id ${baseFrom}${whereSql} AND o.customer_id IS NOT NULL`,
        params
      );
      return res.json({ customer_ids: rows.map((r) => r.customer_id) });
    }

    // Phân trang TÙY CHỌN: không gửi limit = trả hết như cũ (Home, trang ca làm
    // lọc theo 1 ngày và cần đủ danh sách). Lấy dư 1 dòng để biết còn trang sau.
    // o.id phụ cho created_at trùng giây — thứ tự ổn định giữa các trang
    let pageSql = '';
    let pageLimit = null;
    let pageOffset = 0;
    const rawLimit = Number.parseInt(req.query.limit, 10);
    if (Number.isInteger(rawLimit) && rawLimit > 0) {
      pageLimit = Math.min(rawLimit, 500);
      const rawOffset = Number.parseInt(req.query.offset, 10);
      pageOffset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
      pageSql = ` LIMIT ${pageLimit + 1} OFFSET ${pageOffset}`;
    }

    const orders = await query(`
      SELECT o.*,
        c.name as customer_name,
        c.phone as customer_phone,
        u.name as assigned_to_name,
        creator.name as created_by_name
      ${baseFrom}
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users creator ON o.created_by = creator.id
      ${whereSql}
      ORDER BY o.created_at DESC, o.id DESC${pageSql}
    `, params);
    let hasMore = false;
    if (pageLimit !== null && orders.length > pageLimit) {
      hasMore = true;
      orders.length = pageLimit;
    }
    const pagination = pageLimit !== null ? { limit: pageLimit, offset: pageOffset, has_more: hasMore } : undefined;

    // Batch query order items to avoid N+1 problem
    if (orders.length === 0) {
      return res.json({ data: [], pagination });
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

    res.json({ data: ordersWithItems, pagination });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single order
router.get('/:id', async (req, res) => {
  try {
    // BUG NGHIÊM TRỌNG (đã tái hiện bằng test thật): route này có logic scope
    // RIÊNG thay vì dùng userCanAccessOrder() dùng chung, và logic riêng đó
    // hoàn toàn THIẾU nhánh cho role 'employer' — mọi tài khoản tiệm (kể cả
    // nhân viên) đọc được BẤT KỲ đơn hàng nào trong toàn hệ thống chỉ bằng
    // cách dò id (tên khách, SĐT, tiền). Giờ dùng chung 1 hàm kiểm tra quyền
    // với mọi route khác của orders.js — không tự viết lại logic scope nữa.
    const order = await queryOne(`
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
    `, [req.params.id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!(await userCanAccessOrder(order, req.user))) {
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
    const { customer_name, customer_phone, items, note, assigned_to, promotion_id, expected_return_at } = req.body;

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
          throw Object.assign(new Error('Product ID is required for all items'), { statusCode: 400 });
        }

        // Validate quantity
        const quantity = parseFloat(item.quantity);
        if (isNaN(quantity) || !isFinite(quantity) || quantity <= 0) {
          throw Object.assign(new Error(`Số lượng phải là số dương hợp lệ (item product_id: ${item.product_id})`), { statusCode: 400 });
        }

        // Get product and validate it exists and is active
        const product = await db.queryOne('SELECT * FROM products WHERE id = ? AND status = ?', [item.product_id, 'active']);
        if (!product) {
          throw Object.assign(new Error(`Sản phẩm ${item.product_id} không tồn tại hoặc đã bị vô hiệu hóa`), { statusCode: 400 });
        }

        const itemTotal = product.price * quantity;
        if (!isFinite(itemTotal) || itemTotal < 0) {
          throw Object.assign(new Error(`Tính toán giá trị đơn hàng không hợp lệ cho sản phẩm ${product.name}`), { statusCode: 400 });
        }

        total += itemTotal;
        orderItems.push({
          product_id: product.id,
          quantity: quantity,
          unit_price: product.price,
          note: item.note ? item.note.trim() : null,
          product_store_id: product.store_id,
          product_name: product.name,
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
          throw Object.assign(new Error('Invalid promotion_id'), { statusCode: 400 });
        }
        // Initial promotion fetch - will validate store_id later
        const promotion = await db.queryOne('SELECT * FROM promotions WHERE id = ? AND status = "active"', [promotionIdInt]);
        if (promotion) {
          // So sánh theo NGÀY giờ VN (khớp với /promotions/applicable): end_date
          // là cột DATE → so timestamp với 00:00 ngày cuối làm mọi đơn sau nửa
          // đêm ngày cuối bị RỚT khuyến mãi im lặng dù UI vừa báo giá đã giảm
          const vnToday = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

          // Check if promotion is active by date (biên bao gồm cả 2 đầu)
          if (vnToday >= toDateStr(promotion.start_date) && vnToday <= toDateStr(promotion.end_date)) {
            // Check if customer meets promotion criteria
            const orderCount = customer.total_orders || 0;
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
            // Phải throw để transaction ROLLBACK — `return res.status(403)` ở đây
            // sẽ COMMIT customer vừa insert (đơn ma), Response object trở thành
            // "order id" cho các query sau, và response bị gửi 2 lần (crash risk)
            throw Object.assign(
              new Error('Bạn chỉ có thể gán đơn hàng cho nhân viên trong chuỗi cửa hàng của mình'),
              { statusCode: 403 }
            );
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
      } else if (req.user.role === 'employer') {
        // employer/employee_login KHÔNG được gán đơn cho user_id bất kỳ —
        // thiếu check này, client tự truyền assigned_to = users.id của TENANT
        // KHÁC sẽ khiến bước bên dưới lấy store_id của user đó, tạo đơn "ma"
        // ngay trong dữ liệu của tenant khác (cùng luật với PATCH /:id).
        if (assigned_to && Number(assigned_to) !== req.user.id) {
          throw Object.assign(
            new Error('Bạn chỉ có thể gán đơn hàng cho tài khoản cửa hàng của mình'),
            { statusCode: 403 }
          );
        }
        finalAssignedTo = req.user.id;
      }

      // Get store_id for the order
      let orderStoreId = null;
      if (req.user.role === 'employer' && finalAssignedTo === req.user.id) {
        // Đơn do chính tài khoản/nhân viên tiệm tạo → cửa hàng của tài khoản
        // (một nguồn duy nhất: resolveCurrentStoreId)
        orderStoreId = await resolveCurrentStoreId(req.user);
      } else if (finalAssignedTo) {
        const assignedUser = await db.queryOne('SELECT store_id FROM users WHERE id = ?', [finalAssignedTo]);
        if (assignedUser && assignedUser.store_id) {
          orderStoreId = assignedUser.store_id;
        }
      }
      if (!orderStoreId && req.user.store_id) {
        orderStoreId = req.user.store_id;
      }

      // Admin thường KHÔNG có store_id riêng (chỉ quản lý chuỗi cửa hàng),
      // nên nếu để "Chưa gán" thì orderStoreId vẫn NULL tới đây — đơn sẽ bị
      // "mồ côi": không khớp store_id ở mọi query lọc theo cửa hàng (kể cả
      // của chính admin vừa tạo), không bao giờ xuất hiện trong danh sách/báo
      // cáo. Chặn sớm thay vì âm thầm tạo ra đơn không thể truy cập.
      if (!orderStoreId && req.user.role === 'admin') {
        throw Object.assign(
          new Error('Vui lòng gán đơn hàng cho một nhân viên để xác định cửa hàng.'),
          { statusCode: 400 }
        );
      }

      // Chặn sản phẩm KHÁC cửa hàng (kể cả của tenant khác) lẻn vào đơn —
      // bước lấy product ở trên chỉ check status='active', không check
      // store_id, nên client tự truyền product_id bất kỳ trong hệ thống sẽ
      // copy được giá/tên sản phẩm đó vào đơn của mình. Áp dụng bất cứ khi
      // nào đã xác định được cửa hàng cụ thể cho đơn (employer lẫn admin) —
      // trước đây chỉ chặn cho employer, để hở đúng lỗ hổng này cho admin.
      if (orderStoreId) {
        const invalidItem = orderItems.find(
          (it) => it.product_store_id != null && it.product_store_id !== orderStoreId
        );
        if (invalidItem) {
          throw Object.assign(
            new Error(`Sản phẩm ${invalidItem.product_name} không thuộc cửa hàng này`),
            { statusCode: 400 }
          );
        }
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

      const expectedReturnAt = expected_return_at ? isoToMysqlUtc(expected_return_at) : null;
      if (expected_return_at && !expectedReturnAt) {
        throw Object.assign(new Error('Invalid expected_return_at'), { statusCode: 400 });
      }

      // Nhân viên tạo đơn — từ token đăng nhập riêng, hoặc (tài khoản tiệm
      // nhiều nhân viên cùng dùng) nhân viên đang check-in ca duy nhất đang
      // mở — dùng để tính hoa hồng sản phẩm cho đúng người. Trước đây chỉ lấy
      // req.user.employee_id (không có ở tài khoản tiệm) → hoa hồng luôn = 0.
      const orderEmployeeId = await resolveCurrentEmployeeId(req.user, db.queryOne);

      const orderResult = await db.execute(`
        INSERT INTO orders (
          customer_id, code, status, assigned_to, employee_id, note,
          total_amount, discount_amount, final_amount, promotion_id, store_id,
          created_by, is_debt, expected_return_at, payment_status, paid_amount, debt_amount
        )
        VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'unpaid', 0, 0)
      `, [
        customer.id,
        code,
        finalAssignedTo || null,
        orderEmployeeId,
        note || null,
        total,
        discountAmount,
        finalAmount,
        finalPromotionId,
        orderStoreId,
        req.user.id,
        expectedReturnAt
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

    sendOrderCreatedNotification(result).catch((error) => {
      console.error('Order created Zalo notification failed:', error.message);
    });

    res.status(201).json({ data: { ...newOrder, items: orderItemsWithProduct } });
  } catch (error) {
    console.error('Create order error:', error);
    // Các throw new Error(...) validate hàng/số lượng/sản phẩm trong khối tạo
    // đơn phía trên đều là message tiếng Việt tự viết, an toàn để hiện thẳng.
    // Chỉ chặn khi là lỗi MySQL thật (error.code/.sqlMessage) — loại đó mới có
    // nguy cơ lộ tên cột/bảng nội bộ.
    const isRawDbError = Boolean(error.code || error.sqlMessage);
    const errorMessage = isRawDbError ? 'Lỗi máy chủ. Vui lòng thử lại.' : (error.message || 'Lỗi máy chủ. Vui lòng thử lại.');
    res.status(error.statusCode || 500).json({ error: errorMessage });
  }
});

router.patch('/:id/debt', async (req, res) => {
  try {
    const order = await queryOne('SELECT id, status, is_debt, store_id, assigned_to, created_by, final_amount, total_amount, paid_amount FROM orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Chỉ đơn hàng đã hoàn thành mới có thể ghi nợ' });
    }
    if (order.is_debt === 1) {
      return res.status(400).json({ error: 'Đơn hàng đã ở trạng thái ghi nợ' });
    }
    if (!(await userCanAccessOrder(order, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền ghi nợ đơn hàng này' });
    }
    const balance = await getOrderPaymentBalance(req.params.id);
    if ((Number.parseFloat(balance?.debt_amount || 0) || 0) <= 0.009) {
      return res.status(400).json({ error: 'Đơn hàng đã thanh toán đủ, không thể chuyển sang ghi nợ' });
    }
    await syncOrderPaymentState(req.params.id, req.user, { markDebtIfUnpaid: true });
    const updated = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    res.json({ data: updated });
  } catch (error) {
    console.error('Mark order debt error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id/debt/paid', async (req, res) => {
  try {
    const { payment_method } = req.body;
    if (!payment_method || !['cash', 'transfer'].includes(payment_method)) {
      return res.status(400).json({ error: 'Vui lòng chọn phương thức thanh toán (tiền mặt hoặc chuyển khoản).' });
    }
    const order = await queryOne('SELECT id, status, is_debt, store_id, assigned_to, created_by, final_amount, total_amount, paid_amount, debt_amount FROM orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.is_debt !== 1) {
      return res.status(400).json({ error: 'Đơn hàng không ở trạng thái ghi nợ' });
    }
    if (!(await userCanAccessOrder(order, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền thao tác đơn hàng này' });
    }
    const balance = await getOrderPaymentBalance(req.params.id);
    const remaining = Number.parseFloat(balance?.debt_amount ?? order.debt_amount ?? 0) || 0;
    if (remaining <= 0) {
      return res.status(400).json({ error: 'Order has no remaining debt' });
    }
    await recordOrderPayment(req.params.id, {
      amount: remaining,
      payment_method,
      payment_type: 'debt_payment',
      note: 'Debt paid via legacy endpoint',
    }, req.user);
    const updated = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    res.json({ data: updated });
  } catch (error) {
    console.error('Mark debt paid error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/payments', auditLog('update', 'order'), async (req, res) => {
  try {
    const { amount, payment_method, payment_type = 'debt_payment', note } = req.body;

    if (!['cash', 'transfer'].includes(payment_method)) {
      return res.status(400).json({ error: 'Vui lòng chọn phương thức thanh toán (tiền mặt hoặc chuyển khoản).' });
    }
    if (!['order_payment', 'debt_payment'].includes(payment_type)) {
      return res.status(400).json({ error: 'Loại thanh toán không hợp lệ.' });
    }
    const parsedAmount = Number.parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Số tiền phải lớn hơn 0.' });
    }

    const order = await queryOne(
      'SELECT id, store_id, assigned_to, created_by FROM orders WHERE id = ?',
      [req.params.id]
    );
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (!(await userCanAccessOrder(order, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền thao tác đơn hàng này' });
    }

    const payment = await recordOrderPayment(req.params.id, {
      amount: parsedAmount,
      payment_method,
      payment_type,
      note: note ? String(note).slice(0, 500) : null,
    }, req.user);
    const updated = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    res.status(201).json({ data: { order: updated, payment } });
  } catch (error) {
    console.error('Record order payment error:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/:id', auditLog('update', 'order'), async (req, res) => {
  try {
    const { status, assigned_to, note, items, customer_name, customer_phone } = req.body;

    const order = await queryOne('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    // Prevent cross-store edits: only staff who can access this order may modify it
    if (!(await userCanAccessOrder(order, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền sửa đơn hàng này' });
    }

    // Use transaction to ensure atomicity
    await transaction(async (db) => {
      const updates = [];
      const values = [];

      if (status !== undefined) {
        // Đổi trạng thái phải đi qua POST /:id/status — PATCH đổi status "chay"
        // sẽ bỏ qua toàn bộ side effect (hoàn tác thống kê khách khi hủy, ghi
        // nhận thanh toán khi hoàn thành, tin Zalo "chờ nhận", mốc ready_at...)
        // và POST sau đó cũng skip vì thấy status đã đổi rồi
        throw Object.assign(
          new Error('Không thể đổi trạng thái qua API này. Dùng POST /orders/:id/status.'),
          { statusCode: 400 }
        );
      }

      if (assigned_to !== undefined) {
        // Cùng luật với POST / — thiếu check này thì người có quyền sửa đơn
        // (chỉ cần userCanAccessOrder qua) gán được đơn cho user_id BẤT KỲ ở
        // tenant khác, sau đó user đó thấy đơn xuất hiện trong "đơn của tôi"
        if (assigned_to && req.user.role === 'admin') {
          const assignedUser = await db.queryOne(`
            SELECT u.id FROM users u
            INNER JOIN stores s ON u.store_id = s.id
            WHERE u.id = ? AND s.admin_id = ?
          `, [assigned_to, req.user.id]);
          if (!assignedUser) {
            throw Object.assign(
              new Error('Bạn chỉ có thể gán đơn hàng cho nhân viên trong chuỗi cửa hàng của mình'),
              { statusCode: 403 }
            );
          }
        } else if (assigned_to && req.user.role === 'employer' && Number(assigned_to) !== req.user.id) {
          throw Object.assign(
            new Error('Bạn chỉ có thể gán đơn hàng cho tài khoản cửa hàng của mình'),
            { statusCode: 403 }
          );
        }
        updates.push('assigned_to = ?');
        values.push(assigned_to);
      }

      if (note !== undefined) {
        updates.push('note = ?');
        values.push(note);
      }

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
          // Các throw dưới đây đều gắn statusCode — catch block của route này
          // dùng error.statusCode || 500; Error thường (không statusCode) sẽ
          // rớt xuống 500 "Server error" và NUỐT MẤT message tiếng Việt đã
          // viết sẵn, khiến người dùng thấy lỗi máy chủ chung chung.
          if (!item.product_id) {
            throw Object.assign(new Error('Product ID is required for all items'), { statusCode: 400 });
          }

          // Validate quantity
          const quantity = parseFloat(item.quantity);
          if (isNaN(quantity) || !isFinite(quantity) || quantity <= 0) {
            throw Object.assign(new Error(`Số lượng phải là số dương hợp lệ (item product_id: ${item.product_id})`), { statusCode: 400 });
          }

          // Get product and validate it exists and is active
          const product = await db.queryOne('SELECT * FROM products WHERE id = ? AND status = ?', [item.product_id, 'active']);
          if (!product) {
            throw Object.assign(new Error(`Sản phẩm ${item.product_id} không tồn tại hoặc đã bị vô hiệu hóa`), { statusCode: 400 });
          }
          // Chặn sản phẩm KHÁC cửa hàng (kể cả tenant khác) lẻn vào khi sửa
          // đơn — thiếu check này (đường tạo đơn POST / đã có) cho phép gán
          // sản phẩm bất kỳ trong hệ thống vào đơn đã hoàn thành, ăn gian
          // commission_percent của sản phẩm đó hoặc làm sai lệch báo cáo.
          // order.store_id NULL (đơn legacy) → không có cửa hàng để so, bỏ qua
          // check này như POST / (`if (orderStoreId)`); nếu không, MỌI sản phẩm
          // có store_id đều bị từ chối và đơn legacy không bao giờ sửa được
          if (order.store_id && product.store_id != null && product.store_id !== order.store_id) {
            throw Object.assign(new Error(`Sản phẩm ${product.name} không thuộc cửa hàng này`), { statusCode: 400 });
          }

          const itemTotal = product.price * quantity;
          if (!isFinite(itemTotal) || itemTotal < 0) {
            throw Object.assign(new Error(`Tính toán giá trị đơn hàng không hợp lệ cho sản phẩm ${product.name}`), { statusCode: 400 });
          }

          total += itemTotal;
          await db.execute(`
            INSERT INTO order_items (order_id, product_id, quantity, unit_price, note)
            VALUES (?, ?, ?, ?, ?)
          `, [req.params.id, item.product_id, quantity, product.price, item.note ? item.note.trim() : null]);
        }

        updates.push('total_amount = ?', 'discount_amount = 0', 'final_amount = ?', 'promotion_id = ?');
        values.push(total, total, null);

        // Cập nhật DELTA vào thống kê khách: tạo đơn đã cộng final_amount cũ
        // vào total_spent — sửa items đổi tiền mà không điều chỉnh thì số liệu
        // khách lệch vĩnh viễn (hủy/xóa đơn sau đó trừ theo số MỚI)
        if (order.customer_id && order.status !== 'cancelled') {
          const oldFinal = Number.parseFloat(order.final_amount ?? order.total_amount ?? 0) || 0;
          const delta = total - oldFinal;
          if (delta !== 0) {
            await db.execute(`
              UPDATE customers
              SET total_spent = GREATEST(total_spent + ?, 0)
              WHERE id = ?
            `, [delta, order.customer_id]);
          }
        }
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

      // Sửa items của đơn ĐÃ hoàn thành làm final_amount đổi — phải đồng bộ lại
      // paid/debt/payment_status. Nếu không: đơn 100k đã trả đủ, sửa lên 150k
      // vẫn hiện "paid" với debt=0, 50k còn thiếu không bao giờ vào danh sách nợ
      if (items && Array.isArray(items) && order.status === 'completed') {
        await syncOrderPaymentStateTx(db, req.params.id, req.user, { markDebtIfUnpaid: true });
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
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Server error' });
  }
});

// Update order status
router.post('/:id/status', auditLog('update', 'order'), async (req, res) => {
  try {
    const { status, payment_method, withdrawn_amount, amount_paid, delivery_method } = req.body;

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
    // Prevent cross-store status changes / payments booked against another store
    if (!(await userCanAccessOrder(order, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền thay đổi đơn hàng này' });
    }

    const deliveryMethod = delivery_method || 'pickup';
    if (status === 'completed' && !['pickup', 'customer_ship', 'shop_delivery'].includes(deliveryMethod)) {
      return res.status(400).json({ error: 'Invalid delivery_method.' });
    }

    let amountPaid = null;
    const amountPaidProvided = amount_paid !== undefined && amount_paid !== null && amount_paid !== '';
    if (status === 'completed') {
      const finalAmount = Number.parseFloat(order.final_amount ?? order.total_amount ?? 0) || 0;
      const paidSoFar = Number.parseFloat(order.paid_amount || 0) || 0;
      const remaining = Math.max(finalAmount - paidSoFar, 0);

      if (amountPaidProvided) {
        amountPaid = Number.parseFloat(amount_paid);
        if (!Number.isFinite(amountPaid) || amountPaid < 0) {
          return res.status(400).json({ error: 'amount_paid must be a non-negative number.' });
        }
      } else if (payment_method) {
        // Mặc định thu PHẦN CÒN LẠI, không phải toàn bộ final_amount — đơn đã
        // trả trước một phần mà mặc định full sẽ bị chặn "exceeds remaining"
        amountPaid = remaining;
      } else {
        amountPaid = 0;
      }

      if (amountPaid > 0 && !['cash', 'transfer'].includes(payment_method)) {
        return res.status(400).json({ error: 'Invalid payment_method. Only "cash" and "transfer" are allowed.' });
      }

      if (amountPaid - remaining > 0.009) {
        return res.status(400).json({ error: 'Payment amount exceeds remaining order balance' });
      }
    }

    const updates = ['status = ?', 'updated_by = ?'];
    const values = [status, req.user.id];

    if (['washing', 'drying'].includes(status) && !order.processing_started_at) {
      updates.push('processing_started_at = NOW()');
    }

    if (status === 'waiting_pickup' && !order.ready_at) {
      updates.push('ready_at = NOW()');
    }
    
    if (status === 'completed') {
      if (!order.delivered_at) {
        updates.push('delivered_at = NOW()');
      }
      updates.push('delivery_method = ?');
      values.push(deliveryMethod);
      if (amountPaid > 0) {
        updates.push('payment_method = ?');
        values.push(payment_method);
      }
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

    const isNewlyCompleted = status === 'completed' && order.status !== 'completed';
    // Hủy đơn lần đầu (chưa từng hủy): hoàn tác thống kê khách đã cộng lúc tạo
    const isNewlyCancelled = status === 'cancelled' && order.status !== 'cancelled';

    // Đơn ĐÃ THU TIỀN không được hủy trực tiếp: hủy chỉ hoàn tác thống kê khách,
    // còn order_payments/tiền két/báo cáo doanh thu vẫn giữ nguyên → 3 sổ 3 số.
    // Thực tế phải hoàn tiền cho khách trước (điều chỉnh sản phẩm/thanh toán).
    if (isNewlyCancelled && (Number.parseFloat(order.paid_amount) || 0) > 0.009) {
      return res.status(400).json({
        error: 'Đơn đã thu tiền — không thể hủy trực tiếp. Vui lòng xử lý hoàn tiền/điều chỉnh thanh toán trước khi hủy.',
      });
    }
    if (isNewlyCancelled) {
      // Xóa trạng thái nợ khi hủy — nếu không, đơn hủy biến khỏi danh sách thu nợ
      // của nhân viên nhưng vẫn nằm trong "công nợ còn lại" của báo cáo admin mãi mãi
      updates.push('debt_amount = 0', 'is_debt = 0', "payment_status = 'unpaid'");
    }

    await transaction(async (db) => {
      await db.execute(`
        UPDATE orders
        SET ${updates.join(', ')}
        WHERE id = ?
      `, values);

      await db.execute(`
        INSERT INTO order_status_history (order_id, status, changed_by)
        VALUES (?, ?, ?)
      `, [req.params.id, status, req.user.id]);

      if (status === 'completed') {
        // amountPaidProvided: đơn ĐÃ hoàn thành nhưng người dùng nhập số tiền
        // (thu nợ qua nút hoàn thành) — trước đây bị bỏ qua im lặng: 200 OK,
        // payment_method đổi, nhưng không có đồng nào vào sổ
        if ((isNewlyCompleted || amountPaidProvided) && amountPaid > 0) {
          await recordOrderPaymentTx(db, req.params.id, {
            amount: amountPaid,
            payment_method,
            payment_type: 'order_payment',
          }, req.user);
        } else {
          await syncOrderPaymentStateTx(db, req.params.id, req.user, { markDebtIfUnpaid: true });
        }
      }

      // Hoàn tác total_orders/total_spent (đã cộng khi tạo đơn) khi hủy đơn —
      // nếu không, khách bị tính tiền & số đơn cho đơn không bao giờ giặt
      if (isNewlyCancelled && order.customer_id) {
        const orderAmount = Number.parseFloat(order.final_amount ?? order.total_amount ?? 0) || 0;
        await db.execute(`
          UPDATE customers
          SET total_orders = GREATEST(total_orders - 1, 0),
              total_spent = GREATEST(total_spent - ?, 0)
          WHERE id = ?
        `, [orderAmount, order.customer_id]);
      }

      // Bỏ hủy (cancelled → trạng thái khác): cộng LẠI thống kê đã hoàn tác lúc
      // hủy — nếu không, đơn hủy nhầm rồi khôi phục sẽ thiếu vĩnh viễn trong
      // total_orders/total_spent của khách (lệch cả điều kiện khuyến mãi)
      const isNewlyUncancelled = order.status === 'cancelled' && status !== 'cancelled';
      if (isNewlyUncancelled && order.customer_id) {
        const orderAmount = Number.parseFloat(order.final_amount ?? order.total_amount ?? 0) || 0;
        await db.execute(`
          UPDATE customers
          SET total_orders = total_orders + 1,
              total_spent = total_spent + ?
          WHERE id = ?
        `, [orderAmount, order.customer_id]);
      }
      // Bỏ hủy: tính lại paid/debt/payment_status từ order_payments (lúc hủy đã
      // zero các trường nợ) — nhánh completed đã được sync ở khối phía trên
      if (isNewlyUncancelled && status !== 'completed') {
        await syncOrderPaymentStateTx(db, req.params.id, req.user);
      }
    });

    // Chính sách Zalo: khách chỉ nhận đúng 2 tin — (1) khi shop nhận đơn,
    // (2) khi nhân viên bấm "Chờ nhận" (đồ giặt xong). Không gửi tin khi
    // hoàn thành/giao hàng hay nhắc nợ để tránh làm phiền khách.
    if (status === 'waiting_pickup' && order.status !== 'waiting_pickup') {
      sendReadyForPickupNotification(req.params.id).catch((error) => {
        console.error('Ready for pickup Zalo notification failed:', error.message);
      });
    }

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
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
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

    // Lấy đủ thông tin để (1) kiểm tra chủ quyền chuỗi, (2) hoàn tác thống kê khách
    const order = await queryOne(`
      SELECT o.id, o.customer_id, o.final_amount, o.total_amount, o.status,
        s.admin_id AS store_admin_id,
        cs.admin_id AS creator_admin_id
      FROM orders o
      LEFT JOIN stores s ON o.store_id = s.id
      LEFT JOIN users cu ON o.created_by = cu.id
      LEFT JOIN stores cs ON cu.store_id = cs.id
      WHERE o.id = ?
    `, [req.params.id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Chặn xóa chéo tenant: đơn phải thuộc chuỗi cửa hàng của admin này
    // (theo store của đơn, fallback theo store của người tạo đơn).
    // ownerAdminId null = đơn legacy không xác định được chuỗi (store_id NULL
    // và người tạo cũng không gắn store) — cho phép xóa thay vì khóa vĩnh viễn
    const ownerAdminId = order.store_admin_id || order.creator_admin_id;
    if (ownerAdminId && ownerAdminId !== req.user.id) {
      return res.status(403).json({ error: 'Bạn chỉ có thể xóa đơn hàng trong chuỗi cửa hàng của mình' });
    }

    // Đơn đã có giao dịch thanh toán: xóa sẽ CASCADE mất order_payments (báo cáo
    // theo ngày mất tiền) trong khi tiền két + revenue ca đã chốt vẫn giữ —
    // 3 báo cáo lệch nhau vĩnh viễn. Bắt xử lý thanh toán trước.
    const hasPayments = await queryOne('SELECT 1 FROM order_payments WHERE order_id = ? LIMIT 1', [req.params.id]);
    if (hasPayments) {
      return res.status(400).json({
        error: 'Đơn đã có giao dịch thanh toán — không thể xóa (sổ quỹ két sẽ lệch). Hãy hủy đơn sau khi xử lý hoàn tiền.',
      });
    }

    await transaction(async (db) => {
      // Hoàn tác thống kê khách hàng (tạo đơn đã +1 và +tiền) — nếu không,
      // xóa đơn để lại total_orders/total_spent bị thổi phồng vĩnh viễn.
      // Đơn ĐÃ HỦY thì bỏ qua: lúc hủy đã hoàn tác rồi, hoàn tác lần 2 sẽ
      // ăn mất đóng góp của đơn khác (GREATEST che lỗi, không tự lành)
      if (order.customer_id && order.status !== 'cancelled') {
        const orderAmount = Number.parseFloat(order.final_amount ?? order.total_amount ?? 0) || 0;
        await db.execute(`
          UPDATE customers
          SET total_orders = GREATEST(total_orders - 1, 0),
              total_spent = GREATEST(total_spent - ?, 0)
          WHERE id = ?
        `, [orderAmount, order.customer_id]);
      }
      await db.execute('DELETE FROM orders WHERE id = ?', [req.params.id]);
    });

    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
