-- orders.order_time: waktu transaksi ASLI (untuk Shopee = create_time dari marketplace_orders.raw_payload),
-- sehingga laporan/rekap memakai waktu order asli (WIB), bukan waktu import/promote ke tabel orders.
-- POS tetap memakai kolom date (sudah jam lokal WIB).

ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_time timestamptz;

-- Backfill: Shopee → create_time (unix detik) dari raw_payload marketplace_orders.
UPDATE orders o
SET order_time = to_timestamp((m.raw_payload->>'create_time')::bigint)
FROM marketplace_orders m
WHERE m.internal_order_id = o.orderid
  AND o.channel = 'Shopee'
  AND o.order_time IS NULL;
