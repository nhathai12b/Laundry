import { query, queryOne } from '../database/db.js';

async function main() {
  const dbName = await queryOne('SELECT DATABASE() as db');
  const totals = await queryOne(
    "SELECT COUNT(*) as total_orders, SUM(status = 'completed') as completed_orders FROM orders"
  );
  const dateRange = await queryOne(
    'SELECT MIN(created_at) as min_created, MAX(created_at) as max_created, MIN(updated_at) as min_updated, MAX(updated_at) as max_updated FROM orders'
  );
  const byMonth = await query(
    "SELECT DATE_FORMAT(updated_at, '%Y-%m') as ym, COUNT(*) as total, SUM(status = 'completed') as completed FROM orders GROUP BY ym ORDER BY ym DESC LIMIT 24"
  );
  const byStore = await query(
    "SELECT store_id, COUNT(*) as total, SUM(status = 'completed') as completed FROM orders GROUP BY store_id ORDER BY total DESC LIMIT 50"
  );
  const statuses = await query(
    'SELECT status, COUNT(*) as total FROM orders GROUP BY status ORDER BY total DESC'
  );
  const sample = await query(
    'SELECT id, code, status, store_id, assigned_to, created_by, created_at, updated_at, final_amount, payment_method FROM orders ORDER BY updated_at DESC LIMIT 10'
  );

  // eslint-disable-next-line no-console
  console.log('DB:', dbName);
  // eslint-disable-next-line no-console
  console.log('Totals:', totals);
  // eslint-disable-next-line no-console
  console.log('DateRange:', dateRange);
  // eslint-disable-next-line no-console
  console.log('Statuses:', statuses);
  // eslint-disable-next-line no-console
  console.log('ByMonth(updated_at):', byMonth);
  // eslint-disable-next-line no-console
  console.log('ByStore:', byStore);
  // eslint-disable-next-line no-console
  console.log('Sample orders:', sample);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
