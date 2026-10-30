-- ============================================================
-- Skema MINIMAL untuk test integrasi sinkronisasi stok.
-- HANYA untuk database test sementara — JANGAN dijalankan di production.
-- Kolom meniru supabase-migration.sql, shopee-sync-schema.sql,
-- marketplace-schema.sql dan migrations/ (stok NUMERIC, orders_pkey,
-- uq_orders_idempotency_key, marketplace_orders per shop_id).
-- ============================================================
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE TABLE products (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Test',
  price INTEGER NOT NULL DEFAULT 0,
  modal INTEGER NOT NULL DEFAULT 0,
  stock NUMERIC NOT NULL DEFAULT 0,
  minstock INTEGER NOT NULL DEFAULT 0,
  maxstock INTEGER NOT NULL DEFAULT 100,
  sku TEXT,
  barcode TEXT
);

CREATE TABLE orders (
  orderid TEXT,
  date TEXT NOT NULL,
  channel TEXT NOT NULL,
  shop_id TEXT,
  customer TEXT NOT NULL DEFAULT 'Walk-in Customer',
  total INTEGER NOT NULL DEFAULT 0,
  paystatus TEXT NOT NULL DEFAULT 'Lunas',
  wmsstatus TEXT NOT NULL DEFAULT 'Selesai',
  courier TEXT DEFAULT 'Self-Pickup',
  resi TEXT DEFAULT '-',
  items JSONB DEFAULT '[]'::jsonb,
  payment_method TEXT,
  subtotal INTEGER DEFAULT 0,
  diskon INTEGER DEFAULT 0,
  bayar INTEGER DEFAULT 0,
  kembalian INTEGER DEFAULT 0,
  kasir TEXT,
  idempotency_key TEXT,
  order_time TIMESTAMPTZ,
  CONSTRAINT orders_pkey PRIMARY KEY (orderid),
  CONSTRAINT uq_orders_idempotency_key UNIQUE (idempotency_key)
);

CREATE TABLE order_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orderid TEXT NOT NULL,
  product_id BIGINT,
  product_name TEXT NOT NULL,
  qty NUMERIC NOT NULL,
  price INTEGER NOT NULL,
  subtotal INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stock_mutations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL,
  product_name TEXT,
  type TEXT NOT NULL CHECK (type IN ('IN', 'OUT', 'ADJUST')),
  quantity NUMERIC NOT NULL,
  qty_before NUMERIC,
  qty_after NUMERIC,
  source TEXT,
  shopee_account TEXT DEFAULT 'toko_1',
  sync_status TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
  shopee_item_id BIGINT,
  shopee_sku TEXT,
  shopee_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE marketplace_config (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform TEXT NOT NULL,
  account_label TEXT,
  shop_id TEXT NOT NULL,
  shop_name TEXT,
  is_active BOOLEAN DEFAULT true,
  connection_status TEXT DEFAULT 'connected',
  UNIQUE (platform, shop_id)
);

CREATE TABLE marketplace_credentials (
  shop_id TEXT PRIMARY KEY,
  platform TEXT DEFAULT 'shopee',
  access_token TEXT,
  refresh_token TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE activity_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_batch_id TEXT,
  event_type TEXT NOT NULL,
  direction TEXT,
  platform TEXT DEFAULT 'shopee',
  shop_id TEXT,
  product_id BIGINT,
  product_name TEXT,
  qty_after NUMERIC,
  reference_id TEXT,
  status TEXT DEFAULT 'pending',
  triggered_by TEXT,
  action_source TEXT,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE marketplace_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform TEXT DEFAULT 'shopee',
  shop_id TEXT,
  mp_order_id TEXT NOT NULL,
  internal_order_id TEXT,
  customer_name TEXT,
  total INT DEFAULT 0,
  order_status TEXT DEFAULT 'pending',
  sync_status TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'processing', 'ready_import', 'processed', 'failed', 'ignored')),
  raw_payload JSONB DEFAULT '{}'::jsonb,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (platform, shop_id, mp_order_id)
);

CREATE TABLE product_shopee_mapping (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id),
  shop_id TEXT NOT NULL,
  shopee_item_id BIGINT NOT NULL,
  UNIQUE (shop_id, shopee_item_id)
);

CREATE TABLE product_prices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (product_id, channel)
);

CREATE TABLE app_users (
  id TEXT PRIMARY KEY,
  phone TEXT,
  full_name TEXT,
  role TEXT,
  role_label TEXT,
  menus TEXT[],
  status TEXT
);
