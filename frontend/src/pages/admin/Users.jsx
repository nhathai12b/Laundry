import { useEffect, useState } from 'react';
import api from '../../utils/api';
import { isAdmin, isRoot } from '../../utils/auth';
import PasswordRequirements from '../../components/PasswordRequirements';

function Users() {
  const [activeTab, setActiveTab] = useState('users'); // 'users', 'employees', or 'pending'
  
  // Users state
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userFormData, setUserFormData] = useState({
    name: '',
    phone: '',
    password: '',
    role: 'employer',
    started_at: '',
    status: 'active',
    hourly_rate: '',
    shift_rate: '',
    store_id: '',
  });
  const [stores, setStores] = useState([]);

  // Employees state
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [employeeFormData, setEmployeeFormData] = useState({
    name: '',
    phone: '',
    user_id: '',
  });
  const [employerUsers, setEmployerUsers] = useState([]);

  // Pending admins state (for root only)
  const [pendingAdmins, setPendingAdmins] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(false);

  useEffect(() => {
    if (activeTab === 'users') {
      loadUsers();
      loadStoresForUsers();
    } else if (activeTab === 'employees') {
      loadEmployees();
      loadStores();
    } else if (activeTab === 'pending') {
      loadPendingAdmins();
    }
  }, [activeTab]);

  const loadStoresForUsers = async () => {
    try {
      const response = await api.get('/stores');
      setStores(response.data.data || []);
    } catch (error) {
      console.error('Error loading stores:', error);
    }
  };

  // Users functions
  const loadUsers = async () => {
    try {
      setUsersLoading(true);
      const response = await api.get('/users');
      setUsers(response.data.data || []);
    } catch (error) {
      console.error('Error loading users:', error);
      alert('Không thể tải danh sách tài khoản');
    } finally {
      setUsersLoading(false);
    }
  };

  const handleUserSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingUser) {
        await api.patch(`/users/${editingUser.id}`, userFormData);
        alert('Cập nhật tài khoản thành công!');
      } else {
        await api.post('/users', userFormData);
        alert('Tạo tài khoản thành công!');
      }
      setShowUserModal(false);
      setEditingUser(null);
      resetUserForm();
      loadUsers();
    } catch (error) {
      alert(error.response?.data?.error || 'Có lỗi xảy ra');
    }
  };

  const handleUserEdit = (user) => {
    setEditingUser(user);
    setUserFormData({
      name: user.name,
      phone: user.phone,
      password: '',
      role: user.role,
      started_at: user.started_at || '',
      status: user.status,
      hourly_rate: user.hourly_rate || '',
      shift_rate: user.shift_rate || '',
      store_id: user.store_id || '',
    });
    setShowUserModal(true);
  };

  const handleUserDelete = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa tài khoản này?')) return;
    try {
      await api.delete(`/users/${id}`);
      alert('Xóa tài khoản thành công!');
      loadUsers();
    } catch (error) {
      alert(error.response?.data?.error || 'Xóa thất bại');
    }
  };

  const resetUserForm = () => {
    setUserFormData({
      name: '',
      phone: '',
      password: '',
      role: 'employer',
      started_at: '',
      status: 'active',
      hourly_rate: '',
      shift_rate: '',
      store_id: '',
    });
  };

  // Employees functions
  const loadEmployees = async () => {
    try {
      setEmployeesLoading(true);
      const response = await api.get('/employees');
      setEmployees(response.data.data || []);
    } catch (error) {
      console.error('Error loading employees:', error);
      alert('Không thể tải danh sách nhân viên');
    } finally {
      setEmployeesLoading(false);
    }
  };

  const loadStores = async () => {
    try {
      // Load employer users for employee assignment
      const response = await api.get('/users');
      const employerList = (response.data.data || []).filter(u => u.role === 'employer' && u.status === 'active');
      setEmployerUsers(employerList);
      
      // Auto-set user_id for employer (non-admin)
      if (!isAdmin() && employerList.length > 0) {
        const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
        if (currentUser.id) {
          setEmployeeFormData(prev => ({ ...prev, user_id: currentUser.id }));
        }
      }
    } catch (error) {
      console.error('Error loading employer users:', error);
    }
  };

  const handleEmployeeSubmit = async (e) => {
    e.preventDefault();
    try {
      if (!employeeFormData.name || employeeFormData.name.trim() === '') {
        alert('Vui lòng nhập tên nhân viên');
        return;
      }
      
      if (isAdmin() && !editingEmployee && !employeeFormData.user_id) {
        alert('Vui lòng chọn account cho nhân viên');
        return;
      }
      
      const submitData = { 
        name: employeeFormData.name.trim(), 
        phone: employeeFormData.phone?.trim() || '',
        user_id: isAdmin() ? employeeFormData.user_id : undefined // Only send if admin
      };
      
      if (editingEmployee) {
        await api.patch(`/employees/${editingEmployee.id}`, submitData);
        alert('Cập nhật nhân viên thành công!');
      } else {
        await api.post('/employees', submitData);
        alert('Thêm nhân viên thành công!');
      }
      setShowEmployeeModal(false);
      setEditingEmployee(null);
      setEmployeeFormData({ name: '', phone: '', user_id: '' });
      loadEmployees();
    } catch (error) {
      console.error('Submit error:', error);
      alert(error.response?.data?.error || error.message || 'Lưu thất bại');
    }
  };

  const handleEmployeeEdit = (employee) => {
    setEditingEmployee(employee);
    setEmployeeFormData({
      name: employee.name,
      phone: employee.phone || '',
      user_id: employee.store_id, // store_id in employees table is actually user_id
    });
    setShowEmployeeModal(true);
  };

  const handleEmployeeDelete = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa nhân viên này?')) return;
    try {
      await api.delete(`/employees/${id}`);
      alert('Xóa nhân viên thành công!');
      loadEmployees();
    } catch (error) {
      alert(error.response?.data?.error || 'Xóa thất bại');
    }
  };

  // Pending admins functions (for root only)
  const loadPendingAdmins = async () => {
    try {
      setPendingLoading(true);
      const response = await api.get('/users');
      const allUsers = response.data.data || [];
      const pending = allUsers.filter(u => u.role === 'admin' && u.status === 'pending');
      setPendingAdmins(pending);
    } catch (error) {
      console.error('Error loading pending admins:', error);
      alert('Không thể tải danh sách admin chờ phê duyệt');
    } finally {
      setPendingLoading(false);
    }
  };

  const handleApproveAdmin = async (id) => {
    if (!confirm('Bạn có chắc muốn phê duyệt admin này?')) return;
    try {
      await api.post(`/users/${id}/approve`);
      alert('Phê duyệt admin thành công!');
      loadPendingAdmins();
      loadUsers();
    } catch (error) {
      alert(error.response?.data?.error || 'Phê duyệt thất bại');
    }
  };

  const handleRejectAdmin = async (id) => {
    if (!confirm('Bạn có chắc muốn từ chối admin này?')) return;
    try {
      await api.post(`/users/${id}/reject`);
      alert('Đã từ chối admin');
      loadPendingAdmins();
      loadUsers();
    } catch (error) {
      alert(error.response?.data?.error || 'Từ chối thất bại');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Tài khoản & Nhân viên</h1>
          <p className="text-gray-600">Quản lý tài khoản và nhân viên</p>
        </div>
        <button
          onClick={() => {
            if (activeTab === 'users') {
              setEditingUser(null);
              resetUserForm();
              setShowUserModal(true);
            } else {
              setEditingEmployee(null);
              setEmployeeFormData({ name: '', phone: '', user_id: '' });
              setShowEmployeeModal(true);
            }
          }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          + {activeTab === 'users' ? 'Thêm tài khoản' : 'Thêm nhân viên'}
        </button>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg shadow p-1">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('users')}
            className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'users'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Tài khoản
          </button>
          {isRoot() && (
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
          )}
          <button
            onClick={() => setActiveTab('employees')}
            className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'employees'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Nhân viên
          </button>
        </div>
      </div>

      {/* Users Tab */}
      {activeTab === 'users' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {usersLoading ? (
            <div className="text-center py-8">Đang tải...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Tên</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">SĐT</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Cửa hàng</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Vai trò</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Trạng thái</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Lương/giờ</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Lương/ca</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="px-4 py-8 text-center text-gray-500">
                        Chưa có tài khoản nào
                      </td>
                    </tr>
                  ) : (
                    users.map((user) => (
                      <tr key={user.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-800">{user.name}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{user.phone}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{user.store_name || '-'}</td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`px-2 py-1 rounded-full text-xs ${
                            user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                          }`}>
                            {user.role === 'admin' ? 'Admin' : 'Nhân viên'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`px-2 py-1 rounded-full text-xs ${
                            user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                          }`}>
                            {user.role === 'admin' ? 'Admin' : 'Nhân viên'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`px-2 py-1 rounded-full text-xs ${
                            user.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                          }`}>
                            {user.status === 'active' ? 'Hoạt động' : 'Ngưng'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {user.hourly_rate ? new Intl.NumberFormat('vi-VN').format(user.hourly_rate) + ' đ' : '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {user.shift_rate ? new Intl.NumberFormat('vi-VN').format(user.shift_rate) + ' đ' : '-'}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleUserEdit(user)}
                              className="text-blue-600 hover:text-blue-700"
                            >
                              Sửa
                            </button>
                            {user.role !== 'admin' && (
                              <button
                                onClick={() => handleUserDelete(user.id)}
                                className="text-red-600 hover:text-red-700"
                              >
                                Xóa
                              </button>
                            )}
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

      {/* Employees Tab */}
      {activeTab === 'employees' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {employeesLoading ? (
            <div className="text-center py-8">Đang tải...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    {isAdmin() && (
                      <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Cửa hàng</th>
                    )}
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Tên</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">SĐT</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Trạng thái</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {employees.length === 0 ? (
                    <tr>
                      <td colSpan={isAdmin() ? 5 : 4} className="px-4 py-8 text-center text-gray-500">
                        Chưa có nhân viên nào
                      </td>
                    </tr>
                  ) : (
                    employees.map((employee) => (
                      <tr key={employee.id} className="hover:bg-gray-50">
                        {isAdmin() && (
                          <td className="px-4 py-3 text-sm text-gray-600">{employee.store_name || '-'}</td>
                        )}
                        <td className="px-4 py-3 text-sm text-gray-800">{employee.name}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{employee.phone || '-'}</td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`px-2 py-1 rounded-full text-xs ${
                            employee.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                          }`}>
                            {employee.status === 'active' ? 'Hoạt động' : 'Ngừng hoạt động'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleEmployeeEdit(employee)}
                              className="text-blue-600 hover:text-blue-700"
                            >
                              Sửa
                            </button>
                            <button
                              onClick={() => handleEmployeeDelete(employee.id)}
                              className="text-red-600 hover:text-red-700"
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
          )}
        </div>
      )}

      {/* User Modal */}
      {showUserModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">
              {editingUser ? 'Sửa tài khoản' : 'Thêm tài khoản'}
            </h2>
            <form onSubmit={handleUserSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tên *</label>
                <input
                  type="text"
                  value={userFormData.name}
                  onChange={(e) => setUserFormData({ ...userFormData, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">SĐT *</label>
                <input
                  type="text"
                  value={userFormData.phone}
                  onChange={(e) => setUserFormData({ ...userFormData, phone: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Mật khẩu {editingUser && '(để trống nếu không đổi)'}
                </label>
                <input
                  type="password"
                  value={userFormData.password}
                  onChange={(e) => setUserFormData({ ...userFormData, password: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  required={!editingUser}
                />
                {(!editingUser || userFormData.password) && (
                  <PasswordRequirements password={userFormData.password} />
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Cửa hàng *</label>
                <select
                  value={userFormData.store_id}
                  onChange={(e) => setUserFormData({ ...userFormData, store_id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  required
                  disabled={!!editingUser}
                >
                  <option value="">-- Chọn cửa hàng --</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name} {store.phone && `(${store.phone})`}
                    </option>
                  ))}
                </select>
                {editingUser && (
                  <p className="text-xs text-gray-500 mt-1">Không thể thay đổi cửa hàng sau khi tạo</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vai trò</label>
                <select
                  value={userFormData.role}
                  onChange={(e) => setUserFormData({ ...userFormData, role: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  disabled={!!editingUser}
                >
                  <option value="employer">Nhân viên</option>
                  {isRoot() && <option value="admin">Admin (Chuỗi cửa hàng)</option>}
                  {isRoot() && <option value="root">Root Admin</option>}
                </select>
                {userFormData.role === 'admin' && isRoot() && !editingUser && (
                  <p className="text-xs text-yellow-600 mt-1">
                    ⚠️ Admin mới sẽ ở trạng thái "Chờ phê duyệt" và cần được root phê duyệt trước khi có thể đăng nhập.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ngày bắt đầu</label>
                <input
                  type="date"
                  value={userFormData.started_at}
                  onChange={(e) => setUserFormData({ ...userFormData, started_at: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Trạng thái</label>
                <select
                  value={userFormData.status}
                  onChange={(e) => setUserFormData({ ...userFormData, status: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="active">Hoạt động</option>
                  <option value="inactive">Ngưng</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Lương/giờ (đ)</label>
                <input
                  type="number"
                  value={userFormData.hourly_rate}
                  onChange={(e) => setUserFormData({ ...userFormData, hourly_rate: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Lương/ca (đ)</label>
                <input
                  type="number"
                  value={userFormData.shift_rate}
                  onChange={(e) => setUserFormData({ ...userFormData, shift_rate: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700"
                >
                  {editingUser ? 'Cập nhật' : 'Tạo'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowUserModal(false);
                    setEditingUser(null);
                    resetUserForm();
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

      {/* Pending Admins Tab (Root only) */}
      {activeTab === 'pending' && isRoot() && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {pendingLoading ? (
            <div className="text-center py-8">Đang tải...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Tên</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">SĐT</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">Cửa hàng</th>
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
                        <td className="px-4 py-3 text-sm text-gray-600">{admin.store_name || '-'}</td>
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

      {/* Employee Modal */}
      {showEmployeeModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">
              {editingEmployee ? 'Sửa nhân viên' : 'Thêm nhân viên'}
            </h2>
            <form onSubmit={handleEmployeeSubmit} className="space-y-4">
              {isAdmin() && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Account (Cửa hàng) *
                  </label>
                  <select
                    value={employeeFormData.user_id}
                    onChange={(e) => setEmployeeFormData({ ...employeeFormData, user_id: e.target.value })}
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                    required={!editingEmployee}
                    disabled={!!editingEmployee}
                  >
                    <option value="">-- Chọn account --</option>
                    {employerUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name} ({user.phone}) {user.store_name && `- ${user.store_name}`}
                      </option>
                    ))}
                  </select>
                  {editingEmployee && (
                    <p className="text-xs text-gray-500 mt-1">Không thể thay đổi account sau khi tạo</p>
                  )}
                </div>
              )}
              {!isAdmin() && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                  <p className="font-medium">Lưu ý:</p>
                  <p>Nhân viên sẽ được thêm vào account của bạn.</p>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tên nhân viên *
                </label>
                <input
                  type="text"
                  value={employeeFormData.name}
                  onChange={(e) => setEmployeeFormData({ ...employeeFormData, name: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  SĐT (tùy chọn)
                </label>
                <input
                  type="text"
                  value={employeeFormData.phone}
                  onChange={(e) => setEmployeeFormData({ ...employeeFormData, phone: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 font-medium text-base"
                >
                  {editingEmployee ? 'Cập nhật' : 'Thêm'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowEmployeeModal(false);
                    setEditingEmployee(null);
                    setEmployeeFormData({ name: '', phone: '', user_id: '' });
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
    </div>
  );
}

export default Users;
