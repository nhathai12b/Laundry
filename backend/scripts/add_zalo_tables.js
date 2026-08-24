import { execute } from '../database/db.js';

async function migrate() {
  await execute(`
    CREATE TABLE IF NOT EXISTS store_zalo_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id INT NOT NULL,
      zalo_user_id VARCHAR(100) NULL,
      zalo_name VARCHAR(255) NULL,
      credentials_json LONGTEXT NULL,
      status ENUM('not_logged_in', 'pending_qr', 'logged_in', 'expired', 'error') NOT NULL DEFAULT 'not_logged_in',
      qr_path VARCHAR(500) NULL,
      qr_image LONGTEXT NULL,
      last_login_at DATETIME NULL,
      last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_store_zalo (store_id),
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS zalo_phone_mappings (
      store_id INT NOT NULL,
      phone VARCHAR(20) NOT NULL,
      zalo_user_id VARCHAR(100) NOT NULL,
      display_name VARCHAR(255) NOT NULL DEFAULT '',
      last_resolved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (store_id, phone),
      INDEX idx_zalo_phone_user (zalo_user_id),
      FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS order_notifications (
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

  for (const column of [
    {
      name: 'provider',
      ddl: "ALTER TABLE order_notifications ADD COLUMN provider ENUM('zalo') NOT NULL DEFAULT 'zalo' AFTER channel",
    },
    {
      name: 'event_type',
      ddl: "ALTER TABLE order_notifications ADD COLUMN event_type ENUM('order_created', 'ready_for_pickup', 'delivered', 'debt_payment_reminder') DEFAULT NULL AFTER provider",
    },
  ]) {
    try {
      await execute(column.ddl);
      console.log(`Added order_notifications.${column.name}`);
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  }

  console.log('Zalo tables migrated successfully');
  process.exit(0);
}

migrate().catch((error) => {
  console.error('Zalo migration failed:', error);
  process.exit(1);
});
