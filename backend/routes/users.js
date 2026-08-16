import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { hashPassword } from '../utils/helpers.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';
import { validatePositiveNumber, sanitizeString, validateRequiredString } from '../utils/validators.js';
import { validatePasswordStrength, containsUserInfo } from '../utils/passwordValidator.js';

const router = express.Router();

/**
 * Can a non-root admin manage this target user?
 * Root: yes. Admin: only employer accounts whose store belongs to their chain
 * (stores.admin_id = admin.id), matching the GET /users list scoping.
 * Returns false for cross-chain targets and for admin/root targets touched by a
 * non-root admin (those are gated separately by role).
 */
async function adminCanManageUser(targetUser, requester) {
  if (requester.role === 'root') return true;
  if (requester.role !== 'admin') return false;
  if (targetUser.role !== 'employer') return false;
  if (!targetUser.store_id) return false;
  const row = await queryOne(
    'SELECT 1 FROM stores WHERE id = ? AND admin_id = ?',
    [targetUser.store_id, requester.id]
  );
  return Boolean(row);
}

/** Add months to a date without day overflow (e.g. Jan 31 + 1 month = Feb 28, not Mar 2) */
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/** Add one year; day stays same (Feb 29 -> Feb 28 next year) */
function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

// All routes require authentication
router.use(authenticate);

function normalizeDailyReportWebhookUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.length > 1000) {
    const error = new Error('Webhook URL quá dài');
    error.statusCode = 400;
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    const error = new Error('Webhook URL không hợp lệ');
    error.statusCode = 400;
    throw error;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('Webhook URL phải bắt đầu bằng http hoặc https');
    error.statusCode = 400;
    throw error;
  }

  return url;
}

function normalizeDiscordId(value, fieldName) {
  const id = String(value || '').trim();
  if (!id) return '';
  if (!/^\d{5,30}$/.test(id)) {
    const error = new Error(`${fieldName} không hợp lệ`);
    error.statusCode = 400;
    throw error;
  }
  return id;
}

router.get('/daily-revenue-report-settings', authorize('admin'), async (req, res) => {
  try {
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không có cấu hình báo cáo doanh thu chuỗi' });
    }

    const row = await queryOne(`
      SELECT
        daily_revenue_report_enabled,
        daily_revenue_report_webhook_url,
        daily_revenue_report_discord_guild_id,
        daily_revenue_report_discord_channel_id
      FROM users
      WHERE id = ? AND role = 'admin'
    `, [req.user.id]);

    if (!row) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    res.json({
      data: {
        enabled: Boolean(row.daily_revenue_report_enabled),
        webhook_url: row.daily_revenue_report_webhook_url || '',
        discord_guild_id: row.daily_revenue_report_discord_guild_id || '',
        discord_channel_id: row.daily_revenue_report_discord_channel_id || '',
      },
    });
  } catch (error) {
    console.error('Get daily revenue report settings error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Server error' });
  }
});

router.put('/daily-revenue-report-settings', authorize('admin'), async (req, res) => {
  try {
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không có cấu hình báo cáo doanh thu chuỗi' });
    }

    const enabled = req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1';
    const webhookUrl = normalizeDailyReportWebhookUrl(req.body.webhook_url);
    const discordGuildId = normalizeDiscordId(req.body.discord_guild_id, 'Discord Guild ID');
    const discordChannelId = normalizeDiscordId(req.body.discord_channel_id, 'Discord Channel ID');

    if (enabled && !webhookUrl) {
      return res.status(400).json({ error: 'Vui lòng nhập webhook URL trước khi bật báo cáo doanh thu' });
    }

    await execute(`
      UPDATE users
      SET daily_revenue_report_enabled = ?,
          daily_revenue_report_webhook_url = ?,
          daily_revenue_report_discord_guild_id = ?,
          daily_revenue_report_discord_channel_id = ?
      WHERE id = ? AND role = 'admin'
    `, [enabled ? 1 : 0, webhookUrl || null, discordGuildId || null, discordChannelId || null, req.user.id]);

    res.json({
      data: {
        enabled,
        webhook_url: webhookUrl,
        discord_guild_id: discordGuildId,
        discord_channel_id: discordChannelId,
      },
    });
  } catch (error) {
    console.error('Update daily revenue report settings error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Server error' });
  }
});

// Get all users (Admin only)
router.get('/', authorize('admin'), async (req, res) => {
  try {
    let users;
    try {
      if (req.user.role === 'root') {
        users = await query(`
          SELECT u.id, u.name, u.phone, u.role, u.status, u.started_at, u.hourly_rate, u.shift_rate, 
                 u.created_at, u.updated_at, u.store_id, s.name as store_name,
                 u.subscription_expires_at, u.subscription_package,
                 (SELECT COUNT(*) FROM stores st WHERE st.admin_id = u.id) as store_count
          FROM users u
          LEFT JOIN stores s ON u.store_id = s.id
          WHERE u.role IN ('admin', 'root')
          ORDER BY u.created_at DESC
        `);
      } else if (req.user.role === 'admin' && req.user.role !== 'root') {
        // Admin can only see users from stores in their chain (stores with admin_id = user.id)
        // Exclude admin/root users - only show employer users (tài khoản tiệm)
        users = await query(`
          SELECT u.id, u.name, u.phone, u.role, u.status, u.started_at, u.hourly_rate, u.shift_rate, 
                 u.created_at, u.updated_at, u.store_id, s.name as store_name,
                 u.subscription_expires_at, u.subscription_package
          FROM users u
          LEFT JOIN stores s ON u.store_id = s.id
          WHERE s.admin_id = ?
            AND u.role = 'employer'
          ORDER BY u.created_at DESC
        `, [req.user.id]);
      } else {
        // Admin without proper setup (should not happen, but handle gracefully)
        users = [];
      }
    } catch (error) {
      // If stores table doesn't exist or error occurs, handle gracefully
      // Error log removed for security
      if (req.user.role === 'root') {
        // Root can only see admin accounts even if stores table has issues (không dùng store_count ở đây vì stores có thể chưa có)
        users = await query(`
          SELECT u.id, u.name, u.phone, u.role, u.status, u.started_at, u.hourly_rate, u.shift_rate, 
                 u.created_at, u.updated_at, u.store_id, NULL as store_name,
                 u.subscription_expires_at, u.subscription_package, 0 as store_count
          FROM users u
          WHERE u.role IN ('admin', 'root')
          ORDER BY u.created_at DESC
        `);
      } else if (req.user.role === 'admin' && req.user.role !== 'root') {
        // Admin: return empty array if we can't verify store ownership
        // This is safer than showing all users
        users = [];
      } else {
        // For other roles, return empty array
        users = [];
      }
    }

    res.json({ data: users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single user
router.get('/:id', authorize('admin'), async (req, res) => {
  try {
    const user = await queryOne(`
      SELECT id, name, phone, role, status, started_at, hourly_rate, shift_rate, created_at, updated_at, store_id
      FROM users
      WHERE id = ?
    `, [req.params.id]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Scope to chain: a non-root admin may only read employer accounts in their
    // own store chain (the list endpoint is scoped; this one was not)
    if (req.user.role !== 'root' && parseInt(req.params.id, 10) !== req.user.id
        && !(await adminCanManageUser(user, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền xem tài khoản này' });
    }

    res.json({ data: user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create user (Root or Admin)
router.post('/', authorize('admin'), auditLog('create', 'user', (req) => req.body.id || null), async (req, res) => {
  try {
    const { name, phone, password, role, started_at, status, hourly_rate, shift_rate, store_id, trial_7days } = req.body;

    if (!name || !password || !role) {
      return res.status(400).json({ error: 'Name, password, and role are required' });
    }

    // Phone validation - không bắt buộc cho admin, chỉ check duplicate nếu có
    let phoneValue = phone ? phone.trim() : '';
    
    // Nếu role là admin, phone có thể để trống
    if (role !== 'admin' && !phoneValue) {
      return res.status(400).json({ error: 'Số điện thoại là bắt buộc' });
    }
    
    // Check duplicate phone chỉ khi phone được cung cấp
    if (phoneValue) {
      const existing = await queryOne('SELECT id, name, role FROM users WHERE phone = ?', [phoneValue]);
      if (existing) {
        return res.status(400).json({ 
          error: `Số điện thoại "${phoneValue}" đã được sử dụng bởi ${existing.name} (${existing.role})` 
        });
      }
    }

    // Only root can create admin users
    if (role === 'admin' && req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có thể tạo admin mới' });
    }

    // Only root can create root users
    if (role === 'root' && req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có thể tạo root admin' });
    }

    // Store ID handling
    let storeId = null;
    if (role === 'employer') {
      // Employer requires store_id
      if (!store_id) {
        return res.status(400).json({ error: 'Store ID is required. Please select a store.' });
      }

      // Verify store exists in stores table
      const storeExists = await queryOne('SELECT id FROM stores WHERE id = ?', [store_id]);
      if (!storeExists) {
        return res.status(400).json({ error: 'Selected store does not exist' });
      }

      storeId = parseInt(store_id);
    } else if (role === 'admin') {
      // Admin thường không có store_id
      // Admin chỉ được quản lý bởi root admin, không xuất hiện trong danh sách stores/users/employees
      storeId = null;
    }

    const password_hash = await hashPassword(password);

    // Admin mới tạo bởi root sẽ có status 'pending', cần được root phê duyệt
    // Nếu chọn "Dùng thử 7 ngày" thì tạo admin active với gói 7 ngày
    let userStatus = status || 'active';
    if (role === 'admin' && req.user.role === 'root') {
      userStatus = trial_7days ? 'active' : 'pending';
    }

    // Password validation removed - no requirements

    const nameSanitized = sanitizeString(name);
    if (!nameSanitized.valid || nameSanitized.value === '') {
      return res.status(400).json({ error: 'Tên người dùng không được để trống' });
    }

    // Validate hourly_rate and shift_rate if provided
    let hourlyRateValue = null;
    if (hourly_rate !== undefined && hourly_rate !== null && hourly_rate !== '') {
      const rateValidation = validatePositiveNumber(hourly_rate, true);
      if (!rateValidation.valid) {
        return res.status(400).json({ error: `Mức lương theo giờ: ${rateValidation.error}` });
      }
      hourlyRateValue = rateValidation.value;
    }

    let shiftRateValue = null;
    if (shift_rate !== undefined && shift_rate !== null && shift_rate !== '') {
      const rateValidation = validatePositiveNumber(shift_rate, true);
      if (!rateValidation.valid) {
        return res.status(400).json({ error: `Mức lương theo ca: ${rateValidation.error}` });
      }
      shiftRateValue = rateValidation.value;
    }

    const result = await execute(`
      INSERT INTO users (name, phone, password_hash, role, started_at, status, hourly_rate, shift_rate, store_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      nameSanitized.value,
      phoneValue || null,
      password_hash,
      role,
      started_at || null,
      userStatus,
      hourlyRateValue,
      shiftRateValue,
      storeId
    ]);

    const newId = result.insertId;

    // Nếu chọn "Dùng thử 7 ngày": cập nhật subscription cho admin vừa tạo
    if (role === 'admin' && req.user.role === 'root' && trial_7days) {
      const now = new Date();
      const expirationDate = new Date(now);
      expirationDate.setDate(expirationDate.getDate() + 7);
      const expirationDateStr = expirationDate.toISOString().slice(0, 19).replace('T', ' ');
      await execute(`
        UPDATE users SET subscription_package = '7days', subscription_expires_at = ? WHERE id = ?
      `, [expirationDateStr, newId]);
    }

    const newUser = await queryOne(`
      SELECT id, name, phone, role, status, started_at, hourly_rate, shift_rate,
             subscription_package, subscription_expires_at, store_id, created_at, updated_at
      FROM users
      WHERE id = ?
    `, [newId]);

    res.status(201).json({ data: newUser });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (Admin only)
router.patch('/:id', authorize('admin'), auditLog('update', 'user'), async (req, res) => {
  try {
    const { name, phone, password, role, started_at, status, hourly_rate, shift_rate, subscription_package, subscription_expires_at } = req.body;

    // Get old data for audit
    const oldUser = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!oldUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isSelf = parseInt(req.params.id, 10) === req.user.id;
    // Chỉ root mới được cập nhật admin khác; admin thường được đổi mật khẩu của chính mình
    if (oldUser.role === 'admin' && req.user.role !== 'root') {
      if (!isSelf) {
        return res.status(403).json({ error: 'Chỉ root admin mới có thể cập nhật thông tin admin' });
      }
      // Admin thường tự đổi mật khẩu: chỉ cho phép gửi password
      if (!password) {
        return res.status(400).json({ error: 'Chỉ có thể đổi mật khẩu. Gửi field password.' });
      }
      const password_hash = await hashPassword(password);
      await execute('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, req.params.id]);
      return res.json({ message: 'Đổi mật khẩu thành công' });
    }

    // Non-admin target (employer): a non-root admin may only touch accounts in
    // their own store chain — prevents editing/escalating other admins' staff
    if (oldUser.role !== 'admin' && !(await adminCanManageUser(oldUser, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền cập nhật tài khoản này' });
    }
    // Never allow a non-root admin to change a role (privilege-escalation guard)
    if (role !== undefined && role !== oldUser.role && req.user.role !== 'root') {
      return res.status(403).json({ error: 'Bạn không có quyền thay đổi vai trò tài khoản' });
    }

    // Check if phone exists (if changed)
    // Không bắt buộc phone cho admin, chỉ check duplicate nếu có
    if (phone !== undefined) {
      const trimmedPhone = phone ? phone.trim() : '';
      
      // Nếu role là admin, phone có thể để trống
      if (oldUser.role !== 'admin' && !trimmedPhone) {
        return res.status(400).json({ error: 'Số điện thoại là bắt buộc' });
      }
      
      // Check duplicate chỉ khi phone được cung cấp và khác với phone hiện tại
      if (trimmedPhone && trimmedPhone !== oldUser.phone) {
        const existing = await queryOne('SELECT id, name, role FROM users WHERE phone = ?', [trimmedPhone]);
        if (existing) {
          return res.status(400).json({ 
            error: `Số điện thoại "${trimmedPhone}" đã được sử dụng bởi ${existing.name} (${existing.role})` 
          });
        }
      }
    }

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
    if (phone !== undefined) { 
      const trimmedPhone = phone ? phone.trim() : '';
      
      // Nếu role là admin, phone có thể để trống
      if (oldUser.role !== 'admin' && !trimmedPhone) {
        return res.status(400).json({ error: 'Số điện thoại không được để trống' });
      }
      
      updates.push('phone = ?'); 
      values.push(trimmedPhone || null); 
    }
    if (role !== undefined) { updates.push('role = ?'); values.push(role); }
    if (started_at !== undefined) { 
      updates.push('started_at = ?'); 
      // Convert empty string to null for datetime field
      values.push(started_at === '' || started_at === null ? null : started_at); 
    }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    if (hourly_rate !== undefined) {
      if (hourly_rate === '' || hourly_rate === null) {
        updates.push('hourly_rate = ?');
        values.push(null);
      } else {
        const rateValidation = validatePositiveNumber(hourly_rate, true); // Allow zero
        if (!rateValidation.valid) {
          return res.status(400).json({ error: `Mức lương theo giờ: ${rateValidation.error}` });
        }
        updates.push('hourly_rate = ?');
        values.push(rateValidation.value);
      }
    }
    
    if (shift_rate !== undefined) {
      if (shift_rate === '' || shift_rate === null) {
        updates.push('shift_rate = ?');
        values.push(null);
      } else {
        const rateValidation = validatePositiveNumber(shift_rate, true); // Allow zero
        if (!rateValidation.valid) {
          return res.status(400).json({ error: `Mức lương theo ca: ${rateValidation.error}` });
        }
        updates.push('shift_rate = ?');
        values.push(rateValidation.value);
      }
    }
    if (password) {
      // Password validation removed - no requirements
      const password_hash = await hashPassword(password);
      updates.push('password_hash = ?');
      values.push(password_hash);
    }
    
    // Handle subscription update (only for admin users, only root can update)
    if (subscription_package !== undefined && oldUser.role === 'admin' && req.user.role === 'root') {
      updates.push('subscription_package = ?');
      values.push(subscription_package || null);
      
      // If subscription_expires_at is provided, use it; otherwise calculate from package
      if (subscription_expires_at) {
        updates.push('subscription_expires_at = ?');
        values.push(subscription_expires_at);
      } else if (subscription_package) {
        // Calculate expiration date based on package (addMonths/addYears tránh lỗi ngày tháng, e.g. 31/1 + 1 tháng)
        const now = new Date();
        let expirationDate = null;
        switch (subscription_package) {
          case '1month':
            expirationDate = addMonths(now, 1);
            break;
          case '3months':
            expirationDate = addMonths(now, 3);
            break;
          case '6months':
            expirationDate = addMonths(now, 6);
            break;
          case '1year':
            expirationDate = addYears(now, 1);
            break;
          case '7days':
            expirationDate = new Date(now);
            expirationDate.setDate(expirationDate.getDate() + 7);
            break;
          default:
            break;
        }
        
        if (expirationDate) {
          const expirationDateStr = expirationDate.toISOString().slice(0, 19).replace('T', ' ');
          updates.push('subscription_expires_at = ?');
          values.push(expirationDateStr);
        } else {
          updates.push('subscription_expires_at = ?');
          values.push(null);
        }
      } else {
        // If package is removed, remove expiration date too
        updates.push('subscription_expires_at = ?');
        values.push(null);
      }
    } else if (subscription_expires_at !== undefined && oldUser.role === 'admin' && req.user.role === 'root') {
      // Allow direct update of expiration date
      updates.push('subscription_expires_at = ?');
      values.push(subscription_expires_at || null);
    }

    // MySQL handles updated_at automatically with ON UPDATE CURRENT_TIMESTAMP
    values.push(req.params.id);

    await execute(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = ?
    `, values);

    const updatedUser = await queryOne(`
      SELECT id, name, phone, role, status, started_at, hourly_rate, shift_rate, 
             subscription_package, subscription_expires_at, created_at, updated_at
      FROM users
      WHERE id = ?
    `, [req.params.id]);

    res.json({ data: updatedUser });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (Admin only)
router.delete('/:id', authorize('admin'), auditLog('delete', 'user'), async (req, res) => {
  try {
    const user = await queryOne('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Only root can delete admin users
    if (user.role === 'admin' && req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có thể xóa admin' });
    }

    // Non-admin target (employer): a non-root admin may only delete accounts in
    // their own store chain
    if (user.role !== 'admin' && !(await adminCanManageUser(user, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền xóa tài khoản này' });
    }

    // Don't allow deleting yourself
    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    // Block deletion when the account has order history: orders.created_by is
    // ON DELETE RESTRICT, and cascading these deletes non-atomically previously
    // destroyed payroll/employees before failing on the user row
    const orderRef = await queryOne(
      'SELECT 1 FROM orders WHERE created_by = ? OR updated_by = ? OR assigned_to = ? LIMIT 1',
      [user.id, user.id, user.id]
    );
    if (orderRef) {
      return res.status(400).json({
        error: 'Không thể xóa tài khoản đã từng tạo/xử lý đơn hàng. Hãy vô hiệu hóa tài khoản thay vì xóa.'
      });
    }

    // Cascade related rows atomically so a mid-way failure rolls back
    await transaction(async (db) => {
      await db.execute('DELETE FROM employees WHERE store_id = ?', [user.id]);
      await db.execute('DELETE FROM timesheets WHERE user_id = ?', [user.id]);
      await db.execute('DELETE FROM audit_logs WHERE user_id = ?', [user.id]);
      await db.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
    });
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Approve pending admin (Root only)
router.post('/:id/approve', authorize('admin'), auditLog('approve', 'user'), async (req, res) => {
  try {
    // Only root can approve admins
    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có thể phê duyệt admin' });
    }

    const { package: packageType } = req.body; // '3months', '6months', '1year'

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role !== 'admin') {
      return res.status(400).json({ error: 'Chỉ có thể phê duyệt admin' });
    }

    if (user.status !== 'pending') {
      return res.status(400).json({ error: 'User không ở trạng thái pending' });
    }

    // Validate package type
    const validPackages = ['1month', '3months', '6months', '1year', '7days'];
    if (!packageType || !validPackages.includes(packageType)) {
      return res.status(400).json({ error: 'Vui lòng chọn gói: 1 tháng, 3 tháng, 6 tháng, 1 năm hoặc 7 ngày dùng thử' });
    }

    // Calculate expiration date based on package (addMonths/addYears tránh lỗi ngày tháng)
    const now = new Date();
    let expirationDate;
    switch (packageType) {
      case '1month':
        expirationDate = addMonths(now, 1);
        break;
      case '3months':
        expirationDate = addMonths(now, 3);
        break;
      case '6months':
        expirationDate = addMonths(now, 6);
        break;
      case '1year':
        expirationDate = addYears(now, 1);
        break;
      case '7days':
        expirationDate = new Date(now);
        expirationDate.setDate(expirationDate.getDate() + 7);
        break;
      default:
        expirationDate = addMonths(now, 1);
    }

    // Format expiration date for MySQL (YYYY-MM-DD HH:MM:SS)
    const expirationDateStr = expirationDate.toISOString().slice(0, 19).replace('T', ' ');

    // Update admin user with subscription only
    // Admin thường không tự động có store/employer account/employee
    // Admin chỉ được quản lý bởi root admin, không xuất hiện trong danh sách stores/users/employees
    try {
      const updateResult = await execute(`
        UPDATE users 
        SET status = ?, subscription_expires_at = ?, subscription_package = ?
        WHERE id = ?
      `, ['active', expirationDateStr, packageType, req.params.id]);
      
      // Verify the update was successful
      if (updateResult.affectedRows === 0) {
        console.error(`[Approve] No rows updated for admin ${req.params.id}`);
        return res.status(500).json({ error: 'Không thể cập nhật thông tin admin. Vui lòng thử lại.' });
      }
      
      // Debug log removed for security
    } catch (error) {
      console.error('[Approve] Error updating admin user:', error);
      return res.status(500).json({ error: 'Lỗi khi cập nhật thông tin admin. Vui lòng thử lại.' });
    }

    const updated = await queryOne(`
      SELECT id, name, phone, role, status, started_at, hourly_rate, shift_rate, 
             subscription_expires_at, subscription_package, store_id, created_at, updated_at
      FROM users
      WHERE id = ?
    `, [req.params.id]);

    const packageNames = {
      '1month': '1 tháng',
      '3months': '3 tháng',
      '6months': '6 tháng',
      '1year': '1 năm',
      '7days': 'Dùng thử 7 ngày'
    };

    const message = `Admin đã được phê duyệt thành công với gói ${packageNames[packageType]}. Hết hạn: ${new Date(expirationDateStr).toLocaleDateString('vi-VN')}`;

    res.json({ 
      data: updated, 
      message: message
    });
  } catch (error) {
    console.error('Approve user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Revert approved admin to pending (Root only) - chuyển về chờ phê duyệt
router.post('/:id/revert-to-pending', authorize('admin'), auditLog('revert-to-pending', 'user'), async (req, res) => {
  try {
    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có thể chuyển trạng thái admin' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role !== 'admin') {
      return res.status(400).json({ error: 'Chỉ có thể chuyển trạng thái admin' });
    }

    if (user.status !== 'active') {
      return res.status(400).json({ error: 'Chỉ có thể chuyển admin đang hoạt động về chờ phê duyệt' });
    }

    await execute(`
      UPDATE users SET status = 'pending', subscription_package = NULL, subscription_expires_at = NULL WHERE id = ?
    `, [req.params.id]);

    const updated = await queryOne(`
      SELECT id, name, phone, role, status, started_at, hourly_rate, shift_rate,
             subscription_expires_at, subscription_package, store_id, created_at, updated_at
      FROM users WHERE id = ?
    `, [req.params.id]);

    res.json({ data: updated, message: 'Đã chuyển admin về trạng thái chờ phê duyệt' });
  } catch (error) {
    console.error('Revert to pending error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Extend subscription for admin (Root only) - gia hạn khi tài khoản hết hạn
router.post('/:id/extend-subscription', authorize('admin'), async (req, res) => {
  try {
    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có thể gia hạn' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role !== 'admin') {
      return res.status(400).json({ error: 'Chỉ có thể gia hạn cho admin' });
    }

    const validPackages = ['1month', '3months', '6months', '1year'];
    const packageType = req.body.package && validPackages.includes(req.body.package) ? req.body.package : '1month';

    const now = new Date();
    let baseDate = now;
    if (user.subscription_expires_at) {
      const expires = new Date(user.subscription_expires_at);
      if (expires > now) baseDate = expires; // gia hạn từ ngày hết hạn hiện tại nếu chưa hết
    }

    let expirationDate;
    switch (packageType) {
      case '1month':
        expirationDate = addMonths(baseDate, 1);
        break;
      case '3months':
        expirationDate = addMonths(baseDate, 3);
        break;
      case '6months':
        expirationDate = addMonths(baseDate, 6);
        break;
      case '1year':
        expirationDate = addYears(baseDate, 1);
        break;
      default:
        expirationDate = addMonths(baseDate, 1);
    }

    const expirationDateStr = expirationDate.toISOString().slice(0, 19).replace('T', ' ');

    // Cập nhật subscription và đảm bảo status = 'active' (phòng trường hợp sau này có job đổi status khi hết hạn)
    await execute(
      'UPDATE users SET subscription_package = ?, subscription_expires_at = ?, status = ? WHERE id = ?',
      [packageType, expirationDateStr, 'active', req.params.id]
    );

    const packageNames = { '1month': '1 tháng', '3months': '3 tháng', '6months': '6 tháng', '1year': '1 năm' };
    res.json({
      message: `Đã gia hạn thành công. Hết hạn mới: ${new Date(expirationDateStr).toLocaleDateString('vi-VN')}`,
      subscription_expires_at: expirationDateStr,
      subscription_package: packageType,
      package_label: packageNames[packageType],
    });
  } catch (error) {
    console.error('Extend subscription error:', error);
    res.status(500).json({ error: 'Lỗi gia hạn. Vui lòng thử lại.' });
  }
});

// Reject pending admin (Root only)
router.post('/:id/reject', authorize('admin'), auditLog('reject', 'user'), async (req, res) => {
  try {
    // Only root can reject admins
    if (req.user.role !== 'root') {
      return res.status(403).json({ error: 'Chỉ root admin mới có thể từ chối admin' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.role !== 'admin') {
      return res.status(400).json({ error: 'Chỉ có thể từ chối admin' });
    }

    if (user.status !== 'pending') {
      return res.status(400).json({ error: 'User không ở trạng thái pending' });
    }

    // Update status to inactive (rejected)
    await execute('UPDATE users SET status = ? WHERE id = ?', ['inactive', req.params.id]);

    res.json({ message: 'Admin đã bị từ chối' });
  } catch (error) {
    console.error('Reject user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
