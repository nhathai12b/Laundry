import { useEffect, useRef, useState } from 'react';
import PageSkeleton from '../components/PageSkeleton';
import { Link } from 'react-router-dom';
import api from '../utils/api';
import { isAdmin, isRoot, isMobileScreen } from '../utils/auth';
import { format } from 'date-fns';
import { getSavedFilters, saveFilters } from '../utils/filterStorage';
import { getLocalDateRangeUtc, getLocalMonthRangeUtc, getLocalYearRangeUtc } from '../utils/dateTime';
import SetupChecklist from '../components/SetupChecklist';

function Dashboard() {
  const [stats, setStats] = useState({
    todayRevenue: 0,
    todayOrders: 0,
    totalCustomers: 0,
    activeOrders: 0,
    debtOrders: 0,
  });
  const [revenueByStore, setRevenueByStore] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stores, setStores] = useState([]);
  // Lazy init to avoid reading localStorage on every render
  const [selectedStoreId, setSelectedStoreId] = useState(() => getSavedFilters().selectedStoreId);
  // Xem theo ngày / tháng / năm
  const [periodView, setPeriodView] = useState('day');
  const requestSeqRef = useRef(0);

  // Root admin statistics
  const [rootStats, setRootStats] = useState({
    overview: {},
    subscriptionPackages: [],
  });
  const [rootStatsLoading, setRootStatsLoading] = useState(true);

  const loadRootStatistics = async () => {
    try {
      setRootStatsLoading(true);
      const today = format(new Date(), 'yyyy-MM-dd');
      const dayRange = getLocalDateRangeUtc(today);
      const monthRange = getLocalMonthRangeUtc(new Date().getFullYear(), new Date().getMonth() + 1);
      const params = new URLSearchParams({
        today_start_at: dayRange.start_at,
        today_end_at: dayRange.end_at,
        month_start_at: monthRange.start_at,
        month_end_at: monthRange.end_at,
      });
      const response = await api.get(`/reports/root/statistics?${params.toString()}`);
      setRootStats(response.data.data || {
        overview: {},
        subscriptionPackages: [],
      });
    } catch (error) {
      console.error('Error loading root statistics:', error);
    } finally {
      setRootStatsLoading(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isRoot()) {
      loadRootStatistics();
    } else {
      loadData();
    }
  }, [selectedStoreId, periodView]);

  // Load stores list once for admin (avoid reloading on every store filter change)
  useEffect(() => {
    if (!isRoot() && isAdmin()) {
      loadStores();
    }
  }, []);

  // Save store filter whenever it changes
  useEffect(() => {
    if (isAdmin()) {
      // Preserve month/year filters used by other pages; only update store_id here
      const { selectedMonth, selectedYear } = getSavedFilters();
      saveFilters(selectedStoreId, selectedMonth, selectedYear);
    }
  }, [selectedStoreId]);

  const loadStores = async () => {
    try {
      const response = await api.get('/stores');
      setStores(response.data.data || []);
    } catch (error) {
      console.error('Error loading stores:', error);
    }
  };

  const loadData = async () => {
    // Đổi kỳ/cửa hàng nhanh làm các lượt tải chồng nhau — chỉ lượt MỚI NHẤT ghi state
    const requestId = ++requestSeqRef.current;
    try {
      // Không bật spinner khi refresh — giữ số liệu cũ trên màn hình (lần đầu đã có useState(true))
      const now = new Date();
      let period, range;
      if (periodView === 'day') {
        period = 'day';
        range = getLocalDateRangeUtc(format(now, 'yyyy-MM-dd'));
      } else if (periodView === 'month') {
        period = 'month';
        range = getLocalMonthRangeUtc(now.getFullYear(), now.getMonth() + 1);
      } else {
        period = 'year';
        range = getLocalYearRangeUtc(now.getFullYear());
      }

      const storeFilter = isAdmin() && selectedStoreId && selectedStoreId !== 'all' ? selectedStoreId : null;
      const withStore = (params) => {
        if (storeFilter) params.append('store_id', storeFilter);
        return params.toString();
      };
      const revenueQuery = (storeId) => {
        const params = new URLSearchParams();
        params.append('period', period);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
        params.append('timezone_offset_minutes', String(new Date().getTimezoneOffset()));
        if (storeId) params.append('store_id', storeId);
        return params.toString();
      };
      const sumRevenue = (rows) => ({
        revenue: rows.reduce((s, r) => s + (parseFloat(r.total_revenue) || 0), 0),
        orders: rows.reduce((s, r) => s + (r.total_orders || 0), 0),
      });

      // Doanh thu theo từng cửa hàng (chỉ khi xem tất cả cửa hàng)
      const loadStoreRevenues = async () => {
        if (!isAdmin() || selectedStoreId !== 'all') return [];
        let storesList = stores;
        if (storesList.length === 0) {
          const storesRes = await api.get('/stores');
          storesList = storesRes.data.data || [];
        }
        // Show all stores, even if revenue is 0 (lỗi 1 tiệm → hiện 0, không chặn tiệm khác)
        return Promise.all(storesList.map((store) => api.get(`/reports/revenue?${revenueQuery(store.id)}`)
          .then((res) => ({ store_id: store.id, store_name: store.name, ...sumRevenue(res.data.data || []) }))
          .catch((error) => {
            console.error(`Error loading revenue for store ${store.id} (${store.name}):`, error);
            return { store_id: store.id, store_name: store.name, revenue: 0, orders: 0 };
          })));
      };

      // Các khối độc lập — gọi SONG SONG (trước đây tuần tự, thời gian chờ cộng dồn).
      // Đơn đang xử lý / tổng nợ / số khách: chỉ lấy số tổng hợp (summary), trước
      // đây tải toàn bộ danh sách đơn + khách chỉ để đếm/cộng
      const [revenue, activeOrders, debtOrders, totalCustomers, storeRevenues] = await Promise.all([
        api.get(`/reports/revenue?${revenueQuery(storeFilter)}`)
          .then((res) => sumRevenue(res.data.data || []))
          .catch((error) => { console.error('Error loading revenue:', error); return { revenue: 0, orders: 0 }; }),
        api.get(`/orders?${withStore(new URLSearchParams({ active_only: 'true', summary: 'true' }))}`)
          .then((res) => res.data.summary?.order_count || 0)
          .catch((error) => { console.error('Error loading orders:', error); return 0; }),
        // Tổng tiền đang ghi nợ
        api.get(`/orders?${withStore(new URLSearchParams({ debt_only: 'true', summary: 'true' }))}`)
          .then((res) => res.data.summary?.final_amount || 0)
          .catch((error) => { console.error('Error loading debt orders:', error); return 0; }),
        api.get(`/customers?${withStore(new URLSearchParams({ summary: 'true' }))}`)
          .then((res) => res.data.summary?.count || 0)
          .catch((error) => { console.error('Error loading customers:', error); return 0; }),
        loadStoreRevenues()
          .catch((error) => { console.error('Error loading revenue by store:', error); return []; }),
      ]);
      if (requestId !== requestSeqRef.current) return;

      setStats({
        todayRevenue: revenue.revenue,
        todayOrders: revenue.orders,
        totalCustomers,
        activeOrders,
        debtOrders,
      });
      setRevenueByStore(storeRevenues);
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      if (requestId === requestSeqRef.current) setLoading(false);
    }
  };

  // Root admin dashboard
  if (isRoot()) {
    if (rootStatsLoading) {
      return (
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <div className="text-gray-600">Đang tải...</div>
          </div>
        </div>
      );
    }
    const { overview, subscriptionPackages } = rootStats;
    
    const packageLabels = {
      '1month': '1 tháng',
      '3months': '3 tháng',
      '6months': '6 tháng',
      '1year': '1 năm',
      'Không có': 'Không có gói'
    };
    
    return (
      <div className="space-y-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Dashboard - Root Admin</h1>
        </div>

        {/* Main Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Pending Admins */}
          <div className="bg-gradient-to-br from-orange-50 to-orange-100 rounded-xl shadow-lg p-6 border border-orange-200 hover:shadow-xl transition-all duration-300">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-medium text-orange-700 uppercase tracking-wide">Tài khoản chờ duyệt</div>
              <div className="text-2xl">⏳</div>
            </div>
            <div className="text-5xl font-bold text-orange-600 mb-2">{overview.pendingAdmins || 0}</div>
            <div className="text-xs text-orange-600 font-medium">Admin đang chờ phê duyệt</div>
          </div>

          {/* Active Admins */}
          <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl shadow-lg p-6 border border-blue-200 hover:shadow-xl transition-all duration-300">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-medium text-blue-700 uppercase tracking-wide">Admin đang hoạt động</div>
              <div className="text-2xl">👥</div>
            </div>
            <div className="text-5xl font-bold text-blue-600 mb-2">{overview.totalAdmins || 0}</div>
            <div className="text-xs text-blue-600 font-medium">Tổng số admin active</div>
          </div>

          {/* Subscription Packages */}
          <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-xl shadow-lg p-6 border border-green-200 hover:shadow-xl transition-all duration-300">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-medium text-green-700 uppercase tracking-wide">Tổng số gói đăng ký</div>
              <div className="text-2xl">📦</div>
            </div>
            <div className="text-5xl font-bold text-green-600 mb-2">
              {subscriptionPackages?.reduce((sum, pkg) => sum + (pkg.count || 0), 0) || 0}
            </div>
            <div className="text-xs text-green-600 font-medium">Tổng số admin có gói</div>
          </div>
        </div>

        {/* Subscription Packages Breakdown */}
        {subscriptionPackages && subscriptionPackages.length > 0 && (
          <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
            <div className="bg-gradient-to-r from-indigo-500 to-purple-600 p-6">
              <h2 className="text-xl font-bold text-white">Các gói đăng ký đang sử dụng</h2>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {subscriptionPackages.map((pkg) => (
                  <div key={pkg.package} className="bg-gradient-to-br from-indigo-50 to-purple-50 border-2 border-indigo-200 rounded-xl p-5 hover:shadow-md transition-all duration-300">
                    <div className="text-sm font-medium text-indigo-700 mb-2">Gói {packageLabels[pkg.package] || pkg.package}</div>
                    <div className="text-3xl font-bold text-indigo-600 mb-1">{pkg.count || 0}</div>
                    <div className="text-xs text-indigo-500 font-medium">admin</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link
            to="/admin/admin-management"
            className="bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-xl p-6 text-center hover:from-blue-700 hover:to-blue-800 transition-all duration-300 shadow-lg hover:shadow-xl transform hover:-translate-y-1"
          >
            <div className="text-4xl mb-3">👑</div>
            <div className="font-semibold text-lg">Quản lý Admin</div>
          </Link>
        </div>
      </div>
    );
  }

  // Regular admin/employer dashboard
  if (loading) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Checklist thiết lập ban đầu chỉ hiện trên desktop — ẩn trên mobile.
          Dùng Tailwind breakpoint (md = 768px, khớp isMobileScreen) thay vì
          gọi hàm lúc render để tự phản ứng khi xoay màn hình/resize */}
      <div className="hidden md:block">
        <SetupChecklist />
      </div>
      <div className="mb-6 flex flex-wrap items-end gap-4 justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Dashboard</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Xem theo</label>
            <select
              value={periodView}
              onChange={(e) => setPeriodView(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg text-base bg-white shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="day">Ngày</option>
              <option value="month">Tháng</option>
              <option value="year">Năm</option>
            </select>
          </div>
          {isAdmin() && stores.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Lọc theo cửa hàng</label>
              <select
                value={selectedStoreId}
                onChange={(e) => setSelectedStoreId(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-base bg-white shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="all">Tất cả cửa hàng</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Revenue Section - Separated */}
      <div className="bg-gradient-to-br from-green-50 to-emerald-100 rounded-xl shadow-lg p-6 border border-green-200">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-green-800 mb-1">
              Doanh thu {periodView === 'day' ? 'hôm nay' : periodView === 'month' ? 'tháng này' : 'năm nay'}
            </h2>
            <p className="text-sm text-green-600">
              Tổng hợp doanh thu {periodView === 'day' ? 'trong ngày' : periodView === 'month' ? 'trong tháng' : 'trong năm'}
            </p>
          </div>
          <div className="text-4xl">💰</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="bg-white rounded-lg p-4 border border-green-200">
            <div className="text-xs font-medium text-green-700 uppercase tracking-wide mb-2">Tổng doanh thu</div>
            <div className="text-2xl font-bold text-green-600">
              {new Intl.NumberFormat('vi-VN').format(parseFloat(stats.todayRevenue) || 0)} đ
            </div>
          </div>
          <div className="bg-white rounded-lg p-4 border border-green-200">
            <div className="text-xs font-medium text-green-700 uppercase tracking-wide mb-2">Số đơn hoàn thành</div>
            <div className="text-2xl font-bold text-green-600">{stats.todayOrders}</div>
          </div>
          <div className="bg-white rounded-lg p-4 border border-amber-200">
            <div className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-2">Tổng tiền đang ghi nợ</div>
            <div className="text-2xl font-bold text-amber-600">
              {new Intl.NumberFormat('vi-VN').format(parseFloat(stats.debtOrders) || 0)} đ
            </div>
          </div>
        </div>
        
        {/* Revenue by Store removed from here and moved to separate section below */}
      </div>

      {/* Store Revenue - separated section (only when viewing all stores) */}
      {isAdmin() && selectedStoreId === 'all' && revenueByStore.length > 0 && (
        <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 rounded-xl shadow-lg p-6 border border-indigo-200 mt-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-bold text-indigo-800 mb-1">Doanh thu theo từng cửa hàng</h3>
              <p className="text-sm text-indigo-600">Tổng hợp doanh thu trong ngày</p>
            </div>
            <div className="text-2xl">🏬</div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {revenueByStore.map((store) => (
              <div key={store.store_id} className="bg-white rounded-lg p-3 border border-indigo-200">
                <div className="text-xs font-medium text-indigo-700 mb-1">{store.store_name}</div>
                <div className="text-lg font-bold text-indigo-600">
                  {new Intl.NumberFormat('vi-VN').format(parseFloat(store.revenue) || 0)} đ
                </div>
                <div className="text-xs text-indigo-600 mt-1">{store.orders} đơn</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats Grid — thẻ "Đơn hôm nay" đã bỏ: trùng "Số đơn hoàn thành" ở khối
          doanh thu phía trên (cùng stats.todayOrders), và nhãn sai khi xem theo tháng/năm */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="bg-gradient-to-br from-purple-50 to-pink-100 rounded-xl shadow-lg p-5 border border-purple-200 hover:shadow-xl transition-all duration-300">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-purple-700 uppercase tracking-wide">Tổng khách hàng</div>
            <div className="text-xl">👤</div>
          </div>
          <div className="text-2xl font-bold text-purple-600">{stats.totalCustomers}</div>
        </div>
        <div className="bg-gradient-to-br from-orange-50 to-amber-100 rounded-xl shadow-lg p-5 border border-orange-200 hover:shadow-xl transition-all duration-300">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-orange-700 uppercase tracking-wide">Đơn đang xử lý</div>
            <div className="text-xl">⚡</div>
          </div>
          <div className="text-2xl font-bold text-orange-600">{stats.activeOrders}</div>
        </div>
      </div>

      {/* Quick Actions — ẩn trên điện thoại (admin xem trang tổng quan riêng, không dẫn sang module khác) */}
      {isAdmin() && (isRoot() || !isMobileScreen()) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Link
            to="/admin/orders"
            className="bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-xl p-6 text-center hover:from-blue-700 hover:to-blue-800 transition-all duration-300 shadow-lg hover:shadow-xl transform hover:-translate-y-1"
          >
            <div className="text-4xl mb-3">📋</div>
            <div className="font-semibold text-lg">Quản lý đơn</div>
          </Link>
          <Link
            to="/admin/products"
            className="bg-gradient-to-r from-green-600 to-green-700 text-white rounded-xl p-6 text-center hover:from-green-700 hover:to-green-800 transition-all duration-300 shadow-lg hover:shadow-xl transform hover:-translate-y-1"
          >
            <div className="text-4xl mb-3">📦</div>
            <div className="font-semibold text-lg">Sản phẩm</div>
          </Link>
          <Link
            to="/admin/users"
            className="bg-gradient-to-r from-purple-600 to-purple-700 text-white rounded-xl p-6 text-center hover:from-purple-700 hover:to-purple-800 transition-all duration-300 shadow-lg hover:shadow-xl transform hover:-translate-y-1"
          >
            <div className="text-4xl mb-3">👥</div>
            <div className="font-semibold text-lg">Nhân viên</div>
          </Link>
          <Link
            to="/admin/reports"
            className="bg-gradient-to-r from-orange-600 to-orange-700 text-white rounded-xl p-6 text-center hover:from-orange-700 hover:to-orange-800 transition-all duration-300 shadow-lg hover:shadow-xl transform hover:-translate-y-1"
          >
            <div className="text-4xl mb-3">📈</div>
            <div className="font-semibold text-lg">Báo cáo</div>
          </Link>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
