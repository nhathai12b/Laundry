import express from 'express';
import { query, queryOne } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { blockEmployeeLogin } from '../middleware/auth.js';
import { validateId, validatePositiveInteger, validateEnum } from '../utils/validators.js';
import { formatDateTimeUTC } from '../utils/helpers.js';
import { buildDailyBusinessReport } from '../services/dailyBusinessReportService.js';
import { resolveCurrentStoreId } from '../services/workingStoreService.js';
import { getShiftPaymentSummaryDeduped, parseTimesheetDateTimeMsCompat } from './timesheets.js';
import * as XLSX from 'xlsx';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helper function to get store_id from query param or token
async function getStoreIdFilter(req) {
  // Employer/employee token: LUÔN dùng cửa hàng ĐANG LÀM VIỆC (ca đang mở) —
  // không nhận store_id từ query để tránh tài khoản tiệm A đọc doanh thu/tiền
  // két của tiệm B — luôn là cửa hàng của tài khoản.
  if (req.user.role !== 'admin' && req.user.role !== 'root') {
    return await resolveCurrentStoreId(req.user);
  }
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

async function resolveStoreIdForAdmin(req) {
  let storeId = await getStoreIdFilter(req);
  if (req.user.role === 'admin' && storeId) {
    const row = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeId, req.user.id]);
    if (!row) storeId = null;
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

function getTimezoneOffsetMinutes(req) {
  const offset = Number.parseInt(req.query.timezone_offset_minutes ?? '0', 10);
  if (Number.isNaN(offset) || offset < -840 || offset > 840) return 0;
  return offset;
}

function localDateSql(column, offsetMinutes) {
  return `DATE(DATE_SUB(${column}, INTERVAL ${offsetMinutes} MINUTE))`;
}

// Cột DATE → 'YYYY-MM-DD' (pool timezone 'Z': mysql2 trả Date lúc 00:00Z)
function sqlDateKey(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Gắn shift_employee_names (ai đứng ca lúc giao dịch của dòng diễn ra) cho CÁC
// DÒNG TRÊN TRANG. Trước đây là subquery tương quan trong SELECT, chạy cho MỌI
// dòng order_items của cả tháng TRƯỚC GROUP BY/LIMIT, mỗi lần quét toàn bộ ca
// của tiệm bằng điều kiện không dùng được index — đo được ~30 giây/lần mở báo
// cáo với 3 tiệm × 2 năm dữ liệu. Giờ: 1 truy vấn, giới hạn theo ngày + nhóm
// trên trang. `fromSql` phải có alias u_store (tài khoản của đơn) như truy vấn chính.
// Cận dưới check_in > eventAt − 1 ngày không đổi kết quả (cùng ngày local và vào
// ca trước giao dịch ⇒ cách nhau < 24h) nhưng cho phép dùng index (store_id, check_in).
async function attachShiftEmployeeNames(rows, {
  fromSql, whereSql, whereParams, eventAt, dateExpr, groupExpr, rowGroupKey, timezoneOffset,
}) {
  if (!rows.length) return;
  // GROUP BY p.name theo collation _ci (không phân biệt hoa/thường, dấu, khoảng
  // trắng cuối) — khóa ghép phía JS phải chuẩn hóa tương tự mới khớp
  const norm = (v) => String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trimEnd();
  const dates = [...new Set(rows.map((r) => sqlDateKey(r.date)))];
  const groups = [...new Set(rows.map(rowGroupKey))];
  const found = await query(`
    SELECT DISTINCT DATE_FORMAT(${dateExpr}, '%Y-%m-%d') AS d, ${groupExpr} AS g,
      COALESCE(e2.name, u2.name) AS name
    ${fromSql}
    JOIN timesheets t2 ON t2.store_id = u_store.store_id
      AND t2.check_in <= ${eventAt}
      AND t2.check_in > DATE_SUB(${eventAt}, INTERVAL 1 DAY)
      AND ${eventAt} <= COALESCE(t2.check_out, NOW())
      AND ${localDateSql('t2.check_in', timezoneOffset)} = ${dateExpr}
    LEFT JOIN employees e2 ON t2.employee_id = e2.id
    LEFT JOIN users u2 ON t2.user_id = u2.id
    ${whereSql}
      AND ${dateExpr} IN (?)
      AND ${groupExpr} IN (?)
  `, [...whereParams, dates, groups]);
  const byKey = new Map();
  for (const f of found) {
    if (!f.name) continue;
    const key = `${f.d}|${norm(f.g)}`;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(f.name);
  }
  for (const r of rows) {
    const names = byKey.get(`${sqlDateKey(r.date)}|${norm(rowGroupKey(r))}`);
    r.shift_employee_names = names ? [...names].sort((a, b) => a.localeCompare(b, 'vi')).join(', ') : null;
  }
}

function isoToMysqlUtc(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTimeUTC(date);
}

function getUtcRangeFromQuery(req, month, year) {
  if (req.query.start_at && req.query.end_at) {
    const startAt = isoToMysqlUtc(req.query.start_at);
    const endAt = isoToMysqlUtc(req.query.end_at);
    if (startAt && endAt) return { startAt, endAt };
  }

  if (req.query.start_date && req.query.end_date) {
    // Mốc ngày phải quy đổi theo MÚI GIỜ CLIENT (như nhánh month/year bên dưới)
    // — parse "T00:00:00" theo giờ server (UTC trên VPS) làm rớt các khoản
    // 00:00–07:00 VN của ngày đầu kỳ và lệch với /revenue-daily
    const offset = getTimezoneOffsetMinutes(req);
    const startMs = Date.parse(`${req.query.start_date}T00:00:00Z`);
    const endMs = Date.parse(`${req.query.end_date}T00:00:00Z`);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
      const start = new Date(startMs + offset * 60 * 1000);
      const end = new Date(endMs + 24 * 60 * 60 * 1000 + offset * 60 * 1000);
      return { startAt: formatDateTimeUTC(start), endAt: formatDateTimeUTC(end) };
    }
  }

  if (month && year) {
    const offset = getTimezoneOffsetMinutes(req);
    // offset = getTimezoneOffset() = UTC − local (VN: -420).
    // Mốc local 00:00 ngày 1 → UTC = local + offset  (VD: 1/8 00:00 VN = 31/7 17:00Z)
    const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1) + offset * 60 * 1000);
    const end = new Date(Date.UTC(Number(year), Number(month), 1) + offset * 60 * 1000);
    return { startAt: formatDateTimeUTC(start), endAt: formatDateTimeUTC(end) };
  }

  return null;
}

async function resolveDailyBusinessStoreId(req) {
  if (req.user.role === 'employer') {
    return await resolveCurrentStoreId(req.user);
  }

  const rawStoreId = req.body?.store_id ?? req.query?.store_id;
  if (!rawStoreId || rawStoreId === 'all') return null;

  const parsed = Number.parseInt(rawStoreId, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function resolveDailyBusinessScope(req) {
  const storeId = await resolveDailyBusinessStoreId(req);
  if (storeId === undefined) {
    const error = new Error('Invalid store_id');
    error.statusCode = 400;
    throw error;
  }

  if (req.user.role === 'admin') {
    if (storeId) {
      const store = await queryOne('SELECT id FROM stores WHERE id = ? AND admin_id = ?', [storeId, req.user.id]);
      if (!store) {
        const error = new Error('Bạn không có quyền xem báo cáo cửa hàng này');
        error.statusCode = 403;
        throw error;
      }
    }
    return { storeId, adminId: req.user.id };
  }

  // employer chưa gắn store (store_id NULL) hoặc root: KHÔNG được rơi xuống
  // scope rỗng — buildDailyBusinessReport với storeId=null & adminId=null sẽ
  // tổng hợp doanh thu của TOÀN BỘ hệ thống (mọi tenant)
  if (req.user.role === 'employer' && storeId) {
    return { storeId, adminId: null };
  }
  const error = new Error('Tài khoản chưa gắn cửa hàng — không thể xem báo cáo này');
  error.statusCode = 403;
  throw error;
}

router.get('/daily-business', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
  try {
    const { storeId, adminId } = await resolveDailyBusinessScope(req);

    const report = await buildDailyBusinessReport({
      date: req.query.date,
      storeId,
      adminId,
    });

    res.json({ data: report });
  } catch (error) {
    console.error('Daily business report error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get revenue by period (Admin/Employer)
router.get('/revenue', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.json({ data: [] });
    }

    const { period, start_date, end_date } = req.query;
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const revenueDateExpr = localDateSql('p.paid_at', timezoneOffset);

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

    const storeId = await resolveStoreIdForAdmin(req);
    let querySql, groupBy, params;
    if (period === 'day') {
      querySql = `
        SELECT 
          ${revenueDateExpr} as period,
          SUM(p.amount) as total_revenue,
          COUNT(DISTINCT p.order_id) as total_orders
        FROM order_payments p
        JOIN orders o ON p.order_id = o.id
        WHERE p.payment_method IN ('cash', 'transfer')
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
      
      groupBy = revenueDateExpr;
    } else if (period === 'month') {
      querySql = `
        SELECT 
          DATE_FORMAT(DATE_SUB(p.paid_at, INTERVAL ${timezoneOffset} MINUTE), '%Y-%m') as period,
          SUM(p.amount) as total_revenue,
          COUNT(DISTINCT p.order_id) as total_orders
        FROM order_payments p
        JOIN orders o ON p.order_id = o.id
        WHERE p.payment_method IN ('cash', 'transfer')
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
      
      groupBy = `DATE_FORMAT(DATE_SUB(p.paid_at, INTERVAL ${timezoneOffset} MINUTE), "%Y-%m")`;
    } else {
      querySql = `
        SELECT 
          DATE_FORMAT(DATE_SUB(p.paid_at, INTERVAL ${timezoneOffset} MINUTE), '%Y') as period,
          SUM(p.amount) as total_revenue,
          COUNT(DISTINCT p.order_id) as total_orders
        FROM order_payments p
        JOIN orders o ON p.order_id = o.id
        WHERE p.payment_method IN ('cash', 'transfer')
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
      
      groupBy = `DATE_FORMAT(DATE_SUB(p.paid_at, INTERVAL ${timezoneOffset} MINUTE), "%Y")`;
    }

    const range = getUtcRangeFromQuery(req);
    if (range) {
      querySql += ' AND p.paid_at >= ? AND p.paid_at < ?';
      params.push(range.startAt, range.endAt);
    } else if (start_date && end_date) {
      querySql += ` AND ${revenueDateExpr} >= ? AND ${revenueDateExpr} <= ?`;
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthYearValidation.month, monthYearValidation.year);
    const lastDay = new Date(monthYearValidation.year, monthYearValidation.month, 0).getDate();

    // Get revenue by store and day
    let querySql, revenueData;
    try {
      querySql = `
        SELECT 
          t.store_id,
          s.name as store_name,
          ${timesheetDateExpr} as work_date,
          SUM(t.revenue_amount) as daily_revenue,
          COUNT(DISTINCT t.user_id) as employee_count,
          COUNT(*) as shift_count
        FROM timesheets t
        JOIN stores s ON t.store_id = s.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.check_in >= ?
          AND t.check_in < ?
          AND t.check_out IS NOT NULL
          AND t.revenue_amount > 0
          AND (u.role IS NULL OR u.role = 'employer')
      `;
      const params = [monthRange.startAt, monthRange.endAt];
      
      const storeId = await resolveStoreIdForAdmin(req);
      if (storeId) {
        querySql += ' AND t.store_id = ?';
        params.push(storeId);
      } else if (req.user.role === 'admin') {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
      
      querySql += ` GROUP BY t.store_id, ${timesheetDateExpr} ORDER BY t.store_id, work_date`;
      revenueData = await query(querySql, params);
    } catch (error) {
      // If stores table doesn't exist, query without JOIN
      // Warning log removed for security
      querySql = `
        SELECT 
          t.store_id,
          NULL as store_name,
          ${timesheetDateExpr} as work_date,
          SUM(t.revenue_amount) as daily_revenue,
          COUNT(DISTINCT t.user_id) as employee_count,
          COUNT(*) as shift_count
        FROM timesheets t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.check_in >= ?
          AND t.check_in < ?
          AND t.check_out IS NOT NULL
          AND t.revenue_amount > 0
          AND (u.role IS NULL OR u.role = 'employer')
      `;
      const params = [monthRange.startAt, monthRange.endAt];
      
      const storeId = await resolveStoreIdForAdmin(req);
      if (storeId) {
        querySql += ' AND t.store_id = ?';
        params.push(storeId);
      } else if (req.user.role === 'admin') {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
      
      querySql += ` GROUP BY t.store_id, ${timesheetDateExpr} ORDER BY t.store_id, work_date`;
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
        revenue: Number(row.daily_revenue) || 0,
        employee_count: Number(row.employee_count) || 0,
        shift_count: Number(row.shift_count) || 0,
      };
      // Number(): daily_revenue is a SUM of DECIMAL → string from mysql2;
      // without coercion this concatenates instead of adding
      storeMap[row.store_id].total_revenue += Number(row.daily_revenue) || 0;
      storeMap[row.store_id].total_shifts += Number(row.shift_count) || 0;
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
router.get('/export', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - return empty
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể export báo cáo' });
    }

    const { type, month, year, store_id } = req.query;
    
    if (!type) {
      return res.status(400).json({ error: 'Loại báo cáo là bắt buộc' });
    }

    // Kẹp 1-12: month=13 âm thầm tạo range tháng 1 năm sau trong khi tên file ghi _13_
    const monthNum = Math.min(12, Math.max(1, parseInt(month) || (new Date().getMonth() + 1)));
    const yearNum = parseInt(year) || new Date().getFullYear();
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const orderUpdatedDateExpr = localDateSql('o.updated_at', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthNum, yearNum);
    let storeId = await resolveStoreIdForAdmin(req);
    if (!storeId && store_id && store_id !== 'all' && req.user.role === 'admin') {
      // Chỉ admin được chỉ định store — và phải là store thuộc chuỗi của mình.
      // (Nhánh else cũ nhận thẳng store_id từ query cho employer → đọc chéo tenant)
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
            AND o.updated_at >= ?
            AND o.updated_at < ?
        `;
        let productParams = [monthRange.startAt, monthRange.endAt];
        
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
            AND o.updated_at >= ?
            AND o.updated_at < ?
        `;
        let categoryParams = [monthRange.startAt, monthRange.endAt];
        
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
              WHEN HOUR(DATE_SUB(o.updated_at, INTERVAL ${timezoneOffset} MINUTE)) >= 6 AND HOUR(DATE_SUB(o.updated_at, INTERVAL ${timezoneOffset} MINUTE)) < 14 THEN 'Ca sáng'
              WHEN HOUR(DATE_SUB(o.updated_at, INTERVAL ${timezoneOffset} MINUTE)) >= 14 AND HOUR(DATE_SUB(o.updated_at, INTERVAL ${timezoneOffset} MINUTE)) < 22 THEN 'Ca chiều'
              ELSE 'Ca đêm'
            END as shift,
            SUM(o.final_amount) as total_revenue,
            COUNT(*) as order_count
          FROM orders o
          WHERE o.status = 'completed'
            AND o.updated_at >= ?
            AND o.updated_at < ?
        `;
        let shiftParams = [monthRange.startAt, monthRange.endAt];
        
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
            ${orderUpdatedDateExpr} as date,
            SUM(o.final_amount) as total_revenue,
            COUNT(*) as order_count
          FROM orders o
          WHERE o.status = 'completed'
            AND o.updated_at >= ?
            AND o.updated_at < ?
        `;
        let dailyParams = [monthRange.startAt, monthRange.endAt];
        
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
        
        dailyQuery += ` GROUP BY ${orderUpdatedDateExpr} ORDER BY ${orderUpdatedDateExpr}`;
        
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

router.get('/root/statistics', authorize('admin'), async (req, res) => {
  try {
    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có quyền truy cập' });
    }

    const todayStartAt = isoToMysqlUtc(req.query.today_start_at);
    const todayEndAt = isoToMysqlUtc(req.query.today_end_at);
    const monthStartAt = isoToMysqlUtc(req.query.month_start_at);
    const monthEndAt = isoToMysqlUtc(req.query.month_end_at);
    const now = new Date();
    const fallbackTodayStart = formatDateTimeUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    const fallbackTodayEnd = formatDateTimeUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)));
    const fallbackMonthStart = formatDateTimeUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    const fallbackMonthEnd = formatDateTimeUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

    const totalAdmins = await queryOne(`
      SELECT COUNT(*) as count 
      FROM users 
      WHERE role = 'admin' AND status = 'active'
    `);

    const pendingAdmins = await queryOne(`
      SELECT COUNT(*) as count 
      FROM users 
      WHERE role = 'admin' AND status = 'pending'
    `);

    const totalCustomers = await queryOne(`
      SELECT COUNT(*) as count 
      FROM customers
    `);

    const totalOrders = await queryOne(`
      SELECT COUNT(*) as count 
      FROM orders
    `);

    const completedOrders = await queryOne(`
      SELECT COUNT(*) as count 
      FROM orders 
      WHERE status = 'completed'
    `);

    const totalRevenue = await queryOne(`
      SELECT COALESCE(SUM(amount), 0) as total 
      FROM order_payments 
      WHERE payment_method IN ('cash', 'transfer')
    `);

    const todayRevenue = await queryOne(`
      SELECT COALESCE(SUM(amount), 0) as total 
      FROM order_payments 
      WHERE payment_method IN ('cash', 'transfer')
        AND paid_at >= ?
        AND paid_at < ?
    `, [todayStartAt || fallbackTodayStart, todayEndAt || fallbackTodayEnd]);

    const monthRevenue = await queryOne(`
      SELECT COALESCE(SUM(amount), 0) as total 
      FROM order_payments 
      WHERE payment_method IN ('cash', 'transfer')
        AND paid_at >= ?
        AND paid_at < ?
    `, [monthStartAt || fallbackMonthStart, monthEndAt || fallbackMonthEnd]);

    const totalStores = await queryOne(`
      SELECT COUNT(*) as count 
      FROM stores 
      WHERE status = 'active'
    `);

    const totalProducts = await queryOne(`
      SELECT COUNT(*) as count 
      FROM products 
      WHERE status = 'active'
    `);

    const activePromotions = await queryOne(`
      SELECT COUNT(*) as count 
      FROM promotions 
      WHERE status = 'active' 
        AND start_date <= CURDATE() 
        AND end_date >= CURDATE()
    `);

    // (topAdmins + ordersByStatus đã bị xóa: response không bao giờ trả 2 khối
    // này, trong khi topAdmins là triple-JOIN nhân bản payment rất nặng chạy
    // trên MỌI lượt mở dashboard root — thuần lãng phí)

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
router.get('/revenue-by-product-daily', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const orderDateExpr = localDateSql('o.updated_at', timezoneOffset);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthYearValidation.month, monthYearValidation.year);
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    const fromSql = `
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users u_store ON COALESCE(o.assigned_to, o.created_by) = u_store.id
    `;
    let whereSql = `
      WHERE o.status = 'completed'
        AND o.updated_at >= ?
        AND o.updated_at < ?
    `;
    // Tên người đứng ca KHÔNG join thẳng timesheets vào đây — ≥2 ca chồng nhau
    // (nhiều nhân viên cùng ca, tính năng chủ đích) sẽ nhân bản dòng order_items
    // và làm SUM(quantity)/SUM(revenue) bị nhân đôi/ba. Gắn riêng sau phân trang.
    const params = [monthRange.startAt, monthRange.endAt];

    const storeId = await resolveStoreIdForAdmin(req);

    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        // Employer with store_id: filter by store_id OR by user's orders (for legacy orders without store_id)
        whereSql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        // Employer without store_id: filter by their own orders
        whereSql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      // Admin filtering by specific store
      whereSql += ` AND (
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
      whereSql += sql;
      params.push(...p(req.user.id));
    }

    // group_concat_max_len được set cho mọi connection ở db.js pool hook
    const [countResult, data] = await Promise.all([
      queryOne(`
        SELECT COUNT(DISTINCT CONCAT(${orderDateExpr}, "-", p.id)) as total
        ${fromSql} ${whereSql}
      `, params),
      query(`
        SELECT
          ${orderDateExpr} as date,
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
          GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') as employee_names
        ${fromSql} ${whereSql}
        GROUP BY ${orderDateExpr}, p.id, p.name, p.unit
        ORDER BY date DESC, total_revenue DESC
        LIMIT ? OFFSET ?
      `, [...params, paginationValidation.limit, offset]),
    ]);
    const total = countResult?.total || 0;

    await attachShiftEmployeeNames(data, {
      fromSql, whereSql, whereParams: params, timezoneOffset,
      eventAt: 'o.updated_at', dateExpr: orderDateExpr,
      groupExpr: 'p.id', rowGroupKey: (r) => r.product_id,
    });

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

    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get revenue by category (using product name as category) by day in month
router.get('/revenue-by-category-daily', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const orderDateExpr = localDateSql('o.updated_at', timezoneOffset);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthYearValidation.month, monthYearValidation.year);
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    const fromSql = `
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users u_store ON COALESCE(o.assigned_to, o.created_by) = u_store.id
    `;
    let whereSql = `
      WHERE o.status = 'completed'
        AND o.updated_at >= ?
        AND o.updated_at < ?
    `;
    // Tên người đứng ca gắn riêng sau phân trang — xem revenue-by-product-daily
    const params = [monthRange.startAt, monthRange.endAt];

    const storeId = await resolveStoreIdForAdmin(req);

    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        // Employer with store_id: filter by store_id OR by user's orders (for legacy orders without store_id)
        whereSql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        // Employer without store_id: filter by their own orders
        whereSql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      // Admin filtering by specific store
      whereSql += ` AND (
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
      whereSql += sql;
      params.push(...p(req.user.id));
    }

    // group_concat_max_len được set cho mọi connection ở db.js pool hook
    const [countResult, data] = await Promise.all([
      queryOne(`
        SELECT COUNT(DISTINCT CONCAT(${orderDateExpr}, "-", p.name)) as total
        ${fromSql} ${whereSql}
      `, params),
      query(`
        SELECT
          ${orderDateExpr} as date,
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
          GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') as employee_names
        ${fromSql} ${whereSql}
        GROUP BY ${orderDateExpr}, p.name
        ORDER BY date DESC, total_revenue DESC
        LIMIT ? OFFSET ?
      `, [...params, paginationValidation.limit, offset]),
    ]);
    const total = countResult?.total || 0;

    await attachShiftEmployeeNames(data, {
      fromSql, whereSql, whereParams: params, timezoneOffset,
      eventAt: 'o.updated_at', dateExpr: orderDateExpr,
      groupExpr: 'p.name', rowGroupKey: (r) => r.category,
    });

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
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get revenue by employee by day in month
router.get('/revenue-by-employee-daily', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const orderDateExpr = localDateSql('o.updated_at', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthYearValidation.month, monthYearValidation.year);
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    let querySql = `
      SELECT 
        ${orderDateExpr} as date,
        u.id as employee_id,
        u.name as employee_name,
        SUM(o.final_amount) as total_revenue,
        COUNT(*) as total_orders
      FROM orders o
      JOIN users u ON o.assigned_to = u.id
      WHERE o.status = 'completed'
        AND o.updated_at >= ?
        AND o.updated_at < ?
    `;
    const params = [monthRange.startAt, monthRange.endAt];
    
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
      // Admin không chọn store: giới hạn trong CHUỖI của admin — thiếu nhánh
      // này thì admin xem "tất cả cửa hàng" nhận doanh thu nhân viên của MỌI
      // tenant trong hệ thống (các endpoint khác đều có nhánh tương tự)
      const chain = adminStoresOnlyFilter('o');
      querySql += chain.sql;
      params.push(...chain.params(req.user.id));
    }

    querySql += ` GROUP BY ${orderDateExpr}, u.id, u.name ORDER BY date DESC, total_revenue DESC`;
    
    const countSql = querySql
      .replace(/SELECT[\s\S]*?FROM/, `SELECT COUNT(DISTINCT CONCAT(${orderDateExpr}, "-", u.id)) as total FROM`)
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const orderDateExpr = localDateSql('p.paid_at', timezoneOffset);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthYearValidation.month, monthYearValidation.year);
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    const fromSql = `
      FROM order_payments p
      JOIN orders o ON p.order_id = o.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users u_store ON COALESCE(o.assigned_to, o.created_by) = u_store.id
    `;
    let whereSql = `
      WHERE p.payment_method IN ('cash', 'transfer')
        AND p.paid_at >= ?
        AND p.paid_at < ?
    `;
    const params = [monthRange.startAt, monthRange.endAt];

    const storeId = await resolveStoreIdForAdmin(req);

    // Build store filter based on role
    if (req.user.role === 'employer') {
      if (storeId) {
        whereSql += ` AND (
          o.store_id = ?
          OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
        )`;
        params.push(storeId, req.user.id, req.user.id);
      } else {
        whereSql += ' AND (o.assigned_to = ? OR o.created_by = ?)';
        params.push(req.user.id, req.user.id);
      }
    } else if (req.user.role === 'admin' && storeId) {
      whereSql += ` AND (
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
      whereSql += sql;
      params.push(...p(req.user.id));
    }

    // group_concat_max_len được set cho mọi connection ở db.js pool hook
    // Group by payment method (cash or transfer)
    const [countResult, data] = await Promise.all([
      // Mỗi dòng = (ngày, phương thức) — đếm theo cặp, không chỉ theo ngày
      // (trước đây total/totalPages chỉ bằng nửa số dòng thật)
      queryOne(`SELECT COUNT(DISTINCT CONCAT(${orderDateExpr}, "-", p.payment_method)) as total ${fromSql} ${whereSql}`, params),
      query(`
        SELECT
          ${orderDateExpr} as date,
          COALESCE(
            CASE
              WHEN p.payment_method = 'cash' THEN 'Tiền mặt'
              WHEN p.payment_method = 'transfer' THEN 'Chuyển khoản'
              ELSE 'Tiền mặt'
            END,
            'Tiền mặt'
          ) as payment_method,
          SUM(p.amount) as total_revenue,
          COUNT(DISTINCT p.order_id) as total_orders,
          GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') as employee_names
        ${fromSql} ${whereSql}
        GROUP BY ${orderDateExpr}, p.payment_method
        ORDER BY date DESC, payment_method
        LIMIT ? OFFSET ?
      `, [...params, paginationValidation.limit, offset]),
    ]);
    const total = countResult?.total || 0;

    await attachShiftEmployeeNames(data, {
      fromSql, whereSql, whereParams: params, timezoneOffset,
      eventAt: 'p.paid_at', dateExpr: orderDateExpr,
      groupExpr: 'p.payment_method',
      rowGroupKey: (r) => (r.payment_method === 'Chuyển khoản' ? 'transfer' : 'cash'),
    });

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
router.get('/revenue-by-shift-daily', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthYearValidation.month, monthYearValidation.year);
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    // Bao gồm cả ca ĐANG MỞ (check_out IS NULL): nhân viên chưa/quên check-out
    // thì ca vẫn phải hiện với doanh thu tính LIVE, thay vì "biến mất" khỏi báo
    // cáo cho tới khi check-out hoặc tự đóng lúc nửa đêm. Ca tự đóng
    // (auto_closed = 1) có actual_cash_amount NULL = két chưa ai đếm — trả cờ
    // để FE hiển thị nhãn riêng thay vì số 0 gây hiểu nhầm.
    let querySql = `
      SELECT
        ${timesheetDateExpr} as date,
        t.user_id,
        t.store_id,
        t.check_in as check_in_at,
        COALESCE(e.name, u.name) as employee_name,
        t.id as shift_id,
        TIME(t.check_in) as check_in_time,
        TIME(t.check_out) as check_out_time,
        (t.check_out IS NULL) as is_open,
        t.auto_closed,
        t.expected_revenue as start_revenue,
        t.revenue_amount as end_revenue,
        t.actual_cash_amount,
        COALESCE(t.withdrawn_amount, 0) as withdrawn_amount,
        t.note,
        t.regular_hours,
        t.overtime_hours
      FROM timesheets t
      LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.check_in >= ?
        AND t.check_in < ?
    `;
    const params = [monthRange.startAt, monthRange.endAt];

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

    const rows = await query(querySql, params);

    // Ca đang mở: revenue_amount chỉ được ghi lúc đóng ca → tính live theo CÙNG
    // luật dedupe với check-out (ca mở cũ nhất của tiệm nhận doanh thu, ca phụ
    // = 0), cửa sổ [check_in, bây giờ]. Chỉ vài ca mở/trang nên chi phí nhỏ.
    const nowSql = formatDateTimeUTC(new Date());
    const data = await Promise.all(rows.map(async (row) => {
      const { check_in_at, ...rest } = row;
      const isOpen = Number(row.is_open) === 1;
      if (!isOpen) {
        return { ...rest, is_open: false, auto_closed: Number(row.auto_closed) === 1 };
      }
      let liveRevenue = null;
      try {
        const checkInMs = parseTimesheetDateTimeMsCompat(check_in_at);
        const summary = await getShiftPaymentSummaryDeduped(
          { queryOne },
          { id: row.shift_id, store_id: row.store_id, user_id: row.user_id },
          row.user_id,
          formatDateTimeUTC(new Date(checkInMs)),
          nowSql
        );
        liveRevenue = summary.revenue_amount;
      } catch (error) {
        // Không chặn cả báo cáo vì 1 ca tính live lỗi — để null, FE hiện "—"
        console.warn(`Live revenue for open shift ${row.shift_id} failed: ${error.message}`);
      }
      return { ...rest, is_open: true, auto_closed: false, end_revenue: liveRevenue, actual_cash_amount: null };
    }));

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
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// ─── Dòng tiền két theo ngày (một cửa hàng) ────────────────────────────────
// Kể lại TUẦN TỰ THEO GIỜ mọi sự kiện của tiệm trong ngày: ai check-in/out,
// quỹ đầu ca, từng khoản thu tiền mặt / nhập / rút / chi, chốt két, bàn giao
// két giữa người với người — kèm "tồn két" sau mỗi dòng. Mục đích: khi nhiều
// người cùng đứng một ca, nhìn vào là biết tiền đang nằm trong két của ai.
//
// Luật két (khớp với code ghi sổ):
// - Ca mở CŨ NHẤT của tiệm giữ két: tiền mặt khách trả vào két của ca đó
//   (orderPaymentService.findOpenTimesheet), người vào thêm không có két.
// - Tồn két dự kiến = quỹ đầu ca + thu tiền mặt + nhập thêm − rút/chi
//   (cashDrawerService.getDrawerSummaryTx); "bù thiếu" không nằm trong số dự
//   kiến — nó được bỏ vào két SAU khi đếm.
// - Chốt két (closing_count) không cộng/trừ, chỉ ghi số đếm thực tế.
const TIMELINE_KIND_PRIORITY = {
  carry_over: 0,
  check_in: 1,
  opening_float: 2,
  money: 3,
  closing_count: 4,
  shortage_reimbursement: 5,
  check_out: 6,
  handover_in: 7,
};

// Một cơ sở thời gian cho MỌI mốc (ca làm và sổ két): bản Compat bù dữ liệu
// check_in cũ lưu theo giờ VN (nằm ở tương lai); mốc hợp lệ không bị đụng
const toMillis = parseTimesheetDateTimeMsCompat;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Thời điểm két của ca THỰC SỰ đóng: giờ ra có thể nhập lùi (bù giờ quên bấm)
// nhưng ca vẫn là "ca mở" — vẫn nhận tiền mặt vào két (findOpenTimesheet xét
// check_out IS NULL theo thời gian thực) — cho tới lúc chốt két. Xác định "ai
// giữ két" phải theo mốc này, không theo check_out đã nhập.
const SHIFT_CLOSED_AT_SQL = `(SELECT MAX(c.occurred_at) FROM cash_drawer_transactions c
  WHERE c.timesheet_id = t.id AND c.type = 'closing_count')`;

// Cột ca làm dùng chung cho timeline (cả truy vấn chính lẫn nạp bổ sung)
const TIMELINE_SHIFT_COLUMNS = `
  t.id, t.user_id, t.employee_id, t.check_in, t.check_out, t.auto_closed,
  t.regular_hours, t.overtime_hours, t.expected_cash_amount, t.actual_cash_amount,
  t.cash_difference, t.note,
  COALESCE(e.name, u.name) AS employee_name,
  ${SHIFT_CLOSED_AT_SQL} AS closed_at
`;

// Mốc hết giữ két của ca (null = còn mở): muộn hơn giữa giờ ra và lúc chốt két
const shiftEffectiveEndMs = (s) => {
  if (!s.check_out) return null;
  const outMs = toMillis(s.check_out);
  const closedMs = s.closed_at ? toMillis(s.closed_at) : null;
  return closedMs !== null && closedMs > outMs ? closedMs : outMs;
};

// Ca mở cũ nhất (người giữ két) theo cùng thứ tự (check_in, id) với
// findOpenTimesheet / hasOlderOpenShiftTx. `shifts`: các ca cùng tiệm.
function olderOpenShiftAtTime(shifts, target, atMs) {
  const tIn = toMillis(target.check_in);
  return shifts
    .filter((o) => {
      if (o.id === target.id) return false;
      const oIn = toMillis(o.check_in);
      const oEnd = shiftEffectiveEndMs(o);
      const older = oIn < tIn || (oIn === tIn && o.id < target.id);
      return older && oIn <= atMs && (oEnd === null || oEnd > atMs);
    })
    .sort((a, b) => toMillis(a.check_in) - toMillis(b.check_in) || a.id - b.id)[0];
}

router.get('/cash-drawer-timeline', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
  try {
    if (req.user.role === 'root') {
      return res.json({ data: null });
    }

    const dateStr = String(req.query.date || '').trim();
    const dayUtcMs = Date.parse(`${dateStr}T00:00:00Z`);
    // Round-trip: Date.parse cuộn ngày không tồn tại (2026-02-30 → 02/03) —
    // trả dữ liệu ngày khác dưới nhãn ngày đã hỏi
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || Number.isNaN(dayUtcMs)
      || new Date(dayUtcMs).toISOString().slice(0, 10) !== dateStr) {
      return res.status(400).json({ error: 'Ngày không hợp lệ (định dạng YYYY-MM-DD).' });
    }

    // Két là của TỪNG cửa hàng — gộp nhiều tiệm vào một dòng thời gian thì số
    // tồn két vô nghĩa, nên bắt buộc chọn đúng một cửa hàng
    const storeId = await resolveStoreIdForAdmin(req);
    if (!storeId) {
      return res.status(400).json({ error: 'Vui lòng chọn một cửa hàng để xem dòng tiền két.' });
    }

    const offset = getTimezoneOffsetMinutes(req);
    const dayStartMs = dayUtcMs + offset * 60 * 1000;
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const startAt = formatDateTimeUTC(new Date(dayStartMs));
    const endAt = formatDateTimeUTC(new Date(dayEndMs));

    // 4 truy vấn độc lập → chạy song song (1 round-trip thay vì 3 nối tiếp)
    const [store, shifts, transactions, payments] = await Promise.all([
      queryOne('SELECT id, name FROM stores WHERE id = ?', [storeId]),
      // Ca làm việc giao với ngày này (kể cả ca mở từ hôm trước / đang mở)
      query(`
        SELECT ${TIMELINE_SHIFT_COLUMNS}
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        WHERE t.store_id = ?
          AND t.check_in < ?
          AND (t.check_out IS NULL OR t.check_out >= ?)
        ORDER BY t.check_in ASC, t.id ASC
      `, [storeId, endAt, startAt]),
      query(`
        SELECT cdt.id, cdt.timesheet_id, cdt.type, cdt.amount, cdt.reason, cdt.occurred_at,
          cdt.order_id, cdt.related_timesheet_id,
          o.code AS order_code, oe.name AS order_employee_name
        FROM cash_drawer_transactions cdt
        LEFT JOIN orders o ON cdt.order_id = o.id
        LEFT JOIN employees oe ON o.employee_id = oe.id
        WHERE cdt.store_id = ? AND cdt.occurred_at >= ? AND cdt.occurred_at < ?
        ORDER BY cdt.occurred_at ASC, cdt.id ASC
      `, [storeId, startAt, endAt]),
      // Chuyển khoản (không vào két) + tiền mặt KHÔNG vào két nào (thu lúc không
      // có ca mở) — để dòng tiền trong ngày đầy đủ và lộ ra tiền mặt "trôi nổi"
      query(`
        SELECT p.id, p.amount, p.payment_method, p.payment_type, p.paid_at,
          o.code AS order_code, oe.name AS order_employee_name,
          EXISTS (SELECT 1 FROM cash_drawer_transactions c WHERE c.order_payment_id = p.id) AS in_drawer
        FROM order_payments p
        JOIN orders o ON p.order_id = o.id
        LEFT JOIN employees oe ON o.employee_id = oe.id
        WHERE COALESCE(p.store_id, o.store_id) = ?
          AND p.paid_at >= ? AND p.paid_at < ?
        ORDER BY p.paid_at ASC, p.id ASC
      `, [storeId, startAt, endAt]),
    ]);

    const shiftById = new Map(shifts.map((s) => [s.id, s]));
    const shiftCheckInMs = (s) => toMillis(s.check_in);
    const shiftCheckOutMs = (s) => (s.check_out ? toMillis(s.check_out) : null);

    // 2 truy vấn phụ độc lập (chỉ cần shifts + transactions) → chạy song song:
    // - ca có giao dịch két trong ngày nhưng không nằm trong danh sách trên
    //   (dữ liệu lệch mốc giờ) — nạp thêm để không mất tên người giữ két
    // - tồn két dự kiến đầu ngày của két mở từ hôm trước (cùng công thức
    //   getDrawerSummaryTx: bù thiếu và chốt két không cộng/trừ)
    const drawerIds = [...new Set(transactions.map((t) => t.timesheet_id))];
    const missingIds = drawerIds.filter((id) => !shiftById.has(id));
    const earlyShiftIds = shifts.filter((s) => shiftCheckInMs(s) < dayStartMs).map((s) => s.id);
    const carryIds = [...new Set([...drawerIds, ...earlyShiftIds])];
    const [extra, carryRows] = await Promise.all([
      missingIds.length
        ? query(`
            SELECT ${TIMELINE_SHIFT_COLUMNS}
            FROM timesheets t
            JOIN users u ON t.user_id = u.id
            LEFT JOIN employees e ON t.employee_id = e.id
            WHERE t.id IN (?)
          `, [missingIds])
        : [],
      carryIds.length
        ? query(`
            SELECT timesheet_id, COALESCE(SUM(CASE
              WHEN type IN ('opening_float', 'cash_payment', 'cash_in') THEN amount
              WHEN type = 'cash_out' THEN -amount
              ELSE 0 END), 0) AS balance
            FROM cash_drawer_transactions
            WHERE timesheet_id IN (?) AND occurred_at < ?
            GROUP BY timesheet_id
          `, [carryIds, startAt])
        : [],
    ]);
    for (const s of extra) {
      shifts.push(s);
      shiftById.set(s.id, s);
    }
    const carry = new Map(carryRows.map((r) => [r.timesheet_id, round2(r.balance)]));

    const nameOf = (id) => shiftById.get(id)?.employee_name || (id ? `Ca #${id}` : '');

    // Người giữ két tính MỘT lần cho mỗi ca lúc check-in (dùng cho cả dòng
    // check-in lẫn bảng "Người đứng ca")
    const holderAtCheckIn = new Map();
    const holderOf = (s) => {
      if (!holderAtCheckIn.has(s.id)) {
        holderAtCheckIn.set(s.id, olderOpenShiftAtTime(shifts, s, shiftCheckInMs(s)) || null);
      }
      return holderAtCheckIn.get(s.id);
    };
    const openShiftsAt = (atMs, excludeId) => shifts
      .filter((o) => {
        if (o.id === excludeId || shiftCheckInMs(o) > atMs) return false;
        const end = shiftEffectiveEndMs(o);
        return end === null || end > atMs;
      })
      .sort((a, b) => shiftCheckInMs(a) - shiftCheckInMs(b) || a.id - b.id);

    // Bàn giao: dòng opening_float có related_timesheet_id (dữ liệu trước khi
    // có cột đã được backfill từ reason lúc khởi tạo DB — db.js/initDatabase.js)
    const handoverFrom = new Map(); // tx.id -> ca giao
    const handoverTo = new Map();   // ca giao -> ca nhận
    const closingByTimesheet = new Map();
    for (const tx of transactions) {
      if (tx.type === 'closing_count') closingByTimesheet.set(tx.timesheet_id, tx);
      if (tx.type === 'opening_float' && tx.related_timesheet_id) {
        handoverFrom.set(tx.id, tx.related_timesheet_id);
        handoverTo.set(tx.related_timesheet_id, tx.timesheet_id);
      }
    }
    // Giờ địa phương HH:mm (để ghi chú giờ ra đã nhập tay)
    const localHHmm = (ms) => new Date(ms - offset * 60 * 1000).toISOString().slice(11, 16);

    const events = [];
    const pushEvent = (ev) => events.push(ev);

    for (const [tsId, balance] of carry.entries()) {
      pushEvent({
        kind: 'carry_over', at_ms: dayStartMs, id: 0,
        drawer_timesheet_id: tsId,
        label: 'Tồn két đầu ngày (ca mở từ hôm trước)',
        carry_balance: balance,
      });
    }

    for (const s of shifts) {
      const inMs = shiftCheckInMs(s);
      if (inMs >= dayStartMs && inMs < dayEndMs) {
        const holder = holderOf(s);
        pushEvent({
          kind: 'check_in', at_ms: inMs, id: s.id,
          person_timesheet_id: s.id,
          label: holder
            ? `${s.employee_name} check-in — vào THÊM ca, két do ${holder.employee_name} giữ`
            : `${s.employee_name} check-in — mở ca & giữ két`,
        });
      }
      const outMs = shiftCheckOutMs(s);
      if (outMs !== null && outMs >= dayStartMs && outMs < dayEndMs) {
        const hours = round2((Number(s.regular_hours) || 0) + (Number(s.overtime_hours) || 0));
        // Xét tại lúc két THỰC SỰ đóng (giờ ra có thể nhập lùi — xem shiftEffectiveEndMs)
        const endMs = shiftEffectiveEndMs(s);
        const wasHolder = !olderOpenShiftAtTime(shifts, s, endMs);
        const remaining = openShiftsAt(endMs, s.id);
        // Ca tự đóng: mốc giờ là lúc HỆ THỐNG đóng (sweep chạy mỗi giờ / khi có
        // người mở app), không phải 0h — ghi đúng sự thật, không ghi "nửa đêm"
        let detail = Number(s.auto_closed) === 1
          ? 'Quên check-out — hệ thống tự đóng ca (ca đã qua nửa đêm), giờ công = 0'
          : `Làm ${hours}h`;
        if (wasHolder && remaining.length && !handoverTo.has(s.id) && Number(s.auto_closed) !== 1) {
          detail += ` · Không bàn giao két — tiền thu sau đây vào két của ${remaining[0].employee_name} (bắt đầu từ 0)`;
        }
        // timesheets.check_out lấy TRƯỚC transaction chốt két và có thể nhập
        // lùi (bù giờ ra quên bấm) — xếp dòng check-out ngay SAU dòng chốt két
        // của chính ca đó để thứ tự "chốt két → check-out → bàn giao" không bị
        // đảo; giờ ra thật đã nhập ghi vào chú thích nếu khác đáng kể
        const closing = closingByTimesheet.get(s.id);
        const closingMs = closing ? toMillis(closing.occurred_at) : null;
        const sortMs = closingMs !== null && closingMs > outMs ? closingMs : outMs;
        if (sortMs - outMs > 60 * 1000) {
          detail += ` · Giờ ra đã nhập: ${localHHmm(outMs)}`;
        }
        pushEvent({
          kind: 'check_out', at_ms: sortMs, id: s.id,
          person_timesheet_id: s.id,
          label: `${s.employee_name} check-out`,
          detail,
          warning: Number(s.auto_closed) === 1,
        });
      }
    }

    for (const tx of transactions) {
      const amount = round2(tx.amount);
      const base = {
        at_ms: toMillis(tx.occurred_at), id: tx.id, tx_type: tx.type,
        drawer_timesheet_id: tx.timesheet_id, amount,
      };
      const orderLabel = tx.order_code ? `#${tx.order_code}` : (tx.order_id ? `#${tx.order_id}` : '');
      switch (tx.type) {
        case 'opening_float': {
          const fromId = handoverFrom.get(tx.id);
          pushEvent(fromId
            ? { ...base, kind: 'handover_in', label: `${nameOf(tx.timesheet_id)} nhận bàn giao két từ ${nameOf(fromId)}`, from_timesheet_id: fromId }
            : { ...base, kind: 'opening_float', label: 'Quỹ đầu ca' });
          break;
        }
        case 'cash_payment':
          pushEvent({
            ...base, kind: 'money',
            label: `Thu tiền mặt đơn ${orderLabel}`.trim(),
            detail: tx.order_employee_name ? `Đơn do ${tx.order_employee_name} tạo` : null,
          });
          break;
        case 'cash_in':
          pushEvent({ ...base, kind: 'money', label: 'Nhập thêm vào két', detail: tx.reason && tx.reason !== 'Cash added to drawer' ? tx.reason : null });
          break;
        case 'cash_out':
          pushEvent(tx.reason === 'Rút tiền khi check-out'
            ? { ...base, kind: 'money', label: 'Rút tiền khi check-out' }
            : { ...base, kind: 'money', label: 'Chi / trừ khỏi két', detail: tx.reason || null });
          break;
        case 'shortage_reimbursement': {
          // Tạo cùng transaction với dòng chốt két — xếp ngay SAU dòng chốt để
          // số "chênh lệch" ở dòng chốt không bị cộng lẫn tiền bù
          const closing = closingByTimesheet.get(tx.timesheet_id);
          pushEvent({
            ...base, kind: 'shortage_reimbursement',
            at_ms: closing ? toMillis(closing.occurred_at) : base.at_ms,
            label: 'Nhân viên bù tiền thiếu vào két',
          });
          break;
        }
        case 'closing_count': {
          const shift = shiftById.get(tx.timesheet_id);
          const auto = Number(shift?.auto_closed) === 1;
          const toId = handoverTo.get(tx.timesheet_id);
          pushEvent({
            ...base, kind: 'closing_count', auto,
            label: auto
              ? 'Chốt két tự động — KHÔNG ai đếm két'
              : `Chốt két — đếm thực tế ${new Intl.NumberFormat('vi-VN').format(amount)} đ`,
            handed_to_timesheet_id: toId || null,
            detail: toId ? `Bàn giao két cho ${nameOf(toId)}` : null,
            warning: auto,
          });
          break;
        }
        default:
          break;
      }
    }

    let transferTotal = 0;
    let cashOutsideTotal = 0;
    for (const p of payments) {
      const amount = round2(p.amount);
      const orderLabel = p.order_code ? `#${p.order_code}` : '';
      if (p.payment_method === 'transfer') {
        transferTotal += amount;
        pushEvent({
          kind: 'money', tx_type: 'transfer', at_ms: toMillis(p.paid_at), id: 1e9 + p.id,
          amount, drawer_timesheet_id: null,
          label: `Khách chuyển khoản đơn ${orderLabel}`.trim(),
          detail: `Không vào két${p.order_employee_name ? ` · Đơn do ${p.order_employee_name} tạo` : ''}`,
        });
      } else if (p.payment_method === 'cash' && !Number(p.in_drawer)) {
        cashOutsideTotal += amount;
        const paidMs = toMillis(p.paid_at);
        // Chỉ khẳng định "không ai đứng ca" khi đúng là vậy — có ca mở mà vẫn
        // không có dòng két thì là dữ liệu trước khi có sổ két (hoặc ghi lệch)
        const nobodyOnShift = openShiftsAt(paidMs, null).length === 0;
        pushEvent({
          kind: 'money', tx_type: 'cash_outside', at_ms: paidMs, id: 1e9 + p.id,
          amount, drawer_timesheet_id: null,
          label: `Thu tiền mặt đơn ${orderLabel} — KHÔNG vào két nào`.trim(),
          detail: nobodyOnShift
            ? 'Lúc thu không có ca nào đang mở tại tiệm — tiền mặt này không được theo dõi trong két'
            : 'Không có dòng ghi vào két cho khoản thu này (có thể là dữ liệu trước khi có sổ két)',
          warning: true,
        });
      }
    }

    events.sort((a, b) => a.at_ms - b.at_ms
      || TIMELINE_KIND_PRIORITY[a.kind] - TIMELINE_KIND_PRIORITY[b.kind]
      || a.id - b.id);

    // Chạy tồn két theo TỪNG két (mỗi ca giữ két là một két riêng)
    const drawers = new Map();
    const getDrawer = (tsId) => {
      if (!drawers.has(tsId)) {
        const s = shiftById.get(tsId);
        drawers.set(tsId, {
          timesheet_id: tsId,
          employee_name: nameOf(tsId),
          // Một người có thể có 2 két trong ngày (ca hôm trước quên check-out +
          // ca hôm nay) — kèm giờ vào ca để FE phân biệt
          check_in: s ? new Date(shiftCheckInMs(s)).toISOString() : null,
          carried_in: 0,
          opening_float: 0,
          received_handover: 0,
          received_from: null,
          cash_payment: 0,
          cash_in: 0,
          cash_out: 0,
          shortage_reimbursement: 0,
          balance: 0,
          expected_at_close: null,
          counted: null,
          difference: null,
          closed: false,
          auto_closed: Number(s?.auto_closed) === 1,
          handed_to: null,
          is_open: s ? s.check_out === null : false,
        });
      }
      return drawers.get(tsId);
    };

    const output = events.map((ev) => {
      const out = {
        at: new Date(ev.at_ms).toISOString(),
        kind: ev.kind,
        tx_type: ev.tx_type || null,
        label: ev.label,
        detail: ev.detail || null,
        warning: Boolean(ev.warning),
        drawer_timesheet_id: ev.drawer_timesheet_id || null,
        drawer_name: ev.drawer_timesheet_id ? nameOf(ev.drawer_timesheet_id) : null,
        person_timesheet_id: ev.person_timesheet_id || null,
        amount_in: null,
        amount_out: null,
        balance_after: null,
      };
      if (!ev.drawer_timesheet_id) {
        if (ev.tx_type === 'transfer' || ev.tx_type === 'cash_outside') out.amount_in = ev.amount;
        return out;
      }
      const d = getDrawer(ev.drawer_timesheet_id);
      switch (ev.kind) {
        case 'carry_over':
          d.carried_in = ev.carry_balance;
          d.balance = ev.carry_balance;
          break;
        case 'opening_float':
          d.opening_float = round2(d.opening_float + ev.amount);
          d.balance = round2(d.balance + ev.amount);
          out.amount_in = ev.amount;
          break;
        case 'handover_in':
          d.received_handover = round2(d.received_handover + ev.amount);
          d.received_from = nameOf(ev.from_timesheet_id);
          d.balance = round2(d.balance + ev.amount);
          out.amount_in = ev.amount;
          break;
        case 'money':
          if (ev.tx_type === 'cash_out') {
            d.cash_out = round2(d.cash_out + ev.amount);
            d.balance = round2(d.balance - ev.amount);
            out.amount_out = ev.amount;
          } else {
            if (ev.tx_type === 'cash_payment') d.cash_payment = round2(d.cash_payment + ev.amount);
            if (ev.tx_type === 'cash_in') d.cash_in = round2(d.cash_in + ev.amount);
            d.balance = round2(d.balance + ev.amount);
            out.amount_in = ev.amount;
          }
          break;
        case 'closing_count': {
          const s = shiftById.get(ev.drawer_timesheet_id);
          d.expected_at_close = d.balance;
          d.closed = true;
          if (ev.auto) {
            d.counted = null;
            d.difference = null;
          } else {
            d.counted = ev.amount;
            d.difference = s?.cash_difference != null
              ? round2(s.cash_difference)
              : round2(ev.amount - d.balance);
            // Sau khi đếm, tồn két = số tiền vật lý đếm được
            d.balance = ev.amount;
          }
          d.handed_to = ev.handed_to_timesheet_id ? nameOf(ev.handed_to_timesheet_id) : null;
          out.expected = d.expected_at_close;
          out.counted = d.counted;
          out.difference = d.difference;
          break;
        }
        case 'shortage_reimbursement':
          d.shortage_reimbursement = round2(d.shortage_reimbursement + ev.amount);
          d.balance = round2(d.balance + ev.amount);
          out.amount_in = ev.amount;
          break;
        default:
          break;
      }
      out.balance_after = d.balance;
      return out;
    });

    const drawerList = [...drawers.values()].map((d) => ({
      ...d,
      status: d.is_open ? 'open' : d.auto_closed ? 'auto_closed' : d.handed_to ? 'handed_over' : d.closed ? 'closed' : 'unknown',
    }));

    const people = shifts
      .slice()
      .sort((a, b) => shiftCheckInMs(a) - shiftCheckInMs(b) || a.id - b.id)
      .map((s) => {
        const holderAtIn = holderOf(s);
        return {
          timesheet_id: s.id,
          employee_name: s.employee_name,
          check_in: new Date(shiftCheckInMs(s)).toISOString(),
          check_out: s.check_out ? new Date(shiftCheckOutMs(s)).toISOString() : null,
          is_open: s.check_out === null,
          auto_closed: Number(s.auto_closed) === 1,
          hours: round2((Number(s.regular_hours) || 0) + (Number(s.overtime_hours) || 0)),
          role: holderAtIn ? 'joined' : 'opened',
          joined_drawer_of: holderAtIn ? holderAtIn.employee_name : null,
        };
      });

    const cashIntoDrawers = drawerList.reduce((sum, d) => sum + d.cash_payment, 0);

    res.json({
      data: {
        date: dateStr,
        store_id: storeId,
        store_name: store?.name || null,
        people,
        drawers: drawerList,
        events: output,
        totals: {
          cash_payment_into_drawers: round2(cashIntoDrawers),
          transfer: round2(transferTotal),
          cash_outside_drawer: round2(cashOutsideTotal),
        },
      },
    });
  } catch (error) {
    console.error('Get cash drawer timeline error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// ─── Phiếu "Báo cáo ca làm việc" của MỘT ca ─────────────────────────────────
// Két: cộng từ cash_drawer_transactions của đúng ca này (cùng nguồn với
// getDrawerSummaryTx lúc chốt két). Doanh thu: order_payments.timesheet_id —
// khoản thanh toán được ghi cho ca đang GIỮ KÉT lúc thu (findOpenTimesheet),
// nên ca phụ (vào thêm) = 0 và 2 người chung ca không bị đếm trùng.
router.get('/shift-detail/:id', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
  try {
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không xem báo cáo ca của cửa hàng' });
    }
    const idValidation = validateId(req.params.id);
    if (!idValidation.valid) {
      return res.status(400).json({ error: 'Mã ca không hợp lệ' });
    }

    const shift = await queryOne(`
      SELECT t.*, COALESCE(e.name, u.name) AS employee_name,
        s.name AS store_name, s.admin_id AS store_admin_id
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN stores s ON t.store_id = s.id
      WHERE t.id = ?
    `, [idValidation.value]);

    // 404 cho cả "không tồn tại" lẫn "không có quyền" — không lộ ca của tiệm khác
    let allowed = false;
    if (shift) {
      if (req.user.role === 'admin') {
        allowed = shift.store_admin_id === req.user.id;
      } else if (req.user.role === 'employer') {
        const ownStoreId = await resolveCurrentStoreId(req.user);
        allowed = Boolean(ownStoreId) && shift.store_id === ownStoreId;
      }
    }
    if (!allowed) {
      return res.status(404).json({ error: 'Không tìm thấy ca làm việc' });
    }

    const [txRows, handedOutRow, paymentRow, otherShifts] = await Promise.all([
      query(`
        SELECT cdt.type, cdt.amount, cdt.reason, cdt.related_timesheet_id,
          COALESCE(fe.name, fu.name) AS from_name
        FROM cash_drawer_transactions cdt
        LEFT JOIN timesheets ft ON cdt.related_timesheet_id = ft.id
        LEFT JOIN employees fe ON ft.employee_id = fe.id
        LEFT JOIN users fu ON ft.user_id = fu.id
        WHERE cdt.timesheet_id = ?
      `, [shift.id]),
      // Ca này đã bàn giao két cho ai (dòng nhận của ca kia trỏ về ca này)
      queryOne(`
        SELECT cdt.amount, COALESCE(te.name, tu.name) AS to_name
        FROM cash_drawer_transactions cdt
        JOIN timesheets tt ON cdt.timesheet_id = tt.id
        JOIN users tu ON tt.user_id = tu.id
        LEFT JOIN employees te ON tt.employee_id = te.id
        WHERE cdt.related_timesheet_id = ? AND cdt.type = 'opening_float'
        LIMIT 1
      `, [shift.id]),
      queryOne(`
        SELECT
          COALESCE(SUM(p.amount), 0) AS total,
          COALESCE(SUM(CASE WHEN p.payment_method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash,
          COALESCE(SUM(CASE WHEN p.payment_method = 'transfer' THEN p.amount ELSE 0 END), 0) AS transfer,
          COALESCE(SUM(CASE WHEN p.payment_type = 'debt_payment' THEN p.amount ELSE 0 END), 0) AS debt_collected,
          COUNT(DISTINCT p.order_id) AS order_count
        FROM order_payments p
        WHERE p.timesheet_id = ?
      `, [shift.id]),
      // Ca khác cùng tiệm ĐANG MỞ lúc ca này vào ca — để biết ca này giữ két hay
      // vào thêm. "Đang mở" theo lúc két thực sự chốt (giờ ra có thể nhập lùi)
      query(`
        SELECT t.id, t.check_in, t.check_out, ${SHIFT_CLOSED_AT_SQL} AS closed_at,
          COALESCE(e.name, u.name) AS employee_name
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        WHERE t.store_id = ? AND t.id != ?
          AND t.check_in <= ?
          AND (t.check_out IS NULL OR GREATEST(t.check_out, COALESCE(${SHIFT_CLOSED_AT_SQL}, t.check_out)) > ?)
      `, [shift.store_id, shift.id, shift.check_in, shift.check_in]),
    ]);

    const drawer = {
      opening_float: 0, received_handover: 0, received_from: null,
      cash_payment: 0, cash_in: 0, cash_out: 0, withdrawn_at_checkout: 0,
      shortage_reimbursement: 0,
    };
    for (const tx of txRows) {
      const amount = round2(tx.amount);
      switch (tx.type) {
        case 'opening_float':
          if (tx.related_timesheet_id) {
            drawer.received_handover = round2(drawer.received_handover + amount);
            drawer.received_from = tx.from_name || `Ca #${tx.related_timesheet_id}`;
          } else {
            drawer.opening_float = round2(drawer.opening_float + amount);
          }
          break;
        case 'cash_payment': drawer.cash_payment = round2(drawer.cash_payment + amount); break;
        case 'cash_in': drawer.cash_in = round2(drawer.cash_in + amount); break;
        case 'cash_out':
          if (tx.reason === 'Rút tiền khi check-out') {
            drawer.withdrawn_at_checkout = round2(drawer.withdrawn_at_checkout + amount);
          } else {
            drawer.cash_out = round2(drawer.cash_out + amount);
          }
          break;
        case 'shortage_reimbursement': drawer.shortage_reimbursement = round2(drawer.shortage_reimbursement + amount); break;
        // closing_count: số đếm lấy từ timesheets.actual_cash_amount (bên dưới)
        default: break;
      }
    }

    const isOpen = shift.check_out === null;
    const autoClosed = Number(shift.auto_closed) === 1;
    // Cùng công thức getDrawerSummaryTx (bù thiếu KHÔNG nằm trong số dự kiến)
    const liveExpected = round2(drawer.opening_float + drawer.received_handover + drawer.cash_payment
      + drawer.cash_in - drawer.cash_out - drawer.withdrawn_at_checkout);
    const counted = !isOpen && !autoClosed && shift.actual_cash_amount != null
      ? round2(shift.actual_cash_amount)
      : null;
    const expected = counted != null ? round2(shift.expected_cash_amount) : liveExpected;

    const checkInMs = toMillis(shift.check_in);
    const holderAtCheckIn = olderOpenShiftAtTime(otherShifts, shift, checkInMs);

    res.json({
      data: {
        shift: {
          id: shift.id,
          store_name: shift.store_name,
          employee_name: shift.employee_name,
          check_in: new Date(checkInMs).toISOString(),
          check_out: shift.check_out ? new Date(toMillis(shift.check_out)).toISOString() : null,
          is_open: isOpen,
          auto_closed: autoClosed,
          regular_hours: round2(shift.regular_hours),
          overtime_hours: round2(shift.overtime_hours),
          note: shift.note || null,
          role: holderAtCheckIn ? 'joined' : 'opened',
          joined_drawer_of: holderAtCheckIn ? holderAtCheckIn.employee_name : null,
        },
        drawer: {
          ...drawer,
          // Mọi ca khi đóng đều ghi 1 dòng closing_count (kể cả ca vào thêm) —
          // không tính dòng đó, nếu không ca vào thêm luôn hiện như có giữ két
          has_activity: txRows.some((tx) => tx.type !== 'closing_count'),
          expected,
          counted,
          difference: counted != null ? round2(shift.cash_difference) : null,
          handed_to: handedOutRow ? handedOutRow.to_name : null,
          handed_amount: handedOutRow ? round2(handedOutRow.amount) : null,
        },
        revenue: {
          total: round2(paymentRow?.total),
          cash: round2(paymentRow?.cash),
          transfer: round2(paymentRow?.transfer),
          debt_collected: round2(paymentRow?.debt_collected),
          order_count: Number(paymentRow?.order_count || 0),
          // Số ghi lúc kết ca (window theo giờ) — FE báo nếu lệch với số theo két
          recorded_at_close: isOpen ? null : round2(shift.revenue_amount),
        },
      },
    });
  } catch (error) {
    console.error('Get shift detail error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get revenue by day in month (simple daily revenue list)
router.get('/revenue-daily', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const orderDateExpr = localDateSql('p.paid_at', timezoneOffset);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthYearValidation.month, monthYearValidation.year);
    const lastDay = new Date(monthYearValidation.year, monthYearValidation.month, 0).getDate();

    // Get revenue by day for the month, split by payment method
    const storeId = await resolveStoreIdForAdmin(req);
    
    let querySql = `
      SELECT 
        ${orderDateExpr} as date,
        SUM(p.amount) as total_revenue,
        SUM(CASE WHEN p.payment_method = 'cash' THEN p.amount ELSE 0 END) as cash_revenue,
        SUM(CASE WHEN p.payment_method = 'transfer' THEN p.amount ELSE 0 END) as transfer_revenue,
        COUNT(DISTINCT p.order_id) as total_orders
      FROM order_payments p
      JOIN orders o ON p.order_id = o.id
      WHERE p.payment_method IN ('cash', 'transfer')
        AND p.paid_at >= ?
        AND p.paid_at < ?
    `;
    const params = [monthRange.startAt, monthRange.endAt];

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

    querySql += ` GROUP BY ${orderDateExpr} ORDER BY date DESC`;

    // 4 aggregate của trang này độc lập nhau — build SQL xong hết rồi chạy
    // song song (Promise.all) thay vì 4 round-trip nối tiếp
    const revenuePromise = query(querySql, params);

    let withdrawnSql = `
      SELECT 
        ${timesheetDateExpr} as date,
        COALESCE(SUM(t.withdrawn_amount), 0) as total_withdrawn
      FROM timesheets t
      WHERE t.check_out IS NOT NULL
        AND t.check_in >= ?
        AND t.check_in < ?
    `;
    const withdrawnParams = [monthRange.startAt, monthRange.endAt];
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
    withdrawnSql += ` GROUP BY ${timesheetDateExpr}`;
    const withdrawnPromise = query(withdrawnSql, withdrawnParams);

    // Thêm tiền vào két (cash_in) và trừ tiền khỏi két (cash_out) mà nhân viên
    // thao tác trong ca — trước đây báo cáo bỏ sót, chỉ có phần rút (withdrawn)
    const cashDrawerDateExpr = localDateSql('cdt.occurred_at', timezoneOffset);
    let cashDrawerSql = `
      SELECT
        ${cashDrawerDateExpr} as date,
        COALESCE(SUM(CASE WHEN cdt.type = 'cash_in' THEN cdt.amount ELSE 0 END), 0) as total_cash_in,
        COALESCE(SUM(CASE WHEN cdt.type = 'cash_out' THEN cdt.amount ELSE 0 END), 0) as total_cash_out
      FROM cash_drawer_transactions cdt
      WHERE cdt.occurred_at >= ?
        AND cdt.occurred_at < ?
    `;
    const cashDrawerParams = [monthRange.startAt, monthRange.endAt];
    if (storeId) {
      cashDrawerSql += ' AND cdt.store_id = ?';
      cashDrawerParams.push(storeId);
    } else if (req.user.role === 'employer') {
      cashDrawerSql += ' AND cdt.user_id = ?';
      cashDrawerParams.push(req.user.id);
    } else if (req.user.role === 'admin') {
      cashDrawerSql += ' AND cdt.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
      cashDrawerParams.push(req.user.id);
    }
    cashDrawerSql += ` GROUP BY ${cashDrawerDateExpr}`;
    // .catch: bảng cash_drawer_transactions chưa tồn tại (chưa migrate) — coi như 0
    const cashDrawerPromise = query(cashDrawerSql, cashDrawerParams).catch(() => []);

    let notesSql = `
      SELECT 
        ${timesheetDateExpr} as date,
        GROUP_CONCAT(NULLIF(TRIM(COALESCE(t.note, '')), '') SEPARATOR ' | ') as day_notes
      FROM timesheets t
      WHERE t.check_out IS NOT NULL
        AND t.check_in >= ?
        AND t.check_in < ?
    `;
    const notesParams = [monthRange.startAt, monthRange.endAt];
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
    notesSql += ` GROUP BY ${timesheetDateExpr}`;
    const notesPromise = query(notesSql, notesParams);

    // Chạy song song cả 4 aggregate — độ trễ = query chậm nhất thay vì tổng 4
    const [revenueData, withdrawnData, cashDrawerData, notesData] = await Promise.all([
      revenuePromise, withdrawnPromise, cashDrawerPromise, notesPromise,
    ]);

    const withdrawnMap = {};
    withdrawnData.forEach((row) => {
      const dateKey = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date).split(' ')[0];
      withdrawnMap[dateKey] = parseFloat(row.total_withdrawn) || 0;
    });

    const cashInMap = {};
    const cashOutMap = {};
    cashDrawerData.forEach((row) => {
      const dateKey = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date).split(' ')[0];
      cashInMap[dateKey] = parseFloat(row.total_cash_in) || 0;
      cashOutMap[dateKey] = parseFloat(row.total_cash_out) || 0;
    });

    const notesMap = {};
    notesData.forEach((row) => {
      const dateKey = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date).split(' ')[0];
      const notes = (row.day_notes || '').trim();
      notesMap[dateKey] = notes || null;
    });

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
        total_cash_in: cashInMap[dateStr] ?? 0,
        total_cash_out: cashOutMap[dateStr] ?? 0,
        total_orders: revenueInfo.total_orders,
        day_notes: notesMap[dateStr] ?? null,
      });
    }

    // Calculate totals
    const totalRevenue = result.reduce((sum, day) => sum + day.total_revenue, 0);
    const totalCash = result.reduce((sum, day) => sum + day.cash_revenue, 0);
    const totalTransfer = result.reduce((sum, day) => sum + day.transfer_revenue, 0);
    const totalWithdrawn = result.reduce((sum, day) => sum + day.total_withdrawn, 0);
    const totalCashIn = result.reduce((sum, day) => sum + day.total_cash_in, 0);
    const totalCashOut = result.reduce((sum, day) => sum + day.total_cash_out, 0);
    const totalOrders = result.reduce((sum, day) => sum + day.total_orders, 0);

    res.json({
      data: result,
      summary: {
        total_revenue: totalRevenue,
        total_cash: totalCash,
        total_transfer: totalTransfer,
        total_withdrawn: totalWithdrawn,
        total_cash_in: totalCashIn,
        total_cash_out: totalCashOut,
        total_orders: totalOrders,
        average_daily_revenue: totalRevenue / lastDay,
      },
      month: monthYearValidation.month,
      year: monthYearValidation.year,
      days_in_month: lastDay,
    });
  } catch (error) {
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get invoices (orders) by day in month
router.get('/invoices-daily', authorize('admin', 'employer'), blockEmployeeLogin, async (req, res) => {
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const orderDateExpr = localDateSql('o.created_at', timezoneOffset);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const monthRange = getUtcRangeFromQuery(req, monthYearValidation.month, monthYearValidation.year);
    const offset = (paginationValidation.page - 1) * paginationValidation.limit;

    // Invoices daily shows all orders (not just completed) by creation date
    // This is different from revenue reports which use updated_at (completion date)
    let querySql = `
      SELECT 
        ${orderDateExpr} as date,
        o.id as order_id,
        o.code as order_code,
        c.name as customer_name,
        c.phone as customer_phone,
        o.final_amount as total_amount,
        o.status,
        u.name as employee_name,
        (
          SELECT GROUP_CONCAT(DISTINCT COALESCE(e2.name, u2.name) ORDER BY COALESCE(e2.name, u2.name) SEPARATOR ', ')
          FROM timesheets t2
          LEFT JOIN employees e2 ON t2.employee_id = e2.id
          LEFT JOIN users u2 ON t2.user_id = u2.id
          WHERE t2.store_id = u_store.store_id
            AND o.created_at >= t2.check_in
            AND o.created_at <= COALESCE(t2.check_out, NOW())
            AND ${localDateSql('t2.check_in', timezoneOffset)} = ${orderDateExpr}
        ) as shift_employee_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN users u ON o.assigned_to = u.id
      LEFT JOIN users u_store ON COALESCE(o.assigned_to, o.created_by) = u_store.id
      WHERE o.created_at >= ?
        AND o.created_at < ?
    `;
    const params = [monthRange.startAt, monthRange.endAt];
    
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

    // Neo vào "FROM orders" — xem comment ở revenue-by-product-daily
    const countSql = querySql.replace(/SELECT[\s\S]*?FROM orders/, 'SELECT COUNT(*) as total FROM orders').replace(/\s*ORDER BY[\s\S]*$/, '');
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
