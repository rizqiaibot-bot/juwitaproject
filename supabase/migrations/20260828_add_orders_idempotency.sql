-- ============================================================
-- ORDERS: idempotency_key untuk transaksi POS offline/reconnect
-- Non-destruktif. idempotency_key nullable agar order online legacy
-- (yang belum punya key) tidak terpengaruh.
-- UNIQUE membuat index b-tree otomatis → TIDAK perlu CREATE INDEX tambahan.
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_orders_idempotency_key'
      AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT uq_orders_idempotency_key UNIQUE (idempotency_key);
  END IF;
END;
$$;
