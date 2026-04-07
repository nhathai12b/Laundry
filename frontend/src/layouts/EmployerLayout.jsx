import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { clearAuth, getAuth } from '../utils/auth';

function EmployerLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = getAuth();

  const handleLogout = () => {
    clearAuth();
    navigate('/login');
  };

  const navItems = [
    { path: '/', label: 'Trang chủ', icon: '🏠', getIsActive: (loc) => loc.pathname === '/' && !loc.search.includes('tab=debt') },
    { path: '/pending-orders', label: 'Tồn kho', icon: '📋' },
    { path: '/?tab=debt', label: 'Ghi nợ', icon: '📝', getIsActive: (loc) => loc.pathname === '/' && loc.search.includes('tab=debt') },
    { path: '/customers', label: 'Khách hàng', icon: '👤' },
    { path: '/timesheets', label: 'Chấm công', icon: '⏰' },
  ];

  const isActive = (item) => item.getIsActive ? item.getIsActive(location) : location.pathname === item.path;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 shadow-lg sticky top-0 z-40">
        <div className="flex items-center justify-between p-3 sm:p-4">
          <h1 className="text-lg sm:text-xl font-bold text-white truncate flex-1 min-w-0">
            Quản lý cửa hàng
          </h1>
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0 ml-2">
            <span className="text-xs sm:text-sm text-blue-100 hidden sm:inline truncate max-w-[160px] font-medium bg-white/20 px-3 py-1.5 rounded-lg">
              {user?.name}
            </span>
            <button
              onClick={handleLogout}
              className="text-xs sm:text-sm text-white hover:text-red-200 px-3 py-1.5 sm:px-4 sm:py-2 bg-white/20 hover:bg-white/30 rounded-lg transition-all font-medium active:scale-95"
            >
              <span className="hidden sm:inline">Đăng xuất</span>
              <span className="sm:hidden">Thoát</span>
            </button>
          </div>
        </div>

        {/* Top nav (desktop/tablet) */}
        <div className="hidden sm:block bg-white/95 backdrop-blur-sm border-t border-blue-200">
          <div className="px-3 sm:px-4 md:px-6 py-2">
            <div className="flex gap-2 overflow-x-auto">
              {navItems.map((item) => (
                <Link
                  key={item.path + (item.label || '')}
                  to={item.path}
                  className={`px-4 py-2.5 rounded-xl text-sm font-semibold whitespace-nowrap transition-all duration-200 group ${
                    isActive(item)
                      ? 'bg-gradient-to-r from-blue-500 to-blue-600 text-white shadow-lg transform scale-105'
                      : 'text-gray-700 hover:bg-gray-100 hover:shadow-md hover:transform hover:scale-105 bg-white'
                  }`}
                >
                  <span className="mr-2 text-base inline-block group-hover:scale-110 transition-transform">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="pb-20 sm:pb-6">
        <div className="p-3 sm:p-4 md:p-6">
          <Outlet />
        </div>
      </main>

      {/* Bottom Nav - Mobile Only */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-lg border-t border-gray-200 shadow-2xl z-50 sm:hidden">
        <div className="flex justify-around py-1">
          {navItems.map((item) => (
            <Link
              key={item.path + (item.label || '')}
              to={item.path}
              className={`relative flex flex-col items-center py-2 px-3 flex-1 min-w-0 rounded-xl mx-1 transition-all active:scale-95 ${
                isActive(item)
                  ? 'text-blue-600 bg-blue-50 transform scale-105' 
                  : 'text-gray-600 hover:text-blue-600 active:bg-gray-50'
              }`}
            >
              <span className={`text-2xl mb-1 transition-transform ${isActive(item) ? 'scale-110' : ''}`}>{item.icon}</span>
              <span className="text-[10px] font-medium truncate w-full text-center">{item.label}</span>
              {isActive(item) && (
                <span className="absolute top-0 left-1/2 transform -translate-x-1/2 w-8 h-1 bg-blue-600 rounded-b-full"></span>
              )}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}

export default EmployerLayout;

