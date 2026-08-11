const trimText = (value, maxLength = 1900) => {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

const formatMoney = (value) => {
  const amount = Number.parseFloat(value || 0);
  return `${new Intl.NumberFormat('vi-VN').format(amount)} đ`;
};

export function formatDailyBusinessReportMessage(report) {
  return [
    '**========BÁO CÁO TỔNG HỢP CUỐI NGÀY==========**',
    '',
    `Ngày: ${report.display_date}`,
    `Cửa hàng: ${report.store_name || '-'}`,
    '',
    '**DOANH THU THỰC THU**',
    `Tổng doanh thu: ${formatMoney(report.revenue.total_revenue)}`,
    `Tiền mặt: ${formatMoney(report.revenue.cash_revenue)}`,
    `Chuyển khoản: ${formatMoney(report.revenue.transfer_revenue)}`,
    '',
    '**ĐƠN HÀNG**',
    `Đơn tạo mới: ${report.orders.created_orders}`,
    `Đơn đã giao / hoàn thành: ${report.orders.completed_orders}`,
    `Đơn chờ khách nhận: ${report.orders.waiting_pickup_orders}`,
    `Đơn đang xử lý: ${report.orders.processing_orders}`,
    `Đơn đã hủy: ${report.orders.cancelled_orders}`,
    '',
    '**CÔNG NỢ**',
    `Công nợ phát sinh trong ngày: ${formatMoney(report.debt.new_debt_amount)}`,
    `Tiền nợ đã thu trong ngày: ${formatMoney(report.debt.debt_collected_amount)}`,
    `Công nợ còn lại cuối ngày: ${formatMoney(report.debt.outstanding_debt_amount)}`,
    '',
    '**NGĂN KÉT**',
    `Tiền mặt két dự kiến: ${formatMoney(report.cash_drawer.expected_cash_amount)}`,
    `Tiền mặt thực đếm: ${formatMoney(report.cash_drawer.actual_cash_amount)}`,
    `Chênh lệch két: ${formatMoney(report.cash_drawer.cash_difference)}`,
    `===========================${report.display_date}===========================================`,

  ].join('\n');
}

export async function notifyDailyBusinessReport(report, webhookUrl = process.env.CASH_DRAWER_DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) return;

  const content = formatDailyBusinessReportMessage(report);

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
      console.warn('Daily business Discord report failed:', response.status, trimText(body, 200));
    }
  } catch (error) {
    console.warn('Daily business Discord report failed:', error.message);
  }
}
