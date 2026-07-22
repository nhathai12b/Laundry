import { useEffect, useRef, useState } from 'react';
import api from '../utils/api';
import { isAdmin } from '../utils/auth';
import { format, getDaysInMonth } from 'date-fns';
import { getSavedFilters, saveFilters } from '../utils/filterStorage';

function Customers() {
  const savedFilters = getSavedFilters();
  const [customers, setCustomers] = useState([]);
  const [allCustomers, setAllCustomers] = useState([]);
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(savedFilters.selectedStoreId);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState(isAdmin() ? 'day' : 'all'); // 'day', 'month', 'year', 'all'
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedMonth, setSelectedMonth] = useState(savedFilters.selectedMonth);
  const [selectedYear, setSelectedYear] = useState(savedFilters.selectedYear);
  // Tracks the latest search input so typing fast doesn't trigger a request per
  // keystroke, and guards against an older (slower) request response
  // overwriting the results of a newer one that already resolved.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (isAdmin()) {
      loadStores();
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    loadCustomers();
  }, [debouncedSearch, viewMode, selectedDate, selectedMonth, selectedYear, selectedStoreId]);

  // Save filters whenever they change
  useEffect(() => {
    if (isAdmin()) {
      saveFilters(selectedStoreId, selectedMonth, selectedYear);
    }
  }, [selectedStoreId, selectedMonth, selectedYear]);

  const loadStores = async () => {
    try {
      const response = await api.get('/stores');
      setStores(response.data.data || []);
    } catch (error) {
      console.error('Error loading stores:', error);
    }
  };

  const loadCustomers = async () => {
    const seq = ++requestSeqRef.current;
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (debouncedSearch) {
        params.append('search', debouncedSearch);
      }
      if (isAdmin() && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }
      const queryString = params.toString();
      const response = await api.get(`/customers${queryString ? '?' + queryString : ''}`);
      if (seq !== requestSeqRef.current) return; // a newer request has already started
      const allCustomersData = response.data.data || [];
      setAllCustomers(allCustomersData);

      // Filter by date/month/year if admin
      if (isAdmin() && (viewMode === 'day' || viewMode === 'month' || viewMode === 'year')) {
        // Get orders for the selected period
        const ordersParams = new URLSearchParams();
        if (viewMode === 'day') {
          ordersParams.append('date', selectedDate);
        } else if (viewMode === 'month') {
          const startDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
          const daysInMonth = getDaysInMonth(new Date(selectedYear, selectedMonth - 1));
          const endDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
          ordersParams.append('start_date', startDate);
          ordersParams.append('end_date', endDate);
        } else if (viewMode === 'year') {
          const startDate = `${selectedYear}-01-01`;
          const endDate = `${selectedYear}-12-31`;
          ordersParams.append('start_date', startDate);
          ordersParams.append('end_date', endDate);
        }
        
        if (selectedStoreId !== 'all') {
          ordersParams.append('store_id', selectedStoreId);
        }

        const ordersResponse = await api.get(`/orders?${ordersParams.toString()}`);
        if (seq !== requestSeqRef.current) return; // a newer request has already started
        const orders = ordersResponse.data.data || [];
        
        // Get unique customer IDs from orders
        const customerIds = new Set(orders.map(o => o.customer_id).filter(Boolean));
        
        // Filter customers
        const filteredCustomers = allCustomersData.filter(c => customerIds.has(c.id));
        setCustomers(filteredCustomers);
      } else {
        setCustomers(allCustomersData);
      }
    } catch (error) {
      console.error('Error loading customers:', error);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <div className="text-gray-600">Đang tải...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-1 sm:mb-2">Khách hàng</h1>
          <p className="text-sm sm:text-base text-gray-600">Danh sách khách hàng</p>
        </div>
        {isAdmin() && stores.length > 0 && (
          <div className="w-full sm:w-auto">
            <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">Lọc theo cửa hàng</label>
            <select
              value={selectedStoreId}
              onChange={(e) => setSelectedStoreId(e.target.value)}
              className="w-full sm:w-auto px-3 sm:px-4 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm sm:text-base bg-white shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 touch-manipulation"
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

      {/* View Mode - Admin */}
      {isAdmin() && (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => setViewMode('day')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300 ${
                viewMode === 'day'
                  ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg transform scale-105'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 hover:shadow-md'
              }`}
            >
              Theo ngày
            </button>
            <button
              onClick={() => setViewMode('month')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                viewMode === 'month'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              Theo tháng
            </button>
            <button
              onClick={() => setViewMode('year')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                viewMode === 'year'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              Theo năm
            </button>
          </div>
          
          {viewMode === 'day' && (
            <div className="flex items-center gap-2">
              <select
                value={selectedYear}
                onChange={(e) => {
                  const year = parseInt(e.target.value);
                  setSelectedYear(year);
                  const newDate = `${year}-${String(selectedMonth).padStart(2, '0')}-01`;
                  setSelectedDate(newDate);
                }}
                className="px-2 py-1.5 border rounded text-xs"
              >
                {Array.from({ length: 5 }, (_, i) => {
                  const year = new Date().getFullYear() - 2 + i;
                  return <option key={year} value={year}>{year}</option>;
                })}
              </select>
              <select
                value={selectedMonth}
                onChange={(e) => {
                  const month = parseInt(e.target.value);
                  setSelectedMonth(month);
                  const newDate = `${selectedYear}-${String(month).padStart(2, '0')}-01`;
                  setSelectedDate(newDate);
                }}
                className="px-2 py-1.5 border rounded text-xs"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>Tháng {i + 1}</option>
                ))}
              </select>
              <select
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="px-2 py-1.5 border rounded text-xs flex-1"
              >
                {Array.from({ length: getDaysInMonth(new Date(selectedYear, selectedMonth - 1)) }, (_, i) => {
                  const day = i + 1;
                  const dateStr = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const date = new Date(dateStr);
                  const dayName = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][date.getDay()];
                  const isToday = dateStr === format(new Date(), 'yyyy-MM-dd');
                  return (
                    <option key={dateStr} value={dateStr}>
                      {isToday ? `Hôm nay - ${day}/${selectedMonth} (${dayName})` : `${day}/${selectedMonth} (${dayName})`}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          
          {viewMode === 'month' && (
            <div className="flex items-center gap-2">
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
                className="px-2 py-1.5 border rounded text-xs"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>Tháng {i + 1}</option>
                ))}
              </select>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                className="px-2 py-1.5 border rounded text-xs"
              >
                {Array.from({ length: 5 }, (_, i) => {
                  const year = new Date().getFullYear() - 2 + i;
                  return <option key={year} value={year}>{year}</option>;
                })}
              </select>
            </div>
          )}

          {viewMode === 'year' && (
            <div className="flex items-center gap-2">
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                className="px-2 py-1.5 border rounded text-xs"
              >
                {Array.from({ length: 5 }, (_, i) => {
                  const year = new Date().getFullYear() - 2 + i;
                  return <option key={year} value={year}>{year}</option>;
                })}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <div className="bg-white rounded-lg shadow p-3 sm:p-2">
        <input
          type="text"
          placeholder="Tìm kiếm theo tên hoặc SĐT..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-3 sm:py-1.5 border rounded-lg text-sm sm:text-xs touch-manipulation"
          autoComplete="off"
        />
      </div>

      {/* Customers Table - Admin */}
      {isAdmin() ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Tên khách hàng</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">SĐT</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Tổng đơn</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Tổng chi tiêu</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ghi chú</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {customers.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-4 py-8 text-center text-gray-500">
                      Chưa có khách hàng
                    </td>
                  </tr>
                ) : (
                  customers.map((customer) => (
                    <tr key={customer.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-800">{customer.name || 'Chưa có tên'}</td>
                      <td className="px-4 py-3 text-gray-600">{customer.phone}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{customer.total_orders || 0}</td>
                      <td className="px-4 py-3 text-right font-bold text-gray-800">
                        {new Intl.NumberFormat('vi-VN').format(customer.total_spent || 0)} đ
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-sm">{customer.note || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
              {customers.length > 0 && (
                <tfoot className="bg-gray-50 font-semibold">
                  <tr>
                    <td colSpan="2" className="px-4 py-3 text-gray-800">Tổng cộng</td>
                    <td className="px-4 py-3 text-right text-gray-800">
                      {customers.reduce((sum, c) => sum + (c.total_orders || 0), 0)}
                    </td>
                    <td className="px-4 py-3 text-right text-green-600">
                      {new Intl.NumberFormat('vi-VN').format(customers.reduce((sum, c) => sum + (c.total_spent || 0), 0))} đ
                    </td>
                    <td className="px-4 py-3"></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      ) : (
        /* Customers List - Non-admin */
        <div className="space-y-3">
          {customers.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-6 sm:p-8 text-center text-gray-500">
              <div className="text-4xl sm:text-6xl mb-3">👤</div>
              <p className="text-sm sm:text-base">Chưa có khách hàng</p>
            </div>
          ) : (
            customers.map((customer) => (
              <div key={customer.id} className="bg-white rounded-lg shadow p-3 sm:p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-base sm:text-lg text-gray-800 mb-2 truncate">
                      {customer.name || 'Chưa có tên'}
                    </div>
                    <div className="text-xs sm:text-sm text-gray-600 space-y-1">
                      <p className="break-all">
                        <span className="font-medium">SĐT:</span> {customer.phone}
                      </p>
                      <p>
                        <span className="font-medium">Tổng đơn:</span> {customer.total_orders}
                      </p>
                      <p>
                        <span className="font-medium">Tổng chi tiêu:</span>{' '}
                        {new Intl.NumberFormat('vi-VN').format(parseFloat(customer.total_spent) || 0)} đ
                      </p>
                      {customer.note && (
                        <p className="break-words">
                          <span className="font-medium">Ghi chú:</span> {customer.note}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default Customers;
