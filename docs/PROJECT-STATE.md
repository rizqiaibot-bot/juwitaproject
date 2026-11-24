# PROJECT STATE — Juwita

Terakhir diperbarui: **24 November 2026** (fitur JFFBOT — chatbot pengembang via OpenCode, di-deploy).

Baca file ini dulu sebelum mengerjakan apa pun supaya konteks tidak hilang saat sesi baru.

---

## 0. PENGINGAT SESI TERAKHIR (24 Nov 2026)

**Fitur JFFBOT (chatbot pengembang berbasis OpenCode) — selesai & di-deploy:**

- Menu **JFFBOT** di aplikasi (index.html) = chatbot yang bisa mengubah/menambah fitur/menu web Juwita lewat OpenCode V2 (model **DeepSeek V4 Pro via api.deepseek.com langsung**, key di `~/.config/opencode/opencode.json`) yang berjalan permanen di VPS.
- Komponen:
  - VPS: service systemd `juwita-opencode.service` (OpenCode v2.4.1, `127.0.0.1:4096`), config `/home/juwita/.config/opencode/opencode.json` (provider sumopod; deny `git push/branch/checkout/reset/sudo/ssh/scp/rsync` + `external_directory`), instruksi tambahan `/home/juwita/.config/opencode/jffbot.md`.
  - Workspace agent: clone `/home/juwita/juwita-one` (branch main; artefak lama di-exclude via `.git/info/exclude`).
  - Bridge: `juwita-api/src/jffbot.js` (auth HTTP Basic dari `~/.config/opencode/service.json`), route `/api/jffbot/session|status|approve|cancel` di `server.js`.
  - UI: halaman `page-jffbot` (chat + panel perubahan + tombol Approve/Batalkan).
- Akses: token menu baru `jffbot` — centang di Pengaturan → Manajemen Akun. **Approve/Batalkan hanya owner atau role admin.**
- Alur deploy: agent commit lokal → admin tekan **Approve & Deploy** → bridge `git push origin main` via SSH key `/home/juwita/.ssh/jffbot_github` (deploy key GitHub) → GitHub Actions rsync + restart otomatis.
- Satu permintaan agent dalam satu waktu (busy flag 15 menit). Prompt ditolak bila workspace kotor (harus approve/cancel dulu).
- **CATATAN**: deploy key GitHub `jffbot-vps` (write access) harus terpasang di repo `rizqiaibot-bot/juwitaproject`, kalau tidak Approve akan gagal push.

---

## 0a. PENGINGAT SESI SEBELUMNYA (23 Nov 2026)

**1. Audit CSV "PRODUK & BARCODE.csv" (Downloads, 14 Nov) vs DB POS (read-only, selesai):**
- CSV: 722 baris (423 dgn barcode, 299 tanpa). DB: 1.781 produk, 1.429 barcode unik.
- Cocok: 60 via barcode + 3 via nama identik → **659 belum ada di POS** (362 dgn barcode, 297 tanpa).
- Laporan: `Downloads\pos-belum-ada-dari-produk-barcode.csv`. Belum ada tindakan import.

**2. Fitur baru (DRAFT, belum selesai, belum commit/deploy, migration BELUM diterapkan):**
- Permintaan: Rekap Penjualan → Detail Transaksi (mode Harian) tampilkan **hasil akhir setelah biaya lain-lain Shopee**.
- Sumber data (pilihan user): **tarik otomatis dari API Shopee `GetIncomeStatement`** (`/api/v2/finance/income/get_income_statement`) — "biaya lain-lain" = komisi+layanan+transaksi+penyesuaian+dll; "hasil akhir" = `total_escrow_amount`. Batas API: 15 hari per request.
- Sudah dibuat (uncommitted): `juwita-api/migrations/011_shopee_order_income.sql` (tabel `shopee_order_incomes` + kolom `orders.biaya_lain`, `orders.hasil_akhir`) dan fungsi `pullIncomeStatements()` di `src/shopee.js` (hanya proses toko `connected`; aman saat disconnected).
- BELUM dibuat: worker cron (income 15 hari rolling di shopee-pull-orders atau worker baru), skrip backfill riwayat lama (`--days N`), dan kolom "Hasil Akhir" di index.html (tabel detail + print).
- Fitur baru bisa jalan **setelah toko di-Connect lagi** (token saat ini invalid).

**3. PENTING — JANGAN Connect Shopee:**
- Kedua toko masih `disconnected`. Connect saat stok POS masih 0 akan mengirim 0 ke listing (sold out). Tunggu perintah user.

---

## 0a. PENGINGAT SESI SEBELUMNYA (14 Nov 2026)

**Hapus menu HR → Karyawan ("Manajemen Karyawan" = daftar nama karyawan):**
- Dropdown HR (`index.html` + `marketplace.html`) sekarang: Rekap Kehadiran, Izin dan Cuti, Jadwal Kerja.
- Halaman `page-karyawan` + `renderEmployees()` dihapus total (div, fungsi, 2 call site, branch showPage, entry menuMap).
- `defaultPageForMenu("hr")` → `"rekap-kehadiran"` (karyawan HR langsung masuk Rekap Kehadiran).
- Manajemen akun karyawan (buat akun/role/menu) TIDAK dihapus — tetap di Pengaturan → Manajemen Akun.
- **Menu Akuntansi**: dropdown "Dashboard Akuntansi" dihapus → nav item langsung "Akuntansi" yang membuka halaman akuntansi (seperti Pricing).
- Toko Shopee masih `disconnected` (menunggu arahan user untuk Connect).

---

## 0b. PENGINGAT SESI SEBELUMNYA (12 Nov 2026)

**1. Menu GUDANG = general (semua karyawan aktif):**
- `permissions.js`: `GENERAL_MENUS = ["gudang"]`; `checkTableAccess` mengizinkan operasi apa pun yang daftar menunya memuat gudang (mis. read orders/order_items/produk/PO/stock_mutations/warehouse_*); operasi menu lain tetap menu-bound (stok update, retry mutasi, aksi Shopee TIDAK ikut general).
- `server.js`: `checkMenuAccess` — gudang lolos untuk semua karyawan aktif.
- `index.html`: `getMenuPermissions`/`hasAnyMenu` mengenal `GENERAL_MENUS`; karyawan tanpa menu apa pun diarahkan ke halaman gudang (`defaultPageForMenu(... || "gudang")` → Penerimaan).
- Test disesuaikan (84 lulus). Karyawan NONAKTIF tetap ditolak (401).

**2. Push pengiriman ke Shopee (alur penuh pick/pack/ship):**
- Aksi **Kirim** (`record_warehouse_action('ship')`) pada order channel Shopee kini otomatis memanggil `pushShipment` (`shopee.js`): `logistics/get_shipping_parameter` → `logistics/ship_order`.
  - Channel **non-integrated** (kurir sendiri): kirim `non_integrated.tracking_number = resi` → status Shopee ikut berubah (LOGISTICS_PICKUP_DONE → SHIPPED).
  - Channel **pickup**: pakai alamat `default_address` + slot pertama (boleh kosong).
  - Channel **dropoff**: belum otomatis → `needs_manual` (atur di Seller Centre).
- Gagal push TIDAK membatalkan status lokal 'Dikirim'; hasilnya masuk `activity_log` (event `ORDER_SHIP`, direction OUT) dan muncul sebagai toast di HP.
- Kill switch: `SHOPEE_SHIP_PUSH=0` (default aktif). Tidak dipakai saat NODE_ENV=test.
- Catatan: pick/pack TIDAK bisa dipush ke Shopee karena Shopee tidak punya status picking/packing — hanya pengiriman yang ada padanannya.
- **Commit + deploy dilakukan 12 Nov 2026, dengan instruksi user: toko Shopee TETAP `disconnected`, JANGAN Connect sampai ada arahan.** Token masih invalid; push pengiriman akan gagal aman ("disconnected/token tidak tersedia") sampai Connect lagi.

---

## 0c. PENGINGAT SESI SEBELUMNYA (11 Nov 2026)

**Percepat load produk di POS (`index.html`):**
- Grid produk sebelumnya menunggu SEMUA data (orders, order_items, gudang, harga) selesai baru dirender.
- Sekarang: grid dirender begitu **produk + orders + order_items** siap (urutan "sering terjual" langsung benar, produk tidak berubah-ubah di layar), tanpa menunggu gudang/harga/absensi.
- Pagination fetch 1.000 → **5.000 baris** (produk 2→1 request, orders 4→1, order_items 6→2; polling live ikut ringan).
- `computeShopeeQtyMap` di-memoize (dihitung ulang hanya saat data diganti, bukan tiap render).
- Belum ada perubahan server (limit API maksimal sudah 5000 dari dulu).

---

## 0d. PENGINGAT SESI SEBELUMNYA (9 Nov 2026)

**UNDO import Google Sheet 7 Nov (atas permintaan user, "tertumpuk" di POS):**
- **845 produk `SH-` (id 2308–3160) dihapus** dari DB — semua stok 0, nol referensi di semua tabel (sudah diaudit).
- **47 barcode di produk lama dikosongkan** (2 H1 + 45 H3 dari sheet; sebelumnya memang kosong).
- **10 produk `JFF-` (dibuat 8 Nov, ada stok 92 unit + mapping Shopee 2) TIDAK disentuh.**
- Backup: `/tmp/juwita_products_backup_20261109_114230_undo.dump` + `/tmp/juwita_sh_products_20261109_114230_undo.csv` (di VPS). Skrip: `data/undo-sheet-import.sh` (belum di-commit).
- Kondisi sekarang (cek DB 19 Nov 2026): **1.706 produk** total (1.368 dengan barcode, 338 tanpa). File `barcode-review-2026-11-07.csv` di Downloads masih berlaku untuk kandidat H3/H4 bila ingin dipasang lagi.

---

## 0e. PENGINGAT SESI SEBELUMNYA (7 Nov 2026)

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

> **Update 9 Nov 2026 (UNDO):** hasil import sheet 7 Nov sudah dibatalkan atas permintaan user ("tertumpuk" di POS):
> - **845 produk `SH-` dihapus**; **47 barcode di produk lama dikosongkan** (2 H1 + 45 H3). 10 produk `JFF-` (8 Nov, manual + Shopee 2) tetap.
> - Kondisi sekarang (cek DB 19 Nov 2026): **1.706 produk** total — **1.368 dengan barcode**, **338 tanpa barcode**.
> - Kalau suatu saat mau import lagi, skrip tetap ada: `juwita-api/scripts/import-new-products.mjs`; review kandidat lama di `Downloads\barcode-review-2026-11-07.csv`.

<details>
<summary>Riwayat 7 Nov 2026 (sudah di-undo) — klik untuk buka</summary>

> **Update 7 Nov 2026:** memakai sheet baru **"Database Produk"** `https://docs.google.com/spreadsheets/d/1P5pIc-Qoj1FCkCP2GnYwvGdx6NqKLg79` (1 tab). Hasil:
> - **46 barcode diisi** ke produk lama: 2 H1 + 44 H3 (barcode EAN valid, merek & ukuran sama). H2 dilewati (barcode `UKBEN` palsu).
> - **853 produk baru diimport** dari sheet (553 dengan barcode valid, 300 tanpa), stok 0, id mulai 2308, SKU `SH-<kode item>`. Skrip: `juwita-api/scripts/import-new-products.mjs`.
> - Total produk: **2.711**. Dengan barcode: **1.787**. Tanpa barcode: **924** (sebagian besar frozen food yang tidak ada di sheet).

</details>

Sumber lama: Google Sheet **"Database Produk"**
`https://docs.google.com/spreadsheets/d/18R4x0KQX29Cwsr5NieCZ_NaUVvB9t6EHS13nlUbxQuA` (tab `gid=820631729`).
Salinan lokal: `data/barcode-source-2026-11-07.csv` (tidak di-commit).

Aturan yang disepakati user: **"jangan kira-kira, harus benar"** → hanya cocokkan nama yang identik.

Sudah dipasang **2 Nov 2026**: **33 produk / 22 barcode unik**
- H1 = 21 produk (token nama identik, beda urutan kata)
- H2 = 12 produk (beda hanya kata promosi: FRESH, HALAL, ALL VARIAN, PENGIRIMAN CEPAT, ...)

Sisa:
- **338 produk tanpa barcode** (1.368 sudah punya, cek DB 19 Nov 2026).
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

- `90a3db7` — feat(akuntansi): hapus dropdown Dashboard Akuntansi - menu Akuntansi langsung buka halaman akuntansi
- `56261d8` — feat(hr): hapus menu Karyawan dari HR - HR langsung ke Rekap Kehadiran
- `36333ac` — feat(gudang): menu gudang general untuk semua karyawan + push pengiriman ke Shopee saat Kirim
- `2825035` — fix(pos): produk tidak berubah-ubah saat load - render setelah produk+orders+order_items siap
- `cd0df0b` — chore: hapus Edge Function Supabase lama (deploy via VPS Biznet)
- `9c0e325` — fix(shopee): stok Shopee 1 ikut sinkron + push langsung setelah import order

`main == origin/main`.

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
- Unit test: `node --test test/permissions.test.mjs test/routes.test.mjs test/shopee-reconcile.test.mjs` → 84 lulus.
