import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { authenticate, authorize, blockEmployeeLogin } from '../middleware/auth.js';
import { validateEnum, sanitizeString } from '../utils/validators.js';
import { isValidIP, isValidPort } from '../utils/ipValidator.js';
import { resolveCurrentStoreId } from '../services/workingStoreService.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get settings (Admin or Employer)
router.get('/', async (req, res) => {
  try {
    let storeId = null;
    
    // Determine store_id based on user role
    if (req.user.role === 'employer') {
      // Cửa hàng của tài khoản (users.store_id trong token) — hoá đơn in đúng
      // thông tin cửa hàng
      storeId = await resolveCurrentStoreId(req.user);
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      // For admin, chỉ được xem settings cửa hàng trong chuỗi của mình.
      // req.user.store_id LUÔN null cho admin (admin không gắn 1 cửa hàng cố
      // định) — dùng nó làm fallback từng khiến MỌI admin không truyền
      // store_id rơi vào CÙNG 1 row store_id IS NULL dùng chung toàn hệ
      // thống (đọc được/ghi đè cấu hình in bill của admin khác). -1 là giá
      // trị canh gác không khớp bất kỳ store_id thật nào lẫn IS NULL.
      const rawStoreId = req.query.store_id || null;
      if (rawStoreId) {
        const store = await queryOne('SELECT id FROM stores WHERE id = ? AND admin_id = ?', [rawStoreId, req.user.id]);
        storeId = store ? Number(rawStoreId) : -1;
      } else {
        const firstStore = await queryOne('SELECT id FROM stores WHERE admin_id = ? ORDER BY id ASC LIMIT 1', [req.user.id]);
        storeId = firstStore ? firstStore.id : -1;
      }
    } else if (req.user.role === 'root') {
      // Root là vendor phần mềm, không vận hành cửa hàng — không cho đọc
      // settings in/hoá đơn của BẤT KỲ cửa hàng nào (nhất quán với orders.js,
      // reports.js, products.js, promotions.js, ... trong toàn hệ thống).
      // Trước đây route này để root truyền store_id bất kỳ không kiểm tra
      // admin_id, đọc được cấu hình của mọi tenant.
      return res.json({ data: {}, store_id: null });
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
router.put('/', blockEmployeeLogin, async (req, res) => {
  try {
    const { printer_ip, printer_port, printer_com_port, paper_size, print_method, bill_store_name, bill_store_address, bill_store_phone, bill_footer_message, bill_qr_image, bill_qr_content, bill_bottom_padding_mm, store_id } = req.body;

    // COM port: "COM3" on Windows, or a /dev/tty* path on Linux
    const isValidComPort = (value) => /^COM\d+$/i.test(String(value).trim()) || /^\/dev\/[\w./-]+$/.test(String(value).trim());
    if (printer_com_port !== undefined && String(printer_com_port).trim() !== '' && !isValidComPort(printer_com_port)) {
      return res.status(400).json({ error: 'Cổng COM không hợp lệ. Ví dụ hợp lệ: COM3' });
    }
    
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
      const methodValidation = validateEnum(print_method, ['server', 'bluetooth', 'com'], 'Phương thức in');
      if (!methodValidation.valid) {
        return res.status(400).json({ error: 'Phương thức in không hợp lệ. Chỉ chấp nhận: server, bluetooth hoặc com' });
      }
    }
    
    let targetStoreId = store_id || null;
    
    // Determine store_id based on user role
    if (req.user.role === 'employer') {
      // Lưu settings cho cửa hàng của tài khoản
      const currentStoreId = await resolveCurrentStoreId(req.user);
      if (currentStoreId) {
        targetStoreId = currentStoreId;
      } else {
        return res.status(400).json({ error: 'Employer account không có cửa hàng được gán' });
      }
    } else if (req.user.role === 'admin' && req.user.role !== 'root') {
      // req.user.store_id LUÔN null cho admin — bắt buộc phải chọn store_id
      // tường minh khi LƯU, không fallback ngầm về row store_id IS NULL dùng
      // chung toàn hệ thống (đọc lại xem GET / phía trên để biết lý do).
      targetStoreId = store_id || null;
      if (!targetStoreId) {
        return res.status(400).json({ error: 'Vui lòng chọn cửa hàng để lưu cài đặt.' });
      }
      const store = await queryOne('SELECT id FROM stores WHERE id = ? AND admin_id = ?', [targetStoreId, req.user.id]);
      if (!store) {
        return res.status(403).json({ error: 'Bạn không có quyền cập nhật settings cho cửa hàng này' });
      }
    } else if (req.user.role === 'root') {
      // Root là vendor phần mềm, không vận hành cửa hàng — không cho cập nhật
      // settings của bất kỳ cửa hàng nào (xem GET / phía trên).
      return res.status(403).json({ error: 'Root admin không thể cập nhật settings cửa hàng.' });
    }

    // Use transaction to ensure atomicity
    await transaction(async (db) => {
      // UNIQUE (key, store_id) KHÔNG bắt trùng khi store_id NULL (chuẩn SQL:
      // NULL != NULL) → ON DUPLICATE không bao giờ kích hoạt cho setting toàn
      // cục, mỗi lần lưu tạo thêm 1 row trùng và GET trả giá trị tùy ý.
      // Setting toàn cục phải UPDATE-trước, INSERT-khi-chưa-có.
      const upsertSetting = async (key, value) => {
        if (targetStoreId === null || targetStoreId === undefined) {
          const result = await db.execute(
            'UPDATE settings SET value = ? WHERE `key` = ? AND store_id IS NULL',
            [value, key]
          );
          if (!result.affectedRows) {
            await db.execute(
              'INSERT INTO settings (`key`, value, store_id) VALUES (?, ?, NULL)',
              [key, value]
            );
          }
          return;
        }
        await db.execute(`
          INSERT INTO settings (\`key\`, value, store_id)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, [key, value, targetStoreId]);
      };
      // MySQL uses INSERT ... ON DUPLICATE KEY UPDATE with store_id
      if (printer_ip !== undefined) {
        const ipSanitized = sanitizeString(printer_ip);
        await upsertSetting('printer_ip', ipSanitized.value);
      }
      if (printer_port !== undefined) {
        const portValidation = isValidPort(printer_port);
        const portValue = portValidation.valid ? portValidation.value : 9100;
        await upsertSetting('printer_port', String(portValue));
      }
      if (paper_size !== undefined) {
        const paperSizeValidation = validateEnum(paper_size, ['58mm', '80mm', '112mm'], 'Kích thước giấy');
        const paperSizeValue = paperSizeValidation.valid ? paperSizeValidation.value : '80mm';
        await upsertSetting('paper_size', paperSizeValue);
      }
      if (printer_com_port !== undefined) {
        const comSanitized = sanitizeString(String(printer_com_port).trim().toUpperCase().startsWith('COM')
          ? String(printer_com_port).trim().toUpperCase()
          : String(printer_com_port).trim());
        await upsertSetting('printer_com_port', comSanitized.value);
      }
      if (print_method !== undefined) {
        const methodValidation = validateEnum(print_method, ['server', 'bluetooth', 'com'], 'Phương thức in');
        const methodValue = methodValidation.valid ? methodValidation.value : 'server';
        await upsertSetting('print_method', methodValue);
      }
      if (bill_store_name !== undefined) {
        const nameSanitized = sanitizeString(bill_store_name || '');
        await upsertSetting('bill_store_name', nameSanitized.value);
      }
      if (bill_store_address !== undefined) {
        const addressSanitized = sanitizeString(bill_store_address || '');
        await upsertSetting('bill_store_address', addressSanitized.value);
      }
      if (bill_store_phone !== undefined) {
        const phoneSanitized = sanitizeString(bill_store_phone || '');
        await upsertSetting('bill_store_phone', phoneSanitized.value);
      }
      if (bill_footer_message !== undefined) {
        const footerSanitized = sanitizeString(bill_footer_message || 'Cảm ơn quý khách!');
        await upsertSetting('bill_footer_message', footerSanitized.value);
      }
      if (bill_qr_image !== undefined) {
        const qrVal = typeof bill_qr_image === 'string' && bill_qr_image.length <= 60000 ? bill_qr_image : '';
        await upsertSetting('bill_qr_image', qrVal);
      }
      if (bill_qr_content !== undefined) {
        const contentVal = typeof bill_qr_content === 'string' ? String(bill_qr_content).trim().slice(0, 500) : '';
        await upsertSetting('bill_qr_content', contentVal);
      }
      if (bill_bottom_padding_mm !== undefined) {
        const v = parseInt(bill_bottom_padding_mm, 10);
        const val = (isNaN(v) || v < 0) ? 0 : Math.min(100, v);
        await upsertSetting('bill_bottom_padding_mm', String(val));
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

