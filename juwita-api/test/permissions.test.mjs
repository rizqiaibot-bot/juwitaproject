import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkTableAccess,
  checkProductColumns,
  shopeeActionAllowed,
  isAllowedEmployeeRole,
  isAllowedMenuToken,
  isOwnerUser,
  DATA_TABLE_ACCESS,
} from "../src/permissions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function user(menus, role = "staf", status = "ACTIVE") {
  return { id: "u1", role, status, menus };
}

const owner = user([], "owner");
const katalog = user(["katalog"]);
const pricing = user(["pricing"]);
const gudang = user(["gudang"]);
const persediaan = user(["persediaan"]);
const pembelian = user(["pembelian"]);
const hr = user(["hr"]);
const pengaturan = user(["pengaturan"]);
const penjualan = user(["penjualan"]);
const pos = user(["pos"]);
const akuntansi = user(["akuntansi"]);
const noMenu = user([]);

test("owner memiliki akses penuh", () => {
  assert.equal(isOwnerUser(owner), true);
  for (const table of Object.keys(DATA_TABLE_ACCESS)) {
    for (const op of ["read", "create", "update", "delete"]) {
      assert.equal(checkTableAccess(owner, table, op), true, `${table}.${op}`);
    }
  }
  for (const action of ["connect", "pull-orders", "pull-products", "stock-sync", "price-sync", "publish", "unknown"]) {
    assert.equal(shopeeActionAllowed(owner, action), true, action);
  }
  assert.equal(checkProductColumns(owner, ["price", "stock", "unknown"], "update"), true);
});

test("tanpa menu ditolak (default-deny)", () => {
  for (const table of Object.keys(DATA_TABLE_ACCESS)) {
    for (const op of ["read", "create", "update", "delete"]) {
      assert.equal(checkTableAccess(noMenu, table, op), false, `${table}.${op}`);
    }
  }
  assert.equal(checkTableAccess(noMenu, "table_tidak_ada", "read"), false);
  assert.equal(checkProductColumns(noMenu, ["name"], "update"), false);
  assert.equal(shopeeActionAllowed(noMenu, "pull-orders"), false);
});

test("produk: Katalog boleh create termasuk harga awal; update master + modal, bukan harga/stok", () => {
  assert.equal(checkTableAccess(katalog, "products", "create"), true);
  assert.equal(checkTableAccess(katalog, "products", "update"), true);
  assert.equal(checkTableAccess(katalog, "products", "delete"), true);
  assert.equal(checkProductColumns(katalog, ["id", "name", "price", "stock", "modal"], "create"), true);
  assert.equal(checkProductColumns(katalog, ["name", "sku", "category", "barcode"], "update"), true);
  assert.equal(checkProductColumns(katalog, ["price"], "update"), false);
  assert.equal(checkProductColumns(katalog, ["modal"], "update"), true);
  assert.equal(checkProductColumns(katalog, ["stock"], "update"), false);
  assert.equal(checkProductColumns(katalog, ["price"], "create"), true);
  assert.equal(checkProductColumns(katalog, ["kolom_baru"], "update"), false);
  assert.equal(checkProductColumns(katalog, ["kolom_baru"], "create"), false);
});

test("produk: hanya Pricing yang boleh update harga; stock lewat domain stok", () => {
  assert.equal(checkTableAccess(pricing, "products", "update"), true);
  assert.equal(checkProductColumns(pricing, ["price"], "update"), true);
  assert.equal(checkProductColumns(pricing, ["stock"], "update"), false);
  assert.equal(checkProductColumns(pricing, ["modal"], "update"), false);

  assert.equal(checkProductColumns(persediaan, ["stock", "minstock", "maxstock"], "update"), true);
  assert.equal(checkProductColumns(persediaan, ["price"], "update"), false);
  assert.equal(checkProductColumns(pembelian, ["stock", "modal"], "update"), true);

  assert.equal(checkProductColumns(gudang, ["stock"], "update"), false);
  assert.equal(checkProductColumns(gudang, ["modal"], "update"), false);
  assert.equal(checkTableAccess(gudang, "products", "update"), false);
});

test("produk: matriks modal, stok, dan harga per menu", () => {
  assert.equal(checkProductColumns(owner, ["modal", "stock", "price"], "update"), true);

  assert.equal(checkProductColumns(katalog, ["modal"], "update"), true);
  assert.equal(checkProductColumns(katalog, ["stock"], "update"), false);
  assert.equal(checkProductColumns(katalog, ["price"], "update"), false);

  assert.equal(checkProductColumns(pembelian, ["modal"], "update"), true);
  assert.equal(checkProductColumns(pembelian, ["stock"], "update"), true);
  assert.equal(checkProductColumns(pembelian, ["price"], "update"), false);

  assert.equal(checkProductColumns(pricing, ["modal"], "update"), false);
  assert.equal(checkProductColumns(pricing, ["stock"], "update"), false);
  assert.equal(checkProductColumns(pricing, ["price"], "update"), true);

  assert.equal(checkProductColumns(persediaan, ["modal"], "update"), false);
  assert.equal(checkProductColumns(persediaan, ["stock"], "update"), true);
  assert.equal(checkProductColumns(persediaan, ["price"], "update"), false);
});

test("produk: delete hanya Katalog", () => {
  assert.equal(checkTableAccess(katalog, "products", "delete"), true);
  assert.equal(checkTableAccess(pricing, "products", "delete"), false);
  assert.equal(checkTableAccess(gudang, "products", "delete"), false);
  assert.equal(checkTableAccess(pembelian, "products", "delete"), false);
});

test("matriks tabel operasional per menu", () => {
  const allow = (user, table, op) => checkTableAccess(user, table, op);
  const deny = (user, table, op) => !checkTableAccess(user, table, op);

  assert.equal(allow(pos, "orders", "read"), true);
  assert.equal(deny(pos, "orders", "update"), true);
  assert.equal(allow(pos, "products", "read"), true);
  assert.equal(deny(pos, "products", "update"), true);

  assert.equal(allow(penjualan, "orders", "read"), true);
  assert.equal(allow(penjualan, "order_items", "read"), true);
  assert.equal(deny(penjualan, "products", "update"), true);
  assert.equal(deny(penjualan, "suppliers", "read"), true);

  assert.equal(allow(katalog, "products", "create"), true);
  assert.equal(allow(katalog, "products", "update"), true);
  assert.equal(allow(katalog, "products", "delete"), true);
  assert.equal(deny(katalog, "pricing", "read"), true);

  assert.equal(allow(persediaan, "products", "read"), true);
  assert.equal(allow(persediaan, "products", "update"), true);
  assert.equal(allow(persediaan, "stock_mutations", "read"), true);
  assert.equal(deny(persediaan, "products", "delete"), true);

  assert.equal(allow(pembelian, "suppliers", "create"), true);
  assert.equal(allow(pembelian, "purchases", "update"), true);
  assert.equal(allow(pembelian, "purchase_items", "delete"), true);
  assert.equal(deny(pembelian, "products", "delete"), true);

  assert.equal(allow(gudang, "warehouse_racks", "update"), true);
  assert.equal(allow(gudang, "purchases", "read"), true);
  assert.equal(deny(gudang, "purchases", "update"), true);
  assert.equal(deny(gudang, "orders", "update"), true);

  assert.equal(allow(pricing, "products", "read"), true);
  assert.equal(allow(pricing, "products", "update"), true);
  assert.equal(deny(pricing, "products", "delete"), true);
  assert.equal(deny(pricing, "stock_mutations", "read"), true);

  assert.equal(allow(akuntansi, "accounting_transactions", "create"), true);
  assert.equal(allow(akuntansi, "accounting_transactions", "delete"), true);
  assert.equal(deny(akuntansi, "accounting_accounts", "update"), true);

  assert.equal(allow(hr, "attendance_records", "create"), true);
  assert.equal(allow(hr, "work_schedules", "delete"), true);
  assert.equal(deny(hr, "app_users", "update"), true);

  assert.equal(allow(pengaturan, "app_users", "read"), true);
  assert.equal(deny(pengaturan, "app_users", "update"), true);
  assert.equal(allow(pengaturan, "marketplace_config", "read"), true);
  assert.equal(deny(pengaturan, "marketplace_config", "update"), true);
});

test("read produk/harga dibatasi menu pembaca", () => {
  assert.equal(checkTableAccess(pos, "products", "read"), true);
  assert.equal(checkTableAccess(penjualan, "products", "read"), true);
  assert.equal(checkTableAccess(katalog, "products", "read"), true);
  assert.equal(checkTableAccess(persediaan, "products", "read"), true);
  assert.equal(checkTableAccess(pembelian, "products", "read"), true);
  assert.equal(checkTableAccess(gudang, "products", "read"), true);
  assert.equal(checkTableAccess(pricing, "products", "read"), true);
  assert.equal(checkTableAccess(hr, "products", "read"), false);
  assert.equal(checkTableAccess(pengaturan, "products", "read"), false);
  assert.equal(checkTableAccess(akuntansi, "products", "read"), false);
});

test("gudang: baca PO, tulis PO generik ditolak, order generik ditolak", () => {
  assert.equal(checkTableAccess(gudang, "suppliers", "read"), true);
  assert.equal(checkTableAccess(gudang, "purchases", "read"), true);
  assert.equal(checkTableAccess(gudang, "purchase_items", "read"), true);
  assert.equal(checkTableAccess(gudang, "purchases", "update"), false);
  assert.equal(checkTableAccess(gudang, "purchase_items", "update"), false);
  assert.equal(checkTableAccess(gudang, "orders", "update"), false);
  assert.equal(checkTableAccess(gudang, "orders", "read"), true);
  assert.equal(checkTableAccess(gudang, "warehouse_racks", "create"), true);
  assert.equal(checkTableAccess(gudang, "warehouse_opname", "create"), false);
  assert.equal(checkTableAccess(gudang, "warehouse_receiving", "create"), false);
});

test("HR: presensi/jadwal, bukan akun/role", () => {
  assert.equal(checkTableAccess(hr, "attendance_records", "create"), true);
  assert.equal(checkTableAccess(hr, "attendance_records", "update"), true);
  assert.equal(checkTableAccess(hr, "work_schedules", "delete"), true);
  assert.equal(checkTableAccess(hr, "app_users", "read"), true);
  assert.equal(checkTableAccess(hr, "app_users", "update"), false);
  assert.equal(checkTableAccess(hr, "app_users", "delete"), false);
  assert.equal(checkTableAccess(hr, "products", "read"), false);
});

test("pengaturan hanya administratif owner; read config terbatas", () => {
  assert.equal(checkTableAccess(pengaturan, "app_users", "read"), true);
  assert.equal(checkTableAccess(pengaturan, "app_users", "update"), false);
  assert.equal(checkTableAccess(pengaturan, "marketplace_config", "read"), true);
  assert.equal(checkTableAccess(pengaturan, "marketplace_config", "update"), false);
  assert.equal(checkTableAccess(pengaturan, "products", "read"), false);
});

test("akuntansi: transaksi CRUD, akun read-only", () => {
  assert.equal(checkTableAccess(akuntansi, "accounting_transactions", "create"), true);
  assert.equal(checkTableAccess(akuntansi, "accounting_transactions", "update"), true);
  assert.equal(checkTableAccess(akuntansi, "accounting_transactions", "delete"), true);
  assert.equal(checkTableAccess(akuntansi, "accounting_accounts", "read"), true);
  assert.equal(checkTableAccess(akuntansi, "accounting_accounts", "update"), false);
});

test("mapping aksi marketplace per menu", () => {
  assert.equal(shopeeActionAllowed(owner, "connect"), true);
  assert.equal(shopeeActionAllowed(pengaturan, "connect"), false);
  assert.equal(shopeeActionAllowed(penjualan, "pull-orders"), true);
  assert.equal(shopeeActionAllowed(katalog, "pull-orders"), false);
  assert.equal(shopeeActionAllowed(katalog, "pull-products"), true);
  assert.equal(shopeeActionAllowed(katalog, "publish"), true);
  assert.equal(shopeeActionAllowed(gudang, "stock-sync"), true);
  assert.equal(shopeeActionAllowed(persediaan, "stock-sync"), true);
  assert.equal(shopeeActionAllowed(penjualan, "stock-sync"), false);
  assert.equal(shopeeActionAllowed(pricing, "price-sync"), true);
  assert.equal(shopeeActionAllowed(katalog, "price-sync"), false);
  assert.equal(shopeeActionAllowed(katalog, "unknown"), false);
});

test("validasi role/menu karyawan menolak owner dan token lama", () => {
  assert.equal(isAllowedEmployeeRole("kasir"), true);
  assert.equal(isAllowedEmployeeRole("gudang"), true);
  assert.equal(isAllowedEmployeeRole("owner"), false);
  assert.equal(isAllowedEmployeeRole("Owner"), false);
  assert.equal(isAllowedEmployeeRole("role_baru"), false);
  assert.equal(isAllowedMenuToken("pricing"), true);
  assert.equal(isAllowedMenuToken("akuntansi"), true);
  assert.equal(isAllowedMenuToken("pricing.edit"), false);
  assert.equal(isAllowedMenuToken("menu_baru"), false);
});

test("tidak ada sisa pricing.edit di kode frontend/backend", () => {
  const files = [
    path.join(repoRoot, "index.html"),
    path.join(repoRoot, "marketplace.html"),
    path.join(repoRoot, "juwita-api", "src", "server.js"),
    path.join(repoRoot, "juwita-api", "src", "permissions.js"),
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("pricing.edit"), false, file);
  }
});

test("product_prices bukan lagi penghalang delete produk", () => {
  const text = fs.readFileSync(path.join(repoRoot, "juwita-api", "src", "server.js"), "utf8");
  const start = text.indexOf("const PRODUCT_DELETE_REFERENCES");
  const end = text.indexOf("];", start);
  const block = text.slice(start, end);
  assert.equal(block.includes("product_prices"), false);
  assert.equal(block.includes("product_price_sync_queue"), false);
  assert.equal(block.includes("order_items"), true);
  assert.equal(block.includes("stock_mutations"), true);
  assert.equal(block.includes("product_shopee_mapping"), true);
});
