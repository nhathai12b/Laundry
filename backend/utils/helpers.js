import bcrypt from 'bcryptjs';
import { queryOne } from '../database/db.js';
import { MAX_ORDER_CODE_GENERATION_ATTEMPTS } from './constants.js';

export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

export const comparePassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

/**
 * SĐT dùng để gộp khách: rỗng hoặc placeholder (vd. "0") không được coi là số thật —
 * nếu không, mọi đơn nhập "0" sẽ chung một bản ghi customers và tên bị ghi đè.
 * Trả về null → luồng tạo đơn tạo khách với phone tạm (temp_*) riêng từng đơn.
 */
export const normalizeCustomerPhoneForIdentity = (phone) => {
  if (phone == null) return null;
  const s = String(phone).trim();
  if (!s) return null;
  if (s === '0' || /^0+$/.test(s)) return null;
  return s;
};

/**
 * Generate unique order code with retry logic to prevent collisions
 * @returns {Promise<string>} Unique order code
 */
export const generateOrderCode = async () => {
  let attempts = 0;
  
  while (attempts < MAX_ORDER_CODE_GENERATION_ATTEMPTS) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const code = `DH${year}${month}${day}${random}`;
    
    // Check if code exists
    try {
      const existing = await queryOne('SELECT id FROM orders WHERE code = ?', [code]);
      if (!existing) {
        return code;
      }
    } catch (error) {
      // If query fails, assume code is available (fail-safe)
      console.warn('Error checking order code uniqueness:', error.message);
      return code;
    }
    
    attempts++;
  }
  
  throw new Error('Không thể tạo mã đơn hàng duy nhất sau nhiều lần thử');
};

/** Chấm công: giờ Việt Nam (GMT+7), không DST. */
const TZ_VN = 'Asia/Ho_Chi_Minh';

/** Định dạng thời điểm hiện tại thành YYYY-MM-DD HH:mm:ss theo GMT+7 (lưu DB chấm công). */
export function formatDateTimeGMT7(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_VN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // hour12: false alone can render midnight as "24" under ICU; hourCycle
    // 'h23' guarantees 00-23 so MySQL DATETIME never rejects the value.
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = g('hour') === '24' ? '00' : g('hour');
  return `${g('year')}-${g('month')}-${g('day')} ${hour}:${g('minute')}:${g('second')}`;
}

/**
 * Chuỗi chấm công YYYY-MM-DD HH:mm:ss (hoặc T) được hiểu là giờ VN → timestamp UTC (ms).
 * Chuỗi đã có hậu tố Z/±offset được parse theo chuẩn đó.
 */
export function parseTimesheetDateTimeMs(value) {
  if (value == null || value === '') return NaN;
  if (value instanceof Date) {
    // mysql2 builds DATETIME values into a Date whose *local* getters equal the
    // literal stored value, regardless of the Node process's own timezone.
    // Re-interpret those literal components as GMT+7 (same convention as
    // formatDateTimeGMT7/the string branch below) instead of trusting
    // getTime(), which depends on process.env.TZ and can silently be off by
    // hours whenever the server isn't running in Asia/Ho_Chi_Minh.
    return Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours() - 7,
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds()
    );
  }
  let s = String(value).trim().replace(' ', 'T');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    return new Date(s).getTime();
  }
  return new Date(`${s}+07:00`).getTime();
}

/**
 * Tính giờ làm từ check-in đến check-out.
 * Toàn bộ giờ làm đều tính là giờ thường (không tách tăng ca).
 * Thời gian chấm công được hiểu theo GMT+7 (Việt Nam).
 */
export const calculateHours = (checkIn, checkOut) => {
  if (!checkOut) return { regular: 0, overtime: 0 };

  const start = parseTimesheetDateTimeMs(checkIn);
  const end = parseTimesheetDateTimeMs(checkOut);
  if (Number.isNaN(start) || Number.isNaN(end)) return { regular: 0, overtime: 0 };

  const diffMs = end - start;
  const diffHours = diffMs / (1000 * 60 * 60);
  const totalHours = Math.max(0, diffHours);

  return {
    regular: Math.round(totalHours * 100) / 100,
    overtime: 0,
  };
};

