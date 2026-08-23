import { ThreadType } from 'zca-js';
import { query, queryOne, execute } from '../database/db.js';
import { formatDateTimeUTC } from '../utils/helpers.js';
import { normalizeVietnamesePhone } from '../utils/phoneNormalizer.js';
import { getReadyZaloApi } from './zaloSessionService.js';

const EVENT_TYPES = {
  ORDER_CREATED: 'order_created',
  READY_FOR_PICKUP: 'ready_for_pickup',
  DELIVERED: 'delivered',
  DEBT_PAYMENT_REMINDER: 'debt_payment_reminder',
};

const PAYMENT_METHOD_LABELS = {
  cash: 'Tiền mặt',
  transfer: 'Chuyển khoản',
};

const DELIVERY_METHOD_LABELS = {
  pickup: 'Khách nhận tại shop',
  customer_ship: 'Khách book ship',
  shop_delivery: 'Shop giao hàng',
};

async function getCachedMapping(storeId, phone) {
  return queryOne(`
    SELECT phone, zalo_user_id, display_name
    FROM zalo_phone_mappings
    WHERE store_id = ? AND phone = ?
    LIMIT 1
  `, [storeId, phone]);
}

async function saveMapping(storeId, phone, resolved) {
  await execute(`
    INSERT INTO zalo_phone_mappings (store_id, phone, zalo_user_id, display_name, last_resolved_at)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      zalo_user_id = VALUES(zalo_user_id),
      display_name = VALUES(display_name),
      last_resolved_at = VALUES(last_resolved_at)
  `, [
    storeId,
    phone,
    resolved.zaloUserId,
    resolved.displayName || '',
    formatDateTimeUTC(),
  ]);
}

async function resolveZaloUser(api, storeId, phone) {
  const cached = await getCachedMapping(storeId, phone);
  if (cached) {
    return {
      zaloUserId: cached.zalo_user_id,
      displayName: cached.display_name,
      cached: true,
    };
  }

  let result;
  try {
    result = await api.findUser(phone);
  } catch (error) {
    throw new Error(`Zalo account not found for phone ${phone}`);
  }

  if (!result?.uid) {
    throw new Error(`Zalo account not found for phone ${phone}`);
  }

  const resolved = {
    zaloUserId: result.uid,
    displayName: result.display_name || result.zalo_name || '',
    cached: false,
  };

  await saveMapping(storeId, phone, resolved);
  return resolved;
}

export async function sendZaloMessageByPhone({ storeId, phone, message }) {
  const normalizedPhone = normalizeVietnamesePhone(phone);
  if (!normalizedPhone) {
    throw new Error('Customer phone number is invalid for Zalo delivery');
  }

  if (!message || !String(message).trim()) {
    throw new Error('Zalo message content must not be empty');
  }

  const api = await getReadyZaloApi(storeId);
  const resolved = await resolveZaloUser(api, storeId, normalizedPhone);
  await api.sendMessage(String(message), resolved.zaloUserId, ThreadType.User);

  return {
    phone: normalizedPhone,
    zaloUserId: resolved.zaloUserId,
    displayName: resolved.displayName,
    cached: resolved.cached,
    sentAt: new Date().toISOString(),
  };
}

function formatMoney(value) {
  return `${Number.parseFloat(value || 0).toLocaleString('vi-VN')} đ`;
}

function formatVnDateTime(value) {
  if (!value) return 'chưa cập nhật';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'chưa cập nhật';

  const parts = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('hour')}:${get('minute')} - ${get('day')}/${get('month')}/${get('year')}`;
}

function last3Phone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-3) || '***';
}

async function getOrderNotificationData(orderId) {
  const order = await queryOne(`
    SELECT o.*,
      c.name AS customer_name,
      c.phone AS customer_phone,
      s.name AS store_name
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    LEFT JOIN stores s ON o.store_id = s.id
    WHERE o.id = ?
  `, [orderId]);

  if (!order) return null;

  const items = await query(`
    SELECT oi.quantity, p.name AS product_name, p.unit AS product_unit
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
    ORDER BY oi.id
  `, [orderId]);

  return {
    ...order,
    service_list: items.length
      ? items.map((item) => `${item.product_name || 'Dịch vụ'} x${item.quantity} ${item.product_unit || ''}`.trim()).join(', ')
      : 'Dịch vụ giặt ủi',
  };
}

function buildMessage(order, eventType) {
  const customerName = order.customer_name || 'quý khách';
  const code = order.code || `#${order.id}`;

  if (eventType === EVENT_TYPES.ORDER_CREATED) {
    return [
      `Chào anh/chị ${customerName} ***${last3Phone(order.customer_phone)},`,
      `XWASH đã ghi nhận đơn hàng ${code}.`,
      `Dịch vụ: ${order.service_list}.`,
      `Thời gian hẹn trả: ${formatVnDateTime(order.expected_return_at)}.`,
      'Cảm ơn anh/chị đã sử dụng dịch vụ.',
    ].join('\n');
  }

  if (eventType === EVENT_TYPES.READY_FOR_PICKUP) {
    return [
      `Đơn hàng ${code} của anh/chị đã được xử lý xong.`,
      'Anh/chị có thể đến nhận đồ trong khung giờ 07:00-22:00.',
      'Nếu cần nhận ngoài giờ, vui lòng liên hệ shop để được hỗ trợ.',
      'Đơn hàng được lưu tối đa 30 ngày. Sau 30 ngày shop không chịu trách nhiệm.',
      `Tổng giá trị đơn hàng: ${formatMoney(order.final_amount || order.total_amount)}.`,
      'Cảm ơn anh/chị.',
    ].join('\n');
  }

  if (eventType === EVENT_TYPES.DELIVERED) {
    return [
      `Chào anh/chị ${customerName} ***${last3Phone(order.customer_phone)},`,
      `Đơn hàng ${code} đã được giao thành công lúc ${formatVnDateTime(order.delivered_at || order.updated_at)}.`,
      `Dịch vụ: ${order.service_list}.`,
      `Hình thức thanh toán: ${PAYMENT_METHOD_LABELS[order.payment_method] || 'Chưa thanh toán'}.`,
      `Hình thức giao hàng: ${DELIVERY_METHOD_LABELS[order.delivery_method] || 'Khách nhận tại shop'}.`,
      'Nếu có vấn đề, vui lòng phản hồi trong vòng 48 giờ.',
      'Sau 48 giờ shop không chịu trách nhiệm.',
    ].join('\n');
  }

  if (eventType === EVENT_TYPES.DEBT_PAYMENT_REMINDER) {
    return 'Anh/Chị khi thanh toán vui lòng gửi shop ảnh chuyển khoản thành công. Xin cảm ơn.';
  }

  throw new Error(`Unsupported Zalo notification event: ${eventType}`);
}

async function logOrderNotification({ order, eventType, message, status, error = null }) {
  await execute(`
    INSERT INTO order_notifications (
      order_id, store_id, channel, provider, event_type,
      recipient_phone, message, status, error, sent_at
    )
    VALUES (?, ?, 'zalo', 'zalo', ?, ?, ?, ?, ?, ?)
  `, [
    order.id,
    order.store_id || null,
    eventType,
    order.customer_phone || null,
    message,
    status,
    error ? String(error.message || error).slice(0, 2000) : null,
    status === 'sent' ? formatDateTimeUTC() : null,
  ]);
}

async function sendOrderEvent(orderId, eventType) {
  let order = null;
  let message = '';

  try {
    order = await getOrderNotificationData(orderId);
    if (!order) return;

    message = buildMessage(order, eventType);

    if (!order.store_id) {
      throw new Error('Order does not have a store_id');
    }

    await sendZaloMessageByPhone({
      storeId: order.store_id,
      phone: order.customer_phone,
      message,
    });

    await logOrderNotification({ order, eventType, message, status: 'sent' });
  } catch (error) {
    console.error(`Send Zalo notification failed (${eventType}):`, error.message);

    if (order) {
      try {
        await logOrderNotification({ order, eventType, message, status: 'failed', error });
      } catch (logError) {
        console.error('Failed to log Zalo notification error:', logError.message);
      }
    }
  }
}

export function sendOrderCreatedNotification(orderId) {
  return sendOrderEvent(orderId, EVENT_TYPES.ORDER_CREATED);
}

export function sendReadyForPickupNotification(orderId) {
  return sendOrderEvent(orderId, EVENT_TYPES.READY_FOR_PICKUP);
}

export function sendDeliveredNotification(orderId) {
  return sendOrderEvent(orderId, EVENT_TYPES.DELIVERED);
}

export function sendDebtReminderNotification(orderId) {
  return sendOrderEvent(orderId, EVENT_TYPES.DEBT_PAYMENT_REMINDER);
}

export function sendOrderCompletedZaloNotification(orderId) {
  return sendDeliveredNotification(orderId);
}
