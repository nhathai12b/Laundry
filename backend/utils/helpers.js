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

/** Định dạng thời điểm tuyệt đối UTC thành YYYY-MM-DD HH:mm:ss để lưu DATETIME. */
export function formatDateTimeUTC(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Chuỗi chấm công YYYY-MM-DD HH:mm:ss (hoặc T) được hiểu là UTC.
 * Chuỗi đã có hậu tố Z/±offset được parse theo chuẩn đó.
 */
export function parseTimesheetDateTimeMs(value) {
  if (value == null || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  let s = String(value).trim().replace(' ', 'T');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    return new Date(s).getTime();
  }
  return new Date(`${s}Z`).getTime();
}

/**
 * Tính giờ làm từ check-in đến check-out.
 * Giờ vượt 8 giờ/ca được tính là tăng ca (overtime).
 * Thời gian chấm công được hiểu là UTC và frontend hiển thị theo timezone máy dùng.
 */
export const calculateHours = (checkIn, checkOut) => {
  if (!checkOut) return { regular: 0, overtime: 0 };

  const start = parseTimesheetDateTimeMs(checkIn);
  const end = parseTimesheetDateTimeMs(checkOut);
  if (Number.isNaN(start) || Number.isNaN(end)) return { regular: 0, overtime: 0 };

  const diffMs = end - start;
  const diffHours = diffMs / (1000 * 60 * 60);
  const totalHours = Math.max(0, diffHours);

  const regularHours = Math.min(totalHours, 8);
  const overtimeHours = Math.max(totalHours - 8, 0);

  return {
    regular: Math.round(regularHours * 100) / 100,
    overtime: Math.round(overtimeHours * 100) / 100,
  };
};

