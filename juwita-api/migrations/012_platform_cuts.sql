-- ============================================================
-- MIGRATION 012 — PLATFORM_CUTS (POTONGAN PLATFORM PER CHANNEL)
-- ============================================================
-- Persentase potongan platform untuk analisis Laba Rugi per item:
--   - pos                 = 0%  (penjualan offline tidak kena potongan)
--   - shopee:724153261    = 19% (Shopee 1)
--   - shopee:1214362884   = 19% (Shopee 2)
--
-- Aturan:
--   - Nilai bisa diubah admin dari menu Pricing → tab Laba Rugi
--     (PUT /api/platform-cuts) TANPA mengubah kode program.
--   - HANYA dipakai untuk perhitungan analisis laba rugi.
--     TIDAK mengubah harga jual, stok, order, maupun data pembelian.
--   - Satu baris = satu channel. Channel sama dengan kunci tabel
--     product_prices.
--
-- Backend mandiri: TIDAK memakai RLS / auth.uid() / policy Supabase.
-- Idempotent: CREATE TABLE IF NOT EXISTS + seed ON CONFLICT DO NOTHING.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.platform_cuts (
    channel     TEXT PRIMARY KEY,
    percent     NUMERIC(5, 2) NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT platform_cuts_channel_check
        CHECK (channel IN ('pos', 'shopee:724153261', 'shopee:1214362884')),
    CONSTRAINT platform_cuts_percent_check
        CHECK (percent >= 0 AND percent <= 100)
);

-- Akses role aplikasi (backend mandiri). Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_cuts TO juwita_app;

-- Seed nilai awal: POS 0%, Shopee 1 19%, Shopee 2 19%.
-- Idempotent: ON CONFLICT DO NOTHING — nilai yang sudah diubah admin
-- TIDAK ditimpa bila migration dijalankan ulang.
INSERT INTO public.platform_cuts (channel, percent)
VALUES
    ('pos', 0),
    ('shopee:724153261', 19),
    ('shopee:1214362884', 19)
ON CONFLICT (channel) DO NOTHING;
