// ============================================================
// Test rekonsiliasi stok Shopee (TANPA PostgreSQL nyata & TANPA Shopee nyata).
// Arsitektur baru: latest-stock reconciliation.
//   1) Terhubung: products.stock TERBARU dikirim ke semua listing valid.
//   2) Disconnect: perubahan stok master tetap jalan, TANPA antrean mutasi.
//   3) Reconnect: yang dikirim stok terbaru, bukan stok lama.
//   4) Shopee 1 & 2 memakai kredensial partner masing-masing.
//   5) Produk tanpa mapping tidak dikirimi & dilaporkan unlinked.
//   6) SKU ambigu tidak dibuatkan mapping otomatis.
//   7) Pagination + throttle berjalan.
//   8) Push realtime hanya untuk produk terdampak (tidak mengirim semua).
//   9) Kegagalan tidak menjadi retry queue; tidak ada baca/tulis stock_mutations.
//  10) Dry-run & kill switch tidak mengirim apa pun.
// ============================================================
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const captured = {
  updateStocks: [],
  activityLogs: [],
  insertedMappings: [],
};

const state = {
  accounts: [],
  credentials: {},
  products: [],          // [{ id, name, stock }]
  mappings: {},          // product_id -> [{ shop_id, shopee_item_id }]
  legacyItemIds: {},     // product_id -> Item ID Shopee 1 di products.shopee_item_id
  disconnected: [],
  updateStockResponse: { error: null, response: {} },
  authRefreshCalls: 0,
  lockFree: true,
  pullItems: [],         // listing yang dikembalikan get_item_list
  pullBaseItems: [],     // detail listing untuk pullProducts
  pullSkuRows: [],       // hasil SELECT id, sku, shopee_sku FROM products
  mappingRowsByShop: [],
  insertMappingRowCount: 1,
};

function normalize(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function productById(id) {
  return state.products.find((p) => Number(p.id) === Number(id)) || null;
}

function hasMapping(productId) {
  const rows = state.mappings[Number(productId)] || [];
  return rows.some((m) => m.shopee_item_id != null) || state.legacyItemIds[Number(productId)] != null;
}

class FakePool {
  on() { return this; }
  async connect() {
    return {
      async query(text) {
        const sql = normalize(text);
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ ok: state.lockFree }] };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
        throw new Error("UNEXPECTED_CLIENT_QUERY: " + sql.slice(0, 140));
      },
      release() {},
    };
  }
  async query(text, params) {
    const sql = normalize(text);

    // Mekanisme baru tidak boleh menyentuh antrean lama sama sekali.
    if (sql.includes("stock_mutations")) {
      throw new Error("STOCK_MUTATIONS_TIDAK_BOLEH_DIPAKAI: " + sql.slice(0, 120));
    }

    if (sql === "SELECT stock FROM products WHERE id = $1") {
      const p = productById(params[0]);
      return { rows: p ? [{ stock: p.stock }] : [] };
    }
    if (sql.startsWith("SELECT id, name, stock FROM products WHERE id = $1 LIMIT 1")) {
      const p = productById(params[0]);
      return { rows: p ? [{ id: p.id, name: p.name, stock: p.stock }] : [] };
    }
    if (sql.includes("FROM marketplace_config") && sql.includes("connection_status = 'disconnected'")) {
      return { rows: state.disconnected.map((shop_id) => ({ shop_id })) };
    }
    if (sql.includes("FROM marketplace_config")) {
      return { rows: state.accounts };
    }
    if (sql.includes("FROM marketplace_credentials")) {
      const c = state.credentials[String(params[0])] || null;
      return { rows: c ? [c] : [] };
    }
    if (sql.includes("JOIN product_shopee_mapping m ON m.product_id")) {
      // Simulasi pagination: params = [limit] atau [cursor, limit].
      const limit = Number(params[params.length - 1]);
      const cursor = params.length > 1 ? Number(params[0]) : null;
      let rows = state.products.filter((p) => hasMapping(p.id));
      rows = rows.slice().sort((a, b) => Number(a.id) - Number(b.id));
      if (cursor != null) rows = rows.filter((p) => Number(p.id) > cursor);
      return { rows: rows.slice(0, limit) };
    }
    if (sql.includes("count(*)::int AS count") && sql.includes("NOT EXISTS")) {
      const count = state.products.filter((p) => !hasMapping(p.id)).length;
      return { rows: [{ count }] };
    }
    if (sql.includes("NOT EXISTS") && sql.includes("ORDER BY p.id LIMIT")) {
      const limit = Number(params[0]);
      const rows = state.products
        .filter((p) => !hasMapping(p.id))
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, limit);
      return { rows };
    }
    if (sql.includes("SELECT shopee_item_id FROM products WHERE id = $1 AND shopee_item_id IS NOT NULL")) {
      const itemId = state.legacyItemIds[Number(params[0])];
      return { rows: itemId != null ? [{ shopee_item_id: itemId }] : [] };
    }
    if (sql.includes("FROM product_shopee_mapping WHERE product_id = $1")) {
      return { rows: state.mappings[Number(params[0])] || [] };
    }
    if (sql === "SELECT id, sku, shopee_sku FROM products") {
      return { rows: state.pullSkuRows };
    }
    if (sql.startsWith("SELECT id, product_id, shopee_item_id FROM product_shopee_mapping WHERE shop_id = $1")) {
      return { rows: state.mappingRowsByShop.filter((m) => String(m.shop_id) === String(params[0])) };
    }
    if (sql.startsWith("INSERT INTO product_shopee_mapping")) {
      captured.insertedMappings.push(params);
      return { rowCount: state.insertMappingRowCount, rows: [] };
    }
    if (sql.includes("INSERT INTO activity_log")) {
      captured.activityLogs.push(params);
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO marketplace_credentials")) {
      return { rows: [] };
    }
    throw new Error("UNEXPECTED_QUERY: " + sql.slice(0, 140));
  }
}

function json(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const originalPool = pg.Pool;
const originalFetch = globalThis.fetch;

pg.Pool = FakePool;
process.env.DATABASE_URL = "postgresql://fake:fake@127.0.0.1:5432/fake";
process.env.SHOPEE_PARTNER_ID = "fake-partner-id";
process.env.SHOPEE_PARTNER_KEY = "fake-partner-key";
process.env.SHOPEE_SHOP_ID = "724153261";
process.env.SHOPEE2_PARTNER_ID = "fake2-partner-id";
process.env.SHOPEE2_PARTNER_KEY = "fake2-partner-key";
process.env.SHOPEE2_SHOP_ID = "1214362884";
process.env.SHOPEE_THROTTLE_MS = "0";

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/api/v2/product/get_model_list")) {
    return json({ error: null, response: { model: [] } });
  }
  if (u.includes("/api/v2/product/get_item_base_info")) {
    // Pull produk memakai item_id_list; update stok memakai item_id.
    if (u.includes("item_id_list=")) {
      return json({ error: null, response: { item_list: state.pullBaseItems } });
    }
    return json({ error: null, response: { item_list: [{ stock_info_v2: { seller_stock: [{ location_id: "loc-1" }] } }] } });
  }
  if (u.includes("/api/v2/product/get_item_list")) {
    return json({ error: null, response: { item: state.pullItems, has_next_page: false } });
  }
  if (u.includes("/api/v2/product/update_stock")) {
    captured.updateStocks.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
    return json(state.updateStockResponse);
  }
  if (u.includes("/api/v2/auth/access_token/get")) {
    state.authRefreshCalls++;
    return json({ error: null, access_token: "newtok", refresh_token: "rt2" });
  }
  throw new Error("UNEXPECTED_FETCH: " + u.slice(0, 120));
};

const { syncStock, reconcileStock, syncProductsStock, syncStockForProduct, pullProducts } = await import("../src/shopee.js");

function twoShops() {
  state.accounts = [
    { shop_id: "724153261", shop_name: "Shopee 1" },
    { shop_id: "1214362884", shop_name: "Shopee 2" },
  ];
  state.credentials = {
    "724153261": { access_token: "tok1", refresh_token: null },
    "1214362884": { access_token: "tok2", refresh_token: null },
  };
}

beforeEach(() => {
  captured.updateStocks.length = 0;
  captured.activityLogs.length = 0;
  captured.insertedMappings.length = 0;
  state.accounts = [];
  state.disconnected = [];
  state.credentials = {};
  state.products = [];
  state.mappings = {};
  state.legacyItemIds = {};
  state.updateStockResponse = { error: null, response: {} };
  state.authRefreshCalls = 0;
  state.lockFree = true;
  state.pullItems = [];
  state.pullBaseItems = [];
  state.pullSkuRows = [];
  state.mappingRowsByShop = [];
  state.insertMappingRowCount = 1;
  process.env.SHOPEE_THROTTLE_MS = "0";
});

after(() => {
  pg.Pool = originalPool;
  globalThis.fetch = originalFetch;
});

test("terhubung: syncProductsStock mengirim products.stock terbaru ke semua listing", async () => {
  twoShops();
  state.products = [{ id: 206, name: "DADA FILLET 1kg", stock: 99 }];
  state.mappings = {
    206: [
      { shop_id: "724153261", shopee_item_id: 24494633239 },
      { shop_id: "1214362884", shopee_item_id: 99999999999 },
    ],
  };

  const r = await syncProductsStock([206]);

  assert.equal(r.synced, 2);
  assert.equal(r.failed, 0);
  assert.equal(captured.updateStocks.length, 2);
  for (const c of captured.updateStocks) {
    assert.equal(c.body.stock_list[0].seller_stock[0].stock, 99);
  }
  const itemIds = captured.updateStocks.map((c) => c.body.item_id).sort((a, b) => a - b);
  assert.deepEqual(itemIds, [24494633239, 99999999999]);
});

test("disconnect: stok dianggap selesai tanpa antrean stock_mutations", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.disconnected = ["1214362884"];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [{ id: 207, name: "Q", stock: 4 }];
  state.mappings = { 207: [{ shop_id: "1214362884", shopee_item_id: 333 }] };

  const r = await syncProductsStock([207]);

  assert.equal(r.synced, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 1);
  assert.equal(captured.updateStocks.length, 0);
  // FakePool melempar error bila ada query yang menyentuh stock_mutations.
});

test("reconnect: yang dikirim stok TERBARU, bukan stok lama", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.disconnected = ["724153261"];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [{ id: 206, name: "P", stock: 7 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };

  const before = await reconcileStock();
  assert.equal(before.synced, 0);
  assert.equal(captured.updateStocks.length, 0, "toko diputus tidak dikirimi stok");

  // Toko kembali connected dan stok master sudah berubah.
  state.disconnected = [];
  state.products[0].stock = 3;

  const after = await syncStock();
  assert.equal(after.synced, 1);
  assert.equal(captured.updateStocks.length, 1);
  assert.equal(captured.updateStocks[0].body.stock_list[0].seller_stock[0].stock, 3, "harus stok terbaru");
});

test("Shopee 1 & Shopee 2 memakai partner masing-masing", async () => {
  twoShops();
  state.products = [{ id: 206, name: "P", stock: 99 }];
  state.mappings = {
    206: [
      { shop_id: "724153261", shopee_item_id: 24494633239 },
      { shop_id: "1214362884", shopee_item_id: 99999999999 },
    ],
  };

  const r = await mergeStockSync();
  assert.equal(r.synced, 2);

  const shop1 = captured.updateStocks.find((c) => c.body.item_id === 24494633239);
  const shop2 = captured.updateStocks.find((c) => c.body.item_id === 99999999999);
  assert.ok(shop1 && shop2);
  assert.ok(shop1.url.includes("partner_id=fake-partner-id"));
  assert.ok(shop2.url.includes("partner_id=fake2-partner-id"));
  assert.ok(!shop2.url.includes("partner_id=fake-partner-id"));
});

async function mergeStockSync() {
  return syncProductsStock([206]);
}

test("produk tanpa mapping tidak dikirim dan dilaporkan unlinked", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [
    { id: 1, name: "Terhubung", stock: 5 },
    { id: 2, name: "Belum terhubung", stock: 9 },
  ];
  state.mappings = { 1: [{ shop_id: "724153261", shopee_item_id: 111 }] };

  const one = await syncProductsStock([2]);
  assert.equal(one.unlinked, 1);
  assert.equal(one.synced, 0);
  assert.equal(captured.updateStocks.length, 0, "produk tanpa mapping tidak dikirimi");

  const full = await syncStock();
  assert.equal(full.unlinked_count, 1);
  assert.deepEqual(full.unlinked_products.map((p) => p.id), [2]);
  assert.equal(captured.updateStocks.length, 1, "hanya produk terhubung yang dikirimi");
});

test("SKU ambigu tidak dibuatkan mapping otomatis", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.pullItems = [{ item_id: 555 }];
  state.pullBaseItems = [{ item_id: 555, item_sku: "AMBIG", item_name: "Listing" }];
  state.pullSkuRows = [
    { id: 1, sku: "AMBIG", shopee_sku: null },
    { id: 2, sku: "AMBIG", shopee_sku: null },
  ];

  const r = await pullProducts("724153261");

  assert.equal(r.inserted, 0);
  assert.equal(r.unmatched, 1);
  assert.equal(captured.insertedMappings.length, 0, "SKU ambigu tidak boleh ditebak");
});

test("pagination: batch dibatasi dan dilanjutkan dengan next_cursor", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [
    { id: 1, name: "P1", stock: 10 },
    { id: 2, name: "P2", stock: 20 },
    { id: 3, name: "P3", stock: 30 },
  ];
  state.mappings = {
    1: [{ shop_id: "724153261", shopee_item_id: 101 }],
    2: [{ shop_id: "724153261", shopee_item_id: 102 }],
    3: [{ shop_id: "724153261", shopee_item_id: 103 }],
  };

  const first = await reconcileStock(null, { batchLimit: 2 });
  assert.equal(first.listings_processed, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.next_cursor, 2);

  const second = await reconcileStock(null, { cursor: first.next_cursor, batchLimit: 2 });
  assert.equal(second.listings_processed, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.next_cursor, null);

  assert.equal(captured.updateStocks.length, 3);
});

test("throttle: jeda antar-listing benar-benar dijalankan", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [{ id: 1, name: "P1", stock: 1 }];
  state.mappings = {
    1: [
      { shop_id: "724153261", shopee_item_id: 101 },
      { shop_id: "724153261", shopee_item_id: 102 },
      { shop_id: "724153261", shopee_item_id: 103 },
    ],
  };
  process.env.SHOPEE_THROTTLE_MS = "25";
  const started = Date.now();
  const r = await mergeOne();
  const elapsed = Date.now() - started;
  assert.equal(r.synced, 3);
  assert.ok(elapsed >= 40, `throttle harus berjalan (elapsed=${elapsed}ms)`);
});

async function mergeOne() {
  return syncProductsStock([1]);
}

test("push realtime hanya mengirim produk yang terdampak", async () => {
  twoShops();
  state.products = [
    { id: 1, name: "Berubah", stock: 5 },
    { id: 2, name: "Tidak berubah", stock: 50 },
  ];
  state.mappings = {
    1: [{ shop_id: "724153261", shopee_item_id: 101 }],
    2: [{ shop_id: "1214362884", shopee_item_id: 202 }],
  };

  const r = await syncProductsStock([1]);
  assert.equal(r.synced, 1);
  assert.equal(captured.updateStocks.length, 1, "jangan kirim stok produk yang tidak berubah");
  assert.equal(captured.updateStocks[0].body.item_id, 101);
});

test("kegagalan per listing tercatat, tanpa antrean retry", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [{ id: 206, name: "P", stock: 5 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };
  state.updateStockResponse = { error: null, response: { failure_list: [{ failed_reason: "invalid item" }] } };

  const r = await reconcileStock();

  assert.equal(r.failed, 1);
  const failedLog = captured.activityLogs.find((p) => p[6] === "failed");
  assert.ok(failedLog, "harus ada log status failed");
  assert.match(String(failedLog[7]), /failure_list: invalid item/);
  // Tidak ada query stock_mutations (FakePool akan melempar bila ada).
});

test("tidak mencatat log success berulang", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [{ id: 206, name: "P", stock: 99 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };

  const r = await reconcileStock();

  assert.equal(r.synced, 1);
  assert.equal(captured.activityLogs.length, 0, "tidak boleh ada log success");
});

test("error non-auth tidak memicu refresh token", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: "rt1" } };
  state.products = [{ id: 206, name: "P", stock: 5 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };
  state.updateStockResponse = { error: null, response: { failure_list: [{ failed_reason: "invalid item" }] } };

  const r = await reconcileStock();

  assert.equal(r.failed, 1);
  assert.equal(state.authRefreshCalls, 0);
});

test("error auth memicu refresh token lalu retry", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: "rt1" } };
  state.products = [{ id: 206, name: "P", stock: 5 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };
  state.updateStockResponse = { error: "error_auth", response: {} };

  await reconcileStock();

  assert.equal(state.authRefreshCalls, 1);
});

test("dry-run tidak memanggil Shopee dan tidak menulis DB", async () => {
  twoShops();
  state.products = [{ id: 206, name: "P", stock: 99 }];
  state.mappings = {
    206: [
      { shop_id: "724153261", shopee_item_id: 111 },
      { shop_id: "1214362884", shopee_item_id: 222 },
    ],
  };

  const r = await reconcileStock(null, { dryRun: true });

  assert.equal(r.dry_run, true);
  assert.equal(r.synced, 2);
  assert.equal(captured.updateStocks.length, 0, "dry-run tidak boleh kirim");
  assert.equal(captured.activityLogs.length, 0, "dry-run tidak boleh tulis log");
});

test("kill switch SHOPEE_STOCK_PUSH=0 memblokir semua pengiriman", async () => {
  process.env.SHOPEE_STOCK_PUSH = "0";
  try {
    twoShops();
    state.products = [{ id: 206, name: "P", stock: 5 }];
    state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };

    const s = await syncStock();
    assert.equal(s.disabled, true);
    assert.equal(s.synced, 0);

    const r = await reconcileStock();
    assert.equal(r.disabled, true);

    const p = await syncProductsStock([206]);
    assert.equal(p.disabled, true);

    assert.equal(captured.updateStocks.length, 0);
  } finally {
    delete process.env.SHOPEE_STOCK_PUSH;
  }
});

test("lock push dipegang proses lain: tidak mengirim & tidak menandai apa pun", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [{ id: 206, name: "P", stock: 99 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };
  state.lockFree = false;

  const s = await syncStock();
  const r = await reconcileStock();
  const p = await syncProductsStock([206]);

  assert.equal(s.busy, true);
  assert.equal(r.busy, true);
  assert.equal(p.busy, true);
  assert.equal(captured.updateStocks.length, 0);
});

test("syncStockForProduct: produk legacy Shopee 1 tetap memakai item id lama", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.products = [{ id: 300, name: "Produk Legacy", stock: 12 }];
  state.mappings = { 300: [] };
  state.legacyItemIds = { 300: 24494633239 };

  const r = await syncStockForProduct(300);

  assert.equal(r.ok, true);
  assert.equal(captured.updateStocks.length, 1);
  assert.equal(captured.updateStocks[0].body.item_id, 24494633239);
});
