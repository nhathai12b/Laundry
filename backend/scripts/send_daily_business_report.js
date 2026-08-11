import dotenv from 'dotenv';
import { queryOne } from '../database/db.js';
import {
  buildDailyBusinessReport,
  getActiveStoresByAdmin,
  getEnabledDailyBusinessReportAdmins,
} from '../services/dailyBusinessReportService.js';
import { notifyDailyBusinessReport } from '../services/dailyBusinessDiscordNotifier.js';

dotenv.config();

function getArg(name) {
  const prefix = `--${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function parseStoreId(value) {
  if (!value || value === 'all') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    throw new Error('Invalid store id');
  }
  return parsed;
}

async function main() {
  const date = getArg('date');
  const storeId = parseStoreId(getArg('store-id') || process.env.DAILY_BUSINESS_REPORT_STORE_ID);
  const adminIdArg = getArg('admin-id');
  const adminId = adminIdArg ? Number.parseInt(adminIdArg, 10) : null;

  if (adminIdArg && (!Number.isInteger(adminId) || adminId <= 0 || String(adminId) !== String(adminIdArg))) {
    throw new Error('Invalid admin id');
  }

  if (adminId) {
    const admin = await queryOne(`
      SELECT id, name, daily_revenue_report_enabled, daily_revenue_report_webhook_url
      FROM users
      WHERE id = ? AND role = 'admin'
    `, [adminId]);

    if (!admin) throw new Error(`Admin ${adminId} not found`);
    if (!admin.daily_revenue_report_enabled || !admin.daily_revenue_report_webhook_url) {
      throw new Error(`Daily revenue report is disabled or missing webhook for admin ${adminId}`);
    }

    const stores = storeId ? [{ id: storeId }] : await getActiveStoresByAdmin(adminId);
    for (const store of stores) {
      const report = await buildDailyBusinessReport({ date, storeId: store.id, adminId });
      await notifyDailyBusinessReport(report, admin.daily_revenue_report_webhook_url);
      console.log(`Daily business report sent for ${report.display_date} - ${report.store_name}`);
    }
    return;
  }

  const admins = await getEnabledDailyBusinessReportAdmins();
  if (admins.length === 0) {
    console.log('No enabled daily revenue report admins found');
    return;
  }

  for (const admin of admins) {
    const stores = storeId ? [{ id: storeId }] : await getActiveStoresByAdmin(admin.id);
    if (stores.length === 0) {
      console.log(`No active stores found for admin ${admin.id}`);
      continue;
    }

    for (const store of stores) {
      const report = await buildDailyBusinessReport({ date, storeId: store.id, adminId: admin.id });
      await notifyDailyBusinessReport(report, admin.daily_revenue_report_webhook_url);
      console.log(`Daily business report sent for ${report.display_date} - ${report.store_name}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Daily business report failed:', error);
    process.exit(1);
  });
