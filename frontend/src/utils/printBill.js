import api from './api';

const BLUETOOTH_PRINTER_NAME_KEY = 'laundry_bluetooth_printer_name';

/** Cached Bluetooth printer device — dùng lại trong phiên hiện tại; đóng Chrome thì mất, dùng tên lưu để filter lần sau */
let cachedBluetoothDevice = null;
let cachedGattServer = null;
let cachedCharacteristic = null;
let gattConnectionPromise = null;

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

const clearGattCache = () => {
  cachedGattServer = null;
  cachedCharacteristic = null;
  gattConnectionPromise = null;
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

const findWritableCharacteristic = async (server) => {
  for (const serviceId of KNOWN_SERVICE_IDS) {
    try {
      const svc = await server.getPrimaryService(serviceId);
      for (const charId of KNOWN_CHAR_IDS) {
        try {
          const char = await svc.getCharacteristic(charId);
          if (char.properties.write || char.properties.writeWithoutResponse) {
            return char;
          }
        } catch (_) { continue; }
      }
    } catch (_) { continue; }
  }

  const services = await server.getPrimaryServices();
  for (const svc of services) {
    try {
      const chars = await svc.getCharacteristics();
      for (const char of chars) {
        if (char.properties.write || char.properties.writeWithoutResponse) {
          return char;
        }
      }
    } catch (_) { continue; }
  }

  return null;
};

const sendEscPosData = async (characteristic, escPosDataBase64) => {
  const binaryString = atob(escPosDataBase64);
  const data = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    data[i] = binaryString.charCodeAt(i);
  }

  const useWithoutResponse =
    characteristic.properties.writeWithoutResponse &&
    typeof characteristic.writeValueWithoutResponse === 'function';
  const chunkSize = 100;

  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    if (useWithoutResponse) {
      await characteristic.writeValueWithoutResponse(chunk);
      if (i + chunkSize < data.length) {
        await new Promise(resolve => setTimeout(resolve, 8));
      }
    } else if (typeof characteristic.writeValueWithResponse === 'function') {
      await characteristic.writeValueWithResponse(chunk);
    } else {
      await characteristic.writeValue(chunk);
    }
  }
};

/**
 * Connect or reuse cached GATT connection, find writable characteristic
 * Uses promise-based locking to prevent concurrent connection attempts
 */
const ensureGattConnection = async (device) => {
  if (gattConnectionPromise) {
    return gattConnectionPromise;
  }

  if (cachedGattServer && cachedCharacteristic) {
    try {
      if (cachedGattServer.connected) {
        return cachedCharacteristic;
      }
    } catch (_) {
      clearGattCache();
    }
  }

  gattConnectionPromise = (async () => {
    try {
      const server = await device.gatt.connect();
      const characteristic = await findWritableCharacteristic(server);

      if (!characteristic) {
        throw new Error('Không tìm thấy đặc tính ghi dữ liệu trên máy in. Máy in có thể dùng UUID khác — thử in qua máy chủ (WiFi) trong Cài đặt.');
      }

      cachedGattServer = server;
      cachedCharacteristic = characteristic;
      return characteristic;
    } finally {
      gattConnectionPromise = null;
    }
  })();

  return gattConnectionPromise;
};

/**
 * Connect to Bluetooth printer and print ESC/POS data.
 * Reuses cached device & GATT connection to eliminate reconnect overhead.
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

  if (cachedBluetoothDevice) {
    try {
      const characteristic = await ensureGattConnection(cachedBluetoothDevice);
      await sendEscPosData(characteristic, escPosDataBase64);
      return true;
    } catch (error) {
      clearGattCache();
      if (error.message.includes('không tìm thấy đặc tính')) {
        throw error;
      }
    }
  }

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
    const characteristic = await ensureGattConnection(device);
    await sendEscPosData(characteristic, escPosDataBase64);
    return true;
  } catch (error) {
    clearGattCache();
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
  if (cachedGattServer && cachedGattServer.connected) {
    try {
      cachedGattServer.disconnect();
    } catch (_) {}
  }
  clearGattCache();
  cachedBluetoothDevice = null;
  setSavedPrinterName(null);
};
