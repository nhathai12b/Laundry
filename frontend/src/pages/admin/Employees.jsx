import { useEffect, useState } from 'react';
import api from '../../utils/api';
import { isAdmin } from '../../utils/auth';

function Employees() {
  const [employees, setEmployees] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    store_id: '',
  });

  useEffect(() => {
    loadEmployees();
    loadStores();
  }, []);

  const loadEmployees = async () => {
    try {
      const response = await api.get('/employees');
      setEmployees(response.data.data || []);
    } catch (error) {
      console.error('Error loading employees:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadStores = async () => {
    try {
      const response = await api.get('/users');
      const stores = (response.data.data || []).filter(u => u.role === 'employer' && u.status === 'active');
      setStores(stores);
      // Auto-set store_id for employer
      if (!isAdmin() && stores.length > 0) {
        const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
        if (currentUser.id) {
          setFormData(prev => ({ ...prev, store_id: currentUser.id }));
        }
      }
    } catch (error) {
      console.error('Error loading stores:', error);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      // Validate required fields
      if (!formData.name || formData.name.trim() === '') {
        alert('Vui lòng nhập tên nhân viên');
        return;
      }
      
      if (isAdmin() && !editingEmployee && !formData.store_id) {
        alert('Vui lòng chọn cửa hàng');
        return;
      }
      
      // Prepare data - for employer, don't send store_id (backend will use user.id)
      const submitData = isAdmin() 
        ? { name: formData.name.trim(), phone: formData.phone?.trim() || '', store_id: formData.store_id }
        : { name: formData.name.trim(), phone: formData.phone?.trim() || '' };
      
      if (editingEmployee) {
        await api.patch(`/employees/${editingEmployee.id}`, submitData);
      } else {
        await api.post('/employees', submitData);
      }
      setShowModal(false);
      setEditingEmployee(null);
      setFormData({ name: '', phone: '', store_id: '' });
      loadEmployees();
    } catch (error) {
      console.error('Submit error:', error);
      const errorMessage = error.response?.data?.error || error.message || 'Lưu thất bại';
      alert(errorMessage);
    }
  };

  const handleEdit = (employee) => {
    setEditingEmployee(employee);
    setFormData({
      name: employee.name,
      phone: employee.phone || '',
      store_id: employee.store_id,
    });
    setShowModal(true);
  };

  const handleDelete = async (id) => {
    if (!confirm('Bạn có chắc muốn xóa nhân viên này?')) return;
    try {
      await api.delete(`/employees/${id}`);
      loadEmployees();
    } catch (error) {
      alert(error.response?.data?.error || 'Xóa thất bại');
    }
  };

  if (loading) {
    return <div className="text-center py-8">Đang tải...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Quản lý nhân viên</h1>
          <p className="text-gray-600">Thêm và quản lý nhân viên cho từng cửa hàng</p>
        </div>
        <button
          onClick={() => {
            setEditingEmployee(null);
            setFormData({ name: '', phone: '', store_id: '' });
            setShowModal(true);
          }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          + Thêm nhân viên
        </button>
      </div>

      {/* Employees List */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-800">
            {isAdmin() ? 'Tất cả nhân viên' : 'Nhân viên của cửa hàng'}
          </h2>
        </div>
        <div className="divide-y">
          {employees.length === 0 ? (
            <div className="p-8 text-center text-gray-500">Chưa có nhân viên</div>
          ) : (
            employees.map((employee) => (
              <div key={employee.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-gray-800">{employee.name}</div>
                    {employee.phone && (
                      <div className="text-sm text-gray-600">SĐT: {employee.phone}</div>
                    )}
                    {isAdmin() && employee.store_name && (
                      <div className="text-sm text-gray-600">Cửa hàng: {employee.store_name}</div>
                    )}
                    <div className="text-xs text-gray-500 mt-1">
                      Trạng thái: {employee.status === 'active' ? 'Hoạt động' : 'Ngừng hoạt động'}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleEdit(employee)}
                      className="px-3 py-1 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200 text-sm"
                    >
                      Sửa
                    </button>
                    <button
                      onClick={() => handleDelete(employee.id)}
                      className="px-3 py-1 bg-red-100 text-red-600 rounded-lg hover:bg-red-200 text-sm"
                    >
                      Xóa
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">
              {editingEmployee ? 'Sửa nhân viên' : 'Thêm nhân viên'}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              {isAdmin() && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cửa hàng *
                  </label>
                  <select
                    value={formData.store_id}
                    onChange={(e) => setFormData({ ...formData, store_id: e.target.value })}
                    className="w-full px-3 py-2.5 border rounded-lg text-base"
                    required={!editingEmployee}
                    disabled={!!editingEmployee}
                  >
                    <option value="">-- Chọn cửa hàng --</option>
                    {stores.map((store) => (
                      <option key={store.id} value={store.id}>
                        {store.name} ({store.phone})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Tên nhân viên *
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
                  SĐT (tùy chọn)
                </label>
                <input
                  type="text"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
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
                    setShowModal(false);
                    setEditingEmployee(null);
                    setFormData({ name: '', phone: '', store_id: '' });
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

export default Employees;

