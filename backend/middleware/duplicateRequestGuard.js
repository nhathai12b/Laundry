/**
 * Duplicate-request guard for mutating endpoints.
 *
 * A slow create + an impatient second click on "OK" produces two identical
 * POSTs and two database rows. This middleware fingerprints each mutating
 * request (caller + method + path + body); within a short window an identical
 * request either gets the first one's response replayed (already finished)
 * or a 409 (still in flight) instead of being executed again.
 *
 * Failed responses are NOT cached, so genuine retries after an error pass through.
 * In-memory store: single-process only (like the login rate limiter).
 */

import crypto from 'crypto';

const DEFAULT_WINDOW_MS = 5000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

const recentRequests = new Map(); // fingerprint -> { pending, status, body, at, windowMs }

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of recentRequests.entries()) {
    if (now - entry.at > entry.windowMs) {
      recentRequests.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS).unref?.();

const fingerprint = (req) => {
  const raw = [
    req.headers.authorization || req.ip || '',
    req.method,
    req.originalUrl,
    JSON.stringify(req.body ?? null)
  ].join('\n');
  return crypto.createHash('sha256').update(raw).digest('base64');
};

export const duplicateRequestGuard = (windowMs = DEFAULT_WINDOW_MS) => {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();

    const key = fingerprint(req);
    const now = Date.now();
    const seen = recentRequests.get(key);

    if (seen && now - seen.at < windowMs) {
      if (seen.pending) {
        return res.status(409).json({
          error: 'Yêu cầu này đang được xử lý. Vui lòng đợi trong giây lát.'
        });
      }
      // Identical request already succeeded moments ago: replay its response
      // instead of creating a second record
      return res.status(seen.status).json(seen.body);
    }

    recentRequests.set(key, { pending: true, at: now, windowMs });

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        recentRequests.set(key, { pending: false, status: res.statusCode, body, at: Date.now(), windowMs });
      } else {
        recentRequests.delete(key); // don't block genuine retries after failure
      }
      return originalJson(body);
    };

    // Connection died before a response was produced: allow a retry
    res.on('close', () => {
      const entry = recentRequests.get(key);
      if (entry?.pending) recentRequests.delete(key);
    });

    next();
  };
};
