import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { validateId, validatePositiveInteger, validateEnum } from '../utils/validators.js';
import * as XLSX from 'xlsx';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helper function to get store_id from query param or token
function getStoreIdFilter(req) {
  const storeIdParam = req.query.store_id;
  if (storeIdParam && storeIdParam !== 'all' && storeIdParam !== '') {
    const storeIdValidation = validateId(storeIdParam);
    if (!storeIdValidation.valid) {
      return null; // Invalid store_id, return null
    }
    return storeIdValidation.value;
  }
  return req.user.store_id || null;
}

// Admin chỉ được dùng store_id thuộc chuỗi của mình. Nếu không thuộc thì coi như null (sẽ dùng adminStoresOnlyFilter).
// Employer luôn bị ép về store_id của chính họ - query param store_id KHÔNG được tin dùng,
// nếu không một employer có thể truyền ?store_id=<cửa hàng khác> để đọc báo cáo/doanh thu của cửa hàng đó (IDOR).
async function resolveStoreIdForAdmin(req) {
  if (req.user.role === 'employer') {
    return req.user.store_id || null;
  }

  let storeId = getStoreIdFilter(req);
  if (req.user.role === 'admin' && storeId) {
    const row = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeId, req.user.id]);
    if (!row) storeId = null; // store không thuộc admin => bỏ qua, dùng filter "chỉ cửa hàng của admin"
  }
  return storeId;
}

// SQL fragment + params for "admin without store_id": only stores owned by this admin
function adminStoresOnlyFilter(tableAlias = 'o') {
  const o = tableAlias;
  return {
    sql: ` AND (
      (${o}.store_id IS NOT NULL AND ${o}.store_id IN (SELECT id FROM stores WHERE admin_id = ?))
      OR (
        ${o}.store_id IS NULL AND (
          ${o}.assigned_to IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
          OR ${o}.created_by IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
        )
      )
    )`,
    params: (userId) => [userId, userId, userId]
  };
}

// Helper function to validate pagination params
function validatePagination(page, limit, maxLimit = 100) {
  const pageNum = parseInt(page) || 1;
  const limitNum = parseInt(limit) || 20;
  
  if (isNaN(pageNum) || pageNum < 1) {
    return { valid: false, error: 'Page phải là số nguyên dương' };
  }
  
  if (isNaN(limitNum) || limitNum < 1 || limitNum > maxLimit) {
    return { valid: false, error: `Limit phải là số từ 1 đến ${maxLimit}` };
  }
  
  return { valid: true, page: pageNum, limit: limitNum };
}

// Helper function to validate month and year (fallback to current month/year if missing)
function validateMonthYear(month, year) {
  const now = new Date();
  const monthNum = (month === undefined || month === null || month === '') ? now.getMonth() + 1 : parseInt(month, 10);
  const yearNum = (year === undefined || year === null || year === '') ? now.getFullYear() : parseInt(year, 10);
  if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
    return { valid: false, error: 'Tháng phải từ 1 đến 12' };
  }
  if (isNaN(yearNum) || yearNum < 2000 || yearNum > 2100) {
    return { valid: false, error: 'Năm phải từ 2000 đến 2100' };
  }
  return { valid: true, month: monthNum, year: yearNum };
}

// Get revenue by period (Admin/Employer)
router.get('/revenue', authorize('admin', 'employer'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [] });
    }

    const { period, start_date, end_date } = req.query;

    const periodValidation = validateEnum(period, ['day', 'month', 'year'], 'Period');
    if (!periodValidation.valid) {
      return res.status(400).json({ error: periodValidation.error });
    }

    // Validate date range if provided
    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: 'Ngày bắt đầu và ngày kết thúc không hợp lệ' });
      }
      if (start > end) {
        return res.status(400).json({ error: 'Ngày kết thúc phải sau ngày bắt đầu' });
      }
    }

    // Admin/Employer can access stores based on role (admin chỉ được store mình sở hữu)
    const storeId = await resolveStoreIdForAdmin(req);
    let querySql, groupBy, params;
    if (period === 'day') {
      querySql = `
        SELECT 
          DATE(COALESCE(o.debt_paid_at, o.updated_at)) as period,
          SUM(o.final_amount) as total_revenue,
          COUNT(*) as total_orders
        FROM orders o
        WHERE o.status = 'completed'
          AND (o.is_debt = 0 OR o.is_debt IS NULL OR o.debt_paid_at IS NOT NULL)
      `;
      params = [];
      
      // Build store filter based on role
      if (req.user.role === 'employer') {
        if (storeId) {
          querySql += ` AND (
            o.store_id = ?
            OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
          )`;
          params.push(storeId, req.user.id, req.user.id);
        } else {
          querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
          params.push(req.user.id, req.user.id);
        }
      } else if (req.user.role === 'admin' && storeId) {
        querySql += ` AND (
          o.store_id = ?
          OR (
            o.store_id IS NULL AND (
              o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
              OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
            )
          )
        )`;
        params.push(storeId, storeId, storeId);
      } else if (req.user.role === 'admin') {
        const { sql, params: p } = adminStoresOnlyFilter('o');
        querySql += sql;
        params.push(...p(req.user.id));
      }
      
      groupBy = 'DATE(COALESCE(o.debt_paid_at, o.updated_at))';
    } else if (period === 'month') {
      querySql = `
        SELECT 
          DATE_FORMAT(COALESCE(o.debt_paid_at, o.updated_at), '%Y-%m') as period,
          SUM(o.final_amount) as total_revenue,
          COUNT(*) as total_orders
        FROM orders o
        WHERE o.status = 'completed'
          AND (o.is_debt = 0 OR o.is_debt IS NULL OR o.debt_paid_at IS NOT NULL)
      `;
      params = [];
      
      // Build store filter based on role
      if (req.user.role === 'employer') {
        if (storeId) {
          querySql += ` AND (
            o.store_id = ?
            OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
          )`;
          params.push(storeId, req.user.id, req.user.id);
        } else {
          querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
          params.push(req.user.id, req.user.id);
        }
      } else if (req.user.role === 'admin' && storeId) {
        querySql += ` AND (
          o.store_id = ?
          OR (
            o.store_id IS NULL AND (
              o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
              OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
            )
          )
        )`;
        params.push(storeId, storeId, storeId);
      } else if (req.user.role === 'admin') {
        const { sql, params: p } = adminStoresOnlyFilter('o');
        querySql += sql;
        params.push(...p(req.user.id));
      }
      
      groupBy = 'DATE_FORMAT(COALESCE(o.debt_paid_at, o.updated_at), "%Y-%m")';
    } else {
      querySql = `
        SELECT 
          DATE_FORMAT(COALESCE(o.debt_paid_at, o.updated_at), '%Y') as period,
          SUM(o.final_amount) as total_revenue,
          COUNT(*) as total_orders
        FROM orders o
        WHERE o.status = 'completed'
          AND (o.is_debt = 0 OR o.is_debt IS NULL OR o.debt_paid_at IS NOT NULL)
      `;
      params = [];
      
      // Build store filter based on role
      if (req.user.role === 'employer') {
        if (storeId) {
          querySql += ` AND (
            o.store_id = ?
            OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
          )`;
          params.push(storeId, req.user.id, req.user.id);
        } else {
          querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
          params.push(req.user.id, req.user.id);
        }
      } else if (req.user.role === 'admin' && storeId) {
        querySql += ` AND (
          o.store_id = ?
          OR (
            o.store_id IS NULL AND (
              o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
              OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
            )
          )
        )`;
        params.push(storeId, storeId, storeId);
      } else if (req.user.role === 'admin') {
        const { sql, params: p } = adminStoresOnlyFilter('o');
        querySql += sql;
        params.push(...p(req.user.id));
      }
      
      groupBy = 'DATE_FORMAT(COALESCE(o.debt_paid_at, o.updated_at), "%Y")';
    }

    if (start_date && end_date) {
      querySql += ' AND DATE(COALESCE(o.debt_paid_at, o.updated_at)) >= ? AND DATE(COALESCE(o.debt_paid_at, o.updated_at)) <= ?';
      params.push(start_date, end_date);
    }

    querySql += ` GROUP BY ${groupBy} ORDER BY period`;

    const revenue = await query(querySql, params);
    res.json({ data: revenue });
  } catch (error) {
    console.error('Get revenue error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by product (Admin only)
router.get('/revenue-by-product', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [] });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    const storeId = await resolveStoreIdForAdmin(req);
    let querySql = `
      SELECT 
        p.id,
        p.name,
        p.unit,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.unit_price * oi.quantity) as total_revenue,
        COUNT(DISTINCT oi.order_id) as total_orders
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'completed'
    `;
    const params = [];
    
    if (req.user.role === 'employer') {
      if (storeId) {
        querySql += ` AND (o.store_id = ? OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?)))`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      querySql += ` AND (o.store_id = ? OR (o.store_id IS NULL AND (o.assigned_to IN (SELECT id FROM users WHERE store_id = ?) OR o.created_by IN (SELECT id FROM users WHERE store_id = ?))))`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }

    querySql += ' GROUP BY p.id, p.name, p.unit ORDER BY total_revenue DESC';

    const revenue = await query(querySql, params);
    res.json({ data: revenue });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by employee (Admin only)
router.get('/revenue-by-employee', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [] });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    const storeId = await resolveStoreIdForAdmin(req);
    let querySql = `
      SELECT 
        u.id,
        u.name,
        SUM(o.final_amount) as total_revenue,
        COUNT(*) as total_orders
      FROM orders o
      JOIN users u ON o.assigned_to = u.id
      WHERE o.status = 'completed'
    `;
    const params = [];
    
    if (req.user.role === 'admin' && storeId) {
      querySql += ` AND (o.store_id = ? OR (o.store_id IS NULL AND (o.assigned_to IN (SELECT id FROM users WHERE store_id = ?) OR o.created_by IN (SELECT id FROM users WHERE store_id = ?))))`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }

    querySql += ' GROUP BY u.id, u.name ORDER BY total_revenue DESC';

    const revenue = await query(querySql, params);
    res.json({ data: revenue });
  } catch (error) {
    console.error('Get revenue by employee error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get top customers (Admin only)
router.get('/top-customers', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [] });
    }

    const { limit = 10 } = req.query;

    // Validate limit
    const limitValidation = validatePositiveInteger(limit, false);
    if (!limitValidation.valid || limitValidation.value > 100) {
      return res.status(400).json({ error: 'Limit phải là số nguyên dương và không vượt quá 100' });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    const storeId = await resolveStoreIdForAdmin(req);
    let querySql = `
      SELECT 
        c.id,
        c.name,
        c.phone,
        SUM(o.final_amount) as total_spent,
        COUNT(*) as total_orders
      FROM customers c
      JOIN orders o ON c.id = o.customer_id
      WHERE o.status = 'completed'
    `;
    const params = [];
    
    if (req.user.role === 'admin' && storeId) {
      querySql += ` AND (o.store_id = ? OR (o.store_id IS NULL AND (o.assigned_to IN (SELECT id FROM users WHERE store_id = ?) OR o.created_by IN (SELECT id FROM users WHERE store_id = ?))))`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }

    querySql += ' GROUP BY c.id, c.name, c.phone ORDER BY total_spent DESC LIMIT ?';
    params.push(limitValidation.value);

    const customers = await query(querySql, params);
    res.json({ data: customers });
  } catch (error) {
    console.error('Get top customers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get top products (Admin only)
router.get('/top-products', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [] });
    }

    const { limit = 10 } = req.query;

    // Validate limit
    const limitValidation = validatePositiveInteger(limit, false);
    if (!limitValidation.valid || limitValidation.value > 100) {
      return res.status(400).json({ error: 'Limit phải là số nguyên dương và không vượt quá 100' });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    const storeId = await resolveStoreIdForAdmin(req);
    let querySql = `
      SELECT 
        p.id,
        p.name,
        p.unit,
        SUM(oi.quantity) as total_quantity,
        SUM(
          oi.unit_price * oi.quantity * 
          CASE 
            WHEN o.total_amount > 0 THEN o.final_amount / o.total_amount
            ELSE 1
          END
        ) as total_revenue,
        COUNT(DISTINCT oi.order_id) as total_orders
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'completed'
    `;
    const params = [];
    
    if (req.user.role === 'admin' && storeId) {
      querySql += ` AND (o.store_id = ? OR (o.store_id IS NULL AND (o.assigned_to IN (SELECT id FROM users WHERE store_id = ?) OR o.created_by IN (SELECT id FROM users WHERE store_id = ?))))`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }

    querySql += ' GROUP BY p.id, p.name, p.unit ORDER BY total_revenue DESC LIMIT ?';
    params.push(limitValidation.value);

    const products = await query(querySql, params);
    res.json({ data: products });
  } catch (error) {
    console.error('Get top products error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by store and day (Admin only)
router.get('/revenue-by-store', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [] });
    }

    const { month, year } = req.query;

    const monthYearValidation = validateMonthYear(month, year);
    if (!monthYearValidation.valid) {
      return res.status(400).json({ error: monthYearValidation.error });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    const monthStr = String(monthYearValidation.month).padStart(2, '0');
    const lastDay = new Date(monthYearValidation.year, monthYearValidation.month, 0).getDate();

    // Get revenue by store and day
    let querySql, revenueData;
    try {
      querySql = `
        SELECT 
          t.store_id,
          s.name as store_name,
          DATE(t.check_in) as work_date,
          SUM(t.revenue_amount) as daily_revenue,
          COUNT(DISTINCT t.user_id) as employee_count,
          COUNT(*) as shift_count
        FROM timesheets t
        JOIN stores s ON t.store_id = s.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE DATE_FORMAT(t.check_in, '%m') = ? 
          AND DATE_FORMAT(t.check_in, '%Y') = ?
          AND t.check_out IS NOT NULL
          AND t.revenue_amount > 0
          AND (u.role IS NULL OR u.role = 'employer')
      `;
      const params = [monthStr, monthYearValidation.year];
      
      const storeId = await resolveStoreIdForAdmin(req);
      if (storeId) {
        querySql += ' AND t.store_id = ?';
        params.push(storeId);
      } else if (req.user.role === 'admin') {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
      
      querySql += ' GROUP BY t.store_id, DATE(t.check_in) ORDER BY t.store_id, work_date';
      revenueData = await query(querySql, params);
    } catch (error) {
      // If stores table doesn't exist, query without JOIN
      // Warning log removed for security
      querySql = `
        SELECT 
          t.store_id,
          NULL as store_name,
          DATE(t.check_in) as work_date,
          SUM(t.revenue_amount) as daily_revenue,
          COUNT(DISTINCT t.user_id) as employee_count,
          COUNT(*) as shift_count
        FROM timesheets t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE DATE_FORMAT(t.check_in, '%m') = ? 
          AND DATE_FORMAT(t.check_in, '%Y') = ?
          AND t.check_out IS NOT NULL
          AND t.revenue_amount > 0
          AND (u.role IS NULL OR u.role = 'employer')
      `;
      const params = [monthStr, monthYearValidation.year];
      
      const storeId = await resolveStoreIdForAdmin(req);
      if (storeId) {
        querySql += ' AND t.store_id = ?';
        params.push(storeId);
      } else if (req.user.role === 'admin') {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
      
      querySql += ' GROUP BY t.store_id, DATE(t.check_in) ORDER BY t.store_id, work_date';
      revenueData = await query(querySql, params);
    }

    // Group by store
    const storeMap = {};
    revenueData.forEach((row) => {
      if (!storeMap[row.store_id]) {
        storeMap[row.store_id] = {
          store_id: row.store_id,
          store_name: row.store_name,
          daily_revenue: {},
          total_revenue: 0,
          total_shifts: 0,
        };
      }
      storeMap[row.store_id].daily_revenue[row.work_date] = {
        revenue: row.daily_revenue,
        employee_count: row.employee_count,
        shift_count: row.shift_count,
      };
      storeMap[row.store_id].total_revenue += row.daily_revenue;
      storeMap[row.store_id].total_shifts += row.shift_count;
    });

    // Convert to array and fill missing days
    const result = Object.values(storeMap).map((store) => {
      const dailyRevenue = {};
      for (let day = 1; day <= lastDay; day++) {
        const dateKey = `${monthYearValidation.year}-${monthStr}-${String(day).padStart(2, '0')}`;
        dailyRevenue[dateKey] = store.daily_revenue[dateKey] || {
          revenue: 0,
          employee_count: 0,
          shift_count: 0,
        };
      }
      return {
        ...store,
        daily_revenue: dailyRevenue,
      };
    });

    res.json({
      data: result,
      month: monthYearValidation.month,
      year: monthYearValidation.year,
      days_in_month: lastDay,
    });
  } catch (error) {
    console.error('Get revenue by store error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export reports (Admin only)
// Export reports to Excel
router.get('/export', authorize('admin', 'employer'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể export báo cáo' });
    }

    const { type, month, year, store_id } = req.query;
    
    if (!type) {
      return res.status(400).json({ error: 'Loại báo cáo là bắt buộc' });
    }

    const monthNum = parseInt(month) || new Date().getMonth() + 1;
    const yearNum = parseInt(year) || new Date().getFullYear();
    let storeId = await resolveStoreIdForAdmin(req);
    // Employers are always locked to their own store_id (see resolveStoreIdForAdmin);
    // only re-check the query param for admins, and only against their own chain.
    if (!storeId && store_id && store_id !== 'all' && req.user.role === 'admin') {
      const sid = parseInt(store_id);
      const row = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [sid, req.user.id]);
      if (row) storeId = sid;
    }

    let data = [];
    let fileName = '';
    let sheetName = '';

    switch (type) {
      case 'product':
        fileName = `BaoCao_SanPham_${monthNum}_${yearNum}.xlsx`;
        sheetName = 'Báo cáo sản phẩm';
        let productQuery = `
          SELECT 
            p.name as product_name,
            p.unit,
            SUM(oi.quantity) as total_quantity,
            SUM(oi.quantity * oi.unit_price) as total_revenue,
            COUNT(DISTINCT oi.order_id) as order_count
          FROM order_items oi
          JOIN products p ON oi.product_id = p.id
          JOIN orders o ON oi.order_id = o.id
          WHERE o.status = 'completed'
            AND DATE_FORMAT(o.updated_at, '%m') = ?
            AND DATE_FORMAT(o.updated_at, '%Y') = ?
        `;
        let productParams = [String(monthNum).padStart(2, '0'), yearNum];
        
        if (req.user.role === 'employer') {
          if (storeId) {
            productQuery += ` AND (
              o.store_id = ?
              OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
            )`;
            productParams.push(storeId, req.user.id, req.user.id);
          } else {
            productQuery += ' AND (o.assigned_to = ? OR o.created_by = ?)';
            productParams.push(req.user.id, req.user.id);
          }
        } else if (req.user.role === 'admin' && storeId) {
          productQuery += ` AND (
            o.store_id = ?
            OR (
              o.store_id IS NULL AND (
                o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
                OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
              )
            )
          )`;
          productParams.push(storeId, storeId, storeId);
        } else if (req.user.role === 'admin') {
          const { sql, params: p } = adminStoresOnlyFilter('o');
          productQuery += sql;
          productParams.push(...p(req.user.id));
        }
        
        productQuery += ' GROUP BY p.id, p.name, p.unit ORDER BY total_revenue DESC';
        
        const productData = await query(productQuery, productParams);
        data = productData.map(item => ({
          'Tên sản phẩm': item.product_name,
          'Đơn vị': item.unit,
          'Số lượng': parseFloat(item.total_quantity) || 0,
          'Doanh thu': parseFloat(item.total_revenue) || 0,
          'Số đơn': item.order_count || 0
        }));
        break;

      case 'category':
        fileName = `BaoCao_DanhMuc_${monthNum}_${yearNum}.xlsx`;
        sheetName = 'Báo cáo danh mục';
        let categoryQuery = `
          SELECT 
            p.unit as category,
            SUM(oi.quantity) as total_quantity,
            SUM(oi.quantity * oi.unit_price) as total_revenue,
            COUNT(DISTINCT oi.order_id) as order_count
          FROM order_items oi
          JOIN products p ON oi.product_id = p.id
          JOIN orders o ON oi.order_id = o.id
          WHERE o.status = 'completed'
            AND DATE_FORMAT(o.updated_at, '%m') = ?
            AND DATE_FORMAT(o.updated_at, '%Y') = ?
        `;
        let categoryParams = [String(monthNum).padStart(2, '0'), yearNum];
        
        if (req.user.role === 'employer') {
          if (storeId) {
            categoryQuery += ` AND (
              o.store_id = ?
              OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
            )`;
            categoryParams.push(storeId, req.user.id, req.user.id);
          } else {
            categoryQuery += ' AND (o.assigned_to = ? OR o.created_by = ?)';
            categoryParams.push(req.user.id, req.user.id);
          }
        } else if (req.user.role === 'admin' && storeId) {
          categoryQuery += ` AND (
            o.store_id = ?
            OR (
              o.store_id IS NULL AND (
                o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
                OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
              )
            )
          )`;
          categoryParams.push(storeId, storeId, storeId);
        } else if (req.user.role === 'admin') {
          const { sql, params: p } = adminStoresOnlyFilter('o');
          categoryQuery += sql;
          categoryParams.push(...p(req.user.id));
        }
        
        categoryQuery += ' GROUP BY p.unit ORDER BY total_revenue DESC';
        
        const categoryData = await query(categoryQuery, categoryParams);
        data = categoryData.map(item => ({
          'Danh mục': item.category,
          'Số lượng': parseFloat(item.total_quantity) || 0,
          'Doanh thu': parseFloat(item.total_revenue) || 0,
          'Số đơn': item.order_count || 0
        }));
        break;

      case 'shift':
        fileName = `BaoCao_Ca_${monthNum}_${yearNum}.xlsx`;
        sheetName = 'Báo cáo ca làm việc';
        let shiftQuery = `
          SELECT 
            CASE 
              WHEN HOUR(o.updated_at) >= 6 AND HOUR(o.updated_at) < 14 THEN 'Ca sáng'
              WHEN HOUR(o.updated_at) >= 14 AND HOUR(o.updated_at) < 22 THEN 'Ca chiều'
              ELSE 'Ca đêm'
            END as shift,
            SUM(o.final_amount) as total_revenue,
            COUNT(*) as order_count
          FROM orders o
          WHERE o.status = 'completed'
            AND DATE_FORMAT(o.updated_at, '%m') = ?
            AND DATE_FORMAT(o.updated_at, '%Y') = ?
        `;
        let shiftParams = [String(monthNum).padStart(2, '0'), yearNum];
        
        if (req.user.role === 'employer') {
          if (storeId) {
            shiftQuery += ` AND (
              o.store_id = ?
              OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
            )`;
            shiftParams.push(storeId, req.user.id, req.user.id);
          } else {
            shiftQuery += ' AND (o.assigned_to = ? OR o.created_by = ?)';
            shiftParams.push(req.user.id, req.user.id);
          }
        } else if (req.user.role === 'admin' && storeId) {
          shiftQuery += ` AND (
            o.store_id = ?
            OR (
              o.store_id IS NULL AND (
                o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
                OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
              )
            )
          )`;
          shiftParams.push(storeId, storeId, storeId);
        } else if (req.user.role === 'admin') {
          const { sql, params: p } = adminStoresOnlyFilter('o');
          shiftQuery += sql;
          shiftParams.push(...p(req.user.id));
        }
        
        shiftQuery += ' GROUP BY shift ORDER BY shift';
        
        const shiftData = await query(shiftQuery, shiftParams);
        data = shiftData.map(item => ({
          'Ca làm việc': item.shift,
          'Doanh thu': parseFloat(item.total_revenue) || 0,
          'Số đơn': item.order_count || 0
        }));
        break;

      case 'daily':
        fileName = `BaoCao_Ngay_${monthNum}_${yearNum}.xlsx`;
        sheetName = 'Báo cáo theo ngày';
        let dailyQuery = `
          SELECT 
            DATE(o.updated_at) as date,
            SUM(o.final_amount) as total_revenue,
            COUNT(*) as order_count
          FROM orders o
          WHERE o.status = 'completed'
            AND DATE_FORMAT(o.updated_at, '%m') = ?
            AND DATE_FORMAT(o.updated_at, '%Y') = ?
        `;
        let dailyParams = [String(monthNum).padStart(2, '0'), yearNum];
        
        if (req.user.role === 'employer') {
          if (storeId) {
            dailyQuery += ` AND (
              o.store_id = ?
              OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
            )`;
            dailyParams.push(storeId, req.user.id, req.user.id);
          } else {
            dailyQuery += ' AND (o.assigned_to = ? OR o.created_by = ?)';
            dailyParams.push(req.user.id, req.user.id);
          }
        } else if (req.user.role === 'admin' && storeId) {
          dailyQuery += ` AND (
            o.store_id = ?
            OR (
              o.store_id IS NULL AND (
                o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
                OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
              )
            )
          )`;
          dailyParams.push(storeId, storeId, storeId);
        } else if (req.user.role === 'admin') {
          const { sql, params: p } = adminStoresOnlyFilter('o');
          dailyQuery += sql;
          dailyParams.push(...p(req.user.id));
        }
        
        dailyQuery += ' GROUP BY DATE(o.updated_at) ORDER BY DATE(o.updated_at)';
        
        const dailyData = await query(dailyQuery, dailyParams);
        data = dailyData.map(item => ({
          'Ngày': item.date,
          'Doanh thu': parseFloat(item.total_revenue) || 0,
          'Số đơn': item.order_count || 0
        }));
        break;

      default:
        return res.status(400).json({ error: 'Loại báo cáo không hợp lệ' });
    }

    // Create workbook and worksheet
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(data);
    
    // Set column widths
    const maxWidth = 50;
    const colWidths = Object.keys(data[0] || {}).map(key => ({
      wch: Math.min(key.length + 5, maxWidth)
    }));
    worksheet['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Set headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

    res.send(buffer);
  } catch (error) {
    console.error('Export reports error:', error);
    res.status(500).json({ error: 'Lỗi khi export báo cáo' });
  }
});

// Root admin statistics - tổng quan hệ thống
router.get('/root/statistics', authorize('admin'), async (req, res) => {
  try {
    // Chỉ root admin mới có quyền truy cập
    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có quyền truy cập' });
    }

    // Tổng số admin (không tính root)
    const totalAdmins = await queryOne(`
      SELECT COUNT(*) as count 
      FROM users 
      WHERE role = 'admin' AND status = 'active'
    `);

    // Tổng số admin pending
    const pendingAdmins = await queryOne(`
      SELECT COUNT(*) as count 
      FROM users 
      WHERE role = 'admin' AND status = 'pending'
    `);

    // Tổng số khách hàng
    const totalCustomers = await queryOne(`
      SELECT COUNT(*) as count 
      FROM customers
    `);

    // Tổng số đơn hàng
    const totalOrders = await queryOne(`
      SELECT COUNT(*) as count 
      FROM orders
    `);

    // Tổng số đơn hàng hoàn thành
    const completedOrders = await queryOne(`
      SELECT COUNT(*) as count 
      FROM orders 
      WHERE status = 'completed'
    `);

    // Tổng doanh thu (từ đơn hàng hoàn thành)
    const totalRevenue = await queryOne(`
      SELECT COALESCE(SUM(final_amount), 0) as total 
      FROM orders 
      WHERE status = 'completed'
    `);

    // Doanh thu hôm nay (tính theo ngày hoàn thành)
    const todayRevenue = await queryOne(`
      SELECT COALESCE(SUM(final_amount), 0) as total 
      FROM orders 
      WHERE status = 'completed' 
        AND DATE(updated_at) = CURDATE()
    `);

    // Doanh thu tháng này (tính theo ngày hoàn thành)
    const monthRevenue = await queryOne(`
      SELECT COALESCE(SUM(final_amount), 0) as total 
      FROM orders 
      WHERE status = 'completed' 
        AND YEAR(updated_at) = YEAR(CURDATE())
        AND MONTH(updated_at) = MONTH(CURDATE())
    `);

    // Tổng số cửa hàng
    const totalStores = await queryOne(`
      SELECT COUNT(*) as count 
      FROM stores 
      WHERE status = 'active'
    `);

    // Tổng số sản phẩm
    const totalProducts = await queryOne(`
      SELECT COUNT(*) as count 
      FROM products 
      WHERE status = 'active'
    `);

    // Tổng số khuyến mãi đang hoạt động
    const activePromotions = await queryOne(`
      SELECT COUNT(*) as count 
      FROM promotions 
      WHERE status = 'active' 
        AND start_date <= CURDATE() 
        AND end_date >= CURDATE()
    `);

    // Thống kê theo admin (top 10 admin có nhiều đơn hàng nhất)
    const topAdmins = await query(`
      SELECT 
        u.id,
        u.name as admin_name,
        u.phone,
        u.subscription_package,
        u.subscription_expires_at,
        COUNT(DISTINCT s.id) as store_count,
        COUNT(DISTINCT o.id) as order_count,
        COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.final_amount ELSE 0 END), 0) as revenue
      FROM users u
      LEFT JOIN stores s ON s.admin_id = u.id
      LEFT JOIN orders o ON (
        o.assigned_to IN (SELECT id FROM users WHERE store_id = s.id)
        OR o.created_by IN (SELECT id FROM users WHERE store_id = s.id)
      )
      WHERE u.role = 'admin' AND u.status = 'active'
      GROUP BY u.id, u.name, u.phone, u.subscription_package, u.subscription_expires_at
      ORDER BY revenue DESC, order_count DESC
      LIMIT 10
    `);

    // Thống kê đơn hàng theo trạng thái
    const ordersByStatus = await query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM orders
      GROUP BY status
      ORDER BY count DESC
    `);

    // Thống kê gói đăng ký của admin
    const subscriptionPackages = await query(`
      SELECT 
        COALESCE(subscription_package, 'Không có') as package,
        COUNT(*) as count
      FROM users
      WHERE role = 'admin' AND status = 'active'
      GROUP BY subscription_package
      ORDER BY count DESC
    `);

    res.json({
      data: {
        overview: {
          totalAdmins: totalAdmins?.count || 0,
          pendingAdmins: pendingAdmins?.count || 0,
          totalCustomers: totalCustomers?.count || 0,
          totalOrders: totalOrders?.count || 0,
          completedOrders: completedOrders?.count || 0,
          totalRevenue: parseFloat(totalRevenue?.total || 0),
          todayRevenue: parseFloat(todayRevenue?.total || 0),
          monthRevenue: parseFloat(monthRevenue?.total || 0),
          totalStores: totalStores?.count || 0,
          totalProducts: totalProducts?.count || 0,
          activePromotions: activePromotions?.count || 0,
        },
        subscriptionPackages: subscriptionPackages || [],
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get revenue by product by day in month (Admin/Employer)
router.get('/revenue-by-product-daily', authorize('admin', 'employer'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    }

    const { month, year, page = 1, limit = 20 } = req.query;
    
    const monthYearValidation = validateMonthYear(month, year);
    if (!monthYearValidation.valid) {
      return res.status(400).json({ error: monthYearValidation.error });
    }

    const paginationValidation = validatePagination(page, limit);
    if (!paginationValidation.valid) {
      return res.status(400).json({ error: paginationValidation.error });
    }

    const monthStr = String(monthYearValidation.month).padStart(2, '0');
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    // Increase GROUP_CONCAT max length to ensure all employees are included
    await execute('SET SESSION group_concat_max_len = 10000');

    let querySql = `
      SELECT 
        DATE(o.updated_at) as date,
        p.id as product_id,
        p.name as product_name,
        p.unit as product_unit,
        SUM(oi.quantity) as total_quantity,
        SUM(
          oi.unit_price * oi.quantity * 
          CASE 
            WHEN o.total_amount > 0 THEN o.final_amount / o.total_amount
            ELSE 1
          END
        ) as total_revenue,
        COUNT(DISTINCT oi.order_id) as total_orders,
        GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') as employee_names,
        GROUP_CONCAT(DISTINCT COALESCE(e_shift.name, u_shift.name) ORDER BY COALESCE(e_shift.name, u_shift.name) SEPARATOR ', ') as shift_employee_names
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users u_store ON COALESCE(o.assigned_to, o.created_by) = u_store.id
      LEFT JOIN timesheets t ON (
        t.store_id = u_store.store_id 
        AND o.updated_at >= t.check_in 
        AND o.updated_at <= COALESCE(t.check_out, NOW())
        AND DATE(t.check_in) = DATE(o.updated_at)
      )
      LEFT JOIN employees e_shift ON t.employee_id = e_shift.id
      LEFT JOIN users u_shift ON t.user_id = u_shift.id
      WHERE o.status = 'completed'
        AND DATE_FORMAT(o.updated_at, '%m') = ?
        AND DATE_FORMAT(o.updated_at, '%Y') = ?
    `;
    const params = [monthStr, monthYearValidation.year];
    
    const storeId = await resolveStoreIdForAdmin(req);
    
    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        // Employer with store_id: filter by store_id OR by user's orders (for legacy orders without store_id)
        querySql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        // Employer without store_id: filter by their own orders
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      // Admin filtering by specific store
      querySql += ` AND (
        o.store_id = ?
        OR (
          o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
            OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
          )
        )
      )`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }
    

    querySql += ' GROUP BY DATE(o.updated_at), p.id, p.name, p.unit ORDER BY date DESC, total_revenue DESC';
    
    // Get total count (remove GROUP BY/ORDER BY so COUNT returns one row with correct total)
    const countSql = querySql
      .replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(DISTINCT CONCAT(DATE(o.updated_at), "-", p.id)) as total FROM')
      .replace(/\s*ORDER BY[\s\S]*$/, '')
      .replace(/\s*GROUP BY[\s\S]*$/i, '');
    const countResult = await queryOne(countSql, params);
    const total = countResult?.total || 0;

    // Add pagination
    querySql += ` LIMIT ? OFFSET ?`;
    params.push(paginationValidation.limit, offset);

    const data = await query(querySql, params);

    res.json({
      data,
      pagination: {
        page: paginationValidation.page,
        limit: paginationValidation.limit,
        total,
        totalPages: Math.ceil(total / paginationValidation.limit)
      }
    });
  } catch (error) {

    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by category (using product name as category) by day in month
router.get('/revenue-by-category-daily', authorize('admin', 'employer'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    }

    const { month, year, page = 1, limit = 20 } = req.query;
    
    const monthYearValidation = validateMonthYear(month, year);
    if (!monthYearValidation.valid) {
      return res.status(400).json({ error: monthYearValidation.error });
    }

    const paginationValidation = validatePagination(page, limit);
    if (!paginationValidation.valid) {
      return res.status(400).json({ error: paginationValidation.error });
    }

    const monthStr = String(monthYearValidation.month).padStart(2, '0');
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    // Increase GROUP_CONCAT max length to ensure all employees are included
    await execute('SET SESSION group_concat_max_len = 10000');

    let querySql = `
      SELECT 
        DATE(o.updated_at) as date,
        p.name as category,
        SUM(oi.quantity) as total_quantity,
        SUM(
          oi.unit_price * oi.quantity * 
          CASE 
            WHEN o.total_amount > 0 THEN o.final_amount / o.total_amount
            ELSE 1
          END
        ) as total_revenue,
        COUNT(DISTINCT oi.order_id) as total_orders,
        GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') as employee_names,
        GROUP_CONCAT(DISTINCT COALESCE(e_shift.name, u_shift.name) ORDER BY COALESCE(e_shift.name, u_shift.name) SEPARATOR ', ') as shift_employee_names
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users u_store ON COALESCE(o.assigned_to, o.created_by) = u_store.id
      LEFT JOIN timesheets t ON (
        t.store_id = u_store.store_id 
        AND o.updated_at >= t.check_in 
        AND o.updated_at <= COALESCE(t.check_out, NOW())
        AND DATE(t.check_in) = DATE(o.updated_at)
      )
      LEFT JOIN employees e_shift ON t.employee_id = e_shift.id
      LEFT JOIN users u_shift ON t.user_id = u_shift.id
      WHERE o.status = 'completed'
        AND DATE_FORMAT(o.updated_at, '%m') = ?
        AND DATE_FORMAT(o.updated_at, '%Y') = ?
    `;
    const params = [monthStr, monthYearValidation.year];
    
    const storeId = await resolveStoreIdForAdmin(req);
    
    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        // Employer with store_id: filter by store_id OR by user's orders (for legacy orders without store_id)
        querySql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        // Employer without store_id: filter by their own orders
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      // Admin filtering by specific store
      querySql += ` AND (
        o.store_id = ?
        OR (
          o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
            OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
          )
        )
      )`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }

    querySql += ' GROUP BY DATE(o.updated_at), p.name ORDER BY date DESC, total_revenue DESC';
    
    const countSql = querySql
      .replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(DISTINCT CONCAT(DATE(o.updated_at), "-", p.name)) as total FROM')
      .replace(/\s*ORDER BY[\s\S]*$/, '')
      .replace(/\s*GROUP BY[\s\S]*$/i, '');
    const countResult = await queryOne(countSql, params);
    const total = countResult?.total || 0;

    querySql += ` LIMIT ? OFFSET ?`;
    params.push(paginationValidation.limit, offset);

    const data = await query(querySql, params);

    res.json({
      data,
      pagination: {
        page: paginationValidation.page,
        limit: paginationValidation.limit,
        total,
        totalPages: Math.ceil(total / paginationValidation.limit)
      }
    });
  } catch (error) {
    console.error('Get revenue by category daily error:', error);
    console.error('User role:', req.user?.role, 'Store ID:', req.user?.store_id);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by employee by day in month
router.get('/revenue-by-employee-daily', authorize('admin', 'employer'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    }

    const { month, year, page = 1, limit = 20 } = req.query;
    
    const monthYearValidation = validateMonthYear(month, year);
    if (!monthYearValidation.valid) {
      return res.status(400).json({ error: monthYearValidation.error });
    }

    const paginationValidation = validatePagination(page, limit);
    if (!paginationValidation.valid) {
      return res.status(400).json({ error: paginationValidation.error });
    }

    const monthStr = String(monthYearValidation.month).padStart(2, '0');
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    let querySql = `
      SELECT 
        DATE(o.updated_at) as date,
        u.id as employee_id,
        u.name as employee_name,
        SUM(o.final_amount) as total_revenue,
        COUNT(*) as total_orders
      FROM orders o
      JOIN users u ON o.assigned_to = u.id
      WHERE o.status = 'completed'
        AND DATE_FORMAT(o.updated_at, '%m') = ?
        AND DATE_FORMAT(o.updated_at, '%Y') = ?
    `;
    const params = [monthStr, monthYearValidation.year];
    
    const storeId = await resolveStoreIdForAdmin(req);
    
    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        querySql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      querySql += ` AND (
        o.store_id = ?
        OR (
          o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
            OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
          )
        )
      )`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      // No specific store selected - unlike the branch above, this was missing
      // entirely, so an admin viewing "all stores" saw every admin's data.
      const filter = adminStoresOnlyFilter('o');
      querySql += filter.sql;
      params.push(...filter.params(req.user.id));
    }

    querySql += ' GROUP BY DATE(o.updated_at), u.id, u.name ORDER BY date DESC, total_revenue DESC';
    
    const countSql = querySql
      .replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(DISTINCT CONCAT(DATE(o.updated_at), "-", u.id)) as total FROM')
      .replace(/\s*ORDER BY[\s\S]*$/, '')
      .replace(/\s*GROUP BY[\s\S]*$/i, '');
    const countResult = await queryOne(countSql, params);
    const total = countResult?.total || 0;

    querySql += ` LIMIT ? OFFSET ?`;
    params.push(paginationValidation.limit, offset);

    const data = await query(querySql, params);

    res.json({
      data,
      pagination: {
        page: paginationValidation.page,
        limit: paginationValidation.limit,
        total,
        totalPages: Math.ceil(total / paginationValidation.limit)
      }
    });
  } catch (error) {
    console.error('Get revenue by employee daily error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by payment method by day in month
router.get('/revenue-by-payment-daily', authorize('admin'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    }

    const { month, year, page = 1, limit = 20 } = req.query;
    
    const monthYearValidation = validateMonthYear(month, year);
    if (!monthYearValidation.valid) {
      return res.status(400).json({ error: monthYearValidation.error });
    }

    const paginationValidation = validatePagination(page, limit);
    if (!paginationValidation.valid) {
      return res.status(400).json({ error: paginationValidation.error });
    }

    const monthStr = String(monthYearValidation.month).padStart(2, '0');
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    // Increase GROUP_CONCAT max length to ensure all employees are included
    await execute('SET SESSION group_concat_max_len = 10000');

    // Group by payment method (cash or transfer)
    let querySql = `
      SELECT 
        DATE(o.updated_at) as date,
        COALESCE(
          CASE 
            WHEN o.payment_method = 'cash' THEN 'Tiền mặt'
            WHEN o.payment_method = 'transfer' THEN 'Chuyển khoản'
            ELSE 'Tiền mặt'
          END,
          'Tiền mặt'
        ) as payment_method,
        SUM(COALESCE(o.final_amount, o.total_amount, 0)) as total_revenue,
        COUNT(*) as total_orders,
        GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') as employee_names,
        GROUP_CONCAT(DISTINCT COALESCE(e_shift.name, u_shift.name) ORDER BY COALESCE(e_shift.name, u_shift.name) SEPARATOR ', ') as shift_employee_names
      FROM orders o
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users u_store ON COALESCE(o.assigned_to, o.created_by) = u_store.id
      LEFT JOIN timesheets t ON (
        t.store_id = u_store.store_id 
        AND o.updated_at >= t.check_in 
        AND o.updated_at <= COALESCE(t.check_out, NOW())
        AND DATE(t.check_in) = DATE(o.updated_at)
      )
      LEFT JOIN employees e_shift ON t.employee_id = e_shift.id
      LEFT JOIN users u_shift ON t.user_id = u_shift.id
      WHERE o.status = 'completed'
        AND DATE_FORMAT(o.updated_at, '%m') = ?
        AND DATE_FORMAT(o.updated_at, '%Y') = ?
    `;
    const params = [monthStr, monthYearValidation.year];
    
    const storeId = await resolveStoreIdForAdmin(req);
    
    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        querySql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      querySql += ` AND (
        o.store_id = ?
        OR (
          o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
            OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
          )
        )
      )`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }

    querySql += ' GROUP BY DATE(o.updated_at), o.payment_method ORDER BY date DESC, payment_method';
    
    // Rows are per (date, payment_method) pair - counting distinct dates only
    // undercounts and produces a wrong totalPages whenever a day has both
    // cash and transfer orders.
    const countSql = querySql
      .replace(/SELECT[\s\S]*?FROM/, "SELECT COUNT(DISTINCT CONCAT(DATE(o.updated_at), '-', o.payment_method)) as total FROM")
      .replace(/\s*ORDER BY[\s\S]*$/, '')
      .replace(/\s*GROUP BY[\s\S]*$/i, '');
    const countResult = await queryOne(countSql, params);
    const total = countResult?.total || 0;

    querySql += ` LIMIT ? OFFSET ?`;
    params.push(paginationValidation.limit, offset);

    const data = await query(querySql, params);

    res.json({
      data,
      pagination: {
        page: paginationValidation.page,
        limit: paginationValidation.limit,
        total,
        totalPages: Math.ceil(total / paginationValidation.limit)
      }
    });
  } catch (error) {
    console.error('Get revenue by payment daily error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// NOTE: Duplicate routes below (815, 877, 937) have been removed - using routes above (522, 601, 676) instead

// Get revenue by shift daily (grouped by day and employee)
router.get('/revenue-by-shift-daily', authorize('admin', 'employer'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    }

    const { month, year, page = 1, limit = 20 } = req.query;
    
    const monthYearValidation = validateMonthYear(month, year);
    if (!monthYearValidation.valid) {
      return res.status(400).json({ error: monthYearValidation.error });
    }

    const paginationValidation = validatePagination(page, limit);
    if (!paginationValidation.valid) {
      return res.status(400).json({ error: paginationValidation.error });
    }

    const monthStr = String(monthYearValidation.month).padStart(2, '0');
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    let querySql = `
      SELECT 
        DATE(t.check_in) as date,
        t.user_id,
        COALESCE(e.name, u.name) as employee_name,
        t.id as shift_id,
        TIME(t.check_in) as check_in_time,
        TIME(t.check_out) as check_out_time,
        t.expected_revenue as start_revenue,
        t.revenue_amount as end_revenue,
        COALESCE(t.withdrawn_amount, 0) as withdrawn_amount,
        t.note,
        t.regular_hours,
        t.overtime_hours
      FROM timesheets t
      LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE DATE_FORMAT(t.check_in, '%m') = ?
        AND DATE_FORMAT(t.check_in, '%Y') = ?
        AND t.check_out IS NOT NULL
    `;
    const params = [monthStr, monthYearValidation.year];
    
    const storeId = await resolveStoreIdForAdmin(req);
    if (storeId) {
      querySql += ' AND t.store_id = ?';
      params.push(storeId);
    } else if (req.user.role === 'employer') {
      // Employer without store_id: filter by their own timesheets
      querySql += ' AND t.user_id = ?';
      params.push(req.user.id);
    } else if (req.user.role === 'admin') {
      querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
      params.push(req.user.id);
    }

    querySql += ' ORDER BY date DESC, COALESCE(e.name, u.name), t.check_in DESC';
    
    const countSql = querySql.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM').replace(/\s*ORDER BY[\s\S]*$/, '');
    const countResult = await queryOne(countSql, params);
    const total = countResult?.total || 0;

    querySql += ` LIMIT ? OFFSET ?`;
    params.push(paginationValidation.limit, offset);

    const data = await query(querySql, params);

    res.json({
      data,
      pagination: {
        page: paginationValidation.page,
        limit: paginationValidation.limit,
        total,
        totalPages: Math.ceil(total / paginationValidation.limit)
      }
    });
  } catch (error) {
    console.error('Get revenue by shift daily error:', error);
    console.error('User role:', req.user?.role, 'Store ID:', req.user?.store_id);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by day in month (simple daily revenue list)
router.get('/revenue-daily', authorize('admin', 'employer'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [], pagination: { page: 1, limit: 31, total: 0, totalPages: 0 } });
    }

    const { month, year } = req.query;
    
    const monthYearValidation = validateMonthYear(month, year);
    if (!monthYearValidation.valid) {
      return res.status(400).json({ error: monthYearValidation.error });
    }

    const monthStr = String(monthYearValidation.month).padStart(2, '0');
    const lastDay = new Date(monthYearValidation.year, monthYearValidation.month, 0).getDate();

    // Get revenue by day for the month, split by payment method
    const storeId = await resolveStoreIdForAdmin(req);
    
    let querySql = `
      SELECT 
        DATE(o.updated_at) as date,
        SUM(o.final_amount) as total_revenue,
        SUM(CASE WHEN o.payment_method = 'cash' OR o.payment_method IS NULL THEN o.final_amount ELSE 0 END) as cash_revenue,
        SUM(CASE WHEN o.payment_method = 'transfer' THEN o.final_amount ELSE 0 END) as transfer_revenue,
        COUNT(*) as total_orders
      FROM orders o
      WHERE o.status = 'completed'
        AND DATE_FORMAT(o.updated_at, '%m') = ?
        AND DATE_FORMAT(o.updated_at, '%Y') = ?
    `;
    const params = [monthStr, monthYearValidation.year];

    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        // Employer with store_id: filter by store_id OR by user's orders (for legacy orders without store_id)
        querySql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        // Employer without store_id: filter by their own orders
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      // Admin filtering by specific store
      querySql += ` AND (
        o.store_id = ?
        OR (
          o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
            OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
          )
        )
      )`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }

    querySql += ' GROUP BY DATE(o.updated_at) ORDER BY date DESC';

    const revenueData = await query(querySql, params);

    // Tổng tiền đã rút = tổng withdrawn_amount của mỗi nhân viên mỗi ca trong ngày (từ timesheets)
    let withdrawnSql = `
      SELECT 
        DATE(t.check_in) as date,
        COALESCE(SUM(t.withdrawn_amount), 0) as total_withdrawn
      FROM timesheets t
      WHERE t.check_out IS NOT NULL
        AND DATE_FORMAT(t.check_in, '%m') = ?
        AND DATE_FORMAT(t.check_in, '%Y') = ?
    `;
    const withdrawnParams = [monthStr, monthYearValidation.year];
    if (storeId) {
      withdrawnSql += ' AND t.store_id = ?';
      withdrawnParams.push(storeId);
    } else if (req.user.role === 'employer') {
      withdrawnSql += ' AND t.user_id = ?';
      withdrawnParams.push(req.user.id);
    } else if (req.user.role === 'admin') {
      withdrawnSql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
      withdrawnParams.push(req.user.id);
    }
    withdrawnSql += ' GROUP BY DATE(t.check_in)';
    const withdrawnData = await query(withdrawnSql, withdrawnParams);
    const withdrawnMap = {};
    withdrawnData.forEach((row) => {
      const dateKey = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date).split(' ')[0];
      withdrawnMap[dateKey] = parseFloat(row.total_withdrawn) || 0;
    });

    // Ghi chú theo ngày: lấy từ timesheets (check-out có ghi chú), gộp theo ngày (chỉ ghi chú không rỗng)
    let notesSql = `
      SELECT 
        DATE(t.check_in) as date,
        GROUP_CONCAT(NULLIF(TRIM(COALESCE(t.note, '')), '') SEPARATOR ' | ') as day_notes
      FROM timesheets t
      WHERE t.check_out IS NOT NULL
        AND DATE_FORMAT(t.check_in, '%m') = ?
        AND DATE_FORMAT(t.check_in, '%Y') = ?
    `;
    const notesParams = [monthStr, monthYearValidation.year];
    if (storeId) {
      notesSql += ' AND t.store_id = ?';
      notesParams.push(storeId);
    } else if (req.user.role === 'employer') {
      notesSql += ' AND t.user_id = ?';
      notesParams.push(req.user.id);
    } else if (req.user.role === 'admin') {
      notesSql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
      notesParams.push(req.user.id);
    }
    notesSql += ' GROUP BY DATE(t.check_in)';
    const notesData = await query(notesSql, notesParams);
    const notesMap = {};
    notesData.forEach((row) => {
      const dateKey = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date).split(' ')[0];
      const notes = (row.day_notes || '').trim();
      notesMap[dateKey] = notes || null;
    });

    // Debug: Check if there are any completed orders in this month
    const debugQuery = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN o.store_id = ? THEN 1 END) as with_store_id,
        COUNT(CASE WHEN o.store_id IS NULL THEN 1 END) as null_store_id,
        COUNT(CASE WHEN o.store_id IS NOT NULL AND o.store_id != ? THEN 1 END) as other_store_id
      FROM orders o
      WHERE o.status = 'completed'
        AND DATE_FORMAT(o.updated_at, '%m') = ?
        AND DATE_FORMAT(o.updated_at, '%Y') = ?
    `;
    const debugResult = await queryOne(debugQuery, [storeId || 0, storeId || 0, monthStr, monthYearValidation.year]);
    
    // Debug: Check if there are ANY completed orders in database (any month)
    const allOrdersQuery = `
      SELECT 
        COUNT(*) as total,
        MIN(DATE_FORMAT(o.updated_at, '%Y-%m')) as earliest_month,
        MAX(DATE_FORMAT(o.updated_at, '%Y-%m')) as latest_month,
        COUNT(CASE WHEN o.store_id = ? THEN 1 END) as with_store_id,
        COUNT(CASE WHEN o.store_id IS NULL THEN 1 END) as null_store_id
      FROM orders o
      WHERE o.status = 'completed'
    `;
    const allOrdersResult = await queryOne(allOrdersQuery, [storeId || 0]);
    
    // Debug: Check orders with NULL store_id that might match
    if (storeId) {
      const nullStoreDebugQuery = `
        SELECT COUNT(*) as total
        FROM orders o
        WHERE o.status = 'completed'
          AND DATE_FORMAT(o.updated_at, '%m') = ?
          AND DATE_FORMAT(o.updated_at, '%Y') = ?
          AND o.store_id IS NULL
          AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
            OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
          )
      `;
      const nullStoreResult = await queryOne(nullStoreDebugQuery, [monthStr, monthYearValidation.year, storeId, storeId]);
    }

    // Create a map of date -> revenue for quick lookup
    // MySQL DATE() returns date as string in YYYY-MM-DD format
    const revenueMap = {};
    revenueData.forEach((row) => {
      const dateKey = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date).split(' ')[0];
      revenueMap[dateKey] = {
        total_revenue: parseFloat(row.total_revenue) || 0,
        cash_revenue: parseFloat(row.cash_revenue) || 0,
        transfer_revenue: parseFloat(row.transfer_revenue) || 0,
        total_orders: parseInt(row.total_orders) || 0,
      };
    });

    // Fill all days in the month; total_withdrawn và ghi chú lấy từ timesheets
    const result = [];
    for (let day = lastDay; day >= 1; day--) {
      const dateStr = `${monthYearValidation.year}-${monthStr}-${String(day).padStart(2, '0')}`;
      const revenueInfo = revenueMap[dateStr] || { total_revenue: 0, cash_revenue: 0, transfer_revenue: 0, total_orders: 0 };
      result.push({
        date: dateStr,
        day: day,
        total_revenue: revenueInfo.total_revenue,
        cash_revenue: revenueInfo.cash_revenue,
        transfer_revenue: revenueInfo.transfer_revenue,
        total_withdrawn: withdrawnMap[dateStr] ?? 0,
        total_orders: revenueInfo.total_orders,
        day_notes: notesMap[dateStr] ?? null,
      });
    }

    // Calculate totals
    const totalRevenue = result.reduce((sum, day) => sum + day.total_revenue, 0);
    const totalCash = result.reduce((sum, day) => sum + day.cash_revenue, 0);
    const totalTransfer = result.reduce((sum, day) => sum + day.transfer_revenue, 0);
    const totalWithdrawn = result.reduce((sum, day) => sum + day.total_withdrawn, 0);
    const totalOrders = result.reduce((sum, day) => sum + day.total_orders, 0);

    res.json({
      data: result,
      summary: {
        total_revenue: totalRevenue,
        total_cash: totalCash,
        total_transfer: totalTransfer,
        total_withdrawn: totalWithdrawn,
        total_orders: totalOrders,
        average_daily_revenue: totalRevenue / lastDay,
      },
      month: monthYearValidation.month,
      year: monthYearValidation.year,
      days_in_month: lastDay,
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get invoices (orders) by day in month
router.get('/invoices-daily', authorize('admin', 'employer'), async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    }

    const { month, year, page = 1, limit = 20 } = req.query;
    
    const monthYearValidation = validateMonthYear(month, year);
    if (!monthYearValidation.valid) {
      return res.status(400).json({ error: monthYearValidation.error });
    }

    const paginationValidation = validatePagination(page, limit);
    if (!paginationValidation.valid) {
      return res.status(400).json({ error: paginationValidation.error });
    }

    const monthStr = String(monthYearValidation.month).padStart(2, '0');
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    // Invoices daily shows all orders (not just completed) by creation date
    // This is different from revenue reports which use updated_at (completion date)
    let querySql = `
      SELECT 
        DATE(o.created_at) as date,
        o.id as order_id,
        o.code as order_code,
        c.name as customer_name,
        c.phone as customer_phone,
        o.final_amount as total_amount,
        o.status,
        u.name as employee_name,
        COALESCE(e_shift.name, u_shift.name) as shift_employee_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users u_store ON COALESCE(o.assigned_to, o.created_by) = u_store.id
      LEFT JOIN timesheets t ON (
        t.store_id = u_store.store_id 
        AND o.created_at >= t.check_in 
        AND o.created_at <= COALESCE(t.check_out, NOW())
        AND DATE(t.check_in) = DATE(o.created_at)
      )
      LEFT JOIN employees e_shift ON t.employee_id = e_shift.id
      LEFT JOIN users u_shift ON t.user_id = u_shift.id
      WHERE DATE_FORMAT(o.created_at, '%m') = ?
        AND DATE_FORMAT(o.created_at, '%Y') = ?
    `;
    const params = [monthStr, monthYearValidation.year];
    
    const storeId = await resolveStoreIdForAdmin(req);
    
    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        querySql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        querySql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      querySql += ` AND (
        o.store_id = ?
        OR (
          o.store_id IS NULL AND (
            o.assigned_to IN (SELECT id FROM users WHERE store_id = ?)
            OR o.created_by IN (SELECT id FROM users WHERE store_id = ?)
          )
        )
      )`;
      params.push(storeId, storeId, storeId);
    } else if (req.user.role === 'admin') {
      const { sql, params: p } = adminStoresOnlyFilter('o');
      querySql += sql;
      params.push(...p(req.user.id));
    }

    querySql += ' ORDER BY date DESC, o.created_at DESC';
    
    const countSql = querySql.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM').replace(/\s*ORDER BY[\s\S]*$/, '');
    const countResult = await queryOne(countSql, params);
    const total = countResult?.total || 0;

    querySql += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const data = await query(querySql, params);

    res.json({
      data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get invoices daily error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
