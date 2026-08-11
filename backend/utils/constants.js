/**
 * Application constants
 * Centralized configuration values to avoid magic numbers
 */

// Login security constants
export const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5;
export const ACCOUNT_LOCKOUT_MINUTES = parseInt(process.env.ACCOUNT_LOCKOUT_MINUTES) || 30;
export const LOGIN_RATE_LIMIT_WINDOW_MS = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 minutes
export const TIMING_ATTACK_DELAY_MS = parseInt(process.env.TIMING_ATTACK_DELAY_MS) || 1000; // 1 second

// Order code generation
export const MAX_ORDER_CODE_GENERATION_ATTEMPTS = 10;

// Timesheet calculation
export const REGULAR_HOURS_PER_DAY = 8;
export const OVERTIME_MULTIPLIER = parseFloat(process.env.OVERTIME_MULTIPLIER) || 1.5;

// Rate limiter cleanup interval
export const RATE_LIMITER_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
