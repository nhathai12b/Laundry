import express from 'express';
import { query, queryOne, execute } from '../database/db.js';
import { authenticate, authorize, blockEmployeeLogin } from '../middleware/auth.js';
import { validateRequiredString, sanitizeString } from '../utils/validators.js';
import { hashPassword, validatePasswordStrength } from '../utils/helpers.js';

const router = express.Router();

// Chuẩn hóa giá trị lương (hourly_rate): null nếu bỏ trống
const parseRate = (value, fieldName) => {
  if (value === undefined) return { skip: true };
  if (value === null || value === '') return { value: null };
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num) || num < 0) {
    return { error: `${fieldName} phải là số không âm` };
  }
  return { value: Math.round(num * 100) / 100 };
};

// Mật khẩu đăng nhập riêng: SĐT là định danh nên phải có và không trùng với
// tài khoản users hay nhân viên khác đã có mật khẩu
const validateEmployeeLoginPhone = async (phone, excludeEmployeeId = null) => {
  if (!phone) {
    return 'Nhân viên cần có SĐT để đăng nhập riêng. Vui lòng nhập SĐT.';
  }
  const userWithPhone = await queryOne('SELECT id FROM users WHERE phone = ?', [phone]);
  if (userWithPhone) {
    return 'SĐT này trùng với một tài khoản hệ thống. Vui lòng dùng SĐT khác.';
  }
  const params = [phone];
  let sql = 'SELECT id FROM employees WHERE phone = ? AND password_hash IS NOT NULL';
  if (excludeEmployeeId) {
    sql += ' AND id != ?';
    params.push(excludeEmployeeId);
  }
  const employeeWithPhone = await queryOne(sql, params);
  if (employeeWithPhone) {
    return 'SĐT này đã được nhân viên khác dùng để đăng nhập. Vui lòng dùng SĐT khác.';
  }
  return null;
};

// All routes require authentication
router.use(authenticate);

// Get employees for current store (employer) or selected store (admin)
// blockEmployeeLogin: response chứa hourly_rate của mọi đồng nghiệp — token
// nhân viên cá nhân không được đọc (UI nhân viên dùng /timesheets/store-employees
// chỉ có tên + SĐT)
router.get('/', blockEmployeeLogin, async (req, res) => {
  try {
    let employees;
    
    // Không SELECT * — tránh trả password_hash về client
    const employeeColumns = 'e.id, e.store_id, e.name, e.phone, e.hourly_rate, e.status, e.created_at, e.updated_at, (e.password_hash IS NOT NULL) AS has_login';
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      // Admin can ONLY see employees from stores in their chain
      // employees.store_id references users.id, and users.store_id must be in stores with admin_id = user.id
      employees = await query(`
        SELECT ${employeeColumns}, u.name as store_name, u.name as account_name, u.phone as account_phone
        FROM employees e
        JOIN users u ON e.store_id = u.id
        JOIN stores s ON u.store_id = s.id
        WHERE s.admin_id = ?
        ORDER BY e.name
      `, [req.user.id]);
    } else if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - return empty
      employees = [];
    } else {
      // Employer can only see employees of their account
      // employees.store_id references users.id, so use req.user.id
      employees = await query(`
        SELECT ${employeeColumns} FROM employees e
        WHERE e.store_id = ? AND e.status = ?
        ORDER BY e.name
      `, [req.user.id, 'active']);
    }

    res.json({ data: employees });
  } catch (error) {
    console.error('Get employees error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create employee (Admin or Store owner)
router.post('/', blockEmployeeLogin, async (req, res) => {
  try {
    const { name, phone, user_id, password, hourly_rate } = req.body;
    
    // Determine store_id (which is actually user_id in employees table)
    let storeId;
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      // Admin can specify which user/account the employee belongs to, but only from their stores
      if (!user_id) {
        return res.status(400).json({ error: 'User ID (account) is required. Please select an account.' });
      }
      
      // Verify user exists, is an employer, and belongs to admin's store chain
      const targetUser = await queryOne(`
        SELECT u.id, u.role, u.status, s.admin_id
        FROM users u
        LEFT JOIN stores s ON u.store_id = s.id
        WHERE u.id = ?
      `, [user_id]);
      
      if (!targetUser) {
        return res.status(400).json({ error: 'Selected account does not exist' });
      }
      if (targetUser.role !== 'employer') {
        return res.status(400).json({ error: 'Selected account must be an employer account' });
      }
      if (targetUser.status !== 'active') {
        return res.status(400).json({ error: 'Selected account is not active' });
      }
      // Verify the user's store belongs to this admin
      if (!targetUser.admin_id || targetUser.admin_id !== req.user.id) {
        return res.status(403).json({ error: 'Bạn chỉ có thể thêm nhân viên cho tài khoản trong chuỗi cửa hàng của mình' });
      }
      
      storeId = parseInt(user_id);
    } else if (req.user.role === 'root') {
      // Root admin is software vendor, not store operator - cannot create employees
      return res.status(403).json({ error: 'Root admin không thể tạo nhân viên' });
    } else {
      // Employer uses their own user.id as store_id (employees.store_id references users.id)
      // Note: req.user.store_id might be from stores table, but employees.store_id must be user.id
      storeId = req.user.id;
      
      // Verify ownership (employer can only add to their own account)
      if (user_id && parseInt(user_id) !== storeId) {
        return res.status(403).json({ error: 'You can only add employees to your own account' });
      }
    }

    // Validate name
    const nameValidation = validateRequiredString(name, 'Tên nhân viên');
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }

    // Validate phone if provided
    let phoneValue = null;
    if (phone !== undefined && phone !== null && phone !== '') {
      const phoneSanitized = sanitizeString(phone);
      phoneValue = phoneSanitized.value || null;
    }

    // Mật khẩu đăng nhập riêng (tùy chọn)
    let passwordHash = null;
    if (password !== undefined && password !== null && password !== '') {
      const passwordValidation = validatePasswordStrength(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.message });
      }
      const phoneError = await validateEmployeeLoginPhone(phoneValue);
      if (phoneError) {
        return res.status(400).json({ error: phoneError });
      }
      passwordHash = await hashPassword(password);
    }

    // Thiết lập lương theo giờ
    const hourly = parseRate(hourly_rate, 'Lương theo giờ');
    if (hourly.error) return res.status(400).json({ error: hourly.error });

    const result = await execute(`
      INSERT INTO employees (store_id, name, phone, password_hash, hourly_rate)
      VALUES (?, ?, ?, ?, ?)
    `, [
      storeId,
      nameValidation.value,
      phoneValue,
      passwordHash,
      hourly.skip ? null : hourly.value,
    ]);

    const employee = await queryOne('SELECT id, store_id, name, phone, hourly_rate, status, created_at, updated_at, (password_hash IS NOT NULL) AS has_login FROM employees WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: employee });
  } catch (error) {
    console.error('Create employee error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Update employee
router.patch('/:id', blockEmployeeLogin, async (req, res) => {
  try {
    const { name, phone, status, user_id, store_id, password, hourly_rate } = req.body;

    const employee = await queryOne('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Verify store ownership
    // For employer: employees.store_id references users.id, so use req.user.id
    // For admin: can only update employees from their store chain
    // Root admin is software vendor, not store operator - cannot update employees
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể sửa nhân viên' });
    }

    if (req.user.role === 'employer' && employee.store_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only update employees of your own account' });
    }
    
    if (req.user.role === 'admin') {
      // Verify employee belongs to a user in admin's store chain
      const employeeUser = await queryOne(`
        SELECT u.id, s.admin_id
        FROM users u
        LEFT JOIN stores s ON u.store_id = s.id
        WHERE u.id = ?
      `, [employee.store_id]);
      
      if (!employeeUser || !employeeUser.admin_id || employeeUser.admin_id !== req.user.id) {
        return res.status(403).json({ error: 'Bạn chỉ có thể sửa nhân viên trong chuỗi cửa hàng của mình' });
      }
    }

    const updates = [];
    const values = [];

    if (name !== undefined) {
      if (name === '' || (typeof name === 'string' && name.trim() === '')) {
        return res.status(400).json({ error: 'Tên nhân viên không được để trống' });
      }
      const nameValidation = validateRequiredString(name, 'Tên nhân viên');
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error });
      }
      updates.push('name = ?');
      values.push(nameValidation.value);
    }
    
    if (phone !== undefined) {
      let phoneValue = null;
      if (phone !== null && phone !== '') {
        const phoneSanitized = sanitizeString(phone);
        phoneValue = phoneSanitized.value || null;
      }
      updates.push('phone = ?');
      values.push(phoneValue);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    const hasNewPassword = password !== undefined && password !== null && password !== '';

    // Nếu SĐT đăng nhập thay đổi (nhân viên ĐANG có tài khoản login) hoặc
    // đang đặt mật khẩu mới → luôn kiểm tra SĐT không trùng users/nhân viên
    // khác. Trước đây chỉ check khi có password → đổi riêng SĐT có thể tạo
    // 2 login trùng số và khóa lẫn nhau.
    const phoneIsChanging = phone !== undefined;
    if (hasNewPassword || (phoneIsChanging && employee.password_hash)) {
      const loginPhone = phoneIsChanging
        ? (phone !== null && phone !== '' ? (sanitizeString(phone).value || null) : null)
        : employee.phone;
      const phoneError = await validateEmployeeLoginPhone(loginPhone, employee.id);
      if (phoneError) {
        return res.status(400).json({ error: phoneError });
      }
    }

    // Đổi/đặt mật khẩu đăng nhập riêng
    if (hasNewPassword) {
      const passwordValidation = validatePasswordStrength(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.message });
      }
      updates.push('password_hash = ?');
      values.push(await hashPassword(password));
    }

    // Thiết lập lương theo giờ
    const hourly = parseRate(hourly_rate, 'Lương theo giờ');
    if (hourly.error) return res.status(400).json({ error: hourly.error });
    if (!hourly.skip) {
      updates.push('hourly_rate = ?');
      values.push(hourly.value);
    }

    // Handle store_id/user_id update (only for admin)
    let newStoreId = user_id || store_id;
    if (newStoreId !== undefined) {
      if (req.user.role === 'employer') {
        // Employer cannot change store_id - it must remain their own user.id
        return res.status(403).json({ error: 'You cannot change the store/account of an employee' });
      }
      
      // Admin can change store_id (which is actually user_id in employees table)
      const targetUserId = parseInt(newStoreId);
      
      // Verify target user exists, is an employer, and belongs to admin's store chain
      const targetUser = await queryOne(`
        SELECT u.id, u.role, u.status, s.admin_id
        FROM users u
        LEFT JOIN stores s ON u.store_id = s.id
        WHERE u.id = ?
      `, [targetUserId]);
      
      if (!targetUser) {
        return res.status(400).json({ error: 'Target account does not exist' });
      }
      if (targetUser.role !== 'employer') {
        return res.status(400).json({ error: 'Target account must be an employer account' });
      }
      if (targetUser.status !== 'active') {
        return res.status(400).json({ error: 'Target account is not active' });
      }
      
      // For admin, verify target user belongs to their store chain
      if (req.user.role === 'admin') {
        if (!targetUser.admin_id || targetUser.admin_id !== req.user.id) {
          return res.status(403).json({ error: 'Bạn chỉ có thể chuyển nhân viên đến tài khoản trong chuỗi cửa hàng của mình' });
        }
      }
      
      updates.push('store_id = ?');
      values.push(targetUserId);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // MySQL handles updated_at automatically
    values.push(req.params.id);

    await execute(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`, values);

    const updated = await queryOne('SELECT id, store_id, name, phone, hourly_rate, status, created_at, updated_at, (password_hash IS NOT NULL) AS has_login FROM employees WHERE id = ?', [req.params.id]);
    res.json({ data: updated });
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Delete employee
router.delete('/:id', blockEmployeeLogin, async (req, res) => {
  try {
    // Root admin is software vendor, not store operator - cannot delete employees
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xóa nhân viên' });
    }

    const employee = await queryOne('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Verify store ownership
    // For employer: employees.store_id references users.id, so use req.user.id
    if (req.user.role === 'employer' && employee.store_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete employees of your own account' });
    }
    // For admin: employee must belong to a store account in the admin's chain
    // (this check existed in PATCH but was missing here — cross-chain delete gap)
    if (req.user.role === 'admin') {
      const employeeUser = await queryOne(`
        SELECT u.id, s.admin_id
        FROM users u
        LEFT JOIN stores s ON u.store_id = s.id
        WHERE u.id = ?
      `, [employee.store_id]);
      if (!employeeUser || !employeeUser.admin_id || employeeUser.admin_id !== req.user.id) {
        return res.status(403).json({ error: 'Bạn chỉ có thể xóa nhân viên trong chuỗi cửa hàng của mình' });
      }
    }

    // Không xóa nhân viên đang đứng ca — ca mở giữ két tiền, xóa sẽ kéo
    // theo CASCADE toàn bộ cash_drawer_transactions của ca đó
    const openShift = await queryOne(
      'SELECT id FROM timesheets WHERE employee_id = ? AND check_out IS NULL LIMIT 1',
      [req.params.id]
    );
    if (openShift) {
      return res.status(400).json({
        error: 'Nhân viên đang có ca mở. Vui lòng check-out ca trước khi xóa.',
      });
    }

    // Có lịch sử (chấm công / thưởng phạt / đơn hàng) thì KHÔNG hard-delete:
    // - xóa timesheets sẽ CASCADE mất cash_drawer_transactions (sổ quỹ két)
    // - employees bị xóa sẽ CASCADE mất salary_adjustments (lịch sử thưởng/phạt)
    // - payroll các tháng trước thay đổi ngược
    // → theo quy ước của products/stores/promotions: chuyển inactive + khóa login
    const hasHistory = async (sql, params) => {
      try {
        return Boolean(await queryOne(sql, params));
      } catch (error) {
        // CHỈ nuốt lỗi thiếu bảng/cột (chưa migrate = chắc chắn không có dữ liệu).
        // Lỗi khác (mất kết nối, timeout) phải ném ra — nuốt hết sẽ hard-delete
        // nhầm nhân viên CÓ dữ liệu và CASCADE xóa sổ quỹ + lịch sử thưởng phạt
        if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_FIELD_ERROR') {
          return false;
        }
        throw error;
      }
    };
    const [hasTimesheets, hasAdjustments, hasOrders] = await Promise.all([
      hasHistory('SELECT 1 FROM timesheets WHERE employee_id = ? LIMIT 1', [req.params.id]),
      hasHistory('SELECT 1 FROM salary_adjustments WHERE employee_id = ? LIMIT 1', [req.params.id]),
      hasHistory('SELECT 1 FROM orders WHERE employee_id = ? LIMIT 1', [req.params.id]),
    ]);

    if (hasTimesheets || hasAdjustments || hasOrders) {
      await execute(
        "UPDATE employees SET status = 'inactive', password_hash = NULL WHERE id = ?",
        [req.params.id]
      );
      return res.json({
        message: 'Nhân viên đã có dữ liệu chấm công/thưởng phạt/đơn hàng nên được chuyển sang Ngừng hoạt động (giữ nguyên lịch sử lương và sổ quỹ). Tài khoản đăng nhập riêng đã bị vô hiệu.',
        action: 'deactivated',
      });
    }

    // Chưa có bất kỳ lịch sử nào → xóa hẳn được, an toàn
    await execute('DELETE FROM employees WHERE id = ?', [req.params.id]);
    res.json({ message: 'Employee deleted successfully', action: 'deleted' });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

export default router;
