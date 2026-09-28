// Dùng chung giữa salary.js (Lương của tôi / admin xem lương nhân viên) và
// timesheets.js (payroll admin) — trước đây mỗi file định nghĩa lại y hệt,
// dễ sửa một nơi quên nơi kia khiến 2 màn hình lệch số liệu cho cùng một
// nhân viên/tháng.
import { formatDateTimeUTC } from './helpers.js';

// Chỉ nuốt lỗi thiếu bảng/cột (DB chưa migrate) — lỗi thật (deadlock, timeout)
// phải ném ra, nếu không lương/hoa hồng trả về 0 im lặng
export const swallowMissingSchema = (fallback) => (error) => {
  if (error?.code === 'ER_NO_SUCH_TABLE' || error?.code === 'ER_BAD_FIELD_ERROR') return fallback;
  throw error;
};

export const getTimezoneOffsetMinutes = (req) => {
  const offset = Number.parseInt(req.query.timezone_offset_minutes ?? '0', 10);
  if (Number.isNaN(offset) || offset < -840 || offset > 840) return 0;
  return offset;
};

export const isoToMysqlUtc = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTimeUTC(date);
};

// Khoảng UTC [startAt, endAt) của một THÁNG theo giờ địa phương của client
// (timezone_offset_minutes) — hoặc override trực tiếp bằng start_at/end_at
// nếu request truyền sẵn (dùng khi FE cần một khoảng ngày tuỳ ý thay vì cả
// tháng). Dùng chung cho payroll admin (timesheets.js) và lương/hoa hồng cá
// nhân (salary.js) để 2 màn hình không lệch số liệu cho cùng nhân viên/tháng.
export const getMonthUtcRange = (req, month, year) => {
  if (req.query.start_at && req.query.end_at) {
    const startAt = isoToMysqlUtc(req.query.start_at);
    const endAt = isoToMysqlUtc(req.query.end_at);
    if (startAt && endAt) return { startAt, endAt };
  }
  const offset = getTimezoneOffsetMinutes(req);
  // offset = getTimezoneOffset() = UTC − local (VN: -420).
  // Mốc local 00:00 ngày 1 → UTC = local + offset  (VD: 1/8 00:00 VN = 31/7 17:00Z)
  const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1) + offset * 60 * 1000);
  const end = new Date(Date.UTC(Number(year), Number(month), 1) + offset * 60 * 1000);
  return { startAt: formatDateTimeUTC(start), endAt: formatDateTimeUTC(end) };
};
