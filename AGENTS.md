# AGENTS.md — Juwita (WMS)

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
