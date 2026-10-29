// Worker lokal: Shopee stock sync + price sync (VPS, bukan Edge Function).
// Sumber stok = PostgreSQL lokal (stock_mutations), harga = product_prices.
import { syncStock, syncPrice, reconcileStock } from "../src/shopee.js";

const DRY_RUN = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");

const s = await syncStock(null, { dryRun: DRY_RUN });
const p = await syncPrice();

// Rekonsiliasi penuh berjalan per batch (batas listing per proses); loop
// sampai hasMore=false supaya tidak ada listing yang tertinggal.
let rSynced = 0, rFailed = 0, cursor = null, hasMore = true, batches = 0;
while (hasMore) {
  const r = await reconcileStock(null, { cursor, dryRun: DRY_RUN });
  rSynced += r.synced;
  rFailed += r.failed;
  cursor = r.next_cursor;
  hasMore = r.hasMore;
  batches++;
  if (batches > 100000) { console.error("shopee-sync: reconcile batch guard tripped"); break; }
}
console.log(`shopee-sync: mode=${DRY_RUN ? "DRY_RUN" : "LIVE"} stock synced=${s.synced} failed=${s.failed} | reconcile synced=${rSynced} failed=${rFailed} batches=${batches} | price synced=${p.synced} failed=${p.failed}`);
process.exit(0);
