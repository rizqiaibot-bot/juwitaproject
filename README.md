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
├── juwita-api/                 # Backend API + worker (Node.js, PostgreSQL lokal VPS)
│   ├── src/                    # API server + modul Shopee
│   ├── workers/                # pull order, import order, stock/price sync
│   ├── scripts/                # skrip operasional (mis. reset stok POS)
│   └── migrations/             # migration PostgreSQL
└── .gitignore
```

## Cara Menjalankan (Local)

1. Clone repository
2. Tidak perlu build step — file HTML langsung dibuka di browser
3. Backend memakai `juwita-api` + PostgreSQL lokal (env `DATABASE_URL`)

```bash
# Buka aplikasi utama
start index.html

# Buka dashboard marketplace
start marketplace.html

# Jalankan backend
cd juwita-api && npm install && npm start
```

## Deploy ke VPS (Biznet)

Deploy otomatis lewat GitHub Actions (`.github/workflows/deploy.yml`) saat push ke `main`:

- Frontend (`index.html`, `marketplace.html`, aset) → `/var/www/html`
- Backend (`juwita-api/`) → `/var/www/juwita-api`
- Service `juwita-api.service` di-restart otomatis

Worker Shopee (pull order, import order, sync stok/harga) dijalankan oleh timer systemd di VPS.

## Environment Variables (juwita-api)

| Variable | Deskripsi |
|---|---|
| `DATABASE_URL` | Koneksi PostgreSQL lokal VPS |
| `JWT_SECRET` | Secret token login |
| `SHOPEE_PARTNER_ID` / `SHOPEE_PARTNER_KEY` / `SHOPEE_SHOP_ID` | Kredensial Shopee 1 |
| `SHOPEE2_PARTNER_ID` / `SHOPEE2_PARTNER_KEY` / `SHOPEE2_SHOP_ID` | Kredensial Shopee 2 |
| `SHOPEE_STOCK_PUSH` | `0` = matikan semua pengiriman stok ke Shopee |
| `ATTENDANCE_STORE_LAT` / `ATTENDANCE_STORE_LNG` | Titik pusat geofence presensi (default `-6.2589796` / `106.9813076` — Juwita Fresh & Frozen) |
| `ATTENDANCE_STORE_RADIUS_M` | Radius maksimal absen dari toko dalam meter (default `100`) |
| `ATTENDANCE_PHOTO_VIEWER_IDS` | Daftar UUID user (dipisah koma) yang boleh melihat isi foto presensi. Default: akun **Rizkin** & **Bos Warsito Broiler** |


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
- [x] Import Order ke POS (buat transaksi internal + kurangi stok)
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

# 2. Push ke main → GitHub Actions otomatis deploy ke VPS Biznet
git push origin main

# 3. Jika ada perubahan schema SQL, jalankan migration di PostgreSQL VPS
```

## License

MIT
