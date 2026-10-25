-- ============================================================
-- ROLLBACK MIGRATION 010 - STOCK_MUTATIONS.QUANTITY -> INTEGER
-- ============================================================
-- Rollback HANYA aman jika quantity masih dalam rentang INTEGER dan
-- tidak ada nilai desimal. Guard akan membatalkan rollback bila menemukan
-- quantity pecahan atau di luar batas INTEGER, agar tidak ada konversi
-- diam-diam atau kegagalan overflow.
--
-- CATATAN: Jangan jalankan di produksi tanpa backup dan persetujuan.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.stock_mutations
  WHERE quantity IS NOT NULL
    AND (
      quantity <> trunc(quantity)
      OR quantity > 2147483647
      OR quantity < -2147483648
    );

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'Rollback dibatalkan: ada % baris stock_mutations dengan quantity desimal atau di luar batas INTEGER. Hapus/arsipkan atau konversi eksplisit sebelum rollback.',
      v_count;
  END IF;
END $$;

ALTER TABLE public.stock_mutations
  ALTER COLUMN quantity TYPE INTEGER USING quantity::integer;

COMMIT;
