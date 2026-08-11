/**
 * Rate limiting middleware for login attempts
 * Prevents brute force attacks by limiting login attempts per IP
 */

import { MAX_LOGIN_ATTEMPTS, LOGIN_RATE_LIMIT_WINDOW_MS, RATE_LIMITER_CLEANUP_INTERVAL_MS } from '../utils/constants.js';

// In-memory store for rate limiting (use Redis in production)
const loginAttempts = new Map();

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of loginAttempts.entries()) {
    if (now - data.firstAttempt > LOGIN_RATE_LIMIT_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}, RATE_LIMITER_CLEANUP_INTERVAL_MS);

/**
 * Rate limiter for login endpoint
 * @param {number} maxAttempts - Maximum attempts allowed (default from constants)
 * @param {number} windowMs - Time window in milliseconds (default from constants)
 */
export const loginRateLimiter = (maxAttempts = MAX_LOGIN_ATTEMPTS, windowMs = LOGIN_RATE_LIMIT_WINDOW_MS) => {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `login:${ip}`;
    
    const now = Date.now();
    const attemptData = loginAttempts.get(key);

    if (!attemptData) {
      // First attempt
      loginAttempts.set(key, {
        count: 1,
        firstAttempt: now,
        lastAttempt: now
      });
      return next();
    }

    // Check if window has expired
    if (now - attemptData.firstAttempt > windowMs) {
      // Reset window
      loginAttempts.set(key, {
        count: 1,
        firstAttempt: now,
        lastAttempt: now
      });
      return next();
    }

    // Check if max attempts exceeded
    if (attemptData.count >= maxAttempts) {
      const remainingTime = Math.ceil((windowMs - (now - attemptData.firstAttempt)) / 1000 / 60);
      return res.status(429).json({
        error: `Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau ${remainingTime} phút.`,
        retryAfter: remainingTime
      });
    }

    // Increment attempt count
    attemptData.count++;
    attemptData.lastAttempt = now;
    loginAttempts.set(key, attemptData);

    next();
  };
};

/**
 * Reset rate limit for successful login
 */
export const resetLoginRateLimit = (req) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const key = `login:${ip}`;
  loginAttempts.delete(key);
};
