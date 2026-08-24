/**
 * Validate mật khẩu phía client — PHẢI khớp quy tắc backend
 * (backend/utils/helpers.js validatePasswordStrength + utils/constants.js):
 * tối thiểu 8 ký tự, có chữ HOA, chữ thường và chữ số.
 *
 * Trả về message lỗi (string) nếu chưa đạt, hoặc null nếu hợp lệ / bỏ trống.
 */
export const getPasswordError = (pw) => {
  if (!pw) return null;
  if (pw.length < 8) return 'Mật khẩu phải có ít nhất 8 ký tự.';
  if (!/[A-Z]/.test(pw)) return 'Mật khẩu phải chứa ít nhất một chữ HOA (A-Z).';
  if (!/[a-z]/.test(pw)) return 'Mật khẩu phải chứa ít nhất một chữ thường (a-z).';
  if (!/[0-9]/.test(pw)) return 'Mật khẩu phải chứa ít nhất một chữ số (0-9).';
  return null;
};
