-- ============================================================
-- PRODUK TIMBANG (barcode Precio LP) — plu + qty/stock desimal
-- Non-destruktif: ADD COLUMN / ALTER TYPE jadi NUMERIC.
-- Tidak mengubah SKU/barcode lama.
-- Catatan: berkoordinasi dengan ubah type di stok/order_items.
-- ============================================================

-- 1. Field PLU untuk mencari produk timbang dari barcode Precio
ALTER TABLE products ADD COLUMN IF NOT EXISTS plu TEXT;
CREATE INDEX IF NOT EXISTS idx_products_plu ON products(plu);

-- 2. order_items.qty → NUMERIC agar bisa menyimpan berat desimal (mis. 0.240 kg)
ALTER TABLE order_items ALTER COLUMN qty TYPE NUMERIC USING qty::numeric;

-- 3. products.stock → NUMERIC agar pengurangan stok sesuai berat tersimpan (mis. 10 - 0.240)
ALTER TABLE products ALTER COLUMN stock TYPE NUMERIC USING stock::numeric;

-- 4. stock_mutations → qty/stock desimal (konsisten dengan produk timbang)
ALTER TABLE stock_mutations ALTER COLUMN quantity TYPE NUMERIC USING quantity::numeric;
ALTER TABLE stock_mutations ALTER COLUMN qty_before TYPE NUMERIC USING qty_before::numeric;
ALTER TABLE stock_mutations ALTER COLUMN qty_after TYPE NUMERIC USING qty_after::numeric;

-- ============================================================
-- 5. RPC sync_offline_order — dukung qty/stock desimal (produk timbang)
--    Hanya variabel internal qty/stock diubah ke NUMERIC; parameter tidak berubah.
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_offline_order(
  p_orderid         text,
  p_idempotency_key text,
  p_date            text,
  p_channel         text,
  p_customer        text,
  p_total           integer,
  p_paystatus       text,
  p_wmsstatus       text,
  p_courier         text,
  p_resi            text,
  p_payment_method  text,
  p_subtotal        integer,
  p_diskon          integer,
  p_bayar           integer,
  p_kembalian       integer,
  p_items           jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items        jsonb;
  v_item         jsonb;
  v_pid          bigint;
  v_pname        text;
  v_qty          numeric;
  v_price        integer;
  v_subtotal     integer;
  v_stock        numeric;
  v_qty_before   numeric;
  v_qty_after    numeric;
  v_existing_id  text;
  v_missing      bigint[] := '{}';
  v_seen         bigint[] := '{}';
  v_constraint   text;
BEGIN
  -- ============================================================
  -- 1. VALIDASI INPUT DASAR
  -- ============================================================
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'idempotency_key wajib diisi');
  END IF;

  v_items := p_items;
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'items tidak boleh kosong');
  END IF;

  -- ============================================================
  -- 2. GUARD IDEMPOTENCY
  -- ============================================================
  SELECT orderid INTO v_existing_id
  FROM orders
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already_exists', 'orderid', v_existing_id);
  END IF;

  -- ============================================================
  -- 3. VALIDASI ITEM (sebelum sentuh DB apa pun)
  -- ============================================================
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    BEGIN
      v_pid := (v_item->>'product_id')::bigint;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'product_id invalid');
    END;

    IF v_item ? 'product_id' = false THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'product_id wajib ada');
    END IF;
    IF v_pid IS NULL OR v_pid <= 0 THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'product_id invalid');
    END IF;

    BEGIN
      v_qty := (v_item->>'qty')::numeric;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'qty invalid');
    END;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'qty harus > 0');
    END IF;

    BEGIN
      v_price := (v_item->>'price')::integer;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'price invalid');
    END;
    IF v_price IS NULL OR v_price < 0 THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'price invalid');
    END IF;

    BEGIN
      v_subtotal := (v_item->>'subtotal')::integer;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'subtotal invalid');
    END;
    IF v_subtotal IS NULL OR v_subtotal < 0 THEN
      RETURN jsonb_build_object('status', 'error', 'message', 'subtotal invalid');
    END IF;

    IF v_pid = ANY (v_seen) THEN
      RETURN jsonb_build_object(
        'status', 'error',
        'message', 'product_id duplikat dalam items',
        'product_id', v_pid
      );
    END IF;
    v_seen := v_seen || v_pid;
  END LOOP;

  -- ============================================================
  -- 4. VALIDASI STOK + LOCK produk (FOR UPDATE → serial antar kasir)
  -- ============================================================
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    v_pid := (v_item->>'product_id')::bigint;
    v_qty := (v_item->>'qty')::numeric;

    SELECT name, stock INTO v_pname, v_stock
    FROM products WHERE id = v_pid FOR UPDATE;

    IF NOT FOUND THEN
      v_missing := v_missing || v_pid;
      CONTINUE;
    END IF;

    IF v_stock < v_qty THEN
      RETURN jsonb_build_object(
        'status', 'insufficient_stock',
        'orderid', p_orderid,
        'product_id', v_pid,
        'available', v_stock,
        'requested', v_qty
      );
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'error',
      'message', 'produk tidak ditemukan',
      'missing_products', to_jsonb(v_missing)
    );
  END IF;

  -- ============================================================
  -- 5. INSERT ORDER
  -- ============================================================
  INSERT INTO orders (
    orderid, idempotency_key, date, channel, customer, total,
    paystatus, wmsstatus, courier, resi, payment_method,
    subtotal, diskon, bayar, kembalian
  ) VALUES (
    p_orderid, p_idempotency_key, p_date, p_channel, p_customer, p_total,
    p_paystatus, p_wmsstatus, p_courier, p_resi, p_payment_method,
    p_subtotal, p_diskon, p_bayar, p_kembalian
  );

  -- ============================================================
  -- 6. ITEMS: order_items + update stock + stock_mutations (OUT)
  -- ============================================================
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    v_pid      := (v_item->>'product_id')::bigint;
    v_pname    := v_item->>'product_name';
    v_qty      := (v_item->>'qty')::numeric;
    v_price    := (v_item->>'price')::integer;
    v_subtotal := (v_item->>'subtotal')::integer;

    SELECT stock INTO v_qty_before
    FROM products WHERE id = v_pid FOR UPDATE;

    v_qty_after := v_qty_before - v_qty;

    INSERT INTO order_items (orderid, product_id, product_name, qty, price, subtotal)
    VALUES (p_orderid, v_pid, v_pname, v_qty, v_price, v_subtotal);

    UPDATE products SET stock = v_qty_after WHERE id = v_pid;

    INSERT INTO stock_mutations (
      product_id, product_name, type, quantity,
      qty_before, qty_after, source, sync_status
    ) VALUES (
      v_pid, v_pname, 'OUT', v_qty,
      v_qty_before, v_qty_after, 'POS: ' || p_orderid, 'pending'
    );
  END LOOP;

  -- ============================================================
  -- 7. SUCCESS
  -- ============================================================
  RETURN jsonb_build_object('status', 'created', 'orderid', p_orderid);

EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

    IF v_constraint = 'orders_pkey' THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'message', 'orderid sudah ada; buat orderid baru atau gunakan retry idempotency',
        'orderid', p_orderid
      );
    ELSIF v_constraint = 'uq_orders_idempotency_key' THEN
      SELECT orderid INTO v_existing_id
      FROM orders WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN
        RETURN jsonb_build_object('status', 'already_exists', 'orderid', v_existing_id);
      END IF;
      RETURN jsonb_build_object('status', 'conflict', 'message', 'konflik idempotency_key', 'orderid', p_orderid);
    ELSE
      RETURN jsonb_build_object('status', 'conflict', 'message', 'constraint: ' || v_constraint, 'orderid', p_orderid);
    END IF;
  WHEN others THEN
    RAISE EXCEPTION 'sync_offline_order gagal: %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_offline_order TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_offline_order FROM PUBLIC;
