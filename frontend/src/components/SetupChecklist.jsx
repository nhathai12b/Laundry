import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../utils/api';
import { isAdmin, isRoot } from '../utils/auth';

/**
 * Onboarding checklist cho admin mới: hiển thị các bước thiết lập bắt buộc
 * (cửa hàng → sản phẩm → nhân viên) cho tới khi hoàn tất cả 3 bước.
 * Tự ẩn khi setup đã đầy đủ hoặc với root admin.
 */
function SetupChecklist() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!isAdmin() || isRoot()) return;
    let cancelled = false;
    api.get('/stores/setup-status')
      .then((res) => {
        if (!cancelled) setStatus(res.data.data);
      })
      .catch(() => {
        // Không chặn dashboard nếu endpoint lỗi — chỉ ẩn checklist
      });
    return () => { cancelled = true; };
  }, []);

  if (!status || status.complete) return null;

  const steps = [
    {
      done: status.storeCount > 0,
      title: 'Tạo cửa hàng',
      description: 'Tạo cửa hàng đầu tiên kèm tài khoản đăng nhập cho cửa hàng',
      link: '/admin/stores',
      action: 'Tạo cửa hàng',
    },
    {
      done: status.productCount > 0,
      title: 'Thêm sản phẩm / dịch vụ',
      description: 'Thêm các dịch vụ giặt sấy và giá để có thể tạo đơn hàng',
      link: '/admin/products',
      action: 'Thêm sản phẩm',
    },
    {
      done: status.employeeCount > 0,
      title: 'Thêm nhân viên',
      description: 'Thêm nhân viên để chấm công và ghi nhận ca làm việc (tab "Nhân viên")',
      link: '/admin/users',
      action: 'Thêm nhân viên',
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-blue-900">
            Thiết lập ban đầu ({doneCount}/{steps.length})
          </h2>
          <p className="text-sm text-blue-700">
            Hoàn tất các bước dưới đây để bắt đầu nhận đơn hàng. Bảng này sẽ tự ẩn khi xong.
          </p>
        </div>
      </div>
      <div className="space-y-3">
        {steps.map((step, index) => (
          <div
            key={step.title}
            className={`flex items-center gap-4 rounded-lg border p-4 ${
              step.done ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'
            }`}
          >
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                step.done ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {step.done ? '✓' : index + 1}
            </div>
            <div className="flex-1 min-w-0">
              <p className={`font-semibold ${step.done ? 'text-green-800 line-through' : 'text-gray-900'}`}>
                {step.title}
              </p>
              <p className="text-sm text-gray-600">{step.description}</p>
            </div>
            {!step.done && (
              <Link
                to={step.link}
                className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                {step.action}
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default SetupChecklist;
