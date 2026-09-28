import { useState } from 'react';
import api from '../utils/api';
import { getAuth } from '../utils/auth';
import { showToast } from '../utils/toast';
import PasswordRequirements from './PasswordRequirements';

/**
 * Modal đổi mật khẩu cho chính tài khoản đang đăng nhập (admin, employer, root).
 * Dùng chung để tránh 3 bản logic riêng biệt (Settings.jsx, AdminManagement.jsx...).
 * Backend (PATCH /users/:id) là nơi DUY NHẤT xác thực current_password và trả
 * lỗi "Mật khẩu hiện tại không đúng." — KHÔNG gọi /auth/login để "kiểm tra
 * trước": mỗi lần gõ sai ở đây sẽ bị tính là một lần đăng nhập sai (khoá tài
 * khoản 30 phút sau 5 lần), tốn rate-limit và sinh token thừa.
 */
function ChangePasswordModal({ isOpen, onClose }) {
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  if (!isOpen) return null;

  const reset = () => {
    setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setMessage('');
  };

  const handleClose = () => {
    // Chặn đóng khi đang gửi request — nếu không, request pending vẫn chạy
    // ngầm sau khi modal đã ẩn: thành công thì đổi mật khẩu "sau lưng" người
    // dùng tưởng đã hủy; thất bại thì lỗi hiện ra trên modal đã unmount, không
    // ai thấy. Nút Hủy/X cũng gắn disabled={submitting} để không bấm được lúc này.
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage('');

    if (!passwordData.currentPassword || !passwordData.newPassword || !passwordData.confirmPassword) {
      setMessage('Vui lòng điền đầy đủ thông tin');
      setSubmitting(false);
      return;
    }
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setMessage('Mật khẩu mới và xác nhận mật khẩu không khớp');
      setSubmitting(false);
      return;
    }
    if (passwordData.currentPassword === passwordData.newPassword) {
      setMessage('Mật khẩu mới phải khác mật khẩu hiện tại');
      setSubmitting(false);
      return;
    }

    try {
      const auth = getAuth();
      if (!auth || !auth.user || !auth.user.id) {
        setMessage('Không thể lấy thông tin người dùng. Vui lòng đăng nhập lại.');
        setSubmitting(false);
        return;
      }

      await api.patch(`/users/${auth.user.id}`, {
        password: passwordData.newPassword,
        current_password: passwordData.currentPassword,
      });

      showToast('Đổi mật khẩu thành công!', 'success');
      // Giữ nút khóa suốt 800ms chờ đóng modal (mở lại ngay thì người dùng có
      // thể bấm lần nữa với current_password đã CŨ và thấy lỗi gây hiểu nhầm).
      // Component KHÔNG unmount khi đóng (cha render với isOpen) nên PHẢI trả
      // submitting về false ở đây — nếu không lần mở sau mọi nút đều bị khoá
      // và handleClose (có guard submitting) không đóng được, phải reload trang.
      setTimeout(() => {
        reset();
        setSubmitting(false);
        onClose();
      }, 800);
    } catch (error) {
      const errorDetails = error.response?.data?.details || [];
      if (errorDetails.length > 0) {
        setMessage('Mật khẩu không đủ mạnh: ' + errorDetails.join(', '));
      } else {
        setMessage(error.response?.data?.error || 'Đổi mật khẩu thất bại');
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-2 sm:p-3 z-50 overflow-y-auto overflow-x-hidden">
      <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] flex flex-col my-auto shadow-2xl">
        <div className="flex items-center justify-between p-4 sm:p-5 pb-3 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg sm:text-xl font-bold text-gray-900 truncate pr-2">Đổi mật khẩu</h2>
          <button
            onClick={handleClose}
            disabled={submitting}
            className="text-gray-500 hover:text-gray-700 text-2xl w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 active:bg-gray-200 touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Đóng"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-5">
          <form onSubmit={handleSubmit} className="space-y-4 min-w-0 py-2">
            {message && (
              <div
                className={`p-3 rounded-lg ${
                  message.includes('thành công') ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}
              >
                {message}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mật khẩu hiện tại *</label>
              <input
                type="password"
                value={passwordData.currentPassword}
                onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                className="w-full px-3 py-2.5 border rounded-lg text-base"
                required
                placeholder="Nhập mật khẩu hiện tại"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mật khẩu mới *</label>
              <input
                type="password"
                value={passwordData.newPassword}
                onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                className="w-full px-3 py-2.5 border rounded-lg text-base"
                required
                placeholder="Nhập mật khẩu mới"
              />
              {passwordData.newPassword && <PasswordRequirements password={passwordData.newPassword} />}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Xác nhận mật khẩu mới *</label>
              <input
                type="password"
                value={passwordData.confirmPassword}
                onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                className={`w-full px-3 py-2.5 border rounded-lg text-base ${
                  passwordData.confirmPassword && passwordData.newPassword !== passwordData.confirmPassword
                    ? 'border-red-500'
                    : ''
                }`}
                required
                placeholder="Nhập lại mật khẩu mới"
              />
              {passwordData.confirmPassword && passwordData.newPassword !== passwordData.confirmPassword && (
                <p className="text-xs text-red-600 mt-1">Mật khẩu xác nhận không khớp</p>
              )}
            </div>
          </form>
        </div>

        <div className="flex flex-row gap-2.5 px-4 sm:px-5 pb-4 pt-2 border-t border-gray-200 flex-shrink-0">
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 min-w-0 px-4 py-3.5 bg-gradient-to-r from-red-600 to-red-700 text-white rounded-xl active:from-red-700 active:to-red-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation font-semibold text-base shadow-lg"
          >
            {submitting ? 'Đang xử lý...' : 'Đổi mật khẩu'}
          </button>
          <button
            onClick={handleClose}
            disabled={submitting}
            className="flex-1 min-w-0 px-4 py-3.5 bg-gray-200 text-gray-800 rounded-xl hover:bg-gray-300 font-semibold text-base touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Hủy
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChangePasswordModal;
