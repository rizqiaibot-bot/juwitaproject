// ============================================================
// TEST: syncStockOne — kirim products.stock untuk 1 produk Shopee 1
// dan 1 produk Shopee 2 (BUKAN mass sync).
// ============================================================
import { pool } from "../src/db.js";
import { syncStockOne } from "../src/shopee.js";

const SHOP1 = "724153261"; // Shopee 1 — Juwita Fresh and Frozen
const SHOP2 = "1214362884"; // Shopee 2 — juwita frozen food

const tests = [
  { product_id: 1, shop_id: SHOP1 },
  { product_id: 7, shop_id: SHOP2 },
];

async function main() {
  console.log("=== READ-ONLY: cek mapping + stok POS sebelum update ===");
  for (const t of tests) {
    const { rows: prod } = await pool.query(
      "SELECT id, name, stock FROM products WHERE id = $1 LIMIT 1",
      [t.product_id]
    );
    const { rows: maps } = await pool.query(
      "SELECT shop_id, shopee_item_id FROM product_shopee_mapping WHERE product_id = $1 AND shop_id = $2 LIMIT 1",
      [t.product_id, t.shop_id]
    );
    console.log(
      JSON.stringify({
        product_id: t.product_id,
        name: prod[0]?.name,
        pos_stock: prod[0]?.stock,
        target_shop_id: t.shop_id,
        mapping_shop_id: maps[0]?.shop_id,
        mapping_shopee_item_id: maps[0]?.shopee_item_id,
      })
    );
  }

  console.log("\n=== UPDATE: syncStockOne (1 produk per shop) ===");
  for (const t of tests) {
    const r = await syncStockOne(t.product_id, t.shop_id);
    console.log(JSON.stringify(r));
  }

  await pool.end();
}

main().catch((e) => {
  console.error("TEST FAILED:", e && e.message ? e.message : e);
  process.exit(1);
});
