/**
 * Rate limiting middleware for authentication endpoints
 * Prevents brute force attacks by limiting attempts per IP
 */

import { MAX_LOGIN_ATTEMPTS, LOGIN_RATE_LIMIT_WINDOW_MS, RATE_LIMITER_CLEANUP_INTERVAL_MS } from '../utils/constants.js';

// In-memory store for rate limiting (use Redis in production)
const attemptStore = new Map();

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of attemptStore.entries()) {
    if (now - data.firstAttempt > data.windowMs) {
      attemptStore.delete(key);
    }
  }
}, RATE_LIMITER_CLEANUP_INTERVAL_MS);

// Dùng chung toàn backend (rate limit, lưu IP chấm công để đối soát...) —
// sửa cách lấy IP sau proxy thì chỉ sửa ở đây
export const getClientIp = (req) => req.ip || req.connection?.remoteAddress || 'unknown';

/**
 * Generic per-IP rate limiter factory.
 * @param {string} prefix - Bucket namespace so different endpoints don't share counters
 * @param {number} maxAttempts - Maximum attempts allowed within the window
 * @param {number} windowMs - Time window in milliseconds
 */
export const createRateLimiter = (prefix, maxAttempts, windowMs) => {
  return (req, res, next) => {
    const key = `${prefix}:${getClientIp(req)}`;
    const now = Date.now();
    const attemptData = attemptStore.get(key);

    if (!attemptData || now - attemptData.firstAttempt > windowMs) {
      attemptStore.set(key, { count: 1, firstAttempt: now, lastAttempt: now, windowMs });
      return next();
    }

    if (attemptData.count >= maxAttempts) {
      const remainingTime = Math.ceil((windowMs - (now - attemptData.firstAttempt)) / 1000 / 60);
      return res.status(429).json({
        error: `Quá nhiều lần thử. Vui lòng thử lại sau ${remainingTime} phút.`,
        retryAfter: remainingTime
      });
    }

    attemptData.count++;
    attemptData.lastAttempt = now;
    attemptStore.set(key, attemptData);

    next();
  };
};

/**
 * Rate limiter for login endpoint
 */
export const loginRateLimiter = (maxAttempts = MAX_LOGIN_ATTEMPTS, windowMs = LOGIN_RATE_LIMIT_WINDOW_MS) =>
  createRateLimiter('login', maxAttempts, windowMs);

/**
 * Rate limiter for register endpoint (stricter: prevents spamming pending accounts)
 */
export const registerRateLimiter = (maxAttempts = 5, windowMs = 60 * 60 * 1000) =>
  createRateLimiter('register', maxAttempts, windowMs);

/**
 * Login thành công: chỉ hoàn lại 1 lượt (lượt của chính request này) thay vì
 * xóa cả bucket của IP. Xóa cả bucket cho phép kẻ có sẵn 1 tài khoản hợp lệ
 * brute-force tài khoản khác đến sát ngưỡng, đăng nhập tài khoản của mình để
 * reset, rồi tiếp tục — vô hiệu hóa hoàn toàn rate limit theo IP.
 */
export const resetLoginRateLimit = (req) => {
  const data = attemptStore.get(`login:${getClientIp(req)}`);
  if (data && data.count > 0) {
    data.count -= 1;
  }
};
