-- ============================================================
-- MIGRATION 008 — KEHADIRAN (ABSEN KAMERA) TAHAP AWAL
-- Tabel attendance_clock: absen masuk/pulang harian + foto selfie.
-- ============================================================
-- Non-destruktif: hanya CREATE TABLE IF NOT EXISTS + index.
-- TIDAK menyentuh tabel/fitur lain (attendance_records / Rekap
-- Kehadiran tetap utuh), role, menus, RLS app_users, dsb.
--
-- Waktu dicatat server-side (NOW()) dan tanggal kerja memakai
-- zona Asia/Jakarta: (NOW() AT TIME ZONE 'Asia/Jakarta')::date.
--
-- Cegah absen ganda: 1 baris per (employee_id, work_date).
--
-- CATATAN: file ini TIDAK dijalankan otomatis. Jalankan manual
-- hanya setelah disetujui.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.attendance_clock (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id     UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  employee_name   TEXT NOT NULL,
  work_date       DATE NOT NULL,
  check_in_at     TIMESTAMPTZ,
  check_in_photo  TEXT,
  check_out_at    TIMESTAMPTZ,
  check_out_photo TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_clock_employee_date_key UNIQUE (employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS attendance_clock_work_date_idx
  ON public.attendance_clock (work_date);

CREATE INDEX IF NOT EXISTS attendance_clock_employee_idx
  ON public.attendance_clock (employee_id);

-- Akses role aplikasi (backend mandiri, BYPASSRLS). Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_clock TO juwita_app;
GRANT USAGE, SELECT ON SEQUENCE public.attendance_clock_id_seq TO juwita_app;
