#!/bin/bash

# Script tự động setup Database
# Sử dụng: bash setup-database.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🗄️  Bắt đầu setup Database..."

# Đọc thông tin từ .env
if [ ! -f "../backend/.env" ]; then
    echo -e "${RED}Lỗi: Không tìm thấy file .env${NC}"
    exit 1
fi

source <(grep -E '^MYSQL_' ../backend/.env | sed 's/^/export /')

DB_NAME=${MYSQL_DATABASE:-laundry66}
DB_USER=${MYSQL_USER:-laundry_user}
DB_PASS=${MYSQL_PASSWORD}

if [ -z "$DB_PASS" ]; then
    echo -e "${YELLOW}Nhập mật khẩu MySQL root:${NC}"
    read -s ROOT_PASS
else
    ROOT_PASS=""
fi

echo -e "${YELLOW}Tạo database và user...${NC}"

mysql -u root ${ROOT_PASS:+-p$ROOT_PASS} << EOF
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
EOF

echo -e "${GREEN}✓ Database và user đã được tạo${NC}"

# Khởi tạo schema
echo -e "${YELLOW}Khởi tạo database schema...${NC}"
cd ../backend
npm run init-db

echo -e "${GREEN}✓ Database đã được khởi tạo thành công!${NC}"
