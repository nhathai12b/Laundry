import jwt from 'jsonwebtoken';

export const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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

