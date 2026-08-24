import { useEffect, useState } from 'react';
import api from '../utils/api';

/**
 * Modal kết nối Zalo cho MỘT cửa hàng — chỉ dùng ở trang admin
 * (Cửa hàng & Nhân sự). Mọi API đều truyền store_id.
 *
 * Props:
 * - store: { id, name }
 * - onClose: () => void
 */
function ZaloConnectModal({ store, onClose }) {
  const [status, setStatus] = useState({ status: 'loading' });
  const [qr, setQr] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = async () => {
    try {
      const response = await api.get(`/zalo/status?store_id=${store.id}`);
      setStatus(response.data.data || { status: 'not_logged_in' });
      setError('');
    } catch (err) {
      setStatus({ status: 'error' });
      setError(err.response?.data?.error || 'Không tải được trạng thái Zalo');
    }
  };

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.id]);

  // Chỉ poll trạng thái khi đang chờ quét QR — đã logged_in/error thì dừng,
  // tránh bắn ~20 request/phút vô ích nếu modal để mở
  useEffect(() => {
    if (status.status !== 'pending_qr') return undefined;
    const interval = setInterval(loadStatus, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.status, store.id]);

  useEffect(() => {
    if (status.status !== 'pending_qr') return undefined;

    let cancelled = false;
    const loadQr = async () => {
      try {
        const response = await api.get(`/zalo/qr?store_id=${store.id}`);
        if (!cancelled) {
          setQr(response.data.data?.qrDataUrl || '');
          setError('');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.error || 'QR chưa sẵn sàng');
        }
      }
    };

    loadQr();
    const interval = setInterval(loadQr, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.status, store.id]);

  const handleStartLogin = async () => {
    try {
      setLoading(true);
      setQr('');
      const response = await api.post('/zalo/login', { store_id: store.id });
      setStatus(response.data.data || { status: 'pending_qr' });
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Không thể bắt đầu đăng nhập Zalo');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    if (!confirm(`Đăng xuất Zalo của cửa hàng "${store.name}"?`)) return;
    try {
      setLoading(true);
      await api.post('/zalo/logout', { store_id: store.id });
      setStatus({ status: 'not_logged_in' });
      setQr('');
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Đăng xuất Zalo thất bại');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Kết nối Zalo — {store.name}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Mỗi cửa hàng dùng một phiên Zalo riêng.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full text-gray-500 hover:bg-gray-100 text-xl leading-none"
            aria-label="Đóng"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-4">
          {status.status === 'logged_in' ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <div className="text-sm text-emerald-900 font-semibold">✓ Đã kết nối Zalo</div>
              <div className="text-sm text-emerald-800 mt-1">
                Tên Zalo: <span className="font-semibold">{status.zaloName || 'Không xác định'}</span>
              </div>
              {status.lastLoginAt && (
                <div className="text-xs text-emerald-700 mt-1">Lần đăng nhập: {status.lastLoginAt}</div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {status.status === 'pending_qr'
                  ? 'Quét mã QR bên dưới bằng ứng dụng Zalo của cửa hàng để kết nối.'
                  : 'Cửa hàng chưa đăng nhập Zalo. Bấm Login Zalo để tạo mã QR.'}
              </div>

              {status.status === 'pending_qr' && (
                <div className="flex justify-center">
                  {qr ? (
                    <img
                      src={qr}
                      alt="QR đăng nhập Zalo"
                      className="w-64 h-64 object-contain border rounded-lg bg-white"
                    />
                  ) : (
                    <div className="w-64 h-64 border rounded-lg bg-gray-50 flex items-center justify-center text-sm text-gray-500">
                      Đang tải QR...
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t bg-gray-50 flex items-center justify-end gap-2">
          {status.status === 'logged_in' ? (
            <button
              type="button"
              onClick={handleLogout}
              disabled={loading}
              className="px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-sm font-medium disabled:opacity-60"
            >
              Đăng xuất Zalo
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStartLogin}
              disabled={loading || status.status === 'pending_qr'}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium disabled:opacity-60"
            >
              {status.status === 'pending_qr' ? 'Đang chờ quét QR' : 'Login Zalo'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-gray-200 text-gray-800 hover:bg-gray-300 text-sm font-medium"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

export default ZaloConnectModal;
