const CANONICAL_VN_MOBILE = /^0\d{9}$/;

export function normalizeVietnamesePhone(raw) {
  if (typeof raw !== 'string') return null;

  let value = raw.trim();
  if (!value) return null;

  const hadPlus = value.startsWith('+');
  let digits = value.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus && digits.startsWith('84')) {
    digits = `0${digits.slice(2)}`;
  } else if (digits.startsWith('0084')) {
    digits = `0${digits.slice(4)}`;
  } else if (digits.startsWith('84') && digits.length === 11) {
    digits = `0${digits.slice(2)}`;
  }

  return CANONICAL_VN_MOBILE.test(digits) ? digits : null;
}
