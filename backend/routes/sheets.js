import express from 'express';
import { queryOne } from '../database/db.js';
import { authenticateSheetExportKey } from '../middleware/sheetExportAuth.js';

const router = express.Router();
const VIETNAM_OFFSET_MINUTES = 7 * 60;
const MYSQL_DATE_TIME_LENGTH = 19;

router.use(authenticateSheetExportKey);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatMysqlUtc(date) {
  return date.toISOString().slice(0, MYSQL_DATE_TIME_LENGTH).replace('T', ' ');
}

function formatIsoDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function formatDisplayDate(year, month, day) {
  return `${pad2(day)}/${pad2(month)}/${year}`;
}

function parseLocalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

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

function getYesterdayInVietnam() {
  const now = new Date();
  const vietnamNow = new Date(now.getTime() + VIETNAM_OFFSET_MINUTES * 60 * 1000);
  vietnamNow.setUTCDate(vietnamNow.getUTCDate() - 1);

  return {
    year: vietnamNow.getUTCFullYear(),
    month: vietnamNow.getUTCMonth() + 1,
    day: vietnamNow.getUTCDate()
  };
}

function getVietnamDayUtcRange(localDate) {
  const startUtcMs = Date.UTC(localDate.year, localDate.month - 1, localDate.day) -
    VIETNAM_OFFSET_MINUTES * 60 * 1000;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

  return {
    startAt: formatMysqlUtc(new Date(startUtcMs)),
    endAt: formatMysqlUtc(new Date(endUtcMs))
  };
}

function parseStoreId(value) {
  if (value === undefined || value === null || value === '') return null;

  const storeId = Number.parseInt(value, 10);
  if (!Number.isInteger(storeId) || storeId <= 0 || String(storeId) !== String(value)) {
    return undefined;
  }

  return storeId;
}

function toNumber(value) {
  return Number(value || 0);
}

router.get('/daily-revenue', async (req, res) => {
  try {
    const localDate = req.query.date
      ? parseLocalDate(req.query.date)
      : getYesterdayInVietnam();

    if (!localDate) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date. Expected YYYY-MM-DD.'
      });
    }

    const storeId = parseStoreId(req.query.store_id);
    if (storeId === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Invalid store_id.'
      });
    }

    const { startAt, endAt } = getVietnamDayUtcRange(localDate);
    const params = [startAt, endAt];
    let storeFilter = '';

    if (storeId) {
      storeFilter = ' AND COALESCE(p.store_id, o.store_id) = ?';
      params.push(storeId);
    }

    const revenue = await queryOne(`
      SELECT
        COALESCE(SUM(CASE WHEN p.payment_method = 'transfer' THEN p.amount ELSE 0 END), 0) AS transfer_revenue,
        COALESCE(SUM(CASE WHEN p.payment_method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash_revenue,
        COALESCE(SUM(p.amount), 0) AS total_revenue,
        COUNT(*) AS payment_count,
        COUNT(DISTINCT p.order_id) AS order_count
      FROM order_payments p
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE p.payment_method IN ('cash', 'transfer')
        AND p.paid_at >= ?
        AND p.paid_at < ?
        ${storeFilter}
    `, params);

    const store = storeId
      ? await queryOne('SELECT id, name FROM stores WHERE id = ?', [storeId])
      : null;

    if (storeId && !store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found.'
      });
    }

    const isoDate = formatIsoDate(localDate.year, localDate.month, localDate.day);
    const displayDate = formatDisplayDate(localDate.year, localDate.month, localDate.day);
    const transferRevenue = toNumber(revenue?.transfer_revenue);
    const cashRevenue = toNumber(revenue?.cash_revenue);
    const totalRevenue = toNumber(revenue?.total_revenue);

    return res.json({
      success: true,
      data: {
        date: isoDate,
        display_date: displayDate,
        timezone: 'Asia/Ho_Chi_Minh',
        range_utc: {
          start_at: startAt,
          end_at: endAt
        },
        store_id: storeId,
        store_name: store?.name || null,
        summary: {
          transfer_revenue: transferRevenue,
          cash_revenue: cashRevenue,
          total_revenue: totalRevenue,
          payment_count: Number(revenue?.payment_count || 0),
          order_count: Number(revenue?.order_count || 0)
        },
        rows: [
          [displayDate, 'doanh thu chuyển khoản', transferRevenue],
          ['', 'doanh thu tiền mặt', cashRevenue]
        ]
      }
    });
  } catch (error) {
    console.error('Daily sheet revenue export failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to export daily revenue.'
    });
  }
});

export default router;
