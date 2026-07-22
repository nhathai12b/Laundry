import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'node:net';
import { fileURLToPath } from 'url';
import { query, queryOne } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { validateId } from '../utils/validators.js';
import { createCanvas, registerFont, loadImage } from 'canvas';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BILL_FONT_FAMILY = 'BillFont';
const deployFontsDir = process.env.APP_ROOT || '/var/www/laundry-backend';

const fontCandidates = [
  path.join(__dirname, '..', 'fonts', 'NotoSansVietnamese-Regular.ttf'),
  path.join(__dirname, '..', 'fonts', 'arial.ttf'),
  path.join(__dirname, '..', 'fonts', 'NotoSans-Regular.ttf'),
  path.join(deployFontsDir, 'fonts', 'NotoSansVietnamese-Regular.ttf'),
  path.join(deployFontsDir, 'fonts', 'arial.ttf'),
  path.join(deployFontsDir, 'fonts', 'NotoSans-Regular.ttf'),
  ...(process.platform === 'win32' ? ['C:\\Windows\\Fonts\\arial.ttf'] : []),
  ...(process.platform !== 'win32' ? [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/LiberationSans-Regular.ttf',
  ] : []),
];

function tryRegisterFont(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      registerFont(filePath, { family: BILL_FONT_FAMILY });
      return true;
    }
  } catch (_) {}
  return false;
}

let fontRegistered = false;
for (const p of fontCandidates) {
  if (tryRegisterFont(p)) { fontRegistered = true; break; }
}
if (!fontRegistered) {
  const fontDirs = [path.join(__dirname, '..', 'fonts'), path.join(deployFontsDir, 'fonts')];
  for (const dir of fontDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.ttf') || n.endsWith('.otf'));
    if (files.length && tryRegisterFont(path.join(dir, files[0]))) { fontRegistered = true; break; }
  }
}

const router = express.Router();
router.use(authenticate);

/** Đơn hàng + khách — chỉ khi user được phép xem/in (admin chuỗi, employer cửa hàng). */
async function getOrderForBill(req, orderId) {
  if (req.user.role === 'root') return null;

  let sql = `
    SELECT o.*, c.name as customer_name, c.phone as customer_phone
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    WHERE o.id = ?`;
  const params = [orderId];

  if (req.user.role === 'admin' && req.user.role !== 'root') {
    sql += ` AND (
      (o.store_id IS NOT NULL AND o.store_id IN (SELECT id FROM stores WHERE admin_id = ?))
      OR (
        o.store_id IS NULL AND (
          o.assigned_to IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
          OR o.created_by IN (SELECT id FROM users WHERE store_id IN (SELECT id FROM stores WHERE admin_id = ?))
        )
      )
    )`;
    params.push(req.user.id, req.user.id, req.user.id);
  } else if (req.user.role === 'employer') {
    if (req.user.store_id) {
      sql += ` AND (
        o.store_id = ?
        OR (o.store_id IS NULL AND (o.assigned_to = ? OR o.created_by = ?))
      )`;
      params.push(req.user.store_id, req.user.id, req.user.id);
    } else {
      sql += ` AND (o.assigned_to = ? OR o.created_by = ?)`;
      params.push(req.user.id, req.user.id);
    }
  } else {
    return null;
  }

  return queryOne(sql, params);
}

function sendEscPosToNetworkPrinter(host, port, buffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const sock = net.createConnection({ host, port });
    sock.setTimeout(15000, () => {
      sock.destroy();
      finish(new Error('Hết thời gian chờ máy in (kiểm tra IP/cổng và mạng)'));
    });
    sock.once('error', (e) => {
      sock.destroy();
      finish(e);
    });
    sock.once('connect', () => {
      sock.write(buffer, (writeErr) => {
        if (writeErr) {
          sock.destroy();
          return finish(writeErr);
        }
        sock.end();
      });
    });
    sock.once('close', () => finish());
  });
}

async function loadBillPayload(req, orderId) {
  if (!validateId(orderId).valid) {
    return { error: { status: 400, body: { error: 'Order ID không hợp lệ' } } };
  }

  const order = await getOrderForBill(req, orderId);
  if (!order) {
    return { error: { status: 404, body: { error: 'Order not found' } } };
  }

  const items = await query(
    `SELECT oi.*, p.name as product_name, p.unit as product_unit
     FROM order_items oi
     JOIN products p ON oi.product_id = p.id
     WHERE oi.order_id = ?`,
    [orderId]
  );

  const storeId = order.store_id ?? null;
  const settingsRows = await query(
    'SELECT `key`, value FROM settings WHERE store_id = ? OR (store_id IS NULL AND ? IS NULL)',
    [storeId, storeId]
  );
  const settings = {};
  settingsRows.forEach((s) => {
    settings[s.key] = s.value;
  });
  const paperSize = settings.paper_size || '80mm';

  const billData = await generateBill(order, items, settings, paperSize);
  return { order, items, settings, paperSize, billData };
}

// GET /bill-data/:orderId - returns base64 ESC/POS bitmap for Bluetooth printing
router.get('/bill-data/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const payload = await loadBillPayload(req, orderId);
    if (payload.error) {
      return res.status(payload.error.status).json(payload.error.body);
    }
    const { billData, paperSize } = payload;
    res.json({ success: true, data: billData.toString('base64'), paperSize });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi tạo bill' });
  }
});

// POST /bill/:orderId - gửi ESC/POS tới máy in mạng (printer_ip / printer_port trong Cài đặt)
router.post('/bill/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const payload = await loadBillPayload(req, orderId);
    if (payload.error) {
      return res.status(payload.error.status).json(payload.error.body);
    }

    const { settings, billData } = payload;
    const printerIp = (settings.printer_ip && String(settings.printer_ip).trim()) || '';
    const portRaw = settings.printer_port;
    const printerPort = portRaw != null && String(portRaw).trim() !== '' ? parseInt(String(portRaw), 10) : NaN;

    if (!printerIp || Number.isNaN(printerPort) || printerPort < 1 || printerPort > 65535) {
      return res.status(400).json({
        error: 'Chưa cấu hình IP và cổng máy in. Vào Cài đặt → In bill → nhập IP và cổng (thường 9100), rồi Lưu.',
      });
    }

    try {
      await sendEscPosToNetworkPrinter(printerIp, printerPort, billData);
    } catch (e) {
      const msg = e?.message || 'Lỗi kết nối máy in';
      return res.status(502).json({
        error: `Không gửi được tới máy in ${printerIp}:${printerPort}. ${msg}`,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Print bill error:', err);
    res.status(500).json({ error: 'Lỗi khi in bill' });
  }
});

function canvasToEscPos(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const pixels = img.data;
  const bytesPerLine = Math.ceil(w / 8);
  const data = Buffer.alloc(bytesPerLine * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = pixels[idx], g = pixels[idx+1], b = pixels[idx+2];
      const gray = (r + g + b) / 3;
      const bit = gray < 128 ? 1 : 0;
      const byteIndex = y * bytesPerLine + (x >> 3);
      const bitIndex = 7 - (x & 0x7);
      if (bit) data[byteIndex] |= (1 << bitIndex);
    }
  }
  const header = Buffer.from([
    0x1d,0x76,0x30,0x00,
    bytesPerLine & 0xff, (bytesPerLine>>8)&0xff,
    h & 0xff, (h>>8)&0xff
  ]);
  return Buffer.concat([header, data]);
}

function formatDateDDMMYYYY(dateStr) {
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

async function generateBill(order, items, settings, paperSize) {
  const str = (s) => String(s ?? '');
  const widthPx = paperSize === '112mm' ? 576 : paperSize === '80mm' ? 384 : 288;
  const fontSize = 22;
  const titleFontSize = 28;
  const lineHeight = Math.max(fontSize + 4, titleFontSize + 4);
  const fontFamily = fontRegistered ? BILL_FONT_FAMILY : 'Arial';
  const ctxFont = `${fontSize}px ${fontFamily}`;

  const storeName = str(settings.bill_store_name || 'CỬA HÀNG').trim() || 'CỬA HÀNG';
  const storeAddress = str(settings.bill_store_address).trim();
  const storePhone = str(settings.bill_store_phone).trim();
  const footerMessage = str(settings.bill_footer_message || 'Cảm ơn quý khách!').trim() || 'Cảm ơn quý khách!';

  const rows = [];
  rows.push({ type: 'center', text: storeName, fontSize: titleFontSize });
  rows.push({ type: 'full', text: '-------------------' });
  rows.push({ type: 'full', text: 'Ngày: ' + formatDateDDMMYYYY(order.created_at) });
  rows.push({ type: 'full', text: 'Khách: ' + str(order.customer_name || order.customer_phone || 'N/A') });
  if (order.customer_phone) rows.push({ type: 'full', text: 'SĐT: ' + order.customer_phone });
  rows.push({ type: 'full', text: '-------------------' });
  rows.push({ type: 'row', name: 'TÊN SẢN PHẨM', qty: 'SL', priceStr: 'ĐƠN GIÁ' });
  rows.push({ type: 'full', text: '-------------------' });
  items.forEach((item) => {
    const name = str(item.product_name);
    const qty = Number(item.quantity);
    const unitPrice = parseFloat(item.unit_price) || 0;
    const priceStr = unitPrice.toLocaleString('vi-VN') + ' đ';
    rows.push({ type: 'row', name, qty, priceStr });
  });
  rows.push({ type: 'full', text: '-------------------' });
  rows.push({ type: 'full', text: 'Tổng: ' + (parseFloat(order.total_amount) || 0).toLocaleString('vi-VN') + ' đ' });
  if (order.discount_amount && parseFloat(order.discount_amount) > 0) {
    rows.push({ type: 'full', text: 'Giảm giá: -' + parseFloat(order.discount_amount).toLocaleString('vi-VN') + ' đ' });
  }
  rows.push({ type: 'full', text: 'Thanh tiền: ' + (parseFloat(order.final_amount) || 0).toLocaleString('vi-VN') + ' đ' });
  rows.push({ type: 'full', text: '' });
  if (storeAddress) rows.push({ type: 'full', text: 'Dc: ' + storeAddress });
  if (storePhone) rows.push({ type: 'full', text: 'Sdt: ' + storePhone });
  rows.push({ type: 'full', text: '' });
  rows.push({ type: 'center', text: footerMessage }); // Thông điệp cuối bill — luôn dòng cuối, canh giữa

  const canvas = createCanvas(widthPx, lineHeight * rows.length + 10);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black';
  ctx.font = ctxFont;

  const colNameEnd = Math.floor(widthPx * 0.58);
  const colQtyEnd = Math.floor(widthPx * 0.75);

  rows.forEach((row, i) => {
    const y = (i + 1) * lineHeight;
    if (row.type === 'center') {
      const fs = row.fontSize || fontSize;
      ctx.font = `${fs}px ${fontFamily}`;
      const tw = ctx.measureText(row.text).width;
      ctx.fillText(row.text, Math.max(0, (widthPx - tw) / 2), y);
      ctx.font = ctxFont;
      return;
    }
    if (row.type === 'full') {
      ctx.fillText(row.text, 0, y);
      return;
    }
    const maxNameW = colNameEnd - 4;
    let name = row.name;
    if (ctx.measureText(name).width > maxNameW) {
      while (name.length && ctx.measureText(name + '…').width > maxNameW) name = name.slice(0, -1);
      name = name + '…';
    }
    const qtyStr = row.qty != null ? String(row.qty) : '';
    const priceStr = row.priceStr || '';
    ctx.fillText(name, 0, y);
    ctx.fillText(qtyStr, colNameEnd, y);
    ctx.fillText(priceStr, colQtyEnd, y);
  });

  let outputCanvas = canvas;
  const qrSizePx = Math.min(Math.floor(widthPx * 0.55), 220);
  const qrPadding = 12;

  let qrBuffer = null;
  const qrContent = settings.bill_qr_content ? String(settings.bill_qr_content).trim() : '';
  if (qrContent.length > 0) {
    try {
      qrBuffer = await QRCode.toBuffer(qrContent, { type: 'png', width: qrSizePx, margin: 1 });
    } catch (err) {
      console.error('Bill QR generate error:', err.message);
    }
  }
  if (!qrBuffer && settings.bill_qr_image) {
    const qrRaw = String(settings.bill_qr_image).trim();
    const qrBase64 = qrRaw.replace(/^data:image\/[^;]+;base64,/, '').replace(/\s/g, '');
    if (qrBase64.length > 0) {
      try {
        const buf = Buffer.from(qrBase64, 'base64');
        if (buf.length > 0) qrBuffer = buf;
      } catch (_) {}
    }
  }

  if (qrBuffer && qrBuffer.length > 0) {
    try {
      const img = await loadImage(qrBuffer);
      const drawSize = Math.min(qrSizePx, img.width, img.height, 220);
      const totalH = canvas.height + qrPadding + drawSize + 10;
      outputCanvas = createCanvas(widthPx, totalH);
      const outCtx = outputCanvas.getContext('2d');
      outCtx.fillStyle = 'white';
      outCtx.fillRect(0, 0, widthPx, totalH);
      outCtx.drawImage(canvas, 0, 0);
      const qrX = (widthPx - drawSize) / 2;
      const qrY = canvas.height + qrPadding;
      outCtx.drawImage(img, qrX, qrY, drawSize, drawSize);
    } catch (err) {
      console.error('Bill QR draw error:', err.message);
    }
  }

  const extraBottomMm = Math.max(0, parseInt(settings.bill_bottom_padding_mm, 10) || 0);
  if (extraBottomMm > 0) {
    const pxPerMm = widthPx / (paperSize === '112mm' ? 112 : paperSize === '80mm' ? 80 : 58);
    const extraPx = Math.round(extraBottomMm * pxPerMm);
    const longCanvas = createCanvas(widthPx, outputCanvas.height + extraPx);
    const longCtx = longCanvas.getContext('2d');
    longCtx.fillStyle = 'white';
    longCtx.fillRect(0, 0, widthPx, longCanvas.height);
    longCtx.drawImage(outputCanvas, 0, 0);
    outputCanvas = longCanvas;
  }

  return canvasToEscPos(outputCanvas);
}

export default router;

