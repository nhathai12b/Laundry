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

  // Chỉ cộng expected của ca ĐÃ ĐẾM két (actual IS NOT NULL) — ca tự đóng lúc
  // nửa đêm (quên check-out) có actual/cash_difference NULL: nếu vẫn cộng
  // expected thì "dự kiến > thực đếm" trong khi "chênh lệch = 0", nhìn như
  // thiếu tiền. Trả thêm số ca chưa đối soát / đang mở để báo cáo nói rõ.
  const row = await queryOne(`
    SELECT
      COALESCE(SUM(CASE WHEN t.actual_cash_amount IS NOT NULL THEN t.expected_cash_amount ELSE 0 END), 0) AS expected_cash_amount,
      COALESCE(SUM(t.actual_cash_amount), 0) AS actual_cash_amount,
      COALESCE(SUM(t.cash_difference), 0) AS cash_difference,
      COALESCE(SUM(CASE WHEN t.check_out IS NOT NULL AND t.actual_cash_amount IS NULL THEN 1 ELSE 0 END), 0) AS unreconciled_shifts,
      COALESCE(SUM(CASE WHEN t.check_out IS NULL THEN 1 ELSE 0 END), 0) AS open_shifts
    FROM timesheets t
    WHERE t.check_in >= ?
      AND t.check_in < ?
      ${storeFilter('t', storeId, adminId)}
  `, params);

  return {
    expected_cash_amount: toNumber(row?.expected_cash_amount),
    actual_cash_amount: toNumber(row?.actual_cash_amount),
    cash_difference: toNumber(row?.cash_difference),
    unreconciled_shifts: Number(row?.unreconciled_shifts || 0),
    open_shifts: Number(row?.open_shifts || 0),
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
