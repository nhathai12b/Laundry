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

async function tableExists(tableName) {
  const row = await queryOne(`
    SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = ?
  `, [tableName]);
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
  await addColumn('orders', 'expected_return_at', 'expected_return_at DATETIME DEFAULT NULL AFTER withdrawn_amount');
  await addColumn('orders', 'processing_started_at', 'processing_started_at DATETIME DEFAULT NULL AFTER expected_return_at');
  await addColumn('orders', 'ready_at', 'ready_at DATETIME DEFAULT NULL AFTER processing_started_at');
  await addColumn('orders', 'delivered_at', 'delivered_at DATETIME DEFAULT NULL AFTER ready_at');
  await addColumn('orders', 'delivery_method', "delivery_method ENUM('pickup', 'customer_ship', 'shop_delivery') DEFAULT NULL AFTER delivered_at");
  await addColumn('orders', 'payment_status', "payment_status ENUM('unpaid', 'partial', 'paid', 'debt') NOT NULL DEFAULT 'unpaid' AFTER delivery_method");
  await addColumn('orders', 'paid_amount', 'paid_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER payment_status');
  await addColumn('orders', 'debt_amount', 'debt_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER paid_amount');

  await execute(`
    CREATE TABLE IF NOT EXISTS order_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      store_id INT NULL,
      user_id INT NULL,
      employee_id INT NULL,
      timesheet_id INT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      payment_method ENUM('cash', 'transfer') NOT NULL,
      payment_type ENUM('order_payment', 'debt_payment') NOT NULL DEFAULT 'order_payment',
      paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      note TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
      FOREIGN KEY (timesheet_id) REFERENCES timesheets(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await addIndex('order_payments', 'idx_order_payments_order_id', '(order_id)');
  await addIndex('order_payments', 'idx_order_payments_store_id', '(store_id)');
  await addIndex('order_payments', 'idx_order_payments_paid_at', '(paid_at)');
  await addIndex('order_payments', 'idx_order_payments_method', '(payment_method)');

  if (!(await tableExists('order_notifications'))) {
    await execute(`
      CREATE TABLE order_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        store_id INT NULL,
        channel ENUM('zalo') NOT NULL DEFAULT 'zalo',
        provider ENUM('zalo') NOT NULL DEFAULT 'zalo',
        event_type ENUM('order_created', 'ready_for_pickup', 'delivered', 'debt_payment_reminder') DEFAULT NULL,
        recipient_phone VARCHAR(50),
        message TEXT,
        status ENUM('sent', 'failed') NOT NULL,
        error TEXT NULL,
        sent_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL,
        INDEX idx_order_notifications_order_id (order_id),
        INDEX idx_order_notifications_store_id (store_id),
        INDEX idx_order_notifications_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  await addColumn('order_notifications', 'provider', "provider ENUM('zalo') NOT NULL DEFAULT 'zalo' AFTER channel");
  await addColumn('order_notifications', 'event_type', "event_type ENUM('order_created', 'ready_for_pickup', 'delivered', 'debt_payment_reminder') DEFAULT NULL AFTER provider");

  await execute(`
    INSERT INTO order_payments (order_id, store_id, user_id, amount, payment_method, payment_type, paid_at, note)
    SELECT o.id, o.store_id, o.updated_by, COALESCE(o.final_amount, o.total_amount, 0),
      COALESCE(o.payment_method, 'cash'), 'order_payment', COALESCE(o.updated_at, NOW()), 'Legacy completed order backfill'
    FROM orders o
    LEFT JOIN order_payments p ON p.order_id = o.id
    WHERE o.status = 'completed'
      AND COALESCE(o.is_debt, 0) = 0
      AND p.id IS NULL
      AND COALESCE(o.final_amount, o.total_amount, 0) > 0
  `);

  await execute(`
    INSERT INTO order_payments (order_id, store_id, user_id, amount, payment_method, payment_type, paid_at, note)
    SELECT o.id, o.store_id, o.updated_by, COALESCE(o.final_amount, o.total_amount, 0),
      COALESCE(o.payment_method, 'cash'), 'debt_payment', o.debt_paid_at, 'Legacy paid debt backfill'
    FROM orders o
    LEFT JOIN order_payments p ON p.order_id = o.id
    WHERE o.status = 'completed'
      AND COALESCE(o.is_debt, 0) = 1
      AND o.debt_paid_at IS NOT NULL
      AND p.id IS NULL
      AND COALESCE(o.final_amount, o.total_amount, 0) > 0
  `);

  await execute(`
    UPDATE orders o
    LEFT JOIN (
      SELECT order_id, COALESCE(SUM(amount), 0) AS paid_amount
      FROM order_payments
      GROUP BY order_id
    ) p ON p.order_id = o.id
    SET o.paid_amount = COALESCE(p.paid_amount, 0),
        o.debt_amount = GREATEST(COALESCE(o.final_amount, o.total_amount, 0) - COALESCE(p.paid_amount, 0), 0),
        o.payment_status = CASE
          WHEN COALESCE(p.paid_amount, 0) >= COALESCE(o.final_amount, o.total_amount, 0) THEN 'paid'
          WHEN COALESCE(p.paid_amount, 0) > 0 THEN 'partial'
          WHEN o.status = 'completed' AND COALESCE(o.is_debt, 0) = 1 THEN 'debt'
          ELSE 'unpaid'
        END
    WHERE o.status IN ('created', 'washing', 'drying', 'waiting_pickup', 'completed')
  `);

  await execute(`
    UPDATE orders
    SET is_debt = CASE
          WHEN status = 'completed' AND COALESCE(debt_amount, 0) > 0.009 THEN 1
          ELSE 0
        END
    WHERE status IN ('created', 'washing', 'drying', 'waiting_pickup', 'completed')
  `);

  console.log('Payment ledger migration completed successfully');
  process.exit(0);
}

migrate().catch((error) => {
  console.error('Payment ledger migration failed:', error);
  process.exit(1);
});
