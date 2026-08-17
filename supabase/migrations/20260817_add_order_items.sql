-- ============================================================
-- ORDER ITEMS + kolom ringkasan pembayaran pada orders
-- Non-destruktif (ADD COLUMN IF NOT EXISTS + CREATE TABLE IF NOT EXISTS)
-- Tidak mengubah tabel lain.
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS diskon INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bayar INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kembalian INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS order_items (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orderid      TEXT NOT NULL,
  product_id   BIGINT,
  product_name TEXT NOT NULL,
  qty          INTEGER NOT NULL,
  price        INTEGER NOT NULL,
  subtotal     INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_orderid ON order_items (orderid);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all order_items" ON order_items;
CREATE POLICY "Allow all order_items" ON order_items FOR ALL TO public USING (true) WITH CHECK (true);
