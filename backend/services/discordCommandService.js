import { queryOne } from '../database/db.js';
import {
  buildDailyBusinessReport,
  getActiveStoresByAdmin,
} from './dailyBusinessReportService.js';

const MAX_DISCORD_CONTENT_LENGTH = 1900;

function trimText(value, maxLength = MAX_DISCORD_CONTENT_LENGTH) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatMoney(value) {
  const amount = Number.parseFloat(value || 0);
  return `${new Intl.NumberFormat('vi-VN').format(amount)} đ`;
}

function getSubcommandName(interaction) {
  return interaction?.data?.options?.find((option) => option.type === 1)?.name || null;
}

async function findAdminByDiscordChannel(guildId, channelId) {
  if (!guildId || !channelId) return null;

  return queryOne(`
    SELECT id, name
    FROM users
    WHERE role = 'admin'
      AND status = 'active'
      AND daily_revenue_report_discord_guild_id = ?
      AND daily_revenue_report_discord_channel_id = ?
    LIMIT 1
  `, [guildId, channelId]);
}

function formatStoreRevenueReport(report) {
  return [
    `**${report.store_name}**`,
    `Tổng doanh thu: ${formatMoney(report.revenue.total_revenue)}`,
    `Tiền mặt: ${formatMoney(report.revenue.cash_revenue)}`,
    `Chuyển khoản: ${formatMoney(report.revenue.transfer_revenue)}`,
    `Đơn tạo mới: ${report.orders.created_orders}`,
    `Đơn hoàn thành: ${report.orders.completed_orders}`,
    `Công nợ còn lại: ${formatMoney(report.debt.outstanding_debt_amount)}`,
    `Chênh lệch két: ${formatMoney(report.cash_drawer.cash_difference)}`,
  ].join('\n');
}

export async function handleBemyCommand(interaction) {
  const subcommand = getSubcommandName(interaction);

  if (subcommand !== 'bao_cao_doanh_thu') {
    return 'Lệnh chưa được hỗ trợ.';
  }

  const admin = await findAdminByDiscordChannel(interaction.guild_id, interaction.channel_id);
  if (!admin) {
    return [
      'Kênh Discord này chưa được liên kết với admin XWASH.',
      'Vui lòng cấu hình Discord Guild ID và Channel ID trong màn Cửa hàng & Nhân sự.',
    ].join('\n');
  }

  const stores = await getActiveStoresByAdmin(admin.id);
  if (stores.length === 0) {
    return `Admin ${admin.name} chưa có cửa hàng active để báo cáo.`;
  }

  const reports = [];
  for (const store of stores) {
    reports.push(await buildDailyBusinessReport({
      storeId: store.id,
      adminId: admin.id,
    }));
  }

  const content = [
    '**BÁO CÁO DOANH THU HIỆN TẠI**',
    `Ngày: ${reports[0]?.display_date || '-'}`,
    `Admin: ${admin.name}`,
    '',
    reports.map(formatStoreRevenueReport).join('\n\n'),
  ].join('\n');

  return trimText(content);
}
