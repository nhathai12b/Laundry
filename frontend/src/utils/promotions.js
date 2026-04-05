/**
 * Số tiền giảm thực tế của một khuyến mãi với tổng đơn (đã thỏa điều kiện API).
 */
export function promotionDiscountAmount(promotion, total) {
  if (!promotion || total <= 0) return 0;
  let discount = 0;
  if (promotion.discount_type === 'percentage') {
    discount = (total * Number(promotion.discount_value)) / 100;
    if (promotion.max_discount_amount != null && promotion.max_discount_amount !== '') {
      const cap = Number(promotion.max_discount_amount);
      if (!Number.isNaN(cap) && discount > cap) discount = cap;
    }
  } else {
    discount = Number(promotion.discount_value) || 0;
  }
  return Math.max(0, discount);
}

/**
 * Chọn khuyến mãi có mức giảm cao nhất trong danh sách đã áp dụng được.
 */
export function bestApplicablePromotionId(promotions, total) {
  if (!promotions?.length || total <= 0) return '';
  let bestId = '';
  let bestDiscount = -1;
  for (const p of promotions) {
    const d = promotionDiscountAmount(p, total);
    if (d > bestDiscount) {
      bestDiscount = d;
      bestId = String(p.id);
    }
  }
  return bestId;
}
