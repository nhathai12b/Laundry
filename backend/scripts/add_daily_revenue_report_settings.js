import { execute, queryOne } from '../database/db.js';

async function columnExists(tableName, columnName) {
  const row = await queryOne(`
    SELECT COUNT(*) AS count
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = ?
      AND column_name = ?
  `, [tableName, columnName]);
  return Number(row?.count || 0) > 0;
}

async function addColumn(tableName, columnName, ddl) {
  if (await columnExists(tableName, columnName)) {
    console.log(`Column ${tableName}.${columnName} already exists`);
    return;
  }
  await execute(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
  console.log(`Added column ${tableName}.${columnName}`);
}

async function migrate() {
  await addColumn(
    'users',
    'daily_revenue_report_enabled',
    'daily_revenue_report_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER subscription_expires_at'
  );
  await addColumn(
    'users',
    'daily_revenue_report_webhook_url',
    'daily_revenue_report_webhook_url TEXT NULL AFTER daily_revenue_report_enabled'
  );
  await addColumn(
    'users',
    'daily_revenue_report_discord_guild_id',
    'daily_revenue_report_discord_guild_id VARCHAR(50) NULL AFTER daily_revenue_report_webhook_url'
  );
  await addColumn(
    'users',
    'daily_revenue_report_discord_channel_id',
    'daily_revenue_report_discord_channel_id VARCHAR(50) NULL AFTER daily_revenue_report_discord_guild_id'
  );
  console.log('Daily revenue report settings migration completed');
}

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Daily revenue report settings migration failed:', error);
    process.exit(1);
  });
