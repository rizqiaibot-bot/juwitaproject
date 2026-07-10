-- Tabel penerimaan barang
CREATE TABLE IF NOT EXISTS warehouse_receiving (
  id BIGINT PRIMARY KEY,
  po_number TEXT,
  product_id BIGINT,
  product_name TEXT,
  supplier TEXT,
  quantity INT,
  received_date DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel rak & lokasi gudang
CREATE TABLE IF NOT EXISTS warehouse_racks (
  id BIGINT PRIMARY KEY,
  zone TEXT NOT NULL,
  rack_name TEXT NOT NULL,
  product_id BIGINT,
  capacity INT DEFAULT 100,
  filled INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabel sesi opname
CREATE TABLE IF NOT EXISTS warehouse_opname (
  id TEXT PRIMARY KEY,
  zone TEXT NOT NULL,
  officer TEXT,
  session_date DATE DEFAULT CURRENT_DATE,
  status TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed data rak
INSERT INTO warehouse_racks (id, zone, rack_name, product_id, capacity, filled) VALUES
  (1, 'Zone A', 'Rak 1', 18, 500, 320),
  (2, 'Zone A', 'Rak 2', NULL, 300, 150),
  (3, 'Zone B', 'Rak 1', 23, 400, 280),
  (4, 'Zone C', 'Freezer 1', 1, 300, 200)
ON CONFLICT (id) DO NOTHING;

-- Seed data penerimaan
INSERT INTO warehouse_receiving (id, po_number, product_id, product_name, supplier, quantity, received_date, notes) VALUES
  (1, 'PO-2026-001', 18, 'ROTI TAWAR GANDUM', 'PT Sinar Roti', 200, '2026-06-15', 'Kondisi baik'),
  (2, 'PO-2026-002', 23, 'SUSU SEGAR UHT 1L', 'UD Niaga Bersama', 150, '2026-06-14', 'Segel utuh')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- RLS + POLICIES (konsisten dengan tabel lain)
-- ============================================================
ALTER TABLE warehouse_receiving ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_racks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_opname     ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Allow all warehouse_receiving" ON warehouse_receiving FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow all warehouse_racks"      ON warehouse_racks      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Allow all warehouse_opname"     ON warehouse_opname     FOR ALL USING (true) WITH CHECK (true);
