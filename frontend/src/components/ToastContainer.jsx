import { useEffect, useState } from 'react';

/**
 * Hiển thị toast từ showToast() (utils/toast.js). Mount đúng 1 lần trong App.
 * Không chặn thao tác như alert(); tự biến mất sau vài giây; bấm để đóng sớm.
 */

const TYPE_STYLES = {
  success: { bg: '#059669', icon: '✓' },
  error: { bg: '#dc2626', icon: '✕' },
  info: { bg: '#2563eb', icon: 'ℹ' },
};

const AUTO_DISMISS_MS = 3500;

// Tin dài (vd giải thích "chuyển sang Ngừng hoạt động...") cần thời gian đọc —
// cộng thêm theo độ dài, tối đa 10s; bấm vào toast vẫn đóng được ngay
const dismissDelayFor = (message) =>
  Math.min(AUTO_DISMISS_MS + Math.max(0, String(message || '').length - 60) * 35, 10000);

let nextId = 1;

function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const onToast = (e) => {
      const id = nextId++;
      const { message, type } = e.detail || {};
      setToasts((prev) => [...prev.slice(-3), { id, message, type: TYPE_STYLES[type] ? type : 'info' }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, dismissDelayFor(message));
    };
    window.addEventListener('app-toast', onToast);
    return () => window.removeEventListener('app-toast', onToast);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 'min(92vw, 420px)',
        pointerEvents: 'none',
      }}
    >
      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateY(-12px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      {toasts.map((t) => {
        const style = TYPE_STYLES[t.type];
        return (
          <div
            key={t.id}
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            style={{
              pointerEvents: 'auto',
              cursor: 'pointer',
              background: style.bg,
              color: '#fff',
              padding: '10px 14px',
              borderRadius: 12,
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.45,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              animation: 'toast-in 0.22s cubic-bezier(0.21, 1.02, 0.73, 1)',
              wordBreak: 'break-word',
            }}
          >
            <span aria-hidden="true" style={{ flexShrink: 0 }}>{style.icon}</span>
            <span>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

export default ToastContainer;
