import { useEffect, useState } from 'react';
import api from '../../utils/api';
import { isAdmin, isRoot } from '../../utils/auth';
import { getSavedFilters, saveFilters } from '../../utils/filterStorage';

function Reports() {
  const savedFilters = getSavedFilters();
  const validReportTypes = ['product', 'category', 'shift', 'daily'];
  
  // Initialize reportType - check if there's a saved one in localStorage, otherwise default to 'product'
  const getInitialReportType = () => {
    try {
      const saved = localStorage.getItem('laundry66_reportType');
      if (saved && validReportTypes.includes(saved)) {
        return saved;
      }
    } catch (error) {
      console.error('Error loading saved reportType:', error);
    }
    return 'product';
  };
  
  const [reportType, setReportType] = useState(getInitialReportType);
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(savedFilters.selectedStoreId || 'all');
  const [selectedMonth, setSelectedMonth] = useState(savedFilters.selectedMonth || new Date().getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(savedFilters.selectedYear || new Date().getFullYear());
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dailySummary, setDailySummary] = useState(null); // For daily revenue summary
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0
  });
  const [pageSize, setPageSize] = useState(20);

  // Ensure reportType is always valid
  useEffect(() => {
    if (!validReportTypes.includes(reportType)) {
      setReportType('product');
    }
  }, [reportType]);

  useEffect(() => {
    if (isAdmin()) {
      loadStores();
    }
  }, []);

  useEffect(() => {
    // Root không xem báo cáo theo cửa hàng; chỉ load khi admin/employer
    if (isRoot()) return;
    if (validReportTypes.includes(reportType)) {
      loadData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportType, selectedMonth, selectedYear, pagination.page, pageSize, selectedStoreId]);

  // Save filters whenever they change
  useEffect(() => {
    if (isAdmin()) {
      saveFilters(selectedStoreId, selectedMonth, selectedYear);
    }
  }, [selectedStoreId, selectedMonth, selectedYear]);

  const loadStores = async () => {
    try {
      const response = await api.get('/stores');
      setStores(response.data.data || []);
    } catch (error) {
      console.error('Error loading stores:', error);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      const month = selectedMonth || new Date().getMonth() + 1;
      const year = selectedYear || new Date().getFullYear();
      params.append('month', month);
      params.append('year', year);
      
      // Only add pagination for non-daily reports
      if (reportType !== 'daily') {
        params.append('page', pagination.page);
        params.append('limit', pageSize);
      }
      
      if (isAdmin() && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }

      let endpoint = '';
      switch (reportType) {
        case 'product':
          endpoint = '/reports/revenue-by-product-daily';
          break;
        case 'category':
          endpoint = '/reports/revenue-by-category-daily';
          break;
        case 'shift':
          endpoint = '/reports/revenue-by-shift-daily';
          break;
        case 'daily':
          endpoint = '/reports/revenue-daily';
          break;
        default:
          endpoint = '/reports/revenue-by-product-daily';
      }

      const response = await api.get(`${endpoint}?${params.toString()}`);
      
      // Handle daily revenue report (no pagination)
      if (reportType === 'daily') {
        setData(response.data.data || []);
        setDailySummary(response.data.summary || null);
        setPagination({
          page: 1,
          limit: response.data.days_in_month || 31,
          total: response.data.days_in_month || 31,
          totalPages: 1
        });
      } else {
        setData(response.data.data || []);
        setDailySummary(null);
        setPagination(response.data.pagination || {
          page: 1,
          limit: pageSize,
          total: 0,
          totalPages: 0
        });
      }
    } catch (error) {
      console.error('Error loading report data:', error);
      const errorMessage = error.response?.data?.error || error.message || 'Không thể tải dữ liệu báo cáo';
      alert(`Lỗi: ${errorMessage}`);
      setData([]);
      setPagination({
        page: 1,
        limit: pageSize,
        total: 0,
        totalPages: 0
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePageChange = (newPage) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const handlePageSizeChange = (newSize) => {
    setPageSize(parseInt(newSize));
    setPagination(prev => ({ ...prev, page: 1, limit: parseInt(newSize) }));
  };

  const getReportTitle = () => {
    const titles = {
      product: 'Doanh thu theo mặt hàng',
      category: 'Doanh thu theo danh mục',
      shift: 'Doanh thu theo ca',
      daily: 'Doanh thu từng ngày trong tháng'
    };
    return titles[reportType] || 'Báo cáo';
  };

  const handleExportExcel = async () => {
    try {
      const params = new URLSearchParams();
      params.append('type', reportType);
      params.append('month', selectedMonth);
      params.append('year', selectedYear);
      
      if (isAdmin() && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }

      const response = await api.get(`/reports/export?${params.toString()}`, {
        responseType: 'blob'
      });

      // Create blob and download
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      // Get filename from Content-Disposition header or use default
      const contentDisposition = response.headers['content-disposition'];
      let fileName = `BaoCao_${reportType}_${selectedMonth}_${selectedYear}.xlsx`;
      if (contentDisposition) {
        const fileNameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (fileNameMatch && fileNameMatch[1]) {
          fileName = decodeURIComponent(fileNameMatch[1].replace(/['"]/g, ''));
        }
      }
      
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      
      alert('Xuất Excel thành công!');
    } catch (error) {
      console.error('Error exporting Excel:', error);
      // Because the request uses responseType: 'blob', an error response body
      // (typically JSON) also arrives as a Blob instead of a parsed object, so
      // error.response.data.error is always undefined unless we decode it first.
      const blobData = error.response?.data;
      if (blobData instanceof Blob && blobData.type?.includes('json')) {
        try {
          const text = await blobData.text();
          const parsed = JSON.parse(text);
          alert(parsed.error || 'Có lỗi xảy ra khi xuất Excel');
          return;
        } catch {
          // fall through to generic message below
        }
      }
      alert(error.response?.data?.error || 'Có lỗi xảy ra khi xuất Excel');
    }
  };

  const getTableHeaders = () => {
    switch (reportType) {
      case 'product':
        return (
          <>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ngày</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Mặt hàng</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Đơn vị</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Nhân viên</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Nhân viên đứng ca</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Số lượng</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Số đơn</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Doanh thu</th>
          </>
        );
      case 'category':
        return (
          <>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ngày</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Danh mục</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Nhân viên</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Nhân viên đứng ca</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Số lượng</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Số đơn</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Doanh thu</th>
          </>
        );
      case 'shift':
        return (
          <>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ngày</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Nhân viên</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Giờ vào</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Giờ ra</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Doanh thu dự kiến</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Doanh thu thực tế</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Số tiền mặt thực tế</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Tiền đã rút</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ghi chú</th>
          </>
        );
      case 'daily':
        return (
          <>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ngày</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Số đơn</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Tiền mặt</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Chuyển khoản</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Tiền rút</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Tổng doanh thu</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ghi chú</th>
          </>
        );
      default:
        return null;
    }
  };

  const renderTableRow = (item, index) => {
    // Ensure reportType is valid before rendering
    const validTypes = ['product', 'category', 'shift', 'daily'];
    if (!validTypes.includes(reportType)) {
      return null;
    }
    
    switch (reportType) {
      case 'product':
        return (
          <tr key={`${item.date}-${item.product_id}-${index}`} className="hover:bg-blue-50 transition-colors duration-200 cursor-pointer">
            <td className="px-4 py-3 text-sm text-gray-800">
              {new Date(item.date).toLocaleDateString('vi-VN')}
            </td>
            <td className="px-4 py-3 text-sm font-medium text-gray-800">{item.product_name}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{item.product_unit}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{item.employee_names || '-'}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{item.shift_employee_names || '-'}</td>
            <td className="px-4 py-3 text-sm text-gray-600 text-right">
              {parseFloat(item.total_quantity).toFixed(2)}
            </td>
            <td className="px-4 py-3 text-sm text-gray-600 text-right">{item.total_orders}</td>
            <td className="px-4 py-3 text-sm font-bold text-green-600 text-right">
              {new Intl.NumberFormat('vi-VN').format(parseFloat(item.total_revenue) || 0)} đ
            </td>
          </tr>
        );
      case 'category':
        return (
          <tr key={`${item.date}-${item.category}-${index}`} className="hover:bg-blue-50 transition-colors duration-200 cursor-pointer">
            <td className="px-4 py-3 text-sm text-gray-800">
              {new Date(item.date).toLocaleDateString('vi-VN')}
            </td>
            <td className="px-4 py-3 text-sm font-medium text-gray-800">
              {item.category}
            </td>
            <td className="px-4 py-3 text-sm text-gray-600">{item.employee_names || '-'}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{item.shift_employee_names || '-'}</td>
            <td className="px-4 py-3 text-sm text-gray-600 text-right">
              {parseFloat(item.total_quantity).toFixed(2)}
            </td>
            <td className="px-4 py-3 text-sm text-gray-600 text-right">{item.total_orders}</td>
            <td className="px-4 py-3 text-sm font-bold text-green-600 text-right">
              {new Intl.NumberFormat('vi-VN').format(parseFloat(item.total_revenue) || 0)} đ
            </td>
          </tr>
        );
      case 'shift':
        return (
          <tr key={`${item.date}-${item.shift_id}-${index}`} className="hover:bg-blue-50 transition-colors duration-200 cursor-pointer">
            <td className="px-4 py-3 text-sm text-gray-800 font-medium">
              {new Date(item.date).toLocaleDateString('vi-VN')}
            </td>
            <td className="px-4 py-3 text-sm font-medium text-gray-800">{item.employee_name}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{item.check_in_time || '-'}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{item.check_out_time || '-'}</td>
            <td className="px-4 py-3 text-sm font-bold text-blue-600 text-right">
              {new Intl.NumberFormat('vi-VN').format(parseFloat(item.start_revenue) || 0)} đ
            </td>
            <td className="px-4 py-3 text-sm font-bold text-green-600 text-right">
              {new Intl.NumberFormat('vi-VN').format(parseFloat(item.end_revenue) || 0)} đ
            </td>
            <td className="px-4 py-3 text-sm font-bold text-green-700 text-right">
              {new Intl.NumberFormat('vi-VN').format(
                Math.max(0, (parseFloat(item.end_revenue) || 0) - (parseFloat(item.withdrawn_amount) || 0))
              )} đ
            </td>
            <td className="px-4 py-3 text-sm font-bold text-amber-600 text-right">
              {new Intl.NumberFormat('vi-VN').format(parseFloat(item.withdrawn_amount) || 0)} đ
            </td>
            <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={item.note || ''}>
              {item.note || '-'}
            </td>
          </tr>
        );
      case 'daily':
        const isToday = new Date(item.date).toDateString() === new Date().toDateString();
        const hasRevenue = parseFloat(item.total_revenue) > 0;
        const cashAmount = parseFloat(item.cash_revenue) || 0;
        const transferAmount = parseFloat(item.transfer_revenue) || 0;
        const withdrawnAmount = parseFloat(item.total_withdrawn) || 0;
        return (
          <tr 
            key={`${item.date}-${index}`} 
            className={`transition-colors duration-200 ${
              isToday ? 'bg-blue-50 border-l-4 border-blue-500' : 
              hasRevenue ? 'hover:bg-green-50' : 'hover:bg-gray-50'
            }`}
          >
            <td className="px-4 py-3 text-sm font-medium text-gray-800">
              {new Date(item.date).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })}
              {isToday && <span className="ml-2 text-xs text-blue-600 font-semibold">(Hôm nay)</span>}
            </td>
            <td className="px-4 py-3 text-sm text-gray-600 text-right">
              {item.total_orders || 0}
            </td>
            <td className={`px-4 py-3 text-sm font-bold text-right ${
              cashAmount > 0 ? 'text-green-600' : 'text-gray-400'
            }`}>
              {new Intl.NumberFormat('vi-VN').format(cashAmount)} đ
            </td>
            <td className={`px-4 py-3 text-sm font-bold text-right ${
              transferAmount > 0 ? 'text-blue-600' : 'text-gray-400'
            }`}>
              {new Intl.NumberFormat('vi-VN').format(transferAmount)} đ
            </td>
            <td className={`px-4 py-3 text-sm font-bold text-right ${
              withdrawnAmount > 0 ? 'text-amber-600' : 'text-gray-400'
            }`}>
              {new Intl.NumberFormat('vi-VN').format(withdrawnAmount)} đ
            </td>
            <td className={`px-4 py-3 text-sm font-bold text-right ${
              hasRevenue ? 'text-green-600' : 'text-gray-400'
            }`}>
              {new Intl.NumberFormat('vi-VN').format(parseFloat(item.total_revenue) || 0)} đ
            </td>
            <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={item.day_notes || ''}>
              {item.day_notes || '-'}
            </td>
          </tr>
        );
      default:
        return null;
    }
  };

  // Root admin: báo cáo theo cửa hàng, cần đăng nhập bằng tài khoản admin cửa hàng
  if (isRoot()) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">Báo cáo</h1>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-amber-800">
          <p className="font-medium">Báo cáo theo cửa hàng.</p>
          <p className="mt-2">Vui lòng đăng nhập bằng tài khoản <strong>Admin cửa hàng</strong> để xem báo cáo doanh thu, ca làm việc, v.v.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">Báo cáo</h1>
        
        {/* Report Type Selector and Store Filter in one row */}
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-6">
          <div className="flex flex-wrap gap-3 items-end mb-6">
          <button
            onClick={() => {
              setReportType('product');
              setPagination(prev => ({ ...prev, page: 1 }));
              try {
                localStorage.setItem('laundry66_reportType', 'product');
              } catch (e) {}
            }}
            className={`px-5 py-2.5 rounded-xl font-medium transition-all duration-300 ${
              reportType === 'product'
                ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg transform scale-105'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 hover:shadow-md'
            }`}
          >
            Doanh thu theo mặt hàng
          </button>
          <button
            onClick={() => {
              setReportType('category');
              setPagination(prev => ({ ...prev, page: 1 }));
              try {
                localStorage.setItem('laundry66_reportType', 'category');
              } catch (e) {}
            }}
            className={`px-5 py-2.5 rounded-xl font-medium transition-all duration-300 ${
              reportType === 'category'
                ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg transform scale-105'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 hover:shadow-md'
            }`}
          >
            Doanh thu theo danh mục
          </button>
          <button
            onClick={() => {
              setReportType('shift');
              setPagination(prev => ({ ...prev, page: 1 }));
              try {
                localStorage.setItem('laundry66_reportType', 'shift');
              } catch (e) {}
            }}
            className={`px-5 py-2.5 rounded-xl font-medium transition-all duration-300 ${
              reportType === 'shift'
                ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg transform scale-105'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 hover:shadow-md'
            }`}
          >
            Doanh thu theo ca
          </button>
          <button
            onClick={() => {
              setReportType('daily');
              setPagination(prev => ({ ...prev, page: 1 }));
              try {
                localStorage.setItem('laundry66_reportType', 'daily');
              } catch (e) {}
            }}
            className={`px-5 py-2.5 rounded-xl font-medium transition-all duration-300 ${
              reportType === 'daily'
                ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg transform scale-105'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 hover:shadow-md'
            }`}
          >
            Doanh thu từng ngày
          </button>
            
            {/* Store Filter - inline with report type buttons */}
            {isAdmin() && stores.length > 0 && (
              <div className="ml-auto">
                <label className="block text-sm font-medium text-gray-700 mb-1">Lọc theo cửa hàng</label>
                <select
                  value={selectedStoreId}
                  onChange={(e) => setSelectedStoreId(e.target.value)}
                  className="px-4 py-2.5 border border-gray-300 rounded-xl text-base bg-white shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="all">Tất cả cửa hàng</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Month/Year Selector */}
          <div className="flex gap-3 items-center">
          <label className="text-sm font-medium text-gray-700">Tháng:</label>
            <select
            value={selectedMonth}
            onChange={(e) => {
              setSelectedMonth(parseInt(e.target.value));
              setPagination(prev => ({ ...prev, page: 1 }));
            }}
              className="px-3 py-2 border rounded-lg"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  Tháng {i + 1}
                </option>
              ))}
            </select>
          <label className="text-sm font-medium text-gray-700">Năm:</label>
            <input
              type="number"
              min="2020"
              max="2100"
            value={selectedYear}
            onChange={(e) => {
              setSelectedYear(parseInt(e.target.value) || new Date().getFullYear());
              setPagination(prev => ({ ...prev, page: 1 }));
            }}
              className="px-3 py-2 border rounded-lg w-32"
            />
            <button
              onClick={handleExportExcel}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
              title="Xuất Excel"
            >
              <span>📊</span>
              <span>Xuất Excel</span>
            </button>
          </div>
        </div>
      </div>

      {/* Report Table */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
        <div className="bg-gradient-to-r from-blue-500 to-indigo-600 p-6">
          <h2 className="text-xl font-bold text-white">{getReportTitle()}</h2>
          <p className="text-sm text-blue-100 mt-1">
            Tháng {selectedMonth}/{selectedYear}
          </p>
          {reportType === 'daily' && dailySummary && (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <div className="bg-white bg-opacity-20 rounded-lg p-3">
                <div className="text-xs text-blue-100">Tổng doanh thu</div>
                <div className="text-lg font-bold text-white">
                  {new Intl.NumberFormat('vi-VN').format(dailySummary.total_revenue || 0)} đ
                </div>
              </div>
              <div className="bg-white bg-opacity-20 rounded-lg p-3">
                <div className="text-xs text-blue-100">Tổng tiền mặt</div>
                <div className="text-lg font-bold text-white">
                  {new Intl.NumberFormat('vi-VN').format(dailySummary.total_cash || 0)} đ
                </div>
              </div>
              <div className="bg-white bg-opacity-20 rounded-lg p-3">
                <div className="text-xs text-blue-100">Tổng chuyển khoản</div>
                <div className="text-lg font-bold text-white">
                  {new Intl.NumberFormat('vi-VN').format(dailySummary.total_transfer || 0)} đ
                </div>
              </div>
              <div className="bg-white bg-opacity-20 rounded-lg p-3">
                <div className="text-xs text-blue-100">Tổng tiền rút</div>
                <div className="text-lg font-bold text-white">
                  {new Intl.NumberFormat('vi-VN').format(dailySummary.total_withdrawn || 0)} đ
                </div>
              </div>
              <div className="bg-white bg-opacity-20 rounded-lg p-3">
                <div className="text-xs text-blue-100">Tổng số đơn</div>
                <div className="text-lg font-bold text-white">{dailySummary.total_orders || 0}</div>
              </div>
              <div className="bg-white bg-opacity-20 rounded-lg p-3">
                <div className="text-xs text-blue-100">Doanh thu TB/ngày</div>
                <div className="text-lg font-bold text-white">
                  {new Intl.NumberFormat('vi-VN').format(Math.round(dailySummary.average_daily_revenue || 0))} đ
                </div>
              </div>
            </div>
          )}
        </div>

        {loading ? (
          <div className="p-12 text-center">
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mb-4"></div>
            <div className="text-gray-500">Đang tải...</div>
          </div>
        ) : data.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            <div className="text-4xl mb-4">📊</div>
            <div>Chưa có dữ liệu</div>
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
                  <tr>
                    {getTableHeaders()}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                  {data.map((item, index) => renderTableRow(item, index))}
                  {reportType === 'daily' && data.length > 0 && (() => {
                    const totals = data.reduce((acc, item) => ({
                      total_orders: acc.total_orders + (parseInt(item.total_orders) || 0),
                      cash_revenue: acc.cash_revenue + (parseFloat(item.cash_revenue) || 0),
                      transfer_revenue: acc.transfer_revenue + (parseFloat(item.transfer_revenue) || 0),
                      total_withdrawn: acc.total_withdrawn + (parseFloat(item.total_withdrawn) || 0),
                      total_revenue: acc.total_revenue + (parseFloat(item.total_revenue) || 0),
                    }), { total_orders: 0, cash_revenue: 0, transfer_revenue: 0, total_withdrawn: 0, total_revenue: 0 });
                    
                    return (
                      <tr className="bg-gradient-to-r from-blue-50 to-indigo-50 border-t-2 border-blue-300 font-bold">
                        <td className="px-4 py-3 text-sm font-bold text-gray-900">
                          TỔNG CỘNG
                        </td>
                        <td className="px-4 py-3 text-sm font-bold text-gray-900 text-right">
                          {totals.total_orders}
                        </td>
                        <td className="px-4 py-3 text-sm font-bold text-green-700 text-right">
                          {new Intl.NumberFormat('vi-VN').format(totals.cash_revenue)} đ
                        </td>
                        <td className="px-4 py-3 text-sm font-bold text-blue-700 text-right">
                          {new Intl.NumberFormat('vi-VN').format(totals.transfer_revenue)} đ
                        </td>
                        <td className="px-4 py-3 text-sm font-bold text-amber-700 text-right">
                          {new Intl.NumberFormat('vi-VN').format(totals.total_withdrawn)} đ
                        </td>
                        <td className="px-4 py-3 text-sm font-bold text-green-700 text-right">
                          {new Intl.NumberFormat('vi-VN').format(totals.total_revenue)} đ
                        </td>
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </div>

            {/* Pagination - Hide for daily report */}
            {reportType !== 'daily' && (
              <div className="p-6 border-t bg-gray-50 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600">Hiển thị:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => handlePageSizeChange(e.target.value)}
                    className="px-3 py-1.5 border rounded-lg text-sm"
                  >
                    <option value="10">10</option>
                    <option value="20">20</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                  </select>
                  <span className="text-sm text-gray-600">
                    / Tổng: {pagination.total} bản ghi
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handlePageChange(1)}
                    disabled={pagination.page === 1}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white hover:shadow-md transition-all duration-200 bg-white font-medium"
                  >
                    Đầu
                  </button>
                  <button
                    onClick={() => handlePageChange(pagination.page - 1)}
                    disabled={pagination.page === 1}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white hover:shadow-md transition-all duration-200 bg-white font-medium"
                  >
                    Trước
                  </button>
                  <span className="px-3 py-1.5 text-sm text-gray-700">
                    Trang {pagination.page} / {pagination.totalPages || 1}
                  </span>
                  <button
                    onClick={() => handlePageChange(pagination.page + 1)}
                    disabled={pagination.page >= pagination.totalPages}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white hover:shadow-md transition-all duration-200 bg-white font-medium"
                  >
                    Sau
                  </button>
                  <button
                    onClick={() => handlePageChange(pagination.totalPages)}
                    disabled={pagination.page >= pagination.totalPages}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white hover:shadow-md transition-all duration-200 bg-white font-medium"
                  >
                    Cuối
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default Reports;
