import { queryOne } from '../database/db.js';

// Cửa hàng của người gọi (tài khoản tiệm `employer`, hoặc token nhân viên
// employee_login của tiệm đó). Mỗi tài khoản tiệm gắn ĐÚNG một cửa hàng
// (users.store_id = stores.id) và JWT mang store_id đó (auth.js login) — không
// có cơ chế một tài khoản đứng nhiều tiệm, nên không phải đoán "tiệm đang làm
// việc" theo ca mở. Giữ hàm async cùng chữ ký cũ làm NGUỒN DUY NHẤT cho mọi
// route cần "cửa hàng của người gọi" (tham số thứ 2 cũ được bỏ qua).
export async function resolveCurrentStoreId(actor) {
  return actor?.store_id || null;
}

// Nhân viên đang tạo đơn — để gán orders.employee_id (tính hoa hồng sản phẩm).
// Token nhân viên riêng: chính họ. Tài khoản tiệm (nhiều nhân viên cùng dùng
// một đăng nhập): chỉ gán khi KHÔNG MƠ HỒ — tài khoản có đúng 1 ca đang mở.
// ≥2 ca mở song song thì không biết ai đang thao tác đơn này → trả null
// (không hoa hồng) thay vì đoán "ca mở gần nhất" rồi trả hoa hồng nhầm người.
export async function resolveCurrentEmployeeId(actor, queryFn = queryOne) {
  if (!actor || actor.role !== 'employer') return null;
  if (actor.employee_login) return actor.employee_id || null;

  const rows = await queryFn(
    'SELECT employee_id FROM timesheets WHERE user_id = ? AND check_out IS NULL LIMIT 2',
    [actor.id]
  );
  const openShifts = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  if (openShifts.length !== 1) return null;
  return openShifts[0]?.employee_id || null;
}
