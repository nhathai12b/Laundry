# Laundry66 - Hệ thống quản lý giặt ủi

Hệ thống quản lý giặt ủi với đầy đủ tính năng cho Admin và Nhân viên, được xây dựng với React + Node.js + SQLite.

## Tính năng

### Đăng nhập / Phân quyền
- ✅ Đăng nhập / Đăng xuất
- ✅ Phân quyền theo role (Admin / Employer)
- ✅ Audit log (ghi lại hành động)

### Quyền Admin
- ✅ Quản lý nhân viên (thêm/sửa/xóa, lương theo giờ/ca, trạng thái)
- ✅ Quản lý sản phẩm & bảng giá (đơn vị tính, trạng thái)
- ✅ Quản lý đơn hàng (tạo/sửa/xóa, gán nhân viên, trạng thái đầy đủ)
- ✅ Quản lý giờ làm nhân viên (xem theo ngày/tháng)
- ✅ Quản lý doanh thu (theo ngày/tháng/năm, biểu đồ, theo sản phẩm/nhân viên)
- ✅ Export dữ liệu (CSV)

### Quyền Employer (Nhân viên)
- ✅ Tạo đơn hàng mới
- ✅ Xem danh sách đơn hàng (của mình, đang xử lý)
- ✅ Cập nhật trạng thái đơn hàng
- ✅ Quản lý khách hàng (xem lịch sử, tổng chi tiêu)
- ✅ Check-in / Check-out giờ làm

### Quản lý Khách hàng
- ✅ Thông tin khách hàng (tên, SĐT, tổng đơn, tổng chi tiêu, ghi chú)
- ✅ Tự động tạo khi tạo đơn mới

### Báo cáo & Thống kê
- ✅ Top khách hàng
- ✅ Top sản phẩm bán chạy
- ✅ Doanh thu theo ca làm
- ✅ Doanh thu theo nhân viên
- ✅ Biểu đồ doanh thu

## Công nghệ

- **Frontend**: React 18 + Vite + TailwindCSS
- **Backend**: Node.js + Express
- **Database**: SQLite (better-sqlite3)
- **Authentication**: JWT
- **Charts**: Recharts

## Cài đặt

### Backend

```bash
cd backend
npm install
npm run init-db
npm run dev
```

Backend sẽ chạy tại `http://localhost:5000`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend sẽ chạy tại `http://localhost:3000`

## 📚 Tài liệu Deploy

- **[DOCKER.md](./DOCKER.md)** - Chạy toàn bộ hệ thống (MySQL + Backend + Frontend) bằng Docker Compose
- **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** - Xử lý sự cố

## Tài khoản mặc định

- **Phone**: `admin`
- **Password**: `admin123`
- **Role**: Admin

## Cấu trúc dự án

```
Laundry66/
├── backend/
│   ├── database/
│   │   ├── schema.sql          # Database schema
│   │   └── db.js               # Database connection
│   ├── middleware/
│   │   ├── auth.js             # Authentication middleware
│   │   └── audit.js             # Audit logging middleware
│   ├── routes/
│   │   ├── auth.js             # Authentication routes
│   │   ├── users.js            # User management
│   │   ├── products.js         # Product management
│   │   ├── orders.js            # Order management
│   │   ├── customers.js        # Customer management
│   │   ├── timesheets.js        # Timesheet management
│   │   └── reports.js          # Reports & exports
│   ├── utils/
│   │   └── helpers.js          # Helper functions
│   └── server.js               # Express server
│
└── frontend/
    ├── src/
    │   ├── pages/
    │   │   ├── Login.jsx
    │   │   ├── Dashboard.jsx
    │   │   ├── Orders.jsx
    │   │   ├── Customers.jsx
    │   │   ├── Timesheets.jsx
    │   │   └── admin/
    │   │       ├── Users.jsx
    │   │       ├── Products.jsx
    │   │       └── Reports.jsx
    │   ├── layouts/
    │   │   ├── AdminLayout.jsx
    │   │   └── EmployerLayout.jsx
    │   ├── utils/
    │   │   ├── api.js           # API client
    │   │   └── auth.js           # Auth utilities
    │   └── App.jsx
    └── package.json
```

## API Endpoints

### Authentication
- `POST /api/auth/login` - Đăng nhập
- `GET /api/auth/me` - Lấy thông tin user hiện tại
- `POST /api/auth/logout` - Đăng xuất

### Users (Admin only)
- `GET /api/users` - Lấy danh sách users
- `POST /api/users` - Tạo user mới
- `PATCH /api/users/:id` - Cập nhật user
- `DELETE /api/users/:id` - Xóa user

### Products
- `GET /api/products` - Lấy danh sách sản phẩm
- `POST /api/products` - Tạo sản phẩm (Admin)
- `PATCH /api/products/:id` - Cập nhật sản phẩm (Admin)
- `DELETE /api/products/:id` - Xóa sản phẩm (Admin)

### Orders
- `GET /api/orders` - Lấy danh sách đơn hàng
- `POST /api/orders` - Tạo đơn hàng mới
- `GET /api/orders/:id` - Lấy chi tiết đơn
- `PATCH /api/orders/:id` - Cập nhật đơn
- `POST /api/orders/:id/status` - Cập nhật trạng thái
- `DELETE /api/orders/:id` - Xóa đơn (Admin)

### Customers
- `GET /api/customers` - Lấy danh sách khách hàng
- `POST /api/customers` - Tạo/cập nhật khách hàng
- `GET /api/customers/:id/orders` - Lấy đơn hàng của khách

### Timesheets
- `GET /api/timesheets` - Lấy danh sách giờ làm
- `POST /api/timesheets/check-in` - Check-in
- `POST /api/timesheets/check-out` - Check-out
- `GET /api/timesheets/summary` - Tổng hợp giờ làm (Admin)

### Reports (Admin only)
- `GET /api/reports/revenue` - Doanh thu
- `GET /api/reports/revenue-by-product` - Doanh thu theo sản phẩm
- `GET /api/reports/revenue-by-employee` - Doanh thu theo nhân viên
- `GET /api/reports/top-customers` - Top khách hàng
- `GET /api/reports/top-products` - Top sản phẩm
- `GET /api/reports/export` - Export CSV

## Trạng thái đơn hàng

- `created` - Đã tạo
- `washing` - Đang giặt
- `drying` - Đang sấy
- `waiting_pickup` - Chờ lấy đồ
- `completed` - Hoàn thành
- `cancelled` - Hủy

## Ghi chú

- Database SQLite được tạo tự động khi chạy lần đầu
- Tất cả hành động đều được ghi vào audit log
- Giao diện responsive, tối ưu cho mobile
- Export CSV cho doanh thu và giờ làm

## License

MIT

