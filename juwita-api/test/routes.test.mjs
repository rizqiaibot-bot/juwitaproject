import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import pg from "pg";

// ============================================================
// Harness HTTP dengan database palsu (tanpa PostgreSQL nyata).
// Shopee tidak pernah dipanggil pada test ini.
// ============================================================
const USERS = {
  "owner-id": {
    id: "owner-id", phone: "081000000001", full_name: "Owner Test",
    role: "owner", role_label: "Owner", menus: [], status: "ACTIVE",
  },
  "katalog-id": {
    id: "katalog-id", phone: "081000000002", full_name: "Katalog Test",
    role: "staf", role_label: "Staf", menus: ["katalog"], status: "ACTIVE",
  },
  "pricing-id": {
    id: "pricing-id", phone: "081000000003", full_name: "Pricing Test",
    role: "keuangan", role_label: "Keuangan", menus: ["pricing"], status: "ACTIVE",
  },
  "gudang-id": {
    id: "gudang-id", phone: "081000000004", full_name: "Gudang Test",
    role: "gudang", role_label: "Gudang", menus: ["gudang"], status: "ACTIVE",
  },
  "hr-id": {
    id: "hr-id", phone: "081000000005", full_name: "HR Test",
    role: "hr", role_label: "HR", menus: ["hr"], status: "ACTIVE",
  },
  "penjualan-id": {
    id: "penjualan-id", phone: "081000000006", full_name: "Penjualan Test",
    role: "staf", role_label: "Staf", menus: ["penjualan"], status: "ACTIVE",
  },
  "pos-id": {
    id: "pos-id", phone: "081000000007", full_name: "POS Test",
    role: "kasir", role_label: "Kasir", menus: ["pos"], status: "ACTIVE",
  },
  "pembelian-id": {
    id: "pembelian-id", phone: "081000000008", full_name: "Pembelian Test",
    role: "staf", role_label: "Staf", menus: ["pembelian"], status: "ACTIVE",
  },
  "persediaan-id": {
    id: "persediaan-id", phone: "081000000009", full_name: "Persediaan Test",
    role: "staf", role_label: "Staf", menus: ["persediaan"], status: "ACTIVE",
  },
};

const captured = {};
const fakeRefs = {
  order_items: 0,
  purchase_items: 0,
  stock_mutations: 0,
  warehouse_receiving: 0,
  warehouse_racks: 0,
  activity_log: 0,
  product_shopee_mapping: 0,
};

const PRODUCT_ROW = {
  id: 1, name: "Produk Test", category: "Test", price: 1000, modal: 500,
  stock: 10, minstock: 1, maxstock: 20, supplier: null, imageicon: null,
  barcode: "8990000000001", shopee_item_id: null, shopee_sku: null,
  sku: "TST-0001", plu: null,
};

function normalize(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

class FakePool {
  on() { return this; }

  async query(text, params) {
    const sql = normalize(text);
    if (sql.includes("FROM app_users WHERE id = $1")) {
      return { rows: USERS[params[0]] ? [USERS[params[0]]] : [] };
    }
    if (sql.includes("SELECT now() AS now")) {
      return { rows: [{ now: new Date().toISOString() }] };
    }
    if (sql.includes("count(*)::int AS total FROM products")) {
      return { rows: [{ total: 1 }] };
    }
    if (sql.includes("count(*)::int AS total FROM product_prices")) {
      return { rows: [{ total: 0 }] };
    }
    if (sql.includes("FROM products ORDER BY id")) {
      return { rows: [PRODUCT_ROW] };
    }
    if (sql.includes("FROM product_prices")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT record_warehouse_action(")) {
      captured.warehouseRpc = params;
      return { rows: [{ result: { status: "ok", wmsstatus: params[1] === "pick" ? "Dipick" : "Siap Kirim" } }] };
    }
    if (sql.includes("UPDATE orders SET wmsstatus = 'Packing'")) {
      captured.packing = params;
      return { rows: [{ orderid: params[0], wmsstatus: "Packing" }] };
    }
    if (sql.includes("FROM public.attendance_clock")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT id, name, stock FROM products")) {
      return { rows: [PRODUCT_ROW] };
    }
    if (sql.startsWith("UPDATE products SET")) {
      captured.productPatch = params;
      return { rows: [PRODUCT_ROW] };
    }
    if (sql.includes("INSERT INTO stock_mutations")) {
      captured.stockMutation = params;
      return { rows: [] };
    }
    throw new Error("UNEXPECTED_QUERY: " + sql.slice(0, 140));
  }

  async connect() {
    return {
      async query(text, params) {
        const sql = normalize(text);
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          captured.tx = captured.tx || [];
          captured.tx.push(sql);
          return { rows: [] };
        }
        if (sql.includes("SELECT id FROM products WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: 1 }] };
        }
        if (sql.includes("SELECT id, name FROM products WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: 1, name: "Produk Test" }] };
        }
        if (sql.includes("SELECT to_regclass($1) AS t")) {
          return { rows: [{ t: params[0] }] };
        }
        if (sql.includes("SELECT to_regclass('product_shopee_mapping') AS t")) {
          return { rows: [{ t: "product_shopee_mapping" }] };
        }
        const countMatch = sql.match(/SELECT count\(\*\)::int AS count FROM (\w+) WHERE product_id = \$1/);
        if (countMatch) {
          return { rows: [{ count: fakeRefs[countMatch[1]] || 0 }] };
        }
        if (sql.includes("DELETE FROM product_shopee_mapping WHERE product_id = $1")) {
          const removed = fakeRefs.product_shopee_mapping || 0;
          fakeRefs.product_shopee_mapping = 0;
          captured.removedMappings = removed;
          return { rowCount: removed, rows: [] };
        }
        if (sql.includes("UPDATE products SET shopee_item_id = NULL, shopee_sku = NULL WHERE id = $1")) {
          return { rows: [] };
        }
        if (sql.includes("DELETE FROM products WHERE id = $1 RETURNING *")) {
          return { rows: [PRODUCT_ROW] };
        }
        if (sql.includes("FROM purchases WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: Number(params[0]), po_number: "PO-5", receiving_status: "Belum" }] };
        }
        if (sql.includes("FROM purchase_items WHERE purchase_id = $1")) {
          return {
            rows: [{
              id: 11, purchase_id: Number(params[0]), product_id: 1,
              product_name: "Produk Test", qty: 10, qty_received: 0, harga_beli: 500,
            }],
          };
        }
        if (sql.includes("SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE")) {
          return { rows: [{ id: 1, name: "Produk Test", stock: 7 }] };
        }
        if (sql.includes("UPDATE products SET stock = $1, modal = $2 WHERE id = $3")) {
          captured.productUpdate = params;
          return { rows: [] };
        }
        if (sql.includes("UPDATE purchase_items SET qty_received = qty_received + $1 WHERE id = $2")) {
          captured.itemUpdate = params;
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO stock_mutations")) {
          captured.mutation = params;
          return { rows: [] };
        }
        if (sql.includes("UPDATE purchases SET receiving_status = $1 WHERE id = $2")) {
          captured.purchaseUpdate = params;
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO warehouse_opname")) {
          return { rows: [{ id: "OPN-TEST", zone: params[0], officer: params[1], status: "open" }] };
        }
        throw new Error("UNEXPECTED_CLIENT_QUERY: " + sql.slice(0, 140));
      },
      release() {},
    };
  }
}

const originalPool = pg.Pool;
pg.Pool = FakePool;
process.env.DATABASE_URL = "postgresql://fake:fake@127.0.0.1:5432/fake";
process.env.JWT_SECRET = "test-only-secret";
process.env.NODE_ENV = "test";

const { server } = await import("../src/server.js");
let base = "";

function token(userId) {
  const u = USERS[userId];
  return jwt.sign({ role: u.role, status: u.status }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    subject: userId,
    expiresIn: "1h",
  });
}

async function call(path, method = "GET", userId = null, body = null) {
  const headers = {};
  if (userId) headers.Authorization = "Bearer " + token(userId);
  if (body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  pg.Pool = originalPool;
});

test("tanpa autentikasi ditolak", async () => {
  const r = await call("/api/products");
  assert.equal(r.status, 401);
});

test("HR tidak boleh membaca katalog", async () => {
  const r = await call("/api/products", "GET", "hr-id");
  assert.equal(r.status, 403);
});

test("Katalog boleh membaca produk", async () => {
  const r = await call("/api/products", "GET", "katalog-id");
  assert.equal(r.status, 200);
  assert.equal(r.data.data[0].name, "Produk Test");
});

test("Katalog tidak boleh membaca harga per channel", async () => {
  const r = await call("/api/product-prices", "GET", "katalog-id");
  assert.equal(r.status, 403);
});

test("POS boleh membaca harga per channel", async () => {
  const r = await call("/api/product-prices", "GET", "pos-id");
  assert.equal(r.status, 200);
});

test("Katalog tidak boleh PUT harga; Pricing lolos guard", async () => {
  const denied = await call("/api/product-prices", "PUT", "katalog-id", {});
  assert.equal(denied.status, 403);
  const allowed = await call("/api/product-prices", "PUT", "pricing-id", {});
  assert.equal(allowed.status, 400); // body invalid, tetapi guard menu lolos
});

test("Katalog tidak boleh PATCH harga produk lama", async () => {
  const r = await call("/api/data/products?id=1", "PATCH", "katalog-id", { price: 2000 });
  assert.equal(r.status, 403);
});

test("Katalog tidak boleh mengirim kolom produk tak dikenal", async () => {
  const r = await call("/api/data/products", "POST", "katalog-id", { name: "X", kolom_baru: 1 });
  assert.equal(r.status, 403);
});

test("Matriks edit produk: modal, stok, dan harga ditegakkan backend", async () => {
  const cases = [
    ["owner-id", { modal: 100 }, 200],
    ["katalog-id", { modal: 100 }, 200],
    ["pembelian-id", { modal: 100 }, 200],
    ["pricing-id", { modal: 100 }, 403],
    ["persediaan-id", { modal: 100 }, 403],
    ["katalog-id", { stock: 10 }, 403],
    ["pembelian-id", { stock: 10 }, 200],
    ["persediaan-id", { stock: 10 }, 200],
    ["pricing-id", { stock: 10 }, 403],
    ["katalog-id", { price: 2000 }, 403],
    ["pembelian-id", { price: 2000 }, 403],
    ["persediaan-id", { price: 2000 }, 403],
    ["pricing-id", { price: 2000 }, 200],
  ];
  for (const [userId, body, expected] of cases) {
    const r = await call("/api/data/products?id=1", "PATCH", userId, body);
    assert.equal(r.status, expected, userId + " " + JSON.stringify(body));
  }
});

test("Katalog boleh DELETE produk; Pricing tidak", async () => {
  const denied = await call("/api/data/products?id=1", "DELETE", "pricing-id", {});
  assert.equal(denied.status, 403);
  const allowed = await call("/api/data/products?id=1", "DELETE", "katalog-id", {});
  assert.equal(allowed.status, 200);
});

test("Delete produk mengembalikan alasan referensi yang spesifik", async () => {
  fakeRefs.order_items = 2;
  fakeRefs.stock_mutations = 1;
  const r = await call("/api/data/products?id=1", "DELETE", "katalog-id", {});
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "product_in_use");
  assert.equal(r.data.can_detach_shopee_mapping, false);
  assert.deepEqual(
    r.data.references.map((x) => ({ table: x.table, count: x.count })),
    [{ table: "order_items", count: 2 }, { table: "stock_mutations", count: 1 }]
  );
  assert.match(r.data.message, /riwayat transaksi \(2\)/);
  fakeRefs.order_items = 0;
  fakeRefs.stock_mutations = 0;
});

test("Mapping Shopee dilepas hanya jika tidak ada referensi lain", async () => {
  fakeRefs.product_shopee_mapping = 2;
  const blocked = await call("/api/products/1/shopee-mapping", "DELETE", "pricing-id", {});
  assert.equal(blocked.status, 403);

  const mappingOnly = await call("/api/data/products?id=1", "DELETE", "katalog-id", {});
  assert.equal(mappingOnly.status, 409);
  assert.equal(mappingOnly.data.can_detach_shopee_mapping, true);

  const detached = await call("/api/products/1/shopee-mapping", "DELETE", "katalog-id", {});
  assert.equal(detached.status, 200);
  assert.equal(detached.data.data.removed_mappings, 2);
  assert.equal(captured.removedMappings, 2);

  const afterDetach = await call("/api/data/products?id=1", "DELETE", "katalog-id", {});
  assert.equal(afterDetach.status, 200);
});

test("Detach mapping ditolak jika masih ada riwayat transaksi", async () => {
  fakeRefs.product_shopee_mapping = 1;
  fakeRefs.order_items = 1;
  const r = await call("/api/products/1/shopee-mapping", "DELETE", "katalog-id", {});
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "product_in_use");
  assert.equal(r.data.references.length, 1);
  assert.equal(r.data.references[0].table, "order_items");
  fakeRefs.product_shopee_mapping = 0;
  fakeRefs.order_items = 0;
});

test("Gudang boleh membuka endpoint opname, Katalog tidak", async () => {
  const denied = await call("/api/gudang/opname", "POST", "katalog-id", { zone: "A" });
  assert.equal(denied.status, 403);
  const allowed = await call("/api/gudang/opname", "POST", "gudang-id", {});
  assert.equal(allowed.status, 400); // guard lolos, body invalid
});

test("Gudang menerima PO: stok, modal, item, status, dan mutasi konsisten", async () => {
  Object.keys(captured).forEach((k) => delete captured[k]);
  const denied = await call("/api/gudang/purchases/5/receive", "POST", "katalog-id", {
    items: [{ purchase_item_id: 11, qty: 3 }],
  });
  assert.equal(denied.status, 403);

  const r = await call("/api/gudang/purchases/5/receive", "POST", "gudang-id", {
    items: [{ purchase_item_id: 11, qty: 3 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.data.receiving_status, "Sebagian");
  assert.deepEqual(captured.productUpdate, [10, 500, 1]);
  assert.deepEqual(captured.itemUpdate, [3, 11]);
  assert.equal(captured.mutation[0], 1);
  assert.equal(captured.mutation[2], 3);
  assert.equal(captured.mutation[3], 7);
  assert.equal(captured.mutation[4], 10);
  assert.equal(captured.mutation[5], "Penerimaan PO PO-5");
  assert.deepEqual(captured.purchaseUpdate, ["Sebagian", "5"]);
  assert.deepEqual(captured.tx, ["BEGIN", "COMMIT"]);
});

test("Gudang penerimaan menolak qty melebihi sisa", async () => {
  const r = await call("/api/gudang/purchases/5/receive", "POST", "gudang-id", {
    items: [{ purchase_item_id: 11, qty: 11 }],
  });
  assert.equal(r.status, 409);
});

test("Gudang penerimaan menolak item duplikat", async () => {
  const r = await call("/api/gudang/purchases/5/receive", "POST", "gudang-id", {
    items: [
      { purchase_item_id: 11, qty: 1 },
      { purchase_item_id: 11, qty: 2 },
    ],
  });
  assert.equal(r.status, 400);
});

test("Gudang picking/packing memakai endpoint tervalidasi, bukan update orders bebas", async () => {
  Object.keys(captured).forEach((k) => delete captured[k]);
  const denied = await call("/api/orders/ORD-1", "PATCH", "katalog-id", { p_action: "pick" });
  assert.equal(denied.status, 403);
  const invalid = await call("/api/orders/ORD-1", "PATCH", "gudang-id", { p_action: "hapus" });
  assert.equal(invalid.status, 400);

  const picked = await call("/api/orders/ORD-1", "PATCH", "gudang-id", {
    p_action: "pick", p_petugas: "PALSU",
  });
  assert.equal(picked.status, 200);
  assert.equal(picked.data.data.wmsstatus, "Dipick");
  assert.equal(captured.warehouseRpc[0], "ORD-1");
  assert.equal(captured.warehouseRpc[1], "pick");
  assert.equal(captured.warehouseRpc[2], "Gudang Test");

  const packing = await call("/api/orders/ORD-1", "PATCH", "gudang-id", { p_action: "packing" });
  assert.equal(packing.status, 200);
  assert.deepEqual(captured.packing, ["ORD-1"]);
});

test("HR boleh rekap presensi, Penjualan tidak", async () => {
  const denied = await call("/api/attendance/rekap?year=2026&month=0", "GET", "penjualan-id");
  assert.equal(denied.status, 403);
  const allowed = await call("/api/attendance/rekap?year=2026&month=0", "GET", "hr-id");
  assert.equal(allowed.status, 200);
});

test("Marketplace: aksi tanpa menu ditolak sebelum memanggil Shopee", async () => {
  const r = await call("/api/shopee/pull-orders", "POST", "hr-id", {});
  assert.equal(r.status, 403);
});

test("Marketplace: aksi tak dikenal 404; connect non-owner 403", async () => {
  const unknown = await call("/api/shopee/aksi_tidak_ada", "POST", "owner-id", {});
  assert.equal(unknown.status, 404);
  const connect = await call("/api/shopee/connect", "POST", "katalog-id", {});
  assert.equal(connect.status, 403);
});

test("Karyawan non-owner tidak boleh membuat akun", async () => {
  const r = await call("/api/employees", "POST", "katalog-id", {
    action: "create", phone: "081000000099", full_name: "X", role: "staf",
    password: "123456", menus: ["pos"],
  });
  assert.equal(r.status, 403);
});

test("Retry mutasi stok hanya untuk Gudang/Persediaan/owner", async () => {
  const denied = await call("/api/stock-mutations/1/retry", "POST", "penjualan-id", {});
  assert.equal(denied.status, 403);
});
