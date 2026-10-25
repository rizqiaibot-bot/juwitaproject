-- ============================================================
-- MIGRATION 010 - STOCK_MUTATIONS.QUANTITY -> NUMERIC
-- ============================================================
-- Alasan:
--   products.stock, stock_mutations.qty_before, dan qty_after
--   sudah NUMERIC (migrasi produk berbobot), tetapi quantity masih INT.
--   Akibatnya kuantitas desimal (mis. 0.5 kg dari POS timbang) dapat
--   dibulatkan atau gagal saat dicatat.
--
-- Sifat:
--   - Hanya mengubah tipe kolom quantity: INT -> NUMERIC.
--   - Tidak mengubah data, nama kolom, constraint, index, atau grant.
--   - Nilai integer yang sudah ada tetap sama.
--
-- CATATAN:
--   File ini TIDAK dieksekusi otomatis. Jangan jalankan di produksi
--   tanpa backup dan persetujuan. Rollback tersedia di file 010_..._rollback.sql.
-- ============================================================

BEGIN;

ALTER TABLE public.stock_mutations
  ALTER COLUMN quantity TYPE NUMERIC USING quantity::numeric;

COMMIT;
