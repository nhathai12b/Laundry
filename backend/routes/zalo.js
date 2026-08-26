import express from 'express';
import { queryOne } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import {
  ensureZaloAccountRow,
  getZaloQrDataUrl,
  getZaloStatus,
  logoutZalo,
  startZaloQrLogin,
} from '../services/zaloSessionService.js';
import { sendZaloMessageByPhone } from '../services/zaloMessageService.js';

const router = express.Router();

router.use(authenticate);

// Zalo chỉ được quản lý bởi ADMIN (trang Cửa hàng & Nhân sự) — không mở
// cho tài khoản nhân viên/cửa hàng để tránh nhân viên đăng nhập/đăng xuất
// nhầm phiên Zalo của shop.
async function resolveUserStoreId(req) {
  if (req.user.role !== 'admin') {
    throw Object.assign(
      new Error('Zalo được quản lý bởi admin trong mục Cửa hàng & Nhân sự.'),
      { statusCode: 403 }
    );
  }

  const requestedStoreId = req.query.store_id || req.body?.store_id || req.user.store_id;
  if (!requestedStoreId) {
    throw Object.assign(new Error('Missing store_id'), { statusCode: 400 });
  }

  const store = await queryOne('SELECT id FROM stores WHERE id = ? AND admin_id = ?', [requestedStoreId, req.user.id]);
  if (!store) {
    throw Object.assign(new Error('You do not have permission to operate this store'), { statusCode: 403 });
  }

  return store.id;
}

function handleRouteError(res, error) {
  console.error('Zalo route error:', error);
  res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
}

router.get('/status', async (req, res) => {
  try {
    const storeId = await resolveUserStoreId(req);
    await ensureZaloAccountRow(storeId);
    const status = await getZaloStatus(storeId);
    res.json({ data: { store_id: storeId, ...status } });
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post('/login', async (req, res) => {
  try {
    const storeId = await resolveUserStoreId(req);
    const status = await startZaloQrLogin(storeId);
    res.json({ data: { store_id: storeId, ...status } });
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get('/qr', async (req, res) => {
  try {
    const storeId = await resolveUserStoreId(req);
    const qrDataUrl = await getZaloQrDataUrl(storeId);
    res.json({ data: { store_id: storeId, qrDataUrl } });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'QR code is not ready, please try again' });
    }
    handleRouteError(res, error);
  }
});

router.post('/logout', async (req, res) => {
  try {
    const storeId = await resolveUserStoreId(req);
    await logoutZalo(storeId);
    res.json({ data: { store_id: storeId, status: 'not_logged_in' } });
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post('/send-test', async (req, res) => {
  try {
    const storeId = await resolveUserStoreId(req);
    const result = await sendZaloMessageByPhone({
      storeId,
      phone: req.body?.phone,
      message: req.body?.message || 'Test message from XWASH.',
    });
    res.json({ data: result });
  } catch (error) {
    handleRouteError(res, error);
  }
});

export default router;
