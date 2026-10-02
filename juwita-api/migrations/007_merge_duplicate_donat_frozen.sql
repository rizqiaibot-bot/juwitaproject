-- ============================================================
-- MIGRASI DATA: merge produk duplikat 1475 -> 776 (SKU: DONAT FROZEN)
-- ============================================================
-- Status: SUDAH DIEKSEKUSI manual pada 2026-10-02 (transaksi commit).
-- File ini untuk dokumentasi/audit trail saja.
--
-- Produk utama (dipertahankan):  ID 776  (punya product_shopee_mapping
--                                Shopee 1 + order terbaru 21 Sep).
-- Produk duplikat (dihapus):     ID 1475 (tanpa mapping Shopee).
--
-- Yang dipindahkan:
--   - order_items (2 baris) 1475 -> 776 (riwayat transaksi dipertahankan).
-- Yang dibiarkan/cascade:
--   - product_prices 1475 (3 baris) ikut terhapus via ON DELETE CASCADE
--     (nilainya sama dengan 776, jadi tidak di-repoint untuk hindari
--     konflik UNIQUE (product_id, channel)).
-- Yang TIDAK diubah:
--   - stock 776 (tetap 8; stock 1475=5 TIDAK dijumlahkan).
--   - harga, modal, barcode, product_shopee_mapping 776, product_prices 776.
--
-- Backup sebelum eksekusi:
--   /tmp/juwita_one_backup_before_merge_1475.dump (pg_dump --format=custom)
-- ============================================================

BEGIN;

-- Guard: hanya order_items (repoint) & product_prices (cascade) yang boleh
-- terhubung ke 1475. Bila ada relasi lain -> abort (rollback).
DO $$
DECLARE v_cnt int;
BEGIN
  SELECT count(*) INTO v_cnt FROM stock_mutations WHERE product_id = 1475;
  IF v_cnt > 0 THEN RAISE EXCEPTION 'stock_mutations untuk 1475: %', v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM purchase_items WHERE product_id = 1475;
  IF v_cnt > 0 THEN RAISE EXCEPTION 'purchase_items untuk 1475: %', v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM warehouse_receiving WHERE product_id = 1475;
  IF v_cnt > 0 THEN RAISE EXCEPTION 'warehouse_receiving untuk 1475: %', v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM warehouse_racks WHERE product_id = 1475;
  IF v_cnt > 0 THEN RAISE EXCEPTION 'warehouse_racks untuk 1475: %', v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM activity_log WHERE product_id = 1475;
  IF v_cnt > 0 THEN RAISE EXCEPTION 'activity_log untuk 1475: %', v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM product_shopee_mapping WHERE product_id = 1475;
  IF v_cnt > 0 THEN RAISE EXCEPTION 'product_shopee_mapping untuk 1475: %', v_cnt; END IF;
END $$;

-- Repoint riwayat order_items dari 1475 ke 776.
UPDATE order_items SET product_id = 776 WHERE product_id = 1475;

-- Hapus produk duplikat 1475 (product_prices-nya ikut terhapus via ON DELETE CASCADE).
DELETE FROM products WHERE id = 1475;

COMMIT;
