-- ============================================================
-- SHOPEE SYNC SCHEMA — 2 TOKO
-- Paste di SQL Editor Supabase Juwi, jalankan semua
-- ============================================================

-- 1. Tambah kolom Shopee di tabel products (untuk 2 toko)
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopee_item_id BIGINT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopee_sku TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopee_item_id_2 BIGINT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopee_sku_2 TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT;

-- 2. Tabel log mutasi stok (untuk sync ke Shopee)
CREATE TABLE IF NOT EXISTS stock_mutations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL,
  product_name TEXT,
  type TEXT NOT NULL CHECK (type IN ('IN', 'OUT', 'ADJUST')),
  quantity INT NOT NULL,
  qty_before INT,
  qty_after INT,
  source TEXT,
  shopee_account TEXT DEFAULT 'toko_1',
  sync_status TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
  shopee_item_id BIGINT,
  shopee_sku TEXT,
  shopee_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Index untuk polling sync
CREATE INDEX IF NOT EXISTS idx_stock_mutations_sync ON stock_mutations(sync_status, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_mutations_account ON stock_mutations(shopee_account, sync_status);

-- 4. RLS + Policies
ALTER TABLE stock_mutations ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "Allow all stock_mutations" ON stock_mutations FOR ALL USING (true) WITH CHECK (true);
