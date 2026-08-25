import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated, isAdmin, isRoot, isMobileScreen } from './utils/auth';
// Login giữ eager để màn hình đăng nhập hiện tức thì
import Login from './pages/Login';
import ToastContainer from './components/ToastContainer';

// Code-splitting theo route: mỗi trang là một chunk riêng, tải khi cần.
// Nhân viên không phải tải code admin (Reports, Stores, Dashboard...) và
// ngược lại — bundle khởi động nhỏ đi nhiều lần.
const Register = lazy(() => import('./pages/Register'));
const AdminLayout = lazy(() => import('./layouts/AdminLayout'));
const AdminMobileOverview = lazy(() => import('./pages/admin/AdminMobileOverview'));
const EmployerLayout = lazy(() => import('./layouts/EmployerLayout'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Home = lazy(() => import('./pages/Home'));
const Users = lazy(() => import('./pages/admin/Users'));
const Products = lazy(() => import('./pages/admin/Products'));
const Orders = lazy(() => import('./pages/Orders'));
const PendingOrders = lazy(() => import('./pages/PendingOrders'));
const Customers = lazy(() => import('./pages/Customers'));
const Timesheets = lazy(() => import('./pages/Timesheets'));
const Reports = lazy(() => import('./pages/admin/Reports'));
const Settings = lazy(() => import('./pages/admin/Settings'));
const Employees = lazy(() => import('./pages/admin/Employees'));
const Stores = lazy(() => import('./pages/admin/Stores'));
const AdminManagement = lazy(() => import('./pages/admin/AdminManagement'));
const Promotions = lazy(() => import('./pages/admin/Promotions'));

// Fallback khi đang tải chunk của trang
const PageLoading = () => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50">
    <div className="text-center">
      <div className="inline-block animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mb-3"></div>
      <div className="text-sm text-gray-500">Đang tải...</div>
    </div>
  </div>
);

const PrivateRoute = ({ children, adminOnly = false }) => {
  if (!isAuthenticated()) {
    return <Navigate to="/login" />;
  }
  if (adminOnly && !isAdmin()) {
    return <Navigate to="/" />;
  }
  return children;
};

// Route protection cho root admin - chỉ cho phép truy cập Dashboard và Admin Management
const RootAdminRoute = ({ children }) => {
  const location = useLocation();
  
  if (!isAuthenticated()) {
    return <Navigate to="/login" />;
  }
  if (!isAdmin()) {
    return <Navigate to="/" />;
  }
  // Nếu là root admin và đang cố truy cập page không được phép, redirect về dashboard
  if (isRoot() && location.pathname !== '/admin' && location.pathname !== '/admin/admin-management') {
    return <Navigate to="/admin" replace />;
  }
  return children;
};

// Route protection cho admin thường - root admin không được truy cập
const AdminOnlyRoute = ({ children }) => {
  const location = useLocation();
  
  if (!isAuthenticated()) {
    return <Navigate to="/login" />;
  }
  if (!isAdmin()) {
    return <Navigate to="/" />;
  }
  // Root admin không được truy cập các trang admin thường
  if (isRoot()) {
    return <Navigate to="/admin" replace />;
  }
  return children;
};

// Chỉ nhân viên (employer) mới vào được layout trang chủ/tạo đơn - admin không thấy trang tạo đơn
const EmployerOnlyRoute = ({ children }) => {
  if (!isAuthenticated()) {
    return <Navigate to="/login" />;
  }
  if (isAdmin()) {
    return <Navigate to="/admin" replace />;
  }
  return children;
};

/** Admin thường + màn nhỏ → chỉ trang tổng quan điện thoại */
function AdminMobileRedirect() {
  const loc = useLocation();
  const [narrow, setNarrow] = useState(() => isMobileScreen());
  useEffect(() => {
    const check = () => setNarrow(isMobileScreen());
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  if (isAuthenticated() && isAdmin() && !isRoot() && narrow) {
    if (loc.pathname !== '/admin/mobile') {
      return <Navigate to="/admin/mobile" replace />;
    }
  }
  return <AdminLayout />;
}

function App() {
  return (
    <Router>
      <ToastContainer />
      <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        <Route
          path="/admin/mobile"
          element={
            <PrivateRoute adminOnly={true}>
              <AdminMobileEntry />
            </PrivateRoute>
          }
        />

        <Route
          path="/admin/*"
          element={
            <PrivateRoute adminOnly={true}>
              <AdminMobileRedirect />
            </PrivateRoute>
          }
        >
          <Route index element={<RootAdminRoute><Dashboard /></RootAdminRoute>} />
          <Route path="admin-management" element={<RootAdminRoute><AdminManagement /></RootAdminRoute>} />
          {/* Các route chỉ dành cho admin thường, root admin sẽ bị redirect */}
          <Route path="users" element={<AdminOnlyRoute><Users /></AdminOnlyRoute>} />
          <Route path="products" element={<AdminOnlyRoute><Products /></AdminOnlyRoute>} />
          <Route path="customers" element={<AdminOnlyRoute><Customers /></AdminOnlyRoute>} />
          <Route path="timesheets" element={<AdminOnlyRoute><Timesheets /></AdminOnlyRoute>} />
          <Route path="reports" element={<AdminOnlyRoute><Reports /></AdminOnlyRoute>} />
          <Route path="settings" element={<AdminOnlyRoute><Settings /></AdminOnlyRoute>} />
          <Route path="stores" element={<AdminOnlyRoute><Stores /></AdminOnlyRoute>} />
          <Route path="promotions" element={<AdminOnlyRoute><Promotions /></AdminOnlyRoute>} />
          <Route path="orders" element={<AdminOnlyRoute><Orders /></AdminOnlyRoute>} />
        </Route>

        <Route
          path="/*"
          element={
            <PrivateRoute>
              <EmployerOnlyRoute>
                <EmployerLayout />
              </EmployerOnlyRoute>
            </PrivateRoute>
          }
        >
          <Route index element={<Home />} />
          <Route path="pending-orders" element={<PendingOrders />} />
          <Route path="customers" element={<Customers />} />
          <Route path="timesheets" element={<Timesheets />} />
          <Route path="employees" element={<Employees />} />
        </Route>
      </Routes>
      </Suspense>
    </Router>
  );
}

/** Chỉ admin thường trên điện thoại; root / desktop dùng /admin đầy đủ */
function AdminMobileEntry() {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  if (!isAdmin()) {
    return <Navigate to="/" replace />;
  }
  if (isRoot()) {
    return <Navigate to="/admin" replace />;
  }
  if (!isMobileScreen()) {
    return <Navigate to="/admin" replace />;
  }
  return <AdminMobileOverview />;
}

export default App;

