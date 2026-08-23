import { useEffect, useState } from 'react';
import api from '../../utils/api';
import { isAdmin } from '../../utils/auth';
import PasswordRequirements from '../../components/PasswordRequirements';

function Stores() {
  const [activeTab, setActiveTab] = useState('stores'); // 'stores', 'employees'
  
  // Stores state
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingStore, setEditingStore] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    address: '',
    phone: '',
    status: 'active',
    account_phone: '',
    account_password: '',
  });

  // Users state
  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userFormData, setUserFormData] = useState({
    name: '',
    phone: '',
    password: '',
    hourly_rate: '',
    shift_rate: '',
    store_id: '',
  });

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

  useEffect(() => {
    if (activeTab === 'stores') {
      loadUsers().then(() => {
        loadStores();
      });
    } else if (activeTab === 'employees') {
      loadEmployees();
      loadStoresForEmployees();
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

  const loadStoresForEmployees = async () => {
    try {
      const response = await api.get('/users');
      const employerList = (response.data.data || []).filter(u => u.role === 'employer' && u.status === 'active');
      setEmployerUsers(employerList);
      
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

  // Users functions
  const loadUsers = async () => {
    try {
      setUsersLoading(true);
      const response = await api.get('/users');
      const usersData = response.data.data || [];
      setUsers(usersData);
      return usersData; // Return để có thể await
    } catch (error) {
      console.error('Error loading users:', error);
      alert('Không thể tải danh sách tài khoản');
      return [];
    } finally {
      setUsersLoading(false);
    }
  };

  const handleUserSubmit = async (e) => {
    e.preventDefault();
    try {
      const submitData = {
        ...userFormData,
        // Set default values for required fields when creating new user
        role: 'employer',
        status: 'active',
      };
      
      if (editingUser) {
        // Remove password if empty when editing
        if (!submitData.password || submitData.password.trim() === '') {
          delete submitData.password;
        }
        await api.patch(`/users/${editingUser.id}`, submitData);
        alert('Cập nhật tài khoản thành công!');
      } else {
        await api.post('/users', submitData);
        alert('Tạo tài khoản thành công!');
      }
      setShowUserModal(false);
      setEditingUser(null);
      resetUserForm();
      await loadUsers();
      await loadStores();
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
      hourly_rate: user.hourly_rate || '',
      shift_rate: user.shift_rate || '',
      store_id: user.store_id || '',
    });
    setShowUserModal(true);
  };


  const resetUserForm = () => {
    setUserFormData({
      name: '',
      phone: '',
      password: '',
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
        user_id: isAdmin() ? employeeFormData.user_id : undefined
      };
      
      if (editingEmployee) {
        await api.patch(`/employees/${editingEmployee.id}`, submitData);
        alert('Cập nhật nhân viên thành công!');
      } else {
        await api.post('/employees', submitData);
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
      user_id: employee.store_id,
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

  const handleUserDelete = async (userId, userName, storeName) => {
    if (!confirm(`Bạn có chắc muốn xóa tài khoản "${userName}" của cửa hàng "${storeName}"?`)) return;
    try {
      await api.delete(`/users/${userId}`);
      alert('Xóa tài khoản thành công!');
      await loadUsers();
      await loadStores();
    } catch (error) {
      console.error('Error deleting user:', error);
      alert(error.response?.data?.error || 'Xóa tài khoản thất bại');
    }
  };

  const loadStores = async () => {
    try {
      setLoading(true);
      const response = await api.get('/stores');
      const storesData = response.data.data || [];
      setStores(storesData);

      return storesData;
    } catch (error) {
      console.error('Error loading stores:', error);
      alert('Không thể tải danh sách cửa hàng');
      return [];
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name.trim()) {
      alert('Vui lòng nhập tên cửa hàng');
      return;
    }

    try {
      if (editingStore) {
        // When editing, only update store info (name/address/phone/status).
        // Do NOT touch account fields or shared_account_id — the form has no UI
        // for them, and forcing shared_account_id=null here wiped the link for
        // stores that use a shared account.
        const storeData = {
          name: formData.name,
          address: formData.address,
          phone: formData.phone,
          status: formData.status,
        };
        await api.patch(`/stores/${editingStore.id}`, storeData);
        alert('Cập nhật cửa hàng thành công!');
      } else {
        // When creating, always create a new employer account.
        // The store phone doubles as the account login phone.
        if (!formData.phone.trim() || !formData.account_password.trim()) {
          alert('Vui lòng nhập đầy đủ thông tin (Tên cửa hàng, SĐT, Mật khẩu)');
          return;
        }
        const submitData = {
          name: formData.name,
          address: formData.address,
          phone: formData.phone,
          account_phone: formData.phone,
          account_password: formData.account_password,
        };

        const response = await api.post('/stores', submitData);
        // Debug log removed for security
        alert('Tạo cửa hàng thành công!');
      }
      setShowModal(false);
      setEditingStore(null);
      resetForm();
      // Load users first, then stores to ensure users are available
      await loadUsers();
      await loadStores();
      
      // Force reload stores after a short delay to ensure backend has updated
      setTimeout(async () => {
        await loadStores();
      }, 500);
    } catch (error) {
      console.error('Error saving store:', error);
      alert(error.response?.data?.error || 'Có lỗi xảy ra khi lưu cửa hàng');
    }
  };

  const handleEdit = (store) => {
    setEditingStore(store);
    setFormData({
      name: store.name || '',
      address: store.address || '',
      phone: store.phone || '',
      status: store.status || 'active',
      account_phone: '',
      account_password: '',
    });
    setShowModal(true);
  };

  const handleToggleStatus = async (store) => {
    if (!confirm(`Bạn có chắc muốn ${store.status === 'active' ? 'vô hiệu hóa' : 'kích hoạt'} cửa hàng "${store.name}"?`)) {
      return;
    }

    try {
      await api.patch(`/stores/${store.id}`, {
        status: store.status === 'active' ? 'inactive' : 'active',
      });
      alert('Cập nhật trạng thái cửa hàng thành công!');
      loadStores();
    } catch (error) {
      console.error('Error updating store status:', error);
      alert(error.response?.data?.error || 'Có lỗi xảy ra');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      address: '',
      phone: '',
      status: 'active',
      account_phone: '',
      account_password: '',
      shared_account_id: '',
    });
  };

  if (loading) {
    return <div className="text-center py-8">Đang tải...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Cửa hàng & Nhân sự</h1>
          <p className="text-gray-600">Quản lý cửa hàng, tài khoản và nhân viên</p>
        </div>
        <button
          onClick={() => {
            if (activeTab === 'stores') {
              setEditingStore(null);
              resetForm();
              setShowModal(true);
            } else if (activeTab === 'employees') {
              setEditingEmployee(null);
              setEmployeeFormData({ name: '', phone: '', user_id: '' });
              setShowEmployeeModal(true);
            }
          }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          + {activeTab === 'stores' ? 'Thêm cửa hàng' : 'Thêm nhân viên'}
        </button>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg shadow p-1">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('stores')}
            className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'stores'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            🏪 Cửa hàng & Tài khoản
          </button>
          <button
            onClick={() => setActiveTab('employees')}
            className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'employees'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            👥 Nhân viên
          </button>
        </div>
      </div>

      {/* Stores & Users Tab */}
      {activeTab === 'stores' && (
        <div className="space-y-4">
          {/* Stores Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="p-4 border-b">
              <h2 className="text-lg font-semibold text-gray-800">Danh sách cửa hàng</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Tên cửa hàng</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Địa chỉ</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">SĐT</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Tài khoản</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Trạng thái</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {stores.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="px-4 py-8 text-center text-gray-500">
                        Chưa có cửa hàng nào
                      </td>
                    </tr>
                  ) : (
                    stores.map((store) => {
                      // Ưu tiên dùng thông tin từ backend query (nếu có)
                      let accountToShow = null;
                      let isShared = false;
                      
                      // Kiểm tra tài khoản chung trước
                      if (store.shared_account_id) {
                        if (store.shared_account_name || store.shared_account_user_id) {
                          // Có tài khoản chung từ backend query
                          accountToShow = {
                            id: store.shared_account_user_id,
                            name: store.shared_account_name,
                            phone: store.shared_account_phone,
                            store_id: store.id
                          };
                          isShared = true;
                        } else {
                          // Fallback: tìm trong users array
                          const sharedAccount = users.find(u => u.id === store.shared_account_id);
                          if (sharedAccount) {
                            accountToShow = sharedAccount;
                            isShared = true;
                          }
                        }
                      }
                      
                      // Nếu không có tài khoản chung, tìm tài khoản riêng
                      if (!accountToShow) {
                        if (store.own_account_user_id || store.own_account_name) {
                          // Có tài khoản riêng từ backend query
                          accountToShow = {
                            id: store.own_account_user_id,
                            name: store.own_account_name,
                            phone: store.own_account_phone,
                            store_id: store.id
                          };
                        } else {
                          // Fallback: tìm trong users array
                          const storeUser = users.find(u => u.store_id === store.id && u.role === 'employer');
                          if (storeUser) {
                            accountToShow = storeUser;
                          }
                        }
                      }
                      return (
                        <tr key={store.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-900 font-medium">{store.name}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{store.address || '-'}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{store.phone || '-'}</td>
                          <td className="px-4 py-3 text-sm">
                            {accountToShow ? (
                              <div>
                                <div className="flex items-center gap-2">
                                  <div className="text-gray-800 font-medium">{accountToShow.name}</div>
                                  {isShared && (
                                    <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs font-medium">
                                      Chung
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500">{accountToShow.phone}</div>
                                <div className="mt-1 flex items-center gap-2">
                                  <button
                                    onClick={() => handleUserEdit(accountToShow)}
                                    className="text-blue-600 hover:text-blue-700 text-xs"
                                  >
                                    Sửa tài khoản
                                  </button>
                                  <button
                                    onClick={() => handleUserDelete(accountToShow.id, accountToShow.name, store.name)}
                                    className="text-red-600 hover:text-red-700 text-xs"
                                  >
                                    Xóa tài khoản
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div>
                                <span className="text-gray-400 text-xs">Chưa có tài khoản</span>
                                <div className="mt-1">
                                  <button
                                    onClick={() => {
                                      setEditingUser(null);
                                      resetUserForm();
                                      setUserFormData(prev => ({ ...prev, store_id: store.id }));
                                      setShowUserModal(true);
                                    }}
                                    className="text-blue-600 hover:text-blue-700 text-xs"
                                  >
                                    + Tạo tài khoản
                                  </button>
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium ${
                                store.status === 'active'
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {store.status === 'active' ? 'Hoạt động' : 'Ngừng hoạt động'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleEdit(store)}
                                className="text-blue-600 hover:text-blue-700 font-medium text-sm"
                              >
                                Sửa
                              </button>
                              <button
                                onClick={() => handleToggleStatus(store)}
                                className={`font-medium text-sm ${
                                  store.status === 'active'
                                    ? 'text-orange-600 hover:text-orange-700'
                                    : 'text-green-600 hover:text-green-700'
                                }`}
                              >
                                {store.status === 'active' ? 'Vô hiệu hóa' : 'Kích hoạt'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
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

      {/* Store Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">
              {editingStore ? 'Sửa cửa hàng' : 'Thêm cửa hàng'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tên cửa hàng *
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
                  Địa chỉ
                </label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Số điện thoại {!editingStore && '*'}
                </label>
                <input
                  type="text"
                  value={formData.phone}
                  onChange={(e) => {
                    const phoneValue = e.target.value;
                    setFormData({ 
                      ...formData, 
                      phone: phoneValue,
                      // Tự động copy số điện thoại sang account_phone
                      account_phone: phoneValue
                    });
                  }}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                  required={!editingStore}
                />
                {!editingStore && (
                  <p className="text-xs text-gray-500 mt-1">Số điện thoại này cũng sẽ được dùng cho tài khoản</p>
                )}
              </div>
              {editingStore && (
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
              )}
              
              {!editingStore && (
                <>
                  <div className="border-t pt-4 mt-4">
                    <h3 className="text-lg font-semibold text-gray-800 mb-3">Thông tin tài khoản</h3>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Mật khẩu *
                      </label>
                      <input
                        type="password"
                        value={formData.account_password}
                        onChange={(e) => setFormData({ ...formData, account_password: e.target.value })}
                        className="w-full px-3 py-2.5 border rounded-lg text-base"
                        required
                        placeholder="Nhập mật khẩu"
                      />
                      <PasswordRequirements password={formData.account_password} />
                    </div>
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                      <p className="font-medium">Lưu ý:</p>
                      <p>Đăng nhập bằng số điện thoại cửa hàng và mật khẩu. Tên hiển thị tài khoản trùng với tên cửa hàng.</p>
                    </div>
                  </div>
                </>
              )}
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg hover:bg-blue-700 font-medium"
                >
                  {editingStore ? 'Cập nhật' : 'Tạo'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false);
                    setEditingStore(null);
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

export default Stores;
