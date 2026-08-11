const API_KEY_HEADER = 'x-api-key';

export const authenticateSheetExportKey = (req, res, next) => {
  const configuredKey = process.env.SHEETS_EXPORT_API_KEY;

  if (!configuredKey) {
    return res.status(503).json({
      success: false,
      message: 'Sheet export API key is not configured'
    });
  }

  const providedKey = req.get(API_KEY_HEADER);

  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({
      success: false,
      message: 'Invalid sheet export API key'
    });
  }

  next();
};
