import { useEffect, useState } from 'react';
import PageSkeleton from '../../components/PageSkeleton';
import { showToast } from '../../utils/toast';
import api from '../../utils/api';
import MoneyInput from '../../components/MoneyInput';
// Khóa localStorage RIÊNG cho trang này — không dùng chung getSavedFilters/
// saveFilters với Reports/Promotions/Timesheets. Trang này luôn ép về 1 cửa
// hàng cụ thể (bỏ "Tất cả cửa hàng"), nếu ghi vào key CHUNG thì chỉ cần ghé
// qua trang Sản phẩm là filter "Tất cả cửa hàng" admin đã chọn ở Báo cáo/
// Khuyến mãi/Chấm công bị âm thầm ép về 1 cửa hàng, không có cảnh báo gì.
const PRODUCTS_STORE_KEY = 'laundry66_products_store_id';
const getSavedProductsStoreId = () => {
  try {
    return localStorage.getItem(PRODUCTS_STORE_KEY) || '';
  } catch {
    return '';
  }
};
const saveProductsStoreId = (storeId) => {
  try {
    localStorage.setItem(PRODUCTS_STORE_KEY, storeId || '');
  } catch {
    // localStorage không khả dụng (chế độ ẩn danh...) — bỏ qua, không chặn tính năng
  }
};

function Products() {
  const [products, setProducts] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(getSavedProductsStoreId);
  const [loading, setLoading] = useState(true);

  // Default to first store when stores load (bỏ "tất cả cửa hàng")
  useEffect(() => {
    if (stores.length === 0) return;
    const currentValid = stores.some(s => String(s.id) === String(selectedStoreId));
    if (!currentValid || selectedStoreId === 'all') {
      setSelectedStoreId(String(stores[0].id));
    }
  }, [stores]);
  const [showModal, setShowModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  // commission_type: 'none' | 'percent' (% giá bán) | 'fixed' (đ cố định / đơn vị)
  // — mỗi sản phẩm chỉ một loại; backend cũng từ chối nếu gửi cả hai > 0
  const [formData, setFormData] = useState({
    name: '',
    unit: 'kg',
    price: '',
    commission_type: 'none',
    commission_percent: '',
    commission_amount: '',
    status: 'active',
    store_id: '',
  });

  useEffect(() => {
    loadStores();
    loadProducts();
  }, []);

  useEffect(() => {
    // Lọc theo cửa hàng — KHÔNG lọc bỏ sản phẩm 'inactive': làm vậy thì sau
    // khi ngưng bán, sản phẩm biến mất khỏi danh sách vĩnh viễn, không còn
    // cách nào mở lại modal Sửa để bật bán lại (cùng cách hiển thị với
    // Promotions.jsx: vẫn hiện, có nút Sửa/badge trạng thái).
    if (!selectedStoreId || selectedStoreId === 'all') return;
    setProducts(allProducts.filter(p => p.store_id === parseInt(selectedStoreId)));
  }, [selectedStoreId, allProducts]);

  // Save store filter whenever it changes — key riêng, xem comment ở khai báo PRODUCTS_STORE_KEY
  useEffect(() => {
    saveProductsStoreId(selectedStoreId);
  }, [selectedStoreId]);

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
      const response = await api.get('/products');
      const productsData = response.data.data || [];
      setAllProducts(productsData);
      // Apply current store filter (giữ cả sản phẩm inactive — xem comment ở effect phía trên)
      if (selectedStoreId && selectedStoreId !== 'all') {
        setProducts(productsData.filter(p => p.store_id === parseInt(selectedStoreId)));
      }
    } catch (error) {
      console.error('Error loading products:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      // Luôn gửi CẢ HAI field: loại không chọn gửi null để xoá giá trị cũ khi
      // admin đổi từ % sang tiền cố định (hoặc ngược lại / bỏ hoa hồng)
      const submitData = {
        name: formData.name,
        unit: formData.unit,
        price: formData.price,
        commission_percent: formData.commission_type === 'percent' && formData.commission_percent !== ''
          ? formData.commission_percent
          : null,
        commission_amount: formData.commission_type === 'fixed' && formData.commission_amount !== ''
          ? formData.commission_amount
          : null,
        status: formData.status,
      };
      
      if (editingProduct) {
        await api.patch(`/products/${editingProduct.id}`, submitData);
        showToast('Cập nhật sản phẩm thành công!');
      } else {
        submitData.store_id = formData.store_id;
        await api.post('/products', submitData);
      }
      setShowModal(false);
      setEditingProduct(null);
      resetForm();
      await loadProducts();
    } catch (error) {
      console.error('Error saving product:', error);
      showToast(error.response?.data?.error || 'Có lỗi xảy ra khi lưu sản phẩm');
    }
  };

  const handleEdit = (product) => {
    setEditingProduct(product);
    const amount = Number(product.commission_amount) || 0;
    const percent = Number(product.commission_percent) || 0;
    setFormData({
      name: product.name,
      unit: product.unit,
      price: product.price,
      commission_type: amount > 0 ? 'fixed' : (percent > 0 ? 'percent' : 'none'),
      commission_percent: percent > 0 ? String(percent) : '',
      // MoneyInput nhận chuỗi số nguyên (đ) — DB trả DECIMAL dạng "10000.00"
      commission_amount: amount > 0 ? String(Math.round(amount)) : '',
      status: product.status,
      store_id: product.store_id || '',
    });
    setShowModal(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('Bạn có chắc muốn ngừng kinh doanh sản phẩm này? Sản phẩm sẽ được ẩn khỏi danh sách chọn khi tạo đơn.')) return;
    try {
      const res = await api.delete(`/products/${id}`);
      const msg = res.data?.action === 'deactivated'
        ? 'Đã ẩn/ngừng kinh doanh sản phẩm.'
        : (res.data?.message || 'Đã xử lý xong.');
      showToast(msg);
      await loadProducts();
    } catch (error) {
      console.error('Error deleting product:', error);
      showToast(error.response?.data?.error || 'Có lỗi xảy ra khi xử lý sản phẩm');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      unit: 'kg',
      price: '',
      commission_type: 'none',
      commission_percent: '',
      commission_amount: '',
      status: 'active',
      store_id: selectedStoreId && selectedStoreId !== 'all' ? selectedStoreId : (stores[0]?.id ? String(stores[0].id) : ''),
    });
  };

  if (loading) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Sản phẩm</h1>
        </div>
        <div className="flex items-center gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Lọc theo cửa hàng</label>
            <select
              value={stores.length ? selectedStoreId : ''}
              onChange={(e) => setSelectedStoreId(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg text-base bg-white shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => {
              setEditingProduct(null);
              resetForm();
              setShowModal(true);
            }}
            className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-3 rounded-xl hover:from-blue-700 hover:to-blue-800 font-semibold shadow-lg hover:shadow-xl transition-all duration-300 transform hover:-translate-y-0.5"
          >
            + Thêm sản phẩm
          </button>
        </div>
      </div>

      {/* Products List */}
      {products.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <p className="text-gray-500 text-lg">
            {stores.length === 0 ? 'Chưa có cửa hàng nào' : `Chưa có sản phẩm nào cho cửa hàng "${stores.find(s => s.id === parseInt(selectedStoreId))?.name || ''}"`}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {products.map((product) => (
          <div key={product.id} className="bg-white rounded-lg shadow p-4">
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1">
                <h3 className="font-bold text-lg text-gray-800 mb-1">{product.name}</h3>
                {product.store_name && (
                  <p className="text-xs text-blue-600 font-medium mb-1">
                    {product.store_name}
                  </p>
                )}
                <div className="text-sm text-gray-600 space-y-1">
                  <p>
                    <span className="font-medium">Đơn vị:</span> {product.unit}
                  </p>
                  <p>
                    <span className="font-medium">Giá:</span>{' '}
                    {new Intl.NumberFormat('vi-VN').format(product.price)} đ
                  </p>
                  {(Number(product.commission_amount) > 0 || Number(product.commission_percent) > 0) && (
                    <p>
                      <span className="inline-block px-2 py-0.5 bg-amber-100 text-amber-800 border border-amber-300 rounded text-xs font-semibold">
                        🎁 Hoa hồng NV: {Number(product.commission_amount) > 0
                          ? `${new Intl.NumberFormat('vi-VN').format(Number(product.commission_amount))} đ/${product.unit}`
                          : `${Number(product.commission_percent)}%`}
                      </span>
                    </p>
                  )}
                </div>
              </div>
              <span
                className={`px-2 py-1 rounded-full text-xs font-medium ${
                  product.status === 'active'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                {product.status === 'active' ? 'Đang bán' : 'Ngưng bán'}
              </span>
            </div>
            <div className="flex gap-2 pt-3 border-t">
              <button
                onClick={() => handleEdit(product)}
                className="flex-1 text-blue-600 hover:text-blue-700 text-sm font-medium"
              >
                Sửa
              </button>
              <button
                onClick={() => handleDelete(product.id)}
                className="flex-1 text-red-600 hover:text-red-700 text-sm font-medium"
              >
                Xóa
              </button>
            </div>
          </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">
              {editingProduct ? 'Sửa sản phẩm' : 'Thêm sản phẩm'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cửa hàng *</label>
                <select
                  value={formData.store_id}
                  onChange={(e) => setFormData({ ...formData, store_id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  required
                  disabled={!!editingProduct}
                >
                  <option value="">-- Chọn cửa hàng --</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </select>
                {editingProduct && (
                  <p className="text-xs text-gray-500 mt-1">Không thể thay đổi cửa hàng sau khi tạo</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tên sản phẩm</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Đơn vị tính</label>
                <select
                  value={formData.unit}
                  onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="kg">kg</option>
                  <option value="cai">cái</option>
                  <option value="don">đơn</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Giá (đ)</label>
                <input
                  type="number"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  required
                />
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <label className="block text-sm font-semibold text-amber-900 mb-2">
                  🎁 Hoa hồng nhân viên
                </label>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {[
                    { value: 'none', label: 'Không có' },
                    { value: 'percent', label: 'Theo % giá bán' },
                    { value: 'fixed', label: 'Tiền cố định' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormData({ ...formData, commission_type: opt.value })}
                      className={`px-2 py-2 rounded-lg text-xs sm:text-sm font-medium border transition-colors ${
                        formData.commission_type === opt.value
                          ? 'bg-amber-600 text-white border-amber-600'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-amber-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {formData.commission_type === 'percent' && (
                  <>
                    <div className="relative">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        max="100"
                        step="any"
                        value={formData.commission_percent}
                        onChange={(e) => setFormData({ ...formData, commission_percent: e.target.value })}
                        className="w-full px-3 py-2 pr-10 border rounded-lg"
                        placeholder="VD: 5"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-semibold pointer-events-none">%</span>
                    </div>
                    <p className="text-xs text-amber-800 mt-1">
                      Nhân viên xử lý đơn được cộng = % × (giá × số lượng) của dòng hàng này, tính khi đơn hoàn thành.
                    </p>
                  </>
                )}
                {formData.commission_type === 'fixed' && (
                  <>
                    <div className="relative">
                      <MoneyInput
                        value={formData.commission_amount}
                        onChange={(v) => setFormData({ ...formData, commission_amount: v })}
                        className="w-full px-3 py-2 pr-16 border rounded-lg"
                        placeholder="VD: 10.000"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-semibold pointer-events-none">đ/{formData.unit}</span>
                    </div>
                    <p className="text-xs text-amber-800 mt-1">
                      Nhân viên xử lý đơn được cộng = số tiền này × số lượng ({formData.unit}) của dòng hàng, tính khi đơn hoàn thành.
                    </p>
                  </>
                )}
                {formData.commission_type === 'none' && (
                  <p className="text-xs text-amber-800">Sản phẩm này không tính hoa hồng cho nhân viên.</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Trạng thái</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="active">Đang bán</option>
                  <option value="inactive">Ngưng bán</option>
                </select>
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700"
                >
                  {editingProduct ? 'Cập nhật' : 'Tạo'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false);
                    setEditingProduct(null);
                    resetForm();
                  }}
                  className="flex-1 bg-gray-200 text-gray-800 py-2 rounded-lg hover:bg-gray-300"
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

export default Products;

