import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearAuth, getAuth, isMobileScreen } from '../../utils/auth';
import api from '../../utils/api';
import Dashboard from '../Dashboard';

const DAYS_WARNING = 14;

/**
 * Trang admin tối ưu điện thoại: chỉ xem tổng quan (Dashboard), không menu đầy đủ.
 * Admin thường trên màn hình nhỏ (dưới 768px) được chuyển tới đây từ /admin.
 */
function AdminMobileOverview() {
  const navigate = useNavigate();
  const { user } = getAuth();
  const [subscriptionExpiresAt, setSubscriptionExpiresAt] = useState(user?.subscription_expires_at || null);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    if (user?.subscription_expires_at) {
      setSubscriptionExpiresAt(user.subscription_expires_at);
      return;
    }
    api
      .get('/auth/me')
      .then((res) => {
        const exp = res.data?.user?.subscription_expires_at;
        if (exp) setSubscriptionExpiresAt(exp);
      })
      .catch(() => {});
  }, [user?.role, user?.subscription_expires_at]);

  useEffect(() => {
    const onResize = () => {
      if (!isMobileScreen()) {
        navigate('/admin', { replace: true });
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [navigate]);

  const handleLogout = () => {
    clearAuth();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 pb-8">
      <header className="sticky top-0 z-40 bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md">
        <div className="flex items-center justify-between gap-2 px-4 py-3 max-w-lg mx-auto">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold truncate">Tổng quan</h1>
            <p className="text-xs text-blue-100 truncate">{user?.name || 'Admin'}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="shrink-0 text-sm font-medium px-4 py-2 rounded-xl bg-white/20 hover:bg-white/30 active:bg-white/25"
          >
            Đăng xuất
          </button>
        </div>
        <p className="text-center text-[11px] text-blue-100 px-3 pb-2 max-w-lg mx-auto">
          Chỉ xem nhanh số liệu. Quản lý đầy đủ vui lòng dùng máy tính.
        </p>
      </header>

      <div className="max-w-lg mx-auto px-3 pt-3">
        {subscriptionExpiresAt &&
          (() => {
            const expires = new Date(subscriptionExpiresAt);
            const now = new Date();
            const isExpired = expires < now;
            const daysLeft = Math.ceil((expires - now) / (24 * 60 * 60 * 1000));
            const soon = !isExpired && daysLeft <= DAYS_WARNING;
            if (!isExpired && !soon) return null;
            const label = isExpired
              ? `Gói đã hết hạn (${expires.toLocaleDateString('vi-VN')}). Liên hệ root admin để gia hạn.`
              : `Gói sắp hết hạn (còn ${daysLeft} ngày). Liên hệ root admin.`;
            return (
              <div className="mb-3 rounded-xl border-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {label}
              </div>
            );
          })()}

        <div className="rounded-2xl bg-white/80 shadow-sm border border-slate-200/80 overflow-hidden">
          <Dashboard />
        </div>
      </div>
    </div>
  );
}

export default AdminMobileOverview;
