import { useEffect, useState } from 'react';
import PageSkeleton from '../components/PageSkeleton';
import { showToast } from '../utils/toast';
import api from '../utils/api';
import { format } from 'date-fns';
import MoneyInput from '../components/MoneyInput';

function PendingOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [orderToComplete, setOrderToComplete] = useState(null);
  const [printing, setPrinting] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [customAmountPaid, setCustomAmountPaid] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadPendingOrders();
  }, []);

  const loadPendingOrders = async () => {
    try {
      // Không bật spinner khi refresh — giữ dữ liệu cũ trên màn hình (lần đầu đã có useState(true))
      const params = new URLSearchParams();
      params.append('my_orders', 'true');
      // Lọc "chưa hoàn thành" ở server — trước đây tải TOÀN BỘ lịch sử đơn của
      // tiệm rồi mới lọc ở đây (hàng chục MB khi tiệm chạy vài năm)
      params.append('pending_only', 'true');

      const response = await api.get(`/orders?${params.toString()}`);
      const allOrders = response.data.data || [];
      
      // Filter chỉ lấy đơn hàng chưa hoàn thành (status !== 'completed')
      const pendingOrders = allOrders.filter(order => order.status !== 'completed');
      
      // Sắp xếp theo ngày tạo mới nhất
      pendingOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      
      setOrders(pendingOrders);
    } catch (error) {
      console.error('Error loading pending orders:', error);
      setOrders([]);
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteClick = (order) => {
    setOrderToComplete(order);
    setShowCompleteModal(true);
    setPaymentMethod('cash');
    setCustomAmountPaid('');
  };

  const handleCompleteOrder = async () => {
    if (!orderToComplete) return;

    try {
      if (!paymentMethod) {
        showToast('Vui lòng chọn hình thức thanh toán');
        return;
      }

      // Trừ số đã thu trước đó — nếu không, đơn đã trả một phần cho phép nhập
      // tới TOÀN BỘ final_amount ở FE, rồi bị BE từ chối "exceeds remaining"
      // (BE luôn tính cap theo phần CÒN LẠI, xem orderPaymentService.js)
      const paidSoFar = parseFloat(orderToComplete.paid_amount) || 0;
      const maxAmount = Math.max((parseFloat(orderToComplete.final_amount ?? orderToComplete.total_amount ?? 0) || 0) - paidSoFar, 0);
      let amountPaid = null;
      if (customAmountPaid !== '') {
        amountPaid = parseFloat(customAmountPaid);
        if (isNaN(amountPaid) || amountPaid < 0) {
          showToast('Số tiền thanh toán phải là số không âm');
          return;
        }
        if (amountPaid > maxAmount + 0.01) {
          showToast(`Số tiền thanh toán không được vượt quá ${maxAmount.toLocaleString('vi-VN')} đ`);
          return;
        }
      }

      setPrinting(true);

      const payload = {
        status: 'completed',
        payment_method: paymentMethod,
      };
      if (amountPaid !== null) {
        payload.amount_paid = Math.round(amountPaid * 100) / 100;
      }

      await api.post(`/orders/${orderToComplete.id}/status`, payload);

      setShowCompleteModal(false);
      setOrderToComplete(null);
      setPaymentMethod('cash');
      setCustomAmountPaid('');
      setPrinting(false);
      
      // Reload orders
      loadPendingOrders();
    } catch (error) {
      showToast(error.response?.data?.error || 'Cập nhật thất bại');
      setPrinting(false);
    }
  };

  const handleStatusChange = async (orderId, newStatus) => {
    // Optimistic: đổi trạng thái tại chỗ (KHÔNG remove — reload vẫn giữ đơn hủy
    // trong danh sách dạng "Đã hủy", remove rồi hiện lại sẽ gây giật). Lỗi thì
    // chỉ hoàn tác đúng đơn này để không đè lên thao tác song song trên đơn khác
    const prevStatus = orders.find((o) => o.id === orderId)?.status;
    setOrders((cur) => cur.map((o) => (o.id === orderId ? { ...o, status: newStatus } : o)));
    try {
      await api.post(`/orders/${orderId}/status`, { status: newStatus });
      loadPendingOrders();
    } catch (error) {
      setOrders((cur) => cur.map((o) => (o.id === orderId ? { ...o, status: prevStatus } : o)));
      showToast(error.response?.data?.error || 'Cập nhật thất bại');
    }
  };

  const handleCompleteAsDebt = async (order) => {
    if (!confirm(`Chuyển đơn ${order.code} sang ghi nợ? Đơn sẽ không tính doanh thu cho đến khi nhân viên bấm "Đã thanh toán" trong menu Ghi nợ.`)) return;
    try {
      // Completing with amount_paid:0 already marks the order as debt; the extra
      // PATCH /debt used to 400 and make a successful action report failure.
      await api.post(`/orders/${order.id}/status`, {
        status: 'completed',
        amount_paid: 0,
        delivery_method: 'pickup',
      });
      loadPendingOrders();
    } catch (error) {
      showToast(error.response?.data?.error || 'Thao tác thất bại');
    }
  };

  const statusColors = {
    created: 'bg-yellow-100 text-yellow-800',
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
    waiting_pickup: 'Chờ nhận',
    completed: 'Hoàn thành',
    cancelled: 'Đã hủy',
  };

  if (loading) {
    return <PageSkeleton />;
  }

  const q = (searchQuery || '').trim().toLowerCase();
  const filteredOrders = q
    ? orders.filter((o) => {
        const name = (o.customer_name || o.customer_phone || '').toString().toLowerCase();
        return name.includes(q);
      })
    : orders;

  return (
    <div className="space-y-2 sm:space-y-3">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Tồn kho</h1>
          <p className="text-xs sm:text-sm text-gray-600 mt-0.5">Đơn hàng chưa hoàn thành</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <input
            type="text"
            placeholder="Tìm theo tên khách hàng..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 sm:w-56 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          <div className="text-xs sm:text-sm text-gray-600 whitespace-nowrap bg-blue-50 px-3 py-1.5 rounded-lg flex-shrink-0">
            <span className="font-semibold text-blue-600">{filteredOrders.length}</span> đơn
          </div>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-6 text-center">
          <div className="text-5xl mb-3">📦</div>
          <h3 className="text-lg font-semibold text-gray-700 mb-1">Không có đơn hàng</h3>
          <p className="text-sm text-gray-500">Tất cả đơn hàng đã được hoàn thành</p>
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-6 text-center">
          <div className="text-4xl mb-2">🔍</div>
          <h3 className="text-base font-semibold text-gray-700 mb-1">Không tìm thấy đơn nào</h3>
          <p className="text-sm text-gray-500">Thử đổi từ khóa tìm theo tên khách hàng</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-2.5 sm:p-3 hover:shadow-md transition-all"
            >
              {/* Header: Code, Status, Amount */}
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <h3 className="text-sm sm:text-base font-semibold text-gray-900 truncate">
                    #{order.code}
                  </h3>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-medium whitespace-nowrap flex-shrink-0 ${
                      statusColors[order.status] || 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {statusLabels[order.status] || order.status}
                  </span>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-base sm:text-lg font-bold text-blue-600">
                    {parseFloat(order.final_amount ?? order.total_amount ?? 0).toLocaleString('vi-VN')} đ
                  </div>
                  {order.discount_amount > 0 && (
                    <div className="text-[10px] text-gray-500 line-through">
                      {parseFloat(order.total_amount || 0).toLocaleString('vi-VN')} đ
                    </div>
                  )}
                </div>
              </div>

              {/* Customer & Date - Compact */}
              <div className="flex items-center gap-3 text-xs text-gray-600 mb-2 flex-wrap">
                <span className="truncate">
                  👤 {order.customer_name || order.customer_phone || 'Khách vãng lai'}
                </span>
                {order.customer_phone && !order.customer_phone.startsWith('temp_') && (
                  <span className="text-gray-500">• {order.customer_phone}</span>
                )}
                <span className="text-gray-500">
                  • {format(new Date(order.created_at), 'dd/MM HH:mm')}
                </span>
              </div>

              {/* Order Items - Compact */}
              {order.items && order.items.length > 0 && (
                <div className="border-t border-gray-100 pt-2 mb-2">
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
                    {order.items.slice(0, 3).map((item, idx) => (
                      <span key={idx}>
                        {item.product_name} x{item.quantity}
                      </span>
                    ))}
                    {order.items.length > 3 && (
                      <span className="text-gray-500">+{order.items.length - 3} sản phẩm</span>
                    )}
                  </div>
                </div>
              )}

              {/* Note - Compact */}
              {order.note && (
                <div className="text-xs text-gray-500 italic mb-2 truncate" title={order.note}>
                  📝 {order.note}
                </div>
              )}

              {/* Actions - Compact */}
              <div className="flex gap-1.5 pt-2 border-t border-gray-100">
                {order.status !== 'completed' && order.status !== 'cancelled' && (
                  <>
                    <button
                      onClick={() => handleCompleteClick(order)}
                      className="flex-1 bg-gradient-to-r from-green-500 to-green-600 text-white px-3 py-1.5 rounded-lg active:bg-green-700 hover:from-green-600 hover:to-green-700 transition-all text-xs sm:text-sm font-medium touch-manipulation shadow-sm"
                    >
                      ✓ Hoàn thành
                    </button>
                    <button
                      onClick={() => handleCompleteAsDebt(order)}
                      className="px-3 py-1.5 bg-amber-500 text-white rounded-lg active:bg-amber-600 hover:bg-amber-600 transition-colors text-xs sm:text-sm font-medium touch-manipulation shadow-sm"
                    >
                      Ghi nợ
                    </button>
                    <button
                      onClick={() => handleStatusChange(order.id, 'cancelled')}
                      className="px-2.5 py-1.5 bg-red-500 text-white rounded-lg active:bg-red-600 hover:bg-red-600 transition-colors text-xs touch-manipulation"
                      title="Hủy đơn"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Complete Order Modal - Optimized for Mobile */}
      {showCompleteModal && orderToComplete && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-3 overflow-y-auto overflow-x-hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowCompleteModal(false);
              setOrderToComplete(null);
              setPaymentMethod('cash');
              setCustomAmountPaid('');
            }
          }}
        >
          <div className="bg-white rounded-lg max-w-sm w-full max-h-[90vh] flex flex-col my-auto shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between p-4 sm:p-5 pb-3 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900 truncate pr-2">Hoàn thành đơn hàng</h2>
              <button
                onClick={() => {
                  setShowCompleteModal(false);
                  setOrderToComplete(null);
                  setPaymentMethod('cash');
                  setCustomAmountPaid('');
                }}
                className="text-gray-500 hover:text-gray-700 text-2xl w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 active:bg-gray-200 touch-manipulation"
                aria-label="Đóng"
              >
                ×
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-5">
              {/* Order Info */}
              <div className="mb-4 p-3 bg-gradient-to-r from-blue-50 to-blue-100 rounded-xl border border-blue-200 overflow-hidden">
                <div className="text-xs sm:text-sm text-gray-600 mb-1 font-medium">Đơn hàng: #{orderToComplete.code}</div>
                <div className="text-xl sm:text-2xl font-bold text-blue-600 break-words">
                  {parseFloat(orderToComplete.final_amount ?? orderToComplete.total_amount ?? 0).toLocaleString('vi-VN')} đ
                </div>
                {orderToComplete.customer_name && (
                  <div className="text-xs text-gray-600 mt-2">
                    👤 {orderToComplete.customer_name}
                  </div>
                )}
              </div>

              {/* Payment Method */}
              <div className="mb-4">
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

              {/* Payment Amount */}
              <div className="mb-4">
                <label className="block text-sm sm:text-base font-semibold text-gray-700 mb-2.5">
                  Số tiền thanh toán
                </label>
                <MoneyInput
                  placeholder={Math.max((parseFloat(orderToComplete.final_amount ?? orderToComplete.total_amount ?? 0) || 0) - (parseFloat(orderToComplete.paid_amount) || 0), 0).toLocaleString('vi-VN')}
                  value={customAmountPaid}
                  onChange={setCustomAmountPaid}
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                <p className="text-xs text-gray-500 mt-1.5">Để trống = toàn bộ số tiền hoặc nhập 0 để ghi nợ</p>
              </div>

            </div>

            {/* Action Buttons */}
            <div className="flex flex-row gap-2.5 px-4 sm:px-5 pb-4 pt-2 border-t border-gray-200 flex-shrink-0">
              <button
                onClick={handleCompleteOrder}
                disabled={printing}
                className="flex-1 min-w-0 px-4 py-3.5 bg-gradient-to-r from-green-500 to-green-600 text-white rounded-xl active:from-green-600 active:to-green-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation font-semibold text-base shadow-lg"
              >
                {printing ? '⏳ Đang xử lý...' : '✓ Hoàn thành'}
              </button>
              <button
                onClick={() => {
                  setShowCompleteModal(false);
                  setOrderToComplete(null);
                  setPaymentMethod('cash');
                  setCustomAmountPaid('');
                }}
                className="flex-1 min-w-0 px-4 py-3 bg-gray-200 text-gray-800 rounded-xl active:bg-gray-300 transition-colors touch-manipulation text-base font-medium"
                disabled={printing}
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

export default PendingOrders;