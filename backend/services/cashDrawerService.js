import { query, queryOne, transaction } from '../database/db.js';
import { formatDateTimeUTC } from '../utils/helpers.js';
import { resolveCurrentStoreId } from './workingStoreService.js';

const IN_TYPES = new Set(['opening_float', 'cash_payment', 'cash_in', 'shortage_reimbursement']);
const OUT_TYPES = new Set(['cash_out']);
const NEUTRAL_TYPES = new Set(['closing_count']);

// cash_drawer_transactions.amount là DECIMAL(10,2) — vượt mức này MySQL trả
// lỗi "Out of range value" thô (500) thay vì thông báo validate rõ ràng (400)
const MAX_CASH_DRAWER_AMOUNT = 99999999.99;

function normalizeAmount(amount, fieldName = 'amount', allowZero = false) {
  const value = Number.parseFloat(amount);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value <= 0) || value > MAX_CASH_DRAWER_AMOUNT) {
    const error = new Error(`${fieldName} must be ${allowZero ? 'zero or greater' : 'greater than zero'} and at most ${MAX_CASH_DRAWER_AMOUNT}`);
    error.statusCode = 400;
    throw error;
  }
  return Math.round(value * 100) / 100;
}

function directionForType(type) {
  if (IN_TYPES.has(type)) return 'in';
  if (OUT_TYPES.has(type)) return 'out';
  if (NEUTRAL_TYPES.has(type)) return 'neutral';
  const error = new Error('Invalid cash drawer transaction type');
  error.statusCode = 400;
  throw error;
}

async function insertCashDrawerTransactionTx(db, payload) {
  const amount = normalizeAmount(payload.amount, 'amount', payload.allowZero === true);
  const type = payload.type;
  const direction = directionForType(type);
  const occurredAt = payload.occurred_at
    ? formatDateTimeUTC(new Date(payload.occurred_at))
    : formatDateTimeUTC();

  const result = await db.execute(`
    INSERT INTO cash_drawer_transactions (
      store_id, timesheet_id, user_id, employee_id, order_id, order_payment_id,
      type, direction, amount, reason, occurred_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    payload.store_id || null,
    payload.timesheet_id,
    payload.user_id || null,
    payload.employee_id || null,
    payload.order_id || null,
    payload.order_payment_id || null,
    type,
    direction,
    amount,
    payload.reason || null,
    occurredAt,
  ]);

  return {
    id: result.insertId,
    type,
    direction,
    amount,
    occurred_at: occurredAt,
  };
}

async function getTimesheetForActorTx(db, timesheetId, actor, requireOpen = true, lock = false) {
  const conditions = ['t.id = ?'];
  const params = [timesheetId];

  if (actor?.role === 'employer') {
    conditions.push('t.user_id = ?');
    params.push(actor.id);
    // Token nhân viên cá nhân (employee_login) chỉ được thao tác trên ĐÚNG ca
    // của mình — thiếu điều kiện này thì 2 nhân viên dùng chung 1 tài khoản
    // tiệm (2 ca mở song song) có thể đọc/ghi két của nhau (cash-in/cash-out/
    // xem số dư) bằng cách truyền timesheet_id của đồng nghiệp. Cùng luật với
    // ownShiftFilter ở timesheets.js check-out.
    if (actor.employee_login) {
      conditions.push('t.employee_id = ?');
      params.push(actor.employee_id);
    }
  } else if (actor?.role === 'admin') {
    conditions.push('t.store_id IN (SELECT id FROM stores WHERE admin_id = ?)');
    params.push(actor.id);
  } else {
    // role khác employer/admin (root, hoặc actor rỗng) — không nhánh nào ở
    // trên khớp thì query chỉ còn `WHERE t.id = ?`, cho phép đọc/ghi ca của
    // BẤT KỲ tenant nào. cashDrawer.js chỉ có `authenticate`, không có
    // authorize(), nên route này reachable bởi root.
    conditions.push('1 = 0');
  }

  if (requireOpen) {
    conditions.push('t.check_out IS NULL');
  }

  // lock=true (cash-in/cash-out): khoá row ca làm ngay trong transaction để
  // 2 request ghi két gần như đồng thời (double-click, client tự retry) cho
  // CÙNG ca không đọc cùng số dư "trước" rồi cùng ghi đè — request sau phải
  // đợi request trước COMMIT mới đọc được số dư đã cập nhật.
  const timesheet = await db.queryOne(`
    SELECT t.*, u.name AS user_name, COALESCE(e.name, u.name) AS employee_name, s.name AS store_name
    FROM timesheets t
    JOIN users u ON t.user_id = u.id
    LEFT JOIN employees e ON t.employee_id = e.id
    LEFT JOIN stores s ON t.store_id = s.id
    WHERE ${conditions.join(' AND ')}
    LIMIT 1${lock ? ' FOR UPDATE' : ''}
  `, params);

  if (!timesheet) {
    const error = new Error('Timesheet not found');
    error.statusCode = 404;
    throw error;
  }

  return timesheet;
}

// KHÔNG chặn "giao dịch giống hệt trong 5s" cho cash-in/cash-out: 2 khoản chi
// cùng số tiền, cùng lý do liên tiếp là nghiệp vụ hợp lệ (server.js cũng cố ý
// miễn 2 route này khỏi duplicateRequestGuard vì lý do đó). Double-click đã
// được chặn ở FE (nút disabled + api.js gộp request đang chạy); khoá FOR UPDATE
// ở getTimesheetForActorTx(lock=true) chỉ để 2 request đồng thời ghi tuần tự.

export async function ensureOpeningFloatTx(db, timesheet, amount, actor) {
  const openingAmount = normalizeAmount(amount || 0, 'opening_cash_amount', true);

  if (openingAmount > 0) {
    await insertCashDrawerTransactionTx(db, {
      type: 'opening_float',
      amount: openingAmount,
      store_id: timesheet.store_id,
      timesheet_id: timesheet.id,
      user_id: actor?.id || timesheet.user_id,
      employee_id: timesheet.employee_id,
      reason: 'Opening cash float',
    });
  }

  await db.execute(
    'UPDATE timesheets SET opening_cash_amount = ? WHERE id = ?',
    [openingAmount, timesheet.id]
  );

  return openingAmount;
}

export async function recordCashPaymentTx(db, { order, paymentId, amount, timesheet, actor }) {
  if (!timesheet?.id) return null;

  // Fallback cuối: cửa hàng của tài khoản (một nguồn duy nhất: resolveCurrentStoreId)
  const storeId = order.store_id || timesheet.store_id || await resolveCurrentStoreId(actor);

  return insertCashDrawerTransactionTx(db, {
    type: 'cash_payment',
    amount,
    store_id: storeId,
    timesheet_id: timesheet.id,
    user_id: actor?.id || null,
    employee_id: timesheet.employee_id || null,
    order_id: order.id,
    order_payment_id: paymentId,
    reason: `Cash payment for order ${order.code || order.id}`,
  });
}

export async function recordCashIn(timesheetId, payload, actor) {
  return transaction(async (db) => {
    const timesheet = await getTimesheetForActorTx(db, timesheetId, actor, true, true);
    const reason = payload.reason || 'Cash added to drawer';
    const record = await insertCashDrawerTransactionTx(db, {
      type: 'cash_in',
      amount: payload.amount,
      store_id: timesheet.store_id,
      timesheet_id: timesheet.id,
      user_id: actor?.id || null,
      employee_id: timesheet.employee_id,
      reason,
    });
    return { record, summary: await getDrawerSummaryTx(db, timesheet.id) };
  });
}

export async function recordCashOut(timesheetId, payload, actor) {
  if (!String(payload.reason || '').trim()) {
    const error = new Error('Reason is required for cash out');
    error.statusCode = 400;
    throw error;
  }

  return transaction(async (db) => {
    const timesheet = await getTimesheetForActorTx(db, timesheetId, actor, true, true);
    const record = await insertCashDrawerTransactionTx(db, {
      type: 'cash_out',
      amount: payload.amount,
      store_id: timesheet.store_id,
      timesheet_id: timesheet.id,
      user_id: actor?.id || null,
      employee_id: timesheet.employee_id,
      reason: payload.reason,
    });
    return { record, summary: await getDrawerSummaryTx(db, timesheet.id) };
  });
}

// Tiền rút khỏi két lúc check-out — ghi thành cash_out TRONG transaction đóng ca
// để expected_cash giảm tương ứng TRƯỚC khi tính chênh lệch. Không có bút toán
// này, nhân viên rút 200k hợp lệ sẽ bị ghi "thiếu két 200k" (expected không đổi
// nhưng số đếm thực tế đã bớt 200k).
export async function recordCheckoutWithdrawalTx(db, timesheet, amount, actor) {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return insertCashDrawerTransactionTx(db, {
    type: 'cash_out',
    amount,
    store_id: timesheet.store_id,
    timesheet_id: timesheet.id,
    user_id: actor?.id || null,
    employee_id: timesheet.employee_id || null,
    reason: 'Rút tiền khi check-out',
  });
}

// Bàn giao két khi người giữ két (ca mở cũ nhất của tiệm) check-out mà còn
// người khác đang đứng ca: số tiền mặt vừa đếm được chuyển sang két của ca
// nhận. Ghi bằng type 'opening_float' trên ca nhận (không thêm type mới vì
// cột type là ENUM — đổi ENUM cần migration ALTER TABLE trên DB đang chạy) —
// về nghiệp vụ cũng đúng: két của người nhận bắt đầu bằng số tiền được giao.
// Ca giao KHÔNG ghi thêm dòng nào: closing_count của họ đã chốt số này rồi;
// nếu ghi thêm cash_out sẽ làm "chênh lệch két" của người giao bị sai.
export async function recordDrawerHandoverTx(db, fromTimesheet, toTimesheet, amount, actor) {
  const value = normalizeAmount(amount, 'handover_amount', false);
  const record = await insertCashDrawerTransactionTx(db, {
    type: 'opening_float',
    amount: value,
    store_id: toTimesheet.store_id,
    timesheet_id: toTimesheet.id,
    user_id: actor?.id || null,
    employee_id: toTimesheet.employee_id || null,
    reason: `Nhận bàn giao két từ ca #${fromTimesheet.id}${fromTimesheet.employee_name ? ` (${fromTimesheet.employee_name})` : ''}`,
  });
  await db.execute(
    'UPDATE timesheets SET opening_cash_amount = opening_cash_amount + ? WHERE id = ?',
    [value, toTimesheet.id]
  );
  return record;
}

export async function recordClosingCountTx(db, timesheet, payload, actor) {
  const summary = await getDrawerSummaryTx(db, timesheet.id);
  // actual_cash_amount = null/undefined → chốt theo số kỳ vọng (chênh lệch 0).
  // Dùng cho auto-close ca quá hạn: không ai đếm két nên lấy expected làm actual.
  // max(expected, 0): expected có thể ÂM (cash_out vượt quỹ) — normalizeAmount
  // sẽ throw với số âm và ca kẹt mở vĩnh viễn nếu không kẹp về 0.
  const actualAmount = (payload.actual_cash_amount === null || payload.actual_cash_amount === undefined)
    ? Math.max(summary.expected_cash_amount, 0)
    : normalizeAmount(payload.actual_cash_amount, 'actual_cash_amount', true);
  const expectedAmount = summary.expected_cash_amount;
  // Khi actual được mặc định theo expected (auto-close): chênh lệch luôn 0 —
  // nếu tính actual(kẹp 0) − expected(âm) sẽ ra "thừa két" ảo dương
  const cashDifference = (payload.actual_cash_amount === null || payload.actual_cash_amount === undefined)
    ? 0
    : Math.round((actualAmount - expectedAmount) * 100) / 100;
  const shortagePaidAmount = normalizeAmount(payload.cash_shortage_paid_amount || 0, 'cash_shortage_paid_amount', true);

  if (shortagePaidAmount > 0) {
    await insertCashDrawerTransactionTx(db, {
      type: 'shortage_reimbursement',
      amount: shortagePaidAmount,
      store_id: timesheet.store_id,
      timesheet_id: timesheet.id,
      user_id: actor?.id || null,
      employee_id: timesheet.employee_id,
      reason: 'Cash shortage reimbursement',
    });
  }

  await insertCashDrawerTransactionTx(db, {
    type: 'closing_count',
    amount: actualAmount,
    allowZero: true,
    store_id: timesheet.store_id,
    timesheet_id: timesheet.id,
    user_id: actor?.id || null,
    employee_id: timesheet.employee_id,
    reason: payload.note || 'Closing cash count',
  });

  await db.execute(`
    UPDATE timesheets
    SET expected_cash_amount = ?,
        actual_cash_amount = ?,
        cash_difference = ?,
        cash_shortage_paid_amount = ?
    WHERE id = ?
  `, [
    expectedAmount,
    actualAmount,
    cashDifference,
    shortagePaidAmount,
    timesheet.id,
  ]);

  return {
    ...summary,
    actual_cash_amount: actualAmount,
    cash_difference: cashDifference,
    cash_shortage_paid_amount: shortagePaidAmount,
  };
}

export async function getDrawerSummaryTx(db, timesheetId) {
  const summary = await db.queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'opening_float' THEN amount ELSE 0 END), 0) AS opening_cash_amount,
      COALESCE(SUM(CASE WHEN type = 'cash_payment' THEN amount ELSE 0 END), 0) AS cash_payment_amount,
      COALESCE(SUM(CASE WHEN type = 'cash_in' THEN amount ELSE 0 END), 0) AS cash_in_amount,
      COALESCE(SUM(CASE WHEN type = 'cash_out' THEN amount ELSE 0 END), 0) AS cash_out_amount,
      COALESCE(SUM(CASE WHEN type = 'shortage_reimbursement' THEN amount ELSE 0 END), 0) AS shortage_reimbursement_amount
    FROM cash_drawer_transactions
    WHERE timesheet_id = ?
  `, [timesheetId]);

  const opening = Number.parseFloat(summary?.opening_cash_amount || 0);
  const cashPayments = Number.parseFloat(summary?.cash_payment_amount || 0);
  const cashIn = Number.parseFloat(summary?.cash_in_amount || 0);
  const cashOut = Number.parseFloat(summary?.cash_out_amount || 0);
  const shortageReimbursement = Number.parseFloat(summary?.shortage_reimbursement_amount || 0);

  return {
    opening_cash_amount: opening,
    cash_payment_amount: cashPayments,
    cash_in_amount: cashIn,
    cash_out_amount: cashOut,
    shortage_reimbursement_amount: shortageReimbursement,
    expected_cash_amount: Math.round((opening + cashPayments + cashIn - cashOut) * 100) / 100,
  };
}

export async function getDrawerSummary(timesheetId) {
  return transaction(async (db) => getDrawerSummaryTx(db, timesheetId));
}

export async function getDrawerDetails(timesheetId, actor, requireOpen = false) {
  return transaction(async (db) => {
    const timesheet = await getTimesheetForActorTx(db, timesheetId, actor, requireOpen);
    const summary = await getDrawerSummaryTx(db, timesheet.id);
    const transactions = await db.query(`
      SELECT *
      FROM cash_drawer_transactions
      WHERE timesheet_id = ?
      ORDER BY occurred_at ASC, id ASC
    `, [timesheet.id]);

    return { timesheet, summary, transactions };
  });
}

export async function getCurrentDrawer(actor) {
  if (!actor?.id) return null;

  // Token nhân viên cá nhân: phải lấy ĐÚNG ca của mình, không phải ca mở cũ
  // nhất của tiệm — nếu không, 2 nhân viên cùng đứng ca sẽ thấy "két hiện tại"
  // của người kia (getTimesheetForActorTx bên dưới cũng chặn theo employee_id,
  // nhưng nếu bước chọn id ở đây chọn nhầm ca thì luôn 404 "Timesheet not found"
  // thay vì hiện đúng két của họ)
  const ownShiftFilter = actor.employee_login ? ' AND employee_id = ?' : '';
  const ownShiftParams = actor.employee_login ? [actor.employee_id] : [];
  const timesheet = await queryOne(`
    SELECT id
    FROM timesheets
    WHERE user_id = ? AND check_out IS NULL${ownShiftFilter}
    ORDER BY check_in ASC
    LIMIT 1
  `, [actor.id, ...ownShiftParams]);

  if (!timesheet) return null;
  return getDrawerDetails(timesheet.id, actor, true);
}

export async function getDrawerTransactions(timesheetId) {
  return query(`
    SELECT *
    FROM cash_drawer_transactions
    WHERE timesheet_id = ?
    ORDER BY occurred_at ASC, id ASC
  `, [timesheetId]);
}
