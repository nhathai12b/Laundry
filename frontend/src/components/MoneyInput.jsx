/**
 * Ô nhập tiền VND: tự chèn dấu chấm ngăn cách hàng nghìn khi gõ
 * (15000 → 15.000) và hiển thị hậu tố "VND" trong ô.
 *
 * - `value`: chuỗi/số thô (VD '15000') — component tự format khi hiển thị
 * - `onChange(raw)`: trả về chuỗi CHỈ GỒM CHỮ SỐ (VD '15000') để parseFloat
 *   phía ngoài hoạt động y như input number cũ
 */
function MoneyInput({ value, onChange, className = '', placeholder = '0', required, disabled, autoFocus, id }) {
  // Giá trị từ DB (DECIMAL) tới dưới dạng chuỗi "25000.00" — PHẢI parse số
  // trước, tuyệt đối không strip ký tự thô: replace(/\D/g,'') trên "25000.00"
  // ra "2500000" → hiển thị và LƯU lương gấp 100 lần.
  const toDigits = (v) => {
    if (v === null || v === undefined || v === '') return '';
    const str = String(v);
    if (str.includes('.') || str.includes(',')) {
      const num = Number.parseFloat(str.replace(',', '.'));
      if (Number.isFinite(num)) return String(Math.round(num));
    }
    return str.replace(/\D/g, '');
  };

  const formatDisplay = (v) => {
    const digits = toDigits(v);
    if (!digits) return '';
    return new Intl.NumberFormat('vi-VN').format(parseInt(digits, 10));
  };

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={formatDisplay(value)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        className={`${className} pr-14`}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs font-semibold pointer-events-none select-none">
        VND
      </span>
    </div>
  );
}

export default MoneyInput;
