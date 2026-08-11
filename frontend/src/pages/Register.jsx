import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../utils/api';

const PACKAGES = [
  { id: '1month', label: '1 tháng', price: 120000 },
  { id: '3months', label: '3 tháng', price: 300000 },
  { id: '6months', label: '6 tháng', price: 540000 },
  { id: '1year', label: '12 tháng', price: 900000 },
];

const BANK_NAME = 'Vietcombank';
const BANK_ACCOUNT = '0441000805892';
const ZALO_PHONE = '0326122562';

function Register() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    phone: '',
    password: '',
    confirmPassword: '',
    subscription_package: '1month',
  });
  const [error, setError] = useState('');
  const [showSuccessPopup, setShowSuccessPopup] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) {
      setError('Mật khẩu và xác nhận mật khẩu không khớp.');
      return;
    }
    if (form.password.length < 6) {
      setError('Mật khẩu cần ít nhất 6 ký tự.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/register', {
        name: form.name.trim(),
        phone: form.phone.trim(),
        password: form.password,
        subscription_package: form.subscription_package,
      });
      setForm({ name: '', phone: '', password: '', confirmPassword: '', subscription_package: '1month' });
      setShowSuccessPopup(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Đăng ký thất bại. Vui lòng thử lại.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4 py-8">
      <div className="w-full max-w-lg">
        <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8">
          <div className="text-center mb-4">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 mb-1">Đăng ký sử dụng dịch vụ</h1>
            <p className="text-gray-600 text-sm">Tạo tài khoản admin • Chờ phê duyệt để kích hoạt</p>
          </div>

          {/* Hướng dẫn chuyển khoản - đưa lên đầu, nhấn mạnh */}
          <div className="mb-6 p-5 sm:p-6 bg-amber-100 border-2 border-amber-400 rounded-xl shadow-md">
            <h3 className="text-lg sm:text-xl font-bold text-amber-900 mb-3 flex items-center gap-2">
              <span className="text-2xl">💳</span> Quý khách vui lòng chuyển khoản
            </h3>
            <p className="text-base sm:text-lg text-amber-900 font-medium mb-2">
              Ngân hàng <strong>{BANK_NAME}</strong> – STK: <span className="text-xl font-bold text-amber-800 bg-amber-200/80 px-2 py-0.5 rounded">{BANK_ACCOUNT}</span>
            </p>
            <p className="text-sm sm:text-base text-amber-900 mb-2">
              Sau đó chụp màn hình chuyển khoản và gửi tới Zalo <strong className="text-amber-800">{ZALO_PHONE}</strong>.
            </p>
            <p className="text-sm sm:text-base text-amber-900">
              Tài khoản sẽ được kích hoạt trong <strong>24h</strong> sau khi chuyển khoản và thông báo tới Zalo của quý khách.
            </p>
          </div>

          {/* Bảng giá */}
          <div className="mb-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Chọn gói dịch vụ</h2>
            <div className="space-y-2">
              {PACKAGES.map((pkg) => (
                <label
                  key={pkg.id}
                  className={`flex items-center justify-between p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    form.subscription_package === pkg.id
                      ? 'border-blue-600 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300 bg-white'
                  }`}
                >
                  <input
                    type="radio"
                    name="package"
                    value={pkg.id}
                    checked={form.subscription_package === pkg.id}
                    onChange={(e) => setForm({ ...form, subscription_package: e.target.value })}
                    className="sr-only"
                  />
                  <span className="font-medium text-gray-800">{pkg.label}</span>
                  <span className="text-blue-600 font-bold">{new Intl.NumberFormat('vi-VN').format(pkg.price)}đ</span>
                </label>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Họ tên *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Nguyễn Văn A"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Số điện thoại *</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="0912345678"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mật khẩu *</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Ít nhất 6 ký tự"
                required
                minLength={6}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Xác nhận mật khẩu *</label>
              <input
                type="password"
                value={form.confirmPassword}
                onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Nhập lại mật khẩu"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Đang xử lý...' : 'Đăng ký'}
            </button>
          </form>

          <p className="text-center text-gray-600 text-sm mt-6">
            Đã có tài khoản?{' '}
            <Link to="/login" className="text-blue-600 font-medium hover:underline">
              Đăng nhập
            </Link>
          </p>
        </div>
      </div>

      {/* Popup đăng ký thành công */}
      {showSuccessPopup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 sm:p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
              <span className="text-4xl">✓</span>
            </div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">Đăng ký thành công!</h3>
            <p className="text-gray-600 text-sm sm:text-base mb-4">
              Tài khoản của bạn đang chờ phê duyệt. Vui lòng chuyển khoản theo hướng dẫn trên và gửi ảnh chuyển khoản qua Zalo <strong>{ZALO_PHONE}</strong> để được kích hoạt trong 24h.
            </p>
            <button
              type="button"
              onClick={() => setShowSuccessPopup(false)}
              className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium hover:bg-blue-700 transition-colors"
            >
              Đã hiểu
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Register;
