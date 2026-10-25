// ============================================================
// PUSAT OTORISASI JUWITA ONE
// ============================================================
// Aturan: owner aktif = akses penuh. Karyawan aktif = seluruh aksi
// operasional pada menu yang dimiliki. Tanpa menu = ditolak.
// Tidak ada permission aksi terpisah di luar menu.
// ============================================================

export const MENU_TOKENS = Object.freeze([
  "pos",
  "penjualan",
  "katalog",
  "persediaan",
  "pembelian",
  "gudang",
  "pricing",
  "akuntansi",
  "hr",
  "pengaturan",
]);

export const MARKETPLACE_READ_MENUS = Object.freeze([
  "pengaturan",
  "penjualan",
  "katalog",
  "gudang",
  "persediaan",
  "pricing",
]);

export const PRODUCT_READ_MENUS = Object.freeze([
  "pos",
  "penjualan",
  "katalog",
  "persediaan",
  "pembelian",
  "gudang",
  "pricing",
]);

export const PRODUCT_PRICE_READ_MENUS = Object.freeze(["pos", "pricing"]);

// Kolom yang boleh dikirim saat membuat produk baru (Katalog).
export const PRODUCT_CREATE_COLUMNS = new Set([
  "id", "name", "category", "price", "modal", "stock",
  "minstock", "maxstock", "supplier", "imageicon", "barcode",
  "shopee_item_id", "shopee_sku", "sku", "plu",
]);

// Kolom yang boleh diubah setelah produk dibuat, beserta menu domainnya.
export const PRODUCT_UPDATE_COLUMN_MENUS = Object.freeze({
  name: ["katalog"],
  category: ["katalog"],
  supplier: ["katalog"],
  imageicon: ["katalog"],
  barcode: ["katalog"],
  shopee_item_id: ["katalog"],
  shopee_sku: ["katalog"],
  sku: ["katalog"],
  plu: ["katalog"],
  price: ["pricing"],
  modal: ["katalog", "pembelian"],
  stock: ["persediaan", "pembelian"],
  minstock: ["persediaan"],
  maxstock: ["persediaan"],
});

export const DATA_TABLE_ACCESS = Object.freeze({
  products: {
    read: PRODUCT_READ_MENUS,
    create: ["katalog"],
    update: ["katalog", "pricing", "persediaan", "pembelian"],
    delete: ["katalog"],
  },
  orders: {
    read: ["pos", "penjualan", "gudang"],
    create: null,
    update: null,
    delete: null,
  },
  order_items: {
    read: ["pos", "penjualan", "gudang"],
    create: null,
    update: null,
    delete: null,
  },
  karyawan: {
    read: ["hr", "pengaturan"],
    create: null,
    update: null,
    delete: null,
  },
  attendance_records: {
    read: ["hr"],
    create: ["hr"],
    update: ["hr"],
    delete: ["hr"],
  },
  attendance_clock: {
    read: ["hr"],
    create: null,
    update: null,
    delete: null,
  },
  work_schedules: {
    read: ["hr"],
    create: ["hr"],
    update: ["hr"],
    delete: ["hr"],
  },
  warehouse_receiving: {
    read: ["gudang"],
    create: null,
    update: null,
    delete: null,
  },
  warehouse_racks: {
    read: ["gudang"],
    create: ["gudang"],
    update: ["gudang"],
    delete: ["gudang"],
  },
  warehouse_opname: {
    read: ["gudang"],
    create: null,
    update: null,
    delete: null,
  },
  stock_mutations: {
    read: ["persediaan", "gudang", "katalog"],
    create: null,
    update: null,
    delete: null,
  },
  app_users: {
    read: ["hr", "pengaturan"],
    create: null,
    update: null,
    delete: null,
  },
  accounting_accounts: {
    read: ["akuntansi"],
    create: null,
    update: null,
    delete: null,
  },
  accounting_transactions: {
    read: ["akuntansi"],
    create: ["akuntansi"],
    update: ["akuntansi"],
    delete: ["akuntansi"],
  },
  v_account_balance: {
    read: ["akuntansi"],
    create: null,
    update: null,
    delete: null,
  },
  marketplace_config: {
    read: MARKETPLACE_READ_MENUS,
    create: null,
    update: null,
    delete: null,
  },
  activity_log: {
    read: MARKETPLACE_READ_MENUS,
    create: null,
    update: null,
    delete: null,
  },
  suppliers: {
    read: ["pembelian", "gudang"],
    create: ["pembelian"],
    update: ["pembelian"],
    delete: ["pembelian"],
  },
  purchases: {
    read: ["pembelian", "gudang"],
    create: ["pembelian"],
    update: ["pembelian"],
    delete: ["pembelian"],
  },
  purchase_items: {
    read: ["pembelian", "gudang"],
    create: ["pembelian"],
    update: ["pembelian"],
    delete: ["pembelian"],
  },
});

export const SHOPEE_ACTION_MENUS = Object.freeze({
  connect: null, // owner-only
  "pull-orders": ["penjualan"],
  "pull-products": ["katalog"],
  "stock-sync": ["gudang", "persediaan"],
  "price-sync": ["pricing"],
  publish: ["katalog"],
});

export const ALLOWED_EMPLOYEE_ROLES = Object.freeze([
  "kasir",
  "gudang",
  "hr",
  "keuangan",
  "kurir",
  "staf",
  "admin",
]);

export function isOwnerUser(user) {
  return !!user && String(user.role || "").toLowerCase() === "owner";
}

export function userHasMenu(user, menu) {
  return !!user && Array.isArray(user.menus) && user.menus.includes(menu);
}

export function userHasAnyMenu(user, menus) {
  if (!user || !Array.isArray(user.menus) || !Array.isArray(menus)) return false;
  return menus.some((m) => user.menus.includes(m));
}

export function checkTableAccess(user, table, op) {
  if (isOwnerUser(user)) return true;
  const rule = DATA_TABLE_ACCESS[table];
  if (!rule) return false; // default-deny
  const allowed = rule[op];
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return userHasAnyMenu(user, allowed);
}

export function productColumnMenus(column, op) {
  if (op === "create") {
    return PRODUCT_CREATE_COLUMNS.has(column) ? ["katalog"] : null;
  }
  if (op === "update") {
    return PRODUCT_UPDATE_COLUMN_MENUS[column] || null;
  }
  return null;
}

export function checkProductColumns(user, columns, op) {
  if (isOwnerUser(user)) return true;
  if (!Array.isArray(columns) || columns.length === 0) return false;
  for (const column of columns) {
    const menus = productColumnMenus(column, op);
    if (!menus || !userHasAnyMenu(user, menus)) return false;
  }
  return true;
}

export function shopeeActionAllowed(user, action) {
  if (isOwnerUser(user)) return true;
  const menus = SHOPEE_ACTION_MENUS[action];
  if (!Array.isArray(menus) || menus.length === 0) return false;
  return userHasAnyMenu(user, menus);
}

export function isAllowedEmployeeRole(role) {
  const normalized = String(role || "").toLowerCase();
  return normalized !== "owner" && ALLOWED_EMPLOYEE_ROLES.includes(normalized);
}

export function isAllowedMenuToken(token) {
  return MENU_TOKENS.includes(String(token));
}
