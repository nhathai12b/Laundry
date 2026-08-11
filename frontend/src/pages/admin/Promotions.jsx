import { useEffect, useState } from 'react';
import api from '../../utils/api';
import { isAdmin } from '../../utils/auth';
import { getSavedFilters, saveFilters } from '../../utils/filterStorage';

function Promotions() {
  const [promotions, setPromotions] = useState([]);
  const [allPromotions, setAllPromotions] = useState([]);
  const [stores, setStores] = useState([]);
  const savedFilters = getSavedFilters();
  const [selectedStoreId, setSelectedStoreId] = useState(savedFilters.selectedStoreId);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingPromotion, setEditingPromotion] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: 'bill_amount',
    min_bill_amount: '',
    discount_type: 'percentage',
    discount_value: '',
    max_discount_amount: '',
    start_date: '',
    end_date: '',
    status: 'active',
    store_id: '',
  });
  const [filterType, setFilterType] = useState('all');

  useEffect(() => {
    if (isAdmin()) {
      loadStores();
    }
    loadPromotions();
  }, []);

  useEffect(() => {
    loadPromotions();
  }, [filterType, selectedStoreId]);

  // Save store filter whenever it changes
  useEffect(() => {
    if (isAdmin()) {
      saveFilters(selectedStoreId, savedFilters.selectedMonth, savedFilters.selectedYear);
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

  const loadPromotions = async () => {
    try {
      setLoading(true);
      const params = {};
      if (filterType !== 'all') {
        params.type = filterType;
      }
      if (isAdmin() && selectedStoreId !== 'all') {
        params.store_id = selectedStoreId;
      }
      const response = await api.get('/promotions', { params });
      
      // Handle different response structures
      const promotionsData = response.data?.data ?? response.data ?? [];
      setPromotions(Array.isArray(promotionsData) ? promotionsData : []);
    } catch (error) {
      console.error('Error loading promotions:', error);
      const errorMessage = error.response?.data?.error 
        || error.message 
        || 'Không thể tải danh sách khuyến mãi';
      
      if (error.response?.status === 401) {
        alert('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        window.location.href = '/login';
      } else if (error.response?.status === 403) {
        alert('Bạn không có quyền truy cập tính năng này. Vui lòng đăng nhập bằng tài khoản admin.');
      } else if (error.response?.status === 500) {
        alert(`Lỗi máy chủ: ${errorMessage}\n\nVui lòng kiểm tra:\n- Kết nối cơ sở dữ liệu\n- Bảng promotions đã được tạo chưa`);
      } else {
        alert(`Không thể tải danh sách khuyến mãi: ${errorMessage}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name || !formData.start_date || !formData.end_date) {
      alert('Vui lòng điền đầy đủ thông tin bắt buộc');
      return;
    }

    if (!formData.min_bill_amount) {
      alert('Vui lòng nhập giá trị đơn hàng tối thiểu');
      return;
    }

    if (!formData.discount_value) {
      alert('Vui lòng nhập giá trị khuyến mãi');
      return;
    }

    if (new Date(formData.start_date) >= new Date(formData.end_date)) {
      alert('Ngày kết thúc phải sau ngày bắt đầu');
      return;
    }

    try {
      const submitData = {
        ...formData,
        type: 'bill_amount',
        min_bill_amount: parseFloat(formData.min_bill_amount),
        discount_value: parseFloat(formData.discount_value),
        max_discount_amount: formData.max_discount_amount ? parseFloat(formData.max_discount_amount) : null,
      };

      // Add store_id from form or fallback to selectedStoreId filter
      if (formData.store_id) {
        submitData.store_id = parseInt(formData.store_id);
      } else if (isAdmin() && selectedStoreId && selectedStoreId !== 'all') {
        submitData.store_id = parseInt(selectedStoreId);
      }

      // Debug log removed for security

      if (editingPromotion) {
        await api.patch(`/promotions/${editingPromotion.id}`, submitData);
        alert('Cập nhật khuyến mãi thành công!');
      } else {
        const response = await api.post('/promotions', submitData);
        // Debug log removed for security
        alert('Tạo khuyến mãi thành công!');
      }
      setShowModal(false);
      setEditingPromotion(null);
      resetForm();
      await loadPromotions();
    } catch (error) {
      console.error('Error saving promotion:', error);
      alert(error.response?.data?.error || 'Có lỗi xảy ra khi lưu khuyến mãi');
    }
  };

  const handleEdit = (promotion) => {
    setEditingPromotion(promotion);
    setFormData({
      name: promotion.name || '',
      description: promotion.description || '',
      type: 'bill_amount',
      min_bill_amount: promotion.min_bill_amount || '',
      discount_type: promotion.discount_type || 'percentage',
      discount_value: promotion.discount_value || '',
      max_discount_amount: promotion.max_discount_amount || '',
      start_date: promotion.start_date ? promotion.start_date.slice(0, 10) : '',
      end_date: promotion.end_date ? promotion.end_date.slice(0, 10) : '',
      status: promotion.status || 'active',
      store_id: promotion.store_id || '',
    });
    setShowModal(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('Bạn có chắc muốn ngừng áp dụng khuyến mãi này? Khuyến mãi sẽ được ẩn khỏi danh sách chọn khi tạo đơn.')) return;
    try {
      const res = await api.delete(`/promotions/${id}`);
      const msg = res.data?.action === 'deactivated'
        ? 'Đã ẩn/ngừng khuyến mãi.'
        : (res.data?.message || 'Đã xử lý xong.');
      alert(msg);
      loadPromotions();
    } catch (error) {
      alert(error.response?.data?.error || 'Xử lý thất bại');
    }
  };

  const handleToggleStatus = async (promotion) => {
    try {
      await api.patch(`/promotions/${promotion.id}`, {
        status: promotion.status === 'active' ? 'inactive' : 'active'
      });
      alert('Cập nhật trạng thái thành công!');
      loadPromotions();
    } catch (error) {
      alert(error.response?.data?.error || 'Cập nhật thất bại');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      type: 'bill_amount',
      min_bill_amount: '',
      discount_type: 'percentage',
      discount_value: '',
      max_discount_amount: '',
      start_date: '',
      end_date: '',
      status: 'active',
      store_id: selectedStoreId !== 'all' ? selectedStoreId : '',
    });
  };

  const formatDate = (dateString) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('vi-VN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const isActive = (promotion) => {
    if (promotion.status !== 'active') return false;
    const now = new Date();
    const start = new Date(promotion.start_date);
    const end = new Date(promotion.end_date);
    return now >= start && now <= end;
  };

  if (loading) {
    return <div className="text-center py-8">Đang tải...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Khuyến mãi</h1>
          <p className="text-gray-600">Quản lý chương trình khuyến mãi</p>
        </div>
        <div className="flex items-center gap-4">
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
          <button
            onClick={() => {
              setEditingPromotion(null);
              resetForm();
              setShowModal(true);
            }}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            + Thêm khuyến mãi
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex gap-2">
          <button
            onClick={() => setFilterType('all')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              filterType === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Tất cả
          </button>
          <button
            onClick={() => setFilterType('bill_amount')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              filterType === 'bill_amount'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Theo giá trị đơn hàng
          </button>
        </div>
      </div>

      {/* Promotions List */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Tên chương trình</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Loại</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Điều kiện</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Khuyến mãi</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Thời gian</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Trạng thái</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {promotions.length === 0 ? (
                <tr>
                  <td colSpan="7" className="px-4 py-8 text-center text-gray-500">
                    Chưa có khuyến mãi nào
                  </td>
                </tr>
              ) : (
                promotions.map((promotion) => (
                  <tr key={promotion.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900">{promotion.name}</div>
                      {promotion.description && (
                        <div className="text-xs text-gray-500 mt-1">{promotion.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      <span className={`px-2 py-1 rounded-full text-xs ${
                        promotion.type === 'order_count' 
                          ? 'bg-blue-100 text-blue-800' 
                          : 'bg-green-100 text-green-800'
                      }`}>
                        {promotion.type === 'order_count' ? 'Theo số lần' : 'Theo giá trị'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {promotion.type === 'order_count' ? (
                        <span>Từ {promotion.min_order_count} đơn</span>
                      ) : (
                        <span>Từ {new Intl.NumberFormat('vi-VN').format(promotion.min_bill_amount)} đ</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {promotion.discount_type === 'percentage' ? (
                        <span>{promotion.discount_value}%</span>
                      ) : (
                        <span>{new Intl.NumberFormat('vi-VN').format(promotion.discount_value)} đ</span>
                      )}
                      {promotion.max_discount_amount && (
                        <div className="text-xs text-gray-500">
                          Tối đa: {new Intl.NumberFormat('vi-VN').format(promotion.max_discount_amount)} đ
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      <div>{formatDate(promotion.start_date)}</div>
                      <div className="text-xs text-gray-500">đến</div>
                      <div>{formatDate(promotion.end_date)}</div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex flex-col gap-1">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          isActive(promotion)
                            ? 'bg-green-100 text-green-800'
                            : promotion.status === 'active'
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {isActive(promotion) ? 'Đang áp dụng' : promotion.status === 'active' ? 'Chưa bắt đầu' : 'Ngừng'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => handleEdit(promotion)}
                          className="text-blue-600 hover:text-blue-700 text-xs"
                        >
                          Sửa
                        </button>
                        <button
                          onClick={() => handleToggleStatus(promotion)}
                          className={`text-xs ${
                            promotion.status === 'active'
                              ? 'text-orange-600 hover:text-orange-700'
                              : 'text-green-600 hover:text-green-700'
                          }`}
                        >
                          {promotion.status === 'active' ? 'Tắt' : 'Bật'}
                        </button>
                        <button
                          onClick={() => handleDelete(promotion.id)}
                          className="text-red-600 hover:text-red-700 text-xs"
                        >
                          Xóa
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">
              {editingPromotion ? 'Sửa khuyến mãi' : 'Thêm khuyến mãi'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tên chương trình *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Mô tả
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  rows="2"
                />
              </div>
              {isAdmin() && stores.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cửa hàng <span className="text-gray-500 text-xs">(tùy chọn)</span>
                  </label>
                  <select
                    value={formData.store_id}
                    onChange={(e) => setFormData({ ...formData, store_id: e.target.value })}
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                  >
                    <option value="">Tất cả cửa hàng</option>
                    {stores.map((store) => (
                      <option key={store.id} value={store.id}>
                        {store.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Giá trị đơn hàng tối thiểu (đ) *
                </label>
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={formData.min_bill_amount}
                  onChange={(e) => setFormData({ ...formData, min_bill_amount: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Loại giảm giá *
                </label>
                <select
                  value={formData.discount_type}
                  onChange={(e) => setFormData({ ...formData, discount_type: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                >
                  <option value="percentage">Phần trăm (%)</option>
                  <option value="fixed">Số tiền cố định (đ)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Giá trị khuyến mãi *
                  {formData.discount_type === 'percentage' && ' (%)'}
                  {formData.discount_type === 'fixed' && ' (đ)'}
                </label>
                <input
                  type="number"
                  min="0"
                  step={formData.discount_type === 'percentage' ? '1' : '1000'}
                  max={formData.discount_type === 'percentage' ? '100' : undefined}
                  value={formData.discount_value}
                  onChange={(e) => setFormData({ ...formData, discount_value: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                />
              </div>
              {formData.discount_type === 'percentage' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Giảm tối đa (đ) (tùy chọn)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1000"
                    value={formData.max_discount_amount}
                    onChange={(e) => setFormData({ ...formData, max_discount_amount: e.target.value })}
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                    placeholder="Không giới hạn nếu để trống"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Ngày bắt đầu *
                  </label>
                  <input
                    type="date"
                    value={formData.start_date}
                    onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Ngày kết thúc *
                  </label>
                  <input
                    type="date"
                    value={formData.end_date}
                    onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Trạng thái
                </label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                >
                  <option value="active">Hoạt động</option>
                  <option value="inactive">Ngừng hoạt động</option>
                </select>
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 font-medium"
                >
                  {editingPromotion ? 'Cập nhật' : 'Tạo'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false);
                    setEditingPromotion(null);
                    resetForm();
                  }}
                  className="flex-1 bg-gray-200 text-gray-800 py-2.5 rounded-lg hover:bg-gray-300 font-medium"
                >
                  Hủy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default Promotions;
