// Worker lokal: Shopee PRICE sync (VPS, bukan Edge Function).
// Harga per channel = product_prices (mekanisme harga per channel dipertahankan).
//
// Stok TIDAK dikirim rutin oleh worker ini. Stok memakai model rekonsiliasi
// stok terbaru:
//   - perubahan stok memicu push realtime per produk (server/import worker),
//   - saat toko di-Connect, server menjalankan rekonsiliasi penuh,
//   - endpoint manual stock-sync/reconcile-stock juga menjalankan rekonsiliasi.
// Jadi tidak ada pengiriman stok berulang tanpa kebutuhan dan tidak ada antrean
// stock_mutations yang harus dihabiskan.
import { syncPrice } from "../src/shopee.js";

const p = await syncPrice();
console.log(`shopee-sync: price synced=${p.synced} failed=${p.failed} skipped=${p.skipped}`);
