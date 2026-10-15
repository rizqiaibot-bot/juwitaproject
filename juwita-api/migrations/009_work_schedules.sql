-- ============================================================
-- MIGRATION 009 — JADWAL KERJA (HR) TAHAP AWAL
-- Tabel work_schedules: jam masuk/istirahat/pulang + hari libur per karyawan.
-- ============================================================
-- Non-destruktif: CREATE TABLE IF NOT EXISTS + index + grant.
-- TIDAK menyentuh tabel/fitur lain (attendance_clock, attendance_records,
-- app_users, dll). Satu baris per karyawan (employee_id UNIQUE).
--
-- CATATAN: file ini TIDAK dijalankan otomatis. Jalankan manual hanya
-- setelah disetujui.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.work_schedules (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id UUID NOT NULL UNIQUE REFERENCES public.app_users(id) ON DELETE CASCADE,
  check_in    TIME,
  break_start TIME,
  break_end   TIME,
  check_out   TIME,
  off_days    TEXT,                       -- hari libur: CSV nomor hari 0=Minggu..6=Sabtu (mis. "0,6")
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS work_schedules_employee_idx
  ON public.work_schedules (employee_id);

-- Akses role aplikasi (backend mandiri, BYPASSRLS). Idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_schedules TO juwita_app;
GRANT USAGE, SELECT ON SEQUENCE public.work_schedules_id_seq TO juwita_app;
