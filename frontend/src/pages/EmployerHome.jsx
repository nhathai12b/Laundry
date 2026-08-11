import { useEffect, useState } from 'react';
import api from '../utils/api';
import { getAuth } from '../utils/auth';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDaysInMonth } from 'date-fns';
import { vi } from 'date-fns/locale';
import { printBill } from '../utils/printBill';
import { bestApplicablePromotionId } from '../utils/promotions';
import { getLocalDateRangeUtc } from '../utils/dateTime';

function EmployerHome() {
  const [stats, setStats] = useState({
    todayRevenue: 0,
    todayOrders: 0,
    totalCustomers: 0,
    activeOrders: 0,
  });
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth() + 1);
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  
  const [formData, setFormData] = useState({
    customer_name: '',
    customer_phone: '0',
    items: [{ product_id: '', quantity: '' }],
    note: '',
    promotion_id: '',
  });
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [orderToComplete, setOrderToComplete] = useState(null);
  const [shouldPrint, setShouldPrint] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [applicablePromotions, setApplicablePromotions] = useState([]);
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [showCustomerSuggestions, setShowCustomerSuggestions] = useState(false);
  const [searchTimeout, setSearchTimeout] = useState(null);

  useEffect(() => {
    loadData();
    loadProducts();
  }, []);

  useEffect(() => {
    loadOrders();
  }, [selectedDate]);

  const loadData = async () => {
    try {
      const today = format(new Date(), 'yyyy-MM-dd');
      const todayRange = getLocalDateRangeUtc(today);

      // Get today's revenue
      const revenueRes = await api.get(`/reports/revenue?period=day&start_at=${encodeURIComponent(todayRange.start_at)}&end_at=${encodeURIComponent(todayRange.end_at)}&timezone_offset_minutes=${new Date().getTimezoneOffset()}`);
      const todayRevenueData = revenueRes.data.data[0];
      
      // Get customers count
      const customersRes = await api.get('/customers');
      const customers = customersRes.data.data || [];

      // Get today's orders for stats
      const todayOrdersRes = await api.get(`/orders?start_at=${encodeURIComponent(todayRange.start_at)}&end_at=${encodeURIComponent(todayRange.end_at)}`);
      const todayOrders = todayOrdersRes.data.data || [];
      const completedToday = todayOrders.filter(o => o.status === 'completed');
      const activeToday = todayOrders.filter(o => o.status === 'created');

      setStats({
        todayRevenue: todayRevenueData?.total_revenue || 0,
        todayOrders: completedToday.length,
        totalCustomers: customers.length,
        activeOrders: activeToday.length,
      });
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadOrders = async () => {
    setOrdersLoading(true);
    try {
      const params = new URLSearchParams();
      const range = getLocalDateRangeUtc(selectedDate);
      params.append('start_at', range.start_at);
      params.append('end_at', range.end_at);
      params.append('my_orders', 'true');

      const response = await api.get(`/orders?${params.toString()}`);
      setOrders(response.data.data || []);
    } catch (error) {
      console.error('Error loading orders:', error);
    } finally {
      setOrdersLoading(false);
    }
  };

  const loadProducts = async () => {
    try {
      const response = await api.get('/products?status=active');
      setProducts(response.data.data || []);
    } catch (error) {
      console.error('Error loading products:', error);
    }
  };

  const handleCompleteClick = (order) => {
    setOrderToComplete(order);
    setShowCompleteModal(true);
    setShouldPrint(false);
    setPaymentMethod('cash'); // Reset to default
  };

  const handleCompleteOrder = async () => {
    if (!orderToComplete) return;

    try {
      await api.post(`/orders/${orderToComplete.id}/status`, { 
        status: 'completed',
        payment_method: paymentMethod
      });

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
      loadOrders();
      loadData(); // Reload stats
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
      // Get store_id for employer
      const { user } = getAuth();
      const storeId = user?.store_id || null;

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
        const { user } = getAuth();
        const storeId = user?.store_id || null;

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
        promotion_id: '',
      });
      setApplicablePromotions([]);
      loadOrders();
      loadData(); // Reload stats
    } catch (error) {
      alert(error.response?.data?.error || 'Tạo đơn thất bại');
    }
  };

  const getDaysInCurrentMonth = () => {
    const days = getDaysInMonth(new Date(currentYear, currentMonth - 1));
    return Array.from({ length: days }, (_, i) => {
      const day = i + 1;
      const dateStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { day, dateStr };
    });
  };

  const statusColors = {
    created: 'bg-gray-100 text-gray-800',
    completed: 'bg-green-100 text-green-800',
  };

  const statusLabels = {
    created: 'Đã tạo',
    completed: 'Hoàn thành',
  };

  const isToday = (dateStr) => {
    return dateStr === format(new Date(), 'yyyy-MM-dd');
  };

  if (loading) {
    return <div className="text-center py-8">Đang tải...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Trang chủ</h1>
          <p className="text-gray-600">Quản lý đơn hàng</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          + Tạo đơn
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-600 mb-1">Doanh thu hôm nay</div>
          <div className="text-2xl font-bold text-green-600">
            {new Intl.NumberFormat('vi-VN').format(stats.todayRevenue)} đ
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-600 mb-1">Đơn hôm nay</div>
          <div className="text-2xl font-bold text-blue-600">{stats.todayOrders}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-600 mb-1">Tổng khách hàng</div>
          <div className="text-2xl font-bold text-purple-600">{stats.totalCustomers}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-sm text-gray-600 mb-1">Đơn đang xử lý</div>
          <div className="text-2xl font-bold text-orange-600">{stats.activeOrders}</div>
        </div>
      </div>

      {/* Date Filter */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="mb-3">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Chọn ngày trong tháng {currentMonth}/{currentYear}
          </label>
          <div className="flex gap-2 mb-3">
            <select
              value={currentMonth}
              onChange={(e) => {
                const month = parseInt(e.target.value);
                setCurrentMonth(month);
                // Reset to first day of month if current selected date is not in new month
                const newDate = `${currentYear}-${String(month).padStart(2, '0')}-01`;
                if (selectedDate < newDate || selectedDate > `${currentYear}-${String(month).padStart(2, '0')}-${getDaysInMonth(new Date(currentYear, month - 1))}`) {
                  setSelectedDate(newDate);
                }
              }}
              className="px-3 py-2 border rounded-lg"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  Tháng {i + 1}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="2020"
              max="2100"
              value={currentYear}
              onChange={(e) => {
                const year = parseInt(e.target.value) || new Date().getFullYear();
                setCurrentYear(year);
                // Reset to first day of month if current selected date is not in new year
                const newDate = `${year}-${String(currentMonth).padStart(2, '0')}-01`;
                if (selectedDate < newDate || selectedDate > `${year}-${String(currentMonth).padStart(2, '0')}-${getDaysInMonth(new Date(year, currentMonth - 1))}`) {
                  setSelectedDate(newDate);
                }
              }}
              className="px-3 py-2 border rounded-lg w-32"
              placeholder="Năm"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {getDaysInCurrentMonth().map(({ day, dateStr }) => (
            <button
              key={day}
              onClick={() => setSelectedDate(dateStr)}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                selectedDate === dateStr
                  ? 'bg-blue-600 text-white'
                  : isToday(dateStr)
                  ? 'bg-green-100 text-green-700 border-2 border-green-500'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {day}
            </button>
          ))}
        </div>
        <div className="mt-3 text-sm text-gray-600">
          Đang xem: <strong>{format(new Date(selectedDate), 'dd/MM/yyyy', { locale: vi })}</strong>
          {isToday(selectedDate) && <span className="ml-2 text-green-600">(Hôm nay)</span>}
        </div>
      </div>

      {/* Orders List */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-800">
            Đơn hàng ngày {format(new Date(selectedDate), 'dd/MM/yyyy', { locale: vi })}
          </h2>
        </div>
        {ordersLoading ? (
          <div className="p-8 text-center text-gray-500">Đang tải...</div>
        ) : orders.length === 0 ? (
          <div className="p-8 text-center text-gray-500">Chưa có đơn hàng</div>
        ) : (
          <div className="divide-y">
            {orders.map((order) => (
              <div key={order.id} className="p-4 hover:bg-gray-50">
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
                        <span className="font-medium">Thời gian:</span>{' '}
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

                {/* Status Actions */}
                <div className="border-t pt-3 mt-3 flex gap-2">
                  {order.status === 'created' && (
                    <button
                      onClick={() => handleCompleteClick(order)}
                      className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium"
                    >
                      ✓ Hoàn thành
                    </button>
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
                    className={`${order.status === 'created' ? 'flex-1' : 'w-full'} px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50`}
                  >
                    {printing ? 'Đang in...' : 'In bill'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Order Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full p-4 md:p-6 max-h-[95vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">Tạo đơn hàng mới</h2>
            <form onSubmit={handleSubmitOrder} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
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
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                    placeholder="Nhập tên khách hàng"
                  />
                  {showCustomerSuggestions && customerSuggestions.length > 0 && (
                    <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {customerSuggestions.map((customer) => (
                        <div
                          key={customer.id}
                          onClick={() => handleCustomerSelect(customer)}
                          className="px-4 py-2 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-b-0"
                        >
                          <div className="font-medium text-gray-900">{customer.name || 'Không có tên'}</div>
                          <div className="text-sm text-gray-600">{customer.phone}</div>
                          {customer.total_orders > 0 && (
                            <div className="text-xs text-gray-500">
                              {customer.total_orders} đơn • {new Intl.NumberFormat('vi-VN').format(customer.total_spent || 0)} đ
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    SĐT khách hàng <span className="text-gray-500 text-xs">(tùy chọn)</span>
                  </label>
                  <input
                    type="text"
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
                          // Customer not found - log removed for security
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
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                    placeholder="Nhập số điện thoại"
                  />
                  {showCustomerSuggestions && customerSuggestions.length > 0 && (
                    <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {customerSuggestions.map((customer) => (
                        <div
                          key={customer.id}
                          onClick={() => handleCustomerSelect(customer)}
                          className="px-4 py-2 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-b-0"
                        >
                          <div className="font-medium text-gray-900">{customer.name || 'Không có tên'}</div>
                          <div className="text-sm text-gray-600">{customer.phone}</div>
                          {customer.total_orders > 0 && (
                            <div className="text-xs text-gray-500">
                              {customer.total_orders} đơn • {new Intl.NumberFormat('vi-VN').format(customer.total_spent || 0)} đ
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Sản phẩm</label>
                <div className="space-y-3">
                  {formData.items.map((item, index) => (
                    <div key={index} className="flex flex-col sm:flex-row gap-2">
                      <select
                        value={item.product_id}
                        onChange={(e) => handleItemChange(index, 'product_id', e.target.value)}
                        className="flex-1 px-3 py-2.5 border rounded-lg text-base"
                        required
                      >
                        <option value="">Chọn sản phẩm</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.name} - {new Intl.NumberFormat('vi-VN').format(product.price)} đ/{product.unit}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        placeholder="Số lượng"
                        value={item.quantity}
                        onChange={(e) => handleItemChange(index, 'quantity', e.target.value)}
                        className="w-full sm:w-32 px-3 py-2.5 border rounded-lg text-base"
                        required
                      />
                      {formData.items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(index)}
                          className="px-4 py-2.5 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 text-base font-medium"
                        >
                          ✕ Xóa
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={handleAddItem}
                    className="w-full sm:w-auto px-4 py-2 text-sm text-blue-600 hover:text-blue-700 border border-blue-600 rounded-lg hover:bg-blue-50 font-medium"
                  >
                    + Thêm sản phẩm
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Khuyến mãi (tùy chọn)
                </label>
                {applicablePromotions.length > 0 ? (
                  <select
                    value={formData.promotion_id}
                    onChange={(e) => setFormData({ ...formData, promotion_id: e.target.value })}
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                  >
                    <option value="">Không áp dụng khuyến mãi</option>
                    {applicablePromotions.map((promo) => (
                      <option key={promo.id} value={promo.id}>
                        {promo.name} - {promo.discount_type === 'percentage' 
                          ? `${promo.discount_value}%` 
                          : `${new Intl.NumberFormat('vi-VN').format(promo.discount_value)} đ`}
                        {promo.max_discount_amount && ` (Tối đa: ${new Intl.NumberFormat('vi-VN').format(promo.max_discount_amount)} đ)`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="w-full px-3 py-2.5 border rounded-lg text-base bg-gray-50 text-gray-500">
                    {formData.items.some(item => item.product_id && item.quantity) 
                      ? 'Đang tải khuyến mãi...' 
                      : 'Vui lòng thêm sản phẩm để xem khuyến mãi'}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ghi chú đơn</label>
                <textarea
                  value={formData.note}
                  onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  rows="3"
                  placeholder="Ghi chú về đơn hàng (tùy chọn)"
                />
              </div>

              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 font-medium text-base"
                >
                  Tạo đơn
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false);
                    setFormData({
                      customer_name: '',
                      customer_phone: '0',
                      items: [{ product_id: '', quantity: '' }],
                      note: '',
                      promotion_id: '',
                    });
                    setApplicablePromotions([]);
                  }}
                  className="flex-1 bg-gray-200 text-gray-800 py-3 rounded-lg hover:bg-gray-300 font-medium text-base"
                >
                  Hủy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Complete Order Modal */}
      {showCompleteModal && orderToComplete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">Hoàn thành đơn hàng</h2>
            <div className="space-y-4">
              <div>
                <p className="text-gray-700 mb-2">
                  Xác nhận hoàn thành đơn hàng <strong>{orderToComplete.code}</strong>?
                </p>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Hình thức thanh toán *
                </label>
                <div className="flex gap-3">
                  <label className="flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer flex-1 hover:bg-gray-50">
                    <input
                      type="radio"
                      name="payment_method"
                      value="cash"
                      checked={paymentMethod === 'cash'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-4 h-4 text-blue-600"
                    />
                    <span className="font-medium">Tiền mặt</span>
                  </label>
                  <label className="flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer flex-1 hover:bg-gray-50">
                    <input
                      type="radio"
                      name="payment_method"
                      value="transfer"
                      checked={paymentMethod === 'transfer'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="w-4 h-4 text-blue-600"
                    />
                    <span className="font-medium">Chuyển khoản</span>
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <input
                  type="checkbox"
                  id="printBill"
                  checked={shouldPrint}
                  onChange={(e) => setShouldPrint(e.target.checked)}
                  className="w-5 h-5 text-blue-600 rounded"
                />
                <label htmlFor="printBill" className="text-gray-700 font-medium cursor-pointer">
                  In bill sau khi hoàn thành
                </label>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button
                  onClick={handleCompleteOrder}
                  disabled={printing}
                  className="flex-1 bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 font-medium text-base disabled:opacity-50"
                >
                  {printing ? 'Đang in...' : 'Xác nhận'}
                </button>
                <button
                  onClick={() => {
                    setShowCompleteModal(false);
                    setOrderToComplete(null);
                    setShouldPrint(false);
                    setPaymentMethod('cash');
                  }}
                  disabled={printing}
                  className="flex-1 bg-gray-200 text-gray-800 py-3 rounded-lg hover:bg-gray-300 font-medium text-base disabled:opacity-50"
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

export default EmployerHome;
