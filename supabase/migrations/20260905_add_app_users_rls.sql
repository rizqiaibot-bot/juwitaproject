-- ============================================================
-- APP_USERS + ROLE/PERMISSION + RLS (sistem user/permission Juwita One)
-- ============================================================
-- Non-destruktif. TIDAK menyimpan password (password hanya di Supabase Auth).
-- Tabel ini hanya metadata: mapping phone → auth.users + role + menus.
--
-- Alur auth yang dipakai frontend:
--   user ketik NOMOR HP + password
--   → email internal deterministik = <noHp>@juwita.local
--   → supabase.auth.signInWithPassword({ email, password })
--   → resolve profil dari app_users (RLS: hanya owner / diri sendiri)
--
-- Privilege:
--   role = 'owner' → superadmin: manage_users / manage_permissions / manage_settings
--   role lain ('kasir','gudang','hr', dst) → HANYA menu di kolom menus.
--   Karyawan TIDAK bisa mengelola app_users (policy di bawah).
--
-- Catatan seed Rizkin: Auth user harus dibuat DULU oleh pemilik di Dashboard/
-- Admin API (email <noHp>@juwita.local + password rahasia), lalu INSERT row
-- app_users (lihat blok komentar seed di akhir file). JANGAN dijalankan otomatis
-- sebelum Auth user ada (FK auth.users).
-- ============================================================

-- ============================================================
-- 1. TABEL app_users
-- ============================================================
CREATE TABLE IF NOT EXISTS public.app_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT NOT NULL UNIQUE,
  auth_user_id  UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'employee',
  role_label    TEXT,
  menus         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_users_auth_user_id ON public.app_users(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_app_users_phone ON public.app_users(phone);
CREATE INDEX IF NOT EXISTS idx_app_users_role_status ON public.app_users(role, status);

-- ============================================================
-- 2. TRIGGER updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_users_updated_at ON public.app_users;
CREATE TRIGGER trg_app_users_updated_at
  BEFORE UPDATE ON public.app_users
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 3. HELPER is_owner (dipakai RLS & aplikasi via RPC bila perlu)
--    Hanya owner/superadmin (role='owner' + ACTIVE) yang true.
-- ============================================================
CREATE OR REPLACE FUNCTION public.app_user_is_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_users
    WHERE auth_user_id = auth.uid()
      AND role = 'owner'
      AND status = 'ACTIVE'
  );
$$;

GRANT EXECUTE ON FUNCTION public.app_user_is_owner() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.app_user_is_owner() FROM PUBLIC, anon;

-- ============================================================
-- 4. RLS
--    - owner: boleh SELECT/INSERT/UPDATE/DELETE semua baris.
--    - user biasa: hanya boleh SELECT baris miliknya sendiri.
--    Karyawan TIDAK bisa membaca/mengubah user lain.
-- ============================================================
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_users_owner_all" ON public.app_users;
CREATE POLICY "app_users_owner_all"
  ON public.app_users
  FOR ALL
  USING (public.app_user_is_owner())
  WITH CHECK (public.app_user_is_owner());

DROP POLICY IF EXISTS "app_users_self_read" ON public.app_users;
CREATE POLICY "app_users_self_read"
  ON public.app_users
  FOR SELECT
  USING (auth_user_id = auth.uid());

-- ============================================================
-- 5. SEED RIZKIN (manual — jalankan SETELAH Auth user dibuat)
--    Email Auth Rizkin HARUS = '089601790213@juwita.local'
--    Password Auth ditentukan pemilik di Dashboard (bukan di sini).
-- ============================================================
-- INSERT INTO public.app_users (phone, auth_user_id, email, full_name, role, role_label, menus, status)
-- SELECT '089601790213',
--        au.id,
--        au.email,
--        'Rizkin',
--        'owner',
--        'Owner / Super Admin',
--        '["pos","penjualan","katalog","persediaan","pembelian","gudang","pricing","hr","pengaturan"]'::jsonb,
--        'ACTIVE'
-- FROM auth.users au
-- WHERE au.email = '089601790213@juwita.local'
-- ON CONFLICT (phone) DO NOTHING;
