-- ============================================================
-- MIGRASI SUPABASE UNTUK JUWITA ONE
-- Copy & paste ini ke Supabase SQL Editor
-- ============================================================

-- 1. TABEL PRODUK
CREATE TABLE IF NOT EXISTS products (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price INTEGER NOT NULL,
  modal INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  minStock INTEGER NOT NULL DEFAULT 10,
  maxStock INTEGER NOT NULL DEFAULT 100,
  supplier TEXT,
  imageIcon TEXT DEFAULT 'fa-box',
  barcode TEXT
);

-- 2. TABEL ORDERS (TRANSAKSI PENJUALAN)
CREATE TABLE IF NOT EXISTS orders (
  orderId TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  channel TEXT NOT NULL,
  customer TEXT NOT NULL DEFAULT 'Walk-in Customer',
  total INTEGER NOT NULL DEFAULT 0,
  payStatus TEXT NOT NULL DEFAULT 'Lunas',
  wmsStatus TEXT NOT NULL DEFAULT 'Selesai',
  courier TEXT DEFAULT 'Self-Pickup',
  resi TEXT DEFAULT '-',
  items JSONB DEFAULT '[]'::jsonb
);

-- 3. TABEL KARYAWAN
CREATE TABLE IF NOT EXISTS karyawan (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Aktif',
  theme TEXT NOT NULL DEFAULT 'badge-lunas'
);

-- 4. TABEL KONTRAKAN
CREATE TABLE IF NOT EXISTS kontrakan (
  id TEXT PRIMARY KEY,
  pintu TEXT NOT NULL,
  penyewa TEXT NOT NULL DEFAULT '-',
  tipe TEXT NOT NULL DEFAULT 'Standar',
  harga INTEGER NOT NULL DEFAULT 0,
  tempo INTEGER NOT NULL DEFAULT 20,
  kontak TEXT DEFAULT '-',
  listrik INTEGER DEFAULT 0,
  air INTEGER DEFAULT 0,
  deposit INTEGER DEFAULT 0,
  tglMasuk TEXT,
  catatan TEXT DEFAULT '',
  persentase INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Vacant',
  tagihan JSONB DEFAULT '[]'::jsonb
);

-- ============================================================
-- ENABLE RLS (Row Level Security)
-- ============================================================
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE karyawan ENABLE ROW LEVEL SECURITY;
ALTER TABLE kontrakan ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- POLICIES (allow all for anon key)
-- ============================================================
CREATE POLICY "Allow all products" ON products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all orders" ON orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all karyawan" ON karyawan FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all kontrakan" ON kontrakan FOR ALL USING (true) WITH CHECK (true);
