#!/bin/bash

# Script tự động setup Backend
# Sử dụng: bash setup-backend.sh

set -e

echo "🚀 Bắt đầu setup Backend..."

# Màu sắc cho output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Kiểm tra Node.js
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Node.js chưa được cài đặt. Đang cài đặt...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo -e "${GREEN}✓ Node.js: $(node --version)${NC}"

# Tạo thư mục
APP_DIR="/var/www/laundry-backend"
echo -e "${YELLOW}Tạo thư mục $APP_DIR...${NC}"
sudo mkdir -p $APP_DIR
sudo chown -R $USER:$USER $APP_DIR

# Copy code (giả sử script chạy từ thư mục backend)
if [ -f "server.js" ]; then
    echo -e "${YELLOW}Copy code...${NC}"
    cp -r . $APP_DIR/
else
    echo -e "${RED}Lỗi: Không tìm thấy server.js. Vui lòng chạy script từ thư mục backend.${NC}"
    exit 1
fi

cd $APP_DIR

# Cài đặt dependencies
echo -e "${YELLOW}Cài đặt dependencies...${NC}"
npm install --production

# Tạo .env nếu chưa có
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Tạo file .env...${NC}"
    cat > .env << EOF
PORT=5000
NODE_ENV=production
JWT_SECRET=$(openssl rand -base64 32)
JWT_EXPIRE=7d

MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=laundry_user
MYSQL_PASSWORD=$(openssl rand -base64 16 | tr -d "=+/" | cut -c1-16)
MYSQL_DATABASE=laundry66

FRONTEND_URL=http://localhost:3000
EOF
    echo -e "${GREEN}✓ File .env đã được tạo${NC}"
    echo -e "${YELLOW}⚠️  Vui lòng cập nhật MYSQL_PASSWORD và FRONTEND_URL trong .env${NC}"
fi

# Cài đặt PM2
if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}Cài đặt PM2...${NC}"
    sudo npm install -g pm2
fi

# Khởi động với PM2
echo -e "${YELLOW}Khởi động ứng dụng với PM2...${NC}"
pm2 delete laundry-backend 2>/dev/null || true
pm2 start server.js --name laundry-backend
pm2 save

# Setup auto-start
echo -e "${YELLOW}Thiết lập tự động khởi động...${NC}"
pm2 startup | grep "sudo" | bash || true

echo -e "${GREEN}✓ Backend đã được setup thành công!${NC}"
echo -e "${YELLOW}Kiểm tra: pm2 status${NC}"
echo -e "${YELLOW}Xem logs: pm2 logs laundry-backend${NC}"
