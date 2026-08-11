/**
 * Utility to persist filter state (store, month, year) across pages
 */

const STORAGE_KEY = 'laundry66_filters';

/**
 * Get saved filter state from localStorage
 * @returns {Object} { selectedStoreId, selectedMonth, selectedYear }
 */
export const getSavedFilters = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const clampToNow = (month, year) => {
      const m = parseInt(month) || currentMonth;
      const y = parseInt(year) || currentYear;
      // If saved filter points to a future month/year, clamp to current
      if (y > currentYear || (y === currentYear && m > currentMonth)) {
        return { month: currentMonth, year: currentYear };
      }
      return { month: m, year: y };
    };

    if (saved) {
      const parsed = JSON.parse(saved);
      const normalized = clampToNow(parsed.selectedMonth, parsed.selectedYear);
      return {
        selectedStoreId: parsed.selectedStoreId || 'all',
        selectedMonth: normalized.month,
        selectedYear: normalized.year,
      };
    }
  } catch (error) {
    console.error('Error loading saved filters:', error);
  }
  
  // Default values
  return {
    selectedStoreId: 'all',
    selectedMonth: new Date().getMonth() + 1,
    selectedYear: new Date().getFullYear(),
  };
};

/**
 * Save filter state to localStorage
 * @param {string} selectedStoreId 
 * @param {number} selectedMonth 
 * @param {number} selectedYear 
 */
export const saveFilters = (selectedStoreId, selectedMonth, selectedYear) => {
  try {
    const filters = {
      selectedStoreId: selectedStoreId || 'all',
      selectedMonth: selectedMonth || new Date().getMonth() + 1,
      selectedYear: selectedYear || new Date().getFullYear(),
    };
    // Avoid redundant writes
    const next = JSON.stringify(filters);
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev === next) return;
    localStorage.setItem(STORAGE_KEY, next);
  } catch (error) {
    console.error('Error saving filters:', error);
  }
};

/**
 * Clear saved filters
 */
export const clearSavedFilters = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Error clearing filters:', error);
  }
};
