-- ============================================================
-- MIGRATION 003 — app_users.auth_user_id jadi nullable
-- Auth mandiri lokal tidak memakai Supabase Auth (auth.users).
-- auth_user_id tetap ada untuk data lama & rollback; boleh NULL
-- untuk user baru yang dibuat via API lokal.
-- ============================================================
ALTER TABLE public.app_users
  ALTER COLUMN auth_user_id DROP NOT NULL;
