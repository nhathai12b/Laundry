import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../utils/api';
import { isAdmin, isRoot, isMobileScreen } from '../utils/auth';
import { format, startOfMonth, endOfMonth, startOfYear, endOfYear } from 'date-fns';
import { getSavedFilters, saveFilters } from '../utils/filterStorage';

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

  // Root admin statistics
  const [rootStats, setRootStats] = useState({
    overview: {},
    subscriptionPackages: [],
  });
  const [rootStatsLoading, setRootStatsLoading] = useState(true);

  const loadRootStatistics = async () => {
    try {
      setRootStatsLoading(true);
      const response = await api.get('/reports/root/statistics');
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
    try {
      setLoading(true);
      const now = new Date();
      let startDate, endDate, period;
      if (periodView === 'day') {
        startDate = endDate = format(now, 'yyyy-MM-dd');
        period = 'day';
      } else if (periodView === 'month') {
        startDate = format(startOfMonth(now), 'yyyy-MM-dd');
        endDate = format(endOfMonth(now), 'yyyy-MM-dd');
        period = 'month';
      } else {
        startDate = format(startOfYear(now), 'yyyy-MM-dd');
        endDate = format(endOfYear(now), 'yyyy-MM-dd');
        period = 'year';
      }

      // Get revenue and orders count for the period
      let todayRevenue = 0;
      let todayOrders = 0;
      try {
        const params = new URLSearchParams();
        params.append('period', period);
        params.append('start_date', startDate);
        params.append('end_date', endDate);
        if (isAdmin() && selectedStoreId && selectedStoreId !== 'all') {
          params.append('store_id', selectedStoreId);
        }
        const revenueRes = await api.get(`/reports/revenue?${params.toString()}`);
        const revenueData = revenueRes.data.data || [];
        todayRevenue = revenueData.reduce((s, r) => s + (parseFloat(r.total_revenue) || 0), 0);
        todayOrders = revenueData.reduce((s, r) => s + (r.total_orders || 0), 0);
      } catch (error) {
        console.error('Error loading revenue:', error);
      }
      
      // Get active orders count (unchanged - current pending)
      let activeOrders = 0;
      try {
        const params = new URLSearchParams();
        params.append('limit', '100');
        if (isAdmin() && selectedStoreId && selectedStoreId !== 'all') {
          params.append('store_id', selectedStoreId);
        }
        const ordersRes = await api.get(`/orders?${params.toString()}`);
        const orders = ordersRes.data.data || [];
        activeOrders = orders.filter(
          (o) => !['completed', 'cancelled'].includes(o.status)
        ).length;
      } catch (error) {
        console.error('Error loading orders:', error);
      }

      // Get total amount of debt orders (tổng tiền đang ghi nợ)
      let debtOrders = 0;
      try {
        const params = new URLSearchParams();
        params.append('debt_only', 'true');
        if (isAdmin() && selectedStoreId && selectedStoreId !== 'all') {
          params.append('store_id', selectedStoreId);
        }
        const debtRes = await api.get(`/orders?${params.toString()}`);
        const debtList = debtRes.data.data || [];
        debtOrders = debtList.reduce((s, o) => s + (parseFloat(o.final_amount) || parseFloat(o.total_amount) || 0), 0);
      } catch (error) {
        console.error('Error loading debt orders:', error);
      }
      
      // Get customers count
      let totalCustomers = 0;
      try {
        const params = new URLSearchParams();
        if (isAdmin() && selectedStoreId && selectedStoreId !== 'all') {
          params.append('store_id', selectedStoreId);
        }
        const customersRes = await api.get(`/customers?${params.toString()}`);
        totalCustomers = customersRes.data.data?.length || 0;
      } catch (error) {
        console.error('Error loading customers:', error);
      }

      // Get revenue by store (only when viewing all stores)
      let storeRevenues = [];
      if (isAdmin() && selectedStoreId === 'all') {
        try {
          // Get stores list if not already loaded
          let storesList = stores;
          if (storesList.length === 0) {
            const storesRes = await api.get('/stores');
            storesList = storesRes.data.data || [];
          }
          
          // Get revenue for each store separately (same period as overview)
          for (const store of storesList) {
            try {
              const storeParams = new URLSearchParams();
              storeParams.append('period', period);
              storeParams.append('start_date', startDate);
              storeParams.append('end_date', endDate);
              storeParams.append('store_id', store.id);
              const url = `/reports/revenue?${storeParams.toString()}`;
              // Debug log removed for security
              const storeRevenueRes = await api.get(url);
              const storeRevenueRows = storeRevenueRes.data.data || [];
              const storeRevenue = storeRevenueRows.reduce((s, r) => s + (parseFloat(r.total_revenue) || 0), 0);
              const storeOrdersCount = storeRevenueRows.reduce((s, r) => s + (r.total_orders || 0), 0);
              
              // Debug log removed for security
              
              // Show all stores, even if revenue is 0
              storeRevenues.push({
                store_id: store.id,
                store_name: store.name,
                revenue: storeRevenue,
                orders: storeOrdersCount,
              });
            } catch (error) {
              console.error(`Error loading revenue for store ${store.id} (${store.name}):`, error);
              // Still add store with 0 revenue if error
              storeRevenues.push({
                store_id: store.id,
                store_name: store.name,
                revenue: 0,
                orders: 0,
              });
            }
          }
          // Debug log removed for security
        } catch (error) {
          console.error('Error loading revenue by store:', error);
        }
      }

      setStats({
        todayRevenue,
        todayOrders,
        totalCustomers,
        activeOrders,
        debtOrders,
      });
      setRevenueByStore(storeRevenues);
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
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
          <p className="text-gray-600">Tổng quan hệ thống</p>
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
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <div className="text-gray-600">Đang tải dữ liệu...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="mb-6 flex flex-wrap items-end gap-4 justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Dashboard</h1>
          <p className="text-gray-600">Tổng quan hệ thống</p>
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

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="bg-gradient-to-br from-blue-50 to-cyan-100 rounded-xl shadow-lg p-5 border border-blue-200 hover:shadow-xl transition-all duration-300">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-medium text-blue-700 uppercase tracking-wide">Đơn hôm nay</div>
            <div className="text-xl">📋</div>
          </div>
          <div className="text-2xl font-bold text-blue-600">{stats.todayOrders}</div>
        </div>
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

