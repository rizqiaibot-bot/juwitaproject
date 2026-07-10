-- ============================================================
-- MARKETPLACE INTEGRATION SCHEMA — JUWITA ONE
-- Paste di SQL Editor Supabase, jalankan semua
-- Fase 1: Tabel dasar marketplace (tanpa ubah tabel lama)
-- ============================================================

-- 1. Konfigurasi koneksi marketplace
--    Satu row = satu toko. Multi-toko: insert beberapa row.
CREATE TABLE IF NOT EXISTS marketplace_config (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform          TEXT NOT NULL CHECK (platform IN ('shopee', 'tokopedia', 'tiktok', 'lazada')),
  account_label     TEXT,
  shop_id           TEXT NOT NULL,
  shop_name         TEXT,
  is_active         BOOLEAN DEFAULT false,
  connection_status TEXT DEFAULT 'disconnected' CHECK (connection_status IN ('connected', 'disconnected', 'expired', 'error')),
  last_sync_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, shop_id)
);

-- 2. Log seluruh aktivitas marketplace
CREATE TABLE IF NOT EXISTS activity_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_batch_id   TEXT,
  event_type      TEXT NOT NULL,
  direction       TEXT CHECK (direction IN ('IN', 'OUT', 'INTERNAL')),
  platform        TEXT DEFAULT 'shopee',
  shop_id         TEXT,
  product_id      BIGINT,
  product_name    TEXT,
  product_sku     TEXT,
  qty             INT,
  qty_before      INT,
  qty_after       INT,
  reference_id    TEXT,
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed', 'retrying', 'cancelled')),
  triggered_by    TEXT,
  action_source   TEXT,
  error_message   TEXT,
  error_detail    TEXT,
  retry_count     INT DEFAULT 0,
  duration_ms     INT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Pesanan dari marketplace (sebelum diproses ke tabel orders)
CREATE TABLE IF NOT EXISTS marketplace_orders (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform          TEXT DEFAULT 'shopee' CHECK (platform IN ('shopee', 'tokopedia', 'tiktok', 'lazada')),
  mp_order_id       TEXT NOT NULL,
  internal_order_id TEXT,
  customer_name     TEXT,
  total             INT DEFAULT 0,
  order_status      TEXT DEFAULT 'pending',
  sync_status       TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'processing', 'ready_import', 'processed', 'failed', 'ignored')),
  raw_payload       JSONB DEFAULT '{}'::jsonb,
  error_message     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, mp_order_id)
);

-- ============================================================
-- INDEX
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_marketplace_config_active ON marketplace_config(platform, is_active);
CREATE INDEX IF NOT EXISTS idx_activity_log_batch        ON activity_log(sync_batch_id) WHERE sync_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_log_event        ON activity_log(event_type, status);
CREATE INDEX IF NOT EXISTS idx_activity_log_created      ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_ref           ON activity_log(reference_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_shop          ON activity_log(shop_id) WHERE shop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_mp      ON marketplace_orders(platform, mp_order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_sync    ON marketplace_orders(sync_status, created_at);

-- ============================================================
-- HELPER FUNCTIONS (untuk Edge Function, tidak dipanggil UI)
-- ============================================================

-- Advisory lock untuk mencegah concurrent sync execution.
-- Lock ID 987654321 — DIGUNAKAN EKSKLUSIF oleh shopee-stock-sync Edge Function.
-- JANGAN gunakan lock ID yang sama untuk Edge Function atau proses lain.
CREATE OR REPLACE FUNCTION sync_lock_acquire()
RETURNS boolean AS $$
BEGIN
  RETURN pg_try_advisory_lock(987654321);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_lock_release()
RETURNS boolean AS $$
BEGIN
  RETURN pg_advisory_unlock(987654321);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ⚠️  RLS + POLICIES
-- ============================================================
-- CATATAN: Saat ini RLS mengikuti pola legacy — allow all.
-- SEBELUM PRODUCTION: ganti policy menggunakan Supabase Auth.
-- Contoh:
--   CREATE POLICY "Users view own config" ON marketplace_config
--     FOR SELECT USING (auth.uid() = owner_id);
-- ============================================================

ALTER TABLE marketplace_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_orders  ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Allow all marketplace_config"  ON marketplace_config  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow all activity_log"        ON activity_log        FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow all marketplace_orders"  ON marketplace_orders  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- ROLLBACK (jalankan SATU per SATU jika perlu menghapus modul)
-- ============================================================
-- DROP POLICY IF EXISTS "Allow all marketplace_orders"  ON marketplace_orders;
-- DROP POLICY IF EXISTS "Allow all activity_log"        ON activity_log;
-- DROP POLICY IF EXISTS "Allow all marketplace_config"  ON marketplace_config;
-- DROP TABLE IF EXISTS marketplace_orders CASCADE;
-- DROP TABLE IF EXISTS activity_log CASCADE;
-- DROP TABLE IF EXISTS marketplace_config CASCADE;
