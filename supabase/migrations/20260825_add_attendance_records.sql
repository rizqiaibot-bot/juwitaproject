-- ============================================================
-- ATTENDANCE RECORDS — edit absensi manual (HR > Rekap Kehadiran)
-- Non-destruktif (CREATE TABLE IF NOT EXISTS)
-- ============================================================

CREATE TABLE IF NOT EXISTS attendance_records (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  karyawan   TEXT NOT NULL,
  tanggal    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'H',
  jenis      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (karyawan, tanggal)
);

ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all attendance_records" ON attendance_records;
CREATE POLICY "Allow all attendance_records" ON attendance_records FOR ALL TO public USING (true) WITH CHECK (true);
