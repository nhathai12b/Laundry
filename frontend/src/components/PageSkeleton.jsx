/**
 * Skeleton hiển thị trong lần tải đầu tiên của trang — thay cho spinner.
 * Khung xám mờ nhấp nháy mô phỏng bố cục (tiêu đề + thẻ số liệu + danh sách)
 * cho cảm giác trang "đang hình thành" thay vì màn hình trống với vòng xoay.
 */
function PageSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-hidden="true">
      <div className="h-8 w-40 rounded-lg bg-gray-200"></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-xl bg-gray-200"></div>
        ))}
      </div>
      <div className="space-y-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 rounded-xl bg-gray-100 border border-gray-200"></div>
        ))}
      </div>
    </div>
  );
}

export default PageSkeleton;
