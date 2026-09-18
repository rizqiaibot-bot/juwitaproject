-- ============================================================
-- MIGRATION 002 — PRODUCT_PRICES (HARGA JUAL PER CHANNEL)
-- ============================================================
-- Harga jual per channel: pos, shopee:724153261, shopee:1214362884.
--
-- Aturan:
--   - product_id FK ke products(id), ON DELETE CASCADE.
--   - Satu baris = satu harga untuk (product, channel).
--   - TIDAK menulis/mengubah products.price (harga pusat tetap utuh).
--
-- Backend mandiri: TIDAK memakai RLS / auth.uid() / policy Supabase.
-- Akses lewat role aplikasi (BYPASSRLS). Tidak ada ketergantungan
-- auth Supabase.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + trigger re-runnable.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.product_prices (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id  BIGINT NOT NULL
        REFERENCES public.products (id) ON DELETE CASCADE,
    channel     TEXT NOT NULL,
    price       NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT product_prices_product_id_channel_key
        UNIQUE (product_id, channel),
    CONSTRAINT product_prices_channel_check
        CHECK (channel IN ('pos', 'shopee:724153261', 'shopee:1214362884'))
);

-- Akses role aplikasi (backend mandiri). Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_prices TO juwita_app;
GRANT USAGE, SELECT ON SEQUENCE public.product_prices_id_seq TO juwita_app;

-- updated_at di-update otomatis oleh fungsi set_updated_at() yang sudah ada.
DROP TRIGGER IF EXISTS trg_product_prices_updated_at ON public.product_prices;
CREATE TRIGGER trg_product_prices_updated_at
    BEFORE UPDATE ON public.product_prices
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- SEED HARGA AWAL
-- Setiap product mendapat harga awal dari products.price untuk 3 channel.
-- Hanya MEMBACA products.price (TIDAK mengubahnya).
-- Idempotent: ON CONFLICT DO NOTHING — produk yang sudah punya harga
-- (atau di-seed ulang) tidak ditimpa.
-- ============================================================
INSERT INTO public.product_prices (product_id, channel, price)
SELECT p.id, ch.channel, p.price
FROM public.products p
CROSS JOIN (VALUES ('pos'), ('shopee:724153261'), ('shopee:1214362884')) AS ch(channel)
ON CONFLICT (product_id, channel) DO NOTHING;
