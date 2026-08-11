import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { validateEnum, sanitizeString } from '../utils/validators.js';
import { isValidIP, isValidPort } from '../utils/ipValidator.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get settings (Admin or Employer)
router.get('/', async (req, res) => {
  try {
    let storeId = null;
    
    // Determine store_id based on user role
    if (req.user.role === 'employer') {
      // For employer, get their store_id from users table
      const user = await queryOne('SELECT store_id FROM users WHERE id = ? AND role = ?', [req.user.id, 'employer']);
      if (user && user.store_id) {
        storeId = user.store_id;
      }
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      // For admin, chỉ được xem settings cửa hàng trong chuỗi của mình
      const rawStoreId = req.query.store_id || req.user.store_id || null;
      if (rawStoreId) {
        const store = await queryOne('SELECT id FROM stores WHERE id = ? AND admin_id = ?', [rawStoreId, req.user.id]);
        storeId = store ? rawStoreId : null;
      } else {
        storeId = null;
      }
    } else if (req.user.role === 'root') {
      // Root can specify store_id in query
      storeId = req.query.store_id || null;
    }
    
    // Query settings for the store (store_id can be null for global settings)
    const settings = await query('SELECT * FROM settings WHERE store_id = ? OR (store_id IS NULL AND ? IS NULL)', [storeId, storeId]);
    const settingsObj = {};
    settings.forEach((s) => {
      settingsObj[s.key] = s.value;
    });
    
    // If no settings found, return defaults
    if (Object.keys(settingsObj).length === 0) {
      settingsObj.printer_ip = '192.168.1.100';
      settingsObj.printer_port = '9100';
      settingsObj.paper_size = '80mm';
      settingsObj.print_method = 'server';
      settingsObj.bill_store_name = '';
      settingsObj.bill_store_address = '';
      settingsObj.bill_store_phone = '';
      settingsObj.bill_footer_message = 'Cảm ơn quý khách!';
      settingsObj.bill_bottom_padding_mm = '0';
    } else {
      // Set defaults if not present
      if (!settingsObj.print_method) {
        settingsObj.print_method = 'server';
      }
      if (settingsObj.bill_footer_message === undefined || settingsObj.bill_footer_message === null) {
        settingsObj.bill_footer_message = 'Cảm ơn quý khách!';
      }
    }
    
    res.json({ data: settingsObj, store_id: storeId });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update settings (Admin or Employer)
router.put('/', async (req, res) => {
  try {
    const { printer_ip, printer_port, paper_size, print_method, bill_store_name, bill_store_address, bill_store_phone, bill_footer_message, bill_qr_image, bill_qr_content, bill_bottom_padding_mm, store_id } = req.body;
    
    // Validate inputs
    if (printer_ip !== undefined) {
      const ipValidation = isValidIP(printer_ip);
      if (!ipValidation.valid) {
        return res.status(400).json({ error: ipValidation.error });
      }
    }

    if (printer_port !== undefined) {
      const portValidation = isValidPort(printer_port);
      if (!portValidation.valid) {
        return res.status(400).json({ error: portValidation.error });
      }
    }

    if (paper_size !== undefined) {
      const paperSizeValidation = validateEnum(paper_size, ['58mm', '80mm', '112mm'], 'Kích thước giấy');
      if (!paperSizeValidation.valid) {
        return res.status(400).json({ error: paperSizeValidation.error });
      }
    }

    if (print_method !== undefined) {
      const methodValidation = validateEnum(print_method, ['server', 'bluetooth'], 'Phương thức in');
      if (!methodValidation.valid) {
        return res.status(400).json({ error: 'Phương thức in không hợp lệ. Chỉ chấp nhận: server hoặc bluetooth' });
      }
    }
    
    let targetStoreId = store_id || null;
    
    // Determine store_id based on user role
    if (req.user.role === 'employer') {
      // For employer, get their store_id from users table
      const user = await queryOne('SELECT store_id FROM users WHERE id = ? AND role = ?', [req.user.id, 'employer']);
      if (user && user.store_id) {
        targetStoreId = user.store_id;
      } else {
        return res.status(400).json({ error: 'Employer account không có cửa hàng được gán' });
      }
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      // For admin, use store_id from body or token
      targetStoreId = store_id || req.user.store_id || null;
      // Verify store belongs to admin
      if (targetStoreId) {
        const store = await queryOne('SELECT id FROM stores WHERE id = ? AND admin_id = ?', [targetStoreId, req.user.id]);
        if (!store) {
          return res.status(403).json({ error: 'Bạn không có quyền cập nhật settings cho cửa hàng này' });
        }
      }
    } else if (req.user.role === 'root') {
      // Root can set store_id explicitly
      targetStoreId = store_id || null;
    }

    // Use transaction to ensure atomicity
    await transaction(async (db) => {
      // MySQL uses INSERT ... ON DUPLICATE KEY UPDATE with store_id
      if (printer_ip !== undefined) {
        const ipSanitized = sanitizeString(printer_ip);
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['printer_ip', ipSanitized.value, targetStoreId]);
      }
      if (printer_port !== undefined) {
        const portValidation = isValidPort(printer_port);
        const portValue = portValidation.valid ? portValidation.value : 9100;
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['printer_port', String(portValue), targetStoreId]);
      }
      if (paper_size !== undefined) {
        const paperSizeValidation = validateEnum(paper_size, ['58mm', '80mm', '112mm'], 'Kích thước giấy');
        const paperSizeValue = paperSizeValidation.valid ? paperSizeValidation.value : '80mm';
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['paper_size', paperSizeValue, targetStoreId]);
      }
      if (print_method !== undefined) {
        const methodValidation = validateEnum(print_method, ['server', 'bluetooth'], 'Phương thức in');
        const methodValue = methodValidation.valid ? methodValidation.value : 'server';
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['print_method', methodValue, targetStoreId]);
      }
      if (bill_store_name !== undefined) {
        const nameSanitized = sanitizeString(bill_store_name || '');
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['bill_store_name', nameSanitized.value, targetStoreId]);
      }
      if (bill_store_address !== undefined) {
        const addressSanitized = sanitizeString(bill_store_address || '');
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['bill_store_address', addressSanitized.value, targetStoreId]);
      }
      if (bill_store_phone !== undefined) {
        const phoneSanitized = sanitizeString(bill_store_phone || '');
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['bill_store_phone', phoneSanitized.value, targetStoreId]);
      }
      if (bill_footer_message !== undefined) {
        const footerSanitized = sanitizeString(bill_footer_message || 'Cảm ơn quý khách!');
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['bill_footer_message', footerSanitized.value, targetStoreId]);
      }
      if (bill_qr_image !== undefined) {
        const qrVal = typeof bill_qr_image === 'string' && bill_qr_image.length <= 60000 ? bill_qr_image : '';
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['bill_qr_image', qrVal, targetStoreId]);
      }
      if (bill_qr_content !== undefined) {
        const contentVal = typeof bill_qr_content === 'string' ? String(bill_qr_content).trim().slice(0, 500) : '';
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['bill_qr_content', contentVal, targetStoreId]);
      }
      if (bill_bottom_padding_mm !== undefined) {
        const v = parseInt(bill_bottom_padding_mm, 10);
        const val = (isNaN(v) || v < 0) ? 0 : Math.min(100, v);
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, ['bill_bottom_padding_mm', String(val), targetStoreId]);
      }
    });

    // Get updated settings
    const settings = await query('SELECT * FROM settings WHERE store_id = ? OR (store_id IS NULL AND ? IS NULL)', [targetStoreId, targetStoreId]);
    const settingsObj = {};
    settings.forEach((s) => {
      settingsObj[s.key] = s.value;
    });

    res.json({ data: settingsObj, store_id: targetStoreId });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

export default router;

