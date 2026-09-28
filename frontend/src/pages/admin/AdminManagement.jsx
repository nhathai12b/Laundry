import { useEffect, useState } from 'react';
import { showToast } from '../../utils/toast';
import api from '../../utils/api';
import { isRoot, getAuth } from '../../utils/auth';
import PasswordRequirements from '../../components/PasswordRequirements';
import ChangePasswordModal from '../../components/ChangePasswordModal';

function AdminManagement() {
  const [pendingAdmins, setPendingAdmins] = useState([]);
  const [allAdmins, setAllAdmins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('pending'); // 'pending' or 'all'
  const [showModal, setShowModal] = useState(false);
  const [showPackageModal, setShowPackageModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showExtendModal, setShowExtendModal] = useState(false);
  const [extendAdmin, setExtendAdmin] = useState(null);
  const [extendPackage, setExtendPackage] = useState('1month');
  const [selectedAdminId, setSelectedAdminId] = useState(null);
  const [selectedAdmin, setSelectedAdmin] = useState(null);
  const [selectedPackage, setSelectedPackage] = useState('3months');
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    password: '',
    trial_7days: false,
  });
  const [editFormData, setEditFormData] = useState({
    name: '',
    phone: '',
    password: '',
    subscription_package: '',
    subscription_expires_at: '',
  });
  const [stores, setStores] = useState([]);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [creatingAdmin, setCreatingAdmin] = useState(false);

  useEffect(() => {
    // Trang chỉ dành cho root — route đã chặn ở App.jsx, nhưng vẫn tự vệ ở
    // đây (cùng pattern với Reports.jsx) để không bắn GET /users, /stores khi
    // component vì lý do gì đó vẫn mount cho admin thường.
    if (!isRoot()) return;
    if (activeTab === 'pending') {
      loadPendingAdmins();
    } else {
      loadAllAdmins();
    }
    loadStores();
  }, [activeTab]);

  const loadStores = async () => {
    try {
      const response = await api.get('/stores');
      setStores(response.data.data || []);
    } catch (error) {
      console.error('Error loading stores:', error);
    }
  };

  const loadPendingAdmins = async () => {
    try {
      setLoading(true);
      const response = await api.get('/users');
      const allUsers = response.data.data || [];
      const pending = allUsers.filter(u => u.role === 'admin' && u.status === 'pending');
      setPendingAdmins(pending);
    } catch (error) {
      console.error('Error loading pending admins:', error);
      showToast('Không thể tải danh sách admin chờ phê duyệt');
    } finally {
      setLoading(false);
    }
  };

  const loadAllAdmins = async () => {
    try {
      setLoading(true);
      const response = await api.get('/users');
      const allUsers = response.data.data || [];
      const admins = allUsers.filter(u => u.role === 'admin');
      setAllAdmins(admins);
    } catch (error) {
      console.error('Error loading admins:', error);
      showToast('Không thể tải danh sách admin');
    } finally {
      setLoading(false);
    }
  };

  const handleApproveAdmin = (id) => {
    setSelectedAdminId(id);
    setSelectedPackage('3months');
    setShowPackageModal(true);
  };

  const confirmApproveAdmin = async () => {
    if (!selectedAdminId) return;
    
    try {
      const response = await api.post(`/users/${selectedAdminId}/approve`, {
        package: selectedPackage
      });
      
      // Show detailed success message
      const message = response.data.message || 'Phê duyệt admin thành công!';
      showToast(message);
      
      setShowPackageModal(false);
      setSelectedAdminId(null);
      loadPendingAdmins();
      loadAllAdmins();
    } catch (error) {
      showToast(error.response?.data?.error || 'Phê duyệt thất bại');
    }
  };

  const handleRejectAdmin = async (id) => {
    if (!confirm('Bạn có chắc muốn từ chối admin này?')) return;
    try {
      await api.post(`/users/${id}/reject`);
      showToast('Đã từ chối admin');
      loadPendingAdmins();
      loadAllAdmins();
    } catch (error) {
      showToast(error.response?.data?.error || 'Từ chối thất bại');
    }
  };

  const handleRevertToPending = async (id, name) => {
    if (!confirm(`Chuyển admin "${name}" về trạng thái chờ phê duyệt? Tài khoản sẽ không đăng nhập được cho đến khi được phê duyệt lại.`)) return;
    try {
      await api.post(`/users/${id}/revert-to-pending`);
      showToast('Đã chuyển admin về chờ phê duyệt');
      loadPendingAdmins();
      loadAllAdmins();
    } catch (error) {
      showToast(error.response?.data?.error || 'Chuyển trạng thái thất bại');
    }
  };

  const handleCreateAdmin = async (e) => {
    e.preventDefault();
    if (creatingAdmin) return;
    if (!formData.name || !formData.password) {
      showToast('Vui lòng điền đầy đủ thông tin bắt buộc (Tên, Mật khẩu)');
      return;
    }

    // Phone không bắt buộc cho admin, chỉ trim nếu có
    const phone = formData.phone ? formData.phone.trim() : '';

    setCreatingAdmin(true);
    try {
      const submitData = {
        name: formData.name.trim(),
        phone: phone || null, // Cho phép null nếu không có phone
        password: formData.password,
        role: 'admin',
        trial_7days: !!formData.trial_7days,
      };
      
      await api.post('/users', submitData);
      showToast(formData.trial_7days
        ? 'Tạo admin thành công! Admin được kích hoạt dùng thử 7 ngày.'
        : 'Tạo admin thành công! Admin sẽ ở trạng thái chờ phê duyệt.');
      setShowModal(false);
      resetForm();
      loadPendingAdmins();
      loadAllAdmins();
    } catch (error) {
      const errorMessage = error.response?.data?.error || error.message || 'Tạo admin thất bại';
      showToast(errorMessage);
      console.error('Create admin error:', error);
    } finally {
      setCreatingAdmin(false);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      phone: '',
      password: '',
      trial_7days: false,
    });
  };

  // datetime-local cần giờ ĐỊA PHƯƠNG — đổ thẳng chuỗi UTC (toISOString) vào
  // input rồi lưu lại sẽ dịch hạn dùng sớm 7 tiếng MỖI LẦN mở-lưu (VN = UTC+7)
  const toLocalDatetimeInput = (value) => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const handleEditAdmin = (admin) => {
    setSelectedAdmin(admin);
    setEditFormData({
      name: admin.name || '',
      phone: admin.phone || '',
      password: '',
      subscription_package: admin.subscription_package || '',
      subscription_expires_at: admin.subscription_expires_at
        ? toLocalDatetimeInput(admin.subscription_expires_at)
        : '',
    });
    setShowEditModal(true);
  };

  const handleExtendClick = (admin) => {
    setExtendAdmin(admin);
    setExtendPackage('1month');
    setShowExtendModal(true);
  };

  const confirmExtendSubscription = async () => {
    if (!extendAdmin) return;
    try {
      const response = await api.post(`/users/${extendAdmin.id}/extend-subscription`, {
        package: extendPackage,
      });
      showToast(response.data.message || 'Đã gia hạn thành công!');
      setShowExtendModal(false);
      setExtendAdmin(null);
      loadAllAdmins();
    } catch (error) {
      const msg = error.response?.data?.error || error.message || 'Gia hạn thất bại';
      showToast(msg);
    }
  };

  const handleUpdateAdmin = async (e) => {
    e.preventDefault();
    if (!selectedAdmin) return;

    // Phone không bắt buộc cho admin

    try {
      const updateData = {
        name: editFormData.name,
        phone: editFormData.phone ? editFormData.phone.trim() : null, // Cho phép null nếu không có phone
      };

      // Only include password if provided
      if (editFormData.password) {
        updateData.password = editFormData.password;
      }

      // Handle subscription
      if (editFormData.subscription_package) {
        updateData.subscription_package = editFormData.subscription_package;
        if (editFormData.subscription_expires_at) {
          // Convert to MySQL datetime format
          const date = new Date(editFormData.subscription_expires_at);
          updateData.subscription_expires_at = date.toISOString().slice(0, 19).replace('T', ' ');
        }
      } else {
        updateData.subscription_package = null;
        updateData.subscription_expires_at = null;
      }

      await api.patch(`/users/${selectedAdmin.id}`, updateData);
      showToast('Cập nhật admin thành công!');
      setShowEditModal(false);
      setSelectedAdmin(null);
      loadAllAdmins();
      loadPendingAdmins();
    } catch (error) {
      const errorMessage = error.response?.data?.error || error.message || 'Cập nhật thất bại';
      showToast(errorMessage);
      console.error('Update admin error:', error);
    }
  };

  const handleDeleteAdmin = async (id, name) => {
    // Check if trying to delete yourself
    const { user: currentUser } = getAuth();
    if (currentUser && currentUser.id === id) {
      showToast('Bạn không thể xóa chính mình!');
      return;
    }
    
    if (!confirm(`Bạn có chắc muốn xóa admin "${name}"? Hành động này không thể hoàn tác.`)) return;
    
    try {
      await api.delete(`/users/${id}`);
      showToast('Xóa admin thành công!');
      loadAllAdmins();
      loadPendingAdmins();
    } catch (error) {
      showToast(error.response?.data?.error || 'Xóa thất bại');
    }
  };

  if (!isRoot()) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-600">Bạn không có quyền truy cập trang này.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Quản lý Admin</h1>
          <p className="text-gray-600">Tạo và phê duyệt admin cho chuỗi cửa hàng</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowChangePasswordModal(true)}
            className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-200 font-medium text-sm"
          >
            Đổi mật khẩu
          </button>
          <button
            onClick={() => {
              resetForm();
              setShowModal(true);
            }}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            + Tạo Admin mới
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg shadow p-1">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('pending')}
            className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors relative ${
              activeTab === 'pending'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Admin chờ phê duyệt
            {pendingAdmins.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                {pendingAdmins.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('all')}
            className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'all'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Tất cả Admin
          </button>
        </div>
      </div>

      {/* Pending Admins Tab */}
      {activeTab === 'pending' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {loading ? (
            <div className="text-center py-8">Đang tải...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Tên</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">SĐT</th>
                    <th className="px-4 py-3 text-center text-sm font-medium text-gray-700">Số cửa hàng</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Ngày tạo</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pendingAdmins.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="px-4 py-8 text-center text-gray-500">
                        Không có admin nào chờ phê duyệt
                      </td>
                    </tr>
                  ) : (
                    pendingAdmins.map((admin) => (
                      <tr key={admin.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-800">{admin.name}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{admin.phone}</td>
                        <td className="px-4 py-3 text-sm text-center text-gray-600">
                          {admin.role === 'root' ? '-' : (admin.store_count ?? 0)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {new Date(admin.created_at).toLocaleDateString('vi-VN')}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleApproveAdmin(admin.id)}
                              className="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700"
                            >
                              Phê duyệt
                            </button>
                            <button
                              onClick={() => handleRejectAdmin(admin.id)}
                              className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700"
                            >
                              Từ chối
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* All Admins Tab */}
      {activeTab === 'all' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {loading ? (
            <div className="text-center py-8">Đang tải...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Tên</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">SĐT</th>
                    <th className="px-4 py-3 text-center text-sm font-medium text-gray-700">Số cửa hàng</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Trạng thái</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Gói đăng ký</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Ngày hết hạn</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Ngày tạo</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {allAdmins.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="px-4 py-8 text-center text-gray-500">
                        Chưa có admin nào
                      </td>
                    </tr>
                  ) : (
                    allAdmins.map((admin) => {
                      const packageNames = {
                        '1month': '1 tháng',
                        '3months': '3 tháng',
                        '6months': '6 tháng',
                        '1year': '1 năm',
                        '7days': 'Dùng thử 7 ngày'
                      };
                      const isExpired = admin.subscription_expires_at && new Date(admin.subscription_expires_at) < new Date();
                      const expiresAt = admin.subscription_expires_at 
                        ? new Date(admin.subscription_expires_at)
                        : null;
                      
                      return (
                        <tr key={admin.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-800">{admin.name}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{admin.phone}</td>
                          <td className="px-4 py-3 text-sm text-center text-gray-600">
                            {admin.role === 'root' ? '-' : (admin.store_count ?? 0)}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium ${
                                admin.status === 'active'
                                  ? 'bg-green-100 text-green-800'
                                  : admin.status === 'pending'
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {admin.status === 'active' ? 'Hoạt động' : admin.status === 'pending' ? 'Chờ phê duyệt' : 'Ngừng hoạt động'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {admin.subscription_package ? (
                              <span className="text-gray-800 font-medium">
                                {packageNames[admin.subscription_package] || admin.subscription_package}
                              </span>
                            ) : (
                              <span className="text-gray-400">Chưa kích hoạt</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {expiresAt ? (
                              <div>
                                <div className={`font-medium ${
                                  isExpired ? 'text-red-600' : 'text-gray-800'
                                }`}>
                                  {expiresAt.toLocaleDateString('vi-VN')}
                                </div>
                                <div className={`text-xs mt-1 ${
                                  isExpired ? 'text-red-600 font-semibold' : 'text-gray-500'
                                }`}>
                                  {isExpired ? 'Đã hết hạn' : expiresAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              </div>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {new Date(admin.created_at).toLocaleDateString('vi-VN')}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              <button
                                onClick={() => handleEditAdmin(admin)}
                                className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700"
                              >
                                Sửa
                              </button>
                              {admin.role !== 'root' && admin.status !== 'pending' && (
                                <button
                                  onClick={() => handleExtendClick(admin)}
                                  className="bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700"
                                >
                                  Gia hạn
                                </button>
                              )}
                              {admin.status === 'active' && (() => {
                                const { user: currentUser } = getAuth();
                                if (currentUser && currentUser.id === admin.id) return null;
                                return (
                                  <button
                                    onClick={() => handleRevertToPending(admin.id, admin.name)}
                                    className="bg-amber-600 text-white px-3 py-1 rounded text-sm hover:bg-amber-700"
                                  >
                                    Chờ phê duyệt
                                  </button>
                                );
                              })()}
                              {(() => {
                                const { user: currentUser } = getAuth();
                                if (currentUser && currentUser.id === admin.id) return null;
                                return (
                                  <button
                                    onClick={() => handleDeleteAdmin(admin.id, admin.name)}
                                    className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700"
                                  >
                                    Xóa
                                  </button>
                                );
                              })()}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Package Selection Modal */}
      {showPackageModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">Chọn gói đăng ký</h2>
            <p className="text-gray-600 mb-4">Vui lòng chọn gói đăng ký cho admin này:</p>
            
            <div className="space-y-3 mb-6">
              <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                selectedPackage === '7days' ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
              }`}>
                <input
                  type="radio"
                  name="package"
                  value="7days"
                  checked={selectedPackage === '7days'}
                  onChange={(e) => setSelectedPackage(e.target.value)}
                  className="mr-3"
                />
                <div className="flex-1">
                  <div className="font-semibold text-gray-800">Dùng thử 7 ngày</div>
                  <div className="text-sm text-gray-600">Hết hạn sau 7 ngày kể từ ngày kích hoạt</div>
                </div>
              </label>

              <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                selectedPackage === '1month' ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
              }`}>
                <input
                  type="radio"
                  name="package"
                  value="1month"
                  checked={selectedPackage === '1month'}
                  onChange={(e) => setSelectedPackage(e.target.value)}
                  className="mr-3"
                />
                <div className="flex-1">
                  <div className="font-semibold text-gray-800">Gói 1 tháng</div>
                  <div className="text-sm text-gray-600">Hết hạn sau 1 tháng kể từ ngày kích hoạt</div>
                </div>
              </label>

              <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                selectedPackage === '3months' ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
              }`}>
                <input
                  type="radio"
                  name="package"
                  value="3months"
                  checked={selectedPackage === '3months'}
                  onChange={(e) => setSelectedPackage(e.target.value)}
                  className="mr-3"
                />
                <div className="flex-1">
                  <div className="font-semibold text-gray-800">Gói 3 tháng</div>
                  <div className="text-sm text-gray-600">Hết hạn sau 3 tháng kể từ ngày kích hoạt</div>
                </div>
              </label>

              <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                selectedPackage === '6months' ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
              }`}>
                <input
                  type="radio"
                  name="package"
                  value="6months"
                  checked={selectedPackage === '6months'}
                  onChange={(e) => setSelectedPackage(e.target.value)}
                  className="mr-3"
                />
                <div className="flex-1">
                  <div className="font-semibold text-gray-800">Gói 6 tháng</div>
                  <div className="text-sm text-gray-600">Hết hạn sau 6 tháng kể từ ngày kích hoạt</div>
                </div>
              </label>

              <label className={`flex items-center p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                selectedPackage === '1year' ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
              }`}>
                <input
                  type="radio"
                  name="package"
                  value="1year"
                  checked={selectedPackage === '1year'}
                  onChange={(e) => setSelectedPackage(e.target.value)}
                  className="mr-3"
                />
                <div className="flex-1">
                  <div className="font-semibold text-gray-800">Gói 1 năm</div>
                  <div className="text-sm text-gray-600">Hết hạn sau 1 năm kể từ ngày kích hoạt</div>
                </div>
              </label>
            </div>

            <div className="flex gap-3 pt-4">
              <button
                onClick={confirmApproveAdmin}
                className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 font-medium"
              >
                Xác nhận phê duyệt
              </button>
              <button
                onClick={() => {
                  setShowPackageModal(false);
                  setSelectedAdminId(null);
                }}
                className="flex-1 bg-gray-200 text-gray-800 py-2.5 rounded-lg hover:bg-gray-300 font-medium"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Admin Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">Tạo Admin mới</h2>
            <form onSubmit={handleCreateAdmin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tên admin *
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
                  SĐT *
                </label>
                <input
                  type="text"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Mật khẩu *
                </label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                />
                <PasswordRequirements password={formData.password} />
              </div>
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.trial_7days}
                    onChange={(e) => setFormData({ ...formData, trial_7days: e.target.checked })}
                    className="rounded border-gray-300"
                  />
                  <span className="text-sm font-medium text-gray-700">Dùng thử 7 ngày</span>
                </label>
                <p className="text-xs text-gray-500 mt-1 ml-6">Nếu chọn, admin được kích hoạt ngay với gói 7 ngày (không cần phê duyệt).</p>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                <p className="font-medium">ℹ️ Thông tin:</p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  <li>Nếu không chọn dùng thử: admin ở trạng thái "Chờ phê duyệt" và cần root phê duyệt.</li>
                  <li>Khi phê duyệt, chọn gói đăng ký (3 tháng, 6 tháng, 1 năm hoặc dùng thử 7 ngày).</li>
                </ul>
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  disabled={creatingAdmin}
                  className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {creatingAdmin ? 'Đang tạo...' : 'Tạo Admin'}
                </button>
                <button
                  type="button"
                  disabled={creatingAdmin}
                  onClick={() => {
                    setShowModal(false);
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

      {/* Edit Admin Modal */}
      {showEditModal && selectedAdmin && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">Chỉnh sửa Admin</h2>
            <form onSubmit={handleUpdateAdmin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tên admin *
                </label>
                <input
                  type="text"
                  value={editFormData.name}
                  onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  SĐT *
                </label>
                <input
                  type="text"
                  value={editFormData.phone}
                  onChange={(e) => setEditFormData({ ...editFormData, phone: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Mật khẩu mới (để trống nếu không đổi)
                </label>
                <input
                  type="password"
                  value={editFormData.password}
                  onChange={(e) => setEditFormData({ ...editFormData, password: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  placeholder="Nhập mật khẩu mới..."
                />
                {editFormData.password && (
                  <PasswordRequirements password={editFormData.password} />
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Gói đăng ký
                </label>
                <select
                  value={editFormData.subscription_package}
                  onChange={(e) => {
                    const packageType = e.target.value;
                    setEditFormData({ ...editFormData, subscription_package: packageType });
                    // Auto-calculate expiration date if package is selected
                    if (packageType) {
                      const now = new Date();
                      let expirationDate = new Date();
                      switch (packageType) {
                        case '1month':
                          expirationDate.setMonth(now.getMonth() + 1);
                          break;
                        case '3months':
                          expirationDate.setMonth(now.getMonth() + 3);
                          break;
                        case '6months':
                          expirationDate.setMonth(now.getMonth() + 6);
                          break;
                        case '1year':
                          expirationDate.setFullYear(now.getFullYear() + 1);
                          break;
                        case '7days':
                          expirationDate.setDate(now.getDate() + 7);
                          break;
                      }
                      setEditFormData(prev => ({
                        ...prev,
                        subscription_package: packageType,
                        subscription_expires_at: toLocalDatetimeInput(expirationDate)
                      }));
                    }
                  }}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                >
                  <option value="">-- Không có gói --</option>
                  <option value="7days">Dùng thử 7 ngày</option>
                  <option value="1month">1 tháng</option>
                  <option value="3months">3 tháng</option>
                  <option value="6months">6 tháng</option>
                  <option value="1year">1 năm</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Ngày hết hạn
                </label>
                <input
                  type="datetime-local"
                  value={editFormData.subscription_expires_at}
                  onChange={(e) => setEditFormData({ ...editFormData, subscription_expires_at: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  disabled={!editFormData.subscription_package}
                />
                {!editFormData.subscription_package && (
                  <p className="text-xs text-gray-500 mt-1">Vui lòng chọn gói đăng ký trước</p>
                )}
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 font-medium"
                >
                  Cập nhật
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowEditModal(false);
                    setSelectedAdmin(null);
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

      {/* Gia hạn subscription Modal */}
      {showExtendModal && extendAdmin && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-2">Gia hạn gói đăng ký</h2>
            <p className="text-gray-600 mb-4">
              Admin: <strong>{extendAdmin.name}</strong> ({extendAdmin.phone})
            </p>
            <p className="text-sm text-gray-600 mb-3">Chọn gói gia hạn (cộng thêm từ ngày hết hạn hiện tại hoặc từ hôm nay nếu đã hết hạn):</p>
            <div className="space-y-2 mb-6">
              {[
                { value: '1month', label: '1 tháng' },
                { value: '3months', label: '3 tháng' },
                { value: '6months', label: '6 tháng' },
                { value: '1year', label: '1 năm' },
              ].map((pkg) => (
                <label key={pkg.value} className="flex items-center p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
                  <input
                    type="radio"
                    name="extendPackage"
                    value={pkg.value}
                    checked={extendPackage === pkg.value}
                    onChange={() => setExtendPackage(pkg.value)}
                    className="mr-3"
                  />
                  <span className="font-medium">{pkg.label}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={confirmExtendSubscription}
                className="flex-1 bg-green-600 text-white py-2.5 rounded-lg hover:bg-green-700 font-medium"
              >
                Xác nhận gia hạn
              </button>
              <button
                type="button"
                onClick={() => { setShowExtendModal(false); setExtendAdmin(null); }}
                className="flex-1 bg-gray-200 text-gray-800 py-2.5 rounded-lg hover:bg-gray-300 font-medium"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}

      <ChangePasswordModal isOpen={showChangePasswordModal} onClose={() => setShowChangePasswordModal(false)} />
    </div>
  );
}

export default AdminManagement;
