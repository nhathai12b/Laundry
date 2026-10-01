import { query, queryOne } from '../database/db.js';
import { formatDateTimeUTC } from '../utils/helpers.js';

const VIETNAM_OFFSET_MINUTES = 7 * 60;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseReportDate(value) {
  if (!value) {
    const vietnamNow = new Date(Date.now() + VIETNAM_OFFSET_MINUTES * 60 * 1000);
    return {
      year: vietnamNow.getUTCFullYear(),
      month: vietnamNow.getUTCMonth() + 1,
      day: vietnamNow.getUTCDate(),
    };
  }

  if (!DATE_PATTERN.test(value)) return null;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function getVietnamDayUtcRange(localDate) {
  const startUtcMs = Date.UTC(localDate.year, localDate.month - 1, localDate.day) -
    VIETNAM_OFFSET_MINUTES * 60 * 1000;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

  return {
    startAt: formatDateTimeUTC(new Date(startUtcMs)),
    endAt: formatDateTimeUTC(new Date(endUtcMs)),
  };
}

function displayDate(localDate) {
  return `${pad2(localDate.day)}/${pad2(localDate.month)}/${localDate.year}`;
}

function isoDate(localDate) {
  return `${localDate.year}-${pad2(localDate.month)}-${pad2(localDate.day)}`;
}

function toNumber(value) {
  return Number.parseFloat(value || 0) || 0;
}

function storeFilter(alias, storeId, adminId) {
  if (storeId) return ` AND ${alias}.store_id = ?`;
  if (adminId) return ` AND ${alias}.store_id IN (SELECT id FROM stores WHERE admin_id = ?)`;
  return '';
}

function paymentStoreFilter(storeId, adminId) {
  if (storeId) return ' AND COALESCE(p.store_id, o.store_id) = ?';
  if (adminId) return ' AND COALESCE(p.store_id, o.store_id) IN (SELECT id FROM stores WHERE admin_id = ?)';
  return '';
}

function appendScopeParam(params, storeId, adminId) {
  if (storeId) params.push(storeId);
  else if (adminId) params.push(adminId);
}

async function getStoreName(storeId, adminId) {
  if (!storeId && adminId) {
    const admin = await queryOne('SELECT name FROM users WHERE id = ?', [adminId]);
    return admin?.name ? `Chuỗi ${admin.name}` : `Chuỗi admin #${adminId}`;
  }
  if (!storeId) return 'Tất cả cửa hàng';
  const store = await queryOne('SELECT name FROM stores WHERE id = ?', [storeId]);
  return store?.name || `Cửa hàng #${storeId}`;
}

async function getRevenueSummary(startAt, endAt, storeId, adminId) {
  const params = [startAt, endAt];
  appendScopeParam(params, storeId, adminId);

  const row = await queryOne(`
    SELECT
      COALESCE(SUM(p.amount), 0) AS total_revenue,
      COALESCE(SUM(CASE WHEN p.payment_method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash_revenue,
      COALESCE(SUM(CASE WHEN p.payment_method = 'transfer' THEN p.amount ELSE 0 END), 0) AS transfer_revenue
    FROM order_payments p
    LEFT JOIN orders o ON p.order_id = o.id
    WHERE p.payment_method IN ('cash', 'transfer')
      AND p.paid_at >= ?
      AND p.paid_at < ?
      ${paymentStoreFilter(storeId, adminId)}
  `, params);

  return {
    total_revenue: toNumber(row?.total_revenue),
    cash_revenue: toNumber(row?.cash_revenue),
    transfer_revenue: toNumber(row?.transfer_revenue),
  };
}

async function getOrderSummary(startAt, endAt, storeId, adminId) {
  const params = [startAt, endAt];
  appendScopeParam(params, storeId, adminId);

  const row = await queryOne(`
    SELECT
      COUNT(*) AS created_orders,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_orders,
      COALESCE(SUM(CASE WHEN status = 'waiting_pickup' THEN 1 ELSE 0 END), 0) AS waiting_pickup_orders,
      COALESCE(SUM(CASE WHEN status IN ('washing', 'drying') THEN 1 ELSE 0 END), 0) AS processing_orders,
      COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_orders
    FROM orders o
    WHERE o.created_at >= ?
      AND o.created_at < ?
      ${storeFilter('o', storeId, adminId)}
  `, params);

  return {
    created_orders: Number(row?.created_orders || 0),
    completed_orders: Number(row?.completed_orders || 0),
    waiting_pickup_orders: Number(row?.waiting_pickup_orders || 0),
    processing_orders: Number(row?.processing_orders || 0),
    cancelled_orders: Number(row?.cancelled_orders || 0),
  };
}

async function getDebtSummary(startAt, endAt, storeId, adminId) {
  const debtParams = [startAt, endAt];
  appendScopeParam(debtParams, storeId, adminId);

  const debtCreated = await queryOne(`
    SELECT COALESCE(SUM(o.debt_amount), 0) AS new_debt_amount
    FROM orders o
    WHERE COALESCE(o.delivered_at, o.updated_at, o.created_at) >= ?
      AND COALESCE(o.delivered_at, o.updated_at, o.created_at) < ?
      AND COALESCE(o.debt_amount, 0) > 0
      ${storeFilter('o', storeId, adminId)}
  `, debtParams);

  const collectedParams = [startAt, endAt];
  appendScopeParam(collectedParams, storeId, adminId);

  const collected = await queryOne(`
    SELECT COALESCE(SUM(p.amount), 0) AS debt_collected_amount
    FROM order_payments p
    LEFT JOIN orders o ON p.order_id = o.id
    WHERE p.payment_type = 'debt_payment'
      AND p.paid_at >= ?
      AND p.paid_at < ?
      ${paymentStoreFilter(storeId, adminId)}
  `, collectedParams);

  const outstandingParams = [];
  appendScopeParam(outstandingParams, storeId, adminId);

  const outstanding = await queryOne(`
    SELECT COALESCE(SUM(o.debt_amount), 0) AS outstanding_debt_amount
    FROM orders o
    WHERE COALESCE(o.debt_amount, 0) > 0
      AND o.status = 'completed'
      ${storeFilter('o', storeId, adminId)}
  `, outstandingParams);

  return {
    new_debt_amount: toNumber(debtCreated?.new_debt_amount),
    debt_collected_amount: toNumber(collected?.debt_collected_amount),
    outstanding_debt_amount: toNumber(outstanding?.outstanding_debt_amount),
  };
}

async function getCashDrawerSummary(startAt, endAt, storeId, adminId) {
  const params = [startAt, endAt];
  appendScopeParam(params, storeId, adminId);

  // Mỗi ca kèm "ca nhận bàn giao đã được đếm két chưa" (qua related_timesheet_id)
  const rows = await query(`
    SELECT t.id, t.check_out, t.expected_cash_amount, t.actual_cash_amount,
      t.cash_difference, t.cash_shortage_paid_amount,
      -- NULL khi: không bàn giao cho ai, HOẶC ca nhận chưa được đếm két
      (SELECT r.actual_cash_amount
         FROM cash_drawer_transactions h
         JOIN timesheets r ON h.timesheet_id = r.id
        WHERE h.related_timesheet_id = t.id AND h.type = 'opening_float'
        LIMIT 1) AS receiver_actual
    FROM timesheets t
    WHERE t.check_in >= ?
      AND t.check_in < ?
      ${storeFilter('t', storeId, adminId)}
  `, params);

  // Định nghĩa (bất biến: expected − actual = −(cash_difference) − bù thiếu của ca đã chuyển két):
  // - actual: tiền ĐẾM ĐƯỢC ở các két CUỐI (két không chuyển tiếp cho ai đã đếm).
  //   Ca A bàn giao cho B mà B đã chốt → tiền của A nằm trong số đếm của B,
  //   KHÔNG cộng A lần nữa (tránh 530k + 560k = 1.090k ảo). B chưa đếm (đang
  //   mở / quên check-out) → giữ số của A, nếu không tiền đó biến mất khỏi báo cáo.
  // - expected: tiền LẼ RA có trong các két cuối nếu không ai thiếu/thừa — két
  //   nhận chỉ biết số A đếm (+ tiền bù), nên cộng bù phần A thiếu chưa bù.
  // - cash_difference: tổng thiếu/thừa của TỪNG người khi đếm (không bỏ ai).
  // - Ca đã đóng nhưng không ai đếm (tự đóng) → unreconciled, không vào tổng.
  let expected = 0;
  let actual = 0;
  let difference = 0;
  let reimbursed = 0;
  let unreconciled = 0;
  let open = 0;
  for (const r of rows) {
    if (r.check_out === null) { open += 1; continue; }
    if (r.actual_cash_amount === null) { unreconciled += 1; continue; }
    const diff = toNumber(r.cash_difference);
    const paid = toNumber(r.cash_shortage_paid_amount);
    difference += diff;
    reimbursed += paid;
    const passedOnToCountedDrawer = r.receiver_actual !== null;
    if (passedOnToCountedDrawer) {
      expected -= diff + paid;
    } else {
      expected += toNumber(r.expected_cash_amount);
      actual += toNumber(r.actual_cash_amount);
    }
  }

  const round = (n) => Math.round(n * 100) / 100;
  return {
    expected_cash_amount: round(expected),
    actual_cash_amount: round(actual),
    cash_difference: round(difference),
    shortage_reimbursed: round(reimbursed),
    unreconciled_shifts: unreconciled,
    open_shifts: open,
  };
}

export async function buildDailyBusinessReport({ date, storeId, adminId }) {
  const localDate = parseReportDate(date);
  if (!localDate) {
    const error = new Error('Invalid date. Expected YYYY-MM-DD.');
    error.statusCode = 400;
    throw error;
  }

  const { startAt, endAt } = getVietnamDayUtcRange(localDate);
  const [
    storeName,
    revenue,
    orders,
    debt,
    cashDrawer,
  ] = await Promise.all([
    getStoreName(storeId, adminId),
    getRevenueSummary(startAt, endAt, storeId, adminId),
    getOrderSummary(startAt, endAt, storeId, adminId),
    getDebtSummary(startAt, endAt, storeId, adminId),
    getCashDrawerSummary(startAt, endAt, storeId, adminId),
  ]);

  return {
    date: isoDate(localDate),
    display_date: displayDate(localDate),
    timezone: 'Asia/Ho_Chi_Minh',
    range_utc: {
      start_at: startAt,
      end_at: endAt,
    },
    admin_id: adminId || null,
    store_id: storeId || null,
    store_name: storeName,
    revenue,
    orders,
    debt,
    cash_drawer: cashDrawer,
  };
}

export async function getActiveStoresByAdmin(adminId) {
  return query(`
    SELECT id, name
    FROM stores
    WHERE admin_id = ?
      AND status = 'active'
    ORDER BY name ASC
  `, [adminId]);
}
