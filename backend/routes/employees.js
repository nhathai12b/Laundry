import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { validateRequiredString, sanitizeString } from '../utils/validators.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get employees for current store (employer) or selected store (admin)
router.get('/', async (req, res) => {
  try {
    let employees;
    
    if (req.user.role === 'admin' && req.user.role !== 'root') {
      // Admin can ONLY see employees from stores in their chain
      // employees.store_id references users.id, and users.store_id must be in stores with admin_id = user.id
      employees = await query(`
        SELECT e.*, u.name as store_name, u.name as account_name, u.phone as account_phone
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
        SELECT * FROM employees
        WHERE store_id = ? AND status = ?
        ORDER BY name
      `, [req.user.id, 'active']);
    }

    res.json({ data: employees });
  } catch (error) {
    console.error('Get employees error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create employee (Admin or Store owner)
router.post('/', async (req, res) => {
  try {
    const { name, phone, user_id } = req.body;
    
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

    const result = await execute(`
      INSERT INTO employees (store_id, name, phone)
      VALUES (?, ?, ?)
    `, [storeId, nameValidation.value, phoneValue]);

    const employee = await queryOne('SELECT * FROM employees WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: employee });
  } catch (error) {
    console.error('Create employee error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Update employee
router.patch('/:id', async (req, res) => {
  try {
    const { name, phone, status, user_id, store_id } = req.body;

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

    const updated = await queryOne('SELECT * FROM employees WHERE id = ?', [req.params.id]);
    res.json({ data: updated });
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Delete employee
router.delete('/:id', async (req, res) => {
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
    // For admin: can delete employees from their store chain
    if (req.user.role === 'employer' && employee.store_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete employees of your own account' });
    }

    // Use transaction to ensure atomicity
    await transaction(async (db) => {
      // Delete related records first to avoid foreign key constraints
      try {
        await db.execute('DELETE FROM timesheets WHERE employee_id = ?', [req.params.id]);
      } catch (error) {
        // Warning log removed for security
        // Continue even if timesheets deletion fails (might not exist)
      }

      // Delete employee
      await db.execute('DELETE FROM employees WHERE id = ?', [req.params.id]);
    });

    res.json({ message: 'Employee deleted successfully' });
  } catch (error) {
    console.error('Delete employee error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

export default router;
