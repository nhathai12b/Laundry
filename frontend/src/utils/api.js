import axios from 'axios';

// Use same-origin by default.
// - Dev: Vite proxy forwards /api -> http://localhost:5000
// - Prod (VPS): Nginx should proxy /api -> http://localhost:5000
const API_URL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle token expiration
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || '';
    // These endpoints return 401 for normal reasons (wrong password, invalid
    // session), not because an existing session expired. Redirecting/clearing
    // storage here would wipe the on-screen error message via a full reload
    // and can even log a still-valid user out while they're just fixing a
    // typo in the change-password form.
    const isAuthEndpoint = /\/auth\/(login|register|select-store|select-employee)(\?|$)/.test(url);

    if (error.response?.status === 401 && !isAuthEndpoint) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;

