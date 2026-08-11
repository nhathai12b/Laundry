# Hướng dẫn Khắc phục Lỗi

## Lỗi CORS: "CORS request did not succeed" với Status code: (null)

### Nguyên nhân:
Lỗi này thường xảy ra khi **backend server không chạy** hoặc **không thể kết nối được**.

### Cách khắc phục:

#### Bước 1: Kiểm tra Backend có đang chạy không

**Windows:**
```powershell
# Kiểm tra process Node.js
Get-Process node -ErrorAction SilentlyContinue

# Kiểm tra port 5000
netstat -ano | findstr :5000
```

**Linux/Mac:**
```bash
# Kiểm tra process Node.js
ps aux | grep node

# Kiểm tra port 5000
lsof -i :5000
# hoặc
netstat -tulpn | grep :5000
```

#### Bước 2: Kiểm tra cấu hình Backend

Chạy script kiểm tra:
```bash
cd backend
node check-server.js
```

Script này sẽ kiểm tra:
- ✅ Environment variables
- ✅ MySQL connection
- ✅ Port availability

#### Bước 3: Khởi động Backend

**Cách 1: Sử dụng start.bat (Windows)**
```bash
# Từ thư mục gốc
start.bat
```

**Cách 2: Khởi động thủ công**
```bash
# Terminal 1 - Backend
cd backend
npm install
npm run dev

# Terminal 2 - Frontend
cd frontend
npm install
npm run dev
```

#### Bước 4: Kiểm tra MySQL

**Windows:**
1. Mở **Services** (Win + R → `services.msc`)
2. Tìm **MySQL** service
3. Đảm bảo service đang **Running**

**Linux:**
```bash
sudo systemctl status mysql
# Nếu không chạy:
sudo systemctl start mysql
```

**Kiểm tra kết nối MySQL:**
```bash
mysql -u root -p
# Hoặc với user từ .env
mysql -u your_user -p -h localhost
```

#### Bước 5: Kiểm tra file .env

Tạo file `backend/.env` nếu chưa có:
```env
PORT=5000
NODE_ENV=development

# MySQL Configuration
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=laundry66

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this
JWT_EXPIRE=7d
```

#### Bước 6: Test Backend API

Mở browser hoặc dùng curl:
```bash
# Test health endpoint
curl http://localhost:5000/api/health

# Hoặc mở browser:
# http://localhost:5000/api/health
```

**Kết quả mong đợi:**
```json
{
  "status": "ok",
  "database": "connected",
  "memory": {...},
  "uptime": "...",
  "timestamp": "..."
}
```

#### Bước 7: Kiểm tra Browser Console

1. Mở Browser DevTools (F12)
2. Tab **Console** - xem có lỗi gì không
3. Tab **Network** - xem request có được gửi không
   - Nếu request có status `(failed)` hoặc `(pending)` → Backend không chạy
   - Nếu request có status `CORS error` → Vấn đề CORS (đã fix)

---

## Lỗi MySQL Connection

### Lỗi: "ECONNREFUSED" hoặc "Access denied"

**Nguyên nhân:**
- MySQL không chạy
- Sai username/password
- Database chưa được tạo

**Khắc phục:**

1. **Kiểm tra MySQL đang chạy:**
   ```bash
   # Windows
   Get-Service MySQL*
   
   # Linux
   sudo systemctl status mysql
   ```

2. **Tạo database:**
   ```sql
   CREATE DATABASE IF NOT EXISTS laundry66 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

3. **Kiểm tra user và quyền:**
   ```sql
   -- Xem users
   SELECT user, host FROM mysql.user;
   
   -- Tạo user mới (nếu cần)
   CREATE USER 'your_user'@'localhost' IDENTIFIED BY 'your_password';
   GRANT ALL PRIVILEGES ON laundry66.* TO 'your_user'@'localhost';
   FLUSH PRIVILEGES;
   ```

---

## Lỗi Port đã được sử dụng

### Lỗi: "EADDRINUSE: address already in use :::5000"

**Khắc phục:**

**Windows:**
```powershell
# Tìm process đang dùng port 5000
netstat -ano | findstr :5000

# Kill process (thay PID bằng số từ lệnh trên)
taskkill /PID <PID> /F
```

**Linux/Mac:**
```bash
# Tìm process
lsof -i :5000

# Kill process
kill -9 <PID>
```

---

## Lỗi Frontend không kết nối được Backend

### Kiểm tra API URL

File `frontend/src/utils/api.js`:
```javascript
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
```

**Nếu backend chạy trên port khác:**
1. Tạo file `frontend/.env.local`:
   ```env
   VITE_API_URL=http://localhost:5000/api
   ```
2. Restart frontend dev server

---

## Checklist Debug

Khi gặp lỗi CORS, kiểm tra theo thứ tự:

- [ ] Backend server có đang chạy? (`http://localhost:5000/api/health`)
- [ ] MySQL có đang chạy?
- [ ] File `.env` có đúng cấu hình?
- [ ] Database `laundry66` đã được tạo?
- [ ] Port 5000 có bị chiếm bởi process khác?
- [ ] Frontend đang gọi đúng URL? (`http://localhost:5000/api`)
- [ ] Browser console có lỗi gì khác không?

---

## Lỗi HTTPS không hoạt động

### Nguyên nhân:
- Certificate chưa được tạo hoặc đã hết hạn
- Nginx chưa được cấu hình SSL
- Firewall chưa mở port 443
- Domain chưa trỏ về đúng IP VPS

### Cách khắc phục:

#### Bước 1: Kiểm tra certificate đã được tạo

```bash
# Kiểm tra certificate
sudo ls -la /etc/letsencrypt/live/quanlycuahangabc.id.vn/

# Phải thấy:
# - fullchain.pem
# - privkey.pem
```

**Nếu không có certificate:**
```bash
# Tạo certificate bằng standalone mode
sudo systemctl stop nginx
sudo certbot certonly --standalone -d quanlycuahangabc.id.vn -d www.quanlycuahangabc.id.vn
sudo systemctl start nginx
```

#### Bước 2: Kiểm tra cấu hình Nginx có SSL

```bash
# Xem cấu hình Nginx
sudo cat /etc/nginx/conf.d/laundry-frontend.conf

# Phải thấy:
# - listen 443 ssl http2;
# - ssl_certificate /etc/letsencrypt/live/.../fullchain.pem;
# - ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;
```

**Nếu chưa có cấu hình SSL, xem hướng dẫn trong DEPLOY_MANUAL.md phần 4.1**

#### Bước 3: Kiểm tra Nginx có lỗi

```bash
# Test cấu hình
sudo nginx -t

# Xem logs lỗi
sudo tail -f /var/log/nginx/error.log
```

**Nếu có lỗi, sửa cấu hình và restart:**
```bash
sudo nginx -t
sudo systemctl restart nginx
```

#### Bước 4: Kiểm tra Firewall

```bash
# Kiểm tra firewall
sudo firewall-cmd --list-all

# Phải thấy: http, https trong services
# Nếu chưa có, thêm:
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

#### Bước 5: Kiểm tra Domain trỏ về đúng IP

```bash
# Kiểm tra IP của domain
dig +short quanlycuahangabc.id.vn

# Phải chỉ có 1 IP duy nhất (IP của VPS, ví dụ: 103.130.212.155)
# Nếu có nhiều IP hoặc IP sai, cần cập nhật A record trong DNS
```

#### Bước 6: Test HTTPS từ VPS

```bash
# Test HTTPS
curl -I https://quanlycuahangabc.id.vn

# Nếu lỗi SSL, sẽ thấy thông báo lỗi cụ thể
```

#### Bước 7: Renew Certificate (nếu hết hạn)

```bash
# Kiểm tra ngày hết hạn
sudo certbot certificates

# Renew certificate
sudo certbot renew

# Hoặc renew thủ công
sudo certbot certonly --standalone -d quanlycuahangabc.id.vn -d www.quanlycuahangabc.id.vn
```

### Các lỗi thường gặp:

**1. "SSL certificate problem" hoặc "certificate verify failed"**
- **Nguyên nhân**: Certificate chưa được tạo hoặc đường dẫn sai
- **Khắc phục**: Tạo lại certificate (xem Bước 1)

**2. "Connection refused" khi truy cập HTTPS**
- **Nguyên nhân**: Port 443 chưa mở hoặc Nginx chưa listen 443
- **Khắc phục**: 
  - Kiểm tra firewall (Bước 4)
  - Kiểm tra cấu hình Nginx có `listen 443 ssl` (Bước 2)

**3. "Domain mismatch" hoặc "certificate name mismatch"**
- **Nguyên nhân**: Domain trong certificate không khớp với domain truy cập
- **Khắc phục**: Tạo lại certificate với đúng domain

**4. "Certificate expired"**
- **Nguyên nhân**: Certificate đã hết hạn (Let's Encrypt có thời hạn 90 ngày)
- **Khắc phục**: Renew certificate (Bước 7)

**5. "404 Not Found" với `/.well-known/acme-challenge/`**
- **Nguyên nhân**: Nginx chưa được cấu hình để serve Let's Encrypt challenge
- **Khắc phục**: 
  - Thêm location block cho `/.well-known/` vào cấu hình Nginx
  - Hoặc dùng standalone mode để tạo certificate

### Kiểm tra nhanh:

```bash
# 1. Certificate có tồn tại?
sudo test -f /etc/letsencrypt/live/quanlycuahangabc.id.vn/fullchain.pem && echo "OK" || echo "MISSING"

# 2. Nginx có listen 443?
sudo grep -q "listen 443" /etc/nginx/conf.d/laundry-frontend.conf && echo "OK" || echo "MISSING"

# 3. Firewall có mở HTTPS?
sudo firewall-cmd --list-services | grep -q https && echo "OK" || echo "MISSING"

# 4. Domain trỏ về đúng IP?
dig +short quanlycuahangabc.id.vn | grep -q "103.130.212.155" && echo "OK" || echo "WRONG IP"
```

---

## Lỗi: "Unknown column 'p.store_id'" hoặc "Unknown column 'store_id' in 'field list'" (bảng products)

### Nguyên nhân:
Bảng `products` thiếu cột `store_id`. Điều này xảy ra khi:
- Database được tạo trước khi code mới được deploy
- Migration chưa được chạy sau khi update code

### Cách khắc phục:

#### Bước 1: Chạy migration trên VPS

```bash
# Di chuyển vào thư mục backend
cd /var/www/laundry-backend

# Chạy migration để thêm cột store_id vào bảng products
npm run migrate-products
```

**Kết quả mong đợi:**
```
Checking products table for missing store_id column...
Adding store_id column to products table...
✅ Added store_id column
✅ Added foreign key constraint for store_id
✅ Migration completed successfully!
Done!
```

#### Bước 2: Kiểm tra cột đã được thêm

**Kết nối MySQL:**
```bash
mysql -u root -p laundry66
# Hoặc: mysql -u laundry_user -p laundry66
```

**Kiểm tra trong MySQL:**
```sql
-- Xem cấu trúc bảng products
DESCRIBE products;

-- Hoặc
SHOW COLUMNS FROM products;
```

**Phải thấy cột:**
- `store_id INT NULL`

#### Bước 3: Restart backend

```bash
pm2 restart laundry-backend
```

#### Bước 4: Kiểm tra logs

```bash
pm2 logs laundry-backend --lines 20
```

**Nếu vẫn còn lỗi:**
- Kiểm tra xem migration đã chạy thành công chưa
- Kiểm tra lại cấu trúc bảng trong MySQL
- Xem logs chi tiết để tìm lỗi cụ thể

#### Lưu ý:
- Migration script sẽ tự động kiểm tra và chỉ thêm cột còn thiếu
- Nếu cột đã tồn tại, script sẽ bỏ qua và không báo lỗi
- Có thể chạy migration nhiều lần mà không ảnh hưởng đến dữ liệu
- Khi chạy `npm run init-db`, script sẽ tự động thêm cột này nếu thiếu

---

## Lỗi: "Table 'laundry66.login_attempts' doesn't exist"

### Nguyên nhân:
Bảng `login_attempts` chưa được tạo trong database. Bảng này dùng để log các lần đăng nhập (thành công và thất bại) để bảo mật.

### Cách khắc phục:

#### Bước 1: Chạy migration trên VPS

```bash
# Di chuyển vào thư mục backend
cd /var/www/laundry-backend

# Chạy migration để tạo bảng login_attempts
npm run migrate-login-attempts
```

**Kết quả mong đợi:**
```
Checking if login_attempts table exists...
Creating login_attempts table...
✅ Created login_attempts table
✅ Created indexes for login_attempts table
✅ Migration completed successfully!
Done!
```

#### Bước 2: Kiểm tra bảng đã được tạo

**Kết nối MySQL:**
```bash
mysql -u root -p laundry66
# Hoặc: mysql -u laundry_user -p laundry66
```

**Kiểm tra trong MySQL:**
```sql
-- Xem bảng login_attempts
SHOW TABLES LIKE 'login_attempts';

-- Xem cấu trúc bảng
DESCRIBE login_attempts;
```

**Phải thấy bảng với các cột:**
- `id` (INT AUTO_INCREMENT PRIMARY KEY)
- `phone` (VARCHAR(50))
- `ip_address` (VARCHAR(45))
- `success` (BOOLEAN)
- `failure_reason` (TEXT)
- `user_agent` (TEXT)
- `created_at` (DATETIME)

#### Bước 3: Restart backend

```bash
pm2 restart laundry-backend
```

#### Bước 4: Kiểm tra logs

```bash
pm2 logs laundry-backend --lines 20
```

**Nếu vẫn còn lỗi:**
- Kiểm tra xem migration đã chạy thành công chưa
- Kiểm tra lại cấu trúc bảng trong MySQL
- Xem logs chi tiết để tìm lỗi cụ thể

#### Lưu ý:
- Migration script sẽ tự động kiểm tra và chỉ tạo bảng nếu chưa tồn tại
- Nếu bảng đã tồn tại, script sẽ bỏ qua và không báo lỗi
- Có thể chạy migration nhiều lần mà không ảnh hưởng đến dữ liệu
- Khi chạy `npm run init-db`, script sẽ tự động tạo bảng này nếu thiếu

---

## Lỗi: "Unknown column 'store_id' in 'where clause'" (bảng settings)

### Nguyên nhân:
Bảng `settings` thiếu cột `store_id`. Điều này xảy ra khi:
- Database được tạo trước khi code mới được deploy
- Migration chưa được chạy sau khi update code

### Cách khắc phục:

#### Bước 1: Chạy migration trên VPS

```bash
# Di chuyển vào thư mục backend
cd /var/www/laundry-backend

# Chạy migration để thêm cột store_id vào bảng settings
npm run migrate-settings
```

**Kết quả mong đợi:**
```
Checking settings table for missing store_id column...
Adding store_id column to settings table...
✅ Added store_id column
✅ Dropped old unique constraint on key
✅ Added unique constraint unique_key_store
✅ Added foreign key constraint for store_id
✅ Migration completed successfully!
Done!
```

#### Bước 2: Kiểm tra cột đã được thêm

**Kết nối MySQL:**
```bash
mysql -u root -p laundry66
# Hoặc: mysql -u laundry_user -p laundry66
```

**Kiểm tra trong MySQL:**
```sql
-- Xem cấu trúc bảng settings
DESCRIBE settings;

-- Hoặc
SHOW COLUMNS FROM settings;
```

**Phải thấy cột:**
- `store_id INT NULL`
- Unique constraint: `unique_key_store` trên (`key`, `store_id`)
- Foreign key: `fk_settings_store_id` tham chiếu đến `stores(id)`

#### Bước 3: Restart backend

```bash
pm2 restart laundry-backend
```

#### Bước 4: Kiểm tra logs

```bash
pm2 logs laundry-backend --lines 20
```

**Nếu vẫn còn lỗi:**
- Kiểm tra xem migration đã chạy thành công chưa
- Kiểm tra lại cấu trúc bảng trong MySQL
- Xem logs chi tiết để tìm lỗi cụ thể

#### Lưu ý:
- Migration script sẽ tự động kiểm tra và chỉ thêm cột còn thiếu
- Nếu cột đã tồn tại, script sẽ bỏ qua và không báo lỗi
- Có thể chạy migration nhiều lần mà không ảnh hưởng đến dữ liệu
- Khi chạy `npm run init-db`, script sẽ tự động thêm cột này nếu thiếu
- Unique constraint đã được thay đổi từ chỉ `key` thành `(key, store_id)` để cho phép cùng một key cho nhiều cửa hàng khác nhau

---

## Liên hệ hỗ trợ

Nếu vẫn không giải quyết được:
1. Chạy `node backend/check-server.js` và gửi kết quả
2. Kiểm tra logs của backend (terminal nơi chạy `npm run dev`)
3. Kiểm tra browser console (F12)
4. Kiểm tra Network tab trong DevTools
5. Xem logs Nginx: `sudo tail -f /var/log/nginx/error.log`
