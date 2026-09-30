// ============================================================
// TEST MULTI-CHANNEL STOCK SYNC (A/B/C + D) — tidak mass sync.
// ============================================================
import jwt from "jsonwebtoken";
import { pool } from "../src/db.js";
import { syncStockForProduct } from "../src/shopee.js";

const SHOP1 = "724153261";
const SHOP2 = "1214362884";
const OWNER_ID = "7901fd69-9393-4fea-92d3-f6827a172a2a";

function token() {
  return jwt.sign({ role: "owner", status: "ACTIVE" }, process.env.JWT_SECRET, { algorithm: "HS256", subject: OWNER_ID, expiresIn: "1h" });
}

async function api(path, method, body) {
  const res = await fetch("http://127.0.0.1:3000" + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function mappingsOf(pid) {
  const { rows } = await pool.query("SELECT shop_id, shopee_item_id FROM product_shopee_mapping WHERE product_id = $1", [pid]);
  return rows;
}

async function main() {
  // --- Test A/B/C: targeting multi-shop (tanpa ubah stok) ---
  const cases = [
    { id: 4,    label: "A: mapped Shopee 1+2" },
    { id: 1,    label: "B: only Shopee 1" },
    { id: 1269, label: "C: only Shopee 2" },
  ];
  for (const c of cases) {
    console.log("\n=== " + c.label + " (product_id=" + c.id + ") ===");
    const maps = await mappingsOf(c.id);
    console.log("mapping:", maps.map((m) => m.shop_id + ":" + m.shopee_item_id).join(", "));
    const r = await syncStockForProduct(c.id);
    console.log("result:", JSON.stringify(r));
  }

  // --- Test D: PATCH stock +1 lewat /api/data/products → mutation dibuat ---
  console.log("\n=== D: PATCH stock +1 (produk 4) lewat data API ===");
  const pid = 4;
  const { rows: before } = await pool.query("SELECT stock FROM products WHERE id=$1", [pid]);
  const s0 = Number(before[0].stock) || 0;
  const { rows: mutBefore } = await pool.query("SELECT count(*)::int c FROM stock_mutations WHERE product_id=$1", [pid]);
  const c0 = mutBefore[0].c;

  const patch1 = await api("/api/data/products?id=" + pid, "PATCH", { stock: s0 + 1 });
  console.log("PATCH +1 status=", patch1.status, "data=", JSON.stringify(patch1.data));
  const { rows: mutAfter } = await pool.query("SELECT count(*)::int c FROM stock_mutations WHERE product_id=$1", [pid]);
  console.log("mutation bertambah:", mutAfter[0].c - c0, "(harus 1)");

  // revert -1
  const patch2 = await api("/api/data/products?id=" + pid, "PATCH", { stock: s0 });
  console.log("PATCH revert status=", patch2.status);
  const { rows: mutAfter2 } = await pool.query("SELECT count(*)::int c FROM stock_mutations WHERE product_id=$1", [pid]);
  console.log("mutation bertambah (revert):", mutAfter2[0].c - mutAfter[0].c, "(harus 1)");

  await pool.end();
}

main().catch((e) => { console.error("TEST ERROR:", e && e.message ? e.message : e); process.exit(1); });
