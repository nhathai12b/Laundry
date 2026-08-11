#!/bin/bash

# Script deploy Frontend
# Sử dụng: bash update-frontend.sh [server-ip] [username]

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SERVER=${1:-"your-server-ip"}
USER=${2:-"your-username"}
FRONTEND_DIR="/var/www/laundry-frontend"

echo "🎨 Bắt đầu deploy Frontend..."

# Build
echo -e "${YELLOW}Building frontend...${NC}"
npm run build

if [ ! -d "dist" ]; then
    echo -e "${RED}Lỗi: Thư mục dist không tồn tại${NC}"
    exit 1
fi

# Upload
echo -e "${YELLOW}Uploading lên server...${NC}"
scp -r dist/* ${USER}@${SERVER}:${FRONTEND_DIR}/

echo -e "${GREEN}✓ Frontend đã được deploy thành công!${NC}"
echo -e "${YELLOW}Kiểm tra: https://yourdomain.com${NC}"
