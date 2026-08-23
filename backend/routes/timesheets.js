import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { calculateHours, formatDateTimeUTC, parseTimesheetDateTimeMs } from '../utils/helpers.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { OVERTIME_MULTIPLIER } from '../utils/constants.js';
import { ensureOpeningFloatTx, getDrawerSummaryTx, recordClosingCountTx } from '../services/cashDrawerService.js';
import * as XLSX from 'xlsx';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

const toIsoDateTime = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim().replace(' ', 'T');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(`${s}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const LEGACY_VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 60 * 1000;

const normalizeLegacyFutureTimeMs = (ms) => {
  if (Number.isNaN(ms)) return ms;
  return ms;
};

const parseTimesheetDateTimeMsCompat = (value) => {
  return normalizeLegacyFutureTimeMs(parseTimesheetDateTimeMs(value));
};

const toIsoDateTimeCompat = (value) => {
  const ms = parseTimesheetDateTimeMsCompat(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const serializeTimesheet = (timesheet) => {
  if (!timesheet) return timesheet;
  return {
    ...timesheet,
    check_in: toIsoDateTimeCompat(timesheet.check_in),
    check_out: toIsoDateTimeCompat(timesheet.check_out),
    created_at: toIsoDateTime(timesheet.created_at),
  };
};

const serializeTimesheets = (timesheets) => timesheets.map(serializeTimesheet);

const isoToMysqlUtc = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTimeUTC(date);
};

const getTimezoneOffsetMinutes = (req) => {
  const offset = Number.parseInt(req.query.timezone_offset_minutes ?? '0', 10);
  if (Number.isNaN(offset) || offset < -840 || offset > 840) return 0;
  return offset;
};

const localDateSql = (column, offsetMinutes) => {
  return `DATE(DATE_SUB(${column}, INTERVAL ${offsetMinutes} MINUTE))`;
};

const getMonthUtcRange = (req, month, year) => {
  if (req.query.start_at && req.query.end_at) {
    const startAt = isoToMysqlUtc(req.query.start_at);
    const endAt = isoToMysqlUtc(req.query.end_at);
    if (startAt && endAt) return { startAt, endAt };
  }
  const offset = getTimezoneOffsetMinutes(req);
  const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1) - offset * 60 * 1000);
  const end = new Date(Date.UTC(Number(year), Number(month), 1) - offset * 60 * 1000);
  return { startAt: formatDateTimeUTC(start), endAt: formatDateTimeUTC(end) };
};

const formatWithTimezoneOffset = (value, timezoneOffsetMinutes, type = 'date') => {
  const ms = parseTimesheetDateTimeMsCompat(value);
  if (Number.isNaN(ms)) return '';
  const local = new Date(ms - timezoneOffsetMinutes * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  const hour = String(local.getUTCHours()).padStart(2, '0');
  const minute = String(local.getUTCMinutes()).padStart(2, '0');
  const second = String(local.getUTCSeconds()).padStart(2, '0');
  return type === 'time' ? `${hour}:${minute}:${second}` : `${year}-${month}-${day}`;
};

async function getShiftPaymentSummary(db, timesheet, userId, startAt, endAt) {
  let paymentsSubquery = `
    SELECT p.order_id, SUM(p.amount) AS amount
    FROM order_payments p
    JOIN orders o2 ON p.order_id = o2.id
    WHERE p.paid_at >= ?
      AND p.paid_at <= ?
      AND p.payment_method IN ('cash', 'transfer')
      AND (p.user_id = ? OR o2.assigned_to = ? OR o2.created_by = ?)
  `;
  const params = [startAt, endAt, userId, userId, userId];

  if (timesheet.store_id) {
    paymentsSubquery += ' AND COALESCE(p.store_id, o2.store_id) = ?';
    params.push(timesheet.store_id);
  }

  paymentsSubquery += ' GROUP BY p.order_id';

  const summary = await db.queryOne(`
    SELECT
      COALESCE(SUM(agg.amount), 0) AS revenue_amount,
      COUNT(*) AS order_count,
      COALESCE(SUM(o.withdrawn_amount), 0) AS total_withdrawn
    FROM (${paymentsSubquery}) agg
    JOIN orders o ON o.id = agg.order_id
  `, params);

  return {
    revenue_amount: Number.parseFloat(summary?.revenue_amount || 0) || 0,
    order_count: Number(summary?.order_count || 0),
    total_withdrawn: Number.parseFloat(summary?.total_withdrawn || 0) || 0,
  };
}

const EMPTY_PAYMENT_SUMMARY = { revenue_amount: 0, order_count: 0, total_withdrawn: 0 };

// Concurrent-shift revenue attribution. When several employees stand the same
// shift (multiple open timesheets in one store), shift revenue must be counted
// exactly once:
// - the OLDEST open shift ("ca chính") owns the revenue window
// - a shift closing while an older one is still open ("ca phụ") takes 0 —
//   the primary will claim those payments when it closes
// - a primary's window starts right after the latest check_out already claimed
//   by an earlier-starting overlapping shift, so nothing is counted twice when
//   the previous primary closed first and this shift inherited the drawer
async function hasOlderOpenShiftTx(db, timesheet, checkInSql) {
  const older = await db.queryOne(`
    SELECT id FROM timesheets
    WHERE store_id = ? AND check_out IS NULL AND id != ?
      AND (check_in < ? OR (check_in = ? AND id < ?))
    LIMIT 1
  `, [timesheet.store_id, timesheet.id, checkInSql, checkInSql, timesheet.id]);
  return Boolean(older);
}

async function getRevenueWindowStartTx(db, timesheet, checkInSql, checkOutSql) {
  const row = await db.queryOne(`
    SELECT MAX(check_out) AS last_claimed_until
    FROM timesheets
    WHERE store_id = ? AND id != ? AND check_out IS NOT NULL
      AND check_in <= ? AND check_out > ? AND check_out <= ?
  `, [timesheet.store_id, timesheet.id, checkInSql, checkInSql, checkOutSql]);
  if (!row?.last_claimed_until) return checkInSql;
  const ms = parseTimesheetDateTimeMsCompat(row.last_claimed_until);
  // +1s: the previous shift claimed payments up to AND INCLUDING its check_out
  return Number.isNaN(ms) ? checkInSql : formatDateTimeUTC(new Date(ms + 1000));
}

async function getShiftPaymentSummaryDeduped(db, timesheet, userId, checkInSql, checkOutSql) {
  if (await hasOlderOpenShiftTx(db, timesheet, checkInSql)) {
    return { ...EMPTY_PAYMENT_SUMMARY };
  }
  const windowStart = await getRevenueWindowStartTx(db, timesheet, checkInSql, checkOutSql);
  return getShiftPaymentSummary(db, timesheet, userId, windowStart, checkOutSql);
}

// Get timesheets
router.get('/', async (req, res) => {
  try {
    const { user_id, date, month, year, start_at, end_at } = req.query;
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

    const storeIdParam = req.query.store_id;
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

    if (start_at && end_at) {
      const startAt = isoToMysqlUtc(start_at);
      const endAt = isoToMysqlUtc(end_at);
      if (!startAt || !endAt) {
        return res.status(400).json({ error: 'Invalid date range' });
      }
      sqlQuery += ' AND t.check_in >= ? AND t.check_in < ?';
      params.push(startAt, endAt);
    } else if (date) {
      sqlQuery += ' AND DATE(t.check_in) = ?';
      params.push(date);
    }

    // Filter by date range (for month view)
    const { start_date, end_date } = req.query;
    if (!start_at && !end_at && start_date && end_date) {
      sqlQuery += ' AND DATE(t.check_in) >= ? AND DATE(t.check_in) <= ?';
      params.push(start_date, end_date);
    }

    if (!start_at && !end_at && month && year) {
      const monthStr = String(month).padStart(2, '0');
      sqlQuery += ` AND DATE_FORMAT(t.check_in, '%m') = ? AND DATE_FORMAT(t.check_in, '%Y') = ?`;
      params.push(monthStr, year);
    }

    sqlQuery += ' ORDER BY t.check_in DESC';

    const timesheets = await query(sqlQuery, params);
    res.json({ data: serializeTimesheets(timesheets) });
  } catch (error) {
    console.error('Get timesheets error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get employees for store (for check-in selection)
router.get('/store-employees', async (req, res) => {
  try {
    let employeeQuery = `
      SELECT id, name, phone
      FROM employees
      WHERE status = 'active'
    `;
    const params = [];

    if (req.user.role === 'employer') {
      employeeQuery += ` AND store_id = ?`;
      params.push(req.user.id);
    } else if (req.user.role === 'admin') {
      const storeIds = await query(`SELECT id FROM stores WHERE admin_id = ?`, [req.user.id]);
      if (!storeIds || storeIds.length === 0) {
        return res.json({ data: [] });
      }
      const storeIdList = storeIds.map(s => s.id);
      employeeQuery += ` AND store_id IN (${storeIdList.map(() => '?').join(',')})`;
      params.push(...storeIdList);
    } else {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    employeeQuery += ` ORDER BY name`;
    const employees = await query(employeeQuery, params);

    res.json({ data: employees });
  } catch (error) {
    console.error('Get store employees error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

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
    res.json({ data: serializeTimesheets(shifts || []) });
  } catch (error) {
    console.error('Get open shifts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

function normalizeCheckoutAtTime(input) {
  if (input === undefined || input === null || input === '') {
    return { ok: true, mysql: null };
  }
  let s = String(input).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const mysql = isoToMysqlUtc(s);
    if (!mysql) {
      return { ok: false, error: 'Định dạng giờ ra không hợp lệ.' };
    }
    return { ok: true, mysql };
  }
  s = s.replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s += ':00';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return { ok: false, error: 'Định dạng giờ ra không hợp lệ.' };
  }
  return { ok: true, mysql: formatDateTimeUTC(new Date(`${s.replace(' ', 'T')}Z`)) };
}

// Check in
router.post('/check-in', async (req, res) => {
  try {
    // Only employer can check in (not admin)
    if (req.user.role === 'admin') {
      return res.status(403).json({ error: 'Admin không thể check-in. Vui lòng sử dụng tài khoản nhân viên.' });
    }

    const { employee_id, note, opening_cash_amount } = req.body;
    
    // Get the actual store_id from users table (users.store_id references stores.id)
    // For employer, we need to get users.store_id, not users.id
    const user = await queryOne('SELECT store_id FROM users WHERE id = ? AND role = ?', [req.user.id, 'employer']);
    
    if (!user || !user.store_id) {
      return res.status(400).json({ error: 'Employer account không có cửa hàng được gán. Vui lòng liên hệ admin.' });
    }
    
    const storeId = user.store_id; // This is stores.id, not users.id

    // Body employee_id takes precedence over the token's employee_id so a
    // shared device/session can check in a DIFFERENT teammate onto the same
    // shift. Either way the employee is validated against the store below.
    let employeeId = employee_id || req.user.employee_id || null;

    // Verify employee belongs to the same store
    // Note: employees.store_id references users.id (the employer user id)
    if (employeeId) {
      const employee = await queryOne('SELECT * FROM employees WHERE id = ? AND store_id = ? AND status = ?', [employeeId, req.user.id, 'active']);
      if (!employee) {
        return res.status(400).json({ error: 'Employee does not belong to your store' });
      }
    } else {
      // Checking in WITHOUT a name is only allowed for the first open shift.
      // Anyone joining an already-open shift must pick their own name so each
      // concurrent person gets their own timesheet slot.
      const anyOpen = await queryOne(
        'SELECT id FROM timesheets WHERE store_id = ? AND check_out IS NULL LIMIT 1',
        [storeId]
      );
      if (anyOpen) {
        return res.status(400).json({
          error: 'Đã có ca đang mở. Người check-in thêm phải chọn tên nhân viên của mình.',
          code: 'EMPLOYEE_REQUIRED',
        });
      }
    }

    const checkIn = formatDateTimeUTC(new Date());

    let openSameSlot;
    if (employeeId) {
      openSameSlot = await queryOne(`
        SELECT id, check_in FROM timesheets
        WHERE store_id = ? AND employee_id = ? AND check_out IS NULL
        LIMIT 1
      `, [storeId, employeeId]);
    } else {
      openSameSlot = await queryOne(`
        SELECT id, check_in FROM timesheets
        WHERE store_id = ? AND employee_id IS NULL AND check_out IS NULL
        LIMIT 1
      `, [storeId]);
    }
    if (openSameSlot) {
      const d = String(openSameSlot.check_in || '').slice(0, 10);
      return res.status(400).json({
        error: employeeId
          ? `Nhân viên này còn ca chưa check-out (check-in ${d}). Vui lòng check-out ca đó trước, hoặc chọn nhân viên khác.`
          : `Còn ca chưa checkout (check-in ${d}). Vui lòng check-out ca này trước khi mở ca mới.`,
        code: 'OPEN_SHIFT_EXISTS',
        open_shift: { id: openSameSlot.id, check_in: openSameSlot.check_in },
      });
    }

    const timesheet = await transaction(async (db) => {
      const result = await db.execute(`
        INSERT INTO timesheets (user_id, store_id, employee_id, check_in, note)
        VALUES (?, ?, ?, ?, ?)
      `, [req.user.id, storeId, employeeId, checkIn, note || null]);

      const created = await db.queryOne(`
        SELECT t.*, 
          u.name as user_name, 
          e.name as employee_name
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        WHERE t.id = ?
      `, [result.insertId]);

      await ensureOpeningFloatTx(db, created, opening_cash_amount || 0, req.user);
      return db.queryOne(`
        SELECT t.*, 
          u.name as user_name, 
          e.name as employee_name
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        WHERE t.id = ?
      `, [result.insertId]);
    });

    res.status(201).json({ data: serializeTimesheet(timesheet) });
  } catch (error) {
    console.error('Check in error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

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

    const normalizedCheckIn = formatDateTimeUTC(new Date(parseTimesheetDateTimeMsCompat(timesheet.check_in)));
    const revenueData = await getShiftPaymentSummaryDeduped({
      queryOne,
    }, timesheet, req.user.id, normalizedCheckIn, formatDateTimeUTC(new Date()));
    const drawerSummary = await getDrawerSummaryTx({
      queryOne,
      execute,
    }, timesheet.id);

    // Debug log removed for security

    res.json({ 
      data: { 
        expected_revenue: revenueData.revenue_amount,
        order_count: revenueData.order_count,
        total_withdrawn: revenueData.total_withdrawn,
        cash_drawer: drawerSummary
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

    const {
      note,
      revenue_amount,
      expected_revenue,
      withdrawn_amount: checkoutWithdrawn,
      timesheet_id,
      check_out_at,
      actual_cash_amount,
      cash_shortage_paid_amount,
    } = req.body;
    const userId = req.user.id;

    const actualCashInput = actual_cash_amount !== undefined && actual_cash_amount !== null && actual_cash_amount !== ''
      ? actual_cash_amount
      : revenue_amount;

    if (actualCashInput === undefined || actualCashInput === null || actualCashInput === '') {
      return res.status(400).json({ error: 'Số tiền mặt thực đếm là bắt buộc' });
    }
    
    const actualCashValue = parseFloat(actualCashInput);
    
    if (isNaN(actualCashValue) || actualCashValue < 0) {
      return res.status(400).json({ error: 'Số tiền mặt thực đếm phải là số hợp lệ' });
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
      checkOut = formatDateTimeUTC(new Date());
    }

    const checkInMs = parseTimesheetDateTimeMsCompat(timesheet.check_in);
    const checkOutMs = parseTimesheetDateTimeMs(checkOut);
    if (Number.isNaN(checkOutMs) || Number.isNaN(checkInMs) || checkOutMs < checkInMs) {
      return res.status(400).json({ error: 'Giờ ra phải sau giờ vào ca.' });
    }
    if (checkOutMs > Date.now()) {
      return res.status(400).json({ error: 'Giờ ra không được sau thời điểm hiện tại.' });
    }
    const shiftHours = (checkOutMs - checkInMs) / (1000 * 60 * 60);
    if (shiftHours > 16) {
      return res.status(400).json({ error: 'Ca làm việc không được vượt quá 16 giờ.' });
    }

    const normalizedCheckIn = formatDateTimeUTC(new Date(checkInMs));
    const { regular, overtime } = calculateHours(normalizedCheckIn, checkOut);

    const shortagePaidValue = cash_shortage_paid_amount !== undefined && cash_shortage_paid_amount !== null && cash_shortage_paid_amount !== ''
      ? parseFloat(cash_shortage_paid_amount)
      : 0;

    if (Number.isNaN(shortagePaidValue) || shortagePaidValue < 0) {
      return res.status(400).json({ error: 'Số tiền nhân viên bù phải là số hợp lệ' });
    }

    const withdrawnValue = (checkoutWithdrawn !== undefined && checkoutWithdrawn !== null && checkoutWithdrawn !== '')
      ? (parseFloat(checkoutWithdrawn) || null)
      : null;

    const { updated } = await transaction(async (db) => {
      const paymentSummary = await getShiftPaymentSummaryDeduped(
        db,
        timesheet,
        userId,
        normalizedCheckIn,
        checkOut
      );
      const drawerSummary = await recordClosingCountTx(db, timesheet, {
        actual_cash_amount: actualCashValue,
        cash_shortage_paid_amount: shortagePaidValue,
        note,
      }, req.user);

      const updateResult = await db.execute(`
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
        paymentSummary.revenue_amount, 
        paymentSummary.revenue_amount, 
        withdrawnValue, 
        note || null, 
        timesheet.id
      ]);

      if (updateResult.affectedRows === 0) {
        const updateError = new Error('Không thể cập nhật ca làm việc');
        updateError.statusCode = 400;
        throw updateError;
      }

      const updatedTimesheet = await db.queryOne(`
        SELECT t.*, 
          u.name as user_name,
          COALESCE(e.name, u.name) as employee_name,
          s.name as store_name
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        LEFT JOIN stores s ON t.store_id = s.id
        WHERE t.id = ?
      `, [timesheet.id]);

      return { updated: updatedTimesheet, cashDrawerSummary: drawerSummary };
    });

    res.json({ data: serializeTimesheet(updated) });
  } catch (error) {
    console.error('Check out error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get summary (Admin only)
router.get('/summary', authorize('admin'), async (req, res) => {
  try {
    const { user_id, month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year are required' });
    }

    const range = getMonthUtcRange(req, month, year);

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
      WHERE t.check_in >= ? AND t.check_in < ?
        AND t.check_out IS NOT NULL
    `;
    const params = [range.startAt, range.endAt];

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
    summary.forEach(s => {
      s.total_regular_hours = Number(s.total_regular_hours) || 0;
      s.total_overtime_hours = Number(s.total_overtime_hours) || 0;
      s.total_hours = Number(s.total_hours) || 0;
      s.total_revenue = Number(s.total_revenue) || 0;
    });
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

    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const range = getMonthUtcRange(req, month, year);

    // Admin can see all stores if no store_id, or filter by store_id if provided
    let querySql = `
      SELECT 
        t.id,
        t.user_id,
        u.name as user_name,
        ${timesheetDateExpr} as shift_date,
        TIME(t.check_in) as check_in_time,
        TIME(t.check_out) as check_out_time,
        t.regular_hours,
        t.overtime_hours,
        t.revenue_amount,
        t.note
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      WHERE t.check_in >= ? AND t.check_in < ?
        AND t.check_out IS NOT NULL
        AND t.revenue_amount > 0
    `;
    const params = [range.startAt, range.endAt];

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

router.get('/payroll', authorize('admin'), async (req, res) => {
  try {
    const { period, week, month, year, user_id } = req.query;

    if (!period || !['week', 'month'].includes(period)) {
      return res.status(400).json({ error: 'Period must be "week" or "month"' });
    }

    let startDate, endDate, range;
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
      const startAt = req.query.start_at ? isoToMysqlUtc(req.query.start_at) : null;
      const endAt = req.query.end_at ? isoToMysqlUtc(req.query.end_at) : null;
      range = startAt && endAt ? { startAt, endAt } : null;
    } else {
      if (!month || !year) {
        return res.status(400).json({ error: 'Month and year are required for monthly payroll' });
      }
      startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
      range = getMonthUtcRange(req, month, year);
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
      WHERE t.check_in >= ? AND t.check_in < ?
        AND t.check_out IS NOT NULL
    `;
    const params = [range?.startAt || startDate, range?.endAt || endDate];
    
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
        // Number(): these are SUMs of DECIMAL columns (strings from mysql2);
        // leaving them as strings makes the reduce() totals below concatenate
        total_shifts: Number(ts.total_shifts) || 0,
        total_regular_hours: Number(ts.total_regular_hours) || 0,
        total_overtime_hours: Number(ts.total_overtime_hours) || 0,
        total_hours: Number(ts.total_hours) || 0,
        total_revenue: Number(ts.total_revenue) || 0,
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
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const range = getMonthUtcRange(req, month, year);
    const lastDay = new Date(year, month, 0).getDate();

    // Get all timesheets for the month
    let querySql = `
      SELECT 
        COALESCE(t.employee_id, t.user_id) as employee_id,
        COALESCE(e.name, u.name) as employee_name,
        ${timesheetDateExpr} as work_date,
        t.regular_hours,
        t.overtime_hours,
        (t.regular_hours + t.overtime_hours) as total_hours
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE t.check_in >= ? AND t.check_in < ?
        AND t.check_out IS NOT NULL
    `;
    const params = [range.startAt, range.endAt];
    
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
      
      // Sum hours if multiple shifts in the same day.
      // Number(): total_hours comes from SUM of DECIMAL columns, which mysql2
      // returns as a STRING — without coercion this concatenates ("8.5"+"7"→"08.57")
      // and later crashes the UI's .toFixed() call.
      employeeMap[empId].daily_hours[dateKey] += Number(ts.total_hours) || 0;
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
        total_month_hours: Object.values(dailyHours).reduce((sum, hours) => sum + Number(hours), 0),
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
    const { user_id, date, month, year, start_date, end_date, start_at, end_at, store_id } = req.query;
    const timezoneOffsetMinutes = Number.parseInt(req.query.timezone_offset_minutes ?? '0', 10);
    const exportOffset = Number.isNaN(timezoneOffsetMinutes) ? 0 : timezoneOffsetMinutes;
    
    let sqlQuery = `
      SELECT 
        t.id,
        u.name as user_name,
        COALESCE(e.name, u.name) as employee_name,
        t.check_in,
        t.check_out,
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

    if (start_at && end_at) {
      const startAt = isoToMysqlUtc(start_at);
      const endAt = isoToMysqlUtc(end_at);
      if (!startAt || !endAt) {
        return res.status(400).json({ error: 'Invalid date range' });
      }
      sqlQuery += ' AND t.check_in >= ? AND t.check_in < ?';
      params.push(startAt, endAt);
    } else if (date) {
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
      'Ngày': formatWithTimezoneOffset(t.check_in, exportOffset, 'date'),
      'Giờ vào': formatWithTimezoneOffset(t.check_in, exportOffset, 'time'),
      'Giờ ra': t.check_out ? formatWithTimezoneOffset(t.check_out, exportOffset, 'time') : '',
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
      { wch: 8 },
      { wch: 20 },
      { wch: 12 },
      { wch: 10 },
      { wch: 10 },
      { wch: 12 },
      { wch: 12 },
      { wch: 15 },
      { wch: 18 },
      { wch: 30 },
      { wch: 20 }
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
