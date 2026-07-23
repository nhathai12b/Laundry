# Chạy bằng Docker

Cách nhanh nhất để chạy toàn bộ hệ thống (MySQL + Backend + Frontend) trên máy dev hoặc VPS, không cần cài Node.js/MySQL trực tiếp.

## Yêu cầu

- Docker + Docker Compose plugin (`docker compose version` chạy được)

## Chạy lần đầu

```bash
cp .env.example .env
# Sửa .env: đặt MYSQL_ROOT_PASSWORD, JWT_SECRET (dùng: openssl rand -base64 32),
# và FRONTEND_URL nếu deploy có domain thật.

docker compose up -d --build
```

Lần đầu chạy, backend tự tạo database + toàn bộ bảng (idempotent, xem `backend/database/db.js`) — không cần chạy `init-db` thủ công.

Khi các container đã `healthy` (`docker compose ps`), tạo tài khoản root admin đầu tiên:

```bash
docker compose exec backend npm run create-root-admin
```

Script sẽ in ra số điện thoại đăng nhập (mặc định `admin` / mật khẩu `admin123`) — **đổi mật khẩu ngay sau khi đăng nhập lần đầu**.

Truy cập: `http://localhost` (hoặc `http://localhost:$HTTP_PORT` nếu đã đổi trong `.env`).

## Các lệnh thường dùng

```bash
docker compose ps                    # Trạng thái các container
docker compose logs -f backend       # Xem log backend
docker compose exec backend npm run <script>   # Chạy migration script trong backend/package.json
docker compose down                  # Dừng (giữ lại dữ liệu MySQL)
docker compose down -v               # Dừng và XÓA LUÔN dữ liệu MySQL (cẩn thận)
docker compose up -d --build         # Rebuild sau khi sửa code
```

## Kiến trúc

- `mysql` — MySQL 8, dữ liệu lưu ở volume `mysql_data` (sống sót qua `docker compose down`, mất khi thêm `-v`).
- `backend` — Node/Express, build multi-stage để biên dịch `canvas` (in bill Bluetooth) rồi chỉ giữ lại thư viện runtime + font tiếng Việt (DejaVu/Noto) trong image cuối, không cần volume font riêng.
- `frontend` — build Vite thành file tĩnh, phục vụ bằng Nginx; Nginx cũng đóng vai trò reverse proxy `/api` → `backend:5000`.

## Lưu ý khi đổi reverse proxy

Nếu deploy Docker phía sau một reverse proxy khác nữa (vd Cloudflare, hoặc Nginx ở host ngoài container) thay vì expose thẳng port 80, cần tăng số hop tin cậy trong `backend/server.js` (`app.set('trust proxy', 1)` → số hop tương ứng), nếu không rate limit đăng nhập theo IP sẽ nhận sai IP client.
