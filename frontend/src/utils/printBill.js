import api from './api';

const BLUETOOTH_PRINTER_NAME_KEY = 'laundry_bluetooth_printer_name';

/** Cached Bluetooth printer device — dùng lại trong phiên hiện tại; đóng Chrome thì mất, dùng tên lưu để filter lần sau */
let cachedBluetoothDevice = null;

const getSavedPrinterName = () => {
  try {
    return localStorage.getItem(BLUETOOTH_PRINTER_NAME_KEY) || null;
  } catch (_) {
    return null;
  }
};

const setSavedPrinterName = (name) => {
  try {
    if (name) localStorage.setItem(BLUETOOTH_PRINTER_NAME_KEY, name);
    else localStorage.removeItem(BLUETOOTH_PRINTER_NAME_KEY);
  } catch (_) {}
};

/**
 * Check if Web Bluetooth is supported
 */
const isBluetoothSupported = () => {
  return 'bluetooth' in navigator;
};

const OPTIONAL_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '00001800-0000-1000-8000-00805f9b34fb',
];

const KNOWN_CHAR_IDS = [
  '0000fff1-0000-1000-8000-00805f9b34fb',
  '0000fff2-0000-1000-8000-00805f9b34fb',
  '0000fff3-0000-1000-8000-00805f9b34fb',
];

const KNOWN_SERVICE_IDS = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
];

/**
 * Connect to device's GATT, find writable characteristic, send ESC/POS data
 */
const connectAndSend = async (device, escPosDataBase64) => {
  const server = await device.gatt.connect();
  let characteristic = null;

  for (const serviceId of KNOWN_SERVICE_IDS) {
    try {
      const svc = await server.getPrimaryService(serviceId);
      for (const charId of KNOWN_CHAR_IDS) {
        try {
          const char = await svc.getCharacteristic(charId);
          if (char.properties.write || char.properties.writeWithoutResponse) {
            characteristic = char;
            break;
          }
        } catch (_) { continue; }
      }
      if (characteristic) break;
    } catch (_) { continue; }
  }

  if (!characteristic) {
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      try {
        const chars = await svc.getCharacteristics();
        for (const char of chars) {
          if (char.properties.write || char.properties.writeWithoutResponse) {
            characteristic = char;
            break;
          }
        }
        if (characteristic) break;
      } catch (_) { continue; }
    }
  }

  if (!characteristic) {
    throw new Error('Không tìm thấy đặc tính ghi dữ liệu trên máy in. Máy in có thể dùng UUID khác — thử in qua máy chủ (WiFi) trong Cài đặt.');
  }

  const binaryString = atob(escPosDataBase64);
  const data = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    data[i] = binaryString.charCodeAt(i);
  }

  // writeValueWithoutResponse là API đúng và nhanh (không chờ ACK từng gói);
  // writeValue(chunk, {type}) cũ truyền option không tồn tại nên mọi gói đều bị ghi kiểu chờ ACK
  const useWithoutResponse =
    characteristic.properties.writeWithoutResponse &&
    typeof characteristic.writeValueWithoutResponse === 'function';
  const chunkSize = 100;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    if (useWithoutResponse) {
      await characteristic.writeValueWithoutResponse(chunk);
      // Nghỉ ngắn giữa các gói để buffer máy in không tràn (không có ACK để tự điều tiết)
      if (i + chunkSize < data.length) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } else if (typeof characteristic.writeValueWithResponse === 'function') {
      // Ghi có ACK: BLE tự điều tiết, không cần delay thủ công
      await characteristic.writeValueWithResponse(chunk);
    } else {
      await characteristic.writeValue(chunk);
    }
  }

  device.gatt.disconnect();
};

/**
 * Connect to Bluetooth printer and print ESC/POS data.
 * Dùng lại máy in đã chọn lần trước (cachedBluetoothDevice), chỉ hiện danh sách chọn máy khi chưa có hoặc kết nối lỗi.
 */
const printViaBluetooth = async (escPosDataBase64) => {
  if (!isBluetoothSupported()) {
    throw new Error('Web Bluetooth không được hỗ trợ trên thiết bị này');
  }

  const normalizeError = (error) => {
    if (error.name === 'NotFoundError') {
      return new Error(
        'Trình duyệt không thấy máy in. Thử: (1) Bật máy in, bật chế độ ghép nối Bluetooth. (2) Khi bấm In bill, chọn đúng máy in trong danh sách trình duyệt hiện ra (khác với kết nối trong Cài đặt). (3) Nếu máy in chỉ hỗ trợ Bluetooth cổ điển (SPP), web không kết nối được — dùng in qua máy chủ (WiFi) trong Cài đặt.'
      );
    }
    if (error.name === 'SecurityError') return new Error('Lỗi bảo mật. Vui lòng cho phép truy cập Bluetooth.');
    if (error.name === 'NetworkError') {
      return new Error(
        'Không kết nối được với máy in. Nguyên nhân thường gặp: máy in dùng Bluetooth Classic (SPP) — trình duyệt chỉ kết nối được máy in BLE. Với máy in Xprinter/Gprinter Bluetooth: ghép nối máy in với máy chủ Windows rồi chuyển Cài đặt → Phương thức in sang "Cổng COM".'
      );
    }
    return new Error(`Lỗi kết nối Bluetooth: ${error.message || 'Lỗi không xác định'}`);
  };

  // Ưu tiên dùng máy in đã chọn lần trước — không bao giờ xóa cache (kể cả khi kết nối lỗi)
  if (cachedBluetoothDevice) {
    try {
      await connectAndSend(cachedBluetoothDevice, escPosDataBase64);
      return true;
    } catch (_) {
      // Không xóa cachedBluetoothDevice; rơi xuống để hiện danh sách chọn máy (thử lại hoặc chọn máy khác)
    }
  }

  // Chưa có cache hoặc kết nối lỗi → chọn máy in (ưu tiên filter theo tên đã lưu để sau khi đóng/mở lại Chrome chỉ cần chạm 1 lần)
  const savedName = getSavedPrinterName();
  try {
    let device = null;
    if (savedName && savedName.trim()) {
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ name: savedName.trim() }],
          optionalServices: OPTIONAL_SERVICES,
        });
      } catch (filterErr) {
        // Máy đổi tên / không thấy / user hủy → thử mở danh sách tất cả
        device = null;
      }
    }
    if (!device) {
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: OPTIONAL_SERVICES,
      });
    }
    cachedBluetoothDevice = device;
    if (device.name) setSavedPrinterName(device.name);
    await connectAndSend(device, escPosDataBase64);
    return true;
  } catch (error) {
    throw normalizeError(error);
  }
};

/**
 * Get print settings from server.
 * Cache 30s: bỏ một round-trip mỗi lần in; admin đổi cài đặt in sẽ có hiệu lực sau tối đa 30s.
 */
let cachedPrintSettings = null;
let cachedPrintSettingsAt = 0;
const PRINT_SETTINGS_CACHE_MS = 30 * 1000;

const getPrintSettings = async () => {
  if (cachedPrintSettings && Date.now() - cachedPrintSettingsAt < PRINT_SETTINGS_CACHE_MS) {
    return cachedPrintSettings;
  }
  try {
    const response = await api.get('/settings');
    cachedPrintSettings = response.data.data || {};
    cachedPrintSettingsAt = Date.now();
    return cachedPrintSettings;
  } catch (error) {
    console.error('Error loading print settings:', error);
    return {
      print_method: 'server'
    };
  }
};

/**
 * Print bill using the method set in settings
 * This function enforces the print method set by admin
 */
export const printBill = async (orderId) => {
  try {
    // In bill luôn qua Bluetooth — các phương thức khác đã bị bỏ khỏi Cài đặt.
    // Ép cứng ở đây để cửa hàng còn lưu print_method='server'/'com' cũ trong DB
    // vẫn in được mà không cần lưu lại Cài đặt.
    const printMethod = 'bluetooth';

    // Enforce the print method from settings
    if (printMethod === 'bluetooth') {
      // Must use Bluetooth
      if (!isBluetoothSupported()) {
        throw new Error('Thiết bị này không hỗ trợ in Bluetooth qua trình duyệt (chỉ hoạt động trên Chrome ở Android). Vui lòng mở ứng dụng bằng Chrome trên điện thoại Android để in bill.');
      }
      
      // Get bill data from server
      const response = await api.get(`/print/bill-data/${orderId}`);
      if (response.data.success && response.data.data) {
        // Print via Bluetooth
        await printViaBluetooth(response.data.data);
        return { success: true, method: 'bluetooth' };
      } else {
        throw new Error('Không thể lấy dữ liệu bill để in');
      }
    } else {
      // Must use Server (default)
      await api.post(`/print/bill/${orderId}`);
      return { success: true, method: 'server' };
    }
  } catch (error) {
    // Re-throw with better error message
    if (error.response?.data?.error) {
      throw new Error(error.response.data.error);
    }
    throw error;
  }
};

/**
 * Xóa máy in Bluetooth đã lưu. Lần in tiếp theo sẽ yêu cầu chọn lại máy in.
 * Gọi từ Cài đặt khi cần đổi sang máy in khác.
 */
export const resetBluetoothPrinter = () => {
  cachedBluetoothDevice = null;
  setSavedPrinterName(null);
};
