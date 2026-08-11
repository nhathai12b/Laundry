/**
 * Hiển thị khi admin đăng nhập từ điện thoại/màn hình nhỏ.
 * Trang admin chưa responsive nên chỉ cho phép truy cập từ máy tính.
 */
function DesktopOnlyScreen() {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-gray-800/95 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Chỉ hỗ trợ máy tính</h1>
        <p className="text-gray-600 mb-3">
          Tài khoản admin chỉ được sử dụng trên máy tính (desktop/laptop).
        </p>
        <p className="text-gray-600 text-sm">
          Vui lòng truy cập từ thiết bị có màn hình lớn hơn để sử dụng trang quản trị.
        </p>
      </div>
    </div>
  );
}

export default DesktopOnlyScreen;
