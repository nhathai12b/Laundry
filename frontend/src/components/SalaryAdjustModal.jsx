import { useEffect, useState } from 'react';
import api from '../utils/api';
import { format } from 'date-fns';
import MoneyInput from './MoneyInput';

const formatMoney = (value) => `${new Intl.NumberFormat('vi-VN').format(parseFloat(value) || 0)} đ`;

/**
 * Modal xem lương tháng + cộng/trừ tiền (thưởng/phạt) cho một nhân viên.
 * Dùng chung cho trang Chấm công (bảng lương), Cửa hàng & Nhân sự, Quản lý nhân viên.
 *
 * Props:
 * - employee: { id, name } — nhân viên cần thao tác (bắt buộc)
 * - onClose: () => void
 * - onChanged: () => void — gọi sau khi thêm/xóa khoản điều chỉnh (để reload bảng lương bên ngoài)
 */
function SalaryAdjustModal({ employee, onClose, onChanged }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [adjType, setAdjType] = useState('add'); // 'add' | 'subtract'
  const [adjAmount, setAdjAmount] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [adjDate, setAdjDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [saving, setSaving] = useState(false);

  const loadSummary = async (m = month, y = year) => {
    if (!employee?.id) return;
    setLoading(true);
    try {
      const response = await api.get(
        `/salary/summary/${employee.id}?month=${m}&year=${y}&timezone_offset_minutes=${new Date().getTimezoneOffset()}`
      );
      setSummary(response.data.data || null);
    } catch (error) {
      console.error('Error loading salary summary:', error);
      setSummary(null);
      alert(error.response?.data?.error || 'Không tải được lương');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee?.id]);

  const changeMonth = (m, y) => {
    setMonth(m);
    setYear(y);
    loadSummary(m, y);
  };

  const handleAddAdjustment = async (e) => {
    e.preventDefault();
    const amountValue = parseFloat(adjAmount);
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      alert('Vui lòng nhập số tiền lớn hơn 0');
      return;
    }
    setSaving(true);
    try {
      await api.post('/salary/adjustments', {
        employee_id: employee.id,
        amount: adjType === 'subtract' ? -amountValue : amountValue,
        reason: adjReason,
        adjust_date: adjDate,
      });
      setAdjAmount('');
      setAdjReason('');
      loadSummary();
      onChanged?.();
    } catch (error) {
      alert(error.response?.data?.error || 'Lưu thất bại');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAdjustment = async (id) => {
    if (!confirm('Xóa khoản điều chỉnh này?')) return;
    try {
      await api.delete(`/salary/adjustments/${id}`);
      loadSummary();
      onChanged?.();
    } catch (error) {
      alert(error.response?.data?.error || 'Xóa thất bại');
    }
  };

  if (!employee) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
      <div className="bg-white rounded-lg max-w-lg w-full my-auto max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-900">💰 Lương — {employee.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <select
                value={month}
                onChange={(e) => changeMonth(parseInt(e.target.value), year)}
                className="px-2 py-1 border rounded text-sm"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>Tháng {i + 1}</option>
                ))}
              </select>
              <select
                value={year}
                onChange={(e) => changeMonth(month, parseInt(e.target.value))}
                className="px-2 py-1 border rounded text-sm"
              >
                {Array.from({ length: 3 }, (_, i) => {
                  const y = new Date().getFullYear() - 1 + i;
                  return <option key={y} value={y}>{y}</option>;
                })}
              </select>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-xl w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading ? (
            <div className="text-center py-6 text-gray-500">Đang tải...</div>
          ) : summary ? (
            <>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <div className="grid grid-cols-2 gap-2 text-sm text-emerald-900">
                  <div>Số ca: <strong>{summary.total_shifts}</strong></div>
                  <div>Tổng giờ: <strong>{Number(summary.total_hours || 0).toFixed(1)}h</strong></div>
                  <div>Lương công: <strong>{formatMoney(summary.work_salary)}</strong></div>
                  <div>🎁 Hoa hồng: <strong className="text-amber-700">+{formatMoney(summary.total_commission || 0)}</strong></div>
                  <div className="col-span-2">Thưởng/Phạt: <strong className={summary.total_adjustments < 0 ? 'text-red-600' : 'text-green-700'}>
                    {summary.total_adjustments >= 0 ? '+' : ''}{formatMoney(summary.total_adjustments)}
                  </strong></div>
                </div>
                <div className="mt-2 pt-2 border-t border-emerald-300 flex justify-between items-center">
                  <span className="font-semibold text-emerald-900">Tổng lương tháng:</span>
                  <span className="text-xl font-bold text-emerald-700">{formatMoney(summary.total_salary)}</span>
                </div>
              </div>

              {/* Form cộng/trừ tiền */}
              <form onSubmit={handleAddAdjustment} className="rounded-lg border border-gray-200 p-3 space-y-2">
                <div className="text-sm font-semibold text-gray-800">Thưởng / Phạt</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAdjType('add')}
                    className={`flex-1 py-2 rounded-lg text-sm font-semibold border ${adjType === 'add' ? 'bg-green-600 text-white border-green-600' : 'bg-white text-green-700 border-green-300'}`}
                  >
                    + Thưởng (cộng tiền)
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdjType('subtract')}
                    className={`flex-1 py-2 rounded-lg text-sm font-semibold border ${adjType === 'subtract' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-300'}`}
                  >
                    − Phạt (trừ tiền)
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <MoneyInput
                    value={adjAmount}
                    onChange={setAdjAmount}
                    className="w-full px-3 py-2 border rounded-lg text-base"
                    placeholder="VD: 15.000"
                    required
                  />
                  <input
                    type="date"
                    value={adjDate}
                    onChange={(e) => setAdjDate(e.target.value)}
                    className="px-3 py-2 border rounded-lg text-base"
                    required
                  />
                </div>
                <input
                  type="text"
                  value={adjReason}
                  onChange={(e) => setAdjReason(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-base"
                  placeholder="Lý do (thưởng chuyên cần, phạt đi trễ, ứng lương...)"
                />
                <button
                  type="submit"
                  disabled={saving}
                  className={`w-full py-2 rounded-lg text-white font-semibold text-sm disabled:opacity-50 ${adjType === 'subtract' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
                >
                  {saving ? 'Đang lưu...' : (adjType === 'subtract' ? '− Trừ tiền' : '+ Cộng tiền')}
                </button>
              </form>

              {/* Danh sách điều chỉnh trong tháng */}
              <div>
                <div className="text-sm font-semibold text-gray-800 mb-2">
                  Điều chỉnh trong tháng ({summary.adjustments.length})
                </div>
                {summary.adjustments.length === 0 ? (
                  <div className="text-sm text-gray-500">Chưa có khoản nào</div>
                ) : (
                  <div className="space-y-1.5">
                    {summary.adjustments.map((adj) => (
                      <div key={adj.id} className="flex items-center justify-between gap-2 border rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <div className={`font-semibold text-sm ${adj.amount < 0 ? 'text-red-600' : 'text-green-700'}`}>
                            {adj.amount >= 0 ? '+' : ''}{formatMoney(adj.amount)}
                          </div>
                          <div className="text-xs text-gray-600 truncate">
                            {String(adj.adjust_date).slice(0, 10)}{adj.reason ? ` — ${adj.reason}` : ''}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteAdjustment(adj.id)}
                          className="text-xs text-red-500 hover:text-red-700 flex-shrink-0"
                        >
                          Xóa
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-center py-6 text-gray-500">Không tải được dữ liệu lương</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SalaryAdjustModal;
