// Câu lệnh migration dùng chung cho database/db.js (auto-init khi khởi động)
// và scripts/initDatabase.js (`npm run init-db` trên production). Module này
// KHÔNG có side effect (không mở kết nối) — an toàn để cả hai cùng import.

const HANDOVER_REASON_PREFIX = 'Nhận bàn giao két từ ca #';

// Dòng "nhận bàn giao két" ghi TRƯỚC khi có cột related_timesheet_id: điền lại
// từ reason "Nhận bàn giao két từ ca #<id> (<tên>)". Lấy số NGAY SAU tiền tố
// (không phải sau dấu '#' cuối — tên nhân viên có thể chứa '#'), chỉ nhận khi
// đúng là số và trỏ tới ca có thật. Idempotent: chỉ đụng dòng còn NULL.
export const BACKFILL_HANDOVER_LINK_SQL = `
  UPDATE cash_drawer_transactions cdt
  JOIN timesheets src
    ON src.id = CAST(SUBSTRING_INDEX(SUBSTRING(cdt.reason, CHAR_LENGTH('${HANDOVER_REASON_PREFIX}') + 1), ' ', 1) AS UNSIGNED)
  SET cdt.related_timesheet_id = src.id
  WHERE cdt.type = 'opening_float'
    AND cdt.related_timesheet_id IS NULL
    AND cdt.reason LIKE '${HANDOVER_REASON_PREFIX}%'
    AND SUBSTRING_INDEX(SUBSTRING(cdt.reason, CHAR_LENGTH('${HANDOVER_REASON_PREFIX}') + 1), ' ', 1) REGEXP '^[0-9]+$'
`;
