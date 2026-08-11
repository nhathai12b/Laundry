/**
 * Input validation utilities
 * Centralized validation functions for common input types
 */

/**
 * Validate phone number (Vietnamese format: 10-11 digits, may start with 0 or +84)
 * @param {string} phone - Phone number to validate
 * @returns {boolean} - True if valid
 */
export const isValidPhone = (phone) => {
  if (!phone || typeof phone !== 'string') return false;
  const trimmed = phone.trim();
  // Vietnamese phone: 10-11 digits, may start with 0, +84, or 84
  const phoneRegex = /^(\+84|84|0)[1-9][0-9]{8,9}$/;
  return phoneRegex.test(trimmed.replace(/\s+/g, ''));
};

/**
 * Validate positive number
 * @param {any} value - Value to validate
 * @param {boolean} allowZero - Whether to allow zero (default: false)
 * @returns {object} - { valid: boolean, value: number, error: string }
 */
export const validatePositiveNumber = (value, allowZero = false) => {
  if (value === null || value === undefined || value === '') {
    return { valid: false, value: null, error: 'Giá trị không được để trống' };
  }
  
  const num = parseFloat(value);
  
  if (isNaN(num) || !isFinite(num)) {
    return { valid: false, value: null, error: 'Giá trị phải là số hợp lệ' };
  }
  
  if (allowZero && num < 0) {
    return { valid: false, value: num, error: 'Giá trị không được là số âm' };
  }
  
  if (!allowZero && num <= 0) {
    return { valid: false, value: num, error: 'Giá trị phải là số dương' };
  }
  
  return { valid: true, value: num, error: null };
};

/**
 * Validate positive integer
 * @param {any} value - Value to validate
 * @param {boolean} allowZero - Whether to allow zero (default: false)
 * @returns {object} - { valid: boolean, value: number, error: string }
 */
export const validatePositiveInteger = (value, allowZero = false) => {
  const result = validatePositiveNumber(value, allowZero);
  if (!result.valid) return result;
  
  if (!Number.isInteger(result.value)) {
    return { valid: false, value: result.value, error: 'Giá trị phải là số nguyên' };
  }
  
  return result;
};

/**
 * Validate integer ID
 * @param {any} id - ID to validate
 * @returns {object} - { valid: boolean, value: number, error: string }
 */
export const validateId = (id) => {
  if (id === null || id === undefined || id === '') {
    return { valid: false, value: null, error: 'ID không được để trống' };
  }
  
  const num = parseInt(id);
  
  if (isNaN(num) || num <= 0) {
    return { valid: false, value: null, error: 'ID không hợp lệ' };
  }
  
  return { valid: true, value: num, error: null };
};

/**
 * Sanitize string input (trim and validate)
 * @param {any} value - Value to sanitize
 * @param {number} maxLength - Maximum length (optional)
 * @returns {object} - { valid: boolean, value: string, error: string }
 */
export const sanitizeString = (value, maxLength = null) => {
  if (value === null || value === undefined) {
    return { valid: true, value: '', error: null };
  }
  
  if (typeof value !== 'string') {
    return { valid: false, value: String(value), error: 'Giá trị phải là chuỗi' };
  }
  
  const trimmed = value.trim();
  
  if (maxLength && trimmed.length > maxLength) {
    return { valid: false, value: trimmed, error: `Độ dài không được vượt quá ${maxLength} ký tự` };
  }
  
  return { valid: true, value: trimmed, error: null };
};

/**
 * Validate required string
 * @param {any} value - Value to validate
 * @param {string} fieldName - Field name for error message
 * @returns {object} - { valid: boolean, value: string, error: string }
 */
export const validateRequiredString = (value, fieldName = 'Trường này') => {
  const sanitized = sanitizeString(value);
  if (!sanitized.valid) return sanitized;
  
  if (sanitized.value === '') {
    return { valid: false, value: '', error: `${fieldName} là bắt buộc` };
  }
  
  return sanitized;
};

/**
 * Validate enum value
 * @param {any} value - Value to validate
 * @param {array} allowedValues - Array of allowed values
 * @param {string} fieldName - Field name for error message
 * @returns {object} - { valid: boolean, value: any, error: string }
 */
export const validateEnum = (value, allowedValues, fieldName = 'Giá trị') => {
  if (value === null || value === undefined || value === '') {
    return { valid: false, value: null, error: `${fieldName} là bắt buộc` };
  }
  
  if (!allowedValues.includes(value)) {
    return { valid: false, value, error: `${fieldName} phải là một trong: ${allowedValues.join(', ')}` };
  }
  
  return { valid: true, value, error: null };
};

/**
 * Validate date range
 * @param {Date|string} startDate - Start date
 * @param {Date|string} endDate - End date
 * @returns {object} - { valid: boolean, error: string }
 */
export const validateDateRange = (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (isNaN(start.getTime())) {
    return { valid: false, error: 'Ngày bắt đầu không hợp lệ' };
  }
  
  if (isNaN(end.getTime())) {
    return { valid: false, error: 'Ngày kết thúc không hợp lệ' };
  }
  
  if (start >= end) {
    return { valid: false, error: 'Ngày kết thúc phải sau ngày bắt đầu' };
  }
  
  return { valid: true, error: null };
};
