-- ============================================================
-- MIGRATION 004 — Grant akses marketplace_credentials untuk app
-- Worker/API Shopee lokal membaca access_token/refresh_token dari
-- marketplace_credentials (untuk signing endpoint ber-access_token).
-- Sebelumnya hanya role postgres (owner) yang bisa akses.
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.marketplace_credentials TO juwita_app;
