/**
 * IP address validation utilities
 */

/**
 * Validate IP address format (IPv4)
 * @param {string} ip - IP address to validate
 * @returns {object} - { valid: boolean, error: string }
 */
export const isValidIP = (ip) => {
  if (!ip || typeof ip !== 'string') {
    return { valid: false, error: 'IP không được để trống' };
  }

  const trimmed = ip.trim();
  
  // Basic IPv4 regex
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(trimmed)) {
    return { valid: false, error: 'IP không đúng định dạng (ví dụ: 192.168.1.100)' };
  }

  // Validate each octet is 0-255
  const parts = trimmed.split('.');
  for (const part of parts) {
    const num = parseInt(part);
    if (isNaN(num) || num < 0 || num > 255) {
      return { valid: false, error: 'Mỗi phần của IP phải từ 0 đến 255' };
    }
  }

  return { valid: true, error: null };
};

/**
 * Validate port number
 * @param {any} port - Port to validate
 * @returns {object} - { valid: boolean, value: number, error: string }
 */
export const isValidPort = (port) => {
  if (port === null || port === undefined || port === '') {
    return { valid: false, value: null, error: 'Port không được để trống' };
  }

  const portNum = parseInt(port);
  
  if (isNaN(portNum)) {
    return { valid: false, value: null, error: 'Port phải là số' };
  }

  if (portNum < 1 || portNum > 65535) {
    return { valid: false, value: portNum, error: 'Port phải từ 1 đến 65535' };
  }

  return { valid: true, value: portNum, error: null };
};
