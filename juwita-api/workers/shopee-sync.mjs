// Worker lokal: Shopee stock sync + price sync (VPS, bukan Edge Function).
// Sumber stok = PostgreSQL lokal (stock_mutations), harga = product_prices.
import { syncStock, syncPrice } from "../src/shopee.js";

const s = await syncStock();
const p = await syncPrice();
console.log(`shopee-sync: stock synced=${s.synced} failed=${s.failed} | price synced=${p.synced} failed=${p.failed}`);
process.exit(0);
