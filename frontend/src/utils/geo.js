/**
 * Lấy vị trí GPS của thiết bị (dùng cho chấm công tại tiệm).
 *
 * getCurrentPosition(): trả {latitude, longitude, accuracy} hoặc THROW
 *   với message tiếng Việt — dùng khi bắt buộc phải có vị trí
 *   (nút "Lấy vị trí hiện tại" trong cài đặt cửa hàng).
 *
 * getPositionBestEffort(): trả tọa độ hoặc {} nếu không lấy được — dùng cho
 *   check-in/check-out: client không biết tiệm có bật kiểm soát GPS hay
 *   không, cứ gửi kèm nếu có; backend chỉ chặn khi tiệm CÓ đặt tọa độ.
 */
export const getCurrentPosition = () =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Thiết bị/trình duyệt không hỗ trợ định vị GPS.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      (err) => {
        if (err.code === 1) {
          reject(new Error('Bạn đã từ chối quyền vị trí. Vui lòng bật định vị cho trình duyệt (Cài đặt → Quyền → Vị trí) rồi thử lại.'));
        } else if (err.code === 3) {
          reject(new Error('Lấy vị trí quá lâu. Vui lòng thử lại ở nơi thoáng hơn.'));
        } else {
          reject(new Error('Không lấy được vị trí. Vui lòng bật GPS rồi thử lại.'));
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });

export const getPositionBestEffort = async () => {
  try {
    return await getCurrentPosition();
  } catch (error) {
    return {};
  }
};
