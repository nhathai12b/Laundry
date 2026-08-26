import express from 'express';
import { query, queryOne, execute, transaction } from '../database/db.js';
import { calculateHours, formatDateTimeUTC, parseTimesheetDateTimeMs } from '../utils/helpers.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/auth.js';
import { getClientIp } from '../middleware/rateLimiter.js';
import { OVERTIME_MULTIPLIER } from '../utils/constants.js';
import { ensureOpeningFloatTx, getDrawerSummaryTx, recordClosingCountTx, recordCheckoutWithdrawalTx } from '../services/cashDrawerService.js';
import * as XLSX from 'xlsx';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

const toIsoDateTime = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim().replace(' ', 'T');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(`${s}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const LEGACY_VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 60 * 1000;

// Dữ liệu cũ từng lưu check_in theo giờ VN (sớm hơn UTC thật 7h) — đọc lên
// sẽ "ở tương lai". Không bù lại thì ca legacy không bao giờ check-out được
// (giờ ra luôn < giờ vào). Chỉ đụng tới timestamp vượt quá hiện tại + 60s.
const normalizeLegacyFutureTimeMs = (ms) => {
  if (Number.isNaN(ms)) return ms;
  if (ms > Date.now() + FUTURE_CLOCK_SKEW_MS) {
    return ms - LEGACY_VN_OFFSET_MS;
  }
  return ms;
};

const parseTimesheetDateTimeMsCompat = (value) => {
  return normalizeLegacyFutureTimeMs(parseTimesheetDateTimeMs(value));
};

const toIsoDateTimeCompat = (value) => {
  const ms = parseTimesheetDateTimeMsCompat(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const serializeTimesheet = (timesheet) => {
  if (!timesheet) return timesheet;
  return {
    ...timesheet,
    check_in: toIsoDateTimeCompat(timesheet.check_in),
    check_out: toIsoDateTimeCompat(timesheet.check_out),
    created_at: toIsoDateTime(timesheet.created_at),
  };
};

const serializeTimesheets = (timesheets) => timesheets.map(serializeTimesheet);

const isoToMysqlUtc = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTimeUTC(date);
};

const getTimezoneOffsetMinutes = (req) => {
  const offset = Number.parseInt(req.query.timezone_offset_minutes ?? '0', 10);
  if (Number.isNaN(offset) || offset < -840 || offset > 840) return 0;
  return offset;
};

const localDateSql = (column, offsetMinutes) => {
  return `DATE(DATE_SUB(${column}, INTERVAL ${offsetMinutes} MINUTE))`;
};

const getMonthUtcRange = (req, month, year) => {
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

const formatWithTimezoneOffset = (value, timezoneOffsetMinutes, type = 'date') => {
  const ms = parseTimesheetDateTimeMsCompat(value);
  if (Number.isNaN(ms)) return '';
  const local = new Date(ms - timezoneOffsetMinutes * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  const hour = String(local.getUTCHours()).padStart(2, '0');
  const minute = String(local.getUTCMinutes()).padStart(2, '0');
  const second = String(local.getUTCSeconds()).padStart(2, '0');
  return type === 'time' ? `${hour}:${minute}:${second}` : `${year}-${month}-${day}`;
};

async function getShiftPaymentSummary(db, timesheet, userId, startAt, endAt) {
  let paymentsSubquery = `
    SELECT p.order_id, SUM(p.amount) AS amount
    FROM order_payments p
    JOIN orders o2 ON p.order_id = o2.id
    WHERE p.paid_at >= ?
      AND p.paid_at <= ?
      AND p.payment_method IN ('cash', 'transfer')
  `;
  const params = [startAt, endAt];

  if (timesheet.store_id) {
    // Scope THEO TIỆM — phải khớp với routing tiền vào két (findOpenTimesheet
    // cũng scope theo tiệm). Lọc thêm theo user làm ca chính "mù" các khoản do
    // tài khoản khác của cùng tiệm thu (hoặc admin thu nợ hộ): két cộng tiền
    // nhưng revenue ca không thấy → hiện chênh lệch ảo đổ lên đầu nhân viên
    paymentsSubquery += ' AND COALESCE(p.store_id, o2.store_id) = ?';
    params.push(timesheet.store_id);
  } else {
    // Ca legacy không gắn tiệm: đành scope theo người
    paymentsSubquery += ' AND (p.user_id = ? OR o2.assigned_to = ? OR o2.created_by = ?)';
    params.push(userId, userId, userId);
  }

  paymentsSubquery += ' GROUP BY p.order_id';

  const summary = await db.queryOne(`
    SELECT
      COALESCE(SUM(agg.amount), 0) AS revenue_amount,
      COUNT(*) AS order_count,
      COALESCE(SUM(o.withdrawn_amount), 0) AS total_withdrawn
    FROM (${paymentsSubquery}) agg
    JOIN orders o ON o.id = agg.order_id
  `, params);

  return {
    revenue_amount: Number.parseFloat(summary?.revenue_amount || 0) || 0,
    order_count: Number(summary?.order_count || 0),
    total_withdrawn: Number.parseFloat(summary?.total_withdrawn || 0) || 0,
  };
}

const EMPTY_PAYMENT_SUMMARY = { revenue_amount: 0, order_count: 0, total_withdrawn: 0 };

// Concurrent-shift revenue attribution. When several employees stand the same
// shift (multiple open timesheets in one store), shift revenue must be counted
// exactly once:
// - the OLDEST open shift ("ca chính") owns the revenue window
// - a shift closing while an older one is still open ("ca phụ") takes 0 —
//   the primary will claim those payments when it closes
// - a primary's window starts right after the latest check_out already claimed
//   by an earlier-starting overlapping shift, so nothing is counted twice when
//   the previous primary closed first and this shift inherited the drawer
async function hasOlderOpenShiftTx(db, timesheet, checkInSql) {
  const older = await db.queryOne(`
    SELECT id FROM timesheets
    WHERE store_id = ? AND check_out IS NULL AND id != ?
      AND (check_in < ? OR (check_in = ? AND id < ?))
    LIMIT 1
  `, [timesheet.store_id, timesheet.id, checkInSql, checkInSql, timesheet.id]);
  return Boolean(older);
}

async function getRevenueWindowStartTx(db, timesheet, checkInSql, checkOutSql) {
  // Tie-break theo id phải GIỐNG hasOlderOpenShiftTx: chỉ ca "già hơn" (từng là
  // ca chính) mới được trim window. Nếu thiếu, ca cùng giây check-in nhưng id
  // lớn hơn (đóng trước, revenue 0 vì là ca phụ) vẫn trim window của ca chính
  // → doanh thu khoảng đầu ca không thuộc về ai
  const row = await db.queryOne(`
    SELECT MAX(check_out) AS last_claimed_until
    FROM timesheets
    WHERE store_id = ? AND id != ? AND check_out IS NOT NULL
      AND (check_in < ? OR (check_in = ? AND id < ?))
      AND check_out > ? AND check_out <= ?
  `, [timesheet.store_id, timesheet.id, checkInSql, checkInSql, timesheet.id, checkInSql, checkOutSql]);
  if (!row?.last_claimed_until) return checkInSql;
  const ms = parseTimesheetDateTimeMsCompat(row.last_claimed_until);
  // +1s: the previous shift claimed payments up to AND INCLUDING its check_out
  return Number.isNaN(ms) ? checkInSql : formatDateTimeUTC(new Date(ms + 1000));
}

async function getShiftPaymentSummaryDeduped(db, timesheet, userId, checkInSql, checkOutSql) {
  if (await hasOlderOpenShiftTx(db, timesheet, checkInSql)) {
    return { ...EMPTY_PAYMENT_SUMMARY };
  }
  const windowStart = await getRevenueWindowStartTx(db, timesheet, checkInSql, checkOutSql);
  return getShiftPaymentSummary(db, timesheet, userId, windowStart, checkOutSql);
}

// Get timesheets
router.get('/', async (req, res) => {
  try {
    const { user_id, date, month, year, start_at, end_at } = req.query;
    let sqlQuery = `
      SELECT t.*, 
        u.name as user_name,
        COALESCE(e.name, u.name) as employee_name
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE 1=1
    `;
    const params = [];

    // Root là vendor phần mềm, không vận hành cửa hàng — không nhánh nào bên
    // dưới khớp với role 'root' nên query từng chạy KHÔNG lọc gì (WHERE 1=1),
    // trả về chấm công của TOÀN BỘ tenant trong hệ thống
    if (req.user.role === 'root') {
      return res.json({ data: [] });
    }

    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          sqlQuery += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          sqlQuery += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        sqlQuery += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      sqlQuery += ' AND t.user_id = ?';
      params.push(req.user.id);
    }

    if (start_at && end_at) {
      const startAt = isoToMysqlUtc(start_at);
      const endAt = isoToMysqlUtc(end_at);
      if (!startAt || !endAt) {
        return res.status(400).json({ error: 'Invalid date range' });
      }
      sqlQuery += ' AND t.check_in >= ? AND t.check_in < ?';
      params.push(startAt, endAt);
    } else if (date) {
      sqlQuery += ' AND DATE(t.check_in) = ?';
      params.push(date);
    }

    // Filter by date range (for month view)
    const { start_date, end_date } = req.query;
    if (!start_at && !end_at && start_date && end_date) {
      sqlQuery += ' AND DATE(t.check_in) >= ? AND DATE(t.check_in) <= ?';
      params.push(start_date, end_date);
    }

    if (!start_at && !end_at && month && year) {
      const monthStr = String(month).padStart(2, '0');
      sqlQuery += ` AND DATE_FORMAT(t.check_in, '%m') = ? AND DATE_FORMAT(t.check_in, '%Y') = ?`;
      params.push(monthStr, year);
    }

    sqlQuery += ' ORDER BY t.check_in DESC';

    const timesheets = await query(sqlQuery, params);
    res.json({ data: serializeTimesheets(timesheets) });
  } catch (error) {
    console.error('Get timesheets error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get employees for store (for check-in selection)
router.get('/store-employees', async (req, res) => {
  try {
    let employeeQuery = `
      SELECT id, name, phone
      FROM employees
      WHERE status = 'active'
    `;
    const params = [];

    if (req.user.role === 'employer') {
      employeeQuery += ` AND store_id = ?`;
      params.push(req.user.id);
    } else if (req.user.role === 'admin') {
      // employees.store_id tham chiếu users.id (tài khoản cửa hàng), KHÔNG phải
      // stores.id — phải join qua users → stores để lọc đúng chuỗi của admin
      employeeQuery = `
        SELECT e.id, e.name, e.phone
        FROM employees e
        JOIN users u ON e.store_id = u.id
        JOIN stores s ON u.store_id = s.id
        WHERE e.status = 'active' AND s.admin_id = ?
      `;
      params.length = 0;
      params.push(req.user.id);
    } else {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    employeeQuery += req.user.role === 'admin' ? ` ORDER BY e.name` : ` ORDER BY name`;
    const employees = await query(employeeQuery, params);

    res.json({ data: employees });
  } catch (error) {
    console.error('Get store employees error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Chuẩn hóa IP công khai để so sánh (bỏ tiền tố IPv4-mapped "::ffff:")
function normalizeIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

// ===== Kiểm soát chấm công bằng GPS =====
// Nhân viên chỉ check-in/check-out được trong bán kính quanh tiệm.
const GEO_RADIUS_M = 150;

// Khoảng cách haversine giữa 2 tọa độ (mét)
function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Trả về message lỗi nếu vị trí KHÔNG hợp lệ, null nếu qua.
// Tiệm chưa đặt tọa độ → bỏ qua (admin bật tính năng bằng cách lưu vị trí
// tiệm trong Cửa hàng & Nhân sự); client không gửi được GPS chỉ bị chặn
// khi tiệm CÓ đặt tọa độ.
async function verifyAtStore(storeId, body) {
  if (!storeId) return null;
  const store = await queryOne('SELECT latitude, longitude FROM stores WHERE id = ?', [storeId]);
  if (!store || store.latitude === null || store.longitude === null) return null;

  const lat = Number.parseFloat(body?.latitude);
  const lng = Number.parseFloat(body?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return 'Cần bật định vị (GPS) để chấm công tại tiệm. Vui lòng cho phép trình duyệt truy cập vị trí rồi thử lại.';
  }

  // Trừ hao sai số GPS thiết bị báo về (tối đa 100m) để không chặn oan trong nhà
  const accuracy = Math.min(Math.max(Number.parseFloat(body?.accuracy) || 0, 0), 100);
  const distance = distanceMeters(lat, lng, Number(store.latitude), Number(store.longitude));
  if (distance - accuracy > GEO_RADIUS_M) {
    return `Bạn đang ở cách tiệm ~${Math.round(distance)}m — chỉ có thể chấm công trong phạm vi ${GEO_RADIUS_M}m quanh tiệm.`;
  }
  return null;
}

// Tự đóng các ca mở đã qua nửa đêm (không check-out trong ngày) → tính 0h công.
// Với mỗi ca (theo thứ tự cũ → mới):
// 1) CLAIM trước bằng UPDATE có điều kiện (chống race: 2 request đồng thời
//    chỉ 1 bên thắng — không bao giờ ghi trùng 2 dòng chốt két cho 1 ca)
// 2) Tính doanh thu ca TRƯỚC khi đóng (dedupe: ca cũ nhất nhận doanh thu,
//    ca phụ = 0) — nếu bỏ qua, tiền khách trả trong ca bị "mồ côi" khỏi báo cáo
// 3) Chốt sổ quỹ két (actual = expected, chênh lệch 0). Lỗi két thật sự →
//    rollback để lần gọi sau thử lại; riêng deploy cũ chưa có bảng két thì bỏ qua
async function autoCloseStaleShifts(userId = null) {
  // Cutoff = 00:00 hôm nay theo giờ VN, đổi về UTC — tính bằng JS để query
  // sargable (check_in < ?) dùng được index, không quét full bảng mỗi giờ
  const todayVN = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoffUtc = formatDateTimeUTC(new Date(Date.parse(`${todayVN}T00:00:00Z`) - 7 * 60 * 60 * 1000));

  const params = [cutoffUtc];
  let staleSql = `
    SELECT id, user_id, store_id, employee_id, check_in
    FROM timesheets
    WHERE check_out IS NULL AND check_in < ?
  `;
  if (userId) {
    staleSql += ' AND user_id = ?';
    params.push(userId);
  }
  staleSql += ' ORDER BY check_in ASC';

  const staleShifts = await query(staleSql, params);
  if (staleShifts.length === 0) return;

  const nowSql = formatDateTimeUTC(new Date());

  // Tính doanh thu cho TẤT CẢ ca trước khi đóng bất kỳ ca nào — lúc này mọi
  // ca đều còn mở nên dedupe hoạt động đúng (cũ nhất = ca chính, còn lại = 0)
  const revenueByShift = new Map();
  for (const shift of staleShifts) {
    try {
      const normalizedCheckIn = formatDateTimeUTC(new Date(parseTimesheetDateTimeMsCompat(shift.check_in)));
      const summary = await getShiftPaymentSummaryDeduped(
        { queryOne }, shift, shift.user_id, normalizedCheckIn, nowSql
      );
      revenueByShift.set(shift.id, summary.revenue_amount || 0);
    } catch (error) {
      // KHÔNG stamp 0 khi tính doanh thu lỗi (vd pool quá tải): đóng ca với
      // revenue=0 là mất tiền vĩnh viễn (window ca sau bắt đầu sau check_out
      // này nên không ai claim lại được). Bỏ qua ca này, sweep sau thử lại.
      console.warn(`Auto-close: skip shift ${shift.id} (revenue calc failed): ${error.message}`);
    }
  }

  for (const shift of staleShifts) {
    if (!revenueByShift.has(shift.id)) continue; // tính doanh thu lỗi — chờ sweep sau
    try {
      await transaction(async (db) => {
        // CLAIM: chỉ request thắng cuộc mới đi tiếp (auto_closed đánh dấu claim)
        const claim = await db.execute(`
          UPDATE timesheets SET auto_closed = 1
          WHERE id = ? AND check_out IS NULL AND auto_closed = 0
        `, [shift.id]);
        if (!claim.affectedRows) return; // request khác đã xử lý ca này

        // Chốt sổ quỹ két về mặt sổ sách (actual = expected kẹp ≥ 0)
        try {
          await recordClosingCountTx(db, shift, {
            actual_cash_amount: null,
            cash_shortage_paid_amount: 0,
            note: 'Tự đóng ca quá hạn — chưa ai đếm két thực tế',
          }, { id: shift.user_id });
        } catch (drawerError) {
          // Deploy cũ chưa có bảng két → không có ledger để chốt, đi tiếp.
          // Lỗi khác → ném ra cho transaction rollback, lần gọi sau thử lại
          if (drawerError.code !== 'ER_NO_SUCH_TABLE') throw drawerError;
        }

        const revenue = revenueByShift.get(shift.id) || 0;
        // check_out = NOW (không phải check_in): cửa sổ doanh thu của ca sau
        // sẽ bắt đầu SAU thời điểm này (getRevenueWindowStartTx cắt theo
        // check_out) — đặt check_out = check_in từng gây đếm trùng tiền với
        // ca đang mở. Giờ công vẫn = 0 theo luật nửa đêm.
        // actual/cash_difference = NULL: không ai đếm két thật — ghi "cân
        // bằng 0" sẽ che mất thiếu hụt nếu nhân viên cầm tiền bỏ đi.
        await db.execute(`
          UPDATE timesheets
          SET check_out = ?,
              regular_hours = 0,
              overtime_hours = 0,
              revenue_amount = ?,
              expected_revenue = ?,
              actual_cash_amount = NULL,
              cash_difference = NULL,
              note = CONCAT(COALESCE(note, ''), ' [Tự đóng: không check-out tại tiệm trước 12h đêm — 0h công, két chưa đếm]')
          WHERE id = ?
        `, [nowSql, revenue, revenue, shift.id]);
      });
    } catch (error) {
      console.warn(`Auto-close timesheet ${shift.id} failed (sẽ thử lại):`, error.message);
    }
  }
}

// Quét ĐỊNH KỲ toàn hệ thống: ca của nhân viên không bao giờ mở app lại
// (nghỉ việc, mất máy) nếu chỉ dọn theo-request sẽ treo mở vĩnh viễn và
// chặn cả cửa hàng (ca chính giả, EMPLOYEE_REQUIRED, doanh thu ca phụ = 0)
const AUTO_CLOSE_SWEEP_MS = 60 * 60 * 1000; // mỗi giờ
setTimeout(() => {
  autoCloseStaleShifts().catch((e) => console.warn('Stale shift sweep failed:', e.message));
  setInterval(() => {
    autoCloseStaleShifts().catch((e) => console.warn('Stale shift sweep failed:', e.message));
  }, AUTO_CLOSE_SWEEP_MS).unref?.();
}, 15 * 1000).unref?.();

router.get('/open-shifts', async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json({ data: [] });
    }
    let shifts = await query(`
      SELECT t.*,
        COALESCE(e.name, u.name) as employee_name
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE t.user_id = ? AND t.check_out IS NULL
      ORDER BY t.check_in ASC
    `, [req.user.id]);

    // Phát hiện ca quá hạn ngay trên kết quả vừa lấy (so ngày VN = UTC+7) —
    // tránh chạy thêm 1 query dọn dẹp trên MỌI lần gọi endpoint nóng này
    const todayVN = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const hasStale = (shifts || []).some((s) => {
      const ms = parseTimesheetDateTimeMsCompat(s.check_in);
      if (Number.isNaN(ms)) return false;
      return new Date(ms + 7 * 60 * 60 * 1000).toISOString().slice(0, 10) < todayVN;
    });
    if (hasStale) {
      await autoCloseStaleShifts(req.user.id);
      shifts = await query(`
        SELECT t.*,
          COALESCE(e.name, u.name) as employee_name
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        WHERE t.user_id = ? AND t.check_out IS NULL
        ORDER BY t.check_in ASC
      `, [req.user.id]);
    }

    res.json({ data: serializeTimesheets(shifts || []) });
  } catch (error) {
    console.error('Get open shifts error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

function normalizeCheckoutAtTime(input) {
  if (input === undefined || input === null || input === '') {
    return { ok: true, mysql: null };
  }
  let s = String(input).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const mysql = isoToMysqlUtc(s);
    if (!mysql) {
      return { ok: false, error: 'Định dạng giờ ra không hợp lệ.' };
    }
    return { ok: true, mysql };
  }
  s = s.replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s += ':00';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return { ok: false, error: 'Định dạng giờ ra không hợp lệ.' };
  }
  return { ok: true, mysql: formatDateTimeUTC(new Date(`${s.replace(' ', 'T')}Z`)) };
}

// Check in
router.post('/check-in', async (req, res) => {
  try {
    // Only employer can check in (not admin)
    if (req.user.role === 'admin') {
      return res.status(403).json({ error: 'Admin không thể check-in. Vui lòng sử dụng tài khoản nhân viên.' });
    }

    const { employee_id, note, opening_cash_amount } = req.body;
    
    // Get the actual store_id from users table (users.store_id references stores.id)
    // For employer, we need to get users.store_id, not users.id
    const user = await queryOne('SELECT store_id FROM users WHERE id = ? AND role = ?', [req.user.id, 'employer']);
    
    if (!user || !user.store_id) {
      return res.status(400).json({ error: 'Employer account không có cửa hàng được gán. Vui lòng liên hệ admin.' });
    }
    
    const storeId = user.store_id; // This is stores.id, not users.id

    // Dọn ca cũ quá hạn (qua nửa đêm chưa check-out) → 0h, trước khi mở ca mới
    await autoCloseStaleShifts(req.user.id);

    // GPS: phải đứng trong bán kính tiệm mới check-in được (nếu tiệm đã đặt tọa độ)
    const checkInGeoError = await verifyAtStore(storeId, req.body);
    if (checkInGeoError) {
      return res.status(403).json({ error: checkInGeoError, code: 'GEO_MISMATCH' });
    }

    // IP thiết bị lúc check-in — lưu để đối soát/audit
    const checkInIp = normalizeIp(getClientIp(req));

    // Tài khoản cá nhân (employee_login): LUÔN dùng employee_id trong token —
    // không cho check-in hộ người khác. Tài khoản cửa hàng dùng chung: body
    // employee_id được ưu tiên để check-in thêm đồng nghiệp vào ca.
    // Either way the employee is validated against the store below.
    let employeeId;
    if (req.user.employee_login) {
      employeeId = req.user.employee_id;
    } else {
      employeeId = employee_id || req.user.employee_id || null;
    }

    // Verify employee belongs to the same store
    // Note: employees.store_id references users.id (the employer user id)
    if (employeeId) {
      const employee = await queryOne('SELECT * FROM employees WHERE id = ? AND store_id = ? AND status = ?', [employeeId, req.user.id, 'active']);
      if (!employee) {
        return res.status(400).json({ error: 'Employee does not belong to your store' });
      }
    } else {
      // Checking in WITHOUT a name is only allowed for the first open shift.
      // Anyone joining an already-open shift must pick their own name so each
      // concurrent person gets their own timesheet slot.
      const anyOpen = await queryOne(
        'SELECT id FROM timesheets WHERE store_id = ? AND check_out IS NULL LIMIT 1',
        [storeId]
      );
      if (anyOpen) {
        return res.status(400).json({
          error: 'Đã có ca đang mở. Người check-in thêm phải chọn tên nhân viên của mình.',
          code: 'EMPLOYEE_REQUIRED',
        });
      }
    }

    const checkIn = formatDateTimeUTC(new Date());

    let openSameSlot;
    if (employeeId) {
      openSameSlot = await queryOne(`
        SELECT id, check_in FROM timesheets
        WHERE store_id = ? AND employee_id = ? AND check_out IS NULL
        LIMIT 1
      `, [storeId, employeeId]);
    } else {
      openSameSlot = await queryOne(`
        SELECT id, check_in FROM timesheets
        WHERE store_id = ? AND employee_id IS NULL AND check_out IS NULL
        LIMIT 1
      `, [storeId]);
    }
    if (openSameSlot) {
      const d = openSameSlot.check_in instanceof Date
        ? openSameSlot.check_in.toISOString().slice(0, 10)
        : String(openSameSlot.check_in || '').slice(0, 10);
      return res.status(400).json({
        error: employeeId
          ? `Nhân viên này còn ca chưa check-out (check-in ${d}). Vui lòng check-out ca đó trước, hoặc chọn nhân viên khác.`
          : `Còn ca chưa checkout (check-in ${d}). Vui lòng check-out ca này trước khi mở ca mới.`,
        code: 'OPEN_SHIFT_EXISTS',
        open_shift: { id: openSameSlot.id, check_in: openSameSlot.check_in },
      });
    }

    let timesheet;
    try {
      timesheet = await transaction(async (db) => {
      const result = await db.execute(`
        INSERT INTO timesheets (user_id, store_id, employee_id, check_in, check_in_ip, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [req.user.id, storeId, employeeId, checkIn, checkInIp || null, note || null]);

      const created = await db.queryOne(`
        SELECT t.*, 
          u.name as user_name, 
          e.name as employee_name
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        WHERE t.id = ?
      `, [result.insertId]);

      await ensureOpeningFloatTx(db, created, opening_cash_amount || 0, req.user);
      return db.queryOne(`
        SELECT t.*, 
          u.name as user_name, 
          e.name as employee_name
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        WHERE t.id = ?
      `, [result.insertId]);
      });
    } catch (error) {
      // Unique index uq_timesheets_open_slot_v2: 2 request check-in đồng thời
      // (2 thiết bị) cho cùng nhân viên — pre-check phía trên đều pass, request
      // chậm hơn fail ở INSERT thay vì tạo ca trùng (double giờ công)
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({
          error: 'Nhân viên này vừa được check-in — không thể mở 2 ca cùng lúc.',
          code: 'OPEN_SHIFT_EXISTS',
        });
      }
      throw error;
    }

    res.status(201).json({ data: serializeTimesheet(timesheet) });
  } catch (error) {
    console.error('Check in error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

router.get('/expected-revenue', async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json({ data: { expected_revenue: 0, order_count: 0, total_withdrawn: 0 } });
    }

    const timesheetIdParam = req.query.timesheet_id ? parseInt(req.query.timesheet_id, 10) : null;

    // Token nhân viên cá nhân chỉ được xem doanh thu/két dự kiến của CHÍNH ca
    // mình — thiếu điều kiện này thì truyền timesheet_id của đồng nghiệp sẽ
    // đọc được số tiền dự kiến + tóm tắt két của ca họ (cùng luật ownShiftFilter
    // đang áp cho check-out ngay bên dưới)
    const ownShiftFilter = req.user.employee_login ? ' AND employee_id = ?' : '';
    const ownShiftParams = req.user.employee_login ? [req.user.employee_id] : [];

    let timesheet;
    if (timesheetIdParam && !Number.isNaN(timesheetIdParam)) {
      timesheet = await queryOne(`
        SELECT * FROM timesheets
        WHERE id = ? AND user_id = ? AND check_out IS NULL${ownShiftFilter}
      `, [timesheetIdParam, req.user.id, ...ownShiftParams]);
    }
    if (!timesheet) {
      timesheet = await queryOne(`
        SELECT * FROM timesheets
        WHERE user_id = ? AND check_out IS NULL${ownShiftFilter}
        ORDER BY check_in ASC
        LIMIT 1
      `, [req.user.id, ...ownShiftParams]);
    }

    if (!timesheet) {
      return res.json({ data: { expected_revenue: 0, order_count: 0 } });
    }

    const normalizedCheckIn = formatDateTimeUTC(new Date(parseTimesheetDateTimeMsCompat(timesheet.check_in)));
    const revenueData = await getShiftPaymentSummaryDeduped({
      queryOne,
    }, timesheet, req.user.id, normalizedCheckIn, formatDateTimeUTC(new Date()));
    const drawerSummary = await getDrawerSummaryTx({
      queryOne,
      execute,
    }, timesheet.id);

    // Debug log removed for security

    res.json({ 
      data: { 
        expected_revenue: revenueData.revenue_amount,
        order_count: revenueData.order_count,
        total_withdrawn: revenueData.total_withdrawn,
        cash_drawer: drawerSummary
      } 
    });
  } catch (error) {
    console.error('Get expected revenue error:', error);
    res.status(500).json({ error: 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Check out
router.post('/check-out', async (req, res) => {
  try {
    // Only employer can check out (not admin)
    if (req.user.role === 'admin') {
      return res.status(403).json({ error: 'Admin không thể check-out. Vui lòng sử dụng tài khoản nhân viên.' });
    }

    const {
      note,
      revenue_amount,
      expected_revenue,
      withdrawn_amount: checkoutWithdrawn,
      timesheet_id,
      check_out_at,
      actual_cash_amount,
      cash_shortage_paid_amount,
    } = req.body;
    const userId = req.user.id;

    const actualCashInput = actual_cash_amount !== undefined && actual_cash_amount !== null && actual_cash_amount !== ''
      ? actual_cash_amount
      : revenue_amount;

    if (actualCashInput === undefined || actualCashInput === null || actualCashInput === '') {
      return res.status(400).json({ error: 'Số tiền mặt thực đếm là bắt buộc' });
    }
    
    const actualCashValue = parseFloat(actualCashInput);
    
    if (isNaN(actualCashValue) || actualCashValue < 0) {
      return res.status(400).json({ error: 'Số tiền mặt thực đếm phải là số hợp lệ' });
    }

    const tsId = timesheet_id !== undefined && timesheet_id !== null && timesheet_id !== ''
      ? parseInt(timesheet_id, 10)
      : null;

    // Áp luật nửa đêm NGAY TẠI check-out: ca quá hạn phải bị đóng 0h trước,
    // không thể gọi thẳng API này hôm sau để lách (backdate check_out_at)
    await autoCloseStaleShifts(userId);

    // Tài khoản cá nhân chỉ được đóng ca mang employee_id của chính mình
    const ownShiftFilter = req.user.employee_login ? ' AND employee_id = ?' : '';

    let timesheet;
    if (tsId && !Number.isNaN(tsId)) {
      const params = [tsId, userId];
      if (req.user.employee_login) params.push(req.user.employee_id);
      timesheet = await queryOne(`
        SELECT * FROM timesheets
        WHERE id = ? AND user_id = ? AND check_out IS NULL${ownShiftFilter}
      `, params);
      if (!timesheet) {
        // KHÔNG fallback sang ca mở cũ nhất khi client đã chỉ định timesheet_id:
        // double-submit sau khi ca B vừa đóng sẽ rơi xuống fallback và đóng nhầm
        // ca A của đồng nghiệp (ghi đè số két, giờ công của người khác)
        return res.status(req.user.employee_login ? 403 : 409).json({
          error: req.user.employee_login
            ? 'Không tìm thấy ca đang mở của bạn với mã này — bạn chỉ có thể check-out ca của chính mình.'
            : 'Ca này đã được check-out hoặc không tồn tại. Vui lòng tải lại danh sách ca.',
        });
      }
    }
    if (!timesheet) {
      const params = [userId];
      if (req.user.employee_login) params.push(req.user.employee_id);
      timesheet = await queryOne(`
        SELECT * FROM timesheets
        WHERE user_id = ? AND check_out IS NULL${ownShiftFilter}
        ORDER BY check_in ASC
        LIMIT 1
      `, params);
    }

    if (!timesheet) {
      return res.status(400).json({
        error: 'Không tìm thấy ca làm việc đang mở. Vui lòng check-in hoặc liên hệ quản trị viên.',
      });
    }

    // GPS: phải đứng trong bán kính tiệm mới check-out được — về nhà không
    // thể check-out; qua nửa đêm ca tự đóng 0h công
    const checkOutGeoError = await verifyAtStore(timesheet.store_id, req.body);
    if (checkOutGeoError) {
      return res.status(403).json({ error: checkOutGeoError, code: 'GEO_MISMATCH' });
    }

    const normOut = normalizeCheckoutAtTime(check_out_at);
    if (!normOut.ok) {
      return res.status(400).json({ error: normOut.error });
    }
    let checkOut = normOut.mysql;
    if (!checkOut) {
      checkOut = formatDateTimeUTC(new Date());
    }

    const checkInMs = parseTimesheetDateTimeMsCompat(timesheet.check_in);
    const checkOutMs = parseTimesheetDateTimeMs(checkOut);
    if (Number.isNaN(checkOutMs) || Number.isNaN(checkInMs) || checkOutMs < checkInMs) {
      return res.status(400).json({ error: 'Giờ ra phải sau giờ vào ca.' });
    }
    if (checkOutMs > Date.now()) {
      return res.status(400).json({ error: 'Giờ ra không được sau thời điểm hiện tại.' });
    }
    const shiftHours = (checkOutMs - checkInMs) / (1000 * 60 * 60);
    if (shiftHours > 16) {
      return res.status(400).json({
        error: 'Ca làm việc không được vượt quá 16 giờ. Nếu bạn quên check-out, hãy nhập "Giờ ra" là giờ ra thực tế của ca đó (trong vòng 16 giờ kể từ giờ vào ca) rồi bấm lại.',
      });
    }

    const normalizedCheckIn = formatDateTimeUTC(new Date(checkInMs));
    const { regular, overtime } = calculateHours(normalizedCheckIn, checkOut);

    const shortagePaidValue = cash_shortage_paid_amount !== undefined && cash_shortage_paid_amount !== null && cash_shortage_paid_amount !== ''
      ? parseFloat(cash_shortage_paid_amount)
      : 0;

    if (Number.isNaN(shortagePaidValue) || shortagePaidValue < 0) {
      return res.status(400).json({ error: 'Số tiền nhân viên bù phải là số hợp lệ' });
    }

    const withdrawnValue = (checkoutWithdrawn !== undefined && checkoutWithdrawn !== null && checkoutWithdrawn !== '')
      ? (parseFloat(checkoutWithdrawn) || null)
      : null;

    const { updated } = await transaction(async (db) => {
      const paymentSummary = await getShiftPaymentSummaryDeduped(
        db,
        timesheet,
        userId,
        normalizedCheckIn,
        checkOut
      );
      // Tiền rút lúc check-out vào sổ két như cash_out TRƯỚC khi chốt số —
      // để expected giảm tương ứng, không ghi oan "thiếu két" cho nhân viên
      if (withdrawnValue && withdrawnValue > 0) {
        try {
          await recordCheckoutWithdrawalTx(db, timesheet, withdrawnValue, req.user);
        } catch (drawerError) {
          if (drawerError.code !== 'ER_NO_SUCH_TABLE') throw drawerError;
        }
      }

      await recordClosingCountTx(db, timesheet, {
        actual_cash_amount: actualCashValue,
        cash_shortage_paid_amount: shortagePaidValue,
        note,
      }, req.user);

      // AND check_out IS NULL: chống race với auto-close (hoặc check-out
      // trùng từ tab khác) — nếu ca đã bị đóng giữa chừng, affectedRows = 0
      // → throw → transaction rollback kéo theo cả closing_count vừa ghi,
      // không bao giờ có 2 lần chốt két cho 1 ca
      const updateResult = await db.execute(`
        UPDATE timesheets
        SET check_out = ?,
            regular_hours = ?,
            overtime_hours = ?,
            revenue_amount = ?,
            expected_revenue = ?,
            withdrawn_amount = ?,
            note = COALESCE(?, note)
        WHERE id = ? AND check_out IS NULL
      `, [
        checkOut,
        regular,
        overtime,
        paymentSummary.revenue_amount,
        paymentSummary.revenue_amount,
        withdrawnValue,
        note || null,
        timesheet.id
      ]);

      if (updateResult.affectedRows === 0) {
        const updateError = new Error('Không thể cập nhật ca làm việc');
        updateError.statusCode = 400;
        throw updateError;
      }

      const updatedTimesheet = await db.queryOne(`
        SELECT t.*, 
          u.name as user_name,
          COALESCE(e.name, u.name) as employee_name,
          s.name as store_name
        FROM timesheets t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN employees e ON t.employee_id = e.id
        LEFT JOIN stores s ON t.store_id = s.id
        WHERE t.id = ?
      `, [timesheet.id]);

      return { updated: updatedTimesheet };
    });

    res.json({ data: serializeTimesheet(updated) });
  } catch (error) {
    console.error('Check out error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

// Get summary (Admin only)
router.get('/summary', authorize('admin'), async (req, res) => {
  try {
    // authorize('admin') cho phép cả root đi qua nhưng root không khớp nhánh
    // scope nào bên dưới (chỉ check role === 'admin') → chạy KHÔNG lọc, trả về
    // chấm công của TOÀN BỘ tenant
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xem báo cáo chấm công' });
    }
    const { user_id, month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year are required' });
    }

    const range = getMonthUtcRange(req, month, year);

    // Admin can see all stores if no store_id, or filter by store_id if provided
    let querySql = `
      SELECT 
        t.user_id,
        u.name as user_name,
        SUM(CASE WHEN t.auto_closed = 0 THEN 1 ELSE 0 END) as total_days,
        SUM(t.regular_hours) as total_regular_hours,
        SUM(t.overtime_hours) as total_overtime_hours,
        SUM(t.regular_hours + t.overtime_hours) as total_hours,
        SUM(t.revenue_amount) as total_revenue
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      WHERE t.check_in >= ? AND t.check_in < ?
        AND t.check_out IS NOT NULL
    `;
    const params = [range.startAt, range.endAt];

    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          querySql += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.store_id) {
      querySql += ' AND t.store_id = ?';
      params.push(req.user.store_id);
    }

    if (user_id) {
      querySql += ' AND t.user_id = ?';
      params.push(user_id);
    }

    querySql += ' GROUP BY t.user_id, u.name';

    const summary = await query(querySql, params);
    summary.forEach(s => {
      s.total_regular_hours = Number(s.total_regular_hours) || 0;
      s.total_overtime_hours = Number(s.total_overtime_hours) || 0;
      s.total_hours = Number(s.total_hours) || 0;
      s.total_revenue = Number(s.total_revenue) || 0;
    });
    res.json({ data: summary });
  } catch (error) {
    console.error('Get timesheet summary error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue by shift (Admin only)
router.get('/revenue-by-shift', authorize('admin'), async (req, res) => {
  try {
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xem báo cáo doanh thu theo ca' });
    }
    const { month, year, user_id } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year are required' });
    }

    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const range = getMonthUtcRange(req, month, year);

    // Admin can see all stores if no store_id, or filter by store_id if provided
    let querySql = `
      SELECT 
        t.id,
        t.user_id,
        u.name as user_name,
        ${timesheetDateExpr} as shift_date,
        TIME(t.check_in) as check_in_time,
        TIME(t.check_out) as check_out_time,
        t.regular_hours,
        t.overtime_hours,
        t.revenue_amount,
        t.note
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      WHERE t.check_in >= ? AND t.check_in < ?
        AND t.check_out IS NOT NULL
        AND t.revenue_amount > 0
    `;
    const params = [range.startAt, range.endAt];

    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          querySql += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.store_id) {
      querySql += ' AND t.store_id = ?';
      params.push(req.user.store_id);
    }

    if (user_id) {
      querySql += ' AND t.user_id = ?';
      params.push(user_id);
    }

    querySql += ' ORDER BY t.check_in DESC';

    const shifts = await query(querySql, params);
    res.json({ data: shifts });
  } catch (error) {
    console.error('Get revenue by shift error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/payroll', authorize('admin'), async (req, res) => {
  try {
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xem bảng lương' });
    }
    const { period, week, month, year, user_id } = req.query;

    if (!period || !['week', 'month'].includes(period)) {
      return res.status(400).json({ error: 'Period must be "week" or "month"' });
    }

    let startDate, endDate, range;
    if (period === 'week') {
      if (!week || !year) {
        return res.status(400).json({ error: 'Week and year are required for weekly payroll' });
      }
      // Calculate week start and end dates (ISO week)
      const simple = new Date(year, 0, 1 + (week - 1) * 7);
      const dow = simple.getDay();
      const ISOweekStart = simple;
      if (dow <= 4) {
        ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
      } else {
        ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());
      }
      startDate = new Date(ISOweekStart);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
      // Format theo local parts — toISOString() đổi sang UTC nên trên server
      // múi VN (UTC+7) mọi mốc local 00:00 bị lùi thành NGÀY HÔM TRƯỚC,
      // dịch cả tuần lương sớm 1 ngày
      const fmtLocalDate = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      startDate = fmtLocalDate(startDate);
      endDate = fmtLocalDate(endDate);
      const startAt = req.query.start_at ? isoToMysqlUtc(req.query.start_at) : null;
      const endAt = req.query.end_at ? isoToMysqlUtc(req.query.end_at) : null;
      range = startAt && endAt ? { startAt, endAt } : null;
    } else {
      if (!month || !year) {
        return res.status(400).json({ error: 'Month and year are required for monthly payroll' });
      }
      startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
      range = getMonthUtcRange(req, month, year);
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    let querySql = `
      SELECT
        COALESCE(t.employee_id, t.user_id) as employee_id,
        COALESCE(e.name, u.name) as employee_name,
        MAX(t.employee_id) as real_employee_id,
        COALESCE(e.hourly_rate, u.hourly_rate) as hourly_rate,
        SUM(CASE WHEN t.auto_closed = 0 THEN 1 ELSE 0 END) as total_shifts,
        SUM(t.regular_hours) as total_regular_hours,
        SUM(t.overtime_hours) as total_overtime_hours,
        SUM(t.regular_hours + t.overtime_hours) as total_hours,
        SUM(t.revenue_amount) as total_revenue
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE t.check_in >= ? AND t.check_in < ?
        AND t.check_out IS NOT NULL
    `;
    // Biên cuối cho so sánh DATETIME với '<': nếu chỉ có ngày (period=week
    // không kèm start_at/end_at) thì phải +1 ngày, nếu không cả NGÀY CUỐI
    // của kỳ bị loại khỏi giờ công & hoa hồng
    const nextDayStr = (dateStr) => {
      const d = new Date(`${dateStr}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const periodStart = range?.startAt || startDate;
    const periodEnd = range?.endAt || nextDayStr(endDate);

    const params = [periodStart, periodEnd];

    const storeIdParam = req.query.store_id;
    // Store đã xác thực thuộc chuỗi — dùng để scope cả thưởng/phạt & hoa hồng
    // bên dưới (không scope thì payroll lọc 1 cửa hàng vẫn cộng tiền cả chuỗi)
    let scopedStoreId = null;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          scopedStoreId = storeIdParam;
          querySql += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      querySql += ' AND t.store_id = ?';
      params.push(req.user.store_id);
    }

    if (user_id) {
      querySql += ' AND t.user_id = ?';
      params.push(user_id);
    }

    querySql += ' GROUP BY COALESCE(t.employee_id, t.user_id), COALESCE(e.name, u.name), COALESCE(e.hourly_rate, u.hourly_rate) ORDER BY COALESCE(e.name, u.name)';

    const timesheets = await query(querySql, params);

    // Calculate salary for each employee — chỉ tính theo GIỜ:
    // giờ thường × lương giờ + giờ tăng ca × lương giờ × hệ số
    const payroll = timesheets.map((ts) => {
      let salary = 0;

      if (ts.hourly_rate) {
        salary = (ts.total_regular_hours || 0) * ts.hourly_rate;
        // Overtime multiplier (configurable via OVERTIME_MULTIPLIER constant)
        salary += (ts.total_overtime_hours || 0) * ts.hourly_rate * OVERTIME_MULTIPLIER;
      }

      return {
        user_id: ts.employee_id,
        employee_id: ts.employee_id,
        // is_employee: hàng có employee_id thật (employees.id). Hàng legacy
        // (ca không chọn tên) có key là users.id — TUYỆT ĐỐI không merge
        // thưởng/hoa hồng vào các hàng này (users.id có thể trùng số với
        // employees.id của người khác, thậm chí ở chuỗi khác).
        is_employee: ts.real_employee_id != null,
        user_name: ts.employee_name,
        employee_name: ts.employee_name,
        hourly_rate: ts.hourly_rate || 0,
        // Number(): these are SUMs of DECIMAL columns (strings from mysql2);
        // leaving them as strings makes the reduce() totals below concatenate
        total_shifts: Number(ts.total_shifts) || 0,
        total_regular_hours: Number(ts.total_regular_hours) || 0,
        total_overtime_hours: Number(ts.total_overtime_hours) || 0,
        total_hours: Number(ts.total_hours) || 0,
        total_revenue: Number(ts.total_revenue) || 0,
        salary: Math.round(salary * 100) / 100,
        total_adjustments: 0,
        total_commission: 0,
      };
    });

    // Map các hàng nhân viên thật để merge thưởng/hoa hồng đúng người
    const employeeRowMap = new Map(payroll.filter(p => p.is_employee).map(p => [p.employee_id, p]));
    // Nhân viên có thưởng/hoa hồng nhưng KHÔNG có ca trong kỳ vẫn phải hiện
    // trong bảng lương (nếu không khoản thưởng "biến mất" khỏi tổng chi trả)
    const extraRows = new Map();
    const getOrCreateRow = (employeeId, employeeName) => {
      const existing = employeeRowMap.get(employeeId);
      if (existing) return existing;
      if (!extraRows.has(employeeId)) {
        extraRows.set(employeeId, {
          user_id: employeeId,
          employee_id: employeeId,
          is_employee: true,
          user_name: employeeName,
          employee_name: employeeName,
          hourly_rate: 0,
          total_shifts: 0,
          total_regular_hours: 0,
          total_overtime_hours: 0,
          total_hours: 0,
          total_revenue: 0,
          salary: 0,
          total_adjustments: 0,
          total_commission: 0,
        });
      }
      return extraRows.get(employeeId);
    };

    // Thưởng/phạt + hoa hồng trong kỳ — scope theo chuỗi, và theo cửa hàng
    // nếu đang lọc. Hai aggregate độc lập → chạy song song (Promise.all);
    // .catch: bảng/cột chưa migrate — coi như 0
    let adjSql = `
      SELECT a.employee_id, e.name AS employee_name, SUM(a.amount) AS total_adjustments
      FROM salary_adjustments a
      JOIN employees e ON a.employee_id = e.id
      JOIN users u ON e.store_id = u.id
      JOIN stores s ON u.store_id = s.id
      WHERE s.admin_id = ? AND a.adjust_date >= ? AND a.adjust_date <= ?
    `;
    const adjParams = [req.user.id, startDate, endDate];
    if (scopedStoreId) {
      adjSql += ' AND s.id = ?';
      adjParams.push(scopedStoreId);
    }
    adjSql += ' GROUP BY a.employee_id, e.name';

    let commSql = `
      SELECT o.employee_id, e.name AS employee_name,
        COALESCE(SUM(oi.quantity * oi.unit_price * (p.commission_percent / 100)), 0) AS commission
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      JOIN employees e ON o.employee_id = e.id
      WHERE o.employee_id IS NOT NULL
        AND o.status = 'completed'
        AND o.created_at >= ? AND o.created_at < ?
        AND p.commission_percent > 0
        AND o.store_id IN (SELECT id FROM stores WHERE admin_id = ?)
    `;
    const commParams = [periodStart, periodEnd, req.user.id];
    if (scopedStoreId) {
      commSql += ' AND o.store_id = ?';
      commParams.push(scopedStoreId);
    }
    commSql += ' GROUP BY o.employee_id, e.name';

    // Chỉ nuốt lỗi thiếu bảng/cột (DB chưa migrate). Lỗi thật (deadlock, timeout)
    // phải ném ra — trả [] im lặng làm payroll 200 OK với hoa hồng/thưởng phạt = 0
    // và admin trả lương thiếu mà không có tín hiệu lỗi nào
    const swallowMissingSchema = (fallback) => (error) => {
      if (error?.code === 'ER_NO_SUCH_TABLE' || error?.code === 'ER_BAD_FIELD_ERROR') return fallback;
      throw error;
    };
    const [adjRows, commissionRows] = await Promise.all([
      query(adjSql, adjParams).catch(swallowMissingSchema([])),
      query(commSql, commParams).catch(swallowMissingSchema([])),
    ]);

    for (const r of adjRows) {
      const row = getOrCreateRow(r.employee_id, r.employee_name);
      row.total_adjustments = Math.round((Number.parseFloat(r.total_adjustments) || 0) * 100) / 100;
    }
    for (const r of commissionRows) {
      const row = getOrCreateRow(r.employee_id, r.employee_name);
      row.total_commission = Math.round((Number.parseFloat(r.commission) || 0) * 100) / 100;
    }

    payroll.push(...extraRows.values());
    payroll.sort((a, b) => String(a.employee_name || '').localeCompare(String(b.employee_name || ''), 'vi'));
    payroll.forEach(p => {
      p.final_salary = Math.round((p.salary + (p.total_commission || 0) + (p.total_adjustments || 0)) * 100) / 100;
    });

    res.json({
      data: payroll,
      period,
      start_date: startDate,
      end_date: endDate,
      total_salary: payroll.reduce((sum, p) => sum + p.salary, 0),
      total_hours: payroll.reduce((sum, p) => sum + p.total_hours, 0),
    });
  } catch (error) {
    console.error('Get payroll error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get daily hours for each employee in a month (Admin only)
router.get('/daily-hours', authorize('admin'), async (req, res) => {
  try {
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xem bảng chấm công theo ngày' });
    }
    const { month, year, user_id } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: 'Month and year are required' });
    }

    // Admin can see all stores if no store_id, or filter by store_id if provided
    const monthStr = String(month).padStart(2, '0');
    const timezoneOffset = getTimezoneOffsetMinutes(req);
    const timesheetDateExpr = localDateSql('t.check_in', timezoneOffset);
    const range = getMonthUtcRange(req, month, year);
    const lastDay = new Date(year, month, 0).getDate();

    // Get all timesheets for the month
    let querySql = `
      SELECT
        t.employee_id as real_employee_id,
        t.user_id as shift_user_id,
        COALESCE(e.name, u.name) as employee_name,
        ${timesheetDateExpr} as work_date,
        t.regular_hours,
        t.overtime_hours,
        (t.regular_hours + t.overtime_hours) as total_hours
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE t.check_in >= ? AND t.check_in < ?
        AND t.check_out IS NOT NULL
    `;
    const params = [range.startAt, range.endAt];
    
    const storeIdParam = req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          querySql += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        querySql += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      querySql += ' AND t.store_id = ?';
      params.push(req.user.store_id);
    }

    if (user_id) {
      querySql += ' AND t.user_id = ?';
      params.push(user_id);
    }

    querySql += ' ORDER BY COALESCE(e.name, u.name), t.check_in';

    const timesheets = await query(querySql, params);

    // Group by employee and date
    const employeeMap = {};

    // Seed TẤT CẢ nhân viên active của chuỗi (kể cả người chưa có ca nào) để
    // bảng lưới luôn hiển thị đủ cột nhân viên, ngày chưa làm = 0
    try {
      let empSql = `
        SELECT e.id, e.name
        FROM employees e
        JOIN users u ON e.store_id = u.id
        JOIN stores s ON u.store_id = s.id
        WHERE e.status = 'active'
      `;
      const empParams = [];
      if (req.user.role === 'admin') {
        empSql += ' AND s.admin_id = ?';
        empParams.push(req.user.id);
        if (storeIdParam && storeIdParam !== 'all') {
          empSql += ' AND s.id = ?';
          empParams.push(storeIdParam);
        }
      } else if (req.user.role === 'employer') {
        empSql += ' AND u.id = ?';
        empParams.push(req.user.id);
      }
      const activeEmployees = await query(empSql, empParams);
      activeEmployees.forEach((emp) => {
        employeeMap[emp.id] = {
          user_id: emp.id,
          employee_id: emp.id,
          user_name: emp.name,
          employee_name: emp.name,
          daily_hours: {},
        };
      });
    } catch (error) {
      // Nếu lỗi (bảng chưa sẵn sàng) — vẫn build từ timesheets như cũ
    }

    timesheets.forEach((ts) => {
      // employees.id và users.id là 2 dãy số ĐỘC LẬP (đều auto-increment từ 1).
      // Ca vô danh (employee_id NULL) phải có key riêng 'u<user_id>' — nếu dùng
      // thẳng user_id, giờ công của ca tài khoản cộng nhầm vào nhân viên trùng số id
      const empId = ts.real_employee_id != null ? ts.real_employee_id : `u${ts.shift_user_id}`;
      if (!employeeMap[empId]) {
        employeeMap[empId] = {
          user_id: empId,
          employee_id: empId,
          user_name: ts.employee_name,
          employee_name: ts.employee_name,
          daily_hours: {},
        };
      }
      
      // mysql2 trả cột DATE về dạng Date object (pool không bật dateStrings) —
      // dùng thẳng làm key sẽ thành "Sun Aug 24 2026 ..." và không bao giờ khớp
      // key "YYYY-MM-DD" ở bước build lưới bên dưới → cả bảng hiện 0 giờ
      const dateKey = ts.work_date instanceof Date
        ? ts.work_date.toISOString().slice(0, 10)
        : String(ts.work_date).slice(0, 10);
      if (!employeeMap[empId].daily_hours[dateKey]) {
        employeeMap[empId].daily_hours[dateKey] = 0;
      }
      
      // Sum hours if multiple shifts in the same day.
      // Number(): total_hours comes from SUM of DECIMAL columns, which mysql2
      // returns as a STRING — without coercion this concatenates ("8.5"+"7"→"08.57")
      // and later crashes the UI's .toFixed() call.
      employeeMap[empId].daily_hours[dateKey] += Number(ts.total_hours) || 0;
    });

    // Convert to array format with all days of the month
    const result = Object.values(employeeMap).map((emp) => {
      const dailyHours = {};
      
      // Initialize all days with 0
      for (let day = 1; day <= lastDay; day++) {
        const dateKey = `${year}-${monthStr}-${String(day).padStart(2, '0')}`;
        dailyHours[dateKey] = emp.daily_hours[dateKey] || 0;
      }
      
      return {
        user_id: emp.user_id,
        employee_id: emp.employee_id,
        user_name: emp.employee_name,
        employee_name: emp.employee_name,
        daily_hours: dailyHours,
        total_month_hours: Object.values(dailyHours).reduce((sum, hours) => sum + Number(hours), 0),
      };
    });

    // Tổng thưởng/phạt trong tháng cho từng nhân viên (để hiện ở khối tổng
    // kết cuối bảng). adjust_date là DATE nên so theo khoảng ngày local.
    result.forEach((emp) => { emp.total_adjustments = 0; });
    try {
      const adjMonthStart = `${year}-${monthStr}-01`;
      const adjNextMonth = Number(month) === 12
        ? `${Number(year) + 1}-01-01`
        : `${year}-${String(Number(month) + 1).padStart(2, '0')}-01`;
      const adjRows = await query(`
        SELECT a.employee_id, SUM(a.amount) AS total_adjustments
        FROM salary_adjustments a
        JOIN employees e ON a.employee_id = e.id
        JOIN users u ON e.store_id = u.id
        JOIN stores s ON u.store_id = s.id
        WHERE s.admin_id = ? AND a.adjust_date >= ? AND a.adjust_date < ?
        GROUP BY a.employee_id
      `, [req.user.id, adjMonthStart, adjNextMonth]);
      const adjMap = new Map(adjRows.map(r => [r.employee_id, Number.parseFloat(r.total_adjustments) || 0]));
      result.forEach((emp) => {
        emp.total_adjustments = Math.round((adjMap.get(emp.employee_id) || 0) * 100) / 100;
      });
    } catch (error) {
      // Bảng salary_adjustments chưa tồn tại (chưa migrate) — coi như 0
    }

    result.sort((a, b) => String(a.employee_name || '').localeCompare(String(b.employee_name || ''), 'vi'));

    res.json({
      data: result,
      month: parseInt(month),
      year: parseInt(year),
      days_in_month: lastDay,
    });
  } catch (error) {
    console.error('Get daily hours error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Export timesheets to Excel
router.get('/export', async (req, res) => {
  try {
    // Root là vendor phần mềm — không có nhánh scope nào khớp bên dưới nên
    // export trước đây chạy KHÔNG lọc gì, xuất Excel chấm công của TOÀN HỆ THỐNG
    if (req.user.role === 'root') {
      return res.status(403).json({ error: 'Root admin không thể xuất báo cáo chấm công' });
    }
    const { user_id, date, month, year, start_date, end_date, start_at, end_at, store_id } = req.query;
    const timezoneOffsetMinutes = Number.parseInt(req.query.timezone_offset_minutes ?? '0', 10);
    const exportOffset = Number.isNaN(timezoneOffsetMinutes) ? 0 : timezoneOffsetMinutes;
    
    let sqlQuery = `
      SELECT 
        t.id,
        u.name as user_name,
        COALESCE(e.name, u.name) as employee_name,
        t.check_in,
        t.check_out,
        t.regular_hours,
        t.overtime_hours,
        t.revenue_amount,
        t.expected_revenue,
        t.note,
        s.name as store_name
      FROM timesheets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN stores s ON t.store_id = s.id
      WHERE 1=1
    `;
    const params = [];

    const storeIdParam = store_id || req.query.store_id;
    if (req.user.role === 'admin') {
      if (storeIdParam && storeIdParam !== 'all') {
        const store = await queryOne('SELECT 1 FROM stores WHERE id = ? AND admin_id = ?', [storeIdParam, req.user.id]);
        if (store) {
          sqlQuery += ' AND t.store_id = ?';
          params.push(storeIdParam);
        } else {
          sqlQuery += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
          params.push(req.user.id);
        }
      } else {
        sqlQuery += ' AND t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)';
        params.push(req.user.id);
      }
    } else if (req.user.role === 'employer') {
      sqlQuery += ' AND t.user_id = ?';
      params.push(req.user.id);
    }

    if (start_at && end_at) {
      const startAt = isoToMysqlUtc(start_at);
      const endAt = isoToMysqlUtc(end_at);
      if (!startAt || !endAt) {
        return res.status(400).json({ error: 'Invalid date range' });
      }
      sqlQuery += ' AND t.check_in >= ? AND t.check_in < ?';
      params.push(startAt, endAt);
    } else if (date) {
      sqlQuery += ' AND DATE(t.check_in) = ?';
      params.push(date);
    }

    if (start_date && end_date) {
      sqlQuery += ' AND DATE(t.check_in) >= ? AND DATE(t.check_in) <= ?';
      params.push(start_date, end_date);
    }

    if (month && year) {
      const monthStr = String(month).padStart(2, '0');
      sqlQuery += ` AND DATE_FORMAT(t.check_in, '%m') = ? AND DATE_FORMAT(t.check_in, '%Y') = ?`;
      params.push(monthStr, year);
    }

    sqlQuery += ' ORDER BY t.check_in DESC';

    const timesheets = await query(sqlQuery, params);

    // Format data for Excel
    const data = timesheets.map(t => ({
      'ID': t.id,
      'Tên nhân viên': t.employee_name || t.user_name,
      'Ngày': formatWithTimezoneOffset(t.check_in, exportOffset, 'date'),
      'Giờ vào': formatWithTimezoneOffset(t.check_in, exportOffset, 'time'),
      'Giờ ra': t.check_out ? formatWithTimezoneOffset(t.check_out, exportOffset, 'time') : '',
      'Giờ thường': t.regular_hours || 0,
      'Giờ tăng ca': t.overtime_hours || 0,
      'Doanh thu': t.revenue_amount || 0,
      'Doanh thu dự kiến': t.expected_revenue || 0,
      'Ghi chú': t.note || '',
      'Cửa hàng': t.store_name || ''
    }));

    // Create workbook and worksheet
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(data);
    
    // Set column widths
    const colWidths = [
      { wch: 8 },
      { wch: 20 },
      { wch: 12 },
      { wch: 10 },
      { wch: 10 },
      { wch: 12 },
      { wch: 12 },
      { wch: 15 },
      { wch: 18 },
      { wch: 30 },
      { wch: 20 }
    ];
    worksheet['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Chấm công');

    // Generate filename
    let fileName = 'ChamCong';
    if (date) {
      fileName += `_${date}`;
    } else if (month && year) {
      fileName += `_${month}_${year}`;
    } else if (start_date && end_date) {
      fileName += `_${start_date}_${end_date}`;
    } else {
      fileName += `_${new Date().toISOString().slice(0, 10)}`;
    }
    fileName += '.xlsx';

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Set headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

    res.send(buffer);
  } catch (error) {
    console.error('Export timesheets error:', error);
    res.status(500).json({ error: 'Lỗi khi export chấm công' });
  }
});

export default router;
