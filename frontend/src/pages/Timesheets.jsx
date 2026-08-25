import { useEffect, useRef, useState } from 'react';
import PageSkeleton from '../components/PageSkeleton';
import { showToast } from '../utils/toast';
import api from '../utils/api';
import { isAdmin, getEmployeeId, getAuth } from '../utils/auth';
import { format, getDaysInMonth } from 'date-fns';
import { getSavedFilters, saveFilters } from '../utils/filterStorage';
import SalaryAdjustModal from '../components/SalaryAdjustModal';
import MoneyInput from '../components/MoneyInput';
import { getPositionBestEffort } from '../utils/geo';

// Khởi tạo Intl formatter 1 lần ở module scope — tạo mới trong vòng lặp render
// (31 ngày × N nhân viên ô/lần) tốn kém gấp nhiều lần .format() và gây giật
const VND_FORMAT = new Intl.NumberFormat('vi-VN');
import {
  formatLocalDate,
  formatLocalDateKey,
  formatLocalTime,
  getLocalDateRangeUtc,
  getLocalIsoWeekRangeUtc,
  getLocalMonthRangeUtc,
  getLocalYearRangeUtc,
} from '../utils/dateTime';

function Timesheets() {
  const savedFilters = getSavedFilters();
  const [timesheets, setTimesheets] = useState([]);
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(savedFilters.selectedStoreId);
  const [loading, setLoading] = useState(true);
  const [openShifts, setOpenShifts] = useState([]);
  const [todayCheckIn, setTodayCheckIn] = useState(null);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [selectedMonth, setSelectedMonth] = useState(savedFilters.selectedMonth);
  const [selectedYear, setSelectedYear] = useState(savedFilters.selectedYear);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  // Chống double-submit: GPS có thể chờ tới 10s, không khóa nút thì bấm lại
  // trong lúc chờ sẽ bắn 2 request (2 ca mở trùng / check-out 2 lần)
  const [checkInSubmitting, setCheckInSubmitting] = useState(false);
  const [checkOutSubmitting, setCheckOutSubmitting] = useState(false);
  const [cashDrawerSubmitting, setCashDrawerSubmitting] = useState(false);
  const [revenueAmount, setRevenueAmount] = useState('');
  const [checkoutNote, setCheckoutNote] = useState('');
  const [expectedRevenue, setExpectedRevenue] = useState(0);
  const [expectedOrderCount, setExpectedOrderCount] = useState(0);
  const [totalWithdrawn, setTotalWithdrawn] = useState(0);
  const [checkoutWithdrawnAmount, setCheckoutWithdrawnAmount] = useState('');
  const [dailyHours, setDailyHours] = useState([]);
  const [dailyHoursLoading, setDailyHoursLoading] = useState(false);
  const [viewMode, setViewMode] = useState(isAdmin() ? 'list' : 'list'); // 'list', 'daily', 'payroll'
  const [periodViewMode, setPeriodViewMode] = useState(isAdmin() ? 'day' : 'day'); // 'day', 'month', or 'year' for admin
  const [daysInMonth, setDaysInMonth] = useState(31);
  const [showCheckinModal, setShowCheckinModal] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [checkinNote, setCheckinNote] = useState('');
  const [checkoutOutAt, setCheckoutOutAt] = useState('');
  const [closingTimesheetId, setClosingTimesheetId] = useState(null);
  const [closingShift, setClosingShift] = useState(null);
  const [openingCashAmount, setOpeningCashAmount] = useState('');
  const [cashDrawerSummary, setCashDrawerSummary] = useState(null);
  const [showCashDrawerModal, setShowCashDrawerModal] = useState(false);
  const [cashDrawerAction, setCashDrawerAction] = useState('cash-in');
  const [cashDrawerAmount, setCashDrawerAmount] = useState('');
  const [cashDrawerReason, setCashDrawerReason] = useState('');
  const [cashShortagePaidAmount, setCashShortagePaidAmount] = useState('');
  const [mySalary, setMySalary] = useState(null);
  const [adjustEmployee, setAdjustEmployee] = useState(null);
  // GPS warm-up: bắt đầu lấy vị trí ngay khi mở modal để lúc bấm nút không
  // phải đợi fix GPS (có thể tới 10s trong nhà)
  const positionPromiseRef = useRef(null);
  const [adminEmployees, setAdminEmployees] = useState([]);
  const [adjustmentsGrid, setAdjustmentsGrid] = useState([]);
  const [adjustmentsGridDays, setAdjustmentsGridDays] = useState(31);
  const [payroll, setPayroll] = useState([]);
  const [payrollLoading, setPayrollLoading] = useState(false);
  const [payrollPeriod, setPayrollPeriod] = useState('month');
  const [payrollMonth, setPayrollMonth] = useState(new Date().getMonth() + 1);
  const [payrollYear, setPayrollYear] = useState(new Date().getFullYear());
  const [payrollWeek, setPayrollWeek] = useState(1);

  useEffect(() => {
    if (isAdmin()) {
      loadStores();
    }
    loadTimesheets();
    checkTodayStatus();
    if (isAdmin() && viewMode === 'daily') {
      loadDailyHours();
    }
    if (isAdmin() && viewMode === 'payroll') {
      loadPayroll();
      loadAdjustmentsGrid();
    }
  }, [selectedDate, selectedMonth, selectedYear, viewMode, periodViewMode, payrollPeriod, payrollMonth, payrollYear, payrollWeek, selectedStoreId]);

  // Chỉ chạy 1 lần khi mount — 2 hàm này không phụ thuộc filter nào,
  // để trong effect trên sẽ gọi API thừa mỗi lần đổi ngày/tháng
  useEffect(() => {
    if (!isAdmin()) {
      loadStoreEmployees();
      loadMySalary();
    }
  }, []);

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

  useEffect(() => {
    if (payrollPeriod === 'week' && payrollWeek === 1) {
      setPayrollWeek(getWeekNumber(new Date()));
    }
  }, []);

  // Admin: tải danh sách nhân viên để thưởng/phạt nhanh — chỉ khi mở tab
  // Bảng lương (tránh gọi API thừa ở view chấm công mặc định)
  useEffect(() => {
    if (isAdmin() && viewMode === 'payroll' && adminEmployees.length === 0) {
      api.get('/employees')
        .then((r) => setAdminEmployees(r.data.data || []))
        .catch(() => setAdminEmployees([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  const formatMoney = (value) => `${VND_FORMAT.format(parseFloat(value) || 0)} đ`;

  const loadTimesheets = async () => {
    try {
      // Không bật spinner khi refresh — giữ dữ liệu cũ trên màn hình (lần đầu đã có useState(true))
      const params = new URLSearchParams();
      
      if (isAdmin() && periodViewMode === 'month') {
        const range = getLocalMonthRangeUtc(selectedYear, selectedMonth);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      } else if (isAdmin() && periodViewMode === 'year') {
        const range = getLocalYearRangeUtc(selectedYear);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      } else {
        const range = getLocalDateRangeUtc(selectedDate);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      }
      
      // Add store_id filter if admin selected a specific store
      if (isAdmin() && selectedStoreId && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }

      const response = await api.get(`/timesheets?${params.toString()}`);
      let allTimesheets = response.data.data || [];
      
      // Filter by date if day mode
      if (isAdmin() && periodViewMode === 'day') {
        allTimesheets = allTimesheets.filter(ts => {
          const tsDate = formatLocalDateKey(ts.check_in);
          return tsDate === selectedDate;
        });
      }
      
      setTimesheets(allTimesheets);
    } catch (error) {
      console.error('Error loading timesheets:', error);
    } finally {
      setLoading(false);
    }
  };

  const checkTodayStatus = async () => {
    try {
      const response = await api.get('/timesheets/open-shifts');
      const shifts = response.data.data || [];
      setOpenShifts(shifts);
      setTodayCheckIn(shifts[0] || null);
      if (shifts[0]?.id) {
        await loadCashDrawerSummary(shifts[0].id);
      } else {
        setCashDrawerSummary(null);
      }
    } catch (error) {
      console.error('Error checking today status:', error);
      setOpenShifts([]);
      setTodayCheckIn(null);
      setCashDrawerSummary(null);
    }
  };

  const loadCashDrawerSummary = async (timesheetId) => {
    if (!timesheetId) return;
    try {
      const response = await api.get(`/cash-drawer/timesheets/${timesheetId}`);
      setCashDrawerSummary(response.data.data?.summary || null);
    } catch (error) {
      console.error('Error loading cash drawer:', error);
      setCashDrawerSummary(null);
    }
  };

  // Lương tháng hiện tại của nhân viên đang đăng nhập (tài khoản riêng)
  const loadMySalary = async () => {
    if (isAdmin() || !getEmployeeId()) {
      setMySalary(null);
      return;
    }
    try {
      const now = new Date();
      const response = await api.get(
        `/salary/my-summary?month=${now.getMonth() + 1}&year=${now.getFullYear()}&timezone_offset_minutes=${now.getTimezoneOffset()}`
      );
      setMySalary(response.data.data || null);
    } catch (error) {
      console.error('Error loading my salary:', error);
      setMySalary(null);
    }
  };

  const loadStoreEmployees = async () => {
    try {
      const response = await api.get('/timesheets/store-employees');
      setEmployees(response.data.data || []);
    } catch (error) {
      console.error('Error loading employees:', error);
    }
  };

  const handleCheckInClick = () => {
    const employeeIdFromToken = getEmployeeId();
    positionPromiseRef.current = getPositionBestEffort(); // warm-up GPS
    setShowCheckinModal(true);
    // Tài khoản cá nhân: luôn là chính mình. Tài khoản cửa hàng dùng chung:
    // ca đầu dùng nhân viên đã chọn khi login (nếu có), người vào thêm tự chọn tên.
    setSelectedEmployee(employeeIdFromToken || '');
    setCheckinNote('');
    setOpeningCashAmount('');
  };

  const handleCheckIn = async () => {
    if (checkInSubmitting) return;
    setCheckInSubmitting(true);
    try {
      const employeeIdFromToken = getEmployeeId();
      const isAdditional = openShifts.length > 0;
      // Tài khoản cá nhân: luôn gửi employee_id của chính mình (backend cũng khóa cứng).
      // Tài khoản dùng chung: người vào thêm phải chọn tên trong form.
      const employeeIdToSend = employeeIdFromToken || selectedEmployee || undefined;

      if (!employeeIdFromToken && isAdditional && !employeeIdToSend) {
        showToast('Vui lòng chọn tên nhân viên check-in thêm vào ca.');
        return;
      }

      // Vị trí GPS (best-effort): backend chỉ yêu cầu khi tiệm có đặt tọa độ.
      // Ưu tiên promise đã warm-up từ lúc mở modal — không bắt người dùng đợi
      const position = await (positionPromiseRef.current || getPositionBestEffort());
      positionPromiseRef.current = null;

      await api.post('/timesheets/check-in', {
        employee_id: employeeIdToSend,
        // Két tiền thuộc ca chính — người vào thêm không nhập quỹ đầu ca
        opening_cash_amount: isAdditional ? 0 : (openingCashAmount !== '' ? parseFloat(openingCashAmount) : 0),
        note: checkinNote,
        ...position,
      });
      setShowCheckinModal(false);
      setSelectedEmployee('');
      setCheckinNote('');
      setOpeningCashAmount('');
      checkTodayStatus();
      loadTimesheets();
    } catch (error) {
      showToast(error.response?.data?.error || 'Check-in thất bại');
    } finally {
      setCheckInSubmitting(false);
    }
  };

  const handleCheckOutClick = async (shift) => {
    const ts = shift || todayCheckIn;
    if (!ts?.id) {
      showToast('Không tìm thấy ca đang mở.');
      return;
    }
    positionPromiseRef.current = getPositionBestEffort(); // warm-up GPS
    setClosingShift(ts);
    setClosingTimesheetId(ts.id);
    setCheckoutOutAt('');
    try {
      const response = await api.get(`/timesheets/expected-revenue?timesheet_id=${ts.id}`);
      setExpectedRevenue(response.data.data.expected_revenue || 0);
      setExpectedOrderCount(response.data.data.order_count || 0);
      setTotalWithdrawn(response.data.data.total_withdrawn || 0);
      setCashDrawerSummary(response.data.data.cash_drawer || null);
      setRevenueAmount(String(response.data.data.cash_drawer?.expected_cash_amount ?? ''));
      setCashShortagePaidAmount('');
      setShowCheckoutModal(true);
    } catch (error) {
      console.error('Error loading expected revenue:', error);
      setExpectedRevenue(0);
      setExpectedOrderCount(0);
      setTotalWithdrawn(0);
      setCashShortagePaidAmount('');
      setRevenueAmount('');
      setShowCheckoutModal(true);
    }
  };

  const handleCheckOut = async () => {
    if (checkOutSubmitting) return;
    // Allow any numeric value, including negative numbers
    if (revenueAmount === '' || revenueAmount === null || revenueAmount === undefined) {
      showToast('Vui lòng nhập số tiền thực tế');
      return;
    }
    
    const revenueValue = parseFloat(revenueAmount);
    
    if (isNaN(revenueValue)) {
      showToast('Vui lòng nhập số tiền hợp lệ');
      return;
    }

    // Debug log removed for security

    let checkOutAtPayload = null;
    if (checkoutOutAt && checkoutOutAt.trim()) {
      checkOutAtPayload = new Date(checkoutOutAt).toISOString();
    }

    setCheckOutSubmitting(true);
    try {
      // Vị trí GPS (best-effort): ưu tiên promise đã warm-up từ lúc mở modal
      const position = await (positionPromiseRef.current || getPositionBestEffort());
      positionPromiseRef.current = null;

      const response = await api.post('/timesheets/check-out', {
        timesheet_id: closingTimesheetId || todayCheckIn?.id,
        check_out_at: checkOutAtPayload,
        ...position,
        actual_cash_amount: revenueValue,
        cash_shortage_paid_amount: cashShortagePaidAmount !== '' && cashShortagePaidAmount != null
          ? parseFloat(cashShortagePaidAmount)
          : 0,
        expected_revenue: expectedRevenue || 0,
        withdrawn_amount: checkoutWithdrawnAmount !== '' && checkoutWithdrawnAmount != null
          ? parseFloat(checkoutWithdrawnAmount)
          : null,
        note: checkoutNote || null,
      });
      
      // Success log removed for security
      
      setShowCheckoutModal(false);
      setRevenueAmount('');
      setCheckoutNote('');
      setCheckoutWithdrawnAmount('');
      setCheckoutOutAt('');
      setClosingTimesheetId(null);
      setClosingShift(null);
      setCashShortagePaidAmount('');
      setCashDrawerSummary(null);
      setExpectedRevenue(0);
      setExpectedOrderCount(0);
      setTotalWithdrawn(0);
      checkTodayStatus();
      loadTimesheets();
      loadMySalary();
      if (isAdmin() && viewMode === 'daily') {
        loadDailyHours();
      }
      showToast('Check-out thành công!');
    } catch (error) {
      // Error details removed for security
      const errorMessage = error.response?.data?.error || error.message || 'Lỗi không xác định';
      showToast('Check-out thất bại: ' + errorMessage);
    } finally {
      setCheckOutSubmitting(false);
    }
  };

  const openCashDrawerModal = (action) => {
    setCashDrawerAction(action);
    setCashDrawerAmount('');
    setCashDrawerReason('');
    setShowCashDrawerModal(true);
  };

  const handleCashDrawerSubmit = async () => {
    if (!todayCheckIn?.id) {
      showToast('Không tìm thấy ca đang mở.');
      return;
    }

    const amount = parseFloat(cashDrawerAmount);
    if (Number.isNaN(amount) || amount <= 0) {
      showToast('Vui lòng nhập số tiền hợp lệ');
      return;
    }

    if (cashDrawerAction === 'cash-out' && !cashDrawerReason.trim()) {
      showToast('Vui lòng nhập lý do trừ tiền');
      return;
    }

    if (cashDrawerSubmitting) return;
    setCashDrawerSubmitting(true);
    try {
      const endpoint = cashDrawerAction === 'cash-in' ? '/cash-drawer/cash-in' : '/cash-drawer/cash-out';
      const response = await api.post(endpoint, {
        timesheet_id: todayCheckIn.id,
        amount,
        reason: cashDrawerReason || null,
      });
      setCashDrawerSummary(response.data.data?.summary || null);
      setShowCashDrawerModal(false);
      setCashDrawerAmount('');
      setCashDrawerReason('');
    } catch (error) {
      showToast(error.response?.data?.error || 'Không thể cập nhật ngăn két');
    } finally {
      setCashDrawerSubmitting(false);
    }
  };

  const loadDailyHours = async () => {
    if (!isAdmin()) return;
    
    setDailyHoursLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('month', selectedMonth);
      params.append('year', selectedYear);
      const range = getLocalMonthRangeUtc(selectedYear, selectedMonth);
      params.append('start_at', range.start_at);
      params.append('end_at', range.end_at);
      params.append('timezone_offset_minutes', String(new Date().getTimezoneOffset()));
      
      // Add store_id filter if admin selected a specific store
      if (selectedStoreId && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }

      const response = await api.get(`/timesheets/daily-hours?${params.toString()}`);
      setDailyHours(response.data.data || []);
      setDaysInMonth(response.data.days_in_month || 31);
    } catch (error) {
      console.error('Error loading daily hours:', error);
    } finally {
      setDailyHoursLoading(false);
    }
  };


  // Lưới thưởng/phạt theo ngày trong tháng (chỉ khi lọc theo tháng)
  const loadAdjustmentsGrid = async () => {
    if (!isAdmin() || payrollPeriod !== 'month') {
      setAdjustmentsGrid([]);
      return;
    }
    try {
      const params = new URLSearchParams();
      params.append('month', payrollMonth);
      params.append('year', payrollYear);
      if (selectedStoreId && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }
      const response = await api.get(`/salary/adjustments-grid?${params.toString()}`);
      setAdjustmentsGrid(response.data.data || []);
      setAdjustmentsGridDays(response.data.days_in_month || 31);
    } catch (error) {
      console.error('Error loading adjustments grid:', error);
      setAdjustmentsGrid([]);
    }
  };

  const loadPayroll = async () => {
    if (!isAdmin()) return;

    setPayrollLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('period', payrollPeriod);
      
      if (payrollPeriod === 'week') {
        params.append('week', payrollWeek);
        params.append('year', payrollYear);
        const range = getLocalIsoWeekRangeUtc(payrollYear, payrollWeek);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      } else {
        params.append('month', payrollMonth);
        params.append('year', payrollYear);
        const range = getLocalMonthRangeUtc(payrollYear, payrollMonth);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      }
      params.append('timezone_offset_minutes', String(new Date().getTimezoneOffset()));
      
      // Add store_id filter if admin selected a specific store
      if (selectedStoreId && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }

      const response = await api.get(`/timesheets/payroll?${params.toString()}`);
      setPayroll(response.data.data || []);
    } catch (error) {
      console.error('Error loading payroll:', error);
    } finally {
      setPayrollLoading(false);
    }
  };

  const handleExportExcel = async () => {
    try {
      const params = new URLSearchParams();
      
      if (periodViewMode === 'month') {
        const range = getLocalMonthRangeUtc(selectedYear, selectedMonth);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      } else if (periodViewMode === 'year') {
        const range = getLocalYearRangeUtc(selectedYear);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      } else {
        const range = getLocalDateRangeUtc(selectedDate);
        params.append('start_at', range.start_at);
        params.append('end_at', range.end_at);
      }
      params.append('timezone_offset_minutes', String(new Date().getTimezoneOffset()));
      
      if (isAdmin() && selectedStoreId && selectedStoreId !== 'all') {
        params.append('store_id', selectedStoreId);
      }

      const response = await api.get(`/timesheets/export?${params.toString()}`, {
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
      let fileName = `ChamCong_${selectedDate || `${selectedMonth}_${selectedYear}`}.xlsx`;
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
      
      showToast('Xuất Excel thành công!');
    } catch (error) {
      console.error('Error exporting Excel:', error);
      showToast(error.response?.data?.error || 'Có lỗi xảy ra khi xuất Excel');
    }
  };

  const getWeekNumber = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  };

  const getDaysArray = () => {
    const days = [];
    const daysInSelectedMonth = getDaysInMonth(new Date(selectedYear, selectedMonth - 1));
    for (let day = 1; day <= daysInSelectedMonth; day++) {
      const dateKey = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      days.push({ day, dateKey });
    }
    return days;
  };

  const handleDateChange = (dateStr) => {
    setSelectedDate(dateStr);
    const date = new Date(dateStr);
    setSelectedMonth(date.getMonth() + 1);
    setSelectedYear(date.getFullYear());
  };

  const getDaysInSelectedMonth = () => {
    const days = getDaysInMonth(new Date(selectedYear, selectedMonth - 1));
    return Array.from({ length: days }, (_, i) => {
      const day = i + 1;
      const dateStr = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return {
        day,
        dateStr,
        isSelected: dateStr === selectedDate,
        isToday: dateStr === format(new Date(), 'yyyy-MM-dd'),
      };
    });
  };

  if (loading) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {isAdmin() && stores.length > 0 && (
        <div className="mb-4 sm:mb-6">
          <div className="w-full sm:w-auto">
            <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">Lọc theo cửa hàng</label>
            <select
              value={selectedStoreId}
              onChange={(e) => setSelectedStoreId(e.target.value)}
              className="w-full sm:w-auto px-3 sm:px-4 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm sm:text-base bg-white shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 touch-manipulation"
            >
              <option value="all">Tất cả cửa hàng</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Check In/Out */}
      {!isAdmin() && (
        <div className="bg-gradient-to-br from-white to-gray-50 rounded-xl shadow-lg border border-gray-200 p-4 sm:p-6">
          {todayCheckIn &&
            formatLocalDateKey(todayCheckIn.check_in) !== format(new Date(), 'yyyy-MM-dd') && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                Bạn có ca <strong>chưa đóng</strong> từ ngày{' '}
                <strong>{formatLocalDate(todayCheckIn.check_in)}</strong>. Vui lòng check-out (có thể nhập <strong>giờ ra thực tế</strong> trong
                form) trước khi mở ca mới.
              </div>
            )}
          <div className="text-center mb-4">
            {openShifts.length > 0 ? (
              <div>
                <div className="text-base sm:text-lg font-medium text-green-600 mb-3">
                  {openShifts.length > 1
                    ? `${openShifts.length} người đang đứng ca`
                    : 'Ca đang mở'}
                </div>

                {/* Danh sách ca đang mở — mỗi người một thẻ, check-out riêng */}
                <div className="space-y-2 mb-4">
                  {openShifts.map((shift, idx) => (
                    <div
                      key={shift.id}
                      className={`rounded-xl border p-3 text-left ${
                        idx === 0 ? 'border-green-300 bg-green-50' : 'border-blue-200 bg-blue-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-gray-900 truncate">
                            {shift.employee_name || 'Chưa chọn tên'}
                            {idx === 0 && (
                              <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wide text-green-700 bg-green-100 border border-green-300 rounded px-1.5 py-0.5">
                                Ca chính
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-600 mt-0.5">
                            Vào ca: {formatLocalDate(shift.check_in)} {formatLocalTime(shift.check_in)}
                          </div>
                        </div>
                        {(!getEmployeeId() || shift.employee_id === Number(getEmployeeId())) ? (
                          <button
                            onClick={() => handleCheckOutClick(shift)}
                            className="flex-shrink-0 bg-gradient-to-r from-red-600 to-red-700 text-white px-4 py-2 rounded-lg active:from-red-700 active:to-red-800 hover:from-red-700 hover:to-red-800 font-semibold shadow transition-all touch-manipulation text-sm"
                          >
                            Check-out
                          </button>
                        ) : (
                          <span className="flex-shrink-0 text-xs text-gray-400 italic px-2">
                            Ca của đồng nghiệp
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-left">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="font-semibold text-emerald-900">
                      Ngăn két hiện tại
                      {openShifts.length > 1 && (
                        <span className="block text-[11px] font-normal text-emerald-700">(két thuộc ca chính)</span>
                      )}
                    </div>
                    <div className="text-lg font-bold text-emerald-700">
                      {formatMoney(cashDrawerSummary?.expected_cash_amount || 0)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-emerald-900">
                    <div>Quỹ đầu ca: <strong>{formatMoney(cashDrawerSummary?.opening_cash_amount || 0)}</strong></div>
                    <div>Tiền mặt thu đơn: <strong>{formatMoney(cashDrawerSummary?.cash_payment_amount || 0)}</strong></div>
                    <div>Nhập thêm: <strong>{formatMoney(cashDrawerSummary?.cash_in_amount || 0)}</strong></div>
                    <div>Trừ ra: <strong>{formatMoney(cashDrawerSummary?.cash_out_amount || 0)}</strong></div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => openCashDrawerModal('cash-in')}
                      className="rounded-lg bg-white border border-emerald-300 px-3 py-2 text-sm font-medium text-emerald-700 active:bg-emerald-100 hover:bg-emerald-100"
                    >
                      + Nhập thêm tiền
                    </button>
                    <button
                      type="button"
                      onClick={() => openCashDrawerModal('cash-out')}
                      className="rounded-lg bg-white border border-amber-300 px-3 py-2 text-sm font-medium text-amber-700 active:bg-amber-100 hover:bg-amber-100"
                    >
                      - Trừ tiền khỏi két
                    </button>
                  </div>
                </div>

                {(!getEmployeeId() || !openShifts.some((s) => s.employee_id === Number(getEmployeeId()))) && (
                  <button
                    onClick={handleCheckInClick}
                    className="w-full sm:w-auto bg-white border-2 border-green-600 text-green-700 px-8 py-3 rounded-xl active:bg-green-100 hover:bg-green-50 font-semibold shadow transition-all duration-300 touch-manipulation text-base"
                  >
                    {getEmployeeId() ? '+ Check-in ca của tôi' : '+ Check-in thêm nhân viên'}
                  </button>
                )}
              </div>
            ) : (
              <div>
                <div className="text-base sm:text-lg font-medium text-gray-600 mb-3 sm:mb-2">Chưa check-in</div>
                <button
                  onClick={handleCheckInClick}
                  className="w-full sm:w-auto bg-gradient-to-r from-green-600 to-green-700 text-white px-8 py-4 sm:py-3 rounded-xl active:from-green-700 active:to-green-800 hover:from-green-700 hover:to-green-800 font-semibold shadow-lg hover:shadow-xl transition-all duration-300 touch-manipulation text-base sm:text-lg"
                >
                  Check-in
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Lương tháng này — nhân viên đăng nhập tài khoản riêng */}
      {!isAdmin() && mySalary && (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-gray-900">
              💰 Lương tháng {mySalary.month}/{mySalary.year}
              <span className="block text-xs font-normal text-gray-500">{mySalary.employee?.name}</span>
            </div>
            <div className="text-2xl font-bold text-emerald-600">
              {formatMoney(mySalary.total_salary)}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm text-gray-700">
            <div className="rounded-lg bg-gray-50 px-3 py-2">
              Số ca: <strong>{mySalary.total_shifts}</strong>
            </div>
            <div className="rounded-lg bg-gray-50 px-3 py-2">
              Tổng giờ: <strong>{Number(mySalary.total_hours || 0).toFixed(1)}h</strong>
            </div>
            <div className="rounded-lg bg-gray-50 px-3 py-2">
              Lương công: <strong>{formatMoney(mySalary.work_salary)}</strong>
            </div>
            <div className="rounded-lg bg-amber-50 px-3 py-2">
              🎁 Hoa hồng:{' '}
              <strong className="text-amber-700">
                +{formatMoney(mySalary.total_commission || 0)}
              </strong>
            </div>
            <div className="rounded-lg bg-gray-50 px-3 py-2 col-span-2">
              Thưởng/Phạt:{' '}
              <strong className={mySalary.total_adjustments < 0 ? 'text-red-600' : 'text-emerald-700'}>
                {mySalary.total_adjustments >= 0 ? '+' : ''}{formatMoney(mySalary.total_adjustments)}
              </strong>
            </div>
          </div>
          {mySalary.adjustments?.length > 0 && (
            <div className="mt-3 space-y-1">
              {mySalary.adjustments.map((adj) => (
                <div key={adj.id} className="flex items-center justify-between text-xs text-gray-600 border-t border-gray-100 pt-1.5">
                  <span className="truncate">
                    {String(adj.adjust_date).slice(0, 10)}{adj.reason ? ` — ${adj.reason}` : ''}
                  </span>
                  <span className={`font-semibold flex-shrink-0 ml-2 ${adj.amount < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                    {adj.amount >= 0 ? '+' : ''}{formatMoney(adj.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Date Selector and View Mode - Admin */}
      {isAdmin() && (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-3 sm:p-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Theo ngày = danh sách chấm công của ngày; Theo tháng = bảng
                  lưới 30 ngày × tất cả nhân viên. Bỏ filter "Theo năm". */}
              <button
                onClick={() => { setPeriodViewMode('day'); setViewMode('list'); }}
                className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-300 touch-manipulation ${
                  periodViewMode === 'day' && viewMode !== 'payroll'
                    ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg'
                    : 'bg-gray-100 text-gray-700 active:bg-gray-200 hover:bg-gray-200'
                }`}
              >
                Theo ngày
              </button>
              <button
                onClick={() => { setPeriodViewMode('month'); setViewMode('daily'); }}
                className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-300 touch-manipulation ${
                  periodViewMode === 'month' && viewMode !== 'payroll'
                    ? 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg'
                    : 'bg-gray-100 text-gray-700 active:bg-gray-200 hover:bg-gray-200'
                }`}
              >
                Theo tháng
              </button>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setViewMode('payroll')}
                className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-300 touch-manipulation ${
                  viewMode === 'payroll'
                    ? 'bg-gradient-to-r from-indigo-600 to-indigo-700 text-white shadow-lg'
                    : 'bg-gray-100 text-gray-700 active:bg-gray-200 hover:bg-gray-200'
                }`}
              >
                💰 Lương & Thưởng/Phạt
              </button>
              <button
                onClick={handleExportExcel}
                className="px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-300 touch-manipulation bg-green-600 text-white hover:bg-green-700 shadow-lg flex items-center gap-1"
                title="Xuất Excel"
              >
                <span>📊</span>
                <span>Xuất Excel</span>
              </button>
            </div>
          </div>
          
          {periodViewMode === 'day' && (
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={selectedYear}
                onChange={(e) => {
                  const year = parseInt(e.target.value) || new Date().getFullYear();
                  setSelectedYear(year);
                  const currentDate = new Date(selectedDate);
                  const newYearDate = new Date(year, selectedMonth - 1, 1);
                  let day = 1;
                  if (currentDate.getFullYear() === year && currentDate.getMonth() + 1 === selectedMonth) {
                    day = currentDate.getDate();
                    const daysInMonth = getDaysInMonth(newYearDate);
                    if (day > daysInMonth) day = daysInMonth;
                  }
                  const newDate = `${year}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  handleDateChange(newDate);
                }}
                className="px-2 py-2 sm:py-1.5 border rounded-lg text-xs sm:text-sm touch-manipulation flex-1 sm:flex-none"
              >
                {Array.from({ length: 5 }, (_, i) => {
                  const year = new Date().getFullYear() - 2 + i;
                  return (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  );
                })}
              </select>
              <select
                value={selectedMonth}
                onChange={(e) => {
                  const month = parseInt(e.target.value);
                  setSelectedMonth(month);
                  const currentDate = new Date(selectedDate);
                  const newMonthDate = new Date(selectedYear, month - 1, 1);
                  let day = 1;
                  if (currentDate.getMonth() + 1 === month && currentDate.getFullYear() === selectedYear) {
                    day = currentDate.getDate();
                    const daysInMonth = getDaysInMonth(newMonthDate);
                    if (day > daysInMonth) day = daysInMonth;
                  }
                  const newDate = `${selectedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  handleDateChange(newDate);
                }}
                className="px-2 py-1.5 border rounded text-xs"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    Tháng {i + 1}
                  </option>
                ))}
              </select>
              <select
                value={selectedDate}
                onChange={(e) => handleDateChange(e.target.value)}
                className="px-2 py-1.5 border rounded text-xs flex-1"
              >
                {getDaysInSelectedMonth().map(({ day, dateStr, isToday }) => {
                  const date = new Date(dateStr);
                  const dayOfWeek = date.getDay();
                  const dayName = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][dayOfWeek];
                  const displayText = isToday 
                    ? `Hôm nay - ${day}/${selectedMonth} (${dayName})`
                    : `${day}/${selectedMonth} (${dayName})`;
                  return (
                    <option key={dateStr} value={dateStr}>
                      {displayText}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          
          {periodViewMode === 'month' && (
            <div className="flex items-center gap-2">
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
                className="px-2 py-1.5 border rounded text-xs"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>Tháng {i + 1}</option>
                ))}
              </select>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                className="px-2 py-1.5 border rounded text-xs"
              >
                {Array.from({ length: 5 }, (_, i) => {
                  const year = new Date().getFullYear() - 2 + i;
                  return <option key={year} value={year}>{year}</option>;
                })}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Date Selector - Non-admin */}
      {!isAdmin() && (
        <div className="bg-white rounded-lg shadow p-2">
          <div className="flex items-center gap-2 flex-1">
            <select
              value={selectedYear}
              onChange={(e) => {
                const year = parseInt(e.target.value) || new Date().getFullYear();
                setSelectedYear(year);
                const currentDate = new Date(selectedDate);
                const newYearDate = new Date(year, selectedMonth - 1, 1);
                let day = 1;
                if (currentDate.getFullYear() === year && currentDate.getMonth() + 1 === selectedMonth) {
                  day = currentDate.getDate();
                  const daysInMonth = getDaysInMonth(newYearDate);
                  if (day > daysInMonth) day = daysInMonth;
                }
                const newDate = `${year}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                handleDateChange(newDate);
              }}
              className="px-2 py-1.5 border rounded text-xs"
            >
              {Array.from({ length: 5 }, (_, i) => {
                const year = new Date().getFullYear() - 2 + i;
                return (
                  <option key={year} value={year}>
                    {year}
                  </option>
                );
              })}
            </select>
            <select
              value={selectedMonth}
              onChange={(e) => {
                const month = parseInt(e.target.value);
                setSelectedMonth(month);
                const currentDate = new Date(selectedDate);
                const newMonthDate = new Date(selectedYear, month - 1, 1);
                let day = 1;
                if (currentDate.getMonth() + 1 === month && currentDate.getFullYear() === selectedYear) {
                  day = currentDate.getDate();
                  const daysInMonth = getDaysInMonth(newMonthDate);
                  if (day > daysInMonth) day = daysInMonth;
                }
                const newDate = `${selectedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                handleDateChange(newDate);
              }}
              className="px-2 py-1.5 border rounded text-xs"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  Tháng {i + 1}
                </option>
              ))}
            </select>
            <select
              value={selectedDate}
              onChange={(e) => handleDateChange(e.target.value)}
              className="px-2 py-1.5 border rounded text-xs flex-1"
            >
              {getDaysInSelectedMonth().map(({ day, dateStr, isToday }) => {
                const date = new Date(dateStr);
                const dayOfWeek = date.getDay();
                const dayName = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][dayOfWeek];
                const displayText = isToday 
                  ? `Hôm nay - ${day}/${selectedMonth} (${dayName})`
                  : `${day}/${selectedMonth} (${dayName})`;
                return (
                  <option key={dateStr} value={dateStr}>
                    {displayText}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      )}

      {/* Daily Hours Table - Admin only */}
      {isAdmin() && viewMode === 'daily' && (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-cyan-500 to-blue-600 p-4">
            <h2 className="text-lg font-bold text-white">
              📅 Chấm công theo ngày — Tháng {selectedMonth}/{selectedYear}
            </h2>
          </div>
          {dailyHoursLoading ? (
            <div className="p-8 text-center text-gray-500">Đang tải...</div>
          ) : dailyHours.length === 0 ? (
            <div className="p-8 text-center text-gray-500">Chưa có nhân viên nào trong cửa hàng. Thêm nhân viên ở mục Cửa hàng &amp; Nhân sự.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-1.5 py-1 text-left text-[10px] font-medium text-gray-700 uppercase border border-gray-300 sticky left-0 bg-gray-50 z-10 min-w-[60px]">
                      Ngày
                    </th>
                    {dailyHours.map((emp) => (
                      <th
                        key={emp.user_id}
                        className="px-1 py-1 text-center text-[10px] font-medium text-gray-700 uppercase border border-gray-300 min-w-[50px]"
                      >
                        <div className="flex flex-col items-center">
                          <span>{emp.employee_name || emp.user_name}</span>
                          {emp.employee_name && emp.user_name && emp.employee_name !== emp.user_name && (
                            <span className="text-[8px] text-gray-500 mt-0.5">({emp.user_name})</span>
                          )}
                        </div>
                      </th>
                    ))}
                    <th className="px-1.5 py-1 text-center text-[10px] font-medium text-gray-700 uppercase bg-gray-100 font-bold border border-gray-300 min-w-[50px]">
                      Tổng
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {getDaysArray().map(({ day, dateKey }) => {
                    const date = new Date(dateKey);
                    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                    const dayTotal = dailyHours.reduce(
                      (sum, emp) => sum + (emp.daily_hours[dateKey] || 0),
                      0
                    );
                    return (
                      <tr key={day} className="hover:bg-gray-50">
                        <td className={`px-1.5 py-1 text-[11px] font-medium text-gray-800 border border-gray-300 sticky left-0 bg-white z-10 ${
                          isWeekend ? 'bg-red-50' : ''
                        }`}>
                          <div>{day}/{selectedMonth}</div>
                          <div className="text-[9px] text-gray-500">
                            {date.toLocaleDateString('vi-VN', { weekday: 'short' })}
                          </div>
                        </td>
                        {dailyHours.map((emp) => {
                          const hours = emp.daily_hours[dateKey] || 0;
                          return (
                            <td
                              key={emp.user_id}
                              className={`px-1 py-1 text-[11px] text-center border border-gray-300 ${
                                isWeekend ? 'bg-red-50' : ''
                              } ${
                                hours > 0
                                  ? 'font-medium text-blue-600'
                                  : 'text-gray-400'
                              }`}
                              title={`${emp.user_name} - Ngày ${day}/${selectedMonth}: ${hours > 0 ? hours.toFixed(1) + ' giờ' : 'Không làm việc'}`}
                            >
                              {hours > 0 ? hours.toFixed(1) : '-'}
                            </td>
                          );
                        })}
                        <td className={`px-1.5 py-1 text-[11px] text-center font-bold text-gray-800 bg-gray-100 border border-gray-300 ${
                          isWeekend ? 'bg-red-100' : ''
                        }`}>
                          {dayTotal > 0 ? dayTotal.toFixed(1) : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 font-semibold">
                  <tr>
                    <td className="px-1.5 py-1 text-[11px] text-gray-800 border border-gray-300 sticky left-0 bg-gray-50 z-10">
                      Tổng giờ
                    </td>
                    {dailyHours.map((emp) => (
                      <td key={emp.user_id} className="px-1 py-1 text-[11px] text-center font-bold text-gray-800 border border-gray-300">
                        {(parseFloat(emp.total_month_hours) || 0).toFixed(1)}
                      </td>
                    ))}
                    <td className="px-1.5 py-1 text-[11px] text-center bg-gray-100 border border-gray-300">
                      {dailyHours
                        .reduce((sum, emp) => sum + (parseFloat(emp.total_month_hours) || 0), 0)
                        .toFixed(1)}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-1.5 py-1 text-[11px] text-gray-800 border border-gray-300 sticky left-0 bg-gray-50 z-10 whitespace-nowrap">
                      Thưởng/Phạt (đ)
                    </td>
                    {dailyHours.map((emp) => {
                      const adj = parseFloat(emp.total_adjustments) || 0;
                      return (
                        <td
                          key={emp.user_id}
                          className={`px-1 py-1 text-[10px] text-center font-bold border border-gray-300 ${
                            adj < 0 ? 'text-red-600' : adj > 0 ? 'text-green-600' : 'text-gray-400'
                          }`}
                        >
                          {adj !== 0 ? `${adj > 0 ? '+' : ''}${VND_FORMAT.format(adj)}` : '-'}
                        </td>
                      );
                    })}
                    <td className="px-1.5 py-1 text-[10px] text-center font-bold bg-gray-100 border border-gray-300">
                      {VND_FORMAT.format(
                        dailyHours.reduce((sum, emp) => sum + (parseFloat(emp.total_adjustments) || 0), 0)
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Payroll Table - Admin only */}
      {isAdmin() && viewMode === 'payroll' && (
        <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
          <div className="bg-gradient-to-r from-purple-500 to-pink-600 p-4">
            <h2 className="text-lg font-bold text-white mb-3">💰 Bảng lương & Thưởng/Phạt</h2>

            {/* Thưởng/phạt nhanh — luôn hiện, kể cả khi bảng lương trống */}
            <div className="mb-3 bg-white/15 border border-white/30 rounded-lg p-2.5 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-white">± Thưởng / Phạt:</span>
              <select
                value=""
                onChange={(e) => {
                  const emp = adminEmployees.find((x) => x.id === parseInt(e.target.value));
                  if (emp) setAdjustEmployee({ id: emp.id, name: emp.name });
                }}
                className="flex-1 min-w-[180px] px-3 py-2 border-0 rounded-lg text-sm text-gray-800"
              >
                <option value="">-- Chọn nhân viên để cộng/trừ tiền --</option>
                {adminEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}{emp.store_name ? ` (${emp.store_name})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-2">
              <select
                value={payrollPeriod}
                onChange={(e) => {
                  setPayrollPeriod(e.target.value);
                  if (e.target.value === 'week') {
                    setPayrollWeek(getWeekNumber(new Date()));
                  }
                }}
                className="px-3 py-2 border rounded-lg"
              >
                <option value="week">Theo tuần</option>
                <option value="month">Theo tháng</option>
              </select>

              {payrollPeriod === 'week' ? (
                <>
                  <input
                    type="number"
                    min="1"
                    max="53"
                    value={payrollWeek}
                    onChange={(e) => setPayrollWeek(parseInt(e.target.value) || 1)}
                    className="px-3 py-2 border rounded-lg w-24"
                    placeholder="Tuần"
                  />
                  <input
                    type="number"
                    min="2020"
                    max="2100"
                    value={payrollYear}
                    onChange={(e) => setPayrollYear(parseInt(e.target.value) || new Date().getFullYear())}
                    className="px-3 py-2 border rounded-lg w-32"
                    placeholder="Năm"
                  />
                </>
              ) : (
                <>
                  <select
                    value={payrollMonth}
                    onChange={(e) => setPayrollMonth(parseInt(e.target.value))}
                    className="px-3 py-2 border rounded-lg"
                  >
                    {Array.from({ length: 12 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        Tháng {i + 1}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="2020"
                    max="2100"
                    value={payrollYear}
                    onChange={(e) => setPayrollYear(parseInt(e.target.value) || new Date().getFullYear())}
                    className="px-3 py-2 border rounded-lg w-32"
                    placeholder="Năm"
                  />
                </>
              )}
            </div>
          </div>

          {/* Payroll Table */}
          <div className="overflow-x-auto">
            {payrollLoading ? (
              <div className="p-8 text-center text-gray-500">Đang tải...</div>
            ) : payroll.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                Chưa có ca hoàn thành trong kỳ này.
                <span className="block text-sm mt-1">
                  Vẫn có thể thưởng/phạt nhân viên bằng ô <strong>"± Thưởng / Phạt"</strong> phía trên.
                </span>
              </div>
            ) : (
              <>
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-700 uppercase">Nhân viên</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase">Số ca</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase">Giờ</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase">Lương/giờ</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase">Lương công</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase">Hoa hồng</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase">Thưởng/Phạt</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-700 uppercase">Thực nhận</th>
                      <th className="px-3 py-3 text-center text-xs font-medium text-gray-700 uppercase"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {payroll.map((emp) => (
                      <tr key={emp.user_id} className="odd:bg-white even:bg-gray-50 hover:bg-blue-50 transition-colors">
                        <td className="px-3 py-3 text-sm font-medium text-gray-800">
                          {emp.employee_name || '-'}
                          {emp.user_name && emp.user_name !== emp.employee_name && (
                            <span className="block text-xs font-normal text-gray-500">{emp.user_name}</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-sm text-gray-600 text-right">{emp.total_shifts}</td>
                        <td className="px-3 py-3 text-sm font-medium text-gray-800 text-right">{(parseFloat(emp.total_hours) || 0).toFixed(2)}h</td>
                        <td className="px-3 py-3 text-sm text-gray-600 text-right">
                          {emp.hourly_rate > 0 ? VND_FORMAT.format(emp.hourly_rate) + ' đ/h' : '-'}
                        </td>
                        <td className="px-3 py-3 text-sm text-gray-700 text-right">
                          {VND_FORMAT.format(emp.salary)} đ
                        </td>
                        <td className={`px-3 py-3 text-sm font-medium text-right ${(emp.total_commission || 0) > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                          {(emp.total_commission || 0) > 0
                            ? `+${VND_FORMAT.format(emp.total_commission)} đ`
                            : '-'}
                        </td>
                        <td className={`px-3 py-3 text-sm font-medium text-right ${
                          (emp.total_adjustments || 0) < 0 ? 'text-red-600' : (emp.total_adjustments || 0) > 0 ? 'text-green-600' : 'text-gray-400'
                        }`}>
                          {(emp.total_adjustments || 0) !== 0
                            ? `${emp.total_adjustments > 0 ? '+' : ''}${VND_FORMAT.format(emp.total_adjustments)} đ`
                            : '-'}
                        </td>
                        <td className="px-3 py-3 text-sm font-bold text-green-600 text-right">
                          {VND_FORMAT.format(emp.final_salary ?? emp.salary)} đ
                        </td>
                        <td className="px-3 py-3 text-center">
                          {emp.is_employee ? (
                            <button
                              onClick={() => setAdjustEmployee({ id: emp.employee_id, name: emp.employee_name })}
                              className="px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 text-xs font-semibold whitespace-nowrap touch-manipulation"
                              title="Thưởng / phạt nhân viên này"
                            >
                              ± Tiền
                            </button>
                          ) : (
                            // Hàng ca không chọn tên (key là tài khoản cửa hàng) —
                            // không thể thưởng/phạt vì không biết là ai
                            <span className="text-xs text-gray-400 italic" title="Ca không chọn tên nhân viên">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-gray-50 font-semibold">
                    <tr>
                      <td className="px-3 py-3 text-sm text-gray-800">Tổng cộng</td>
                      <td className="px-3 py-3 text-sm text-gray-600 text-right">
                        {payroll.reduce((sum, emp) => sum + emp.total_shifts, 0)}
                      </td>
                      <td className="px-3 py-3 text-sm text-gray-800 text-right">
                        {payroll.reduce((sum, emp) => sum + (parseFloat(emp.total_hours) || 0), 0).toFixed(2)}h
                      </td>
                      <td className="px-3 py-3"></td>
                      <td className="px-3 py-3 text-sm text-gray-700 text-right">
                        {VND_FORMAT.format(payroll.reduce((sum, emp) => sum + emp.salary, 0))} đ
                      </td>
                      <td className="px-3 py-3 text-sm text-amber-600 text-right">
                        {VND_FORMAT.format(payroll.reduce((sum, emp) => sum + (emp.total_commission || 0), 0))} đ
                      </td>
                      <td className="px-3 py-3 text-sm text-right">
                        {VND_FORMAT.format(payroll.reduce((sum, emp) => sum + (emp.total_adjustments || 0), 0))} đ
                      </td>
                      <td className="px-3 py-3 text-sm text-green-600 text-right">
                        {VND_FORMAT.format(payroll.reduce((sum, emp) => sum + (emp.final_salary ?? emp.salary), 0))} đ
                      </td>
                      <td className="px-3 py-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </>
            )}
          </div>

          {/* Bảng lưới THƯỞNG/PHẠT theo ngày trong tháng (giống bảng chấm công) */}
          {payrollPeriod === 'month' && (
            <div className="border-t border-gray-200">
              <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-4">
                <h2 className="text-lg font-bold text-white">
                  🎁 Thưởng / Phạt theo ngày — Tháng {payrollMonth}/{payrollYear}
                </h2>
              </div>
              {adjustmentsGrid.length === 0 ? (
                <div className="p-8 text-center text-gray-500">Chưa có nhân viên nào trong cửa hàng.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-1.5 py-1 text-left text-[10px] font-medium text-gray-700 uppercase border border-gray-300 sticky left-0 bg-gray-50 z-10 min-w-[60px]">
                          Ngày
                        </th>
                        {adjustmentsGrid.map((emp) => (
                          <th key={emp.employee_id} className="px-1 py-1 text-center text-[10px] font-medium text-gray-700 uppercase border border-gray-300 min-w-[64px]">
                            {emp.employee_name}
                          </th>
                        ))}
                        <th className="px-1.5 py-1 text-center text-[10px] font-medium text-gray-700 uppercase bg-gray-100 font-bold border border-gray-300 min-w-[64px]">
                          Tổng
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: adjustmentsGridDays }, (_, i) => i + 1).map((day) => {
                        const dateKey = `${payrollYear}-${String(payrollMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const date = new Date(dateKey);
                        const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                        const dayTotal = adjustmentsGrid.reduce((sum, emp) => sum + (emp.daily_amounts[dateKey] || 0), 0);
                        return (
                          <tr key={day} className="hover:bg-gray-50">
                            <td className={`px-1.5 py-1 text-[11px] font-medium text-gray-800 border border-gray-300 sticky left-0 bg-white z-10 ${isWeekend ? 'bg-red-50' : ''}`}>
                              <div>{day}/{payrollMonth}</div>
                              <div className="text-[9px] text-gray-500">{date.toLocaleDateString('vi-VN', { weekday: 'short' })}</div>
                            </td>
                            {adjustmentsGrid.map((emp) => {
                              const amt = emp.daily_amounts[dateKey] || 0;
                              return (
                                <td
                                  key={emp.employee_id}
                                  className={`px-1 py-1 text-[10px] text-center border border-gray-300 ${isWeekend ? 'bg-red-50' : ''} ${
                                    amt < 0 ? 'text-red-600 font-medium' : amt > 0 ? 'text-green-600 font-medium' : 'text-gray-300'
                                  }`}
                                >
                                  {amt !== 0 ? `${amt > 0 ? '+' : ''}${VND_FORMAT.format(amt)}` : '-'}
                                </td>
                              );
                            })}
                            <td className={`px-1.5 py-1 text-[10px] text-center font-bold bg-gray-100 border border-gray-300 ${dayTotal < 0 ? 'text-red-600' : dayTotal > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                              {dayTotal !== 0 ? VND_FORMAT.format(dayTotal) : '-'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-50 font-semibold">
                      <tr>
                        <td className="px-1.5 py-1 text-[11px] text-gray-800 border border-gray-300 sticky left-0 bg-gray-50 z-10">Tổng</td>
                        {adjustmentsGrid.map((emp) => (
                          <td key={emp.employee_id} className={`px-1 py-1 text-[10px] text-center font-bold border border-gray-300 ${emp.total < 0 ? 'text-red-600' : emp.total > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                            {emp.total !== 0 ? VND_FORMAT.format(emp.total) : '-'}
                          </td>
                        ))}
                        <td className="px-1.5 py-1 text-[10px] text-center bg-gray-100 border border-gray-300">
                          {VND_FORMAT.format(adjustmentsGrid.reduce((sum, emp) => sum + (emp.total || 0), 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Timesheets List - Table for Admin, Cards for Non-admin */}
      {viewMode === 'list' && (
        isAdmin() ? (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Nhân viên</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Người đứng ca</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ngày</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Check-in</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Check-out</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Giờ</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-700 uppercase">Doanh thu ca</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase">Ghi chú</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {timesheets.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="px-4 py-8 text-center text-gray-500">
                        Chưa có dữ liệu chấm công
                      </td>
                    </tr>
                  ) : (
                    timesheets.map((timesheet) => (
                      <tr key={timesheet.id} className="hover:bg-blue-50 transition-colors duration-200 cursor-pointer">
                        <td className="px-4 py-3 font-medium text-gray-800">
                          {timesheet.employee_name || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {timesheet.user_name || '-'}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {formatLocalDate(timesheet.check_in)}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {formatLocalTime(timesheet.check_in)}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {timesheet.check_out 
                            ? formatLocalTime(timesheet.check_out)
                            : <span className="px-3 py-1 bg-gradient-to-r from-yellow-100 to-amber-100 text-yellow-800 rounded-full text-xs font-semibold shadow-sm border border-yellow-200">Đang làm việc</span>
                          }
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-gray-800">
                          {(parseFloat(timesheet.regular_hours || 0) + parseFloat(timesheet.overtime_hours || 0)).toFixed(2)}h
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-green-600">
                          {timesheet.revenue_amount 
                            ? `${VND_FORMAT.format(parseFloat(timesheet.revenue_amount) || 0)} đ`
                            : '-'
                          }
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-sm">{timesheet.note || '-'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {timesheets.length > 0 && (
                  <tfoot className="bg-gray-50 font-semibold">
                    <tr>
                      <td colSpan="5" className="px-4 py-3 text-gray-800">Tổng cộng</td>
                      <td className="px-4 py-3 text-right text-gray-800">
                        {timesheets.reduce((sum, t) => sum + ((parseFloat(t.regular_hours) || 0) + (parseFloat(t.overtime_hours) || 0)), 0).toFixed(2)}h
                      </td>
                      <td className="px-4 py-3 text-right text-green-600">
                        {VND_FORMAT.format(
                          timesheets.reduce((sum, t) => sum + (parseFloat(t.revenue_amount) || 0), 0)
                        )} đ
                      </td>
                      <td className="px-4 py-3"></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {timesheets.length === 0 ? (
              <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500 text-sm">
                Chưa có dữ liệu chấm công trong ngày này
              </div>
            ) : (
              timesheets.map((timesheet) => (
                <div key={timesheet.id} className="bg-gradient-to-br from-white to-gray-50 rounded-xl shadow-md border border-gray-200 p-4 hover:shadow-lg transition-all duration-300">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-600 space-y-0.5">
                        <p>
                          <span className="font-medium">Ngày:</span>{' '}
                          {formatLocalDate(timesheet.check_in)}
                        </p>
                        <p>
                          <span className="font-medium">Check-in:</span>{' '}
                          {formatLocalTime(timesheet.check_in)}
                        </p>
                        {timesheet.check_out && (
                          <>
                            <p>
                              <span className="font-medium">Check-out:</span>{' '}
                              {formatLocalTime(timesheet.check_out)}
                            </p>
                            <p>
                              <span className="font-medium">Giờ:</span>{' '}
                              {(parseFloat(timesheet.regular_hours || 0) + parseFloat(timesheet.overtime_hours || 0)).toFixed(2)}h
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {!timesheet.check_out ? (
                        <div className="px-2 py-1 bg-yellow-100 text-yellow-800 rounded text-[10px] font-medium">
                          Đang làm việc
                        </div>
                      ) : timesheet.revenue_amount ? (
                        <div className="text-right">
                          <div className="text-xs text-gray-600 mb-0.5">Doanh thu ca</div>
                          <div className="text-base font-bold text-green-600">
                            {VND_FORMAT.format(parseFloat(timesheet.revenue_amount) || 0)} đ
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )
      )}

      {/* Check-out Modal */}
      {showCheckoutModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center z-50 pb-16 sm:pb-0">
          <div className="bg-white rounded-t-xl sm:rounded-xl max-w-md w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="flex-shrink-0 p-3 sm:p-4 border-b border-gray-200">
              <h2 className="text-base sm:text-lg font-bold text-gray-900">Kết thúc ca làm việc</h2>
              {closingShift && (
                <p className="text-xs text-gray-600 mt-1">
                  Ca check-in {formatLocalDate(closingShift.check_in, 'dd/MM/yyyy HH:mm')}
                  {closingShift.employee_name ? ` — ${closingShift.employee_name}` : ''}
                </p>
              )}
              {closingShift && openShifts.length > 1 && openShifts[0]?.id !== closingShift.id && (
                <p className="text-[11px] text-blue-700 mt-1 bg-blue-50 border border-blue-200 rounded px-2 py-1">
                  Đây là <strong>ca phụ</strong> — chỉ chấm giờ công. Doanh thu &amp; két tiền được tính khi ca chính check-out.
                </p>
              )}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); handleCheckOut(); }} className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="flex-1 overflow-y-auto min-h-0 px-3 sm:px-4 py-2 sm:py-3 space-y-2 sm:space-y-3">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                    Giờ ra <span className="text-gray-500 font-normal">(để trống = thời điểm hiện tại; dùng khi bù ca hôm trước)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={checkoutOutAt}
                    onChange={(e) => setCheckoutOutAt(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-blue-500 focus:ring-1 focus:ring-blue-200 touch-manipulation"
                  />
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 sm:p-3">
                  <div className="text-xs text-blue-700 mb-1">
                    <span className="font-medium">Doanh thu ca từ đơn hàng:</span>
                    {expectedOrderCount > 0 ? (
                      <span> {expectedOrderCount} đơn</span>
                    ) : (
                      <span> Chưa có đơn</span>
                    )}
                  </div>
                  <div className="text-lg sm:text-xl font-bold text-blue-600 break-words">
                    {VND_FORMAT.format(expectedRevenue || 0)} đ
                  </div>
                </div>

                {/* Số tiền đã rút trong ca (từ đơn) - chỉ hiển thị */}
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 sm:p-3">
                  <div className="text-xs text-amber-700 mb-1">
                    <span className="font-medium">Số tiền đã rút (từ đơn):</span>
                  </div>
                  <div className="text-lg sm:text-xl font-bold text-amber-700 break-words">
                    {VND_FORMAT.format(totalWithdrawn || 0)} đ
                  </div>
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                    Số tiền rút (khi checkout) <span className="text-gray-500 font-normal">(tùy chọn)</span>
                  </label>
                  <MoneyInput
                    value={checkoutWithdrawnAmount}
                    onChange={setCheckoutWithdrawnAmount}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-amber-500 focus:ring-1 focus:ring-amber-200 transition-all touch-manipulation"
                    placeholder="Nhập số tiền rút khi kết thúc ca"
                  />
                </div>

                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                    Tiền mặt thực đếm trong két (đ) *
                  </label>
                  <MoneyInput
                    value={revenueAmount}
                    onChange={setRevenueAmount}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-blue-500 focus:ring-1 focus:ring-blue-200 transition-all touch-manipulation"
                    placeholder="Nhập số tiền mặt đang có trong két"
                    required
                    autoFocus
                  />
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 sm:p-3 space-y-1.5">
                  <div className="flex justify-between gap-3 text-xs text-emerald-900">
                    <span>Quỹ đầu ca</span>
                    <strong>{formatMoney(cashDrawerSummary?.opening_cash_amount || 0)}</strong>
                  </div>
                  <div className="flex justify-between gap-3 text-xs text-emerald-900">
                    <span>Tiền mặt thu đơn</span>
                    <strong>{formatMoney(cashDrawerSummary?.cash_payment_amount || 0)}</strong>
                  </div>
                  <div className="flex justify-between gap-3 text-xs text-emerald-900">
                    <span>Nhập thêm</span>
                    <strong>{formatMoney(cashDrawerSummary?.cash_in_amount || 0)}</strong>
                  </div>
                  <div className="flex justify-between gap-3 text-xs text-emerald-900">
                    <span>Trừ khỏi két</span>
                    <strong>{formatMoney(cashDrawerSummary?.cash_out_amount || 0)}</strong>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-emerald-200 pt-2 text-sm text-emerald-950">
                    <span className="font-medium">TMK dự kiến</span>
                    <strong>{formatMoney(cashDrawerSummary?.expected_cash_amount || 0)}</strong>
                  </div>
                </div>
                <div className={`rounded-lg border p-2.5 ${
                  (parseFloat(revenueAmount) || 0) - (parseFloat(cashDrawerSummary?.expected_cash_amount) || 0) < 0
                    ? 'border-red-200 bg-red-50 text-red-800'
                    : (parseFloat(revenueAmount) || 0) - (parseFloat(cashDrawerSummary?.expected_cash_amount) || 0) > 0
                      ? 'border-blue-200 bg-blue-50 text-blue-800'
                      : 'border-gray-200 bg-gray-50 text-gray-700'
                }`}>
                  <div className="flex justify-between gap-3 text-sm">
                    <span>Chênh lệch két</span>
                    <strong>
                      {formatMoney((parseFloat(revenueAmount) || 0) - (parseFloat(cashDrawerSummary?.expected_cash_amount) || 0))}
                    </strong>
                  </div>
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                    Nhân viên bù tiền thiếu <span className="text-gray-500 font-normal">(nếu có)</span>
                  </label>
                  <MoneyInput
                    value={cashShortagePaidAmount}
                    onChange={setCashShortagePaidAmount}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-red-500 focus:ring-1 focus:ring-red-200 transition-all touch-manipulation"
                    placeholder="Nhập số tiền nhân viên bù"
                  />
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                    Ghi chú (tùy chọn)
                  </label>
                  <textarea 
                    value={checkoutNote}
                    onChange={(e) => setCheckoutNote(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 transition-all resize-none"
                    rows="2"
                    placeholder="Ghi chú..."
                  />
                </div>
              </div>
              <div className="flex-shrink-0 flex flex-col gap-2 p-3 sm:p-4 border-t border-gray-200 bg-gray-50">
                <button
                  type="submit"
                  disabled={checkOutSubmitting}
                  className="w-full bg-red-600 text-white py-2 rounded-lg hover:bg-red-700 active:bg-red-800 font-medium text-sm shadow-sm transition-all touch-manipulation disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {checkOutSubmitting ? '⏳ Đang xử lý...' : 'Xác nhận Check-out'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCheckoutModal(false);
                    setRevenueAmount('');
                    setCheckoutNote('');
                    setCheckoutWithdrawnAmount('');
                    setCheckoutOutAt('');
                    setClosingTimesheetId(null);
                    setClosingShift(null);
                    setCashDrawerSummary(null);
                    setCashShortagePaidAmount('');
                    setExpectedRevenue(0);
                    setExpectedOrderCount(0);
                    setTotalWithdrawn(0);
                  }}
                  className="w-full bg-gray-200 text-gray-800 py-2 rounded-lg hover:bg-gray-300 active:bg-gray-400 font-medium text-sm transition-all touch-manipulation"
                >
                  Hủy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showCashDrawerModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-3 z-50">
          <div className="bg-white rounded-xl max-w-sm w-full shadow-2xl">
            <div className="p-4 border-b border-gray-200">
              <h2 className="text-lg font-bold text-gray-900">
                {cashDrawerAction === 'cash-in' ? 'Nhập thêm tiền quỹ' : 'Trừ tiền khỏi két'}
              </h2>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Số tiền *</label>
                <MoneyInput
                  value={cashDrawerAmount}
                  onChange={setCashDrawerAmount}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                  placeholder="Nhập số tiền"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Lý do {cashDrawerAction === 'cash-out' ? '*' : <span className="text-gray-500 font-normal">(tùy chọn)</span>}
                </label>
                <textarea
                  value={cashDrawerReason}
                  onChange={(e) => setCashDrawerReason(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 resize-none"
                  rows="3"
                  placeholder={cashDrawerAction === 'cash-in' ? 'Ví dụ: nạp thêm tiền lẻ để thối khách' : 'Ví dụ: mua đồ ăn, đưa shipper...'}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 p-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => setShowCashDrawerModal(false)}
                className="rounded-lg bg-gray-200 py-2 text-sm font-medium text-gray-800 hover:bg-gray-300"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleCashDrawerSubmit}
                disabled={cashDrawerSubmitting}
                className={`rounded-lg py-2 text-sm font-medium text-white disabled:opacity-60 disabled:cursor-not-allowed ${
                  cashDrawerAction === 'cash-in' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'
                }`}
              >
                {cashDrawerSubmitting ? '⏳ Đang xử lý...' : 'Xác nhận'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Salary Adjust Modal (± thưởng/phạt) */}
      {adjustEmployee && (
        <SalaryAdjustModal
          employee={adjustEmployee}
          onClose={() => setAdjustEmployee(null)}
          onChanged={loadPayroll}
        />
      )}

      {/* Check-in Modal */}
      {showCheckinModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-2 sm:p-3 z-50 overflow-y-auto overflow-x-hidden">
          <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] flex flex-col my-auto shadow-2xl">
            <div className="flex items-center justify-between p-4 sm:p-5 pb-3 border-b border-gray-200 flex-shrink-0">
              <h2 className="text-base sm:text-lg font-bold truncate pr-2">
                {openShifts.length > 0 ? 'Check-in thêm nhân viên' : 'Mở ca làm việc'}
              </h2>
              <button
                onClick={() => {
                  setShowCheckinModal(false);
                  setSelectedEmployee('');
                  setCheckinNote('');
                  setOpeningCashAmount('');
                }}
                className="text-gray-500 hover:text-gray-700 text-xl w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 touch-manipulation"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-5">
              <div className="space-y-3 min-w-0 py-2">
              {(() => {
                const employeeIdFromToken = getEmployeeId();
                const isAdditional = openShifts.length > 0;
                // Nhân viên đang có ca mở thì không thể check-in thêm lần nữa
                const busyEmployeeIds = new Set(openShifts.map((s) => s.employee_id).filter(Boolean));
                const availableEmployees = employees.filter((emp) => !busyEmployeeIds.has(emp.id));
                const selectedEmployeeInfo = employees.find(emp => emp.id === parseInt(selectedEmployee || employeeIdFromToken || '0'));

                // Tài khoản cá nhân (hoặc đã chọn nhân viên khi login): hiển thị
                // cố định — không được check-in hộ người khác
                if (employeeIdFromToken && selectedEmployeeInfo) {
                  return (
                    <div className="min-w-0">
                      <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                        Nhân viên
                      </label>
                      <div className="w-full min-w-0 px-3 py-2 border rounded-lg text-sm bg-gray-50 break-words">
                        {selectedEmployeeInfo.name} {selectedEmployeeInfo.phone ? `(${selectedEmployeeInfo.phone})` : ''}
                      </div>
                      <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5">
                        Tài khoản của bạn — check-in cho chính mình
                      </p>
                    </div>
                  );
                }

                if (availableEmployees.length > 0) {
                  return (
                    <div className="min-w-0">
                      <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                        Chọn nhân viên <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={selectedEmployee}
                        onChange={(e) => setSelectedEmployee(e.target.value)}
                        className="w-full min-w-0 px-3 py-2 border rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                      >
                        <option value="">-- Chọn tên của bạn --</option>
                        {availableEmployees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.name} {emp.phone ? `(${emp.phone})` : ''}
                          </option>
                        ))}
                      </select>
                      {isAdditional ? (
                        <div className="mt-2 p-2 bg-blue-50 rounded-lg border border-blue-200">
                          <p className="text-[10px] sm:text-xs text-blue-700">
                            Bạn đang check-in <strong>thêm người</strong> vào ca đang mở. Giờ công được chấm riêng cho từng người; doanh thu và két tiền tính vào <strong>ca chính</strong>.
                          </p>
                        </div>
                      ) : (
                        <div className="mt-2 p-2 bg-blue-50 rounded-lg border border-blue-200">
                          <p className="text-[10px] sm:text-xs text-blue-800 font-medium mb-1">
                            💡 Lưu ý khi nhiều người cùng làm việc:
                          </p>
                          <p className="text-[10px] sm:text-xs text-blue-700">
                            Mỗi nhân viên phải chọn <strong>tên của mình</strong> khi check-in. Sau khi mở ca, dùng nút <strong>+ Check-in thêm nhân viên</strong> để người tiếp theo vào ca.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                }
                if (employees.length > 0) {
                  return (
                    <div className="min-w-0">
                      <div className="p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                        <p className="text-xs sm:text-sm text-yellow-800 font-medium mb-1">
                          ⚠️ Tất cả nhân viên đều đang có ca mở
                        </p>
                        <p className="text-[10px] sm:text-xs text-yellow-700">
                          Không còn nhân viên nào để check-in thêm. Check-out ca cũ trước, hoặc liên hệ admin để thêm nhân viên mới.
                        </p>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="min-w-0">
                    <div className="p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                      <p className="text-xs sm:text-sm text-yellow-800 font-medium mb-1">
                        ⚠️ Chưa có danh sách nhân viên
                      </p>
                      <p className="text-[10px] sm:text-xs text-yellow-700">
                        Nếu nhiều người cùng làm việc, vui lòng liên hệ admin để thêm nhân viên vào danh sách. Mỗi nhân viên cần chọn tên mình khi check-in.
                      </p>
                    </div>
                  </div>
                );
              })()}
              {openShifts.length === 0 && (
                <div className="min-w-0">
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                    Nhập quỹ đầu ca <span className="text-gray-500 text-[10px]">(tiền lẻ trong két)</span>
                  </label>
                  <MoneyInput
                    value={openingCashAmount}
                    onChange={setOpeningCashAmount}
                    className="w-full min-w-0 px-3 py-2 border rounded-lg text-base focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                    placeholder="Ví dụ: 500.000"
                  />
                </div>
              )}
              <div className="min-w-0">
                <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-1">
                  Ghi chú <span className="text-gray-500 text-[10px]">(tùy chọn)</span>
                </label>
                <textarea
                  value={checkinNote}
                  onChange={(e) => setCheckinNote(e.target.value)}
                  className="w-full min-w-0 px-3 py-2 border rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-200 resize-none"
                  rows="2"
                  placeholder="Ghi chú về ca làm việc..."
                />
              </div>
              </div>
            </div>
            <div className="flex flex-row gap-2 px-4 sm:px-5 pb-4 pt-2 border-t border-gray-200 flex-shrink-0">
              <button
                onClick={handleCheckIn}
                disabled={checkInSubmitting}
                className="flex-1 min-w-0 bg-gradient-to-r from-green-500 to-green-600 text-white py-2.5 rounded-lg hover:from-green-600 hover:to-green-700 active:from-green-700 active:to-green-800 font-medium text-sm shadow-md transition-all touch-manipulation disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {checkInSubmitting ? '⏳ Đang xử lý...' : '✓ Xác nhận'}
              </button>
              <button
                onClick={() => {
                  setShowCheckinModal(false);
                  setSelectedEmployee('');
                  setCheckinNote('');
                  setOpeningCashAmount('');
                }}
                className="flex-1 min-w-0 bg-gray-200 text-gray-800 py-2.5 rounded-lg hover:bg-gray-300 active:bg-gray-400 font-medium text-sm transition-all touch-manipulation"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Timesheets;
