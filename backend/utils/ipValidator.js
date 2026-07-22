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
  const octets = [];
  for (const part of parts) {
    const num = parseInt(part);
    if (isNaN(num) || num < 0 || num > 255) {
      return { valid: false, error: 'Mỗi phần của IP phải từ 0 đến 255' };
    }
    octets.push(num);
  }

  // Block ranges that would make the server (not the user's browser) send
  // arbitrary bytes to itself or to cloud metadata endpoints (SSRF) via the
  // "server" print method, which opens a raw TCP connection to this IP.
  // Regular LAN printer ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x) are
  // still allowed.
  const isLoopback = octets[0] === 127;
  const isLinkLocal = octets[0] === 169 && octets[1] === 254; // covers cloud metadata (169.254.169.254)
  const isUnspecified = octets.every((o) => o === 0);
  if (isLoopback || isLinkLocal || isUnspecified) {
    return { valid: false, error: 'IP này không được phép sử dụng cho máy in' };
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

  // parseInt would silently accept trailing garbage like "8080abc" as 8080;
  // require the whole (trimmed) value to be a plain integer.
  const trimmed = String(port).trim();
  if (!/^\d+$/.test(trimmed)) {
    return { valid: false, value: null, error: 'Port phải là số' };
  }

  const portNum = Number(trimmed);
  
  if (portNum < 1 || portNum > 65535) {
    return { valid: false, value: portNum, error: 'Port phải từ 1 đến 65535' };
  }

  return { valid: true, value: portNum, error: null };
};
