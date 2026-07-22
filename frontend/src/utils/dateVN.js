const TZ_VN = 'Asia/Ho_Chi_Minh';

const vnDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ_VN,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Trả về ngày dương lịch "YYYY-MM-DD" theo giờ Việt Nam (GMT+7) từ một giá trị
 * ngày/giờ trả về từ backend, bất kể giá trị đó là:
 * - Date object (mysql2, JSON.parse của chuỗi ISO, v.v.)
 * - Chuỗi ISO có hậu tố Z/±offset (thời điểm tuyệt đối, cần đổi múi giờ)
 * - Chuỗi "YYYY-MM-DD HH:mm:ss" không có hậu tố (đã là giờ VN, dùng trực tiếp)
 *
 * Dùng hàm này thay cho `format(new Date(value), 'yyyy-MM-dd')` khi lọc theo
 * ngày — parse trực tiếp bằng `new Date()` rồi định dạng theo giờ trình
 * duyệt có thể lệch ngày với dữ liệu backend khi ca làm/đơn hàng rơi vào
 * khoảng 00:00–07:00 giờ Việt Nam.
 */
export function calendarDayVN(value) {
  if (value == null || value === '') return '';

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : vnDateFormatter.format(value);
  }

  const s = String(value).trim();
  if (!s) return '';

  // Absolute instant (has explicit timezone info) -> convert to VN calendar day.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '' : vnDateFormatter.format(d);
  }

  // Plain "YYYY-MM-DD ..." literal wall-clock value -> already VN time.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : vnDateFormatter.format(d);
}
