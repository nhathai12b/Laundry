import { formatLocalDate, formatLocalDateKey } from '../utils/dateTime';

// Báo cáo "Dòng tiền két" của một cửa hàng trong một ngày — dữ liệu từ
// GET /reports/cash-drawer-timeline. Mỗi người đứng ca có một màu riêng, dùng
// chung ở mọi bảng để nhìn là biết tiền đang nằm trong két của ai.

const PERSON_COLORS = [
  { chip: 'bg-indigo-100 text-indigo-800 border-indigo-300', dot: 'bg-indigo-500' },
  { chip: 'bg-teal-100 text-teal-800 border-teal-300', dot: 'bg-teal-500' },
  { chip: 'bg-orange-100 text-orange-800 border-orange-300', dot: 'bg-orange-500' },
  { chip: 'bg-pink-100 text-pink-800 border-pink-300', dot: 'bg-pink-500' },
  { chip: 'bg-lime-100 text-lime-800 border-lime-300', dot: 'bg-lime-600' },
];
const FALLBACK_COLOR = { chip: 'bg-gray-100 text-gray-700 border-gray-300', dot: 'bg-gray-400' };

const money = (n) => `${new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0))} đ`;

const EVENT_ICON = {
  carry_over: '↪️',
  check_in: '🟢',
  check_out: '🔴',
  opening_float: '💵',
  handover_in: '🔁',
  closing_count: '🔒',
  shortage_reimbursement: '🩹',
};
const MONEY_ICON = {
  cash_payment: '🧾',
  transfer: '🏦',
  cash_in: '➕',
  cash_out: '➖',
  cash_outside: '⚠️',
};

const STATUS_BADGE = {
  open: { text: 'Đang giữ két', cls: 'bg-emerald-100 text-emerald-800' },
  handed_over: { text: 'Đã bàn giao', cls: 'bg-indigo-100 text-indigo-800' },
  closed: { text: 'Đã chốt két', cls: 'bg-gray-100 text-gray-700' },
  auto_closed: { text: 'Tự đóng — chưa đếm két', cls: 'bg-red-100 text-red-700' },
  unknown: { text: '—', cls: 'bg-gray-100 text-gray-600' },
};

function PersonChip({ name, color }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-semibold whitespace-nowrap ${color.chip}`}>
      <span className={`w-2 h-2 rounded-full ${color.dot}`} />
      {name}
    </span>
  );
}

function CashDrawerTimeline({ timeline, selectedDate, onOpenShift, selectedShiftId }) {
  if (!timeline) return null;

  const { people = [], drawers = [], events = [], totals = {} } = timeline;
  // Màu theo NGƯỜI (tên), không theo ca — cùng một người có 2 ca trong ngày
  // (ca hôm trước quên check-out + ca hôm nay) vẫn cùng một màu
  const colorByName = new Map();
  const colorByTimesheet = new Map();
  [...people, ...drawers].forEach((p) => {
    if (!colorByName.has(p.employee_name)) {
      colorByName.set(p.employee_name, PERSON_COLORS[colorByName.size % PERSON_COLORS.length]);
    }
    colorByTimesheet.set(p.timesheet_id, colorByName.get(p.employee_name));
  });
  const colorOf = (tsId) => colorByTimesheet.get(tsId) || FALLBACK_COLOR;
  const drawerCount = (name) => drawers.filter((d) => d.employee_name === name).length;
  const personName = (tsId) => people.find((p) => p.timesheet_id === tsId)?.employee_name
    || drawers.find((d) => d.timesheet_id === tsId)?.employee_name
    || '';

  // Mốc giờ ngoài ngày đang xem (ca vào hôm trước / ra hôm sau) thì kèm ngày
  const timeLabel = (iso) => (formatLocalDateKey(iso) === selectedDate
    ? formatLocalDate(iso, 'HH:mm')
    : formatLocalDate(iso, 'dd/MM HH:mm'));

  const warnings = [];
  if ((totals.cash_outside_drawer || 0) > 0) {
    warnings.push(`Có ${money(totals.cash_outside_drawer)} tiền mặt thu lúc KHÔNG có ai đứng ca — số tiền này không nằm trong két nào.`);
  }
  drawers.filter((d) => d.status === 'auto_closed').forEach((d) => {
    warnings.push(`${d.employee_name} quên check-out${d.check_in ? ` (ca vào ${timeLabel(d.check_in)})` : ''} — hệ thống tự đóng ca, két KHÔNG được đếm (giờ công = 0).`);
  });
  drawers.filter((d) => d.difference != null && Math.abs(d.difference) >= 1).forEach((d) => {
    warnings.push(`Két của ${d.employee_name} ${d.difference < 0 ? 'thiếu' : 'thừa'} ${money(Math.abs(d.difference))} khi chốt${d.shortage_reimbursement > 0 ? ` (đã bù ${money(d.shortage_reimbursement)})` : ''}.`);
  });

  if (people.length === 0 && events.length === 0) {
    return (
      <div className="p-12 text-center text-gray-500">
        <div className="text-4xl mb-4">🗓️</div>
        <div>Không có ca làm việc hay giao dịch nào trong ngày này.</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
        <p className="font-semibold mb-1">Cách đọc báo cáo</p>
        <ul className="list-disc list-inside space-y-0.5 text-xs sm:text-sm">
          <li>Két tiền thuộc về <strong>người mở ca sớm nhất còn đang trong ca</strong>. Người vào thêm không có két riêng — tiền mặt khách trả đều vào két của người đang giữ.</li>
          <li>Khi người giữ két check-out: đếm két, rồi <strong>bàn giao</strong> cho người còn lại (số đếm + tiền bù thiếu nếu có trở thành quỹ của người nhận) hoặc kết sổ.</li>
          <li>Cột <strong>Tồn két</strong> là số tiền dự kiến trong két của người đó ngay sau dòng tương ứng.</li>
        </ul>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 space-y-1">
          {warnings.map((w, i) => <p key={i}>⚠️ {w}</p>)}
        </div>
      )}

      <section>
        <h3 className="text-base font-bold text-gray-800 mb-2">Người đứng ca</h3>
        {people.length === 0 ? (
          <p className="text-sm text-gray-500">Không ai check-in trong ngày.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-200 rounded-lg">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase">Nhân viên</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase">Vào</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase">Ra</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase">Vai trò</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-600 uppercase">Giờ công</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {people.map((p) => (
                  <tr
                    key={p.timesheet_id}
                    onClick={() => onOpenShift?.(p.timesheet_id)}
                    title="Bấm để xem báo cáo ca"
                    className={`cursor-pointer ${p.timesheet_id === selectedShiftId ? 'bg-blue-100' : 'hover:bg-blue-50'}`}
                  >
                    <td className="px-3 py-2"><PersonChip name={p.employee_name} color={colorOf(p.timesheet_id)} /></td>
                    <td className="px-3 py-2 text-gray-700">{timeLabel(p.check_in)}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {p.is_open
                        ? <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-xs font-medium">Đang trong ca</span>
                        : p.auto_closed
                          ? <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 text-xs font-medium">Quên check-out</span>
                          : timeLabel(p.check_out)}
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {p.role === 'opened' ? 'Mở ca & giữ két' : `Vào thêm (két do ${p.joined_drawer_of} giữ)`}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700">{p.is_open ? '—' : `${p.hours}h`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {drawers.length > 0 && (
        <section>
          <h3 className="text-base font-bold text-gray-800 mb-2">Két tiền</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {drawers.map((d) => {
              const badge = STATUS_BADGE[d.status] || STATUS_BADGE.unknown;
              const expected = d.expected_at_close ?? d.balance;
              return (
                <div
                  key={d.timesheet_id}
                  onClick={() => onOpenShift?.(d.timesheet_id)}
                  title="Bấm để xem báo cáo ca"
                  className={`rounded-lg border p-3 bg-white cursor-pointer hover:border-blue-400 hover:shadow-md transition ${
                    d.timesheet_id === selectedShiftId ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <PersonChip name={d.employee_name} color={colorOf(d.timesheet_id)} />
                      {d.check_in && drawerCount(d.employee_name) > 1 && (
                        <span className="text-[11px] text-gray-500 whitespace-nowrap">ca vào {timeLabel(d.check_in)}</span>
                      )}
                    </div>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${badge.cls}`}>
                      {d.status === 'handed_over' && d.handed_to ? `Bàn giao cho ${d.handed_to}` : badge.text}
                    </span>
                  </div>
                  <dl className="text-xs sm:text-sm space-y-1">
                    {d.carried_in !== 0 && (
                      <div className="flex justify-between"><dt className="text-gray-600">Tồn đầu ngày</dt><dd>{money(d.carried_in)}</dd></div>
                    )}
                    {d.opening_float > 0 && (
                      <div className="flex justify-between"><dt className="text-gray-600">Quỹ đầu ca</dt><dd>{money(d.opening_float)}</dd></div>
                    )}
                    {d.received_handover > 0 && (
                      <div className="flex justify-between"><dt className="text-gray-600">Nhận bàn giao từ {d.received_from}</dt><dd>{money(d.received_handover)}</dd></div>
                    )}
                    <div className="flex justify-between"><dt className="text-gray-600">+ Thu tiền mặt</dt><dd className="text-green-700">{money(d.cash_payment)}</dd></div>
                    {d.cash_in > 0 && (
                      <div className="flex justify-between"><dt className="text-gray-600">+ Nhập thêm</dt><dd className="text-green-700">{money(d.cash_in)}</dd></div>
                    )}
                    {d.cash_out > 0 && (
                      <div className="flex justify-between"><dt className="text-gray-600">− Chi / rút</dt><dd className="text-red-600">{money(d.cash_out)}</dd></div>
                    )}
                    <div className="flex justify-between border-t border-gray-200 pt-1 font-semibold">
                      <dt>{d.closed ? 'Dự kiến khi chốt' : 'Hiện đang có (dự kiến)'}</dt>
                      <dd>{money(expected)}</dd>
                    </div>
                    {d.closed && !d.auto_closed && (
                      <>
                        <div className="flex justify-between"><dt className="text-gray-600">Đếm thực tế</dt><dd>{money(d.counted)}</dd></div>
                        <div className="flex justify-between">
                          <dt className="text-gray-600">Chênh lệch</dt>
                          <dd className={d.difference < 0 ? 'text-red-600 font-semibold' : d.difference > 0 ? 'text-blue-600 font-semibold' : ''}>
                            {money(d.difference)}
                          </dd>
                        </div>
                        {d.shortage_reimbursement > 0 && (
                          <div className="flex justify-between"><dt className="text-gray-600">Nhân viên bù thiếu</dt><dd>{money(d.shortage_reimbursement)}</dd></div>
                        )}
                      </>
                    )}
                    {d.auto_closed && (
                      <p className="text-red-600 pt-1">Không ai đếm két khi đóng ca.</p>
                    )}
                  </dl>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h3 className="text-base font-bold text-gray-800 mb-2">Diễn biến theo thời gian</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded-lg">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase">Giờ</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase">Sự kiện</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-600 uppercase">Két của</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-600 uppercase">Tiền vào</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-600 uppercase">Tiền ra</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-600 uppercase">Tồn két</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {events.map((e, idx) => {
                const isPersonEvent = e.kind === 'check_in' || e.kind === 'check_out';
                const icon = e.kind === 'money' ? (MONEY_ICON[e.tx_type] || '•') : (EVENT_ICON[e.kind] || '•');
                const rowCls = e.warning
                  ? 'bg-red-50'
                  : e.kind === 'handover_in' || e.kind === 'closing_count'
                    ? 'bg-indigo-50'
                    : isPersonEvent
                      ? 'bg-gray-50'
                      : '';
                const noDrawerMoney = !e.drawer_timesheet_id && e.amount_in != null;
                // Sự kiện check-in/out: tên người (đầu label) hiện thành chip màu
                const pName = isPersonEvent ? personName(e.person_timesheet_id) : '';
                const showChip = Boolean(pName) && e.label.startsWith(pName);
                const labelText = showChip ? e.label.slice(pName.length).trim() : e.label;
                return (
                  <tr key={`${e.at}-${idx}`} className={rowCls}>
                    <td className="px-3 py-2 text-gray-700 whitespace-nowrap align-top">{timeLabel(e.at)}</td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-start gap-2">
                        <span aria-hidden="true">{icon}</span>
                        <div className="min-w-0">
                          <div className={isPersonEvent ? 'font-medium text-gray-800' : 'text-gray-800'}>
                            {showChip && <PersonChip name={pName} color={colorOf(e.person_timesheet_id)} />}
                            <span className={showChip ? 'ml-1.5' : ''}>{labelText}</span>
                          </div>
                          {e.kind === 'closing_count' && e.counted != null && (
                            <div className="text-xs text-gray-600 mt-0.5">
                              Dự kiến {money(e.expected)} · Đếm {money(e.counted)} ·{' '}
                              <span className={e.difference < 0 ? 'text-red-600 font-semibold' : e.difference > 0 ? 'text-blue-600 font-semibold' : ''}>
                                Lệch {money(e.difference)}
                              </span>
                            </div>
                          )}
                          {e.detail && <div className="text-xs text-gray-500 mt-0.5">{e.detail}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      {e.drawer_timesheet_id
                        ? <PersonChip name={e.drawer_name} color={colorOf(e.drawer_timesheet_id)} />
                        : noDrawerMoney
                          ? <span className="text-xs text-gray-500">Không vào két</span>
                          : null}
                    </td>
                    <td className={`px-3 py-2 text-right align-top whitespace-nowrap ${noDrawerMoney ? 'text-blue-600' : 'text-green-700'}`}>
                      {e.amount_in != null ? `+${money(e.amount_in)}` : ''}
                    </td>
                    <td className="px-3 py-2 text-right align-top whitespace-nowrap text-red-600">
                      {e.amount_out != null ? `−${money(e.amount_out)}` : ''}
                    </td>
                    <td className="px-3 py-2 text-right align-top whitespace-nowrap font-semibold text-gray-900">
                      {e.balance_after != null ? money(e.balance_after) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-green-200 bg-green-50 p-3">
          <div className="text-xs text-green-800">Tiền mặt khách trả vào két</div>
          <div className="text-lg font-bold text-green-700">{money(totals.cash_payment_into_drawers)}</div>
        </div>
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="text-xs text-blue-800">Chuyển khoản (không vào két)</div>
          <div className="text-lg font-bold text-blue-700">{money(totals.transfer)}</div>
        </div>
        <div className={`rounded-lg border p-3 ${(totals.cash_outside_drawer || 0) > 0 ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
          <div className="text-xs text-gray-700">Tiền mặt ngoài két (không ai đứng ca)</div>
          <div className={`text-lg font-bold ${(totals.cash_outside_drawer || 0) > 0 ? 'text-red-600' : 'text-gray-500'}`}>{money(totals.cash_outside_drawer)}</div>
        </div>
      </section>
    </div>
  );
}

export default CashDrawerTimeline;
