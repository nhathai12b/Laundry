import { useEffect, useState } from 'react';
import api from '../utils/api';
import { isAdmin, isEmployer, getAuth, isRoot } from '../utils/auth';
import { format, getDaysInMonth } from 'date-fns';
import { getSavedFilters, saveFilters } from '../utils/filterStorage';
import { printBill } from '../utils/printBill';
import MoneyInput from '../components/MoneyInput';
import { bestApplicablePromotionId } from '../utils/promotions';
import {
  formatLocalDateKey,
  getLocalDateRangeUtc,
  getLocalMonthRangeUtc,
  getLocalYearRangeUtc,
} from '../utils/dateTime';

function Orders() {
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const savedFilters = getSavedFilters();
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(savedFilters.selectedStoreId);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [viewMode, setViewMode] = useState(isAdmin() ? 'day' : 'all'); // 'day', 'month', 'year', 'all'
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedMonth, setSelectedMonth] = useState(savedFilters.selectedMonth);
  const [selectedYear, setSelectedYear] = useState(savedFilters.selectedYear);
  const [filters, setFilters] = useState({
    status: '',
    customer_phone: '',
    my_orders: !isAdmin(),
  });
  const [formData, setFormData] = useState({
    customer_name: '',
    customer_phone: '0',
    items: [{ product_id: '', quantity: '' }],
    note: '',
    assigned_to: '',
    promotion_id: '',
  });
  const [applicablePromotions, setApplicablePromotions] = useState([]);
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [showCustomerSuggestions, setShowCustomerSuggestions] = useState(false);
  const [searchTimeout, setSearchTimeout] = useState(null);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [orderToComplete, setOrderToComplete] = useState(null);
  const [shouldPrint, setShouldPrint] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [customAmountPaid, setCustomAmountPaid] = useState('');

  // Load products and stores only once on mount
  useEffect(() => {
    if (isAdmin()) {
      loadStores();
      loadProducts();
      loadUsers();
    } else {
      loadProducts();
    }
  }, []); // Empty dependency array - only run once on mount

  // Filter products by selected store (for admin)
  useEffect(() => {
    if (isAdmin()) {
      if (selectedStoreId === 'all') {
        setProducts(allProducts.filter(p => p.status === 'active'));
      } else {
        setProducts(allProducts.filter(p => p.store_id === parseInt(selectedStoreId) && p.status === 'active'));
      }
    }
  }, [selectedStoreId, allProducts, isAdmin]);

  // Load orders when filters/date change
  useEffect(() => {
    loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, viewMode, selectedDate, selectedMonth, selectedYear, selectedStoreId]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeout) {
        clearTimeout(searchTimeout);
      }
    };
  }, [searchTimeout]);

  // Save filters whenever they change
  useEffect(() => {
    if (isAdmin()) {
      saveFilters(selectedStoreId, selectedMonth, selectedYear);
    }
  }, [selectedStoreId, selectedMonth, selectedYear]);

  const loadOrders = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filters.status) params.append('status', filters.status);
      if (filters.customer_phone) params.append('customer_phone', filters.customer_phone);
      if (filters.my_orders) params.append('my_orders', 'true');
      if (isAdmin() && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }

      // Admin view mode filters
      if (isAdmin() && viewMode === 'day') {
        const range = getLocalDateRangeUtc(selectedDate);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      } else if (isAdmin() && viewMode === 'month') {
        const range = getLocalMonthRangeUtc(selectedYear, selectedMonth);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      } else if (isAdmin() && viewMode === 'year') {
        const range = getLocalYearRangeUtc(selectedYear);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      }

      const response = await api.get(`/orders?${params.toString()}`);
      let allOrders = response.data.data || [];
      
      // Filter by date if day mode (additional client-side filter for safety)
      if (isAdmin() && viewMode === 'day') {
        allOrders = allOrders.filter(order => {
          const orderDate = formatLocalDateKey(order.created_at);
          return orderDate === selectedDate;
        });
      }

      setOrders(allOrders);
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadStores = async () => {
    try {
      const response = await api.get('/stores');
      setStores(response.data.data || []);
    } catch (error) {
      console.error('Error loading stores:', error);
    }
  };

  const loadProducts = async () => {
    try {
      if (isAdmin()) {
        // Admin: load all products, then filter by store and status
        const response = await api.get('/products');
        const productsData = response.data.data || [];
        // Debug log removed for security
        setAllProducts(productsData);
        // Apply current filter
        if (selectedStoreId === 'all') {
          const filtered = productsData.filter(p => p.status === 'active');
          // Debug log removed for security
          setProducts(filtered);
        } else {
          const filtered = productsData.filter(p => p.store_id === parseInt(selectedStoreId) && p.status === 'active');
          // Debug log removed for security
          setProducts(filtered);
        }
      } else {
        // Non-admin (employer): only load active products (backend will filter by store)
        const response = await api.get('/products?status=active');
        const productsData = response.data.data || [];
        // Debug log removed for security
        setProducts(productsData);
      }
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const loadUsers = async () => {
    try {
      const response = await api.get('/users');
      setUsers(response.data.data || []);
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  const handleStatusChange = async (orderId, newStatus) => {
    try {
      await api.post(`/orders/${orderId}/status`, { status: newStatus });
      loadOrders();
    } catch (error) {
      alert(error.response?.data?.error || 'Cập nhật thất bại');
    }
  };

  const handleCompleteClick = (order) => {
    setOrderToComplete(order);
    setShowCompleteModal(true);
    setShouldPrint(false);
  };

  const handleMarkDebt = async (order) => {
    if (!confirm(`Chuyển đơn ${order.code} sang ghi nợ? Đơn sẽ không tính doanh thu cho đến khi nhân viên bấm "Đã thanh toán" trong menu Ghi nợ.`)) return;
    try {
      // Completing with amount_paid:0 already flags the order as debt server-side.
      // The old code then also PATCHed /debt, which 400s ("đã ở trạng thái ghi nợ")
      // and made a successful action always alert failure.
      if (order.status !== 'completed') {
        await api.post(`/orders/${order.id}/status`, {
          status: 'completed',
          amount_paid: 0,
          delivery_method: 'pickup',
        });
      } else {
        await api.patch(`/orders/${order.id}/debt`);
      }
      loadOrders();
    } catch (error) {
      alert(error.response?.data?.error || 'Thao tác thất bại');
    }
  };

  const handleCompleteOrder = async () => {
    if (!orderToComplete) return;

    try {
      if (!paymentMethod) {
        alert('Vui lòng chọn hình thức thanh toán');
        return;
      }

      const maxAmount = parseFloat(orderToComplete.final_amount || orderToComplete.total_amount || 0) || 0;
      let amountPaid = null;
      if (customAmountPaid !== '') {
        amountPaid = parseFloat(customAmountPaid);
        if (isNaN(amountPaid) || amountPaid < 0) {
          alert('Số tiền thanh toán phải là số không âm');
          return;
        }
        if (amountPaid > maxAmount + 0.01) {
          alert(`Số tiền thanh toán không được vượt quá ${maxAmount.toLocaleString('vi-VN')} đ`);
          return;
        }
      }

      const payload = {
        status: 'completed',
        payment_method: paymentMethod
      };
      if (amountPaid !== null) {
        payload.amount_paid = Math.round(amountPaid * 100) / 100;
      }
      await api.post(`/orders/${orderToComplete.id}/status`, payload);

      // Print bill if selected
      if (shouldPrint) {
        setPrinting(true);
        try {
          const result = await printBill(orderToComplete.id);
          alert(`Đơn hàng đã hoàn thành và bill đã được in! (Phương thức: ${result.method === 'bluetooth' ? 'Bluetooth' : 'Server'})`);
        } catch (printError) {
          console.error('Print error:', printError);
          alert(printError.message || 'Đơn hàng đã hoàn thành nhưng in bill thất bại. Vui lòng kiểm tra kết nối máy in.');
        } finally {
          setPrinting(false);
        }
      } else {
        alert('Đơn hàng đã hoàn thành!');
      }

      setShowCompleteModal(false);
      setOrderToComplete(null);
      setShouldPrint(false);
      setPaymentMethod('cash');
      setCustomAmountPaid('');
      loadOrders();
    } catch (error) {
      alert(error.response?.data?.error || 'Cập nhật thất bại');
      setPrinting(false);
    }
  };

  const handleAddItem = () => {
    setFormData({
      ...formData,
      items: [...formData.items, { product_id: '', quantity: '' }],
    });
  };

  const handleRemoveItem = (index) => {
    const newItems = formData.items.filter((_, i) => i !== index);
    setFormData({ ...formData, items: newItems });
    calculateTotalAndLoadPromotions(newItems);
  };

  const handleItemChange = (index, field, value) => {
    const newItems = [...formData.items];
    newItems[index][field] = value;
    setFormData({ ...formData, items: newItems });
    
    // Calculate total and load applicable promotions when items change
    if (field === 'product_id' || field === 'quantity') {
      calculateTotalAndLoadPromotions(newItems);
    }
  };

  // Search customers for autocomplete
  const searchCustomers = async (query) => {
    if (!query || query.trim().length < 2) {
      setCustomerSuggestions([]);
      setShowCustomerSuggestions(false);
      return;
    }

    try {
      // Get store_id for filtering
      let storeId = null;
      if (isAdmin() && selectedStoreId !== 'all') {
        storeId = parseInt(selectedStoreId);
      } else if (!isAdmin()) {
        const { user } = getAuth();
        storeId = user?.store_id || null;
      }

      const params = new URLSearchParams();
      params.append('search', query.trim());
      if (storeId) {
        params.append('store_id', storeId);
      }

      const response = await api.get(`/customers?${params.toString()}&limit=10`);
      const customers = response.data.data || [];
      setCustomerSuggestions(customers);
      setShowCustomerSuggestions(customers.length > 0);
    } catch (error) {
      console.error('Error searching customers:', error);
      setCustomerSuggestions([]);
      setShowCustomerSuggestions(false);
    }
  };

  const handleCustomerSelect = (customer) => {
    setFormData({
      ...formData,
      customer_name: customer.name || '',
      customer_phone: customer.phone || '',
    });
    setShowCustomerSuggestions(false);
    setCustomerSuggestions([]);
    
    calculateTotalAndLoadPromotions(formData.items, customer.phone);
  };

  const calculateTotalAndLoadPromotions = async (items, customerPhone = null) => {
    // Calculate total
    let total = 0;
    for (const item of items) {
      if (item.product_id && item.quantity) {
        const product = products.find(p => p.id === parseInt(item.product_id));
        if (product) {
          total += product.price * parseFloat(item.quantity);
        }
      }
    }

    const phoneToUse =
      customerPhone !== undefined && customerPhone !== null
        ? customerPhone
        : formData.customer_phone;
    const phoneParam =
      phoneToUse && String(phoneToUse).trim() && String(phoneToUse).trim() !== '0'
        ? String(phoneToUse).trim()
        : null;

    if (total > 0) {
      try {
        let storeId = null;
        if (isAdmin() && selectedStoreId !== 'all') {
          storeId = parseInt(selectedStoreId);
        } else if (!isAdmin()) {
          const { user } = getAuth();
          storeId = user?.store_id || null;
        }

        const customerResponse = await api.post('/promotions/applicable', {
          customer_phone: phoneParam,
          bill_amount: total,
          store_id: storeId,
        });
        const promotions = customerResponse.data.data || [];
        setApplicablePromotions(promotions);
        const bestId = bestApplicablePromotionId(promotions, total);
        setFormData((prev) => ({ ...prev, promotion_id: bestId }));
      } catch (error) {
        console.error('Error loading promotions:', error);
        setApplicablePromotions([]);
        setFormData((prev) => ({ ...prev, promotion_id: '' }));
      }
    } else {
      setApplicablePromotions([]);
      setFormData((prev) => ({ ...prev, promotion_id: '' }));
    }
  };

  const handleSubmitOrder = async (e) => {
    e.preventDefault();
    try {
      const orderData = {
        customer_name: formData.customer_name,
        customer_phone: formData.customer_phone || null,
        items: formData.items
          .filter((item) => item.product_id && item.quantity)
          .map((item) => ({
            product_id: parseInt(item.product_id),
            quantity: parseFloat(item.quantity),
          })),
        note: formData.note,
        assigned_to: formData.assigned_to || null,
        promotion_id: formData.promotion_id || null,
      };

      if (orderData.items.length === 0) {
        alert('Vui lòng thêm ít nhất một sản phẩm');
        return;
      }

      await api.post('/orders', orderData);
      setShowModal(false);
      setFormData({
        customer_name: '',
        customer_phone: '0',
        items: [{ product_id: '', quantity: '' }],
        note: '',
        assigned_to: '',
        promotion_id: '',
      });
      setApplicablePromotions([]);
      loadOrders();
    } catch (error) {
      alert(error.response?.data?.error || 'Tạo đơn thất bại');
    }
  };

  const statusColors = {
    created: 'bg-gray-100 text-gray-800',
    completed: 'bg-green-100 text-green-800',
  };

  const statusLabels = {
    created: 'Đã tạo',
    completed: 'Hoàn thành',
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
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Đơn hàng</h1>
          <p className="text-gray-600">Quản lý đơn hàng</p>
        </div>
        {!isAdmin() && (
          <button
            onClick={() => setShowModal(true)}
            className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-3 rounded-xl hover:from-blue-700 hover:to-blue-800 font-semibold shadow-lg hover:shadow-xl transition-all duration-300 transform hover:-translate-y-0.5"
          >
            + Tạo đơn
          </button>
        )}
      </div>

      {/* Filters and View Mode - Admin */}
      {isAdmin() && (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Lọc theo cửa hàng</label>
                <select
                  value={selectedStoreId}
                  onChange={(e) => setSelectedStoreId(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">Tất cả cửa hàng</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
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
            <button
              onClick={() => setShowModal(true)}
              className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-4 py-2 rounded-lg hover:from-blue-700 hover:to-blue-800 text-sm font-semibold shadow-md hover:shadow-lg transition-all duration-300"
            >
              + Tạo đơn
            </button>
          </div>
          
          {viewMode === 'day' && (
            <div className="flex items-center gap-2">
              <select
                value={selectedYear}
                onChange={(e) => {
                  const year = parseInt(e.target.value);
                  setSelectedYear(year);
                  const newDate = `${year}-${String(selectedMonth).padStart(2, '0')}-${String(new Date(selectedYear, selectedMonth - 1, 1).getDate()).padStart(2, '0')}`;
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
        </div>
      )}

      {/* Additional Filters for Admin */}
      {isAdmin() && (
        <div className="bg-white rounded-lg shadow p-2">
          <div className="flex items-center gap-2">
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="px-2 py-1.5 border rounded text-xs flex-1"
            >
              <option value="">Tất cả trạng thái</option>
              <option value="created">Đã tạo</option>
              <option value="completed">Hoàn thành</option>
            </select>
            <input
              type="text"
              placeholder="Tìm theo SĐT"
              value={filters.customer_phone}
              onChange={(e) => setFilters({ ...filters, customer_phone: e.target.value })}
              className="px-2 py-1.5 border rounded text-xs flex-1"
            />
          </div>
        </div>
      )}

      {/* Filters - Non-admin */}
      {!isAdmin() && (
        <div className="bg-white rounded-lg shadow p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="px-4 py-2 border rounded-lg"
            >
              <option value="">Tất cả trạng thái</option>
              <option value="created">Đã tạo</option>
              <option value="completed">Hoàn thành</option>
            </select>
            <input
              type="text"
              placeholder="Tìm theo SĐT khách"
              value={filters.customer_phone}
              onChange={(e) => setFilters({ ...filters, customer_phone: e.target.value })}
              className="px-4 py-2 border rounded-lg"
            />
          </div>
        </div>
      )}

      {/* Orders Table - Admin */}
      {isAdmin() ? (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Mã đơn</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Khách hàng</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">SĐT</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Cửa hàng</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ngày tạo</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-700 uppercase">Trạng thái</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Số SP</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Tổng tiền</th>
                  {isRoot() && (
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-700 uppercase">Thao tác</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={isRoot() ? 9 : 8} className="px-4 py-8 text-center text-gray-500">
                      Chưa có đơn hàng
                    </td>
                  </tr>
                ) : (
                  orders.map((order) => (
                    <tr key={order.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-800">{order.code}</td>
                      <td className="px-4 py-3 text-gray-600">{order.customer_name || 'N/A'}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {order.customer_phone && !order.customer_phone.startsWith('temp_') ? order.customer_phone : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{order.assigned_to_name || '-'}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {new Date(order.created_at).toLocaleDateString('vi-VN')} {new Date(order.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          statusColors[order.status] || statusColors.created
                        }`}>
                          {statusLabels[order.status] || order.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">{order.items?.length || 0}</td>
                      <td className="px-4 py-3 text-right font-bold text-gray-800">
                        {new Intl.NumberFormat('vi-VN').format(parseFloat(order.total_amount) || 0)} đ
                      </td>
                      {isRoot() && (
                        <td className="px-4 py-3 text-center">
                          {order.status === 'created' && (
                          <div className="flex gap-1.5 sm:gap-2 flex-nowrap justify-center overflow-x-auto">
                            <button
                              onClick={() => handleCompleteClick(order)}
                              className="flex-shrink-0 px-2 sm:px-3 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 whitespace-nowrap"
                            >
                              Hoàn thành
                            </button>
                            <button
                              onClick={() => handleMarkDebt(order)}
                              className="flex-shrink-0 px-2 sm:px-3 py-1 bg-amber-500 text-white rounded text-xs hover:bg-amber-600 whitespace-nowrap"
                            >
                              Ghi nợ
                            </button>
                            <button
                              onClick={async () => {
                                setPrinting(true);
                                try {
                                  const result = await printBill(order.id);
                                  alert(`Bill đã được in! (Phương thức: ${result.method === 'bluetooth' ? 'Bluetooth' : 'Server'})`);
                                } catch (printError) {
                                  console.error('Print error:', printError);
                                  alert(printError.message || 'In bill thất bại. Vui lòng kiểm tra kết nối máy in.');
                                } finally {
                                  setPrinting(false);
                                }
                              }}
                              disabled={printing}
                              className="flex-shrink-0 px-2 sm:px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                            >
                              {printing ? 'Đang in...' : 'In bill'}
                            </button>
                          </div>
                        )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
              {orders.length > 0 && (
                <tfoot className="bg-gray-50 font-semibold">
                  <tr>
                    <td colSpan="6" className="px-4 py-3 text-gray-800">Tổng cộng</td>
                    <td className="px-4 py-3 text-right text-gray-800">
                      {orders.reduce((sum, o) => sum + (o.items?.length || 0), 0)}
                    </td>
                    <td className="px-4 py-3 text-right text-green-600">
                      {new Intl.NumberFormat('vi-VN').format(orders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0))} đ
                    </td>
                    {isRoot() && <td className="px-4 py-3"></td>}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      ) : (
        /* Orders List - Non-admin */
        <div className="space-y-3">
          {orders.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
              Chưa có đơn hàng
            </div>
          ) : (
            orders.map((order) => (
              <div key={order.id} className="bg-white rounded-lg shadow p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold text-lg text-gray-800">{order.code}</span>
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          statusColors[order.status] || statusColors.created
                        }`}
                      >
                        {statusLabels[order.status] || order.status}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1">
                      <p>
                        <span className="font-medium">Khách:</span> {order.customer_name || order.customer_phone || 'N/A'}
                      </p>
                      {order.customer_phone && !order.customer_phone.startsWith('temp_') && (
                        <p>
                          <span className="font-medium">SĐT:</span> {order.customer_phone}
                        </p>
                      )}
                      <p>
                        <span className="font-medium">Ngày tạo:</span>{' '}
                        {new Date(order.created_at).toLocaleString('vi-VN')}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-gray-800 mb-2">
                      {new Intl.NumberFormat('vi-VN').format(parseFloat(order.total_amount) || 0)} đ
                    </div>
                    {order.items && (
                      <div className="text-sm text-gray-600">
                        {order.items.length} sản phẩm
                      </div>
                    )}
                  </div>
                </div>

                {order.items && order.items.length > 0 && (
                  <div className="border-t pt-3 mt-3">
                    <div className="text-sm font-medium text-gray-700 mb-2">Sản phẩm:</div>
                    <div className="space-y-1">
                      {order.items.map((item) => (
                        <div key={item.id} className="flex justify-between text-sm text-gray-600">
                          <span>
                            {item.product_name} x {item.quantity} {item.product_unit}
                          </span>
                          <span>
                            {new Intl.NumberFormat('vi-VN').format(item.quantity * item.unit_price)} đ
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="border-t pt-3 mt-3 flex flex-nowrap gap-1.5 sm:gap-2 overflow-x-auto">
                  {order.status === 'created' && (
                    <>
                      <button
                        onClick={() => handleCompleteClick(order)}
                        className="flex-shrink-0 px-3 sm:px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium text-sm whitespace-nowrap"
                      >
                        ✓ Hoàn thành
                      </button>
                      <button
                        onClick={() => handleMarkDebt(order)}
                        className="flex-shrink-0 px-3 sm:px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium text-sm whitespace-nowrap"
                      >
                        Ghi nợ
                      </button>
                    </>
                  )}
                  <button
                    onClick={async () => {
                      setPrinting(true);
                      try {
                        const result = await printBill(order.id);
                        alert(`Bill đã được in! (Phương thức: ${result.method === 'bluetooth' ? 'Bluetooth' : 'Server'})`);
                      } catch (printError) {
                        console.error('Print error:', printError);
                        alert(printError.message || 'In bill thất bại. Vui lòng kiểm tra kết nối máy in.');
                      } finally {
                        setPrinting(false);
                      }
                    }}
                    disabled={printing}
                    className="flex-shrink-0 px-3 sm:px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium text-sm disabled:opacity-50 whitespace-nowrap"
                  >
                    {printing ? 'Đang in...' : 'In bill'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Create Order Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center z-50 overflow-y-auto overflow-x-hidden">
          <div className="bg-white rounded-t-3xl sm:rounded-lg w-full sm:max-w-2xl sm:max-h-[95vh] flex flex-col shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between p-4 sm:p-5 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-lg sm:text-xl font-bold text-gray-800">📋 Tạo đơn hàng mới</h2>
              <button
                type="button"
                onClick={() => {
                  setShowModal(false);
                  setFormData({
                    customer_name: '',
                    customer_phone: '0',
                    items: [{ product_id: '', quantity: '' }],
                    note: '',
                    assigned_to: '',
                    promotion_id: '',
                  });
                  setApplicablePromotions([]);
                }}
                className="text-gray-400 hover:text-gray-600 text-2xl leading-none w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 touch-manipulation"
                aria-label="Đóng"
              >
                ✕
              </button>
            </div>

            {/* Form Content */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden">
              <form id="order-form" onSubmit={handleSubmitOrder} className="space-y-3 p-4 sm:p-5">

              {/* Customer Section */}
              <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-3.5 rounded-lg border border-blue-200">
                <h3 className="text-sm font-semibold text-gray-700 mb-2.5 flex items-center gap-2">
                  👤 Thông tin khách hàng
                </h3>
                <div className="space-y-2.5">
                  {/* Name and Phone on Mobile: Stack, on Desktop: 2 columns */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Tên khách hàng
                    </label>
                    <input
                      type="text"
                      value={formData.customer_name}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setFormData({ ...formData, customer_name: newName });

                        // Clear timeout if exists
                        if (searchTimeout) {
                          clearTimeout(searchTimeout);
                        }

                        // Debounce search
                        const timeout = setTimeout(() => {
                          searchCustomers(newName);
                        }, 300);
                        setSearchTimeout(timeout);
                      }}
                      onFocus={() => {
                        if (formData.customer_name && formData.customer_name.trim().length >= 2) {
                          searchCustomers(formData.customer_name);
                        }
                      }}
                      onBlur={() => {
                        // Delay hiding suggestions to allow click
                        setTimeout(() => setShowCustomerSuggestions(false), 200);
                      }}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                      placeholder="Nhập tên khách hàng"
                    />
                    {showCustomerSuggestions && customerSuggestions.length > 0 && (
                      <div className="absolute z-50 w-full mt-2 bg-white border border-gray-300 rounded-lg shadow-xl max-h-64 overflow-y-auto">
                        {customerSuggestions.map((customer) => (
                          <div
                            key={customer.id}
                            onClick={() => handleCustomerSelect(customer)}
                            className="px-4 py-3 hover:bg-blue-50 active:bg-blue-100 cursor-pointer border-b border-gray-100 last:border-b-0 touch-manipulation"
                          >
                            <div className="font-semibold text-gray-900">{customer.name || 'Không có tên'}</div>
                            <div className="text-sm text-gray-600 mt-1">{customer.phone}</div>
                            {customer.total_orders > 0 && (
                              <div className="text-xs text-gray-500 mt-2">
                                📊 {customer.total_orders} đơn • {new Intl.NumberFormat('vi-VN').format(customer.total_spent || 0)} đ
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Số điện thoại <span className="text-gray-500 text-xs">(tùy chọn)</span>
                    </label>
                    <input
                      type="tel"
                      inputMode="numeric"
                      value={formData.customer_phone}
                      onChange={async (e) => {
                        const newPhone = e.target.value;
                        setFormData({ ...formData, customer_phone: newPhone });

                        // Clear timeout if exists
                        if (searchTimeout) {
                          clearTimeout(searchTimeout);
                        }

                        // Debounce search
                        const timeout = setTimeout(() => {
                          if (newPhone && newPhone.trim().length >= 2) {
                            searchCustomers(newPhone);
                          } else {
                            setCustomerSuggestions([]);
                            setShowCustomerSuggestions(false);
                          }
                        }, 300);
                        setSearchTimeout(timeout);

                        // Load customer info if phone exists (exact match)
                        if (newPhone && newPhone.trim().length >= 10) {
                          try {
                            const customerResponse = await api.get(`/customers/by-phone/${encodeURIComponent(newPhone.trim())}`);
                            if (customerResponse.data.data && customerResponse.data.data.name) {
                              // Auto-fill customer name if found
                              setFormData(prev => ({ ...prev, customer_name: customerResponse.data.data.name }));
                              setShowCustomerSuggestions(false);
                            }
                          } catch (error) {
                            // Customer not found or error - keep current name
                          }
                        }

                        // Load promotions when customer phone changes
                        await calculateTotalAndLoadPromotions(formData.items, newPhone);
                      }}
                      onFocus={() => {
                        if (formData.customer_phone && formData.customer_phone.trim().length >= 2) {
                          searchCustomers(formData.customer_phone);
                        }
                      }}
                      onBlur={() => {
                        // Delay hiding suggestions to allow click
                        setTimeout(() => setShowCustomerSuggestions(false), 200);
                      }}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                      placeholder="Nhập số điện thoại"
                    />
                    {showCustomerSuggestions && customerSuggestions.length > 0 && (
                      <div className="absolute z-50 w-full mt-2 bg-white border border-gray-300 rounded-lg shadow-xl max-h-64 overflow-y-auto">
                        {customerSuggestions.map((customer) => (
                          <div
                            key={customer.id}
                            onClick={() => handleCustomerSelect(customer)}
                            className="px-4 py-3 hover:bg-blue-50 active:bg-blue-100 cursor-pointer border-b border-gray-100 last:border-b-0 touch-manipulation"
                          >
                            <div className="font-semibold text-gray-900">{customer.name || 'Không có tên'}</div>
                            <div className="text-sm text-gray-600 mt-1">{customer.phone}</div>
                            {customer.total_orders > 0 && (
                              <div className="text-xs text-gray-500 mt-2">
                                📊 {customer.total_orders} đơn • {new Intl.NumberFormat('vi-VN').format(customer.total_spent || 0)} đ
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                </div>
              </div>

              {/* Admin Assignment */}
              {isAdmin() && (
                <div className="bg-gradient-to-br from-green-50 to-green-100 p-3.5 rounded-lg border border-green-200">
                  <label className="block text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                    👥 Gán cho nhân viên
                  </label>
                  <select
                    value={formData.assigned_to}
                    onChange={(e) => setFormData({ ...formData, assigned_to: e.target.value })}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                  >
                    <option value="">Chưa gán</option>
                    {users
                      .filter((u) => u.role === 'employer' && u.status === 'active')
                      .map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}

              {/* Products Section */}
              <div className="bg-gradient-to-br from-purple-50 to-purple-100 p-3.5 rounded-lg border border-purple-200">
                <h3 className="text-sm font-semibold text-gray-700 mb-2.5 flex items-center gap-2">
                  🧺 Sản phẩm
                </h3>
                <div className="space-y-1.5">
                  {formData.items.map((item, index) => (
                    <div key={index} className="bg-white p-2.5 rounded-lg border border-gray-200 space-y-1.5">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Sản phẩm</label>
                        <select
                          value={item.product_id}
                          onChange={(e) => handleItemChange(index, 'product_id', e.target.value)}
                          className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                          required
                        >
                          <option value="">-- Chọn sản phẩm --</option>
                          {products.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name} {product.store_name ? `(${product.store_name})` : ''} - {new Intl.NumberFormat('vi-VN').format(product.price)} đ/{product.unit}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex gap-2 items-end">
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-gray-600 mb-1">Số lượng</label>
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.1"
                            min="0.1"
                            placeholder="0.5, 1, 2..."
                            value={item.quantity}
                            onChange={(e) => handleItemChange(index, 'quantity', e.target.value)}
                            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all"
                            required
                          />
                        </div>
                        {formData.items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(index)}
                            className="px-4 py-2.5 flex-shrink-0 bg-red-500 hover:bg-red-600 active:bg-red-700 text-white rounded-lg text-sm font-medium touch-manipulation"
                          >
                            🗑️ Xóa
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={handleAddItem}
                    className="w-full px-4 py-3 text-sm font-semibold text-blue-600 hover:text-blue-700 active:text-blue-800 border-2 border-blue-600 rounded-lg hover:bg-blue-50 active:bg-blue-100 transition-all touch-manipulation"
                  >
                    ➕ Thêm sản phẩm khác
                  </button>
                </div>
              </div>

              {/* Promotions Section */}
              <div className="bg-gradient-to-br from-orange-50 to-orange-100 p-3.5 rounded-lg border border-orange-200">
                <h3 className="text-sm font-semibold text-gray-700 mb-2.5 flex items-center gap-2">
                  🎁 Khuyến mãi (tùy chọn)
                </h3>
                {applicablePromotions.length > 0 ? (
                  <select
                    value={formData.promotion_id}
                    onChange={(e) => setFormData({ ...formData, promotion_id: e.target.value })}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg text-base focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all bg-white"
                  >
                    <option value="">Không áp dụng khuyến mãi</option>
                    {applicablePromotions.map((promo) => (
                      <option key={promo.id} value={promo.id}>
                        🌟 {promo.name} - {promo.discount_type === 'percentage'
                          ? `${promo.discount_value}%`
                          : `${new Intl.NumberFormat('vi-VN').format(promo.discount_value)} đ`}
                        {promo.max_discount_amount && ` (Tối đa: ${new Intl.NumberFormat('vi-VN').format(promo.max_discount_amount)} đ)`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="px-4 py-3 border border-orange-300 rounded-lg text-sm bg-white text-gray-600">
                    {formData.items.some(item => item.product_id && item.quantity)
                      ? '⏳ Đang tải khuyến mãi...'
                      : '📝 Thêm sản phẩm để xem khuyến mãi có sẵn'}
                  </div>
                )}
              </div>

              {/* Notes Section */}
              <div className="bg-gradient-to-br from-cyan-50 to-cyan-100 p-3.5 rounded-lg border border-cyan-200">
                <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                  📝 Ghi chú (tùy chọn)
                </h3>
                <textarea
                  value={formData.note}
                  onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all resize-none bg-white"
                  rows="2"
                  maxLength="200"
                  placeholder="Ghi chú ngắn... (tối đa 200 ký tự)"
                />
                <div className="text-xs text-gray-500 mt-1">
                  {formData.note.length}/200
                </div>
              </div>
              </form>
            </div>

            {/* Footer - Action Buttons */}
            <div className="flex gap-3 p-4 sm:p-5 border-t border-gray-200 bg-gray-50 flex-shrink-0 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setShowModal(false);
                  setFormData({
                    customer_name: '',
                    customer_phone: '0',
                    items: [{ product_id: '', quantity: '' }],
                    note: '',
                    assigned_to: '',
                    promotion_id: '',
                  });
                  setApplicablePromotions([]);
                }}
                className="flex-1 px-4 py-3 text-base text-gray-700 hover:text-gray-800 border-2 border-gray-300 rounded-lg hover:bg-gray-200 active:bg-gray-300 font-semibold transition-all touch-manipulation"
              >
                ✕ Hủy
              </button>
              <button
                form="order-form"
                type="submit"
                className="flex-1 px-4 py-3 text-base text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 active:from-blue-800 active:to-blue-900 rounded-lg font-semibold shadow-lg hover:shadow-xl transition-all touch-manipulation"
              >
                ✓ Tạo đơn hàng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Order Modal */}
      {showCompleteModal && orderToComplete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center p-0 sm:p-2 z-50 overflow-y-auto overflow-x-hidden">
          <div className="bg-white rounded-t-2xl sm:rounded-lg max-w-md w-full p-4 sm:p-5 max-h-[90vh] sm:max-h-[85vh] overflow-y-auto overflow-x-hidden my-0 sm:my-auto shadow-xl pb-safe sm:pb-5">
            <div className="flex items-center justify-between mb-3 sticky top-0 bg-white pb-2 border-b z-10 min-w-0">
              <h2 className="text-base sm:text-lg font-bold text-gray-900 truncate pr-2">Hoàn thành đơn hàng</h2>
              <button
                type="button"
                onClick={() => {
                  setShowCompleteModal(false);
                  setOrderToComplete(null);
                  setShouldPrint(false);
                  setPaymentMethod('cash');
                  setCustomAmountPaid('');
                }}
                disabled={printing}
                className="text-gray-500 hover:text-gray-700 text-xl w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 active:bg-gray-200 touch-manipulation disabled:opacity-50"
                aria-label="Đóng"
              >
                ×
              </button>
            </div>
            
            <div className="space-y-3 min-w-0">
              <div className="bg-blue-50 border-l-4 border-blue-500 p-2.5 rounded-r-lg overflow-hidden">
                <p className="text-xs text-gray-600 mb-0.5 truncate">Đơn hàng</p>
                <p className="text-sm font-bold text-gray-900 truncate">
                  #{orderToComplete.code}
                </p>
                <p className="text-base font-bold text-blue-600 mt-1 break-words">
                  {parseFloat(orderToComplete.final_amount || orderToComplete.total_amount || 0).toLocaleString('vi-VN')} đ
                </p>
              </div>
              
              <div className="min-w-0">
                <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                  Hình thức thanh toán <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-2 gap-2 min-w-0">
                  <label className={`flex items-center justify-center gap-2 p-2.5 border-2 rounded-lg cursor-pointer transition-all touch-manipulation min-w-0 ${
                    paymentMethod === 'cash'
                      ? 'border-green-500 bg-green-50'
                      : 'border-gray-300'
                  } active:scale-95`}>
                    <input
                      type="radio"
                      name="payment_method"
                      value="cash"
                      checked={paymentMethod === 'cash'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="sr-only"
                    />
                    <span className="text-xs font-medium text-center break-words">💰 Tiền mặt</span>
                  </label>
                  <label className={`flex items-center justify-center gap-2 p-2.5 border-2 rounded-lg cursor-pointer transition-all touch-manipulation min-w-0 ${
                    paymentMethod === 'transfer'
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-300'
                  } active:scale-95`}>
                    <input
                      type="radio"
                      name="payment_method"
                      value="transfer"
                      checked={paymentMethod === 'transfer'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="sr-only"
                    />
                    <span className="text-xs font-medium text-center break-words">🏦 Chuyển khoản</span>
                  </label>
                </div>
              </div>

              <div className="min-w-0">
                <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                  Số tiền thanh toán
                </label>
                <MoneyInput
                  placeholder={parseFloat(orderToComplete.final_amount || orderToComplete.total_amount || 0).toLocaleString('vi-VN')}
                  value={customAmountPaid}
                  onChange={setCustomAmountPaid}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                <p className="text-xs text-gray-500 mt-1">Để trống = toàn bộ số tiền hoặc nhập 0 để ghi nợ</p>
              </div>

              <div className="flex flex-col gap-2 pt-2 border-t border-gray-200 min-w-0">
                <button
                  onClick={handleCompleteOrder}
                  disabled={printing}
                  className="w-full min-w-0 bg-gradient-to-r from-green-500 to-green-600 text-white py-2.5 rounded-lg hover:from-green-600 hover:to-green-700 active:from-green-700 active:to-green-800 font-medium text-sm shadow-md transition-all touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:from-green-500 disabled:hover:to-green-600"
                >
                  {printing ? '⏳ Đang xử lý...' : '✓ Hoàn thành'}
                </button>
                <button
                  onClick={async () => {
                    setPrinting(true);
                    try {
                      const result = await printBill(orderToComplete.id);
                      alert(`Bill đã được in! (Phương thức: ${result.method === 'bluetooth' ? 'Bluetooth' : 'Server'})`);
                    } catch (printError) {
                      console.error('Print error:', printError);
                      alert(printError.message || 'In bill thất bại. Vui lòng kiểm tra kết nối máy in.');
                    } finally {
                      setPrinting(false);
                    }
                  }}
                  disabled={printing}
                  className="w-full min-w-0 bg-gradient-to-r from-blue-500 to-blue-600 text-white py-2.5 rounded-lg hover:from-blue-600 hover:to-blue-700 active:from-blue-700 active:to-blue-800 font-medium text-sm shadow-md transition-all touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {printing ? '⏳ Đang in...' : '🖨️ In bill'}
                </button>
                <button
                  onClick={() => {
                    setShowCompleteModal(false);
                    setOrderToComplete(null);
                    setShouldPrint(false);
                    setPaymentMethod('cash');
                  }}
                  disabled={printing}
                  className="w-full min-w-0 bg-gray-200 text-gray-800 py-2.5 rounded-lg hover:bg-gray-300 active:bg-gray-400 font-medium text-sm transition-all touch-manipulation disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Hủy
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Orders;
