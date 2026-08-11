# Font in bill (tiếng Việt)

Để in bill Bluetooth **đúng chữ tiếng Việt có dấu**, backend cần font hỗ trợ Unicode tiếng Việt.

## Server Linux (khuyến nghị)

**Cách 1 – Cài font trên server**

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y fonts-dejavu-core fonts-noto-core

# Hoặc chỉ DejaVu (nhẹ, có tiếng Việt)
sudo apt-get install -y fonts-dejavu-core
```

Sau khi cài, khởi động lại backend. Code sẽ tự dùng DejaVu hoặc Noto nếu có.

**Cách 2 – Đặt font trong thư mục deploy (Linux: /var/www/laundry-backend)**

1. Trên server: `mkdir -p /var/www/laundry-backend/fonts`
2. Copy file `.ttf` vào `/var/www/laundry-backend/fonts/` (tên ví dụ: `NotoSans-Regular.ttf`, `arial.ttf`).
3. Khởi động lại backend.

Deploy ở path khác: set `APP_ROOT=/đường/dẫn/backend` → backend đọc font từ `APP_ROOT/fonts`.

**Cách 3 – Đặt font trong thư mục này (backend/fonts)**  
Copy file `.ttf` vào đây, restart backend.

## Windows

Backend tự dùng `C:\Windows\Fonts\arial.ttf`. Nếu vẫn lỗi, copy `arial.ttf` vào thư mục này.
