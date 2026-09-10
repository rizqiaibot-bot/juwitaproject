-- ============================================================
-- AKUNTANSI V1 — JUWITA ONE
-- ============================================================
-- 1. accounting_accounts   : master 5 akun (CASH/BRI/BCA/QRIS/RECEIVABLE).
-- 2. accounting_transactions : ledger tunggal; SALDO TIDAK DISIMPAN,
--    selalu dihitung dari jurnal.
-- 3. v_account_balance     : view saldo per akun + akumulasi.
-- 4. accounting_meta       : watermark mulai sinkron POS (transaksi lama
--    sebelum V1 TIDAK di-import).
-- 5. accounting_sync_pos() : cron 5 mnt + tombol manual; idempoten via
--    ref_type='pos_order' + ref_id=orderid; EDC→BRI; TRANSFER non-split
--    tanpa bank TIDAK ditebak (dilaporkan unmapped).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.accounting_accounts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('CASH','BANK','EWALLET','RECEIVABLE')),
  sort_order  INT  NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.accounting_transactions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trx_date    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type        TEXT NOT NULL CHECK (type IN ('IN','OUT','TRANSFER','PIUTANG_PAYMENT','POS_SALE')),
  keterangan  TEXT,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  akun_dari   BIGINT REFERENCES public.accounting_accounts(id),
  akun_ke     BIGINT REFERENCES public.accounting_accounts(id),
  ref_type    TEXT,
  ref_id      TEXT,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT accounting_trx_direction_check CHECK (
    (type = 'IN'              AND akun_dari IS NULL AND akun_ke IS NOT NULL) OR
    (type = 'OUT'             AND akun_dari IS NOT NULL AND akun_ke IS NULL) OR
    (type = 'TRANSFER'        AND akun_dari IS NOT NULL AND akun_ke IS NOT NULL AND akun_dari <> akun_ke) OR
    (type = 'PIUTANG_PAYMENT' AND akun_dari IS NOT NULL AND akun_ke IS NOT NULL AND akun_dari <> akun_ke) OR
    (type = 'POS_SALE'        AND akun_dari IS NULL AND akun_ke IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_accounting_trx_date ON public.accounting_transactions(trx_date DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_trx_ref ON public.accounting_transactions(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_accounting_trx_akun_ke ON public.accounting_transactions(akun_ke);
CREATE INDEX IF NOT EXISTS idx_accounting_trx_akun_dari ON public.accounting_transactions(akun_dari);

CREATE TABLE IF NOT EXISTS public.accounting_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ============================================================
-- SEED 5 AKUN (V1)
-- ============================================================
INSERT INTO public.accounting_accounts (code, name, type, sort_order) VALUES
  ('CASH',       'Laci Kasir',  'CASH',       1),
  ('BRI',        'BRI',         'BANK',       2),
  ('BCA',        'BCA',         'BANK',       3),
  ('QRIS',       'QRIS',        'EWALLET',    4),
  ('RECEIVABLE', 'Piutang',     'RECEIVABLE', 5)
ON CONFLICT (code) DO NOTHING;

-- Watermark sinkron POS: hanya order POS dengan tanggal >= titik ini yang
-- akan di-import. Transaksi POS sebelum V1 TIDAK di-import.
INSERT INTO public.accounting_meta (key, value)
VALUES ('pos_sync_start', to_char(NOW(), 'YYYY-MM-DD HH24:MI'))
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- VIEW SALDO (saldo TIDAK disimpan — dihitung dari jurnal)
-- ============================================================
CREATE OR REPLACE VIEW public.v_account_balance AS
SELECT
  a.id,
  a.code,
  a.name,
  a.type,
  a.sort_order,
  COALESCE(SUM(
      CASE WHEN t.akun_ke   = a.id THEN t.amount ELSE 0 END
    - CASE WHEN t.akun_dari = a.id THEN t.amount ELSE 0 END
  ), 0)::bigint AS saldo
FROM public.accounting_accounts a
LEFT JOIN public.accounting_transactions t
  ON t.akun_ke = a.id OR t.akun_dari = a.id
GROUP BY a.id, a.code, a.name, a.type, a.sort_order;

-- ============================================================
-- FUNGSI SINKRON POS (cron 5 menit + tombol manual)
-- ============================================================
CREATE OR REPLACE FUNCTION public.accounting_sync_pos()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start       TEXT;
  v_cash_id     BIGINT;
  v_bri_id      BIGINT;
  v_bca_id      BIGINT;
  v_qris_id     BIGINT;
  v_recv_id     BIGINT;
  rec           RECORD;
  v_pm          TEXT;
  v_acc         TEXT;
  v_amount      INTEGER;
  v_total       INTEGER;
  v_processed   INTEGER := 0;
  v_unmapped    TEXT[] := '{}';
  v_leg         TEXT[];
  v_bank        TEXT;
  v_method      TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('juwita_accounting_sync'));

  SELECT id INTO v_cash_id FROM public.accounting_accounts WHERE code = 'CASH';
  SELECT id INTO v_bri_id  FROM public.accounting_accounts WHERE code = 'BRI';
  SELECT id INTO v_bca_id  FROM public.accounting_accounts WHERE code = 'BCA';
  SELECT id INTO v_qris_id FROM public.accounting_accounts WHERE code = 'QRIS';
  SELECT id INTO v_recv_id FROM public.accounting_accounts WHERE code = 'RECEIVABLE';

  v_start := COALESCE((SELECT value FROM public.accounting_meta WHERE key = 'pos_sync_start'), '1970-01-01 00:00');

  FOR rec IN
    SELECT orderid, date, payment_method, total
    FROM public.orders
    WHERE channel IN ('POS1','POS2')
      AND date >= v_start
      AND orderid NOT IN (
        SELECT ref_id FROM public.accounting_transactions WHERE ref_type = 'pos_order'
      )
    ORDER BY orderid
  LOOP
    v_pm    := LOWER(BTRIM(COALESCE(rec.payment_method::TEXT, '')));
    v_total := COALESCE(rec.total, 0);
    v_acc   := NULL;

    -- ====================================================
    -- 1) SPLIT → parse tiap leg
    -- ====================================================
    IF v_pm LIKE 'split:%' THEN
      v_amount := 0;
      FOR v_leg IN SELECT regexp_matches(v_pm, '([a-z]+)\s+([0-9][0-9.]*)\s*(?:\(([a-z]+)\))?', 'g')
      LOOP
        v_method := v_leg[1];
        v_bank   := v_leg[3];
        v_acc    := NULL;
        IF v_method = 'cash'   THEN v_acc := 'CASH';
        ELSIF v_method = 'qris'  THEN v_acc := 'QRIS';
        ELSIF v_method = 'edc'   THEN v_acc := 'BRI';
        ELSIF v_method = 'piutang' THEN v_acc := 'RECEIVABLE';
        ELSIF v_method = 'transfer' THEN
          IF v_bank = 'bri' THEN v_acc := 'BRI';
          ELSIF v_bank = 'bca' THEN v_acc := 'BCA';
          END IF;
        END IF;
        IF v_acc IS NULL THEN
          v_unmapped := v_unmapped || rec.orderid;
          CONTINUE;
        END IF;
        v_amount := REPLACE(v_leg[2], '.', '')::INTEGER;
        INSERT INTO public.accounting_transactions
          (trx_date, type, keterangan, amount, akun_ke, ref_type, ref_id)
        VALUES
          ((rec.date::timestamp) AT TIME ZONE 'Asia/Jakarta', 'POS_SALE',
           'Penjualan POS ' || rec.orderid, v_amount,
           CASE v_acc WHEN 'CASH' THEN v_cash_id WHEN 'BRI' THEN v_bri_id
                      WHEN 'BCA' THEN v_bca_id WHEN 'QRIS' THEN v_qris_id
                      WHEN 'RECEIVABLE' THEN v_recv_id END,
           'pos_order', rec.orderid);
        v_processed := v_processed + 1;
      END LOOP;

    -- ====================================================
    -- 2) NON-SPLIT
    -- ====================================================
    ELSE
      IF v_pm = 'cash'    THEN v_acc := 'CASH';
      ELSIF v_pm = 'qris'  THEN v_acc := 'QRIS';
      ELSIF v_pm = 'edc'   THEN v_acc := 'BRI';   -- EDC → BRI
      ELSIF v_pm = 'piutang' THEN v_acc := 'RECEIVABLE';
      ELSIF v_pm LIKE 'transfer%' THEN v_acc := NULL; -- tanpa bank → jangan ditebak
      ELSIF v_pm = '' OR v_pm IS NULL THEN v_acc := NULL;
      END IF;

      IF v_acc IS NULL THEN
        IF v_pm IS NOT NULL AND v_pm <> '' THEN v_unmapped := v_unmapped || rec.orderid; END IF;
        CONTINUE;
      END IF;

      INSERT INTO public.accounting_transactions
        (trx_date, type, keterangan, amount, akun_ke, ref_type, ref_id)
      VALUES
        ((rec.date::timestamp) AT TIME ZONE 'Asia/Jakarta', 'POS_SALE',
         'Penjualan POS ' || rec.orderid, v_total,
         CASE v_acc WHEN 'CASH' THEN v_cash_id WHEN 'BRI' THEN v_bri_id
                    WHEN 'BCA' THEN v_bca_id WHEN 'QRIS' THEN v_qris_id
                    WHEN 'RECEIVABLE' THEN v_recv_id END,
         'pos_order', rec.orderid);
      v_processed := v_processed + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'processed_orders', v_processed,
    'unmapped', to_jsonb(v_unmapped)
  );
END;
$$;

GRANT SELECT ON public.accounting_accounts, public.accounting_transactions, public.accounting_meta TO authenticated;
GRANT SELECT ON public.v_account_balance TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.accounting_accounts, public.accounting_transactions TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_sync_pos() TO authenticated;

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.accounting_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_meta ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accounting_accounts_auth_all" ON public.accounting_accounts;
CREATE POLICY "accounting_accounts_auth_all"
  ON public.accounting_accounts FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "accounting_transactions_auth_all" ON public.accounting_transactions;
CREATE POLICY "accounting_transactions_auth_all"
  ON public.accounting_transactions FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "accounting_meta_auth_all" ON public.accounting_meta;
CREATE POLICY "accounting_meta_auth_all"
  ON public.accounting_meta FOR ALL TO authenticated USING (true) WITH CHECK (true);
