import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../utils/api';
import { setAuth, isAdmin, isRoot } from '../utils/auth';
import '../styles/premium.css';

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
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      display: 'flex',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Animated background */}
      <div style={{
        position: 'absolute',
        top: '-50%',
        left: '-50%',
        width: '200%',
        height: '200%',
        background: 'radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%)',
        animation: 'float 20s ease-in-out infinite'
      }}></div>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translate(0, 0) rotate(0deg); }
          33% { transform: translate(30px, -30px) rotate(120deg); }
          66% { transform: translate(-20px, 20px) rotate(240deg); }
        }

        @keyframes slideUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }

        @keyframes shimmer {
          0%, 100% { background-position: 200% 0; }
          50% { background-position: -200% 0; }
        }

        /* Desktop Layout */
        @media (min-width: 768px) {
          .login-wrapper {
            display: flex;
            width: 100%;
            height: 100vh;
            align-items: stretch;
          }

          .login-branding {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
            padding: 4rem;
            position: relative;
            z-index: 10;
          }

          .login-form-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem;
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
          }

          .login-container {
            width: 100%;
            max-width: 420px;
          }

          .login-card {
            background: transparent;
            box-shadow: none;
            padding: 0;
            border: none;
            animation: slideUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
          }

          .login-card::before {
            display: none;
          }

          .login-header {
            display: none;
          }

          .brand-section h1 {
            font-size: 3.5rem;
            font-weight: 900;
            color: white;
            margin: 0 0 1.5rem;
            line-height: 1.2;
            text-shadow: 0 2px 10px rgba(0,0,0,0.2);
          }

          .brand-section p {
            font-size: 1.25rem;
            color: rgba(255,255,255,0.9);
            margin: 0 0 3rem;
            line-height: 1.6;
            font-weight: 300;
          }

          .brand-features {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            margin-top: 3rem;
          }

          .feature-item {
            display: flex;
            gap: 1rem;
            align-items: flex-start;
          }

          .feature-icon {
            font-size: 2rem;
            flex-shrink: 0;
          }

          .feature-text {
            color: rgba(255,255,255,0.85);
            font-weight: 400;
            line-height: 1.4;
          }

          .form-group {
            margin-bottom: 1.5rem;
          }
        }

        /* Mobile Layout */
        @media (max-width: 767px) {
          .login-wrapper {
            display: flex;
            flex-direction: column;
            width: 100%;
            min-height: 100vh;
            padding: 1rem;
            align-items: center;
            justify-content: center;
          }

          .login-branding {
            display: none;
          }

          .login-form-wrapper {
            width: 100%;
            background: transparent;
            padding: 0;
          }

          .login-container {
            width: 100%;
            max-width: 420px;
            position: relative;
            z-index: 10;
          }

          .login-card {
            background: white;
            border-radius: 24px;
            box-shadow: 0 25px 50px rgba(0,0,0,0.3);
            padding: 3rem;
            animation: slideUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
            border: 1px solid rgba(255, 255, 255, 0.8);
            position: relative;
            overflow: hidden;
          }

          .login-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 4px;
            background: linear-gradient(90deg, #667eea, #764ba2, #667eea);
            background-size: 200% 100%;
            animation: shimmer 2s ease-in-out infinite;
          }

          .login-header {
            text-align: center;
            margin-bottom: 2.5rem;
          }

          .login-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
            animation: bounce 2s ease-in-out infinite;
            display: inline-block;
          }

          .login-title {
            font-size: 2rem;
            font-weight: 800;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.5rem;
            letter-spacing: -1px;
          }

          .login-subtitle {
            font-size: 0.875rem;
            color: #6b7280;
            font-weight: 500;
          }

          .form-group {
            margin-bottom: 1.5rem;
          }

          .login-form {
            animation: fadeIn 0.8s ease;
          }

          .login-footer {
            text-align: center;
            margin-top: 2rem;
            font-size: 0.875rem;
            color: #6b7280;
          }

          .login-footer a {
            color: #667eea;
            font-weight: 700;
            text-decoration: none;
            transition: all 0.3s ease;
            position: relative;
          }

          .login-footer a::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            width: 0;
            height: 2px;
            background: linear-gradient(90deg, #667eea, #764ba2);
            transition: width 0.3s ease;
          }

          .login-footer a:hover::after {
            width: 100%;
          }
        }

        /* Desktop Styling */
        @media (min-width: 768px) {
          .login-title {
            font-size: 1.5rem;
            font-weight: 600;
            color: #1f2937;
            margin-bottom: 0.5rem;
          }

          .login-subtitle {
            font-size: 0.875rem;
            color: #6b7280;
            margin-bottom: 2rem;
          }

          label {
            display: block;
            font-weight: 600;
            color: #374151;
            margin-bottom: 0.5rem;
            font-size: 0.95rem;
          }

          input[type="text"],
          input[type="password"],
          select {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 1.5px solid #e5e7eb;
            border-radius: 8px;
            font-size: 1rem;
            transition: all 0.3s ease;
            background: #f9fafb;
          }

          input[type="text"]:focus,
          input[type="password"]:focus,
          select:focus {
            outline: none;
            border-color: #667eea;
            background: white;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
          }

          .btn {
            padding: 0.875rem 1.5rem;
            border-radius: 8px;
            font-weight: 600;
            font-size: 0.95rem;
            cursor: pointer;
            transition: all 0.3s ease;
            border: none;
          }

          .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }

          .btn-primary:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
          }

          .alert {
            padding: 0.875rem 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            font-size: 0.9rem;
          }

          .alert-danger {
            background: #fee2e2;
            color: #991b1b;
            border: 1px solid #fecaca;
          }
        }
      `}</style>

      <div className="login-wrapper">
        {/* Desktop Branding Section */}
        <div className="login-branding">
          <div className="brand-section">
            <h1>X-Wash</h1>
            <p>Giải pháp quản lý cửa hàng giặt ủi hiện đại dành cho bạn</p>

            <div className="brand-features">
              <div className="feature-item">
                <div className="feature-icon">📊</div>
                <div className="feature-text">
                  <strong>Quản lý hoàn toàn</strong><br/>
                  Từ đơn hàng, thanh toán đến nhân viên
                </div>
              </div>
              <div className="feature-item">
                <div className="feature-icon">⚡</div>
                <div className="feature-text">
                  <strong>Nhanh chóng & Hiệu quả</strong><br/>
                  Tối ưu hóa quy trình kinh doanh
                </div>
              </div>
              <div className="feature-item">
                <div className="feature-icon">🔒</div>
                <div className="feature-text">
                  <strong>An toàn & Bảo mật</strong><br/>
                  Bảo vệ dữ liệu của bạn
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Form Section */}
        <div className="login-form-wrapper">
          <div className="login-container">
            <div className="login-card">
              <div className="login-header">
                <div className="login-icon">🏪</div>
                <h1 className="login-title">X-Wash</h1>
                <p className="login-subtitle">Hệ thống quản lý cửa hàng giặt ủi hiện đại</p>
              </div>

              <form onSubmit={handleSubmit}>
                {error && (
                  <div className="alert alert-danger" style={{ marginBottom: '1.25rem' }}>
                    {error}
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="phone">📞 Số điện thoại</label>
                  <input
                    id="phone"
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="09xxxxxxxx"
                    required
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="password">🔐 Mật khẩu</label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Nhập mật khẩu của bạn"
                    required
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="btn btn-primary"
                  style={{ width: '100%', marginTop: '1.5rem' }}
                >
                  {loading ? '⏳ Đang đăng nhập...' : '✓ Đăng nhập'}
                </button>

                <p style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.875rem', color: '#6b7280' }}>
                  Chưa có tài khoản?{' '}
                  <Link to="/register" style={{ color: '#667eea', fontWeight: '500', textDecoration: 'none' }}>
                    Đăng ký ngay
                  </Link>
                </p>
              </form>
            </div>
          </div>
        </div>
      </div>

      {/* Store/Employee Selection Modal */}
      {showStoreSelection && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">
                {isStoreSelection ? '🏢 Chọn cửa hàng' : '👥 Chọn nhân viên'}
              </h2>
              <button onClick={() => setShowStoreSelection(false)} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-danger">{error}</div>}
              <div className="form-group">
                <label>
                  {isStoreSelection ? '✓ Cửa hàng *' : '✓ Nhân viên'}
                </label>
                <select
                  value={selectedStore}
                  onChange={(e) => setSelectedStore(e.target.value)}
                  required={isStoreSelection}
                >
                  <option value="">
                    {isStoreSelection ? '-- Chọn cửa hàng --' : '-- Chọn hoặc để trống --'}
                  </option>
                  {stores.length === 0 && !isStoreSelection ? (
                    <option value="" disabled>Chưa có nhân viên</option>
                  ) : (
                    stores.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} {item.phone ? `(${item.phone})` : ''}
                      </option>
                    ))
                  )}
                </select>
                {!isStoreSelection && (
                  <p style={{ fontSize: '0.8125rem', color: '#6b7280', marginTop: '0.5rem' }}>
                    Để trống nếu bạn là chủ cửa hàng
                  </p>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button
                onClick={() => {
                  setShowStoreSelection(false);
                  setSelectedStore('');
                  setTempUser(null);
                  setStores([]);
                  setIsStoreSelection(false);
                }}
                className="btn btn-outline"
              >
                Hủy
              </button>
              <button
                onClick={handleStoreSelect}
                disabled={loading}
                className="btn btn-primary"
              >
                {loading ? '⏳ Xử lý...' : '✓ Xác nhận'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Login;

