import { useEffect, useState } from 'react';
import api from '../utils/api';
import { formatLocalDate } from '../utils/dateTime';

// Khung "Báo cáo ca làm việc" mở BÊN CẠNH bảng báo cáo (không che màn hình) —
// dữ liệu từ GET /reports/shift-detail/:id. Bấm dòng khác thì khung cập nhật.
const money = (n) => `${new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0))}đ`;

function Row({ label, value, bold }) {
  return (
    <div className={`flex justify-between gap-3 py-1 text-sm ${bold ? 'font-bold text-gray-900' : 'text-gray-700'}`}>
      <span>{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="border-t border-dashed border-gray-300 pt-3 mt-3">
      <h3 className="text-sm font-semibold text-green-700 mb-1">{title}</h3>
      {children}
    </div>
  );
}

function ShiftReportPanel({ timesheetId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api.get(`/reports/shift-detail/${timesheetId}`)
      .then((res) => { if (!cancelled) setData(res.data.data); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || 'Không tải được báo cáo ca'); });
    return () => { cancelled = true; };
  }, [timesheetId]);

  const shift = data?.shift;
  const drawer = data?.drawer;
  const revenue = data?.revenue;
  const hours = shift ? Math.round((shift.regular_hours + shift.overtime_hours) * 100) / 100 : 0;

  return (
    <aside className="bg-white rounded-xl shadow-lg border border-gray-200 p-5 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
      <div className="flex items-start justify-between mb-3">
        <h2 className="flex-1 text-center text-base font-bold text-gray-900">BÁO CÁO CA LÀM VIỆC</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="Đóng">×</button>
      </div>

      {error && <p className="text-sm text-red-600 text-center py-6">{error}</p>}
      {!error && !data && <p className="text-sm text-gray-500 text-center py-6">Đang tải...</p>}

      {shift && (
        <>
          <Row label="Ca làm việc số" value={shift.id} />
          <Row label="Cửa hàng" value={shift.store_name || '-'} />
          <Row label="Nhân viên" value={shift.employee_name} />
          <Row
            label="Vai trò"
            value={shift.role === 'opened' ? 'Mở ca & giữ két' : `Vào thêm (két do ${shift.joined_drawer_of} giữ)`}
          />
          <Row label="Bắt đầu ca" value={formatLocalDate(shift.check_in, 'dd/MM/yyyy HH:mm')} />
          <Row
            label="Kết ca"
            value={shift.is_open
              ? <span className="text-emerald-700 font-medium">Đang trong ca</span>
              : shift.auto_closed
                ? <span className="text-red-600">Tự đóng (quên check-out)</span>
                : formatLocalDate(shift.check_out, 'dd/MM/yyyy HH:mm')}
          />
          {!shift.is_open && <Row label="Giờ công" value={`${hours}h`} />}

          <Section title="Ngăn kéo đựng tiền">
            {!drawer.has_activity ? (
              <>
                <p className="text-sm text-gray-600 py-1">
                  {shift.role === 'joined'
                    ? `Ca vào thêm — không giữ két. Tiền mặt nằm trong két của ${shift.joined_drawer_of}.`
                    : 'Không có giao dịch két trong ca này.'}
                </p>
                {drawer.counted > 0 && (
                  <Row label="Số tiền nhập khi check-out" value={money(drawer.counted)} />
                )}
              </>
            ) : (
              <>
                {drawer.opening_float > 0 && <Row label="Tiền quỹ đầu ca" value={money(drawer.opening_float)} />}
                {drawer.received_handover > 0 && (
                  <Row label={`Nhận bàn giao từ ${drawer.received_from}`} value={money(drawer.received_handover)} />
                )}
                <Row label="Thanh toán bằng tiền mặt" value={money(drawer.cash_payment)} />
                <Row label="Đã nạp tiền" value={money(drawer.cash_in)} />
                <Row label="Đã chi tiền" value={money(drawer.cash_out)} />
                {drawer.withdrawn_at_checkout > 0 && <Row label="Rút khi kết ca" value={money(drawer.withdrawn_at_checkout)} />}
                <Row label="Số tiền mặt dự kiến" value={money(drawer.expected)} />
                <Row
                  label="Số tiền mặt thực tế"
                  value={drawer.counted != null ? money(drawer.counted) : (shift.is_open ? 'Chưa kết ca' : 'Chưa đếm')}
                />
                <Row
                  label="Chênh lệch"
                  bold
                  value={drawer.difference != null
                    ? <span className={drawer.difference < 0 ? 'text-red-600' : drawer.difference > 0 ? 'text-blue-600' : ''}>{money(drawer.difference)}</span>
                    : '—'}
                />
                {drawer.shortage_reimbursement > 0 && <Row label="Nhân viên bù thiếu" value={money(drawer.shortage_reimbursement)} />}
                {drawer.handed_to && <Row label={`Bàn giao cho ${drawer.handed_to}`} value={money(drawer.handed_amount)} />}
              </>
            )}
          </Section>

          <Section title="Báo cáo tổng hợp">
            <Row label="Tổng doanh thu" value={money(revenue.total)} bold />
            <Row label="Tiền mặt" value={money(revenue.cash)} />
            <Row label="Chuyển khoản" value={money(revenue.transfer)} />
            {revenue.debt_collected > 0 && <Row label="Trong đó thu nợ" value={money(revenue.debt_collected)} />}
            <Row label="Số đơn thanh toán" value={revenue.order_count} />
            {revenue.recorded_at_close != null && Math.abs(revenue.recorded_at_close - revenue.total) >= 1 && (
              <p className="text-xs text-amber-700 mt-1">
                Doanh thu ghi lúc kết ca: {money(revenue.recorded_at_close)} (khác số trên do có khoản thu ghi nhận sau giờ ra đã nhập).
              </p>
            )}
          </Section>

          {shift.note && (
            <Section title="Ghi chú">
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{shift.note}</p>
            </Section>
          )}
        </>
      )}
    </aside>
  );
}

export default ShiftReportPanel;
