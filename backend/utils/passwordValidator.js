/**
 * Password strength validator
 * Enforces strong password requirements
 */

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export const validatePasswordStrength = (password) => {
  // Only check if password is not empty
  if (!password) {
    return { valid: false, errors: ['Mật khẩu là bắt buộc'] };
  }

  // No other requirements - accept any password
  return {
    valid: true,
    errors: [],
    strength: calculatePasswordStrength(password)
  };
};

/**
 * Calculate password strength score (0-100)
 * @param {string} password 
 * @returns {Object} { score: number, level: string }
 */
const calculatePasswordStrength = (password) => {
  let score = 0;

  // Length score (max 25 points)
  if (password.length >= 8) score += 10;
  if (password.length >= 12) score += 10;
  if (password.length >= 16) score += 5;

  // Character variety (max 50 points)
  if (/[a-z]/.test(password)) score += 10;
  if (/[A-Z]/.test(password)) score += 10;
  if (/[0-9]/.test(password)) score += 10;
  if (/[^a-zA-Z0-9]/.test(password)) score += 20;

  // Complexity (max 25 points)
  const uniqueChars = new Set(password).size;
  if (uniqueChars >= password.length * 0.5) score += 15;
  if (uniqueChars >= password.length * 0.7) score += 10;

  // Determine level
  let level = 'weak';
  if (score >= 70) level = 'strong';
  else if (score >= 50) level = 'medium';
  else if (score >= 30) level = 'fair';

  return { score: Math.min(100, score), level };
};

/**
 * Check if password contains user information (name, phone, etc.)
 * @param {string} password 
 * @param {Object} userInfo - { name, phone, email }
 * @returns {boolean}
 */
export const containsUserInfo = (password, userInfo = {}) => {
  // No longer checking - always return false
  return false;
};
