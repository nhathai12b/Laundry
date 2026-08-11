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

async function indexExists(tableName, indexName) {
  const row = await queryOne(`
    SELECT COUNT(*) AS count
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = ?
      AND index_name = ?
  `, [tableName, indexName]);
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

async function addIndex(tableName, indexName, ddl) {
  if (await indexExists(tableName, indexName)) {
    console.log(`Index ${indexName} already exists`);
    return;
  }
  await execute(`ALTER TABLE ${tableName} ADD INDEX ${indexName} ${ddl}`);
  console.log(`Added index ${indexName}`);
}

async function migrate() {
  await addColumn('timesheets', 'opening_cash_amount', 'opening_cash_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER expected_revenue');
  await addColumn('timesheets', 'expected_cash_amount', 'expected_cash_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER opening_cash_amount');
  await addColumn('timesheets', 'actual_cash_amount', 'actual_cash_amount DECIMAL(10, 2) DEFAULT NULL AFTER expected_cash_amount');
  await addColumn('timesheets', 'cash_difference', 'cash_difference DECIMAL(10, 2) DEFAULT NULL AFTER actual_cash_amount');
  await addColumn('timesheets', 'cash_shortage_paid_amount', 'cash_shortage_paid_amount DECIMAL(10, 2) DEFAULT NULL AFTER cash_difference');

  await execute(`
    CREATE TABLE IF NOT EXISTS cash_drawer_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id INT NULL,
      timesheet_id INT NOT NULL,
      user_id INT NULL,
      employee_id INT NULL,
      order_id INT NULL,
      order_payment_id INT NULL,
      type ENUM('opening_float', 'cash_payment', 'cash_in', 'cash_out', 'shortage_reimbursement', 'closing_count') NOT NULL,
      direction ENUM('in', 'out', 'neutral') NOT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      reason TEXT,
      occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      FOREIGN KEY (timesheet_id) REFERENCES timesheets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
      FOREIGN KEY (order_payment_id) REFERENCES order_payments(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await addIndex('cash_drawer_transactions', 'idx_cash_drawer_timesheet_id', '(timesheet_id)');
  await addIndex('cash_drawer_transactions', 'idx_cash_drawer_store_id', '(store_id)');
  await addIndex('cash_drawer_transactions', 'idx_cash_drawer_occurred_at', '(occurred_at)');
  await addIndex('cash_drawer_transactions', 'idx_cash_drawer_type', '(type)');

  console.log('Cash drawer ledger migration completed');
}

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Cash drawer ledger migration failed:', error);
    process.exit(1);
  });
