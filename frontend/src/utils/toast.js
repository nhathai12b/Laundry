/**
 * Toast thông báo không chặn màn hình — thay cho window.alert().
 *
 * Dùng: showToast('Check-out thành công!')            → tự nhận diện loại
 *       showToast('Lưu thất bại', 'error')            → chỉ định loại
 *
 * Cơ chế CustomEvent nên gọi được từ BẤT KỲ file nào không cần context/hook;
 * <ToastContainer /> (mount 1 lần trong App.jsx) lắng nghe và hiển thị.
 */

const ERROR_HINTS = ['thất bại', 'lỗi', 'không thể', 'không tìm thấy', 'không hợp lệ', 'không có quyền', 'vui lòng', 'sai ', 'chưa ', 'đã bị', 'đã có ca', 'phải chọn', 'hết hạn', 'quá nhiều', 'failed', 'error', 'invalid', 'required', 'does not', 'exceeds', '⚠'];
const SUCCESS_HINTS = ['thành công', 'đã lưu', 'đã xóa', 'đã cập nhật', 'đã thêm', 'hoàn tất', '✓', '✅'];

const detectType = (message) => {
  const lower = String(message).toLowerCase();
  if (SUCCESS_HINTS.some((h) => lower.includes(h))) return 'success';
  if (ERROR_HINTS.some((h) => lower.includes(h))) return 'error';
  return 'info';
};

export const showToast = (message, type) => {
  const text = String(message ?? '');
  if (!text.trim()) return;
  window.dispatchEvent(new CustomEvent('app-toast', {
    detail: { message: text, type: type || detectType(text) },
  }));
};
