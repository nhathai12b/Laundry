import { useEffect, useState } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { clearAuth, getAuth } from '../utils/auth';
import api from '../utils/api';
import '../styles/premium.css';

function EmployerLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = getAuth();
  const [zaloStatus, setZaloStatus] = useState({ status: 'loading' });
  const [showZaloModal, setShowZaloModal] = useState(false);
  const [zaloQr, setZaloQr] = useState('');
  const [zaloLoading, setZaloLoading] = useState(false);
  const [zaloError, setZaloError] = useState('');

  const handleLogout = () => {
    clearAuth();
    navigate('/login');
  };

  const navItems = [
    { path: '/', label: 'Trang chủ', icon: '🏠', getIsActive: (loc) => loc.pathname === '/' && !loc.search.includes('tab=debt') },
    { path: '/pending-orders', label: 'Tồn kho', icon: '📋' },
    { path: '/?tab=debt', label: 'Ghi nợ', icon: '📝', getIsActive: (loc) => loc.pathname === '/' && loc.search.includes('tab=debt') },
    { path: '/customers', label: 'Khách hàng', icon: '👤' },
    { path: '/timesheets', label: 'Chấm công', icon: '⏰' },
  ];

  const isActive = (item) => item.getIsActive ? item.getIsActive(location) : location.pathname === item.path;

  const loadZaloStatus = async () => {
    try {
      const response = await api.get('/zalo/status');
      setZaloStatus(response.data.data || { status: 'not_logged_in' });
      setZaloError('');
    } catch (error) {
      setZaloStatus({ status: 'error' });
      setZaloError(error.response?.data?.error || 'Không tải được trạng thái Zalo');
    }
  };

  useEffect(() => {
    loadZaloStatus();
  }, []);

  useEffect(() => {
    if (!showZaloModal) return undefined;

    const interval = setInterval(() => {
      loadZaloStatus();
    }, 3000);

    return () => clearInterval(interval);
  }, [showZaloModal]);

  useEffect(() => {
    if (!showZaloModal || zaloStatus.status !== 'pending_qr') return undefined;

    let cancelled = false;
    const loadQr = async () => {
      try {
        const response = await api.get('/zalo/qr');
        if (!cancelled) {
          setZaloQr(response.data.data?.qrDataUrl || '');
          setZaloError('');
        }
      } catch (error) {
        if (!cancelled) {
          setZaloError(error.response?.data?.error || 'QR chưa sẵn sàng');
        }
      }
    };

    loadQr();
    const interval = setInterval(loadQr, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showZaloModal, zaloStatus.status]);

  const handleOpenZaloModal = async () => {
    setShowZaloModal(true);
    setZaloQr('');
    await loadZaloStatus();
  };

  const handleStartZaloLogin = async () => {
    try {
      setZaloLoading(true);
      setZaloQr('');
      const response = await api.post('/zalo/login');
      setZaloStatus(response.data.data || { status: 'pending_qr' });
      setZaloError('');
    } catch (error) {
      setZaloError(error.response?.data?.error || 'Không thể bắt đầu đăng nhập Zalo');
    } finally {
      setZaloLoading(false);
    }
  };

  const handleLogoutZalo = async () => {
    if (!confirm('Đăng xuất Zalo của cửa hàng này?')) return;
    try {
      setZaloLoading(true);
      await api.post('/zalo/logout');
      setZaloStatus({ status: 'not_logged_in' });
      setZaloQr('');
      setZaloError('');
    } catch (error) {
      setZaloError(error.response?.data?.error || 'Đăng xuất Zalo thất bại');
    } finally {
      setZaloLoading(false);
    }
  };

  const zaloButtonLabel = zaloStatus.status === 'logged_in'
    ? `Zalo: ${zaloStatus.zaloName || 'Đã kết nối'}`
    : 'Login Zalo';

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 shadow-lg sticky top-0 z-40 pt-safe">
        <div className="flex items-center justify-between p-3 sm:p-4">
          <h1 className="text-lg sm:text-xl font-bold text-white truncate flex-1 min-w-0">
            Quản lý cửa hàng
          </h1>
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 ml-2">
            <button
              type="button"
              onClick={handleOpenZaloModal}
              className={`sm:hidden text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                zaloStatus.status === 'logged_in'
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-white/20 text-white hover:bg-white/30'
              }`}
            >
              Zalo
            </button>
            <span className="text-xs sm:text-sm text-blue-100 hidden sm:inline truncate max-w-[160px] font-medium bg-white/20 px-3 py-1.5 rounded-lg">
              {user?.name}
            </span>
            <button
              onClick={handleLogout}
              className="text-xs sm:text-sm text-white hover:text-red-200 px-3 py-1.5 sm:px-4 sm:py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all font-medium active:scale-95"
            >
              <span className="hidden sm:inline">Đăng xuất</span>
              <span className="sm:hidden">Thoát</span>
            </button>
          </div>
        </div>

        {/* Top nav (desktop/tablet) */}
        <div className="hidden sm:block bg-white/95 backdrop-blur-sm border-t border-blue-200">
          <div className="px-3 sm:px-4 md:px-6 py-2">
            <div className="flex gap-2 overflow-x-auto">
              {navItems.map((item) => (
                <Link
                  key={item.path + (item.label || '')}
                  to={item.path}
                  className={`px-4 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap transition-all duration-200 group ${
                    isActive(item)
                      ? 'bg-gradient-to-r from-blue-500 to-blue-600 text-white shadow-lg transform scale-105'
                      : 'text-gray-700 hover:bg-gray-100 hover:shadow-md hover:transform hover:scale-105 bg-white'
                  }`}
                >
                  <span className="mr-2 text-base inline-block group-hover:scale-110 transition-transform">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
              <button
                type="button"
                onClick={handleOpenZaloModal}
                className={`px-4 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap transition-all duration-200 bg-white border ${
                  zaloStatus.status === 'logged_in'
                    ? 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                    : 'text-red-600 border-red-200 hover:bg-red-50'
                }`}
              >
                {zaloButtonLabel}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="pb-6 max-sm:pb-bottom-nav">
        <div className="p-3 sm:p-4 md:p-6">
          <Outlet />
        </div>
      </main>

      {showZaloModal && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Kết nối Zalo cửa hàng</h2>
                <p className="text-xs text-gray-500 mt-0.5">Mỗi cửa hàng dùng một phiên Zalo riêng.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowZaloModal(false)}
                className="w-8 h-8 rounded-full text-gray-500 hover:bg-gray-100 text-xl leading-none"
                aria-label="Đóng"
              >
                ×
              </button>
            </div>

            <div className="p-4 space-y-4">
              {zaloStatus.status === 'logged_in' ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <div className="text-sm text-emerald-900 font-semibold">Đã kết nối Zalo</div>
                  <div className="text-sm text-emerald-800 mt-1">
                    Tên Zalo: <span className="font-semibold">{zaloStatus.zaloName || 'Không xác định'}</span>
                  </div>
                  {zaloStatus.lastLoginAt && (
                    <div className="text-xs text-emerald-700 mt-1">Lần đăng nhập: {zaloStatus.lastLoginAt}</div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    {zaloStatus.status === 'pending_qr'
                      ? 'Quét mã QR bên dưới bằng ứng dụng Zalo để kết nối cửa hàng.'
                      : 'Cửa hàng chưa đăng nhập Zalo. Bấm Login Zalo để tạo mã QR.'}
                  </div>

                  {zaloStatus.status === 'pending_qr' && (
                    <div className="flex justify-center">
                      {zaloQr ? (
                        <img
                          src={zaloQr}
                          alt="QR đăng nhập Zalo"
                          className="w-64 h-64 object-contain border rounded-lg bg-white"
                        />
                      ) : (
                        <div className="w-64 h-64 border rounded-lg bg-gray-50 flex items-center justify-center text-sm text-gray-500">
                          Đang tải QR...
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {zaloError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {zaloError}
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t bg-gray-50 flex items-center justify-end gap-2">
              {zaloStatus.status === 'logged_in' ? (
                <button
                  type="button"
                  onClick={handleLogoutZalo}
                  disabled={zaloLoading}
                  className="px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-sm font-medium disabled:opacity-60"
                >
                  Đăng xuất Zalo
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartZaloLogin}
                  disabled={zaloLoading || zaloStatus.status === 'pending_qr'}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium disabled:opacity-60"
                >
                  {zaloStatus.status === 'pending_qr' ? 'Đang chờ quét QR' : 'Login Zalo'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowZaloModal(false)}
                className="px-4 py-2 rounded-lg bg-gray-200 text-gray-800 hover:bg-gray-300 text-sm font-medium"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Nav - Mobile Only */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-lg border-t border-gray-200 shadow-2xl z-50 sm:hidden pb-safe">
        <div className="flex justify-around py-1">
          {navItems.map((item) => (
            <Link
              key={item.path + (item.label || '')}
              to={item.path}
              className={`flex flex-col items-center py-2 px-3 flex-1 min-w-0 rounded-xl mx-1 transition-all active:scale-95 ${
                isActive(item)
                  ? 'text-blue-600 bg-blue-50 transform scale-105' 
                  : 'text-gray-600 hover:text-blue-600 active:bg-gray-50'
              }`}
            >
              <span className={`text-2xl mb-1 transition-transform ${isActive(item) ? 'scale-110' : ''}`}>{item.icon}</span>
              <span className="text-[10px] font-medium truncate w-full text-center">{item.label}</span>
              {isActive(item) && (
                <span className="absolute top-0 left-1/2 transform -translate-x-1/2 w-8 h-1 bg-blue-600 rounded-b-full"></span>
              )}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}

export default EmployerLayout;
