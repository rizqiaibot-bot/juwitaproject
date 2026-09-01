-- ============================================================
-- GUDANG: timestamp + petugas aktivitas (Picking/Packing/Pengiriman/Opname)
-- Backward-compatible: hanya ADD COLUMN + RPC baru.
-- Tidak mengubah kolom existing, tidak mengubah RPC POS/offline/Shopee.
-- Timestamp memakai SERVER (now()) agar akurat & timezone Asia/Jakarta saat tampil.
-- ============================================================

-- 1. orders: timestamp & petugas per aktivitas gudang
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS packed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS packed_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_by TEXT;

-- 2. warehouse_opname: waktu selesai sesi opname (created_at = mulai, server)
ALTER TABLE warehouse_opname ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- ============================================================
-- 3. RPC record_warehouse_action — catat aksi gudang dengan timestamp SERVER
--    action: 'pick' → Dipick + picked_at/by
--            'pack' → Siap Kirim + packed_at/by
--            'ship' → Dikirim + shipped_at/by + courier/resi
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_warehouse_action(
  p_order_id text,
  p_action   text,
  p_petugas  text DEFAULT NULL,
  p_courier  text DEFAULT NULL,
  p_resi     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res jsonb;
BEGIN
  IF p_order_id IS NULL OR p_order_id = '' OR p_action IS NULL OR p_action NOT IN ('pick','pack','ship') THEN
    RETURN jsonb_build_object('status','error','message','parameter tidak valid');
  END IF;

  IF p_action = 'pick' THEN
    UPDATE orders
    SET wmsstatus = 'Dipick', picked_at = now(), picked_by = p_petugas
    WHERE orderid = p_order_id;
  ELSIF p_action = 'pack' THEN
    UPDATE orders
    SET wmsstatus = 'Siap Kirim', packed_at = now(), packed_by = p_petugas
    WHERE orderid = p_order_id;
  ELSE
    UPDATE orders
    SET wmsstatus = 'Dikirim',
        shipped_at = now(), shipped_by = p_petugas,
        courier = COALESCE(NULLIF(p_courier,''), courier),
        resi    = COALESCE(NULLIF(p_resi,''), resi)
    WHERE orderid = p_order_id;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','error','message','order tidak ditemukan');
  END IF;

  SELECT jsonb_build_object(
    'status','ok','orderid',orderid,'wmsstatus',wmsstatus,
    'picked_at',picked_at,'picked_by',picked_by,
    'packed_at',packed_at,'packed_by',packed_by,
    'shipped_at',shipped_at,'shipped_by',shipped_by,
    'courier',courier,'resi',resi
  ) INTO v_res
  FROM orders WHERE orderid = p_order_id;

  RETURN v_res;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_warehouse_action TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_warehouse_action FROM PUBLIC;

-- ============================================================
-- 4. RPC close_opname — selesaikan sesi opname (closed_at = server time)
-- ============================================================
CREATE OR REPLACE FUNCTION public.close_opname(
  p_opname_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res jsonb;
BEGIN
  UPDATE warehouse_opname
  SET status = 'closed', closed_at = now()
  WHERE id = p_opname_id AND status = 'open';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','error','message','sesi opname tidak ditemukan / sudah ditutup');
  END IF;

  SELECT jsonb_build_object('status','ok','id',id,'zone',zone,'closed_at',closed_at)
  INTO v_res FROM warehouse_opname WHERE id = p_opname_id;

  RETURN v_res;
END;
$$;

GRANT EXECUTE ON FUNCTION public.close_opname TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.close_opname FROM PUBLIC;
