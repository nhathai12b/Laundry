-- Script thêm sản phẩm mẫu vào bảng products cho TẤT CẢ các tiệm (stores).
--
-- Cách chạy:
--   mysql -u USER -p TEN_DATABASE < backend/scripts/seed_products_all_stores.sql
-- Hoặc trong MySQL client: source /path/to/seed_products_all_stores.sql;
--
-- Lưu ý: Mỗi INSERT chèn 1 sản phẩm cho từng store (bảng stores). Nếu store chưa có thì bảng stores trống sẽ không chèn dòng nào.

-- Giặt khô dưới 3kg 20k - Giặt - 20.000đ - kg
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Giặt khô dưới 3kg 20k', 'kg', 20000, 'active', id FROM stores;

-- Giặt phơi 7k 1kg - Giặt - 7.000đ - kg
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Giặt phơi 7k 1kg', 'kg', 7000, 'active', id FROM stores;

-- Giặt riêng đồ trắng 5k 1 mẻ - Giặt - 5.000đ - don (mẻ)
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Giặt riêng đồ trắng 5k 1 mẻ', 'don', 5000, 'active', id FROM stores;

-- Giặt sấy 8k 1kg - Giặt - 8.000đ - kg
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Giặt sấy 8k 1kg', 'kg', 8000, 'active', id FROM stores;

-- Giặt sấy gấp 10k 1kg - Giặt - 10.000đ - kg
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Giặt sấy gấp 10k 1kg', 'kg', 10000, 'active', id FROM stores;

-- Giặt tay thủ công 5k 1 cái - Giặt - 5.000đ - cai
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Giặt tay thủ công 5k 1 cái', 'cai', 5000, 'active', id FROM stores;

-- Giặt ướt dưới 5kg 20k - Giặt - 20.000đ - kg
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Giặt ướt dưới 5kg 20k', 'kg', 20000, 'active', id FROM stores;

-- Giặt ướt trên 5kg [5k/1kg] - Giặt - 5.000đ - kg
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Giặt ướt trên 5kg [5k/1kg]', 'kg', 5000, 'active', id FROM stores;

-- Gối 15k cái - 15.000đ - cai
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Gối 15k cái', 'cai', 15000, 'active', id FROM stores;

-- Gối lớn, gối ôm 20k cái - 20.000đ - cai
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Gối lớn, gối ôm 20k cái', 'cai', 20000, 'active', id FROM stores;

-- Grap nệm dày 20k 1 cái - Chăn màn rèm - 20.000đ - cai
INSERT INTO products (name, unit, price, status, store_id)
SELECT 'Grap nệm dày 20k 1 cái', 'cai', 20000, 'active', id FROM stores;
