// ============================================================
// Test rekonsiliasi stok Shopee (TANPA PostgreSQL nyata & TANPA Shopee nyata).
// Memastikan:
//   1) Produk tanpa mapping TIDAK diam-diam ditandai synced (-> failed).
//   2) reconcileStock mengirim products.stock ke SEMUA listing ter-mapping.
//   3) Kegagalan per listing tercatat di activity_log.
//   4) Batas batch listing + lanjutan (hasMore/next_cursor).
//   5) Tidak ada log success berulang di reconcileStock.
//   6) Refresh token hanya untuk error autentikasi (isAuthError).
//   7) Dry-run tidak memanggil Shopee & tidak menulis DB.
// ============================================================
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const captured = {
  updateStocks: [],
  activityLogs: [],
  stockMutationUpdate: null,
};

const state = {
  accounts: [],
  credentials: {},
  syncProducts: [],      // hasil query DISTINCT ON (syncStock)
  reconcileProducts: [], // hasil query DISTINCT (reconcileStock)
  mappings: {},          // product_id -> [{shop_id, shopee_item_id}]
  updateStockResponse: { error: null, response: {} },
  authRefreshCalls: 0,   // berapa kali /auth/access_token/get dipanggil
  lockFree: true,        // hasil pg_try_advisory_lock
};

function normalize(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

class FakePool {
  on() { return this; }
  // Koneksi khusus untuk advisory lock push stok.
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
    if (sql === "SELECT stock FROM products WHERE id = $1") {
      const id = Number(params[0]);
      const p = state.syncProducts.find((r) => Number(r.product_id) === id) ||
        state.reconcileProducts.find((r) => Number(r.id) === id);
      return { rows: p ? [{ stock: p.stock }] : [] };
    }
    if (sql.includes("FROM marketplace_config")) {
      return { rows: state.accounts };
    }
    if (sql.includes("FROM marketplace_credentials")) {
      const c = state.credentials[String(params[0])] || null;
      return { rows: c ? [c] : [] };
    }
    if (sql.includes("JOIN product_shopee_mapping m ON m.product_id")) {
      // Simulasi pagination: params = [limit] atau [cursor, limit] (tanpa shopId).
      const limit = Number(params[params.length - 1]);
      const cursor = params.length > 1 ? Number(params[0]) : null;
      let rows = state.reconcileProducts.slice().sort((a, b) => Number(a.id) - Number(b.id));
      if (cursor != null) rows = rows.filter((r) => Number(r.id) > cursor);
      return { rows: rows.slice(0, limit) };
    }
    if (sql.includes("FROM stock_mutations m") && sql.includes("JOIN products")) {
      return { rows: state.syncProducts };
    }
    if (sql.includes("FROM product_shopee_mapping WHERE product_id = $1")) {
      return { rows: state.mappings[Number(params[0])] || [] };
    }
    if (sql.includes("UPDATE stock_mutations SET sync_status")) {
      captured.stockMutationUpdate = { sql, params };
      return { rows: [] };
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
    return json({ error: null, response: { item_list: [{ stock_info_v2: { seller_stock: [{ location_id: "loc-1" }] } }] } });
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

const { syncStock, reconcileStock } = await import("../src/shopee.js");

beforeEach(() => {
  // reset per-test state
  captured.updateStocks.length = 0;
  captured.activityLogs.length = 0;
  captured.stockMutationUpdate = null;
  state.accounts = [];
  state.credentials = {};
  state.syncProducts = [];
  state.reconcileProducts = [];
  state.mappings = {};
  state.updateStockResponse = { error: null, response: {} };
  state.authRefreshCalls = 0;
  state.lockFree = true;
});

after(() => {
  pg.Pool = originalPool;
  globalThis.fetch = originalFetch;
});

test("syncStock: produk tanpa mapping ditandai failed, bukan synced", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.syncProducts = [{ product_id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 99, mutation_ids: [1] }];
  state.mappings = { 206: [] };

  const r = await syncStock();

  assert.equal(r.failed, 1);
  assert.equal(r.synced, 0);
  assert.match(captured.stockMutationUpdate.sql, /sync_status='failed'/);
  assert.equal(r.results[0].error, "tanpa mapping Shopee");
  assert.equal(captured.activityLogs.length, 1);
  assert.equal(captured.activityLogs[0][6], "failed"); // status
});

test("reconcileStock: kirim products.stock ke semua listing ter-mapping", async () => {
  state.accounts = [
    { shop_id: "724153261", shop_name: "Shopee 1" },
    { shop_id: "1214362884", shop_name: "Shopee 2" },
  ];
  state.credentials = {
    "724153261": { access_token: "tok1", refresh_token: null },
    "1214362884": { access_token: "tok2", refresh_token: null },
  };
  state.reconcileProducts = [{ id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 99 }];
  state.mappings = {
    206: [
      { shop_id: "724153261", shopee_item_id: 24494633239 },
      { shop_id: "1214362884", shopee_item_id: 99999999999 },
    ],
  };

  const r = await reconcileStock();

  assert.equal(r.synced, 2);
  assert.equal(r.failed, 0);
  assert.equal(captured.updateStocks.length, 2);
  const itemIds = captured.updateStocks.map((c) => c.body.item_id).sort((a, b) => a - b);
  assert.deepEqual(itemIds, [24494633239, 99999999999]);
  for (const c of captured.updateStocks) {
    assert.equal(c.body.stock_list[0].seller_stock[0].stock, 99);
  }
});

test("reconcileStock: kegagalan per listing tercatat di activity_log", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.reconcileProducts = [{ id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 5 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };
  state.updateStockResponse = { error: null, response: { failure_list: [{ failed_reason: "invalid item" }] } };

  const r = await reconcileStock();

  assert.equal(r.failed, 1);
  const failedLog = captured.activityLogs.find((p) => p[6] === "failed");
  assert.ok(failedLog, "harus ada log status failed");
  assert.match(String(failedLog[7]), /failure_list: invalid item/);
});

test("reconcileStock: batas batch + lanjutan (hasMore/next_cursor)", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.reconcileProducts = [
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

test("reconcileStock: tidak mencatat log success berulang", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.reconcileProducts = [{ id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 99 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 24494633239 }] };

  const r = await reconcileStock();

  assert.equal(r.synced, 1);
  assert.equal(captured.activityLogs.length, 0, "tidak boleh ada log success di reconcile");
});

test("reconcileStock: error non-auth TIDAK memicu refresh token", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: "rt1" } };
  state.reconcileProducts = [{ id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 5 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };
  state.updateStockResponse = { error: null, response: { failure_list: [{ failed_reason: "invalid item" }] } };

  const r = await reconcileStock();

  assert.equal(r.failed, 1);
  assert.equal(state.authRefreshCalls, 0, "error non-auth tidak boleh refresh token");
});

test("reconcileStock: error auth memicu refresh token lalu retry", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: "rt1" } };
  state.reconcileProducts = [{ id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 5 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 111 }] };
  state.updateStockResponse = { error: "error_auth", response: {} };

  const r = await reconcileStock();

  assert.equal(state.authRefreshCalls, 1, "error auth harus refresh token sekali");
});

test("reconcileStock: dry-run tidak memanggil update_stock & tidak menulis DB", async () => {
  state.accounts = [
    { shop_id: "724153261", shop_name: "Shopee 1" },
    { shop_id: "1214362884", shop_name: "Shopee 2" },
  ];
  state.credentials = {
    "724153261": { access_token: "tok1", refresh_token: null },
    "1214362884": { access_token: "tok2", refresh_token: null },
  };
  state.reconcileProducts = [{ id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 99 }];
  state.mappings = {
    206: [
      { shop_id: "724153261", shopee_item_id: 24494633239 },
      { shop_id: "1214362884", shopee_item_id: 99999999999 },
    ],
  };

  const r = await reconcileStock(null, { dryRun: true });

  assert.equal(r.dry_run, true);
  assert.equal(r.synced, 2);
  assert.equal(captured.updateStocks.length, 0, "dry-run tidak boleh kirim ke Shopee");
  assert.equal(captured.activityLogs.length, 0, "dry-run tidak boleh tulis activity_log");
});

test("syncStock: dry-run tidak mengubah stock_mutations & tidak kirim stok", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.syncProducts = [{ product_id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 99, mutation_ids: [1] }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 24494633239 }] };

  const r = await syncStock(null, { dryRun: true });

  assert.equal(r.dry_run, true);
  assert.equal(r.synced, 1);
  assert.equal(captured.updateStocks.length, 0, "dry-run tidak boleh kirim ke Shopee");
  assert.equal(captured.stockMutationUpdate, null, "dry-run tidak boleh ubah stock_mutations");
});

test("reconcileStock: Shopee 2 memakai SHOPEE2_PARTNER_ID untuk sign", async () => {
  state.accounts = [
    { shop_id: "724153261", shop_name: "Shopee 1" },
    { shop_id: "1214362884", shop_name: "Shopee 2" },
  ];
  state.credentials = {
    "724153261": { access_token: "tok1", refresh_token: null },
    "1214362884": { access_token: "tok2", refresh_token: null },
  };
  state.reconcileProducts = [{ id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 99 }];
  state.mappings = {
    206: [
      { shop_id: "724153261", shopee_item_id: 24494633239 },
      { shop_id: "1214362884", shopee_item_id: 99999999999 },
    ],
  };

  const r = await reconcileStock();
  assert.equal(r.synced, 2);

  const shop1 = captured.updateStocks.find((c) => c.body.item_id === 24494633239);
  const shop2 = captured.updateStocks.find((c) => c.body.item_id === 99999999999);
  assert.ok(shop1, "harus ada request Shopee 1");
  assert.ok(shop2, "harus ada request Shopee 2");
  assert.ok(shop1.url.includes("partner_id=fake-partner-id"), "Shopee 1 pakai SHOPEE_PARTNER_ID");
  assert.ok(shop2.url.includes("partner_id=fake2-partner-id"), "Shopee 2 pakai SHOPEE2_PARTNER_ID");
  assert.ok(!shop2.url.includes("partner_id=fake-partner-id"), "Shopee 2 TIDAK boleh pakai partner Shopee 1");
});

test("syncStock & reconcileStock: lock push stok sedang dipegang → tidak kirim apa pun", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.syncProducts = [{ product_id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 99, mutation_ids: [1] }];
  state.reconcileProducts = [{ id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 99 }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 24494633239 }] };
  state.lockFree = false;

  const s = await syncStock();
  const r = await reconcileStock();

  assert.equal(s.busy, true);
  assert.equal(r.busy, true);
  assert.equal(r.hasMore, false);
  assert.equal(captured.updateStocks.length, 0, "tidak boleh kirim stok saat run lain berjalan");
  assert.equal(captured.stockMutationUpdate, null, "mutasi tetap pending");
});

test("syncStock: semua mutasi pending yang terlihat ditandai synced sekaligus", async () => {
  state.accounts = [{ shop_id: "724153261", shop_name: "Shopee 1" }];
  state.credentials = { "724153261": { access_token: "tok1", refresh_token: null } };
  state.syncProducts = [{ product_id: 206, name: "DADA FILLET BONELLES DADA 1kg", stock: 7, mutation_ids: [3, 5, 9] }];
  state.mappings = { 206: [{ shop_id: "724153261", shopee_item_id: 24494633239 }] };

  const r = await syncStock();

  assert.equal(r.synced, 1);
  assert.equal(captured.updateStocks[0].body.stock_list[0].seller_stock[0].stock, 7);
  assert.match(captured.stockMutationUpdate.sql, /sync_status='synced'/);
  assert.match(captured.stockMutationUpdate.sql, /sync_status='pending'/);
  assert.deepEqual(captured.stockMutationUpdate.params[0], [3, 5, 9]);
});
