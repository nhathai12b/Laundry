import { format } from 'date-fns';

export const toLocalDateTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatLocalDate = (value, pattern = 'dd/MM/yyyy') => {
  const date = toLocalDateTime(value);
  return date ? format(date, pattern) : '';
};

export const formatLocalTime = (value) => {
  const date = toLocalDateTime(value);
  return date
    ? date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
};

export const formatLocalDateKey = (value) => {
  const date = toLocalDateTime(value);
  return date ? format(date, 'yyyy-MM-dd') : '';
};

export const parseLocalDateKey = (dateKey) => {
  if (!dateKey) return null;
  const date = new Date(`${String(dateKey).slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatLocalDateKeyDisplay = (dateKey, options) => {
  const date = parseLocalDateKey(dateKey);
  return date ? date.toLocaleDateString('vi-VN', options) : '';
};

export const isTodayLocalDateKey = (dateKey) => {
  const date = parseLocalDateKey(dateKey);
  return date ? date.toDateString() === new Date().toDateString() : false;
};

export const localInputToIso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const isoToLocalInput = (value) => {
  const date = toLocalDateTime(value);
  return date ? format(date, "yyyy-MM-dd'T'HH:mm") : '';
};

export const getLocalDateRangeUtc = (dateKey) => {
  const start = new Date(`${dateKey}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    start_at: start.toISOString(),
    end_at: end.toISOString(),
  };
};

export const getLocalMonthRangeUtc = (year, month) => {
  const start = new Date(Number(year), Number(month) - 1, 1);
  const end = new Date(Number(year), Number(month), 1);
  return {
    start_at: start.toISOString(),
    end_at: end.toISOString(),
  };
};

export const getLocalYearRangeUtc = (year) => {
  const start = new Date(Number(year), 0, 1);
  const end = new Date(Number(year) + 1, 0, 1);
  return {
    start_at: start.toISOString(),
    end_at: end.toISOString(),
  };
};

export const getLocalIsoWeekRangeUtc = (year, week) => {
  const simple = new Date(Number(year), 0, 1 + (Number(week) - 1) * 7);
  const day = simple.getDay();
  const start = new Date(simple);
  if (day <= 4) {
    start.setDate(simple.getDate() - day + 1);
  } else {
    start.setDate(simple.getDate() + 8 - day);
  }
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return {
    start_at: start.toISOString(),
    end_at: end.toISOString(),
  };
};
