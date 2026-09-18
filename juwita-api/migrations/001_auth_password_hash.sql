-- ============================================================
-- MIGRATION 001 — AUTH MANDIRI TAHAP M1
-- Tambah kolom password_hash (nullable) untuk auth mandiri.
-- ============================================================
-- Non-destruktif: hanya ADD COLUMN, TIDAK menyentuh data user,
-- role, menus, RLS, auth_user_id, maupun tabel lain.
--
-- password_hash dibuat NULLABLE agar rollout bertahap:
--   - data lama tetap valid (belum ada password),
--   - diisi bertahap saat reset password (lihat docs/auth-migration-plan.md §5).
--
-- auth_user_id TIDAK diubah/dihapus (masih jadi referensi lama
-- dan cadangan rollback ke Supabase Auth).
--
-- Idempotent: memakai IF NOT EXISTS.
-- ============================================================

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;
