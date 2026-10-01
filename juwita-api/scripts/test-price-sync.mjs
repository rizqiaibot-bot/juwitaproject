// Test: flow Harga Jual → product_prices (DB) → push Shopee via syncPriceOne.
import { pool } from "../src/db.js";
import { syncPriceOne } from "../src/shopee.js";

const PID = 4; // KULIT DIMSUM (mapped Shopee 1 + 2)

async function main() {
  // 1) READ-ONLY: product_prices untuk produk ini
  const { rows: prices } = await pool.query(
    "SELECT product_id, channel, price FROM product_prices WHERE product_id = $1 ORDER BY channel",
    [PID]
  );
  console.log("=== product_prices (DB) untuk produk " + PID + " ===");
  for (const r of prices) console.log("  channel=" + r.channel + " price=" + r.price);

  const { rows: maps } = await pool.query(
    "SELECT shop_id, shopee_item_id FROM product_shopee_mapping WHERE product_id = $1 ORDER BY shop_id",
    [PID]
  );
  console.log("=== mapping ===");
  for (const m of maps) console.log("  shop_id=" + m.shop_id + " item_id=" + m.shopee_item_id);

  // 2) Push ke Shopee 1 (jika ada harga channel tsb)
  console.log("\n=== syncPriceOne (Shopee 1) ===");
  const r1 = await syncPriceOne(PID, "shopee:724153261");
  console.log(JSON.stringify(r1));

  console.log("=== syncPriceOne (Shopee 2) ===");
  const r2 = await syncPriceOne(PID, "shopee:1214362884");
  console.log(JSON.stringify(r2));

  await pool.end();
}

main().catch((e) => { console.error("TEST ERROR:", e && e.message ? e.message : e); process.exit(1); });
