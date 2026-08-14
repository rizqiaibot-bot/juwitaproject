-- ============================================================
-- MARKETPLACE CREDENTIALS — penyimpanan token Shopee
-- Hanya bisa diakses oleh service_role (Edge Function).
-- Frontend TIDAK boleh membaca tabel ini.
-- ============================================================
CREATE TABLE IF NOT EXISTS marketplace_credentials (
  shop_id       TEXT PRIMARY KEY,
  platform      TEXT NOT NULL DEFAULT 'shopee' CHECK (platform IN ('shopee', 'tokopedia', 'tiktok', 'lazada')),
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE marketplace_credentials ENABLE ROW LEVEL SECURITY;
