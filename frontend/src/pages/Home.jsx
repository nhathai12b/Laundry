import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { getAuth, isAdmin, isEmployer, getEmployeeId } from '../utils/auth';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDaysInMonth } from 'date-fns';
import { printBill } from '../utils/printBill';
import { bestApplicablePromotionId, promotionDiscountAmount } from '../utils/promotions';
import { calendarDayVN as calendarDayFromDbDateTime } from '../utils/dateVN';

function Home() {
  const [orders, setOrders] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [stats, setStats] = useState({
    todayRevenue: 0,
    todayOrders: 0,
    totalAmount: 0,
  });
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
  const [loadingPromotions, setLoadingPromotions] = useState(false);
  const [orderTotal, setOrderTotal] = useState(0);
  const [orderDiscount, setOrderDiscount] = useState(0);
  const [orderFinal, setOrderFinal] = useState(0);
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [showCustomerSuggestions, setShowCustomerSuggestions] = useState(false);
  const [searchTimeout, setSearchTimeout] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [viewTab, setViewTab] = useState(() => (searchParams.get('tab') === 'debt' ? 'debt' : 'home'));
  const [debtOrders, setDebtOrders] = useState([]);
  const [debtOrdersLoading, setDebtOrdersLoading] = useState(false);
  const [debtSearchQuery, setDebtSearchQuery] = useState('');
  const [showDebtPayModal, setShowDebtPayModal] = useState(false);
  const [orderForDebtPay, setOrderForDebtPay] = useState(null);
  const [debtPayPaymentMethod, setDebtPayPaymentMethod] = useState('cash');
  const [debtPaySubmitting, setDebtPaySubmitting] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [orderToEdit, setOrderToEdit] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Check-in: chỉ employer. Chưa có ca mở (open-shifts) thì không mở form tạo đơn — ca mở có thể từ ngày trước nếu chưa checkout.
  const [todayCheckIn, setTodayCheckIn] = useState(null);
  const [showCheckInPrompt, setShowCheckInPrompt] = useState(false);
  const [checkInEmployees, setCheckInEmployees] = useState([]);
  const [checkInEmployeeId, setCheckInEmployeeId] = useState('');
  const [checkInNote, setCheckInNote] = useState('');
  const [checkInLoading, setCheckInLoading] = useState(false);
  const navigate = useNavigate();

  // Sync viewTab from URL when user navigates (e.g. sidebar "Ghi nợ")
  useEffect(() => {
    const tab = searchParams.get('tab') === 'debt' ? 'debt' : 'home';
    setViewTab(tab);
  }, [searchParams]);

  useEffect(() => {
    loadProducts();
    loadOrders();
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  useEffect(() => {
    if (viewTab === 'debt') {
      loadDebtOrders();
    }
  }, [viewTab]);

  // Nhân viên: có ca đang mở (kể cả ngày trước chưa checkout) thì được tạo đơn; không có ca mở thì chặn
  const checkTodayStatus = async () => {
    if (isAdmin()) return;
    try {
      const response = await api.get('/timesheets/open-shifts');
      const shifts = response.data.data || [];
      setTodayCheckIn(shifts[0] || null);
    } catch (error) {
      console.error('Error checking today status:', error);
      // Giữ state cũ — tránh mất ca mở sau lỗi mạng / tạm thời.
    }
  };

  useEffect(() => {
    if (isEmployer()) {
      checkTodayStatus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Khi mở popup "Chưa check-in", load danh sách nhân viên cho dropdown
  useEffect(() => {
    if (showCheckInPrompt && isEmployer()) {
      const employeeIdFromToken = getEmployeeId();
      setCheckInEmployeeId(employeeIdFromToken || '');
      setCheckInNote('');
      api.get('/timesheets/store-employees').then((res) => {
        setCheckInEmployees(res.data.data || []);
      }).catch(() => setCheckInEmployees([]));
    }
  }, [showCheckInPrompt]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeout) {
        clearTimeout(searchTimeout);
      }
    };
  }, [searchTimeout]);

  const loadOrders = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      // Filter by exact date (YYYY-MM-DD)
      params.append('date', selectedDate);
      
      const response = await api.get(`/orders?${params.toString()}`);
      const allOrders = response.data.data || [];
      
      // Backend already filters by date, so just use the orders directly
      // But add a safety check in case of timezone issues
      const filteredOrders = allOrders.filter(order => {
        if (!order.created_at) return false;
        try {
          const orderDate = calendarDayFromDbDateTime(order.created_at);
          return orderDate === selectedDate;
        } catch (e) {
          return false;
        }
      });
      
      setOrders(filteredOrders);
    } catch (error) {
      console.error('Error loading orders:', error);
      setOrders([]);
    } finally {
      setLoading(false);
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

  const loadStats = async () => {
    try {
      // Use reports API to get revenue by completion date (updated_at)
      const today = format(new Date(), 'yyyy-MM-dd');
      try {
        const revenueRes = await api.get(`/reports/revenue?period=day&start_date=${selectedDate}&end_date=${selectedDate}`);
        const todayRevenueData = revenueRes.data.data?.[0];
        const todayRevenue = parseFloat(todayRevenueData?.total_revenue) || 0;
        
        // Get orders count for the selected date (by created_at for display)
        const response = await api.get(`/orders?date=${selectedDate}`);
        const dayOrders = response.data.data || [];
        
        setStats({
          todayRevenue: todayRevenue, // Revenue calculated by completion date (updated_at)
          todayOrders: dayOrders.length || 0,
          totalAmount: dayOrders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0) || 0,
        });
      } catch (revenueError) {
        console.error('Error loading revenue from reports:', revenueError);
        // Fallback to old method
        const response = await api.get(`/orders?date=${selectedDate}`);
        const dayOrders = response.data.data || [];
        const completedOrders = dayOrders.filter(o => o.status === 'completed');
        const totalRevenue = completedOrders.reduce((sum, o) => sum + (parseFloat(o.final_amount || o.total_amount) || 0), 0);
        
        setStats({
          todayRevenue: totalRevenue || 0,
          todayOrders: dayOrders.length || 0,
          totalAmount: dayOrders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0) || 0,
        });
      }
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  };

  const handleStatusChange = async (orderId, newStatus) => {
    try {
      await api.post(`/orders/${orderId}/status`, { status: newStatus });
      loadOrders();
      loadStats();
    } catch (error) {
      alert(error.response?.data?.error || 'Cập nhật thất bại');
    }
  };

  const handleCompleteClick = (order) => {
    setOrderToComplete(order);
    setShowCompleteModal(true);
    setShouldPrint(false);
    setPaymentMethod('cash'); // Reset to default
  };

  const handleMarkDebt = async (order) => {
    if (!confirm(`Chuyển đơn ${order.code} sang ghi nợ? Đơn sẽ không tính doanh thu cho đến khi nhân viên bấm "Đã thanh toán" trong menu Ghi nợ.`)) return;
    try {
      if (order.status !== 'completed') {
        await api.post(`/orders/${order.id}/status`, { status: 'completed' });
        await api.patch(`/orders/${order.id}/debt`);
      } else {
        await api.patch(`/orders/${order.id}/debt`);
      }
      loadOrders();
      loadStats();
      if (viewTab === 'debt') loadDebtOrders();
    } catch (error) {
      alert(error.response?.data?.error || 'Thao tác thất bại');
    }
  };

  const loadDebtOrders = async () => {
    setDebtOrdersLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('debt_only', 'true');
      const response = await api.get(`/orders?${params.toString()}`);
      setDebtOrders(response.data.data || []);
    } catch (error) {
      console.error('Error loading debt orders:', error);
      setDebtOrders([]);
    } finally {
      setDebtOrdersLoading(false);
    }
  };

  const openDebtPayModal = (order) => {
    setOrderForDebtPay(order);
    setDebtPayPaymentMethod('cash');
    setShowDebtPayModal(true);
  };

  const closeDebtPayModal = () => {
    if (debtPaySubmitting) return;
    setShowDebtPayModal(false);
    setOrderForDebtPay(null);
    setDebtPayPaymentMethod('cash');
  };

  const handleConfirmDebtPaid = async () => {
    if (!orderForDebtPay) return;
    try {
      setDebtPaySubmitting(true);
      await api.patch(`/orders/${orderForDebtPay.id}/debt/paid`, {
        payment_method: debtPayPaymentMethod,
      });
      setShowDebtPayModal(false);
      setOrderForDebtPay(null);
      setDebtPayPaymentMethod('cash');
      loadDebtOrders();
      loadStats();
    } catch (error) {
      alert(error.response?.data?.error || 'Thao tác thất bại');
    } finally {
      setDebtPaySubmitting(false);
    }
  };

  const handleCheckInFromPrompt = async () => {
    const employeeIdToSend = getEmployeeId() || checkInEmployeeId || undefined;
    if (!checkInEmployees.length && !employeeIdToSend) {
      alert('Vui lòng chọn nhân viên hoặc liên hệ admin thêm danh sách nhân viên.');
      return;
    }
    try {
      setCheckInLoading(true);
      const res = await api.post('/timesheets/check-in', {
        employee_id: employeeIdToSend,
        note: checkInNote,
      });
      const created = res.data?.data;
      if (created) {
        setTodayCheckIn(created);
      }
      setShowCheckInPrompt(false);
      setCheckInEmployeeId('');
      setCheckInNote('');
      await checkTodayStatus();
      setShowModal(true);
    } catch (error) {
      alert(error.response?.data?.error || 'Check-in thất bại');
    } finally {
      setCheckInLoading(false);
    }
  };

  const handleCompleteOrder = async () => {
    if (!orderToComplete) return;

    try {
      setPrinting(true);
      
      await api.post(`/orders/${orderToComplete.id}/status`, { 
        status: 'completed',
        payment_method: paymentMethod
      });

      setShowCompleteModal(false);
      setOrderToComplete(null);
      setShouldPrint(false);
      setPaymentMethod('cash');
      setPrinting(false);
      
      loadOrders();
      loadStats();
    } catch (error) {
      alert(error.response?.data?.error || 'Cập nhật thất bại');
      setPrinting(false);
    }
  };

  const handleOpenEditOrder = (order) => {
    if (!order.items || order.items.length === 0) {
      alert('Đơn không có sản phẩm, không thể sửa.');
      return;
    }
    setOrderToEdit(order);
    setFormData({
      customer_name: order.customer_name || '',
      customer_phone: order.customer_phone || '0',
      items: order.items.map((i) => ({
        product_id: String(i.product_id),
        quantity: String(i.quantity),
      })),
      note: order.note || '',
      promotion_id: '',
    });
    setShowEditModal(true);
    setApplicablePromotions([]);
    setOrderTotal(parseFloat(order.total_amount) || 0);
    setOrderDiscount(parseFloat(order.discount_amount) || 0);
    setOrderFinal(parseFloat(order.final_amount) || parseFloat(order.total_amount) || 0);
  };

  const handleCloseEditModal = () => {
    setShowEditModal(false);
    setOrderToEdit(null);
  };

  const handleSubmitEditOrder = async (e) => {
    e.preventDefault();
    if (!orderToEdit) return;
    const payload = {
      customer_name: formData.customer_name || '',
      customer_phone: formData.customer_phone || null,
      note: formData.note || null,
      items: formData.items
        .filter((item) => item.product_id && item.quantity)
        .map((item) => ({
          product_id: parseInt(item.product_id),
          quantity: parseFloat(item.quantity),
        })),
    };
    if (payload.items.length === 0) {
      alert('Vui lòng giữ ít nhất một sản phẩm');
      return;
    }
    try {
      setSavingEdit(true);
      await api.patch(`/orders/${orderToEdit.id}`, payload);
      handleCloseEditModal();
      loadOrders();
      loadStats();
      alert('Đã cập nhật đơn hàng.');
    } catch (error) {
      const msg = error.response?.data?.error || error.message || 'Sửa đơn thất bại';
      alert(msg);
    } finally {
      setSavingEdit(false);
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
    const newItems = formData.items.map((item, i) => (i === index ? { ...item, [field]: value } : item));
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

    setOrderTotal(total);

    if (total > 0) {
      setLoadingPromotions(true);
      try {
        const { user } = getAuth();
        const storeId = user?.store_id || null;

        const phoneToUse =
          customerPhone !== undefined && customerPhone !== null
            ? customerPhone
            : formData.customer_phone;
        const phoneParam =
          phoneToUse && String(phoneToUse).trim() && String(phoneToUse).trim() !== '0'
            ? String(phoneToUse).trim()
            : null;

        const requestData = {
          customer_phone: phoneParam,
          bill_amount: total,
          store_id: storeId,
        };

        const customerResponse = await api.post('/promotions/applicable', requestData);
        const promotions = customerResponse.data.data || [];
        setApplicablePromotions(promotions);

        const bestId = bestApplicablePromotionId(promotions, total);
        if (bestId) {
          const promo = promotions.find((p) => String(p.id) === bestId);
          const discount = promotionDiscountAmount(promo, total);
          setOrderDiscount(discount);
          setOrderFinal(Math.max(0, total - discount));
          setFormData((prev) => ({ ...prev, promotion_id: bestId }));
        } else {
          setOrderDiscount(0);
          setOrderFinal(total);
          setFormData((prev) => ({ ...prev, promotion_id: '' }));
        }
      } catch (error) {
        setApplicablePromotions([]);
        setOrderDiscount(0);
        setOrderFinal(total);
        setFormData((prev) => ({ ...prev, promotion_id: '' }));
      } finally {
        setLoadingPromotions(false);
      }
    } else {
      setApplicablePromotions([]);
      setLoadingPromotions(false);
      setOrderDiscount(0);
      setOrderFinal(0);
      setFormData((prev) => ({ ...prev, promotion_id: '' }));
    }
  };

  const calculateDiscount = (total, promotionId) => {
    if (!promotionId || total === 0) {
      setOrderDiscount(0);
      setOrderFinal(total);
      return;
    }

    const promotion = applicablePromotions.find(p => p.id === parseInt(promotionId));
    if (!promotion) {
      setOrderDiscount(0);
      setOrderFinal(total);
      return;
    }

    let discount = 0;
    if (promotion.discount_type === 'percentage') {
      discount = (total * promotion.discount_value) / 100;
      if (promotion.max_discount_amount && discount > promotion.max_discount_amount) {
        discount = promotion.max_discount_amount;
      }
    } else {
      discount = promotion.discount_value;
    }

    const final = total - discount;
    setOrderDiscount(discount);
    setOrderFinal(final < 0 ? 0 : final);
  };

  const handleSubmitOrder = async (e) => {
    e.preventDefault();
    if (submittingOrder) return;
    setSubmittingOrder(true);
    try {
      const orderData = {
        customer_name: formData.customer_name || '',
        customer_phone: formData.customer_phone || null,
        items: formData.items
          .filter((item) => item.product_id && item.quantity)
          .map((item) => ({
            product_id: parseInt(item.product_id),
            quantity: parseFloat(item.quantity),
          })),
        note: formData.note || null,
        promotion_id: formData.promotion_id ? parseInt(formData.promotion_id) : null,
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
      setLoadingPromotions(false);
      setOrderTotal(0);
      setOrderDiscount(0);
      setOrderFinal(0);
      
      // Ensure selectedDate is today to show the new order
      const today = format(new Date(), 'yyyy-MM-dd');
      const todayMonth = new Date().getMonth() + 1;
      const todayYear = new Date().getFullYear();
      
      // Update date state first
      if (selectedDate !== today) {
        setSelectedDate(today);
        setSelectedMonth(todayMonth);
        setSelectedYear(todayYear);
      }
      
      // Force reload orders with today's date (don't wait for useEffect)
      try {
        const params = new URLSearchParams();
        params.append('date', today);
        const response = await api.get(`/orders?${params.toString()}`);
        const allOrders = response.data.data || [];
        const filteredOrders = allOrders.filter(order => {
          const orderDate = calendarDayFromDbDateTime(order.created_at);
          return orderDate === today;
        });
        setOrders(filteredOrders);
      } catch (error) {
        console.error('Error reloading orders:', error);
      }
      
      // Reload stats - use reports API to get revenue by completion date
      try {
        const revenueRes = await api.get(`/reports/revenue?period=day&start_date=${today}&end_date=${today}`);
        const todayRevenueData = revenueRes.data.data?.[0];
        const todayRevenue = parseFloat(todayRevenueData?.total_revenue) || 0;
        
        const statsResponse = await api.get(`/orders?date=${today}`);
        const dayOrders = statsResponse.data.data || [];
        
        setStats({
          todayRevenue: todayRevenue, // Revenue calculated by completion date (updated_at)
          todayOrders: dayOrders.length || 0,
          totalAmount: dayOrders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0) || 0,
        });
      } catch (error) {
        console.error('Error reloading stats:', error);
      }
      
      // Reload again after a short delay to ensure backend has fully processed
      setTimeout(() => {
        loadOrders();
        loadStats();
      }, 1500);
    } catch (error) {
      console.error('Create order error:', error);
      const errorMessage = error.response?.data?.error || error.message || 'Tạo đơn thất bại';
      alert(errorMessage);
    } finally {
      setSubmittingOrder(false);
    }
  };

  const handleDateChange = (dateStr) => {
    setSelectedDate(dateStr);
    const date = new Date(dateStr);
    setSelectedMonth(date.getMonth() + 1);
    setSelectedYear(date.getFullYear());
  };

  const getDaysInSelectedMonth = () => {
    const days = getDaysInMonth(new Date(selectedYear, selectedMonth - 1));
    return Array.from({ length: days }, (_, i) => {
      const day = i + 1;
      const dateStr = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return {
        day,
        dateStr,
        isSelected: dateStr === selectedDate,
        isToday: dateStr === format(new Date(), 'yyyy-MM-dd'),
      };
    });
  };

  const statusColors = {
    created: 'bg-gray-100 text-gray-800',
    washing: 'bg-blue-100 text-blue-800',
    drying: 'bg-purple-100 text-purple-800',
    waiting_pickup: 'bg-orange-100 text-orange-800',
    completed: 'bg-green-100 text-green-800',
    cancelled: 'bg-red-100 text-red-800',
  };

  const statusLabels = {
    created: 'Đã tạo',
    washing: 'Đang giặt',
    drying: 'Đang sấy',
    waiting_pickup: 'Chờ lấy',
    completed: 'Hoàn thành',
    cancelled: 'Đã hủy',
  };

  // Chỉ chặn toàn trang khi đang ở tab Trang chủ; tab Ghi nợ tải riêng (loadDebtOrders)
  if (viewTab === 'home' && loading && orders.length === 0) {
    return <div className="text-center py-8">Đang tải...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Trang chủ: Stats + Date + Orders */}
      {viewTab === 'home' && (
      <>
      {/* Header with Stats */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div className="bg-white rounded-lg shadow p-3 sm:p-4">
          <div className="text-xs sm:text-sm text-gray-600 mb-1">Doanh thu</div>
          <div className="text-base sm:text-lg font-bold text-green-600">
            {new Intl.NumberFormat('vi-VN').format(parseFloat(stats.todayRevenue) || 0)} đ
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-3 sm:p-4">
          <div className="text-xs sm:text-sm text-gray-600 mb-1">Tổng đơn</div>
          <div className="text-base sm:text-lg font-bold text-blue-600">{stats.todayOrders}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-3 sm:p-4">
          <div className="text-xs sm:text-sm text-gray-600 mb-1">Tổng tiền</div>
          <div className="text-base sm:text-lg font-bold text-purple-600">
            {new Intl.NumberFormat('vi-VN').format(parseFloat(stats.totalAmount) || 0)} đ
          </div>
        </div>
      </div>

      {isEmployer() &&
        todayCheckIn &&
        calendarDayFromDbDateTime(todayCheckIn.check_in) !== format(new Date(), 'yyyy-MM-dd') && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <span>
              Bạn còn ca <strong>chưa checkout</strong> từ ngày{' '}
              <strong>{format(new Date(todayCheckIn.check_in), 'dd/MM/yyyy')}</strong>. Vào Chấm công để check-out bù (có thể nhập giờ ra) — sau đó mới mở ca mới được.
            </span>
            <button
              type="button"
              onClick={() => navigate('/timesheets')}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-700 text-white text-sm font-medium hover:bg-amber-800"
            >
              Mở Chấm công
            </button>
          </div>
        )}

      {/* Date Selector - All in Combobox */}
      <div className="bg-white rounded-lg shadow p-3 sm:p-2">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-1">
            <select
              value={selectedYear}
              onChange={(e) => {
                const year = parseInt(e.target.value) || new Date().getFullYear();
                setSelectedYear(year);
                const currentDate = new Date(selectedDate);
                const newYearDate = new Date(year, selectedMonth - 1, 1);
                let day = 1;
                if (currentDate.getFullYear() === year && currentDate.getMonth() + 1 === selectedMonth) {
                  day = currentDate.getDate();
                  const daysInMonth = getDaysInMonth(newYearDate);
                  if (day > daysInMonth) day = daysInMonth;
                }
                const newDate = `${year}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                handleDateChange(newDate);
              }}
              className="px-2 py-2 sm:py-1.5 border rounded text-sm sm:text-xs"
            >
              {Array.from({ length: 5 }, (_, i) => {
                const year = new Date().getFullYear() - 2 + i;
                return (
                  <option key={year} value={year}>
                    {year}
                  </option>
                );
              })}
            </select>
            <select
              value={selectedMonth}
              onChange={(e) => {
                const month = parseInt(e.target.value);
                setSelectedMonth(month);
                const currentDate = new Date(selectedDate);
                const newMonthDate = new Date(selectedYear, month - 1, 1);
                let day = 1;
                if (currentDate.getMonth() + 1 === month && currentDate.getFullYear() === selectedYear) {
                  day = currentDate.getDate();
                  const daysInMonth = getDaysInMonth(newMonthDate);
                  if (day > daysInMonth) day = daysInMonth;
                }
                const newDate = `${selectedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                handleDateChange(newDate);
              }}
              className="px-2 py-2 sm:py-1.5 border rounded text-sm sm:text-xs"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  Tháng {i + 1}
                </option>
              ))}
            </select>
            <select
              value={selectedDate}
              onChange={(e) => handleDateChange(e.target.value)}
              className="px-2 py-2 sm:py-1.5 border rounded text-sm sm:text-xs flex-1"
            >
              {getDaysInSelectedMonth().map(({ day, dateStr, isToday }) => {
                const date = new Date(dateStr);
                const dayOfWeek = date.getDay();
                const dayName = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][dayOfWeek];
                const displayText = isToday 
                  ? `Hôm nay - ${day}/${selectedMonth} (${dayName})`
                  : `${day}/${selectedMonth} (${dayName})`;
                return (
                  <option key={dateStr} value={dateStr}>
                    {displayText}
                  </option>
                );
              })}
            </select>
          </div>
          <button
            onClick={() => {
              if (isEmployer() && !todayCheckIn) {
                setShowCheckInPrompt(true);
              } else {
                setShowModal(true);
              }
            }}
            className="bg-blue-600 text-white px-4 py-2 sm:px-3 sm:py-1.5 rounded hover:bg-blue-700 active:bg-blue-800 text-sm sm:text-xs font-medium whitespace-nowrap w-full sm:w-auto"
          >
            + Tạo đơn
          </button>
        </div>
      </div>

      {/* Orders List */}
      <div className="space-y-1.5">
        {orders.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-4 text-center text-gray-500 text-xs sm:text-sm">
            Chưa có đơn hàng trong ngày này
          </div>
        ) : (
          // Sort: created first, then completed
          [...orders].sort((a, b) => {
            if (a.status === 'created' && b.status === 'completed') return -1;
            if (a.status === 'completed' && b.status === 'created') return 1;
            return new Date(b.created_at) - new Date(a.created_at);
          }).map((order) => (
            <div key={order.id} className="relative bg-white rounded-lg shadow-sm border border-gray-100 p-2 sm:p-2.5 hover:shadow-md transition-shadow">
              {order.status !== 'completed' && order.status !== 'cancelled' && (
                <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
                  {order.status === 'created' && (
                    <button
                      type="button"
                      onClick={() => handleOpenEditOrder(order)}
                      className="w-7 h-7 flex items-center justify-center rounded bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-700 transition-colors touch-manipulation"
                      title="Sửa đơn"
                      aria-label="Sửa đơn"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Hủy đơn hàng ${order.code}?`)) {
                        handleStatusChange(order.id, 'cancelled');
                      }
                    }}
                    className="w-7 h-7 flex items-center justify-center rounded bg-red-500 text-white hover:bg-red-600 active:bg-red-700 transition-colors touch-manipulation text-lg leading-none"
                    title="Hủy đơn"
                    aria-label="Hủy đơn"
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <div className={`flex-1 min-w-0 ${order.status !== 'completed' && order.status !== 'cancelled' ? 'pr-14' : 'pr-0'}`}>
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span className="font-semibold text-xs sm:text-sm text-gray-800 truncate">{order.code}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-medium whitespace-nowrap ${
                        statusColors[order.status] || statusColors.created
                      }`}
                    >
                      {statusLabels[order.status] || order.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] sm:text-xs text-gray-600 mb-0.5">
                    <span className="truncate">{order.customer_name || order.customer_phone || 'N/A'}</span>
                    {order.items && order.items.length > 0 && (
                      <span className="text-gray-400 whitespace-nowrap">
                        • {order.items.length} sp
                      </span>
                    )}
                  </div>
                  {order.items && order.items.length > 0 && (
                    <div className="text-[10px] sm:text-xs text-gray-500 truncate">
                      {order.items.slice(0, 1).map((item) => (
                        <span key={item.id}>
                          {item.product_name} x{item.quantity} {item.product_unit}
                        </span>
                      ))}
                      {order.items.length > 1 && (
                        <span className="text-gray-400 ml-1">+{order.items.length - 1}</span>
                      )}
                    </div>
                  )}
                </div>
                <div className={`text-right flex-shrink-0 ${order.status !== 'completed' && order.status !== 'cancelled' ? 'mt-6' : ''}`}>
                  <div className="text-sm sm:text-base font-bold text-gray-800 leading-tight">
                    {new Intl.NumberFormat('vi-VN').format(parseFloat(order.final_amount) || parseFloat(order.total_amount) || 0)} đ
                  </div>
                  {order.discount_amount > 0 && (
                    <div className="text-[10px] text-gray-400 line-through">
                      {new Intl.NumberFormat('vi-VN').format(parseFloat(order.total_amount) || 0)} đ
                    </div>
                  )}
                </div>
              </div>
              {/* Nút thao tác: khi đơn chưa hoàn thành và chưa hủy */}
              {order.status !== 'completed' && order.status !== 'cancelled' && (
                <div className="flex flex-row flex-nowrap gap-1.5 sm:gap-2 mt-2 pt-2 border-t border-gray-100 justify-end overflow-x-auto">
                  {order.status === 'created' && (
                    <>
                      <button
                        onClick={() => handleCompleteClick(order)}
                        className="flex-1 min-w-0 py-1.5 px-2 bg-green-600 text-white rounded text-[10px] sm:text-xs font-medium hover:bg-green-700 active:bg-green-800 whitespace-nowrap touch-manipulation"
                      >
                        ✓ Hoàn thành
                      </button>
                      <button
                        onClick={() => handleMarkDebt(order)}
                        className="flex-1 min-w-0 py-1.5 px-2 bg-amber-500 text-white rounded text-[10px] sm:text-xs font-medium hover:bg-amber-600 active:bg-amber-700 whitespace-nowrap touch-manipulation"
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
                        className="flex-1 min-w-0 py-1.5 px-2 bg-blue-600 text-white rounded text-[10px] sm:text-xs font-medium hover:bg-blue-700 disabled:opacity-50 active:bg-blue-800 whitespace-nowrap touch-manipulation"
                      >
                        {printing ? '...' : '🖨️ In bill'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      </>
      )}

      {/* Tab Ghi nợ: Danh sách đơn ghi nợ */}
      {viewTab === 'debt' && (
      <div className="bg-white rounded-lg shadow">
        <div className="p-3 sm:p-4 border-b">
          <div className="mt-3">
            <input
              type="text"
              placeholder="Tìm theo tên khách hàng..."
              value={debtSearchQuery}
              onChange={(e) => setDebtSearchQuery(e.target.value)}
              className="w-full sm:w-64 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
            />
          </div>
        </div>
        {debtOrdersLoading ? (
          <div className="p-6 text-center text-gray-500 text-sm">Đang tải...</div>
        ) : (() => {
          const q = (debtSearchQuery || '').trim().toLowerCase();
          const notCancelled = debtOrders.filter((o) => o.status !== 'cancelled');
          const filtered = q
            ? notCancelled.filter((o) => {
                const name = (o.customer_name || o.customer_phone || '').toString().toLowerCase();
                return name.includes(q);
              })
            : notCancelled;
          if (filtered.length === 0) {
            return (
              <div className="p-6 text-center text-gray-500 text-sm">
                {notCancelled.length === 0 ? 'Chưa có đơn ghi nợ' : 'Không tìm thấy đơn nào theo tên khách hàng'}
              </div>
            );
          }
          return (
          <div className="divide-y">
            {filtered.map((order) => (
              <div key={order.id} className="p-3 sm:p-4 hover:bg-gray-50">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm text-gray-800">{order.code}</span>
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">Ghi nợ</span>
                    </div>
                    <div className="text-xs text-gray-600">
                      <span className="font-medium">Khách:</span> {order.customer_name || order.customer_phone || 'N/A'}
                      {order.customer_phone && !order.customer_phone.startsWith('temp_') && ` • ${order.customer_phone}`}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-bold text-gray-800">
                      {new Intl.NumberFormat('vi-VN').format(parseFloat(order.final_amount) || 0)} đ
                    </div>
                  </div>
                </div>
                {order.items && order.items.length > 0 && (
                  <div className="border-t pt-2 mt-2 text-xs text-gray-600">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex justify-between">
                        <span>{item.product_name} x{item.quantity} {item.product_unit}</span>
                        <span>{new Intl.NumberFormat('vi-VN').format((item.quantity || 0) * (item.unit_price || 0))} đ</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t">
                  <button
                    onClick={() => openDebtPayModal(order)}
                    className="flex-1 min-w-0 px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
                  >
                    Đã Thanh Toán
                  </button>
                  <button
                    onClick={async () => {
                      setPrinting(true);
                      try {
                        const result = await printBill(order.id);
                        alert(`Bill đã được in! (Phương thức: ${result.method === 'bluetooth' ? 'Bluetooth' : 'Server'})`);
                      } catch (printError) {
                        console.error('Print error:', printError);
                        alert(printError.message || 'In bill thất bại.');
                      } finally {
                        setPrinting(false);
                      }
                    }}
                    disabled={printing}
                    className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                  >
                    {printing ? '...' : 'In bill'}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Hủy đơn hàng ${order.code}? Đơn ghi nợ sẽ bị hủy.`)) {
                        handleStatusChange(order.id, 'cancelled').then(() => loadDebtOrders());
                      }
                    }}
                    className="px-3 py-2 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600"
                  >
                    Hủy đơn
                  </button>
                </div>
              </div>
            ))}
          </div>
          );
        })()}
      </div>
      )}

      {/* Modal thanh toán ghi nợ — chọn hình thức để báo cáo doanh thu theo PM */}
      {showDebtPayModal && orderForDebtPay && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-2 sm:p-3 z-50 overflow-y-auto overflow-x-hidden">
          <div className="bg-white rounded-lg max-w-sm w-full max-h-[90vh] flex flex-col my-auto shadow-2xl">
            <div className="flex items-center justify-between p-4 sm:p-5 pb-3 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-base sm:text-lg font-bold text-gray-900 truncate pr-2">Xác nhận thanh toán ghi nợ</h2>
              <button
                type="button"
                onClick={closeDebtPayModal}
                disabled={debtPaySubmitting}
                className="text-gray-500 hover:text-gray-700 text-xl w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 active:bg-gray-200 touch-manipulation disabled:opacity-50"
                aria-label="Đóng"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-5">
              <p className="text-sm text-gray-600 py-2">
                Doanh thu sẽ ghi nhận theo ngày thanh toán và theo hình thức bạn chọn bên dưới.
              </p>
              <div className="bg-gradient-to-r from-amber-50 to-amber-100 rounded-xl border border-amber-200 p-3 overflow-hidden mb-3">
                <div className="text-xs sm:text-sm text-gray-600 mb-1 font-medium">Đơn: #{orderForDebtPay.code}</div>
                <div className="text-xl sm:text-2xl font-bold text-amber-800 break-words">
                  {parseFloat(orderForDebtPay.final_amount || orderForDebtPay.total_amount || 0).toLocaleString('vi-VN')} đ
                </div>
                {orderForDebtPay.customer_name && (
                  <div className="text-xs text-gray-600 mt-2">👤 {orderForDebtPay.customer_name}</div>
                )}
              </div>
              <div className="min-w-0 pb-2">
                <label className="block text-sm sm:text-base font-semibold text-gray-700 mb-2.5">
                  Phương thức thanh toán
                </label>
                <div className="grid grid-cols-2 gap-2.5 min-w-0">
                  <label
                    className={`flex flex-col items-center justify-center p-3.5 rounded-xl border-2 cursor-pointer touch-manipulation transition-all min-w-0 ${
                      debtPayPaymentMethod === 'cash'
                        ? 'border-green-500 bg-green-50 shadow-md'
                        : 'border-gray-200 bg-gray-50 active:bg-gray-100'
                    }`}
                  >
                    <input
                      type="radio"
                      name="debt_pay_payment_method"
                      value="cash"
                      checked={debtPayPaymentMethod === 'cash'}
                      onChange={(e) => setDebtPayPaymentMethod(e.target.value)}
                      className="sr-only"
                    />
                    <span className="text-2xl mb-1">💰</span>
                    <span className="text-sm font-semibold text-center break-words">Tiền mặt</span>
                  </label>
                  <label
                    className={`flex flex-col items-center justify-center p-3.5 rounded-xl border-2 cursor-pointer touch-manipulation transition-all min-w-0 ${
                      debtPayPaymentMethod === 'transfer'
                        ? 'border-blue-500 bg-blue-50 shadow-md'
                        : 'border-gray-200 bg-gray-50 active:bg-gray-100'
                    }`}
                  >
                    <input
                      type="radio"
                      name="debt_pay_payment_method"
                      value="transfer"
                      checked={debtPayPaymentMethod === 'transfer'}
                      onChange={(e) => setDebtPayPaymentMethod(e.target.value)}
                      className="sr-only"
                    />
                    <span className="text-2xl mb-1">🏦</span>
                    <span className="text-sm font-semibold text-center break-words">Chuyển khoản</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="flex flex-row gap-2.5 px-4 sm:px-5 pb-4 pt-2 border-t border-gray-200 flex-shrink-0">
              <button
                type="button"
                onClick={handleConfirmDebtPaid}
                disabled={debtPaySubmitting}
                className="flex-1 min-w-0 bg-gradient-to-r from-green-500 to-green-600 text-white py-3 rounded-xl active:from-green-600 active:to-green-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation font-semibold text-base shadow-lg"
              >
                {debtPaySubmitting ? '⏳ Đang xử lý...' : '✓ Xác nhận đã thanh toán'}
              </button>
              <button
                type="button"
                onClick={closeDebtPayModal}
                disabled={debtPaySubmitting}
                className="flex-1 min-w-0 bg-gray-200 text-gray-800 py-3 rounded-xl active:bg-gray-300 transition-colors touch-manipulation text-base font-medium"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Popup nhắc check-in khi nhân viên chưa check-in mà bấm Tạo đơn */}
      {showCheckInPrompt && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-3 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-4">
            <h3 className="text-base font-bold text-gray-800 mb-1">Chưa check-in</h3>
            <p className="text-sm text-gray-600 mb-4">Vui lòng check-in trước khi tạo đơn hàng.</p>
            {checkInEmployees.length > 0 ? (
              <>
                {!getEmployeeId() && (
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Chọn nhân viên</label>
                    <select
                      value={checkInEmployeeId}
                      onChange={(e) => setCheckInEmployeeId(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                    >
                      <option value="">-- Chọn tên của bạn --</option>
                      {checkInEmployees.map((emp) => (
                        <option key={emp.id} value={emp.id}>{emp.name}{emp.phone ? ` (${emp.phone})` : ''}</option>
                      ))}
                    </select>
                  </div>
                )}
                {getEmployeeId() && (
                  <div className="mb-3 text-xs text-gray-500">Nhân viên đã chọn khi đăng nhập.</div>
                )}
                <div className="mb-4">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Ghi chú (tùy chọn)</label>
                  <input
                    type="text"
                    value={checkInNote}
                    onChange={(e) => setCheckInNote(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                    placeholder="Ghi chú ca làm việc..."
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-amber-700 mb-4">Chưa có danh sách nhân viên. Vui lòng vào Chấm công để check-in hoặc liên hệ admin.</p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleCheckInFromPrompt}
                disabled={checkInLoading || (checkInEmployees.length > 0 && !getEmployeeId() && !checkInEmployeeId)}
                className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {checkInLoading ? 'Đang xử lý...' : 'Check-in ngay'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCheckInPrompt(false);
                  navigate('/timesheets');
                }}
                className="flex-1 bg-gray-200 text-gray-800 py-2 rounded-lg text-sm font-medium hover:bg-gray-300"
              >
                Đi đến Chấm công
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowCheckInPrompt(false)}
              className="mt-3 w-full text-gray-500 text-sm hover:text-gray-700"
            >
              Đóng
            </button>
          </div>
        </div>
      )}

      {/* Create Order Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-2 sm:p-3 z-50 overflow-y-auto overflow-x-hidden">
          <div className="bg-white rounded-lg max-w-xl w-full max-h-[90vh] flex flex-col my-auto shadow-2xl">
            <div className="flex items-center justify-between p-2.5 sm:p-3 md:p-4 pb-2 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-sm sm:text-base font-bold truncate pr-2">Tạo đơn hàng mới</h2>
              <button
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
                  setLoadingPromotions(false);
                }}
                className="text-gray-500 hover:text-gray-700 text-xl w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 touch-manipulation"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 sm:px-3 md:px-4">
              <form onSubmit={handleSubmitOrder} className="space-y-2 min-w-0 py-2">
              <div className="grid grid-cols-2 gap-1.5 sm:gap-2 min-w-0">
                <div className="relative min-w-0">
                  <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-0.5">
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
                    className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                    placeholder="Nhập tên khách hàng"
                  />
                  {showCustomerSuggestions && customerSuggestions.length > 0 && (
                    <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-xl max-h-48 overflow-y-auto overflow-x-hidden">
                      {customerSuggestions.map((customer) => (
                        <div
                          key={customer.id}
                          onClick={() => handleCustomerSelect(customer)}
                          className="px-3 py-2 hover:bg-blue-50 active:bg-blue-100 cursor-pointer border-b border-gray-100 last:border-b-0 touch-manipulation min-w-0"
                        >
                          <div className="font-medium text-gray-900 text-sm truncate">{customer.name || 'Không có tên'}</div>
                          <div className="text-xs text-gray-600 truncate">{customer.phone}</div>
                          {customer.total_orders > 0 && (
                            <div className="text-[10px] text-gray-500 mt-0.5 truncate">
                              {customer.total_orders} đơn • {new Intl.NumberFormat('vi-VN').format(customer.total_spent || 0)} đ
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="relative min-w-0">
                  <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-0.5">
                    SĐT <span className="text-gray-500 text-[9px]">(tùy chọn)</span>
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
                    className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 touch-manipulation"
                    placeholder="Nhập số điện thoại"
                    autoComplete="tel"
                  />
                  {showCustomerSuggestions && customerSuggestions.length > 0 && (
                    <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-xl max-h-48 overflow-y-auto overflow-x-hidden">
                      {customerSuggestions.map((customer) => (
                        <div
                          key={customer.id}
                          onClick={() => handleCustomerSelect(customer)}
                          className="px-3 py-2 hover:bg-blue-50 active:bg-blue-100 cursor-pointer border-b border-gray-100 last:border-b-0 touch-manipulation min-w-0"
                        >
                          <div className="font-medium text-gray-900 text-sm truncate">{customer.name || 'Không có tên'}</div>
                          <div className="text-xs text-gray-600 truncate">{customer.phone}</div>
                          {customer.total_orders > 0 && (
                            <div className="text-[10px] text-gray-500 mt-0.5 truncate">
                              {customer.total_orders} đơn • {new Intl.NumberFormat('vi-VN').format(customer.total_spent || 0)} đ
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="min-w-0">
                <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-1">Sản phẩm</label>
                <div className="space-y-1.5 min-w-0">
                  {formData.items.map((item, index) => (
                    <div key={index} className="flex gap-1 min-w-0">
                      <select
                        value={item.product_id}
                        onChange={(e) => handleItemChange(index, 'product_id', e.target.value)}
                        className="flex-1 min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 touch-manipulation"
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
                        inputMode="decimal"
                        step="0.1"
                        min="0.1"
                        placeholder="SL"
                        value={item.quantity}
                        onChange={(e) => handleItemChange(index, 'quantity', e.target.value)}
                        className="w-20 min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                        required
                      />
                      {formData.items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(index)}
                          className="px-2 py-1.5 flex-shrink-0 bg-red-100 text-red-600 rounded-lg active:bg-red-200 hover:bg-red-200 text-[10px] sm:text-xs font-medium touch-manipulation"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={handleAddItem}
                    className="w-full min-w-0 px-2 py-1.5 text-xs sm:text-sm text-blue-600 active:text-blue-700 hover:text-blue-700 border border-blue-600 rounded-lg active:bg-blue-50 hover:bg-blue-50 font-medium touch-manipulation"
                  >
                    + Thêm sản phẩm
                  </button>
                </div>
              </div>

              <div className="min-w-0">
                <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-0.5">
                  Khuyến mãi <span className="text-gray-500 text-[9px]">(tùy chọn)</span>
                </label>
                {loadingPromotions ? (
                  <div className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm bg-gray-50 text-gray-500 break-words">
                    Đang tải...
                  </div>
                ) : applicablePromotions.length > 0 ? (
                  <select
                    value={formData.promotion_id}
                    onChange={(e) => {
                      const newPromotionId = e.target.value;
                      setFormData({ ...formData, promotion_id: newPromotionId });
                      // Recalculate discount when promotion changes
                      calculateDiscount(orderTotal, newPromotionId);
                    }}
                    className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                  >
                    <option value="">Không áp dụng</option>
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
                  <div className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm bg-gray-50 text-gray-500 break-words">
                    {formData.items.some(item => item.product_id && item.quantity) 
                      ? 'Không có khuyến mãi' 
                      : 'Thêm sản phẩm để xem khuyến mãi'}
                  </div>
                )}
              </div>

              <div className="min-w-0">
                <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-0.5">Ghi chú</label>
                <textarea
                  value={formData.note}
                  onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                  className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 touch-manipulation resize-none"
                  rows="2"
                  placeholder="Ghi chú (tùy chọn)"
                />
              </div>

              {/* Order Summary */}
              {orderTotal > 0 && (
                <div className="bg-gray-50 p-2 rounded-lg space-y-1">
                  <div className="flex justify-between text-xs sm:text-sm">
                    <span className="text-gray-600">Tổng tiền:</span>
                    <span className="font-medium">{new Intl.NumberFormat('vi-VN').format(orderTotal)} đ</span>
                  </div>
                  {orderDiscount > 0 && (
                    <>
                      <div className="flex justify-between text-xs sm:text-sm">
                        <span className="text-gray-600">Giảm giá:</span>
                        <span className="font-medium text-red-600">-{new Intl.NumberFormat('vi-VN').format(orderDiscount)} đ</span>
                      </div>
                      <div className="flex justify-between text-sm sm:text-base font-bold pt-1 border-t border-gray-300">
                        <span>Thành tiền:</span>
                        <span className="text-blue-600">{new Intl.NumberFormat('vi-VN').format(orderFinal)} đ</span>
                      </div>
                    </>
                  )}
                  {orderDiscount === 0 && (
                    <div className="flex justify-between text-sm sm:text-base font-bold pt-1 border-t border-gray-300">
                      <span>Thành tiền:</span>
                      <span className="text-blue-600">{new Intl.NumberFormat('vi-VN').format(orderTotal)} đ</span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-row gap-1.5 pt-2 border-t border-gray-200 min-w-0">
                <button
                  type="submit"
                  disabled={submittingOrder}
                  className="flex-1 min-w-0 bg-gradient-to-r from-blue-600 to-blue-700 text-white py-2 rounded-lg hover:from-blue-700 hover:to-blue-800 active:from-blue-800 active:to-blue-900 font-semibold text-xs sm:text-sm shadow-md transition-all touch-manipulation disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submittingOrder ? 'Đang tạo...' : '✓ Tạo đơn'}
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
                    setLoadingPromotions(false);
                  }}
                  className="flex-1 min-w-0 bg-gray-200 text-gray-800 py-2 rounded-lg hover:bg-gray-300 active:bg-gray-400 font-medium text-xs sm:text-sm transition-all touch-manipulation"
                >
                  Hủy
                </button>
              </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Edit Order Modal (nhân viên) */}
      {showEditModal && orderToEdit && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-2 sm:p-3 z-50 overflow-y-auto overflow-x-hidden">
          <div className="bg-white rounded-lg max-w-xl w-full max-h-[90vh] flex flex-col my-auto shadow-2xl">
            <div className="flex items-center justify-between p-2.5 sm:p-3 md:p-4 pb-2 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-sm sm:text-base font-bold truncate pr-2">Sửa đơn hàng {orderToEdit.code}</h2>
              <button
                onClick={handleCloseEditModal}
                className="text-gray-500 hover:text-gray-700 text-xl w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 sm:px-3 md:px-4">
              <form onSubmit={handleSubmitEditOrder} className="space-y-2 min-w-0 py-2">
                <div className="grid grid-cols-2 gap-1.5 sm:gap-2 min-w-0">
                  <div className="min-w-0">
                    <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-0.5">Tên khách hàng</label>
                    <input
                      type="text"
                      value={formData.customer_name}
                      onChange={(e) => setFormData({ ...formData, customer_name: e.target.value })}
                      className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm"
                      placeholder="Tên khách hàng"
                    />
                  </div>
                  <div className="min-w-0">
                    <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-0.5">SĐT</label>
                    <input
                      type="tel"
                      value={formData.customer_phone}
                      onChange={(e) => setFormData({ ...formData, customer_phone: e.target.value })}
                      className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm"
                      placeholder="Số điện thoại"
                    />
                  </div>
                </div>
                <div className="min-w-0">
                  <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-1">Sản phẩm</label>
                  <div className="space-y-1.5 min-w-0">
                    {formData.items.map((item, index) => (
                      <div key={index} className="flex gap-1 min-w-0">
                        <select
                          value={item.product_id}
                          onChange={(e) => handleItemChange(index, 'product_id', e.target.value)}
                          className="flex-1 min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm"
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
                          inputMode="decimal"
                          step="0.1"
                          min="0.1"
                          placeholder="SL"
                          value={item.quantity}
                          onChange={(e) => handleItemChange(index, 'quantity', e.target.value)}
                          className="w-20 min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm"
                          required
                        />
                        {formData.items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveItem(index)}
                            className="px-2 py-1.5 flex-shrink-0 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 text-[10px] sm:text-xs font-medium"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={handleAddItem}
                      className="w-full min-w-0 px-2 py-1.5 text-xs sm:text-sm text-blue-600 border border-blue-600 rounded-lg hover:bg-blue-50 font-medium"
                    >
                      + Thêm sản phẩm
                    </button>
                  </div>
                </div>
                <div className="min-w-0">
                  <label className="block text-[10px] sm:text-xs font-medium text-gray-700 mb-0.5">Ghi chú</label>
                  <textarea
                    value={formData.note}
                    onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                    className="w-full min-w-0 px-2 py-1.5 border rounded-lg text-xs sm:text-sm resize-none"
                    rows="2"
                    placeholder="Ghi chú (tùy chọn)"
                  />
                </div>
                {orderTotal > 0 && (
                  <div className="bg-gray-50 p-2 rounded-lg">
                    <div className="flex justify-between text-sm font-bold">
                      <span className="text-gray-600">Thành tiền:</span>
                      <span className="text-blue-600">{new Intl.NumberFormat('vi-VN').format(orderTotal)} đ</span>
                    </div>
                  </div>
                )}
                <div className="flex gap-1.5 pt-2 border-t border-gray-200">
                  <button
                    type="submit"
                    disabled={savingEdit}
                    className="flex-1 bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 font-semibold text-sm disabled:opacity-50"
                  >
                    {savingEdit ? 'Đang lưu...' : 'Lưu thay đổi'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCloseEditModal}
                    className="flex-1 bg-gray-200 text-gray-800 py-2 rounded-lg hover:bg-gray-300 font-medium text-sm"
                  >
                    Hủy
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Complete Order Modal */}
      {showCompleteModal && orderToComplete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-2 sm:p-3 z-50 overflow-y-auto overflow-x-hidden">
          <div className="bg-white rounded-lg max-w-sm w-full max-h-[90vh] flex flex-col my-auto shadow-2xl">
            <div className="flex items-center justify-between p-4 sm:p-5 pb-3 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-base sm:text-lg font-bold text-gray-900 truncate pr-2">Hoàn thành đơn hàng</h2>
              <button
                type="button"
                onClick={() => {
                  setShowCompleteModal(false);
                  setOrderToComplete(null);
                  setShouldPrint(false);
                  setPaymentMethod('cash');
                }}
                disabled={printing}
                className="text-gray-500 hover:text-gray-700 text-xl w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 active:bg-gray-200 touch-manipulation disabled:opacity-50"
                aria-label="Đóng"
              >
                ×
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-5">
              <div className="space-y-3 min-w-0 py-2">
                <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-xl border border-blue-200 p-3 overflow-hidden">
                  <div className="text-xs sm:text-sm text-gray-600 mb-1 font-medium">Đơn hàng: #{orderToComplete.code}</div>
                  <div className="text-xl sm:text-2xl font-bold text-blue-600 break-words">
                    {parseFloat(orderToComplete.final_amount || orderToComplete.total_amount || 0).toLocaleString('vi-VN')} đ
                  </div>
                  {orderToComplete.customer_name && (
                    <div className="text-xs text-gray-600 mt-2">
                      👤 {orderToComplete.customer_name}
                    </div>
                  )}
                </div>
                
                <div className="min-w-0">
                  <label className="block text-sm sm:text-base font-semibold text-gray-700 mb-2.5">
                    Phương thức thanh toán
                  </label>
                  <div className="grid grid-cols-2 gap-2.5 min-w-0">
                    <label className={`flex flex-col items-center justify-center p-3.5 rounded-xl border-2 cursor-pointer touch-manipulation transition-all min-w-0 ${
                      paymentMethod === 'cash' 
                        ? 'border-green-500 bg-green-50 shadow-md' 
                        : 'border-gray-200 bg-gray-50 active:bg-gray-100'
                    }`}>
                      <input
                        type="radio"
                        name="payment_method"
                        value="cash"
                        checked={paymentMethod === 'cash'}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                        className="sr-only"
                      />
                      <span className="text-2xl mb-1">💰</span>
                      <span className="text-sm font-semibold text-center break-words">Tiền mặt</span>
                    </label>
                    <label className={`flex flex-col items-center justify-center p-3.5 rounded-xl border-2 cursor-pointer touch-manipulation transition-all min-w-0 ${
                      paymentMethod === 'transfer' 
                        ? 'border-blue-500 bg-blue-50 shadow-md' 
                        : 'border-gray-200 bg-gray-50 active:bg-gray-100'
                    }`}>
                      <input
                        type="radio"
                        name="payment_method"
                        value="transfer"
                        checked={paymentMethod === 'transfer'}
                        onChange={(e) => setPaymentMethod(e.target.value)}
                        className="sr-only"
                      />
                      <span className="text-2xl mb-1">🏦</span>
                      <span className="text-sm font-semibold text-center break-words">Chuyển khoản</span>
                    </label>
                  </div>
                </div>

              </div>
            </div>

            <div className="flex flex-row gap-2.5 px-4 sm:px-5 pb-4 pt-2 border-t border-gray-200 flex-shrink-0">
              <button
                onClick={handleCompleteOrder}
                disabled={printing}
                className="flex-1 min-w-0 bg-gradient-to-r from-green-500 to-green-600 text-white py-3 rounded-xl active:from-green-600 active:to-green-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation font-semibold text-base shadow-lg"
              >
                {printing ? '⏳ Đang xử lý...' : '✓ Hoàn thành'}
              </button>
              <button
                onClick={() => {
                  setShowCompleteModal(false);
                  setOrderToComplete(null);
                  setShouldPrint(false);
                  setPaymentMethod('cash');
                }}
                disabled={printing}
                className="flex-1 min-w-0 bg-gray-200 text-gray-800 py-3 rounded-xl active:bg-gray-300 transition-colors touch-manipulation text-base font-medium"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Home;

