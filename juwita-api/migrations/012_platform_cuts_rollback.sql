-- ============================================================
-- ROLLBACK MIGRATION 012 — PLATFORM_CUTS
-- ============================================================
-- Mengembalikan perubahan migration 012_platform_cuts.sql.
--
-- PERINGATAN: menjalankan rollback ini akan MENGHAPUS tabel
-- platform_cuts beserta seluruh pengaturan persentase potongan
-- platform yang tersimpan (POS / Shopee 1 / Shopee 2). Setelah
-- rollback, analisis Laba Rugi kembali memakai nilai default
-- (POS 0%, Shopee 1 19%, Shopee 2 19%) dan tombol simpan
-- persentase tidak berfungsi sampai migration 012 dijalankan lagi.
--
-- Aturan:
--   - TIDAK dijalankan otomatis. Hanya dijalankan manual bila
--     fitur benar-benar ingin dibatalkan.
--   - Tidak mengubah tabel lain apa pun.
--   - Idempotent (aman dijalankan berulang).
-- ============================================================

DROP TABLE IF EXISTS public.platform_cuts;
