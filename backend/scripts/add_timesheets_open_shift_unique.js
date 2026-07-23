import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'laundry66',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  multipleStatements: true
});

// Prevents a race condition where two near-simultaneous check-in requests for
// the same user both pass the "no open shift" read before either INSERT
// commits, creating two open shifts at once. Adds a generated column that is
// NULL for closed shifts and user_id for open shifts, with a UNIQUE index on
// it — MySQL unique indexes permit unlimited NULLs but still reject duplicate
// non-NULL values, so a user can never have two open shifts simultaneously.
async function addTimesheetsOpenShiftUnique() {
  const connection = await pool.getConnection();
  try {
    const dbName = process.env.MYSQL_DATABASE || 'laundry66';
    console.log('Checking timesheets.open_shift_guard...');

    const [colCheck] = await connection.query(`
      SELECT COUNT(*) as count
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'timesheets'
        AND column_name = 'open_shift_guard'
    `, [dbName]);

    if (colCheck[0].count === 0) {
      // Look for any existing duplicate open shifts first — the ALTER TABLE
      // will fail with ER_DUP_ENTRY if duplicates already exist, so surface
      // them clearly instead of a raw MySQL error.
      const [dupes] = await connection.query(`
        SELECT user_id, COUNT(*) as open_count
        FROM timesheets
        WHERE check_out IS NULL
        GROUP BY user_id
        HAVING COUNT(*) > 1
      `);

      if (dupes.length > 0) {
        console.error('Found users with more than one open shift — resolve these before running this migration:');
        console.error(dupes);
        throw new Error('Duplicate open shifts exist; migration aborted to avoid a failed ALTER TABLE.');
      }

      console.log('Adding timesheets.open_shift_guard generated column + unique index...');
      await connection.query(`
        ALTER TABLE timesheets
        ADD COLUMN open_shift_guard INT AS (CASE WHEN check_out IS NULL THEN user_id ELSE NULL END) STORED,
        ADD UNIQUE KEY unique_open_shift_per_user (open_shift_guard)
      `);
      console.log('✓ timesheets.open_shift_guard added with unique index');
    } else {
      console.log('✓ timesheets.open_shift_guard already exists');
    }

    console.log('Migration complete!');
  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

addTimesheetsOpenShiftUnique();
