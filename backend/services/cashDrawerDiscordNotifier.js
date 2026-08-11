const trimText = (value, maxLength = 1900) => {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

const formatMoney = (value) => {
  const amount = Number.parseFloat(value || 0);
  return `${new Intl.NumberFormat('vi-VN').format(amount)} đ`;
};

const formatDateTime = (value) => {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 16);
};

function statusText(difference, shortagePaidAmount) {
  if (difference < 0) {
    return shortagePaidAmount >= Math.abs(difference)
      ? 'THIẾU TIỀN, ĐÃ BÙ'
      : 'THIẾU TIỀN';
  }
  if (difference > 0) return 'DƯ TIỀN';
  return 'KHỚP';
}

export async function notifyCashDrawerCheckout({ timesheet, summary, note }) {
  const webhookUrl = process.env.CASH_DRAWER_DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const content = [
    '**BÁO CÁO CHỐT CA TIỀN MẶT**',
    '',
    `Cửa hàng: ${timesheet.store_name || '-'}`,
    `Nhân viên: ${timesheet.employee_name || timesheet.user_name || '-'}`,
    `Ca làm: ${formatDateTime(timesheet.check_in)} - ${formatDateTime(timesheet.check_out)}`,
    `Tiền mặt đầu ca: ${formatMoney(summary.opening_cash_amount)}`,
    `Thanh toán bằng tiền mặt: ${formatMoney(summary.cash_payment_amount)}`,
    `Tiền mặt thu vào: ${formatMoney(summary.cash_in_amount)}`,
    `Tiền mặt chi ra: ${formatMoney(summary.cash_out_amount)}`,
    `Tiền mặt dự kiến: ${formatMoney(summary.expected_cash_amount)}`,
    `Tiền mặt thực tế đã đếm: ${formatMoney(summary.actual_cash_amount)}`,
    `Chênh lệch: ${formatMoney(summary.cash_difference)}`,
    `Bù tiền thiếu hụt: ${formatMoney(summary.cash_shortage_paid_amount)}`,
    `Trạng thái: ${statusText(summary.cash_difference, summary.cash_shortage_paid_amount)}`,
    note ? `Ghi chú: ${note}` : null,
  ].filter(Boolean).join('\n');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: trimText(content),
        allowed_mentions: { parse: [] },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn('Cash drawer Discord report failed:', response.status, trimText(body, 200));
    }
  } catch (error) {
    console.warn('Cash drawer Discord report failed:', error.message);
  }
}
