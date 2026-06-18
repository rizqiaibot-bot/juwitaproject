-- ============================================================
-- PORTAL KARYAWAN - SKEMA DATABASE
-- Jalankan di SQL Editor Supabase
-- ============================================================

-- Tabel karyawan
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel absensi harian
CREATE TABLE IF NOT EXISTS attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) NOT NULL,
  date DATE NOT NULL,
  check_in TIME,
  check_out TIME,
  is_break BOOLEAN DEFAULT FALSE,
  break_start TIME,
  break_end TIME,
  overtime_minutes INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, date)
);

-- Tabel tugas harian
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) NOT NULL,
  date DATE NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel KPI bulanan
CREATE TABLE IF NOT EXISTS kpi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) NOT NULL,
  month INT NOT NULL,
  year INT NOT NULL,
  attendance_score DECIMAL(5,2),
  punctuality_score DECIMAL(5,2),
  overtime_score DECIMAL(5,2),
  task_completion_score DECIMAL(5,2),
  total_score DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, month, year)
);

-- Tabel ringkasan bulanan
CREATE TABLE IF NOT EXISTS monthly_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) NOT NULL,
  month INT NOT NULL,
  year INT NOT NULL,
  present_days INT DEFAULT 0,
  late_days INT DEFAULT 0,
  alpha_days INT DEFAULT 0,
  overtime_hours DECIMAL(5,1) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, month, year)
);

-- ============================================================
-- DATA SEEDING
-- ============================================================

-- Insert employee
INSERT INTO employees (id, name, email)
VALUES ('c0a80121-0001-4000-8000-000000000001', 'Muhamad Rizkin', 'rizkin@juwita.com')
ON CONFLICT (id) DO NOTHING;

-- Insert attendance hari ini
INSERT INTO attendance (employee_id, date, check_in, overtime_minutes)
VALUES ('c0a80121-0001-4000-8000-000000000001', CURRENT_DATE, '10:00:00', 29)
ON CONFLICT (employee_id, date) DO NOTHING;

-- Insert tasks hari ini
INSERT INTO tasks (employee_id, date, description, status)
VALUES
  ('c0a80121-0001-4000-8000-000000000001', CURRENT_DATE, 'Cek stok gudang barang frozen', 'pending'),
  ('c0a80121-0001-4000-8000-000000000001', CURRENT_DATE, 'Input data penjualan kemarin', 'pending'),
  ('c0a80121-0001-4000-8000-000000000001', CURRENT_DATE, 'Buat laporan stok mingguan', 'done');

-- Insert KPI bulan ini
INSERT INTO kpi (employee_id, month, year, attendance_score, punctuality_score, overtime_score, task_completion_score, total_score)
VALUES ('c0a80121-0001-4000-8000-000000000001',
  EXTRACT(MONTH FROM CURRENT_DATE),
  EXTRACT(YEAR FROM CURRENT_DATE),
  94.0, 100.0, 100.0, 0.0, 72.0)
ON CONFLICT (employee_id, month, year) DO NOTHING;

-- Insert monthly summary
INSERT INTO monthly_summary (employee_id, month, year, present_days, late_days, alpha_days, overtime_hours)
VALUES ('c0a80121-0001-4000-8000-000000000001',
  EXTRACT(MONTH FROM CURRENT_DATE),
  EXTRACT(YEAR FROM CURRENT_DATE),
  15, 0, 1, 23)
ON CONFLICT (employee_id, month, year) DO NOTHING;
