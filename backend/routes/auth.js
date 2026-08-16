import express from 'express';
import jwt from 'jsonwebtoken';
import { query, queryOne, execute } from '../database/db.js';
import { comparePassword, hashPassword } from '../utils/helpers.js';
import { authenticate } from '../middleware/auth.js';
import { loginRateLimiter, registerRateLimiter, resetLoginRateLimit } from '../middleware/rateLimiter.js';
import { MAX_LOGIN_ATTEMPTS, ACCOUNT_LOCKOUT_MINUTES, TIMING_ATTACK_DELAY_MS } from '../utils/constants.js';

const router = express.Router();

// Generic message for both "user not found" and "wrong password" so responses
// can't be used to probe which phone numbers have accounts.
const INVALID_CREDENTIALS_MESSAGE = 'Số điện thoại hoặc mật khẩu không đúng.';

// Valid bcrypt hash of a random throwaway string. Compared against when the user
// doesn't exist so both branches cost one bcrypt verification (timing equalization).
const DUMMY_PASSWORD_HASH = '$2a$10$ATOLApL9NU7650NWv2ohzOEDbpz7POcHmWK/9tzVK6FZIHxjnWFQq';

// Helper function to log login attempt
const logLoginAttempt = async (phone, ip, success, failureReason = null, userAgent = null) => {
  try {
    await execute(`
      INSERT INTO login_attempts (phone, ip_address, success, failure_reason, user_agent)
      VALUES (?, ?, ?, ?, ?)
    `, [phone, ip, success, failureReason, userAgent]);
  } catch (error) {
    // Ignore errors if table doesn't exist yet
    console.error('Failed to log login attempt:', error.message);
  }
};

// Helper function to check if account is locked
const isAccountLocked = (user) => {
  if (!user.locked_until) return false;
  const now = new Date();
  const lockedUntil = new Date(user.locked_until);
  return now < lockedUntil;
};

// Helper function to increment failed login attempts
const incrementFailedAttempts = async (userId, maxAttempts = MAX_LOGIN_ATTEMPTS, lockoutMinutes = ACCOUNT_LOCKOUT_MINUTES) => {
  try {
    // Check if security columns exist
    let user;
    try {
      user = await queryOne('SELECT failed_login_attempts FROM users WHERE id = ?', [userId]);
    } catch (error) {
      if (error.code === 'ER_BAD_FIELD_ERROR') {
        // Security columns don't exist yet, skip lockout
        console.warn('Security columns not found, skipping account lockout');
        return { currentAttempts: 0, isLocked: false };
      }
      throw error;
    }
    
    // Atomic increment (read-then-write would race under concurrent attempts),
    // locking in the same statement once the threshold is reached
    await execute(`
      UPDATE users
      SET failed_login_attempts = failed_login_attempts + 1,
          last_failed_login = NOW(),
          locked_until = IF(failed_login_attempts >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), locked_until)
      WHERE id = ?
    `, [maxAttempts, lockoutMinutes, userId]);

    const updated = await queryOne('SELECT failed_login_attempts, locked_until FROM users WHERE id = ?', [userId]);
    const currentAttempts = updated?.failed_login_attempts ?? (user?.failed_login_attempts || 0) + 1;
    const lockedUntil = updated?.locked_until ? new Date(updated.locked_until) : null;
    const isLocked = lockedUntil !== null && lockedUntil > new Date();

    return { currentAttempts, isLocked, lockedUntil: isLocked ? lockedUntil : null };
  } catch (error) {
    // If columns don't exist, gracefully degrade
    if (error.code === 'ER_BAD_FIELD_ERROR') {
      console.warn('Security columns not found, skipping account lockout');
      return { currentAttempts: 0, isLocked: false };
    }
    console.error('Error incrementing failed attempts:', error);
    return { currentAttempts: 0, isLocked: false };
  }
};

// Helper function to reset failed login attempts on successful login
const resetFailedAttempts = async (userId) => {
  try {
    // Check if security columns exist before UPDATE (avoid ER_BAD_FIELD_ERROR in DB)
    await queryOne('SELECT failed_login_attempts FROM users WHERE id = ?', [userId]);
    await execute(`
      UPDATE users 
      SET failed_login_attempts = 0,
          last_failed_login = NULL,
          locked_until = NULL
      WHERE id = ?
    `, [userId]);
  } catch (error) {
    if (error.code === 'ER_BAD_FIELD_ERROR') {
      return; // Columns don't exist, skip silently
    }
    console.error('Error resetting failed attempts:', error);
  }
};

// Login with rate limiting and brute force protection
router.post('/login', loginRateLimiter(), async (req, res) => {
  try {
    const { phone, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    if (!phone || !password) {
      await logLoginAttempt(phone || 'unknown', ip, false, 'Missing phone or password', userAgent);
      return res.status(400).json({ error: 'Phone and password are required' });
    }

    // Get user (use SELECT * so missing security columns don't break login)
    const user = await queryOne('SELECT * FROM users WHERE phone = ?', [phone]);
    if (user) {
      user.locked_until = user.locked_until ?? null;
      user.failed_login_attempts = user.failed_login_attempts ?? 0;
      user.last_failed_login = user.last_failed_login ?? null;
    }

    if (!user) {
      // Don't reveal if user exists or not: burn one bcrypt verification so this
      // branch costs the same as a real password check, plus the standard delay
      await comparePassword(password, DUMMY_PASSWORD_HASH);
      await logLoginAttempt(phone, ip, false, 'Invalid credentials', userAgent);
      await new Promise(resolve => setTimeout(resolve, TIMING_ATTACK_DELAY_MS));
      return res.status(401).json({ error: INVALID_CREDENTIALS_MESSAGE });
    }

    // Check if account is locked (must come before password check so a locked
    // account can't keep being brute-forced)
    if (isAccountLocked(user)) {
      const lockedUntil = new Date(user.locked_until);
      const minutesRemaining = Math.ceil((lockedUntil - new Date()) / 1000 / 60);
      await logLoginAttempt(phone, ip, false, `Account locked until ${lockedUntil.toISOString()}`, userAgent);
      return res.status(423).json({
        error: `Tài khoản đã bị khóa do quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ${minutesRemaining} phút.`,
        lockedUntil: lockedUntil.toISOString(),
        minutesRemaining
      });
    }

    // Verify password BEFORE any account-status responses: without this order,
    // anyone can probe account state (pending/disabled/expired) with no password
    const isValid = await comparePassword(password, user.password_hash);

    if (!isValid) {
      const { isLocked, lockedUntil } = await incrementFailedAttempts(user.id);

      await logLoginAttempt(phone, ip, false, 'Invalid password', userAgent);

      if (isLocked && lockedUntil) {
        const minutesRemaining = Math.ceil((new Date(lockedUntil) - new Date()) / 1000 / 60);
        return res.status(423).json({
          error: `Tài khoản đã bị khóa do quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ${minutesRemaining} phút.`,
          lockedUntil: lockedUntil.toISOString(),
          minutesRemaining
        });
      }

      // Same generic message as the user-not-found branch (no attempt-count hint)
      await new Promise(resolve => setTimeout(resolve, TIMING_ATTACK_DELAY_MS));
      return res.status(401).json({ error: INVALID_CREDENTIALS_MESSAGE });
    }

    // Password verified — status/subscription details below are only revealed
    // to someone who actually owns the account

    if (user.status === 'pending') {
      if (user.role === 'admin') {
        return res.status(401).json({
          error: 'Tài khoản admin đang chờ phê duyệt. Vui lòng liên hệ root admin để được phê duyệt và kích hoạt gói đăng ký.'
        });
      }
      return res.status(401).json({ error: 'Tài khoản đang chờ phê duyệt. Vui lòng liên hệ admin.' });
    }

    if (user.status !== 'active') {
      return res.status(401).json({ error: 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ admin.' });
    }

    // Check subscription expiration for admin users (not root)
    // If admin is active but no subscription, allow login (might be approved but subscription not set yet)
    if (user.role === 'admin' && user.subscription_expires_at) {
      const expirationDate = new Date(user.subscription_expires_at);
      if (new Date() > expirationDate) {
        return res.status(401).json({
          error: `Gói đăng ký đã hết hạn vào ${expirationDate.toLocaleDateString('vi-VN')}. Vui lòng liên hệ root admin để gia hạn.`
        });
      }
    }

    // Successful login - reset failed attempts and rate limit
    await resetFailedAttempts(user.id);
    await logLoginAttempt(phone, ip, true, null, userAgent);
    resetLoginRateLimit(req);

    // For employer, return employees list for selection
    if (user.role === 'employer') {
      // employees.store_id references users.id, so always use user.id for employees query
      // But user.store_id from database is stores.id, which we need for promotions filtering
      const storeId = user.id; // Always use user.id for employees query
      // Keep user.store_id from database (stores.id) for promotions and other store-related queries

      // Query employees - employees.store_id references users.id
      // So we query WHERE store_id = user.id
      let employees = await query(`
        SELECT * FROM employees 
        WHERE store_id = ? AND status = ? 
        ORDER BY name
      `, [user.id, 'active']);

      // If no employees found, try without status filter (might be inactive)
      if (employees.length === 0) {
        employees = await query(`
          SELECT * FROM employees 
          WHERE store_id = ? 
          ORDER BY name
        `, [user.id]);
      }


      // If no employees, allow direct login without employee selection
      if (employees.length === 0) {
        const token = jwt.sign(
          { 
            id: user.id, 
            role: user.role, 
            name: user.name, 
            store_id: user.store_id // Use actual stores.id from database
          },
          process.env.JWT_SECRET,
          { expiresIn: process.env.JWT_EXPIRE || '7d' }
        );

        // Log login (ignore errors if audit_logs table doesn't exist)
        try {
          await execute(`
            INSERT INTO audit_logs (user_id, action, entity, entity_id)
            VALUES (?, 'login', 'user', ?)
          `, [user.id, user.id]);
        } catch (error) {
          // Ignore audit log errors
        }

        res.json({
          token,
          user: {
            id: user.id,
            name: user.name,
            phone: user.phone,
            role: user.role,
            status: user.status,
            store_id: user.store_id // Use actual stores.id from database
          }
        });
        return;
      }

      // Allow direct login without employee selection
      // Employee will be selected during check-in
      const token = jwt.sign(
        { 
          id: user.id, 
          role: user.role, 
          name: user.name, 
          store_id: user.store_id // Use actual stores.id from database
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '7d' }
      );

      // Log login (ignore errors if audit_logs table doesn't exist)
      try {
        await execute(`
          INSERT INTO audit_logs (user_id, action, entity, entity_id)
          VALUES (?, 'login', 'user', ?)
        `, [user.id, user.id]);
      } catch (error) {
        // Ignore audit log errors
      }

      res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          role: user.role,
          status: user.status,
          store_id: user.store_id // Use actual stores.id from database
        }
      });
      return;
    }

    // Admin or Root login - no store selection required
    if (user.role === 'admin' || user.role === 'root') {
      // Include store_id in token if available (for filtering purposes)
      const tokenPayload = {
        id: user.id,
        role: user.role,
        name: user.name
      };
      
      // Add store_id to token if user has one (root admin usually doesn't have store_id)
      if (user.store_id) {
        tokenPayload.store_id = user.store_id;
      }
      
      const token = jwt.sign(
        tokenPayload,
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '7d' }
      );

      // Log login (ignore errors)
      try {
        await execute(`
          INSERT INTO audit_logs (user_id, action, entity, entity_id)
          VALUES (?, 'login', 'user', ?)
        `, [user.id, user.id]);
      } catch (logError) {
        // Ignore audit log errors
      }
      
      res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          role: user.role,
          status: user.status,
          subscription_expires_at: user.subscription_expires_at || null,
          subscription_package: user.subscription_package || null
        }
      });
      return;
    }

    // Other roles (should not reach here)
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    // Log login
    await execute(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id)
      VALUES (?, 'login', 'user', ?)
    `, [user.id, user.id]);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        status: user.status
      }
    });
  } catch (error) {
    console.error('[Login] Error occurred');
    // Stack trace removed for security
    res.status(500).json({ 
      error: 'Lỗi máy chủ khi đăng nhập. Vui lòng thử lại.' 
    });
  }
});

// Đăng ký sử dụng dịch vụ (tạo admin thường, status = pending, chờ root phê duyệt)
router.post('/register', registerRateLimiter(), async (req, res) => {
  try {
    const { name, phone, password, subscription_package } = req.body;

    if (!name || !phone || !password || !subscription_package) {
      return res.status(400).json({ error: 'Vui lòng điền đầy đủ: Họ tên, Số điện thoại, Mật khẩu và chọn gói dịch vụ.' });
    }

    const validPackages = ['1month', '3months', '6months', '1year'];
    if (!validPackages.includes(subscription_package)) {
      return res.status(400).json({ error: 'Gói dịch vụ không hợp lệ. Chọn: 1 tháng, 3 tháng, 6 tháng hoặc 12 tháng.' });
    }

    const trimmedPhone = String(phone).trim();
    if (!/^\d{8,15}$/.test(trimmedPhone)) {
      return res.status(400).json({ error: 'Số điện thoại không hợp lệ. Chỉ nhập chữ số (8-15 số).' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 8 ký tự.' });
    }
    const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [trimmedPhone]);
    if (existing) {
      return res.status(400).json({ error: 'Số điện thoại đã được đăng ký. Vui lòng dùng số khác hoặc đăng nhập.' });
    }

    const password_hash = await hashPassword(password);
    await execute(
      `INSERT INTO users (name, phone, password_hash, role, status, subscription_package)
       VALUES (?, ?, ?, 'admin', 'pending', ?)`,
      [name.trim(), trimmedPhone, password_hash, subscription_package]
    );

    res.status(201).json({
      message: 'Đăng ký thành công. Tài khoản đang chờ phê duyệt. Quý khách vui lòng chuyển khoản theo hướng dẫn và gửi ảnh chuyển khoản qua Zalo để được kích hoạt trong 24h.',
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Lỗi đăng ký. Vui lòng thử lại.' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await queryOne('SELECT id, name, phone, role, status, started_at, hourly_rate, shift_rate, subscription_expires_at, subscription_package FROM users WHERE id = ?', [req.user.id]);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Select store (for admin after login)
// Requires a valid token: the target user is ALWAYS the authenticated user.
// (Previously this endpoint minted a JWT for any userId passed in the body —
// a full authentication bypass. Never trust userId from the request body.)
router.post('/select-store', authenticate, async (req, res) => {
  try {
    const { storeId } = req.body;

    if (!storeId) {
      return res.status(400).json({ error: 'Store ID is required' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.role !== 'admin' || user.status !== 'active') {
      return res.status(403).json({ error: 'Invalid user or not an active admin' });
    }

    let store;
    try {
      // Only allow selecting a store the admin actually owns — otherwise an admin
      // could mint a token scoped to another admin's store
      store = await queryOne('SELECT * FROM stores WHERE id = ? AND status = ? AND admin_id = ?', [storeId, 'active', user.id]);
      if (!store) {
        return res.status(403).json({ error: 'Cửa hàng không tồn tại hoặc không thuộc quyền quản lý của bạn' });
      }
    } catch (error) {
      // If stores table doesn't exist, allow using storeId as user.id (backward compatibility)
      const userStore = await queryOne('SELECT * FROM users WHERE id = ? AND role = ?', [storeId, 'employer']);
      if (!userStore) {
        return res.status(404).json({ error: 'Store not found' });
      }
      store = { id: userStore.id, name: userStore.name };
    }
    
    if (!store) {
      return res.status(404).json({ error: 'Store not found' });
    }

    // Generate token with store_id (use store.id which is stores.id, or fallback to user.store_id)
    const finalStoreId = store?.id || user.store_id || null;
    const token = jwt.sign(
      { 
        id: user.id, 
        role: user.role, 
        name: user.name, 
        store_id: finalStoreId
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    // Log login
    await execute(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id)
      VALUES (?, 'login', 'user', ?)
    `, [user.id, user.id]);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        status: user.status,
        store_id: finalStoreId
      },
      store: {
        id: store.id,
        name: store.name,
        address: store.address,
        phone: store.phone
      }
    });
  } catch (error) {
    console.error('Select store error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Select employee (for employer after login)
// Requires a valid token: the target user is ALWAYS the authenticated user
// (same auth-bypass fix as /select-store — never trust userId from the body).
router.post('/select-employee', authenticate, async (req, res) => {
  try {
    const { employeeId } = req.body;

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.role !== 'employer' || user.status !== 'active') {
      return res.status(403).json({ error: 'Invalid user or not an active employer' });
    }

    // employees.store_id references users.id, so use user.id for employees query
    // But user.store_id from database is stores.id, which we need for promotions filtering
    const employeeStoreId = user.id; // Use user.id for employees query

    let selectedEmployee = null;
    if (employeeId) {
      selectedEmployee = await queryOne('SELECT * FROM employees WHERE id = ? AND store_id = ? AND status = ?', [employeeId, employeeStoreId, 'active']);
      if (!selectedEmployee) {
        return res.status(404).json({ error: 'Employee not found' });
      }
    }

    // Generate token with store_id (stores.id) and employee_id
    const token = jwt.sign(
      { 
        id: user.id, 
        role: user.role, 
        name: user.name, 
        store_id: user.store_id, // Use actual stores.id from database
        employee_id: employeeId || null
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    // Log login (ignore errors if audit_logs table doesn't exist)
    try {
      await execute(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id)
        VALUES (?, 'login', 'user', ?)
      `, [user.id, user.id]);
    } catch (error) {
      // Ignore audit log errors
    }

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        status: user.status,
        store_id: user.store_id // Use actual stores.id from database
      },
      employee: selectedEmployee ? {
        id: selectedEmployee.id,
        name: selectedEmployee.name,
        phone: selectedEmployee.phone
      } : null
    });
  } catch (error) {
    console.error('Select employee error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout (client-side token removal, but we log it)
router.post('/logout', authenticate, async (req, res) => {
  try {
    await execute(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id)
      VALUES (?, 'logout', 'user', ?)
    `, [req.user.id, req.user.id]);

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
