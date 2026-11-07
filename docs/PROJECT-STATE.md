# PROJECT STATE — Juwita

Terakhir diperbarui: **7 November 2026** (import 853 produk + isi 46 barcode dari sheet; radius presensi 100 → 20 m).
Baca file ini dulu sebelum mengerjakan apa pun supaya konteks tidak hilang saat sesi baru.

---

## 0. PENGINGAT SESI TERAKHIR (7 Nov 2026)

Yang dikerjakan & di-deploy di sesi terakhir (semua sudah commit + push, `main` bersih):

1. **Barcode POS** — sheet baru "Database Produk" (`1P5pIc-Qoj1FCkCP2GnYwvGdx6NqKLg79`):
   - 46 barcode diisi ke produk lama (2 H1 + 44 H3 aman).
   - **853 produk baru diimport** (553 dengan barcode valid, 300 tanpa), stok 0, id mulai 2308, SKU `SH-…`. Total produk sekarang **2.711** (1.787 dengan barcode, **924 tanpa**).
   - Masih tertunda: 18 H3 ragu + 38 H4 (laporan `Downloads\barcode-review-2026-11-07.csv`) dan frozen food yang tidak ada di sheet.
2. **Radius presensi: 100 m → 20 m** (server + frontend + test + docs). Kalau terlalu ketat, set `ATTENDANCE_STORE_RADIUS_M` di env VPS atau naikkan default.
3. **Rekap Penjualan**: Bulanan = global saja (tanpa ITEM, tanpa detail transaksi, breakdown POS/kasir); Harian = lengkap. Print ungu, judul mengikuti mode, dan mencetak SEMUA transaksi periode. Polling live sudah pakai pagination penuh (item terjual tidak lagi 0).
4. **Kata "Supabase" dibersihkan** dari seluruh kode (sudah VPS Biznet).
5. Presensi sebelumnya: geofence + kamera depan/belakang + pembatas akses foto (Rizkin & Bos Warsito Broiler).

Commit terakhir: `a5b1fe3`. Deploy otomatis via GitHub Actions (push `main` → rsync + restart `juwita-api.service`).

---

## 1. Kondisi stok (PALING PENTING)

> **Update 6 Nov 2026 (audit read-only DB):** stok POS sudah diisi lagi → **198 produk berisi, total 4.350 unit**; 1.650 produk lain masih 0. Kedua toko Shopee **masih `disconnected`**. `stock_mutations`: **4.114 `synced`, 1.408 `pending`, 1.227 `failed`** (backlog lama, TIDAK dihapus).
>
> Refactor sinkronisasi stok (belum di-commit/deploy): pengiriman stok **tidak lagi memakai antrean `stock_mutations`**, melainkan rekonsiliasi `products.stock` TERBARU per produk (push realtime) dan saat Connect/manual. Baris `stock_mutations` baru hanya histori terminal (`synced`) dan tidak pernah dibaca untuk push. Rencana pembersihan backlog lama menunggu persetujuan.

**Catatan historis (2 Nov 2026):**

- `products.stock = 0` untuk **semua 1.848 produk** (kondisi saat reset; sekarang sudah berubah, lihat update di atas).
  - Dieksekusi 2 Nov 2026 di VPS dengan `juwita-api/scripts/reset-pos-stock.mjs --apply --disconnect`.
  - 1.146 produk yang sebelumnya berisi (total 17.157 unit) di-nol-kan; 1.146 baris `stock_mutations` (`pending`, source "Reset stok POS").
- **Shopee 1 & Shopee 2 `disconnected`**:
  - Shopee 1 = `724153261` ("Juwita Fresh and Frozen")
  - Shopee 2 = `1214362884` ("juwita frozen food")
- **Instruksi user: JANGAN SENTUH STOK SHOPEE.**
  - Jangan `Connect` toko selama POS masih 0 → saat Connect, worker mengirim stok POS terkini (0) ke listing Shopee (jadi sold out).
  - Urutan yang benar: isi stok POS dulu → baru Connect.
- Ada **1.296 mutasi `pending`**; tidak dikirim selama toko disconnected.
- POS belum pernah dipakai untuk penjualan (tidak ada order POS).
- Kill switch tersedia: `SHOPEE_STOCK_PUSH=0` (mematikan semua push stok). **Belum di-set** di VPS; saat ini pengaman utama adalah status `disconnected`.

### Risiko yang belum ditutup

- `juwita-shopee-import.timer` tetap jalan tiap 15 menit (tidak melihat `connection_status`).
  Ada **29 order `failed`** (dibuat ≥ 31 Okt) yang akan diimport ulang kalau mapping + harga channel diperbaiki dan token Shopee di-refresh → stok bisa jadi minus.
- Token Shopee terakhir dicek **invalid** (`403 invalid_access_token`), jadi import saat ini tidak memotong stok.
- Jendela tarik order hanya 24 jam: order Shopee selama masa disconnect yang lebih tua **tidak** akan tertarik saat Connect.

---

## 2. Progres barcode

> **Update 7 Nov 2026:** memakai sheet baru **"Database Produk"** `https://docs.google.com/spreadsheets/d/1P5pIc-Qoj1FCkCP2GnYwvGdx6NqKLg79` (1 tab). Hasil:
> - **46 barcode diisi** ke produk lama: 2 H1 + 44 H3 (barcode EAN valid, merek & ukuran sama). H2 dilewati (barcode `UKBEN` palsu).
> - **853 produk baru diimport** dari sheet (553 dengan barcode valid, 300 tanpa), stok 0, id mulai 2308, SKU `SH-<kode item>`. Skrip: `juwita-api/scripts/import-new-products.mjs`.
> - Total produk: **2.711**. Dengan barcode: **1.787**. Tanpa barcode: **924** (sebagian besar frozen food yang tidak ada di sheet).

Sumber lama: Google Sheet **"Database Produk"**
`https://docs.google.com/spreadsheets/d/18R4x0KQX29Cwsr5NieCZ_NaUVvB9t6EHS13nlUbxQuA` (tab `gid=820631729`).
Salinan lokal: `data/barcode-source-2026-11-07.csv` (tidak di-commit).

Aturan yang disepakati user: **"jangan kira-kira, harus benar"** → hanya cocokkan nama yang identik.

Sudah dipasang **2 Nov 2026**: **33 produk / 22 barcode unik**
- H1 = 21 produk (token nama identik, beda urutan kata)
- H2 = 12 produk (beda hanya kata promosi: FRESH, HALAL, ALL VARIAN, PENGIRIMAN CEPAT, ...)

Sisa:
- **924 produk tanpa barcode** (1.787 sudah punya).
- Kandidat belum dipasang (dari sheet 7 Nov): 18 H3 ragu (beda varian / barcode mencurigakan) + 38 H4 (ukuran/isi beda).
  Laporan: `C:\Users\rizqi\Downloads\barcode-review-2026-11-07.csv` (bisa hilang → generate ulang dengan skrip di bawah).
- Sebagian besar produk tanpa barcode adalah **frozen food yang tidak ada di sheet** — sheet mayoritas katalog minimarket (YAKULT, AQUA, SASA, dll). Kemungkinan ada sheet/tab lain untuk frozen food.

Cara mengulang pencocokan (tidak menulis DB, hanya menghasilkan SQL + laporan):

```bash
# 1. dump produk dari VPS
ssh -i ~/.ssh/juwita_vps juwita@juwita.biz.id
set -a; . /home/juwita/.juwita-one-db.env; set +a
psql "$DATABASE_URL" -c "\copy (select id, name, coalesce(sku,'') sku, coalesce(plu,'') plu, coalesce(barcode,'') barcode, price, coalesce(modal,0) modal, coalesce(category,'') category from products order by id) to stdout with (format csv, header true)" > /tmp/products.csv

# 2. jalankan pencocokan (lokal, di folder juwita-api)
node scripts/match-barcodes.mjs --sheet <sheet.csv> --db <products.csv> --out <dir>
```

Catatan data:
- 165 grup nama produk duplikat (nama sama, `product_id` beda) → barcode sama boleh; POS memakai `find()` sehingga produk pertama yang cocok yang terpilih.
- 132 barcode lama punya check-digit EAN salah → kemungkinan dibuat acak oleh `index.html` (`"899" + random`) saat produk dibuat tanpa barcode.

---

## 3. Deploy & akses

- Backend: **VPS Biznet**, `juwita@juwita.biz.id`, folder `/var/www/juwita-api`, service `juwita-api.service`.
- Frontend: `/var/www/html` (via `.github/workflows/deploy.yml`).
- Deploy otomatis: **push ke `main`** → GitHub Actions rsync + restart `juwita-api.service`.
- SSH key (mesin user): `C:\Users\rizqi\.ssh\juwita_vps`.
- Env di VPS:
  - `/home/juwita/.juwita-one-api.env`
  - `/home/juwita/.juwita-one-db.env` (berisi `DATABASE_URL`)
  - `/home/juwita/.juwita-shopee.env`
- Node VPS: `/home/juwita/.local/bin/node`.
- **Tidak ada `DATABASE_URL` di mesin lokal Windows** → semua query DB harus lewat SSH.
- Timer systemd tiap 15 menit: `juwita-shopee-pull.timer`, `juwita-shopee-import.timer`, `juwita-shopee-sync.timer`.
- Health check: `https://juwita.biz.id/api/health`.

### Tips eksekusi SSH dari PowerShell

Quoting `psql -c "..."` lewat PowerShell sering rusak. Cara yang berhasil:
tulis skrip bash ke file lokal → pipe ke `ssh ... "bash -s"`, dan buang CR:

```powershell
$s = Get-Content -Raw script.sh; $s = $s -replace [char]13, ""
$s | ssh -i "$env:USERPROFILE\.ssh\juwita_vps" -o BatchMode=yes juwita@juwita.biz.id "bash -s"
```

---

## 4. Commit terakhir

- `cd0df0b` — chore: hapus Edge Function Supabase lama (deploy via VPS Biznet)
- `9c0e325` — fix(shopee): stok Shopee 1 ikut sinkron + push langsung setelah import order

`main == origin/main`. Pekerjaan barcode (2 Nov) **belum di-commit** kecuali `scripts/match-barcodes.mjs` bila sudah di-commit.

---

## 5. Yang sudah benar di kode (jangan diubah tanpa alasan)

- `juwita-api/src/shopee.js`
  - `products.stock` = satu-satunya sumber kebenaran; push hanya mengirim `qty_after` absolut.
  - Fallback `products.shopee_item_id` (legacy) sebagai mapping Shopee 1 bila `product_shopee_mapping` belum punya baris.
  - Kill switch `SHOPEE_STOCK_PUSH=0` di `syncStock`, `reconcileStock`, `syncStockOne`, `syncStockForProduct`.
  - `updateStockOne`: fallback `model_id: 0` + `get_item_base_info` untuk listing tanpa variasi.
- `juwita-api/workers/shopee-import-orders.mjs`: setelah import sukses, langsung `syncStock(null)`.
- `juwita-api/scripts/reset-pos-stock.mjs`: reset stok POS, dry-run default, guard `--disconnect`.
- `juwita-api/scripts/match-barcodes.mjs`: pencocokan barcode (baru, belum di-commit).
- Unit test: `node --test test/permissions.test.mjs test/routes.test.mjs test/shopee-reconcile.test.mjs` → 71 lulus.
