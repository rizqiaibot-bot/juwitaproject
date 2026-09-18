-- ============================================================
-- PRODUCT PRICE SYNC QUEUE — ANTREAN SINKRON HARGA KE SHOPEE
-- ============================================================
-- Fungsi:
--   Menyimpan niat sinkron harga per (product_id, channel) ke Shopee.
--   Frontend TIDAK memanggil API Shopee; hanya menulis antrean ini.
--   Edge Function shopee-price-sync membaca antrean lalu push ke Shopee.
--
-- Non-destruktif:
--   - Hanya MEMBUAT tabel baru + index + trigger + policy + helper lock.
--   - TIDAK mengubah products / products.price / stok / SKU / barcode.
--   - TIDAK mengubah orders / order_items.
--   - TIDAK mengubah product_prices.
--   - TIDAK mengubah stock_mutations / integrasi stok Shopee.
--
-- Channel harga yang relevan (hanya Shopee):
--   shopee:724153261     -> Shopee 1 (Juwita Fresh and Frozen)
--   shopee:1214362884    -> Shopee 2 (Juwita Frozen Food)
--   (channel 'pos' tidak pernah masuk antrean ini)
--
-- Jalankan MANUAL / via SQL langsung (tidak dieksekusi otomatis).
-- ============================================================

-- ============================================================
-- 1. TABEL ANTREAN
-- ============================================================
CREATE TABLE IF NOT EXISTS public.product_price_sync_queue (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id        BIGINT  NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  channel           TEXT    NOT NULL,
  target_price      INTEGER NOT NULL CHECK (target_price >= 0),
  status            TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'synced', 'failed', 'skipped')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_synced_price INTEGER,
  synced_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Satu baris per produk+channel: perubahan harga meng-update baris yang sama,
  -- sehingga tidak menumpuk antrean duplikat.
  UNIQUE (product_id, channel)
);

-- ============================================================
-- 2. INDEX
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_ppsq_status         ON public.product_price_sync_queue (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_ppsq_channel_status ON public.product_price_sync_queue (channel, status);
CREATE INDEX IF NOT EXISTS idx_ppsq_product        ON public.product_price_sync_queue (product_id);

-- ============================================================
-- 3. TRIGGER updated_at (pakai helper yang sudah ada)
-- ============================================================
DROP TRIGGER IF EXISTS trg_ppsq_updated_at ON public.product_price_sync_queue;
CREATE TRIGGER trg_ppsq_updated_at
  BEFORE UPDATE ON public.product_price_sync_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 4. RLS
--    Baca/tulis antrean hanya owner aktif (pola app_user_is_owner()).
--    Edge Function memakai service_role sehingga bypass RLS.
--    Kasir / user biasa: TIDAK ada akses.
-- ============================================================
ALTER TABLE public.product_price_sync_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ppsq_owner_all" ON public.product_price_sync_queue;
CREATE POLICY "ppsq_owner_all"
  ON public.product_price_sync_queue
  FOR ALL
  TO authenticated
  USING (public.app_user_is_owner())
  WITH CHECK (public.app_user_is_owner());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.product_price_sync_queue
  TO authenticated;

GRANT USAGE, SELECT
  ON SEQUENCE public.product_price_sync_queue_id_seq
  TO authenticated;

-- ============================================================
-- 5. LOCK KHUSUS PRICE SYNC (berbasis tabel, BUKAN advisory lock)
--    Alasan: Supabase connection pooler bisa mengeksekusi unlock di
--    koneksi berbeda sehingga advisory lock bisa "nyangkut". Tabel lock
--    dengan masa kedaluwarsa aman lintas koneksi.
--    BERBEDA dan tidak mengganggu shopee-stock-sync (advisory 987654321).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.price_sync_lock (
  name      TEXT PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.price_sync_lock TO service_role;

-- Ambil lock. Bila sudah dipegang < 10 menit terakhir -> false.
-- Bila lock basi (>= 10 menit, mis. proses crash) -> boleh diambil alih.
CREATE OR REPLACE FUNCTION public.price_sync_lock_acquire()
RETURNS boolean AS $$
DECLARE
  v_ok boolean;
BEGIN
  INSERT INTO public.price_sync_lock (name, locked_at)
  VALUES ('shopee-price-sync', NOW())
  ON CONFLICT (name) DO UPDATE
    SET locked_at = NOW()
    WHERE public.price_sync_lock.locked_at < NOW() - INTERVAL '10 minutes'
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.price_sync_lock_release()
RETURNS boolean AS $$
BEGIN
  DELETE FROM public.price_sync_lock WHERE name = 'shopee-price-sync';
  RETURN true;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION public.price_sync_lock_acquire() TO service_role;
GRANT EXECUTE ON FUNCTION public.price_sync_lock_release() TO service_role;

-- ============================================================
-- VERIFIKASI (opsional)
-- ============================================================
-- SELECT channel, status, COUNT(*) FROM public.product_price_sync_queue
--   GROUP BY channel, status ORDER BY channel, status;
