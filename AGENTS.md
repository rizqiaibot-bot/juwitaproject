# AGENTS.md — Juwita (WMS)

## Status Terakhir (WAJIB dibaca lebih dulu)

Lihat **`docs/PROJECT-STATE.md`**. Ringkasan kondisi per 2 Nov 2026:

- `products.stock = 0` untuk SEMUA produk (reset 2 Nov 2026), POS belum pernah dipakai.
- **Shopee 1 & Shopee 2 `disconnected`** — JANGAN sentuh stok Shopee.
- **JANGAN Connect Shopee selama stok POS masih 0** (akan mengirim 0 ke listing).
- Progres barcode: 33 produk sudah dipasang dari Google Sheet; 802 belum, 130 di antaranya menunggu review, 672 tidak ada di sheet.
- Skrip terkait: `juwita-api/scripts/reset-pos-stock.mjs`, `juwita-api/scripts/match-barcodes.mjs`.

## Aturan Inti

- 1 produk Juwita = 1 product_id.
- 1 produk = 1 SKU + 1 barcode + 1 stok pusat.
- products.stock = stok pusat.
- POS/offline memakai stok pusat.
- Shopee 1 & Shopee 2 memakai produk pusat yang sama.
- product_shopee_mapping = mapping product_id → listing Shopee per shop_id.
- shopee_item_id adalah ID listing, bukan ID produk pusat.
- stock_mutations = event perubahan/sinkronisasi stok.
- Shopee stock sync hanya MENGIRIM qty_after, tidak mengurangi products.stock.
- 1 order Shopee hanya boleh mengurangi stok pusat 1 kali.
- Jangan membuat product baru hanya karena listing Shopee berbeda.
- Jangan menghapus/merge produk tanpa audit referensi transaksi.
- Audit/read-only harus benar-benar tanpa perubahan data.
- Jangan migration/db push tanpa instruksi eksplisit.
- Jangan commit/push/deploy tanpa instruksi eksplisit.
- Jangan mengubah POS, Gudang, Order, atau stok saat mengerjakan fitur Shopee kecuali diminta.
- Perubahan harus minimal dan fokus pada file yang diperlukan.
- Hindari membaca seluruh repository; cari file yang relevan saja.
- Gunakan output ringkas untuk menghemat token.
