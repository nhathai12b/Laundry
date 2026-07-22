export const setAuth = (token, user) => {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
};

export const getAuth = () => {
  const token = localStorage.getItem('token');
  const rawUser = localStorage.getItem('user');
  let user = null;
  if (rawUser) {
    try {
      user = JSON.parse(rawUser);
    } catch {
      // Corrupted value (manual edit, partial write, etc.) - clear it instead
      // of throwing and breaking every screen that calls getAuth().
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      return { token: null, user: null };
    }
  }
  return { token, user };
};

export const clearAuth = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
};

export const isAuthenticated = () => {
  return !!localStorage.getItem('token');
};

export const isAdmin = () => {
  const { user } = getAuth();
  return user?.role === 'admin' || user?.role === 'root';
};

export const isRoot = () => {
  const { user } = getAuth();
  return user?.role === 'root';
};

export const isEmployer = () => {
  const { user } = getAuth();
  return user?.role === 'employer';
};

export const getStoreId = () => {
  const { user } = getAuth();
  return user?.store_id || null;
};

export const getEmployeeId = () => {
  const { user } = getAuth();
  return user?.employee_id || null;
};

/** Màn hình nhỏ (điện thoại), breakpoint giống Tailwind md */
export const isMobileScreen = () => {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 768;
};
