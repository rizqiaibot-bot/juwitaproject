-- ============================================================
-- AKUNTANSI V1 — GUARD TRANSFER ANTAR AKUN
-- ============================================================
-- Validasi saldo akun asal SEBELUM INSERT jurnal untuk tipe
-- TRANSFER dan PIUTANG_PAYMENT. Mencegah saldo minus walau UI
-- dilewati (aman di database, tidak bisa bypass).
-- Uang Masuk (IN), Uang Keluar (OUT), dan POS_SALE tidak diubah.
-- ============================================================

CREATE OR REPLACE FUNCTION public.accounting_guard_transfer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saldo      bigint;
  v_name       text;
  v_saldo_txt  text;
  v_amount_txt text;
BEGIN
  IF NEW.type NOT IN ('TRANSFER', 'PIUTANG_PAYMENT') THEN
    RETURN NEW;
  END IF;
  IF NEW.akun_dari IS NULL THEN
    RETURN NEW;
  END IF;

  -- Serialisasi per akun asal agar cek saldo + insert atomik (anti race).
  PERFORM pg_advisory_xact_lock(hashtext('acc_from:' || NEW.akun_dari::text));

  SELECT name INTO v_name FROM public.accounting_accounts WHERE id = NEW.akun_dari;

  SELECT COALESCE(SUM(
      CASE WHEN t.akun_ke   = NEW.akun_dari THEN t.amount ELSE 0 END
    - CASE WHEN t.akun_dari = NEW.akun_dari THEN t.amount ELSE 0 END
  ), 0)
  INTO v_saldo
  FROM public.accounting_transactions t
  WHERE t.akun_ke = NEW.akun_dari OR t.akun_dari = NEW.akun_dari;

  v_saldo_txt  := 'Rp' || replace(to_char(v_saldo, 'FM999,999,999,999'), ',', '.');
  v_amount_txt := 'Rp' || replace(to_char(NEW.amount, 'FM999,999,999,999'), ',', '.');

  IF v_saldo < NEW.amount THEN
    RAISE EXCEPTION 'Saldo % tidak mencukupi. Saldo tersedia %, nominal transfer %.',
      COALESCE(v_name, 'akun'), v_saldo_txt, v_amount_txt;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounting_guard_transfer ON public.accounting_transactions;
CREATE TRIGGER trg_accounting_guard_transfer
  BEFORE INSERT ON public.accounting_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.accounting_guard_transfer();
