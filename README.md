# Juwita One — All-in-One Management

Sistem operasional terintegrasi untuk toko retail, mencakup POS, gudang, persediaan, pembelian, SDM, dan integrasi marketplace (Shopee).

## Struktur Folder

```
juwitaproject/
├── index.html                  # Aplikasi utama (POS, Gudang, Penjualan, dll)
├── marketplace.html            # Dashboard Marketplace (modul terpisah)
├── marketplace-schema.sql      # Schema tabel marketplace + helper functions
├── supabase-migration.sql      # Schema tabel utama (products, orders, dll)
├── shopee-sync-schema.sql      # Tambahan kolom Shopee + tabel stock_mutations
├── stock-sync-schema.sql       # ⚠️ DEPRECATED — gunakan shopee-sync-schema.sql
├── gudang-schema.sql           # Schema tabel warehouse
├── shopee-stock-sync.js        # Edge Function: push stok ke Shopee
├── shopee-connect.js           # Edge Function: verifikasi koneksi Shopee
├── shopee-pull-orders.js       # Edge Function: tarik order dari Shopee
├── .env.example                # Template environment variables
└── .gitignore
```

## Cara Menjalankan (Local)

1. Clone repository
2. Tidak perlu build step — file HTML langsung dibuka di browser
3. Pastikan Supabase project sudah berjalan dan SQL schema sudah dijalankan

```bash
# Buka aplikasi utama
start index.html

# Buka dashboard marketplace
start marketplace.html
```

## Deploy Supabase Edge Functions

```bash
# Install Supabase CLI
npm install -g supabase

# Login
supabase login

# Deploy Edge Functions
supabase functions deploy shopee-stock-sync
supabase functions deploy shopee-connect
supabase functions deploy shopee-pull-orders

# Set Environment Variables di Supabase Dashboard
```

## Deploy ke Vercel

1. Push repository ke GitHub
2. Import project di Vercel
3. Set Build & Output Settings:
   - Framework: Other
   - Output Directory: `.`
4. Deploy

## Environment Variables

| Variable | Deskripsi |
|---|---|
| `SUPABASE_URL` | URL project Supabase |
| `SUPABASE_ANON_KEY` | Anon key Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (untuk Edge Function) |
| `SHOPEE_PARTNER_ID` | Partner ID Shopee Toko 1 |
| `SHOPEE_PARTNER_KEY` | Partner Key Shopee Toko 1 |
| `SHOPEE_SHOP_ID` | Shop ID Shopee Toko 1 |
| `SHOPEE_PARTNER_ID_2` | Partner ID Shopee Toko 2 (opsional) |
| `SHOPEE_PARTNER_KEY_2` | Partner Key Shopee Toko 2 (opsional) |
| `SHOPEE_SHOP_ID_2` | Shop ID Shopee Toko 2 (opsional) |

## Daftar Fitur

### Core
- [x] POS (Point of Sale) — checkout, cash, QRIS, EDC, split payment
- [x] Penjualan — daftar transaksi, pelanggan, rekap
- [x] Katalog — daftar produk, tambah produk, barcode, foto
- [x] Persediaan — monitor stok, stock opname, mutasi, kartu stok
- [x] Pembelian — data pembelian, supplier, retur
- [x] Gudang — penerimaan, picking, packing, pengiriman, rak
- [x] Pricing — harga belanja, harga jual, markup, diskon, margin
- [x] HR — karyawan, absensi, rekap kehadiran, cuti, penggajian
- [x] Lain-lain — kontrakan, peternakan lele, kandang ayam

### Marketplace (Shopee)
- [x] Marketplace Schema (database)
- [x] Stock Sync (push stok ke Shopee)
- [x] Shopee Connect (verifikasi koneksi)
- [x] Shopee Pull Orders (tarik order dari Shopee)
- [x] Marketplace Dashboard (UI monitoring)
- [x] Approval Marketplace Order (pending → processing → ready_import)
- [ ] Import Order ke POS (buat transaksi internal)
- [ ] Sinkronisasi otomatis POS

## Status Development

```
Database:   ████████░░ 80%
Backend:    ████████░░ 80%
Frontend:   ████████░░ 80%
Marketplace: ██████░░░░ 60%
Production: ░░░░░░░░░░  0%
```

## Cara Update Project

```bash
# 1. Pull perubahan terbaru
git pull origin main

# 2. Jika ada perubahan schema SQL, jalankan di Supabase SQL Editor
#    (marketplace-schema.sql, shopee-sync-schema.sql, dll)

# 3. Jika ada perubahan Edge Function, deploy ulang
supabase functions deploy shopee-stock-sync
supabase functions deploy shopee-connect
supabase functions deploy shopee-pull-orders

# 4. Vercel auto-deploy jika terhubung ke GitHub
```

## License

MIT
