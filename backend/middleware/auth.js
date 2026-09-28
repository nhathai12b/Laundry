import jwt from 'jsonwebtoken';
import { queryOne } from '../database/db.js';

export const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Token cá nhân của nhân viên sống 7 ngày — nếu chỉ tin JWT, nhân viên bị
  // cho nghỉ (status inactive) vẫn tạo đơn/thu tiền cả tuần bằng token cũ.
  // Re-check status mỗi request (1 lookup theo PK, rẻ; chỉ áp cho token nhân viên)
  if (decoded.employee_login && decoded.employee_id) {
    let emp;
    try {
      emp = await queryOne('SELECT status FROM employees WHERE id = ?', [decoded.employee_id]);
    } catch (error) {
      // Lỗi DB tạm thời (pool cạn, timeout) KHÔNG phải token sai — trả 503 để
      // client thử lại. Nếu gộp vào 401 như trước, api.js FE coi là hết hạn
      // → xoá token, đá toàn bộ nhân viên ra màn đăng nhập giữa lúc bán hàng.
      console.error('authenticate: employee status lookup failed:', error.message);
      return res.status(503).json({ error: 'Không kiểm tra được trạng thái tài khoản. Vui lòng thử lại.' });
    }
    if (!emp || emp.status !== 'active') {
      return res.status(401).json({ error: 'Tài khoản nhân viên đã bị vô hiệu hóa. Vui lòng liên hệ quản lý.' });
    }
  }

  req.user = decoded;
  next();
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

