-- Modul Pembelian (PO) — tabel supplier, PO header, dan PO items.
-- Tidak mengubah/menghapus data existing. Supplier di-seed dari nama supplier
-- yang sudah ada di data existing (products.supplier & warehouse_receiving.supplier).

CREATE TABLE IF NOT EXISTS suppliers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  contact_person text,
  phone text,
  address text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_number text NOT NULL UNIQUE,
  supplier_id bigint NOT NULL REFERENCES suppliers(id),
  purchase_date date NOT NULL DEFAULT CURRENT_DATE,
  payment_status text NOT NULL DEFAULT 'Belum',    -- Belum | Sebagian | Lunas
  receiving_status text NOT NULL DEFAULT 'Belum',  -- Belum | Sebagian | Diterima
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_id bigint NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id),
  product_name text,
  qty integer NOT NULL,
  qty_received integer NOT NULL DEFAULT 0,
  harga_beli integer NOT NULL,
  subtotal integer NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

-- Seed supplier nyata dari data existing (bukan dummy). Idempoten via ON CONFLICT.
INSERT INTO suppliers (name)
SELECT DISTINCT supplier FROM products WHERE supplier IS NOT NULL AND btrim(supplier) <> ''
ON CONFLICT (name) DO NOTHING;

INSERT INTO suppliers (name)
SELECT DISTINCT supplier FROM warehouse_receiving WHERE supplier IS NOT NULL AND btrim(supplier) <> ''
ON CONFLICT (name) DO NOTHING;
