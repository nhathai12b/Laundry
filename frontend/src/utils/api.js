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

// Coalesce duplicate mutating requests: double-clicking a submit button fires
// two identical POSTs before the first responds — share one request instead,
// so both click handlers resolve with the same response and no duplicate rows.
const inflight = new Map();
for (const method of ['post', 'put', 'patch']) {
  const original = api[method].bind(api);
  api[method] = (url, data, config) => {
    let key;
    try {
      key = `${method}:${url}:${JSON.stringify(data ?? null)}`;
    } catch {
      return original(url, data, config); // non-serializable body: skip dedupe
    }
    if (inflight.has(key)) return inflight.get(key);
    const request = original(url, data, config).finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  };
}

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
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;

