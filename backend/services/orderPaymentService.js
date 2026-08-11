import { queryOne, transaction } from '../database/db.js';
import { formatDateTimeUTC } from '../utils/helpers.js';
import { recordCashPaymentTx } from './cashDrawerService.js';

const PAYMENT_METHODS = ['cash', 'transfer'];
const PAYMENT_TYPES = ['order_payment', 'debt_payment'];

function normalizeAmount(amount) {
  const value = Number.parseFloat(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Payment amount must be greater than zero');
  }
  return Math.round(value * 100) / 100;
}

function paymentStatusFor(finalAmount, paidAmount, markDebtIfUnpaid = false) {
  const remaining = Math.max(finalAmount - paidAmount, 0);
  if (remaining <= 0.009) return 'paid';
  if (paidAmount > 0) return 'partial';
  return markDebtIfUnpaid ? 'debt' : 'unpaid';
}

async function findOpenTimesheet(db, actor, storeId) {
  if (!actor?.id) return null;

  const params = [actor.id];
  let sql = `
    SELECT id, employee_id, store_id
    FROM timesheets
    WHERE user_id = ?
      AND check_out IS NULL
  `;

  if (storeId) {
    sql += ' AND (store_id = ? OR store_id IS NULL)';
    params.push(storeId);
  }

  sql += ' ORDER BY check_in DESC LIMIT 1';
  return db.queryOne(sql, params);
}

async function updateOrderPaymentState(db, order, paidAmount, actor, markDebtIfUnpaid = false) {
  const finalAmount = Number.parseFloat(order.final_amount || order.total_amount || 0) || 0;
  const normalizedPaid = Math.min(Math.round(paidAmount * 100) / 100, finalAmount);
  const debtAmount = Math.max(Math.round((finalAmount - normalizedPaid) * 100) / 100, 0);
  const paymentStatus = paymentStatusFor(finalAmount, normalizedPaid, markDebtIfUnpaid);
  const isDebt = order.status === 'completed' && debtAmount > 0.009 ? 1 : 0;

  await db.execute(`
    UPDATE orders
    SET paid_amount = ?,
        debt_amount = ?,
        payment_status = ?,
        is_debt = ?,
        debt_paid_at = ?,
        updated_by = ?
    WHERE id = ?
  `, [
    normalizedPaid,
    debtAmount,
    paymentStatus,
    isDebt,
    debtAmount <= 0.009 && finalAmount > 0 ? formatDateTimeUTC() : null,
    actor?.id || null,
    order.id,
  ]);

  return {
    paid_amount: normalizedPaid,
    debt_amount: debtAmount,
    payment_status: paymentStatus,
  };
}

export async function recordOrderPaymentTx(db, orderId, payload, actor) {
  const amount = normalizeAmount(payload.amount);
  const paymentMethod = payload.payment_method;
  const paymentType = payload.payment_type || 'order_payment';

  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new Error('Payment method must be cash or transfer');
  }
  if (!PAYMENT_TYPES.includes(paymentType)) {
    throw new Error('Payment type is invalid');
  }

  const order = await db.queryOne('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }

  const finalAmount = Number.parseFloat(order.final_amount || order.total_amount || 0) || 0;
  const existing = await db.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS paid_amount
    FROM order_payments
    WHERE order_id = ?
  `, [orderId]);
  const paidSoFar = Number.parseFloat(existing?.paid_amount || 0) || 0;
  const remaining = Math.max(finalAmount - paidSoFar, 0);

  if (amount - remaining > 0.009) {
    const error = new Error('Payment amount exceeds remaining order balance');
    error.statusCode = 400;
    throw error;
  }

  const storeId = order.store_id || actor?.store_id || null;
  const openTimesheet = await findOpenTimesheet(db, actor, storeId);
  const paidAt = payload.paid_at ? formatDateTimeUTC(new Date(payload.paid_at)) : formatDateTimeUTC();

  const result = await db.execute(`
    INSERT INTO order_payments (
      order_id, store_id, user_id, employee_id, timesheet_id,
      amount, payment_method, payment_type, paid_at, note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    order.id,
    storeId,
    actor?.id || null,
    openTimesheet?.employee_id || null,
    openTimesheet?.id || null,
    amount,
    paymentMethod,
    paymentType,
    paidAt,
    payload.note || null,
  ]);

  const state = await updateOrderPaymentState(db, order, paidSoFar + amount, actor, true);

  if (paymentMethod === 'cash' && openTimesheet?.id) {
    await recordCashPaymentTx(db, {
      order,
      paymentId: result.insertId,
      amount,
      timesheet: openTimesheet,
      actor,
    });
  }

  await db.execute(
    'UPDATE orders SET payment_method = ? WHERE id = ?',
    [paymentMethod, order.id]
  );

  return {
    payment_id: result.insertId,
    order_id: order.id,
    amount,
    payment_method: paymentMethod,
    payment_type: paymentType,
    paid_at: paidAt,
    ...state,
  };
}

export async function recordOrderPayment(orderId, payload, actor) {
  return transaction((db) => recordOrderPaymentTx(db, orderId, payload, actor));
}

export async function syncOrderPaymentStateTx(db, orderId, actor, options = {}) {
  const order = await db.queryOne('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
  if (!order) {
    const error = new Error('Order not found');
    error.statusCode = 404;
    throw error;
  }

  const existing = await db.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS paid_amount
    FROM order_payments
    WHERE order_id = ?
  `, [orderId]);

  return updateOrderPaymentState(
    db,
    order,
    Number.parseFloat(existing?.paid_amount || 0) || 0,
    actor,
    Boolean(options.markDebtIfUnpaid)
  );
}

export async function syncOrderPaymentState(orderId, actor, options = {}) {
  return transaction((db) => syncOrderPaymentStateTx(db, orderId, actor, options));
}

export async function getOrderPaymentBalance(orderId) {
  const order = await queryOne(`
    SELECT final_amount, total_amount, paid_amount, debt_amount, payment_status
    FROM orders
    WHERE id = ?
  `, [orderId]);

  if (!order) return null;

  const finalAmount = Number.parseFloat(order.final_amount || order.total_amount || 0) || 0;
  const paidAmount = Number.parseFloat(order.paid_amount || 0) || 0;

  return {
    final_amount: finalAmount,
    paid_amount: paidAmount,
    debt_amount: Math.max(finalAmount - paidAmount, 0),
    payment_status: order.payment_status,
  };
}
