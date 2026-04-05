import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated, isAdmin, isRoot, isMobileScreen } from './utils/auth';
import Login from './pages/Login';
import Register from './pages/Register';
import AdminLayout from './layouts/AdminLayout';
import AdminMobileOverview from './pages/admin/AdminMobileOverview';
import EmployerLayout from './layouts/EmployerLayout';
import Dashboard from './pages/Dashboard';
import Home from './pages/Home';
import Users from './pages/admin/Users';
import Products from './pages/admin/Products';
import Orders from './pages/Orders';
import PendingOrders from './pages/PendingOrders';
import Customers from './pages/Customers';
import Timesheets from './pages/Timesheets';
import Reports from './pages/admin/Reports';
import Settings from './pages/admin/Settings';
import Employees from './pages/admin/Employees';
import Stores from './pages/admin/Stores';
import AdminManagement from './pages/admin/AdminManagement';
import Promotions from './pages/admin/Promotions';

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

