import express from 'express';
import net from 'net';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { query, queryOne } from '../database/db.js';
import { authenticate } from '../middleware/auth.js';
import { validateId } from '../utils/validators.js';
import { userCanAccessOrder } from './orders.js';
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

// Load order + items + store-scoped settings for bill rendering
async function loadBillPayload(orderId) {
  const order = await queryOne(
    `SELECT o.*, c.name as customer_name, c.phone as customer_phone
     FROM orders o
     LEFT JOIN customers c ON o.customer_id=c.id
     WHERE o.id=?`,
    [orderId]
  );
  if (!order) return null;

  const items = await query(
    `SELECT oi.*, p.name as product_name, p.unit as product_unit
     FROM order_items oi
     JOIN products p ON oi.product_id=p.id
     WHERE oi.order_id=?`,
    [orderId]
  );

  const storeId = order.store_id ?? null;
  const settingsRows = await query(
    'SELECT `key`, value FROM settings WHERE store_id = ? OR (store_id IS NULL AND ? IS NULL)',
    [storeId, storeId]
  );
  const settings = {};
  settingsRows.forEach((s) => { settings[s.key] = s.value; });
  const paperSize = settings.paper_size || '80mm';

  return { order, items, settings, paperSize };
}

// GET /bill-data/:orderId - returns base64 ESC/POS bitmap for Bluetooth printing
router.get('/bill-data/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!validateId(orderId).valid) return res.status(400).json({ error: 'Order ID không hợp lệ' });

    const payload = await loadBillPayload(orderId);
    if (!payload) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    // Chặn in bill chéo tenant: thiếu check này thì bất kỳ tài khoản nào cũng
    // dò id đơn và đọc được bill (tên, SĐT khách, tiền) của chuỗi khác
    if (!(await userCanAccessOrder(payload.order, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền in đơn hàng này' });
    }

    const billData = await generateBill(payload.order, payload.items, payload.settings, payload.paperSize);
    res.json({ success: true, data: billData.toString('base64'), paperSize: payload.paperSize });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi khi tạo bill' });
  }
});

// Send raw ESC/POS bytes to a network printer (RAW/JetDirect, usually port 9100)
function sendToNetworkPrinter(host, port, data, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(message));
    };
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => fail(`Hết thời gian chờ kết nối máy in tại ${host}:${port}. Kiểm tra máy in đã bật và cùng mạng với máy chủ.`));
    socket.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        fail(`Máy in tại ${host}:${port} từ chối kết nối. Kiểm tra IP và cổng trong Cài đặt (thường là 9100).`);
      } else if (err.code === 'EHOSTUNREACH' || err.code === 'ETIMEDOUT' || err.code === 'ENETUNREACH') {
        fail(`Không tìm thấy máy in tại ${host}:${port}. Kiểm tra máy in đã bật và IP đúng chưa.`);
      } else if (err.code === 'ENOTFOUND') {
        fail(`Địa chỉ máy in "${host}" không hợp lệ.`);
      } else {
        fail(`Lỗi kết nối máy in: ${err.message}`);
      }
    });
    socket.connect(port, host, () => {
      socket.end(data, () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  });
}

// Send raw ESC/POS bytes to a serial (COM) port — used for Bluetooth printers
// paired with the server machine (Windows exposes SPP printers as COM ports)
async function sendToComPort(comPath, data) {
  let SerialPort;
  try {
    ({ SerialPort } = await import('serialport'));
  } catch (_) {
    throw new Error('Thư viện serialport chưa được cài trên máy chủ. Chạy: npm install serialport');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      try { port.close(() => {}); } catch (_) {}
      reject(new Error(message));
    };
    // High baud: Bluetooth virtual COM ports usually ignore it, but some drivers
    // throttle to the configured rate — 9600 would take ~40s for a 38KB bill
    const port = new SerialPort({ path: comPath, baudRate: 115200, autoOpen: false });
    port.on('error', (err) => fail(`Lỗi cổng ${comPath}: ${err.message}`));
    port.open((err) => {
      if (err) {
        const msg = String(err.message || '');
        if (msg.includes('File not found') || msg.includes('cannot find')) {
          return fail(`Không tìm thấy cổng ${comPath}. Kiểm tra máy in đã ghép nối Bluetooth với máy chủ và đúng cổng COM (xem trong Bluetooth Settings → COM Ports).`);
        }
        if (msg.includes('Access denied') || msg.includes('Permission denied')) {
          return fail(`Cổng ${comPath} đang bị chương trình khác chiếm dụng. Đóng phần mềm khác đang dùng máy in rồi thử lại.`);
        }
        return fail(`Không mở được cổng ${comPath}: ${msg}`);
      }
      port.write(data, (writeErr) => {
        if (writeErr) return fail(`Lỗi ghi dữ liệu ra ${comPath}: ${writeErr.message}`);
        port.drain((drainErr) => {
          if (drainErr) return fail(`Lỗi gửi dữ liệu ra ${comPath}: ${drainErr.message}`);
          port.close(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          });
        });
      });
    });
  });
}

// POST /bill/:orderId - print via server: send ESC/POS to the printer
// configured in settings — network printer (printer_ip/printer_port) or
// COM port (printer_com_port, print_method 'com')
router.post('/bill/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!validateId(orderId).valid) return res.status(400).json({ error: 'Order ID không hợp lệ' });

    const payload = await loadBillPayload(orderId);
    if (!payload) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    // Chặn in bill chéo tenant (xem GET /bill-data)
    if (!(await userCanAccessOrder(payload.order, req.user))) {
      return res.status(403).json({ error: 'Bạn không có quyền in đơn hàng này' });
    }

    const billBitmap = await generateBill(payload.order, payload.items, payload.settings, payload.paperSize);
    const escPosJob = Buffer.concat([
      Buffer.from([0x1b, 0x40]),             // ESC @ : reset printer
      billBitmap,
      Buffer.from([0x1b, 0x64, 0x03]),       // ESC d 3 : feed 3 lines
      Buffer.from([0x1d, 0x56, 0x42, 0x00])  // GS V B 0: partial cut
    ]);

    if (payload.settings.print_method === 'com') {
      const comPort = (payload.settings.printer_com_port || '').trim();
      if (!comPort) {
        return res.status(400).json({
          error: 'Chưa cấu hình cổng COM. Vào Cài đặt → nhập cổng COM của máy in (ví dụ COM3).'
        });
      }
      await sendToComPort(comPort, escPosJob);
      return res.json({ success: true, message: 'Đã gửi bill tới máy in qua cổng COM' });
    }

    const printerIp = (payload.settings.printer_ip || '').trim();
    const printerPort = parseInt(payload.settings.printer_port, 10) || 9100;
    if (!printerIp) {
      return res.status(400).json({
        error: 'Chưa cấu hình IP máy in. Vào Cài đặt → nhập IP máy in (in qua máy chủ chỉ dùng được với máy in mạng LAN/WiFi).'
      });
    }

    await sendToNetworkPrinter(printerIp, printerPort, escPosJob);
    res.json({ success: true, message: 'Đã gửi bill tới máy in' });
  } catch (err) {
    console.error('Server print error:', err.message);
    res.status(502).json({ error: err.message || 'Lỗi khi in bill qua máy chủ' });
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

