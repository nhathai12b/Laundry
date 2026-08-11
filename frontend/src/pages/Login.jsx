import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../utils/api';
import { setAuth, isAdmin, isRoot } from '../utils/auth';

function Login() {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showStoreSelection, setShowStoreSelection] = useState(false);
  const [stores, setStores] = useState([]);
  const [selectedStore, setSelectedStore] = useState('');
  const [tempUser, setTempUser] = useState(null);
  const [isStoreSelection, setIsStoreSelection] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await api.post('/auth/login', { phone, password });
      
      if (response.data.requiresStoreSelection) {
        setStores(response.data.stores || []);
        setTempUser(response.data.user);
        setIsStoreSelection(true);
        setShowStoreSelection(true);
        setLoading(false);
        return;
      }

      // Check if employee selection is required (for employer)
      if (response.data.requiresEmployeeSelection) {
        const employees = response.data.employees || [];
        setStores(employees);
        setTempUser(response.data.user);
        setIsStoreSelection(false);
        setShowStoreSelection(true);
        setLoading(false);
        return;
      }

      // Direct login (for employer without employees, or other roles)
      const { token, user } = response.data;
      if (!token || !user) {
        setError('Đăng nhập thất bại: Thiếu thông tin token hoặc user');
        return;
      }

      setAuth(token, user);

      // Root admin chỉ có thể truy cập Dashboard và Admin Management
      if (isRoot()) {
        navigate('/admin');
      } else if (isAdmin()) {
        navigate('/admin');
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Đăng nhập thất bại');
    } finally {
      setLoading(false);
    }
  };

  const handleStoreSelect = async () => {
    setLoading(true);
    setError('');

    try {
      let response;
      if (isStoreSelection) {
        // Admin selecting store
        if (!selectedStore) {
          setError('Vui lòng chọn cửa hàng');
          setLoading(false);
          return;
        }
        response = await api.post('/auth/select-store', {
          userId: tempUser.id,
          storeId: parseInt(selectedStore)
        });
      } else {
        // Employer selecting employee (employeeId is optional - can be null)
        response = await api.post('/auth/select-employee', {
          userId: tempUser.id,
          employeeId: selectedStore ? parseInt(selectedStore) : null
        });
      }

      const { token, user } = response.data;
      if (!token || !user) {
        setError('Đăng nhập thất bại: Thiếu thông tin token hoặc user');
        return;
      }

      setAuth(token, user);

      // Root admin chỉ có thể truy cập Dashboard và Admin Management
      if (isRoot()) {
        navigate('/admin');
      } else if (isAdmin()) {
        navigate('/admin');
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || (isStoreSelection ? 'Chọn cửa hàng thất bại' : 'Chọn nhân viên thất bại'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-800 mb-2">Quản lý cửa hàng</h1>
            <p className="text-gray-600">Hệ thống quản lý</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            <div>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Số điện thoại"
                required
              />
            </div>

            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Mật khẩu"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
            </button>

            <p className="text-center text-sm text-gray-600 mt-4">
              Chưa có tài khoản?{' '}
              <Link to="/register" className="text-blue-600 font-medium hover:underline">
                Đăng ký sử dụng dịch vụ
              </Link>
            </p>
          </form>

        </div>
      </div>

      {/* Store/Employee Selection Modal */}
      {showStoreSelection && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">
              {isStoreSelection ? 'Chọn cửa hàng' : 'Chọn nhân viên'}
            </h2>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
                {error}
              </div>
            )}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {isStoreSelection ? 'Chọn cửa hàng *' : 'Chọn tên nhân viên (tùy chọn)'}
                </label>
                <select
                  value={selectedStore}
                  onChange={(e) => setSelectedStore(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required={isStoreSelection}
                >
                  <option value="">
                    {isStoreSelection ? '-- Chọn cửa hàng --' : '-- Chọn nhân viên hoặc để trống --'}
                  </option>
                  {stores.length === 0 && !isStoreSelection ? (
                    <option value="" disabled>
                      Chưa có nhân viên nào
                    </option>
                  ) : (
                    stores.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} {item.phone ? `(${item.phone})` : ''}
                      </option>
                    ))
                  )}
                </select>
                {!isStoreSelection && (
                  <p className="text-xs text-gray-500 mt-1">
                    Để trống nếu bạn là chủ cửa hàng
                  </p>
                )}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleStoreSelect}
                  disabled={loading}
                  className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Đang xử lý...' : 'Xác nhận'}
                </button>
                <button
                  onClick={() => {
                    setShowStoreSelection(false);
                    setSelectedStore('');
                    setTempUser(null);
                    setStores([]);
                    setIsStoreSelection(false);
                  }}
                  disabled={loading}
                  className="flex-1 bg-gray-200 text-gray-800 py-3 rounded-lg font-medium hover:bg-gray-300 transition-colors disabled:opacity-50"
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

export default Login;

