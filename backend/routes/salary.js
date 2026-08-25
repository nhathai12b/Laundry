import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { formatDateTimeUTC } from '../utils/helpers.js';
import { OVERTIME_MULTIPLIER } from '../utils/constants.js';

const router = express.Router();

router.use(authenticate);

const getTimezoneOffsetMinutes = (req) => {
  const offset = Number.parseInt(req.query.timezone_offset_minutes ?? '0', 10);
  if (Number.isNaN(offset) || offset < -840 || offset > 840) return 0;
  return offset;
};

const getMonthUtcRange = (req, month, year) => {
  const offset = getTimezoneOffsetMinutes(req);
  // offset = getTimezoneOffset() = UTC − local (VN: -420).
  // Mốc local 00:00 ngày 1 → UTC = local + offset  (VD: 1/8 00:00 VN = 31/7 17:00Z)
  const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1) + offset * 60 * 1000);
  const end = new Date(Date.UTC(Number(year), Number(month), 1) + offset * 60 * 1000);
  return { startAt: formatDateTimeUTC(start), endAt: formatDateTimeUTC(end) };
};

// Lương công tính theo GIỜ: giờ thường × lương giờ + tăng ca × hệ số
// (cùng công thức với payroll admin)
const computeWorkSalary = (totals, hourlyRate) => {
  let salary = 0;
  if (hourlyRate) {
    salary = (totals.total_regular_hours || 0) * hourlyRate
      + (totals.total_overtime_hours || 0) * hourlyRate * OVERTIME_MULTIPLIER;
  }
  return Math.round(salary * 100) / 100;
};

// Kiểm tra nhân viên thuộc phạm vi của người gọi
// - employer: employees.store_id = req.user.id
// - admin: nhân viên thuộc chuỗi cửa hàng của admin
const getEmployeeForActor = async (employeeId, actor) => {
  if (actor.role === 'employer') {
    return queryOne(
      'SELECT * FROM employees WHERE id = ? AND store_id = ?',
      [employeeId, actor.id]
    );
  }
  if (actor.role === 'admin') {
    return queryOne(`
      SELECT e.*
      FROM employees e
      JOIN users u ON e.store_id = u.id
      JOIN stores s ON u.store_id = s.id
      WHERE e.id = ? AND s.admin_id = ?
    `, [employeeId, actor.id]);
  }
  return null;
};

const buildSalarySummary = async (req, employee, month, year) => {
  const range = getMonthUtcRange(req, month, year);

  // So sánh theo khoảng ngày (sargable) để dùng index (employee_id, adjust_date)
  // thay vì MONTH()/YEAR() phải quét toàn bộ lịch sử của nhân viên
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = Number(month) === 12 ? `${Number(year) + 1}-01-01` : `${year}-${String(Number(month) + 1).padStart(2, '0')}-01`;

  // 3 query độc lập — chạy song song thay vì 3 round-trip nối tiếp
  const [totalsRow, adjustments, commissionRow] = await Promise.all([
    queryOne(`
      SELECT
        COUNT(*) AS total_shifts,
        COALESCE(SUM(regular_hours), 0) AS total_regular_hours,
        COALESCE(SUM(overtime_hours), 0) AS total_overtime_hours
      FROM timesheets
      WHERE employee_id = ? AND check_out IS NOT NULL
        AND check_in >= ? AND check_in < ?
    `, [employee.id, range.startAt, range.endAt]),
    query(`
      SELECT a.id, a.amount, a.reason, a.adjust_date, a.created_at, u.name AS created_by_name
      FROM salary_adjustments a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.employee_id = ? AND a.adjust_date >= ? AND a.adjust_date < ?
      ORDER BY a.adjust_date DESC, a.id DESC
    `, [employee.id, monthStart, nextMonth]).catch(() => []),
    // Hoa hồng sản phẩm: % (admin đặt trên từng sản phẩm) × giá trị dòng hàng,
    // tính trên các đơn ĐÃ HOÀN THÀNH mà nhân viên này tạo/xử lý trong tháng.
    // .catch: cột commission_percent/employee_id chưa migrate — coi như 0
    queryOne(`
      SELECT COALESCE(SUM(oi.quantity * oi.unit_price * (p.commission_percent / 100)), 0) AS commission
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE o.employee_id = ?
        AND o.status = 'completed'
        AND o.created_at >= ? AND o.created_at < ?
        AND p.commission_percent > 0
    `, [employee.id, range.startAt, range.endAt]).catch(() => null),
  ]);

  const totals = {
    total_shifts: Number(totalsRow?.total_shifts) || 0,
    total_regular_hours: Number(totalsRow?.total_regular_hours) || 0,
    total_overtime_hours: Number(totalsRow?.total_overtime_hours) || 0,
  };

  const hourlyRate = Number.parseFloat(employee.hourly_rate) || 0;
  const workSalary = computeWorkSalary(totals, hourlyRate);
  const totalCommission = Math.round((Number.parseFloat(commissionRow?.commission) || 0) * 100) / 100;

  const totalAdjustments = adjustments.reduce(
    (sum, a) => sum + (Number.parseFloat(a.amount) || 0), 0
  );

  return {
    employee: { id: employee.id, name: employee.name },
    month: Number(month),
    year: Number(year),
    total_shifts: totals.total_shifts,
    total_regular_hours: totals.total_regular_hours,
    total_overtime_hours: totals.total_overtime_hours,
    total_hours: totals.total_regular_hours + totals.total_overtime_hours,
    hourly_rate: hourlyRate,
    work_salary: workSalary,
    total_commission: totalCommission,
    adjustments: adjustments.map((a) => ({ ...a, amount: Number.parseFloat(a.amount) || 0 })),
    total_adjustments: Math.round(totalAdjustments * 100) / 100,
    total_salary: Math.round((workSalary + totalCommission + totalAdjustments) * 100) / 100,
  };
};

// Nhân viên xem lương tháng của chính mình (token đăng nhập riêng có employee_id)
router.get('/my-summary', async (req, res) => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      return res.status(400).json({ error: 'Tài khoản này không gắn với nhân viên cụ thể.' });
    }

    const now = new Date();
    const month = Number.parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = Number.parseInt(req.query.year, 10) || now.getFullYear();

    const employee = await queryOne(
      'SELECT * FROM employees WHERE id = ? AND store_id = ?',
      [employeeId, req.user.id]
    );
    if (!employee) {
      return res.status(404).json({ error: 'Không tìm thấy nhân viên.' });
    }

    const summary = await buildSalarySummary(req, employee, month, year);
    res.json({ data: summary });
  } catch (error) {
    console.error('Get my salary summary error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Admin xem lương tháng của một nhân viên
router.get('/summary/:employeeId', authorize('admin'), async (req, res) => {
  try {
    const now = new Date();
    const month = Number.parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = Number.parseInt(req.query.year, 10) || now.getFullYear();

    const employee = await getEmployeeForActor(req.params.employeeId, req.user);
    if (!employee) {
      return res.status(404).json({ error: 'Không tìm thấy nhân viên trong chuỗi cửa hàng của bạn.' });
    }

    const summary = await buildSalarySummary(req, employee, month, year);
    res.json({ data: summary });
  } catch (error) {
    console.error('Get salary summary error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Admin: lưới thưởng/phạt theo ngày trong tháng — hàng = ngày, cột = nhân viên
// (giống bảng chấm công theo tháng). Seed tất cả nhân viên active của chuỗi.
router.get('/adjustments-grid', authorize('admin'), async (req, res) => {
  try {
    const now = new Date();
    const month = Number.parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = Number.parseInt(req.query.year, 10) || now.getFullYear();
    const monthStr = String(month).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    const storeIdParam = req.query.store_id;

    // Danh sách nhân viên active trong chuỗi (cột của bảng)
    let empSql = `
      SELECT e.id, e.name
      FROM employees e
      JOIN users u ON e.store_id = u.id
      JOIN stores s ON u.store_id = s.id
      WHERE e.status = 'active' AND s.admin_id = ?
    `;
    const empParams = [req.user.id];
    if (storeIdParam && storeIdParam !== 'all') {
      empSql += ' AND s.id = ?';
      empParams.push(storeIdParam);
    }
    empSql += ' ORDER BY e.name';
    const employees = await query(empSql, empParams);

    // Các khoản thưởng/phạt trong tháng (adjust_date là DATE)
    const monthStart = `${year}-${monthStr}-01`;
    const nextMonth = Number(month) === 12
      ? `${Number(year) + 1}-01-01`
      : `${year}-${String(Number(month) + 1).padStart(2, '0')}-01`;
    let adjRows = [];
    try {
      adjRows = await query(`
        SELECT a.employee_id, a.adjust_date, SUM(a.amount) AS amount
        FROM salary_adjustments a
        JOIN employees e ON a.employee_id = e.id
        JOIN users u ON e.store_id = u.id
        JOIN stores s ON u.store_id = s.id
        WHERE s.admin_id = ? AND a.adjust_date >= ? AND a.adjust_date < ?
        GROUP BY a.employee_id, a.adjust_date
      `, [req.user.id, monthStart, nextMonth]);
    } catch (error) {
      // Bảng chưa migrate — coi như không có khoản nào
    }

    // Build map: employee_id -> { dateKey -> amount }
    const byEmployee = new Map(employees.map((e) => [e.id, {}]));
    for (const r of adjRows) {
      const key = String(r.adjust_date).slice(0, 10);
      const map = byEmployee.get(r.employee_id);
      if (map) map[key] = Number.parseFloat(r.amount) || 0;
    }

    const data = employees.map((e) => {
      const daily = byEmployee.get(e.id) || {};
      const total = Object.values(daily).reduce((s, v) => s + v, 0);
      return {
        employee_id: e.id,
        employee_name: e.name,
        daily_amounts: daily,
        total: Math.round(total * 100) / 100,
      };
    });

    res.json({ data, month, year, days_in_month: lastDay });
  } catch (error) {
    console.error('Get adjustments grid error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Admin cộng/trừ tiền cho nhân viên theo ngày (amount dương = cộng, âm = trừ)
router.post('/adjustments', authorize('admin'), async (req, res) => {
  try {
    const { employee_id, amount, reason, adjust_date } = req.body;

    if (!employee_id) {
      return res.status(400).json({ error: 'Thiếu nhân viên.' });
    }
    const amountValue = Number.parseFloat(amount);
    if (!Number.isFinite(amountValue) || amountValue === 0) {
      return res.status(400).json({ error: 'Số tiền phải là số khác 0 (dương = cộng, âm = trừ).' });
    }
    const dateValue = String(adjust_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return res.status(400).json({ error: 'Ngày không hợp lệ (YYYY-MM-DD).' });
    }

    const employee = await getEmployeeForActor(employee_id, req.user);
    if (!employee) {
      return res.status(404).json({ error: 'Không tìm thấy nhân viên trong chuỗi cửa hàng của bạn.' });
    }

    const result = await execute(`
      INSERT INTO salary_adjustments (employee_id, store_id, amount, reason, adjust_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      employee.id,
      employee.store_id,
      Math.round(amountValue * 100) / 100,
      String(reason || '').trim() || null,
      dateValue,
      req.user.id,
    ]);

    const created = await queryOne('SELECT * FROM salary_adjustments WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: created });
  } catch (error) {
    console.error('Create salary adjustment error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Admin xóa một khoản cộng/trừ
router.delete('/adjustments/:id', authorize('admin'), async (req, res) => {
  try {
    const adjustment = await queryOne('SELECT * FROM salary_adjustments WHERE id = ?', [req.params.id]);
    if (!adjustment) {
      return res.status(404).json({ error: 'Không tìm thấy khoản điều chỉnh.' });
    }
    const employee = await getEmployeeForActor(adjustment.employee_id, req.user);
    if (!employee) {
      return res.status(403).json({ error: 'Khoản điều chỉnh không thuộc chuỗi cửa hàng của bạn.' });
    }
    await execute('DELETE FROM salary_adjustments WHERE id = ?', [req.params.id]);
    res.json({ message: 'Đã xóa khoản điều chỉnh.' });
  } catch (error) {
    console.error('Delete salary adjustment error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

export default router;
