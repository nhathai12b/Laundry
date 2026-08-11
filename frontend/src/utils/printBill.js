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

  const useWithoutResponse = characteristic.properties.writeWithoutResponse;
  const chunkSize = 100;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    if (useWithoutResponse) {
      await characteristic.writeValue(chunk, { type: 'without-response' });
    } else {
      await characteristic.writeValue(chunk);
    }
    if (i + chunkSize < data.length) {
      await new Promise(resolve => setTimeout(resolve, 15));
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
    if (error.name === 'NetworkError') return new Error('Lỗi kết nối Bluetooth. Vui lòng thử lại.');
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
 * Get print settings from server
 */
const getPrintSettings = async () => {
  try {
    const response = await api.get('/settings');
    return response.data.data || {};
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
    // Get print settings - this is mandatory
    const settings = await getPrintSettings();
    const printMethod = settings.print_method || 'server';
    
    // Enforce the print method from settings
    if (printMethod === 'bluetooth') {
      // Must use Bluetooth
      if (!isBluetoothSupported()) {
        throw new Error('Web Bluetooth không được hỗ trợ trên thiết bị này (thường chỉ có trên Android Chrome). Vui lòng liên hệ admin chuyển sang "In qua máy chủ" trong Cài đặt, hoặc mở ứng dụng trên điện thoại Android Chrome để in Bluetooth.');
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
