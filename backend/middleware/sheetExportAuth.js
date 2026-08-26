import crypto from 'crypto';

const API_KEY_HEADER = 'x-api-key';

// So sánh timing-safe: !== so từng byte và dừng ngay khi lệch, lộ thời gian
// phản hồi tỉ lệ với số ký tự khớp đúng ở đầu chuỗi — đủ để dò dần key qua
// nhiều lần thử (timing side-channel), dù khó khai thác qua mạng thật.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Vẫn chạy timingSafeEqual trên 2 buffer cùng độ dài để không lộ luôn độ
    // dài qua nhánh rẽ sớm (so bufA với chính nó khi độ dài lệch)
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export const authenticateSheetExportKey = (req, res, next) => {
  const configuredKey = process.env.SHEETS_EXPORT_API_KEY;

  if (!configuredKey) {
    return res.status(503).json({
      success: false,
      message: 'Sheet export API key is not configured'
    });
  }

  const providedKey = req.get(API_KEY_HEADER);

  if (!providedKey || !safeEqual(providedKey, configuredKey)) {
    return res.status(401).json({
      success: false,
      message: 'Invalid sheet export API key'
    });
  }

  next();
};
