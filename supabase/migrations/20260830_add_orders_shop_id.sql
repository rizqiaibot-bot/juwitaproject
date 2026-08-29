-- ============================================================
-- ORDERS: kolom shop_id untuk membedakan transaksi Shopee per akun
-- Non-destruktif & backward-compatible.
-- - Transaksi POS/WhatsApp: shop_id tetap NULL.
-- - Transaksi Shopee baru: diisi oleh pull-orders / import manual.
-- - Backfill lama: HANYA memakai relasi terbukti
--   marketplace_orders.internal_order_id → orders.orderid.
-- - Baris tanpa bukti relasi tetap NULL (tidak menebak).
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shop_id TEXT;

-- Backfill: 36 transaksi Shopee lama (channel='Shopee') yang terhubung ke
-- marketplace_orders akan terisi shop_id asal akun (terbukti = 724153261).
UPDATE orders o
SET shop_id = mo.shop_id
FROM marketplace_orders mo
WHERE o.orderid = mo.internal_order_id
  AND o.shop_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_shop_id ON orders(shop_id);
