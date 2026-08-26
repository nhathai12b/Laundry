import jwt from 'jsonwebtoken';
import { queryOne } from '../database/db.js';

export const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Token cá nhân của nhân viên sống 7 ngày — nếu chỉ tin JWT, nhân viên bị
    // cho nghỉ (status inactive) vẫn tạo đơn/thu tiền cả tuần bằng token cũ.
    // Re-check status mỗi request (1 lookup theo PK, rẻ; chỉ áp cho token nhân viên)
    if (decoded.employee_login && decoded.employee_id) {
      const emp = await queryOne('SELECT status FROM employees WHERE id = ?', [decoded.employee_id]);
      if (!emp || emp.status !== 'active') {
        return res.status(401).json({ error: 'Tài khoản nhân viên đã bị vô hiệu hóa. Vui lòng liên hệ quản lý.' });
      }
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Token đăng nhập cá nhân của nhân viên (employee_login=true) vẫn mang role
// 'employer' của tài khoản cửa hàng — middleware này chặn các endpoint quản
// trị (quản lý nhân viên, cài đặt...) khỏi loại token đó. Nguồn duy nhất của
// quy tắc; đừng inline lại check này ở từng route.
export const blockEmployeeLogin = (req, res, next) => {
  if (req.user?.employee_login) {
    return res.status(403).json({
      error: 'Tài khoản nhân viên không có quyền thực hiện thao tác này. Vui lòng liên hệ quản lý.',
    });
  }
  next();
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Root has all admin permissions
    const userRole = req.user.role;
    const allowedRoles = roles.includes('admin') ? [...roles, 'root'] : roles;

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  };
};

