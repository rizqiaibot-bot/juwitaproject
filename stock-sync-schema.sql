-- Tabel log mutasi stok (untuk sync ke Shopee)
CREATE TABLE IF NOT EXISTS stock_mutations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id INT NOT NULL,
  product_name TEXT,
  type TEXT NOT NULL CHECK (type IN ('IN', 'OUT', 'ADJUST')),
  quantity INT NOT NULL,
  qty_before INT,
  qty_after INT,
  source TEXT,
  sync_status TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
  shopee_item_id BIGINT,
  shopee_sku TEXT,
  shopee_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index untuk polling sync
CREATE INDEX IF NOT EXISTS idx_stock_mutations_sync ON stock_mutations(sync_status, created_at);
