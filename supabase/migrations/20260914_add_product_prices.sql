-- ============================================================
-- PRODUCT PRICES — HARGA JUAL PER CHANNEL (TAHAP 1)
-- ============================================================
-- Channel final:
--   pos                  -> POS / offline
--   shopee:724153261     -> Shopee 1 (Juwita Fresh and Frozen)
--   shopee:1214362884    -> Shopee 2 (juwita frozen food)
--
-- Non-destruktif:
--   - Hanya MEMBUAT tabel baru product_prices.
--   - TIDAK mengubah products.price (tetap harga POS/fallback).
--   - TIDAK mengubah orders / order_items (transaksi lama aman).
--   - TIDAK menyentuh stok, SKU, barcode, PLU, atau product_id.
--   - TIDAK mengubah import order Shopee.
--
-- Jalankan MANUAL di database (tidak dieksekusi otomatis).
-- ============================================================

-- 1. TABEL
CREATE TABLE IF NOT EXISTS product_prices (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  BIGINT     NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel     TEXT       NOT NULL,
  price       INTEGER    NOT NULL CHECK (price >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, channel)
);

-- 2. INDEX
CREATE INDEX IF NOT EXISTS idx_product_prices_product ON product_prices (product_id);

-- 3. RLS
-- Baca: semua user yang sudah login (kasir butuh harga POS).
-- Tulis: hanya owner (role='owner' dan status ACTIVE) via app_user_is_owner().
-- TIDAK ada akses untuk anon/public.
ALTER TABLE public.product_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_prices_select_authenticated"
  ON public.product_prices;

CREATE POLICY "product_prices_select_authenticated"
  ON public.product_prices
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "product_prices_insert_owner"
  ON public.product_prices;

CREATE POLICY "product_prices_insert_owner"
  ON public.product_prices
  FOR INSERT
  TO authenticated
  WITH CHECK (public.app_user_is_owner());

DROP POLICY IF EXISTS "product_prices_update_owner"
  ON public.product_prices;

CREATE POLICY "product_prices_update_owner"
  ON public.product_prices
  FOR UPDATE
  TO authenticated
  USING (public.app_user_is_owner())
  WITH CHECK (public.app_user_is_owner());

DROP POLICY IF EXISTS "product_prices_delete_owner"
  ON public.product_prices;

CREATE POLICY "product_prices_delete_owner"
  ON public.product_prices
  FOR DELETE
  TO authenticated
  USING (public.app_user_is_owner());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.product_prices
  TO authenticated;

GRANT USAGE, SELECT
  ON SEQUENCE public.product_prices_id_seq
  TO authenticated;

-- ============================================================
-- 4. SEED / BACKFILL (idempotent, TIDAK menimpa harga yang ada)
-- ============================================================
-- Semua produk mendapat 3 baris channel dari products.price.
-- ON CONFLICT DO NOTHING -> harga channel yang sudah diubah manual
-- tidak akan tertimpa bila migration dijalankan ulang.
--
-- Guard "p.price >= 0": products.price adalah INTEGER NOT NULL tanpa
-- CHECK non-negatif, sedangkan product_prices.price punya CHECK (>= 0).
-- Baris dengan harga negatif (bila ada) dilewati agar migration tidak
-- gagal; products.price sendiri TIDAK diubah.
-- ============================================================

INSERT INTO product_prices (product_id, channel, price)
SELECT p.id, c.channel, p.price
FROM products p
CROSS JOIN (
  VALUES
    ('pos'),
    ('shopee:724153261'),
    ('shopee:1214362884')
) AS c(channel)
WHERE p.price >= 0
ON CONFLICT (product_id, channel) DO NOTHING;

-- ============================================================
-- VERIFIKASI (opsional, jalankan manual untuk cek hasil)
-- ============================================================
-- SELECT channel, COUNT(*) FROM product_prices GROUP BY channel ORDER BY channel;
-- SELECT * FROM product_prices ORDER BY product_id, channel LIMIT 20;
