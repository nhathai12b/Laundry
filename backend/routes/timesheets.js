import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { calculateHours, formatDateTimeGMT7, parseTimesheetDateTimeMs } from '../utils/helpers.js';
import { resolveStoresIdForEmployerUser } from '../utils/employerStore.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { OVERTIME_MULTIPLIER } from '../utils/constants.js';
import * as XLSX from 'xlsx';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get timesheets
router.get('/', async (req, res) => {
  try {
    const { user_id, date, month, year } = req.query;
    let sqlQuery = `
      SELECT t.*, 
        u.name as user_name,
        COALESCE(e.name, u.name) as employee_name
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE 1=1
    `;
    const params = [];

    // Admin chỉ xem chấm công cửa hàng mình sở hữu (stores.admin_id = user.id)
    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        // Chỉ chấp nhận store_id thuộc chuỗi của admin
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          sqlQuery += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          sqlQuery += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        sqlQuery += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      sqlQuery += ' AND t.user_id = ?';
      params.push(req.user.id);
    } else if (user_id) {
      sqlQuery += ' AND t.user_id = ?';
      params.push(user_id);
    }

    if (date) {
      sqlQuery += ' AND DATE(t.check_in) = ?';
      params.push(date);
    }

    // Filter by date range (for month view)
    const { start_date, end_date } = req.query;
    if (start_date && end_date) {
      sqlQuery += ' AND DATE(t.check_in) >= ? AND DATE(t.check_in) <= ?';
      params.push(start_date, end_date);
    }

    if (month && year) {
      const monthStr = String(month).padStart(2, '0');
      sqlQuery += ` AND DATE_FORMAT(t.check_in, '%m') = ? AND DATE_FORMAT(t.check_in, '%Y') = ?`;
      params.push(monthStr, year);
    }

    sqlQuery += ' ORDER BY t.check_in DESC';

    const timesheets = await query(sqlQuery, params);
    res.json({ data: timesheets });
  } catch (error) {
    console.error('Get timesheets error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get employees for store (for check-in selection)
router.get('/store-employees', async (req, res) => {
  try {
    // For employer, employees.store_id references users.id (the employer user id)
    // So we use req.user.id, not users.store_id
    const employerUserId = req.user.id;
    
    const employees = await query(`
      SELECT id, name, phone
      FROM employees
      WHERE store_id = ? AND status = 'active'
      ORDER BY name
    `, [employerUserId]);

    res.json({ data: employees });
  } catch (error) {
    console.error('Get store employees error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

/** Ca đang mở (check_out IS NULL) của user — dùng để cảnh báo checkout bù và đồng bộ UI */
router.get('/open-shifts', async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json({ data: [] });
    }
    const shifts = await query(`
      SELECT t.*,
        COALESCE(e.name, u.name) as employee_name
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE t.user_id = ? AND t.check_out IS NULL
      ORDER BY t.check_in ASC
    `, [req.user.id]);
    res.json({ data: shifts || [] });
  } catch (error) {
    console.error('Get open shifts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

function normalizeCheckoutAtTime(input) {
  if (input === undefined || input === null || input === '') {
    return { ok: true, mysql: null };
  }
  let s = String(input).trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) {
    s += ':00';
  }
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return { ok: false, error: 'Định dạng giờ ra không hợp lệ (YYYY-MM-DD HH:mm, giờ Việt Nam GMT+7).' };
  }
  return { ok: true, mysql: s };
}

// Check in
router.post('/check-in', async (req, res) => {
  try {
    // Only employer can check in (not admin)
    if (req.user.role === 'admin') {
      return res.status(403).json({ error: 'Admin không thể check-in. Vui lòng sử dụng tài khoản nhân viên.' });
    }

    const { employee_id, note } = req.body;

    const storeId = await resolveStoresIdForEmployerUser(req.user.id);
    if (!storeId) {
      return res.status(400).json({
        error:
          'Tài khoản chưa gắn cửa hàng (store_id) hoặc chưa được gán làm tài khoản chung cho cửa hàng nào. Vui lòng liên hệ admin.',
      });
    }
    
    // Ưu tiên dùng employee_id từ token (nếu đã chọn khi login)
    // Nếu không có trong token, dùng từ request body
    let employeeId = req.user.employee_id || employee_id || null;
    
    // Verify employee belongs to the same store
    // Note: employees.store_id references users.id (the employer user id)
    if (employeeId) {
      const employee = await queryOne('SELECT * FROM employees WHERE id = ? AND store_id = ? AND status = ?', [employeeId, req.user.id, 'active']);
      if (!employee) {
        return res.status(400).json({ error: 'Employee does not belong to your store' });
      }
    }

    // Lưu giờ vào theo GMT+7 (Việt Nam) — đúng chấm công / xuất Excel
    const checkIn = formatDateTimeGMT7(new Date());

    // Một employer chỉ 1 ca mở (không lọc store_id): phải khớp GET /open-shifts.
    // Dữ liệu cũ có store_id NULL vẫn là ca mở — nếu chỉ so khớp store_id hiện tại sẽ INSERT thêm ca,
    // UI / checkout lệch (open-shifts trả ca khác hoặc nhiều ca).
    const anyOpenShift = await queryOne(
      `
      SELECT id, check_in FROM timesheets
      WHERE user_id = ? AND check_out IS NULL
      ORDER BY check_in ASC
      LIMIT 1
    `,
      [req.user.id]
    );
    if (anyOpenShift) {
      const d = String(anyOpenShift.check_in || '').slice(0, 10);
      return res.status(400).json({
        error: `Bạn đã có ca chưa check-out (check-in ${d}). Hãy bấm Check-out trước khi check-in lại — kể cả khi muốn đổi nhân viên.`,
        code: 'OPEN_SHIFT_EXISTS',
        open_shift: { id: anyOpenShift.id, check_in: anyOpenShift.check_in },
      });
    }

    const result = await execute(`
      INSERT INTO timesheets (user_id, store_id, employee_id, check_in, note)
      VALUES (?, ?, ?, ?, ?)
    `, [req.user.id, storeId, employeeId, checkIn, note || null]);

    const timesheet = await queryOne(`
      SELECT t.*, 
        u.name as user_name, 
        e.name as employee_name
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE t.id = ?
    `, [result.insertId]);

    res.status(201).json({ data: timesheet });
  } catch (error) {
    console.error('Check in error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error:
          'Dữ liệu chấm công bị trùng (có thể đã check-in). Hãy tải lại trang Chấm công; nếu vẫn có ca mở thì check-out trước khi check-in lại.',
        code: 'DUPLICATE_CHECKIN',
      });
    }
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get expected revenue for current shift (tổng số tiền từ các đơn đã hoàn thành trong ca)
router.get('/expected-revenue', async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json({ data: { expected_revenue: 0, order_count: 0, total_withdrawn: 0 } });
    }

    const timesheetIdParam = req.query.timesheet_id ? parseInt(req.query.timesheet_id, 10) : null;

    let timesheet;
    if (timesheetIdParam && !Number.isNaN(timesheetIdParam)) {
      timesheet = await queryOne(`
        SELECT * FROM timesheets
        WHERE id = ? AND user_id = ? AND check_out IS NULL
      `, [timesheetIdParam, req.user.id]);
    }
    if (!timesheet) {
      timesheet = await queryOne(`
        SELECT * FROM timesheets
        WHERE user_id = ? AND check_out IS NULL
        ORDER BY check_in ASC
        LIMIT 1
      `, [req.user.id]);
    }

    if (!timesheet) {
      return res.json({ data: { expected_revenue: 0, order_count: 0 } });
    }

    // Calculate total revenue and total withdrawn from completed orders in this shift
    // Tính tổng từ các đơn có status = 'completed' và được hoàn thành sau khi check-in
    // Filter by store_id if available
    let revenueQuery = `
      SELECT 
        COALESCE(SUM(final_amount), 0) as expected_revenue,
        COUNT(*) as order_count,
        COALESCE(SUM(withdrawn_amount), 0) as total_withdrawn
      FROM orders
      WHERE status = 'completed'
        AND updated_at >= ?
        AND updated_at <= NOW()
        AND (assigned_to = ? OR created_by = ?)
    `;
    const revenueParams = [timesheet.check_in, req.user.id, req.user.id];
    
    // Filter by store_id if timesheet has store_id
    if (timesheet.store_id) {
      revenueQuery += ' AND store_id = ?';
      revenueParams.push(timesheet.store_id);
    }
    
    const revenueData = await queryOne(revenueQuery, revenueParams);

    const expectedRevenue = revenueData?.expected_revenue || 0;
    const orderCount = revenueData?.order_count || 0;
    const totalWithdrawn = parseFloat(revenueData?.total_withdrawn) || 0;

    // Debug log removed for security

    res.json({ 
      data: { 
        expected_revenue: expectedRevenue,
        order_count: orderCount,
        total_withdrawn: totalWithdrawn
      } 
    });
  } catch (error) {
    console.error('Get expected revenue error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Check out
router.post('/check-out', async (req, res) => {
  try {
    // Only employer can check out (not admin)
    if (req.user.role === 'admin') {
      return res.status(403).json({ error: 'Admin không thể check-out. Vui lòng sử dụng tài khoản nhân viên.' });
    }

    const { note, revenue_amount, expected_revenue, withdrawn_amount: checkoutWithdrawn, timesheet_id, check_out_at } = req.body;
    const userId = req.user.id;

    // Validate revenue_amount - allow any numeric value
    if (revenue_amount === undefined || revenue_amount === null || revenue_amount === '') {
      return res.status(400).json({ error: 'Số tiền thực tế là bắt buộc' });
    }
    
    const revenueValue = parseFloat(revenue_amount);
    
    if (isNaN(revenueValue)) {
      return res.status(400).json({ error: 'Số tiền thực tế phải là số hợp lệ' });
    }

    const tsId = timesheet_id !== undefined && timesheet_id !== null && timesheet_id !== ''
      ? parseInt(timesheet_id, 10)
      : null;

    let timesheet;
    if (tsId && !Number.isNaN(tsId)) {
      timesheet = await queryOne(`
        SELECT * FROM timesheets
        WHERE id = ? AND user_id = ? AND check_out IS NULL
      `, [tsId, userId]);
    }
    if (!timesheet) {
      timesheet = await queryOne(`
        SELECT * FROM timesheets
        WHERE user_id = ? AND check_out IS NULL
        ORDER BY check_in ASC
        LIMIT 1
      `, [userId]);
    }

    if (!timesheet) {
      return res.status(400).json({
        error: 'Không tìm thấy ca làm việc đang mở. Vui lòng check-in hoặc liên hệ quản trị viên.',
      });
    }

    const normOut = normalizeCheckoutAtTime(check_out_at);
    if (!normOut.ok) {
      return res.status(400).json({ error: normOut.error });
    }
    let checkOut = normOut.mysql;
    if (!checkOut) {
      checkOut = formatDateTimeGMT7(new Date());
    }

    const checkInMs = parseTimesheetDateTimeMs(timesheet.check_in);
    const checkOutMs = parseTimesheetDateTimeMs(checkOut);
    if (Number.isNaN(checkOutMs) || Number.isNaN(checkInMs) || checkOutMs < checkInMs) {
      return res.status(400).json({ error: 'Giờ ra phải sau giờ vào ca.' });
    }
    if (checkOutMs > Date.now()) {
      return res.status(400).json({ error: 'Giờ ra không được sau thời điểm hiện tại.' });
    }

    // Calculate hours
    const { regular, overtime } = calculateHours(timesheet.check_in, checkOut);

    // withdrawn_amount at checkout (optional): parse if provided
    const withdrawnValue = (checkoutWithdrawn !== undefined && checkoutWithdrawn !== null && checkoutWithdrawn !== '')
      ? (parseFloat(checkoutWithdrawn) || null)
      : null;

    // Update timesheet with actual revenue, expected revenue, withdrawn_amount
    const updateResult = await execute(`
      UPDATE timesheets
      SET check_out = ?,
          regular_hours = ?,
          overtime_hours = ?,
          revenue_amount = ?,
          expected_revenue = ?,
          withdrawn_amount = ?,
          note = COALESCE(?, note)
      WHERE id = ?
    `, [
      checkOut, 
      regular, 
      overtime, 
      revenueValue, 
      expected_revenue || null, 
      withdrawnValue, 
      note || null, 
      timesheet.id
    ]);

    if (updateResult.affectedRows === 0) {
      return res.status(400).json({ error: 'Không thể cập nhật ca làm việc' });
    }

    const updated = await queryOne(`
      SELECT t.*, 
        u.name as user_name,
        e.name as employee_name
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE t.id = ?
    `, [timesheet.id]);

    res.json({ data: updated });
  } catch (error) {
    console.error('Check out error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get summary (Admin only)
router.get('/summary', authorize('admin'), async (req, res) => {
  try {
    const { user_id, month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year are required' });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    let querySql = `
      SELECT 
        t.user_id,
        u.name as user_name,
        COUNT(*) as total_days,
        SUM(t.regular_hours) as total_regular_hours,
        SUM(t.overtime_hours) as total_overtime_hours,
        SUM(t.regular_hours + t.overtime_hours) as total_hours,
        SUM(t.revenue_amount) as total_revenue
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      WHERE DATE_FORMAT(t.check_in, '%m') = ? AND DATE_FORMAT(t.check_in, '%Y') = ?
        AND t.check_out IS NOT NULL
    `;
    const params = [String(month).padStart(2, '0'), year];

    // Admin chuỗi: chỉ xem chấm công cửa hàng mình sở hữu (stores.admin_id = user.id)
    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          querySql += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.store_id) {
      querySql += ' AND t.store_id = ?';
      params.push(req.user.store_id);
    }

    if (user_id) {
      querySql += ' AND t.user_id = ?';
      params.push(user_id);
    }

    querySql += ' GROUP BY t.user_id, u.name';

    const summary = await query(querySql, params);
    res.json({ data: summary });
  } catch (error) {
    console.error('Get timesheet summary error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by shift (Admin only)
router.get('/revenue-by-shift', authorize('admin'), async (req, res) => {
  try {
    const { month, year, user_id } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year are required' });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    let querySql = `
      SELECT 
        t.id,
        t.user_id,
        u.name as user_name,
        DATE(t.check_in) as shift_date,
        TIME(t.check_in) as check_in_time,
        TIME(t.check_out) as check_out_time,
        t.regular_hours,
        t.overtime_hours,
        t.revenue_amount,
        t.note
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      WHERE DATE_FORMAT(t.check_in, '%m') = ? AND DATE_FORMAT(t.check_in, '%Y') = ?
        AND t.check_out IS NOT NULL
        AND t.revenue_amount > 0
    `;
    const params = [String(month).padStart(2, '0'), year];

    // Admin chuỗi: chỉ xem chấm công cửa hàng mình sở hữu
    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          querySql += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.store_id) {
      querySql += ' AND t.store_id = ?';
      params.push(req.user.store_id);
    }

    if (user_id) {
      querySql += ' AND t.user_id = ?';
      params.push(user_id);
    }

    querySql += ' ORDER BY t.check_in DESC';

    const shifts = await query(querySql, params);
    res.json({ data: shifts });
  } catch (error) {
    console.error('Get revenue by shift error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get payroll calculation (Admin only) - Tính lương theo tuần/tháng
router.get('/payroll', authorize('admin'), async (req, res) => {
  try {
    const { period, week, month, year, user_id } = req.query;

    if (!period || !['week', 'month'].includes(period)) {
      return res.status(400).json({ error: 'Period must be "week" or "month"' });
    }

    let startDate, endDate;
    if (period === 'week') {
      if (!week || !year) {
        return res.status(400).json({ error: 'Week and year are required for weekly payroll' });
      }
      // Calculate week start and end dates (ISO week)
      const simple = new Date(year, 0, 1 + (week - 1) * 7);
      const dow = simple.getDay();
      const ISOweekStart = simple;
      if (dow <= 4) {
        ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
      } else {
        ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());
      }
      startDate = new Date(ISOweekStart);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
      startDate = startDate.toISOString().split('T')[0];
      endDate = endDate.toISOString().split('T')[0];
    } else {
      if (!month || !year) {
        return res.status(400).json({ error: 'Month and year are required for monthly payroll' });
      }
      startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    let querySql = `
      SELECT 
        COALESCE(t.employee_id, t.user_id) as employee_id,
        COALESCE(e.name, u.name) as employee_name,
        u.hourly_rate as hourly_rate,
        u.shift_rate as shift_rate,
        COUNT(*) as total_shifts,
        SUM(t.regular_hours) as total_regular_hours,
        SUM(t.overtime_hours) as total_overtime_hours,
        SUM(t.regular_hours + t.overtime_hours) as total_hours,
        SUM(t.revenue_amount) as total_revenue
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE DATE(t.check_in) >= ? AND DATE(t.check_in) <= ?
        AND t.check_out IS NOT NULL
    `;
    const params = [startDate, endDate];
    
    // Admin chuỗi: chỉ xem chấm công cửa hàng mình sở hữu; validate store_id nếu có
    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          querySql += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      querySql += ' AND t.store_id = ?';
      params.push(req.user.store_id);
    }

    if (user_id) {
      querySql += ' AND t.user_id = ?';
      params.push(user_id);
    }

    querySql += ' GROUP BY COALESCE(t.employee_id, t.user_id), COALESCE(e.name, u.name), u.hourly_rate, u.shift_rate ORDER BY COALESCE(e.name, u.name)';

    const timesheets = await query(querySql, params);

    // Calculate salary for each employee
    const payroll = timesheets.map((ts) => {
      let salary = 0;
      
      // Calculate based on hourly rate if available
      if (ts.hourly_rate) {
        salary = (ts.total_regular_hours || 0) * ts.hourly_rate;
        // Overtime multiplier (configurable via OVERTIME_MULTIPLIER constant)
        salary += (ts.total_overtime_hours || 0) * ts.hourly_rate * OVERTIME_MULTIPLIER;
      }
      
      // Add shift rate if available (alternative calculation method)
      if (ts.shift_rate) {
        const shiftSalary = (ts.total_shifts || 0) * ts.shift_rate;
        // Use the higher of hourly or shift rate calculation
        if (shiftSalary > salary) {
          salary = shiftSalary;
        }
      }

      return {
        user_id: ts.employee_id,
        employee_id: ts.employee_id,
        user_name: ts.employee_name,
        employee_name: ts.employee_name,
        hourly_rate: ts.hourly_rate || 0,
        shift_rate: ts.shift_rate || 0,
        total_shifts: ts.total_shifts || 0,
        total_regular_hours: ts.total_regular_hours || 0,
        total_overtime_hours: ts.total_overtime_hours || 0,
        total_hours: ts.total_hours || 0,
        total_revenue: ts.total_revenue || 0,
        salary: Math.round(salary * 100) / 100,
      };
    });

    res.json({ 
      data: payroll,
      period,
      start_date: startDate,
      end_date: endDate,
      total_salary: payroll.reduce((sum, p) => sum + p.salary, 0),
      total_hours: payroll.reduce((sum, p) => sum + p.total_hours, 0),
    });
  } catch (error) {
    console.error('Get payroll error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get daily hours for each employee in a month (Admin only)
router.get('/daily-hours', authorize('admin'), async (req, res) => {
  try {
    const { month, year, user_id } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year are required' });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    const monthStr = String(month).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();

    // Get all timesheets for the month
    let querySql = `
      SELECT 
        COALESCE(t.employee_id, t.user_id) as employee_id,
        COALESCE(e.name, u.name) as employee_name,
        DATE(t.check_in) as work_date,
        t.regular_hours,
        t.overtime_hours,
        (t.regular_hours + t.overtime_hours) as total_hours
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE DATE_FORMAT(t.check_in, '%m') = ? AND DATE_FORMAT(t.check_in, '%Y') = ?
        AND t.check_out IS NOT NULL
    `;
    const params = [monthStr, year];
    
    // Admin chuỗi: chỉ xem chấm công cửa hàng mình sở hữu; validate store_id nếu có
    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          querySql += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      querySql += ' AND t.store_id = ?';
      params.push(req.user.store_id);
    }

    if (user_id) {
      querySql += ' AND t.user_id = ?';
      params.push(user_id);
    }

    querySql += ' ORDER BY COALESCE(e.name, u.name), t.check_in';

    const timesheets = await query(querySql, params);

    // Group by employee and date
    const employeeMap = {};
    
    timesheets.forEach((ts) => {
      const empId = ts.employee_id;
      if (!employeeMap[empId]) {
        employeeMap[empId] = {
          user_id: empId,
          employee_id: empId,
          user_name: ts.employee_name,
          employee_name: ts.employee_name,
          daily_hours: {},
        };
      }
      
      const dateKey = ts.work_date;
      if (!employeeMap[empId].daily_hours[dateKey]) {
        employeeMap[empId].daily_hours[dateKey] = 0;
      }
      
      // Sum hours if multiple shifts in the same day
      employeeMap[empId].daily_hours[dateKey] += ts.total_hours || 0;
    });

    // Convert to array format with all days of the month
    const result = Object.values(employeeMap).map((emp) => {
      const dailyHours = {};
      
      // Initialize all days with 0
      for (let day = 1; day <= lastDay; day++) {
        const dateKey = `${year}-${monthStr}-${String(day).padStart(2, '0')}`;
        dailyHours[dateKey] = emp.daily_hours[dateKey] || 0;
      }
      
      return {
        user_id: emp.user_id,
        employee_id: emp.employee_id,
        user_name: emp.employee_name,
        employee_name: emp.employee_name,
        daily_hours: dailyHours,
        total_month_hours: Object.values(emp.daily_hours).reduce((sum, hours) => sum + hours, 0),
      };
    });

    res.json({ 
      data: result,
      month: parseInt(month),
      year: parseInt(year),
      days_in_month: lastDay,
    });
  } catch (error) {
    console.error('Get daily hours error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export timesheets to Excel
router.get('/export', async (req, res) => {
  try {
    const { user_id, date, month, year, start_date, end_date, store_id } = req.query;
    
    let sqlQuery = `
      SELECT 
        t.id,
        u.name as user_name,
        COALESCE(e.name, u.name) as employee_name,
        DATE(t.check_in) as date,
        TIME(t.check_in) as check_in_time,
        TIME(t.check_out) as check_out_time,
        t.regular_hours,
        t.overtime_hours,
        t.revenue_amount,
        t.expected_revenue,
        t.note,
        s.name as store_name
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN stores s ON t.store_id = s.id
      WHERE 1=1
    `;
    const params = [];

    // Admin chuỗi: chỉ xem chấm công cửa hàng mình sở hữu; validate store_id nếu có
    const storeIdParam = store_id || req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          sqlQuery += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          sqlQuery += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        sqlQuery += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      sqlQuery += ' AND t.user_id = ?';
      params.push(req.user.id);
    } else if (user_id) {
      sqlQuery += ' AND t.user_id = ?';
      params.push(user_id);
    }

    if (date) {
      sqlQuery += ' AND DATE(t.check_in) = ?';
      params.push(date);
    }

    if (start_date && end_date) {
      sqlQuery += ' AND DATE(t.check_in) >= ? AND DATE(t.check_in) <= ?';
      params.push(start_date, end_date);
    }

    if (month && year) {
      const monthStr = String(month).padStart(2, '0');
      sqlQuery += ` AND DATE_FORMAT(t.check_in, '%m') = ? AND DATE_FORMAT(t.check_in, '%Y') = ?`;
      params.push(monthStr, year);
    }

    sqlQuery += ' ORDER BY t.check_in DESC';

    const timesheets = await query(sqlQuery, params);

    // Format data for Excel
    const data = timesheets.map(t => ({
      'ID': t.id,
      'Tên nhân viên': t.employee_name || t.user_name,
      'Ngày': t.date,
      'Giờ vào': t.check_in_time || '',
      'Giờ ra': t.check_out_time || '',
      'Giờ thường': t.regular_hours || 0,
      'Giờ tăng ca': t.overtime_hours || 0,
      'Doanh thu': t.revenue_amount || 0,
      'Doanh thu dự kiến': t.expected_revenue || 0,
      'Ghi chú': t.note || '',
      'Cửa hàng': t.store_name || ''
    }));

    // Create workbook and worksheet
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(data);
    
    // Set column widths
    const colWidths = [
      { wch: 8 },   // ID
      { wch: 20 },  // Tên nhân viên
      { wch: 12 },  // Ngày
      { wch: 10 },  // Giờ vào
      { wch: 10 },  // Giờ ra
      { wch: 12 },  // Giờ thường
      { wch: 12 },  // Giờ tăng ca
      { wch: 15 },  // Doanh thu
      { wch: 18 },  // Doanh thu dự kiến
      { wch: 30 },  // Ghi chú
      { wch: 20 }   // Cửa hàng
    ];
    worksheet['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Chấm công');

    // Generate filename
    let fileName = 'ChamCong';
    if (date) {
      fileName += `_${date}`;
    } else if (month && year) {
      fileName += `_${month}_${year}`;
    } else if (start_date && end_date) {
      fileName += `_${start_date}_${end_date}`;
    } else {
      fileName += `_${new Date().toISOString().slice(0, 10)}`;
    }
    fileName += '.xlsx';

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Set headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

    res.send(buffer);
  } catch (error) {
    console.error('Export timesheets error:', error);
    res.status(500).json({ error: 'Lỗi khi export chấm công' });
  }
});

export default router;

