// ============================================================
// Test INTEGRASI konsistensi stok POS ↔ Shopee 1 ↔ Shopee 2 dengan
// PostgreSQL SUNGGUHAN (lock, transaksi, race condition) + Shopee palsu.
//
// Hanya berjalan bila TEST_DATABASE_URL di-set ke database LOKAL yang
// namanya mengandung "test". Skema di database itu DIHAPUS & dibuat ulang.
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/juwita_test \
//     node --test test/integration/sync-consistency.test.mjs
// ============================================================
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import jwt from "jsonwebtoken";

const TEST_URL = process.env.TEST_DATABASE_URL || "";
const safeUrl = (() => {
  try {
    const u = new URL(TEST_URL);
    const host = u.hostname;
    const db = u.pathname.replace(/^\//, "");
    return (host === "127.0.0.1" || host === "localhost") && /test/i.test(db);
  } catch { return false; }
})();
const skip = safeUrl ? false : "TEST_DATABASE_URL lokal (*test*) belum di-set";

const here = path.dirname(fileURLToPath(import.meta.url));
const S1 = "724153261";
const S2 = "1214362884";
const P = 101;            // satu produk pusat
const ITEM_S1 = 9001;     // listing Shopee 1
const ITEM_S2 = 9002;     // listing Shopee 2 (produk pusat SAMA)

// ---------- Shopee palsu ----------
const shopee = {
  updateStocks: [],   // {shop_id, item_id, stock}
  updatePrices: [],   // {shop_id, item_id, price}
  failStockForShop: null,
  orderDetails: {},   // order_sn -> detail
  models: {},         // item_id -> model list (variasi)
};
function fakeJson(body) { return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }; }
const realFetch = globalThis.fetch;
function fakeFetch(url, opts = {}) {
  const u = new URL(String(url));
  if (u.hostname !== "partner.shopeemobile.com") return realFetch(url, opts);
  const shopId = u.searchParams.get("shop_id");
  const body = opts.body ? JSON.parse(opts.body) : null;
  const p = u.pathname;
  if (p.endsWith("/product/get_model_list")) {
    const models = shopee.models[u.searchParams.get("item_id")] || [];
    return Promise.resolve(fakeJson({ error: "", response: { model: models } }));
  }
  if (p.endsWith("/product/get_item_base_info")) {
    return Promise.resolve(fakeJson({ error: "", response: { item_list: [{ stock_info_v2: { seller_stock: [{ location_id: "loc" }] } }] } }));
  }
  if (p.endsWith("/product/update_stock")) {
    if (shopee.failStockForShop === shopId) return Promise.resolve(fakeJson({ error: "internal_error", message: "down" }));
    shopee.updateStocks.push({ shop_id: shopId, item_id: body.item_id, stock: body.stock_list[0].seller_stock[0].stock });
    return Promise.resolve(fakeJson({ error: "", response: {} }));
  }
  if (p.endsWith("/product/update_price")) {
    shopee.updatePrices.push({ shop_id: shopId, item_id: body.item_id, price: body.price_list[0].original_price });
    return Promise.resolve(fakeJson({ error: "", response: {} }));
  }
  if (p.endsWith("/order/get_order_detail")) {
    const sns = String(u.searchParams.get("order_sn_list") || "").split(",");
    const list = sns.map((sn) => shopee.orderDetails[sn]).filter(Boolean);
    return Promise.resolve(fakeJson({ error: "", response: { order_list: list } }));
  }
  return Promise.reject(new Error("UNEXPECTED_SHOPEE_CALL " + p));
}

let admin, worker, shopeeLib, server, base;

before(async () => {
  if (skip) return;
  admin = new pg.Pool({ connectionString: TEST_URL, max: 4 });
  await admin.query(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  // RPC POS yang dipanggil server.js (16 argumen) — diambil apa adanya dari migration.
  await admin.query(fs.readFileSync(path.join(here, "../../../supabase/migrations/20260904_allow_negative_stock_pos.sql"), "utf8"));

  process.env.DATABASE_URL = TEST_URL;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "integration-test-secret";
  process.env.SHOPEE_THROTTLE_MS = "0";
  process.env.SHOPEE_PARTNER_ID = "p1";
  process.env.SHOPEE_PARTNER_KEY = "k1";
  process.env.SHOPEE_SHOP_ID = S1;
  process.env.SHOPEE2_PARTNER_ID = "p2";
  process.env.SHOPEE2_PARTNER_KEY = "k2";
  process.env.SHOPEE2_SHOP_ID = S2;
  delete process.env.DRY_RUN;
  // Retry order 'failed' hanya untuk order yang dibuat ≤1 jam terakhir.
  process.env.IMPORT_RETRY_FAILED_SINCE = new Date(Date.now() - 3600e3).toISOString();
  globalThis.fetch = fakeFetch;

  worker = await import("../../workers/shopee-import-orders.mjs");
  shopeeLib = await import("../../src/shopee.js");
  ({ server } = await import("../../src/server.js"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  if (skip) return;
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
  await worker.pool.end();
  const db = await import("../../src/db.js");
  await db.pool.end();
  await admin.end();
});

beforeEach(async () => {
  if (skip) return;
  shopee.updateStocks.length = 0;
  shopee.updatePrices.length = 0;
  shopee.failStockForShop = null;
  shopee.orderDetails = {};
  shopee.models = {};
  await admin.query(`TRUNCATE products, orders, order_items, stock_mutations, marketplace_config,
    marketplace_credentials, activity_log, marketplace_orders, product_shopee_mapping, product_prices, app_users
    RESTART IDENTITY CASCADE`);
  await admin.query("INSERT INTO products (id, name, price, stock) VALUES ($1, 'Nugget 500g', 10000, 100)", [P]);
  await admin.query(`INSERT INTO product_shopee_mapping (product_id, shop_id, shopee_item_id) VALUES ($1,$2,$3), ($1,$4,$5)`, [P, S1, ITEM_S1, S2, ITEM_S2]);
  await admin.query(`INSERT INTO product_prices (product_id, channel, price) VALUES ($1,'pos',10000), ($1,$2,11000), ($1,$3,12500)`, [P, "shopee:" + S1, "shopee:" + S2]);
  await admin.query(`INSERT INTO marketplace_config (platform, shop_id, shop_name) VALUES ('shopee',$1,'Shopee 1'), ('shopee',$2,'Shopee 2')`, [S1, S2]);
  await admin.query(`INSERT INTO marketplace_credentials (shop_id, access_token) VALUES ($1,'tok1'), ($2,'tok2')`, [S1, S2]);
  await admin.query(`INSERT INTO app_users (id, phone, full_name, role, menus, status) VALUES ('kasir-1','0800','Kasir Test','staf','{pos}','ACTIVE')`);
});

// ---------- helper ----------
function payload(sn, items, status = "READY_TO_SHIP") {
  return {
    order_sn: sn, order_status: status, buyer_user_name: "buyer-" + sn,
    create_time: Math.floor(Date.now() / 1000),
    item_list: items.map((i) => ({ item_id: i.item_id, model_quantity_purchased: i.qty, item_name: "Nugget" })),
  };
}
async function addMpOrder(shopId, sn, items, opts = {}) {
  const p = payload(sn, items, opts.status);
  const { rows } = await admin.query(
    `INSERT INTO marketplace_orders (platform, shop_id, mp_order_id, order_status, sync_status, raw_payload)
     VALUES ('shopee',$1,$2,$3,$4,$5) RETURNING id`,
    [shopId, sn, p.order_status, opts.syncStatus || "pending", JSON.stringify(p)]
  );
  return rows[0].id;
}
async function mpRow(id) {
  const { rows } = await admin.query("SELECT id, shop_id, mp_order_id, raw_payload, order_status, sync_status, internal_order_id FROM marketplace_orders WHERE id=$1", [id]);
  return rows[0];
}
async function stockOf(id = P) {
  const { rows } = await admin.query("SELECT stock FROM products WHERE id=$1", [id]);
  return Number(rows[0].stock);
}
async function mutationSum(id = P) {
  const { rows } = await admin.query("SELECT COALESCE(SUM(quantity),0) AS q, count(*)::int AS n FROM stock_mutations WHERE product_id=$1 AND type='OUT'", [id]);
  return { qty: Number(rows[0].q), count: rows[0].n };
}
function kasirToken() {
  return jwt.sign({ role: "staf", status: "ACTIVE" }, process.env.JWT_SECRET, { algorithm: "HS256", subject: "kasir-1", expiresIn: "1h" });
}
async function posCheckout(orderId, key, qty) {
  const res = await fetch(base + "/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + kasirToken() },
    body: JSON.stringify({
      p_orderid: orderId, p_idempotency_key: key, p_date: "2026-10-30 10:00", p_channel: "POS1",
      p_customer: "Walk-in Customer", p_total: 10000 * qty, p_paystatus: "Lunas", p_wmsstatus: "Selesai",
      p_courier: "Self-Pickup", p_resi: "-", p_payment_method: "cash", p_subtotal: 10000 * qty,
      p_diskon: 0, p_bayar: 10000 * qty, p_kembalian: 0,
      p_items: [{ product_id: P, product_name: "Nugget 500g", qty, price: 10000, subtotal: 10000 * qty }],
    }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).data;
}

// ============================================================
// SHOPEE → DATABASE
// ============================================================
test("Order Shopee: SKU sama di 2 baris dipotong sekali dengan total qty", { skip }, async () => {
  const id = await addMpOrder(S1, "SN-DUP", [{ item_id: ITEM_S1, qty: 2 }, { item_id: ITEM_S1, qty: 3 }]);
  const r = await worker.importOrder(await mpRow(id));
  assert.equal(r.status, "imported");
  assert.equal(await stockOf(), 95);
  const { rows } = await admin.query("SELECT quantity, qty_before, qty_after FROM stock_mutations WHERE product_id=$1", [P]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows.map((x) => [Number(x.quantity), Number(x.qty_before), Number(x.qty_after)]), [[5, 100, 95]]);
  const items = await admin.query("SELECT qty, price FROM order_items WHERE orderid=$1 ORDER BY id", [r.internal_order_id]);
  assert.deepEqual(items.rows.map((x) => [Number(x.qty), x.price]), [[2, 11000], [3, 11000]]);
});

test("Order Shopee yang sama diproses ulang (retry/row basi) tidak memotong stok lagi", { skip }, async () => {
  const id = await addMpOrder(S1, "SN-RETRY", [{ item_id: ITEM_S1, qty: 4 }]);
  const stale = await mpRow(id); // snapshot sebelum diimport (sync_status=pending)
  assert.equal((await worker.importOrder(stale)).status, "imported");
  const again = await worker.importOrder(stale);
  assert.equal(again.status, "skipped");
  assert.equal(await stockOf(), 96);
  assert.equal((await mutationSum()).count, 1);
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM orders WHERE channel='Shopee'");
  assert.equal(rows[0].n, 1);
});

test("Dua worker import bersamaan untuk order yang sama → hanya satu yang memotong stok", { skip }, async () => {
  const id = await addMpOrder(S2, "SN-RACE", [{ item_id: ITEM_S2, qty: 7 }]);
  const row = await mpRow(id);
  const results = await Promise.all([worker.importOrder({ ...row }), worker.importOrder({ ...row })]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["imported", "skipped"]);
  assert.equal(await stockOf(), 93);
  assert.equal((await mutationSum()).count, 1);
});

test("Shopee 1 & Shopee 2 memotong stok pusat yang SAMA, harga per toko independen", { skip }, async () => {
  const a = await worker.importOrder(await mpRow(await addMpOrder(S1, "SN-S1", [{ item_id: ITEM_S1, qty: 1 }])));
  const b = await worker.importOrder(await mpRow(await addMpOrder(S2, "SN-S2", [{ item_id: ITEM_S2, qty: 2 }])));
  assert.equal(a.status, "imported");
  assert.equal(b.status, "imported");
  assert.equal(await stockOf(), 97);
  const { rows } = await admin.query(
    "SELECT o.shop_id, oi.price FROM orders o JOIN order_items oi ON oi.orderid=o.orderid ORDER BY o.shop_id"
  );
  assert.deepEqual(rows.map((x) => [x.shop_id, x.price]).sort(), [[S2, 12500], [S1, 11000]].sort());
  assert.notEqual(a.internal_order_id, b.internal_order_id);
});

test("Listing Shopee 1 tidak dikenali sebagai item di order Shopee 2 (tanpa silang toko)", { skip }, async () => {
  const id = await addMpOrder(S2, "SN-CROSS", [{ item_id: ITEM_S1, qty: 1 }]);
  const r = await worker.importOrder(await mpRow(id));
  assert.equal(r.status, "failed");
  assert.equal(await stockOf(), 100);
  assert.equal((await mutationSum()).count, 0);
});

// ============================================================
// POS ↔ SHOPEE BERSAMAAN (lost update)
// ============================================================
test("30 transaksi POS + 30 order Shopee 1/2 bersamaan: tidak ada stok hilang", { skip }, async () => {
  const jobs = [];
  for (let i = 0; i < 30; i++) {
    jobs.push(posCheckout(`ORD-20261030-${String(100 + i)}`, "pos-key-" + i, 1));
    const shop = i % 2 ? S2 : S1;
    const item = i % 2 ? ITEM_S2 : ITEM_S1;
    jobs.push(addMpOrder(shop, "SN-C" + i, [{ item_id: item, qty: 1 }]).then(mpRow).then((row) => worker.importOrder(row)));
  }
  const res = await Promise.all(jobs);
  const failed = res.filter((r) => !["created", "imported"].includes(r.status));
  assert.equal(failed.length, 0, JSON.stringify(failed.slice(0, 3)));
  assert.equal(await stockOf(), 40);
  const m = await mutationSum();
  assert.equal(m.count, 60);
  assert.equal(m.qty, 60);
});

// ============================================================
// POS: ID unik & retry aman
// ============================================================
test("POS: orderid bentrok dengan order Shopee → nomor baru, stok dipotong sekali", { skip }, async () => {
  const shopeeOrder = await worker.importOrder(await mpRow(await addMpOrder(S1, "SN-ID", [{ item_id: ITEM_S1, qty: 1 }])));
  const clashing = shopeeOrder.internal_order_id; // client POS menebak nomor yang sama
  const r = await posCheckout(clashing, "pos-clash", 2);
  assert.equal(r.status, "created");
  assert.notEqual(r.orderid, clashing);
  assert.match(r.orderid, new RegExp("^ORD-" + clashing.slice(4, 12) + "-\\d+$"));
  assert.equal(await stockOf(), 97);

  // Retry dari antrean offline (orderid lama, key sama) → already_exists, stok tetap.
  const again = await posCheckout(clashing, "pos-clash", 2);
  assert.equal(again.status, "already_exists");
  assert.equal(again.orderid, r.orderid);
  assert.equal(await stockOf(), 97);
  assert.equal((await mutationSum()).count, 2);
});

// ============================================================
// RETRY order Shopee 'failed' (worker main)
// ============================================================
test("Order 'failed' dicoba ulang setelah mapping diperbaiki; status batal terbaru dihormati", { skip }, async () => {
  await admin.query("DELETE FROM product_shopee_mapping WHERE shop_id=$1", [S1]);
  const okId = await addMpOrder(S1, "SN-LATE", [{ item_id: ITEM_S1, qty: 3 }]);
  const cancelId = await addMpOrder(S1, "SN-CANCEL", [{ item_id: ITEM_S1, qty: 9 }]);
  let r = await worker.main();
  assert.equal(r.failed, 2);
  assert.equal(await stockOf(), 100);

  // Mapping diperbaiki; Shopee: SN-LATE masih valid, SN-CANCEL sudah dibatalkan pembeli.
  await admin.query("INSERT INTO product_shopee_mapping (product_id, shop_id, shopee_item_id) VALUES ($1,$2,$3)", [P, S1, ITEM_S1]);
  shopee.orderDetails["SN-LATE"] = payload("SN-LATE", [{ item_id: ITEM_S1, qty: 3 }], "READY_TO_SHIP");
  shopee.orderDetails["SN-CANCEL"] = payload("SN-CANCEL", [{ item_id: ITEM_S1, qty: 9 }], "CANCELLED");
  r = await worker.main();
  assert.equal(r.imported, 1);
  assert.equal(r.ignored, 1);
  assert.equal(await stockOf(), 97);
  assert.equal((await mpRow(okId)).sync_status, "processed");
  assert.equal((await mpRow(cancelId)).sync_status, "ignored");

  // Run berikutnya tidak menyentuh apa pun lagi.
  r = await worker.main();
  assert.equal(r.imported, 0);
  assert.equal(await stockOf(), 97);
});

test("Order 'failed' TIDAK diimport bila status terbaru Shopee tidak bisa diambil", { skip }, async () => {
  const id = await addMpOrder(S1, "SN-NODETAIL", [{ item_id: ITEM_S1, qty: 2 }], { syncStatus: "failed" });
  const r = await worker.main(); // orderDetails kosong → status tidak bisa diverifikasi
  assert.equal(r.imported, 0);
  assert.equal(r.skipped, 1);
  assert.equal(await stockOf(), 100);
  assert.equal((await mpRow(id)).sync_status, "failed");
});

test("Order 'failed' lama (sebelum fitur retry aktif) TIDAK dicoba ulang otomatis", { skip }, async () => {
  const id = await addMpOrder(S1, "SN-OLD", [{ item_id: ITEM_S1, qty: 2 }], { syncStatus: "failed" });
  await admin.query("UPDATE marketplace_orders SET created_at = now() - interval '2 hours' WHERE id=$1", [id]);
  shopee.orderDetails["SN-OLD"] = payload("SN-OLD", [{ item_id: ITEM_S1, qty: 2 }]);
  const r = await worker.main();
  assert.equal(r.imported, 0);
  assert.equal(await stockOf(), 100);
  assert.equal((await mpRow(id)).sync_status, "failed");
});

test("Stok desimal dikirim ke Shopee dibulatkan ke bawah (tidak oversell)", { skip }, async () => {
  await admin.query("UPDATE products SET stock = 2.6 WHERE id=$1", [P]);
  await shopeeLib.reconcileStock(null);
  assert.deepEqual(shopee.updateStocks.map((x) => x.stock), [2, 2]);
});

test("Worker import tidak berjalan ganda (advisory lock)", { skip }, async () => {
  await addMpOrder(S1, "SN-LOCK", [{ item_id: ITEM_S1, qty: 1 }]);
  const holder = await admin.connect();
  try {
    await holder.query("SELECT pg_advisory_lock($1)", [worker.IMPORT_LOCK_KEY]);
    const r = await worker.main();
    assert.equal(r.skipped, true);
    assert.equal(await stockOf(), 100);
  } finally {
    await holder.query("SELECT pg_advisory_unlock($1)", [worker.IMPORT_LOCK_KEY]);
    holder.release();
  }
  const r2 = await worker.main();
  assert.equal(r2.imported, 1);
  assert.equal(await stockOf(), 99);
});

// ============================================================
// DATABASE → SHOPEE 1 & 2 (push stok + retry)
// ============================================================
test("POS & Shopee 1 → stok terbaru dikirim ke Shopee 1 DAN Shopee 2; gagal → pending → retry", { skip }, async () => {
  await posCheckout("ORD-20261030-500", "pos-sync", 5);
  await worker.importOrder(await mpRow(await addMpOrder(S1, "SN-SYNC", [{ item_id: ITEM_S1, qty: 2 }])));
  assert.equal(await stockOf(), 93);

  shopee.failStockForShop = S2; // API Shopee 2 sedang gagal
  let s = await shopeeLib.syncStock(null);
  assert.equal(s.synced, 0);
  const pending = await admin.query("SELECT count(*)::int AS n FROM stock_mutations WHERE sync_status='pending'");
  assert.equal(pending.rows[0].n, 2, "mutasi tetap di antrean retry");
  assert.deepEqual(shopee.updateStocks, [{ shop_id: S1, item_id: ITEM_S1, stock: 93 }]);

  shopee.failStockForShop = null;
  shopee.updateStocks.length = 0;
  s = await shopeeLib.syncStock(null);
  assert.equal(s.synced, 1);
  assert.deepEqual(
    shopee.updateStocks.map((x) => [x.shop_id, x.item_id, x.stock]).sort(),
    [[S1, ITEM_S1, 93], [S2, ITEM_S2, 93]].sort()
  );
  const left = await admin.query("SELECT count(*)::int AS n FROM stock_mutations WHERE sync_status<>'synced'");
  assert.equal(left.rows[0].n, 0);
  // Push stok TIDAK mengubah stok pusat.
  assert.equal(await stockOf(), 93);
});

test("Rekonsiliasi mengoreksi drift: kirim stok DB ke semua listing tanpa mutasi pending", { skip }, async () => {
  await admin.query("UPDATE products SET stock = 42 WHERE id=$1", [P]); // drift (tanpa mutasi)
  let total = 0, cursor = null, more = true;
  while (more) {
    const r = await shopeeLib.reconcileStock(null, { cursor });
    total += r.synced; cursor = r.next_cursor; more = r.hasMore;
  }
  assert.equal(total, 2);
  assert.deepEqual(
    shopee.updateStocks.map((x) => [x.shop_id, x.stock]).sort(),
    [[S1, 42], [S2, 42]].sort()
  );
});

test("Push stok tidak berjalan ganda: lock dipegang → busy, mutasi tetap pending", { skip }, async () => {
  await posCheckout("ORD-20261030-600", "pos-busy", 1);
  const holder = await admin.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(745300102)");
    const s = await shopeeLib.syncStock(null);
    assert.equal(s.busy, true);
    assert.equal(shopee.updateStocks.length, 0);
  } finally {
    await holder.query("SELECT pg_advisory_unlock(745300102)");
    holder.release();
  }
  const s2 = await shopeeLib.syncStock(null);
  assert.equal(s2.synced, 1);
});

// ============================================================
// HARGA per toko
// ============================================================
test("syncPrice: harga Shopee 1 hanya ke listing Shopee 1, Shopee 2 ke listing Shopee 2", { skip }, async () => {
  const r = await shopeeLib.syncPrice();
  assert.equal(r.failed, 0);
  assert.deepEqual(
    shopee.updatePrices.map((x) => [x.shop_id, x.item_id, x.price]).sort(),
    [[S1, ITEM_S1, 11000], [S2, ITEM_S2, 12500]].sort()
  );
});

test("syncPrice: listing dengan harga variasi berbeda TIDAK diratakan", { skip }, async () => {
  shopee.models[String(ITEM_S2)] = [
    { model_id: 1, price_info: [{ original_price: 12000 }] },
    { model_id: 2, price_info: [{ original_price: 15000 }] },
  ];
  const r = await shopeeLib.syncPrice();
  assert.equal(r.skipped, 1);
  assert.equal(r.failed, 0);
  assert.deepEqual(shopee.updatePrices.map((x) => [x.shop_id, x.item_id]), [[S1, ITEM_S1]]);
});
