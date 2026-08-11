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

