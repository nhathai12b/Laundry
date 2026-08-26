export const setAuth = (token, user) => {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
};

export const getAuth = () => {
  const token = localStorage.getItem('token');
  const user = localStorage.getItem('user');
  // try/catch: getAuth chạy trong render của route guard — user bị hỏng trong
  // localStorage (ghi dở, sửa tay) mà throw ở đây là trắng màn hình MỌI trang
  let parsedUser = null;
  try {
    parsedUser = user ? JSON.parse(user) : null;
  } catch {
    localStorage.removeItem('user');
  }
  return { token, user: parsedUser };
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
