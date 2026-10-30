import http from "node:http";
import { pool } from "./db.js";
import { verifyPassword, hashPassword } from "./auth.js";
import { signAccessToken, verifyAccessToken } from "./jwt.js";
import { requireAuth } from "./middleware.js";
import {
  checkTableAccess,
  checkProductColumns,
  isOwnerUser,
  userHasAnyMenu,
  userHasMenu,
  shopeeActionAllowed,
  isAllowedEmployeeRole,
  isAllowedMenuToken,
  PRODUCT_READ_MENUS,
  PRODUCT_PRICE_READ_MENUS,
  SHOPEE_ACTION_MENUS,
} from "./permissions.js";
import { connectShop, pullOrders, pullProducts, syncStock, syncPrice, syncPriceOne, reconcileStock } from "./shopee.js";
import { nextOrderNumber, formatOrderId, lockOrderDay } from "./order-id.js";

const PORT = Number(process.env.PORT || 3000);

const PRODUCT_COLUMNS = [
  "id", "name", "category", "price", "modal", "stock",
  "minstock", "maxstock", "supplier", "imageicon", "barcode",
  "shopee_item_id", "shopee_sku", "sku", "plu",
].join(", ");

const PRODUCT_PRICE_CHANNELS = ["pos", "shopee:724153261", "shopee:1214362884"];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function parsePagination(url) {
  const u = new URL(url, "http://localhost");
  const rawLimit = Number(u.searchParams.get("limit"));
  const rawOffset = Number(u.searchParams.get("offset"));
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5000) : 50;
  const offset =
    Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  return { limit, offset };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

// --- Rate limit login sederhana (in-memory, per IP) ---
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function isLoginRateLimited(ip) {
  const now = Date.now();
  let arr = loginAttempts.get(ip) || [];
  arr = arr.filter((t) => now - t < LOGIN_WINDOW_MS);
  if (arr.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(ip, arr);
    return true;
  }
  arr.push(now);
  loginAttempts.set(ip, arr);
  return false;
}

// --- Rate limit absen sederhana (in-memory, per user) ---
// Normal: maks 2 absen/hari; 10/menit cukup longgar untuk retry kamera.
const ATTENDANCE_WINDOW_MS = 60 * 1000;
const ATTENDANCE_MAX_ATTEMPTS = 10;
const attendanceAttempts = new Map();

function isAttendanceRateLimited(userId) {
  const key = String(userId || "");
  if (!key) return true;
  const now = Date.now();
  let arr = attendanceAttempts.get(key) || [];
  arr = arr.filter((t) => now - t < ATTENDANCE_WINDOW_MS);
  if (arr.length >= ATTENDANCE_MAX_ATTEMPTS) {
    attendanceAttempts.set(key, arr);
    return true;
  }
  arr.push(now);
  attendanceAttempts.set(key, arr);
  return false;
}

// --- Baca body JSON dengan batas ukuran ---
function readJsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    let done = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!done) {
          done = true;
          resolve({ error: "too_large" });
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({ error: null, data: null });
      try {
        resolve({ error: null, data: JSON.parse(text) });
      } catch {
        resolve({ error: "invalid_json" });
      }
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        resolve({ error: "invalid_json" });
      }
    });
  });
}

// --- Profil user aman (tanpa hash/credential) ---
function safeUser(row) {
  const role = String(row.role || "").toLowerCase();
  const isOwner = role === "owner" && row.status === "ACTIVE";
  return {
    id: row.id,
    auth_user_id: row.auth_user_id,
    phone: row.phone,
    email: row.email,
    name: row.full_name,
    role: row.role,
    roleLabel: row.role_label || row.role,
    menus: Array.isArray(row.menus) ? row.menus : [],
    status: row.status,
    privileges: isOwner
      ? ["manage_users", "manage_permissions", "manage_settings"]
      : [],
  };
}

async function handleHealth(res) {
  try {
    const { rows } = await pool.query("SELECT now() AS now");
    sendJson(res, 200, { status: "ok", db: "up", time: rows[0].now });
  } catch (err) {
    console.error("health check failed:", err.message);
    sendJson(res, 500, { error: "internal_error" });
  }
}

async function handleProducts(req, res) {
  const { limit, offset } = parsePagination(req.url);
  try {
    const data = await pool.query(
      `SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const count = await pool.query(
      "SELECT count(*)::int AS total FROM products"
    );
    sendJson(res, 200, {
      data: data.rows,
      pagination: { limit, offset, total: count.rows[0].total },
    });
  } catch (err) {
    console.error("products query failed:", err.message);
    sendJson(res, 500, { error: "internal_error" });
  }
}

async function handleProductPrices(req, res) {
  const { limit, offset } = parsePagination(req.url);
  try {
    const data = await pool.query(
      "SELECT id, product_id, channel, price FROM product_prices ORDER BY id LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    const count = await pool.query(
      "SELECT count(*)::int AS total FROM product_prices"
    );
    sendJson(res, 200, {
      data: data.rows,
      pagination: { limit, offset, total: count.rows[0].total },
    });
  } catch (err) {
    console.error("product-prices query failed:", err.message);
    sendJson(res, 500, { error: "internal_error" });
  }
}

async function handleProductPricesPut(req, res) {
  const { error, data } = await readJsonBody(req, 256 * 1024);
  if (error === "too_large") {
    return sendJson(res, 413, { error: "payload_too_large" });
  }
  if (error || data == null) {
    return sendJson(res, 400, { error: "invalid_request" });
  }

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0 || rows.length > 10000) {
    return sendJson(res, 400, { error: "invalid_request" });
  }

  const seen = new Map();
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      return sendJson(res, 400, { error: "invalid_request" });
    }

    const rawId = r.product_id;
    const idStr =
      typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0
        ? String(rawId)
        : typeof rawId === "string" && /^[1-9]\d*$/.test(rawId.trim())
          ? rawId.trim()
          : null;
    if (idStr === null) {
      return sendJson(res, 400, { error: "invalid_product_id" });
    }

    const channel = r.channel;
    if (typeof channel !== "string" || !PRODUCT_PRICE_CHANNELS.includes(channel)) {
      return sendJson(res, 400, { error: "invalid_channel" });
    }

    const price = r.price;
    if (!Number.isInteger(price) || price < 0) {
      return sendJson(res, 400, { error: "invalid_price" });
    }

    seen.set(idStr + "|" + channel, { productId: idStr, channel, price });
  }

  const entries = [...seen.values()];
  try {
    const uniqueIds = [...new Set(entries.map((e) => e.productId))];
    const { rows: found } = await pool.query(
      "SELECT id FROM products WHERE id = ANY($1::bigint[])",
      [uniqueIds]
    );
    const foundIds = new Set(found.map((r) => String(r.id)));
    for (const id of uniqueIds) {
      if (!foundIds.has(id)) {
        return sendJson(res, 404, { error: "product_not_found" });
      }
    }

    await pool.query(
      `INSERT INTO product_prices (product_id, channel, price)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::numeric[])
       ON CONFLICT (product_id, channel)
       DO UPDATE SET price = EXCLUDED.price`,
      [
        entries.map((e) => e.productId),
        entries.map((e) => e.channel),
        entries.map((e) => e.price),
      ]
    );

    // Setelah tersimpan di VPS, langsung sinkronkan harga channel Shopee
    // (POS tidak dikirim ke Shopee). Gagal sync TIDAK membatalkan save.
    const syncResults = [];
    for (const e of entries) {
      if (e.channel === "pos") continue;
      try {
        const sr = await syncPriceOne(e.productId, e.channel);
        syncResults.push({ channel: e.channel, product_id: e.productId, ok: sr.ok, skipped: !!sr.skipped, error: sr.error || null });
      } catch (err) {
        syncResults.push({ channel: e.channel, product_id: e.productId, ok: false, error: (err && err.message) ? String(err.message).slice(0, 200) : "sync error" });
      }
    }

    return sendJson(res, 200, { ok: true, count: entries.length, sync: syncResults });
  } catch (err) {
    console.error("product-prices upsert failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

// --- Data API generik (whitelist tabel) ---
const DATA_TABLES = new Set([
  "products", "orders", "order_items", "karyawan",
  "warehouse_receiving", "warehouse_racks", "warehouse_opname",
  "stock_mutations", "attendance_records", "attendance_clock", "work_schedules",
  "app_users", "accounting_accounts", "accounting_transactions",
  "v_account_balance", "marketplace_config", "activity_log",
  "suppliers", "purchases", "purchase_items",
]);

// Kolom sensitif yang tidak boleh dibaca/ditulis via data API.
const FORBIDDEN_COLUMNS = new Set(["password_hash"]);

const TABLE_READ_COLUMNS = {
  app_users: "id, auth_user_id, phone, email, full_name, role, role_label, menus, status, created_at, updated_at",
};

// ============================================================
// OTORISASI DATA API (default-deny)
// Peta tabel/operasi/kolom ada di permissions.js. Owner = akses penuh.
// Non-owner dibatasi status ACTIVE (requireAuth) + menu + operasi + kolom.
// ============================================================
function checkMenuAccess(user, menu) {
  if (isOwnerUser(user)) return true;
  return userHasMenu(user, menu);
}

function tableName(pathname) {
  return pathname.replace(/^\/api\/data\//, "");
}

async function handleDataGet(req, res, table) {
  if (!DATA_TABLES.has(table)) return sendJson(res, 404, { error: "not_found" });
  const u = new URL(req.url, "http://localhost");
  const filters = [];
  const params = [];
  let idx = 1;
  for (const [k, v] of u.searchParams) {
    if (["order", "dir", "limit", "offset"].includes(k)) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) continue;
    filters.push(`${k} = $${idx++}`);
    params.push(v);
  }
  const orderCol = u.searchParams.get("order");
  const orderDir = (u.searchParams.get("dir") || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const { limit, offset } = parsePagination(req.url);
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const order = orderCol && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(orderCol)
    ? ` ORDER BY ${orderCol} ${orderDir}`
    : "";
  const readCols = TABLE_READ_COLUMNS[table] || "*";
  try {
    const { rows } = await pool.query(
      `SELECT ${readCols} FROM ${table}${where}${order} LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );
    sendJson(res, 200, { data: rows });
  } catch (err) {
    console.error(`data GET ${table} failed:`, err.message);
    sendJson(res, 500, { error: "internal_error" });
  }
}

// Tabel yang merujuk product_id. Produk yang masih dirujuk TIDAK boleh
// dihapus agar mapping Shopee, stok, harga, dan transaksi historis tetap utuh.
const PRODUCT_DELETE_REFERENCES = [
  ["order_items", "riwayat transaksi"],
  ["purchase_items", "data pembelian"],
  ["stock_mutations", "mutasi stok"],
  ["warehouse_receiving", "penerimaan gudang"],
  ["warehouse_racks", "data rak"],
  ["activity_log", "log marketplace"],
  ["product_shopee_mapping", "mapping Shopee"],
];

async function productDeleteReferences(client, productId) {
  const refs = [];
  for (const [table, label] of PRODUCT_DELETE_REFERENCES) {
    // Nama tanpa schema agar mengikuti search_path yang sama dengan DELETE.
    const { rows } = await client.query("SELECT to_regclass($1) AS t", [table]);
    if (!rows[0] || !rows[0].t) continue;
    const found = await client.query(
      `SELECT count(*)::int AS count FROM ${table} WHERE product_id = $1`,
      [productId]
    );
    const count = Number(found.rows[0] && found.rows[0].count) || 0;
    if (count > 0) refs.push({ table, label, count });
  }
  return refs;
}

function productDeleteBlockMessage(refs) {
  return refs.map((r) => `${r.label} (${r.count})`).join(", ");
}

async function deleteProductTransactional(req, res, u) {
  const id = u.searchParams.get("id");
  if (!/^[1-9]\d*$/.test(id || "")) {
    return sendJson(res, 400, { error: "invalid_product_id" });
  }
  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows: existing } = await client.query(
      "SELECT id FROM products WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (existing.length === 0) {
      await client.query("ROLLBACK");
      return sendJson(res, 404, { error: "product_not_found" });
    }
    const refs = await productDeleteReferences(client, id);
    if (refs.length > 0) {
      await client.query("ROLLBACK");
      const mappingOnly = refs.every((r) => r.table === "product_shopee_mapping");
      return sendJson(res, 409, {
        error: "product_in_use",
        message: "Produk tidak dapat dihapus karena masih terhubung dengan: " + productDeleteBlockMessage(refs) + ".",
        references: refs,
        can_detach_shopee_mapping: mappingOnly,
      });
    }
    const { rows: deleted } = await client.query(
      "DELETE FROM products WHERE id = $1 RETURNING *",
      [id]
    );
    await client.query("COMMIT");
    return sendJson(res, 200, { data: deleted });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    if (err.code === "23503") {
      return sendJson(res, 409, {
        error: "product_in_use",
        message: "Produk tidak dapat dihapus karena masih terhubung dengan data lain.",
        references: [],
        can_detach_shopee_mapping: false,
      });
    }
    console.error("data DELETE products failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  } finally {
    if (client) client.release();
  }
}

// Lepas mapping Shopee secara eksplisit (tanpa memanggil API Shopee).
// Hanya diizinkan jika SATU-SATUNYA referensi produk adalah mapping Shopee.
async function detachProductShopeeMapping(req, res, productId) {
  if (!/^[1-9]\d*$/.test(String(productId || ""))) {
    return sendJson(res, 400, { error: "invalid_product_id" });
  }
  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows: existing } = await client.query(
      "SELECT id, name FROM products WHERE id = $1 FOR UPDATE",
      [productId]
    );
    if (!existing.length) {
      await client.query("ROLLBACK");
      return sendJson(res, 404, { error: "product_not_found" });
    }

    const mappingTable = await client.query("SELECT to_regclass('product_shopee_mapping') AS t");
    if (!mappingTable.rows[0] || !mappingTable.rows[0].t) {
      await client.query("ROLLBACK");
      return sendJson(res, 404, { error: "shopee_mapping_not_found" });
    }

    const refs = await productDeleteReferences(client, productId);
    const blocking = refs.filter((r) => r.table !== "product_shopee_mapping");
    if (blocking.length > 0) {
      await client.query("ROLLBACK");
      return sendJson(res, 409, {
        error: "product_in_use",
        message: "Mapping Shopee tidak dilepas karena produk masih terhubung dengan: " + productDeleteBlockMessage(blocking) + ".",
        references: blocking,
      });
    }

    const mappingRows = refs.find((r) => r.table === "product_shopee_mapping");
    if (!mappingRows || mappingRows.count <= 0) {
      await client.query("ROLLBACK");
      return sendJson(res, 404, { error: "shopee_mapping_not_found" });
    }

    const deleted = await client.query(
      "DELETE FROM product_shopee_mapping WHERE product_id = $1",
      [productId]
    );
    // Ulangi validasi setelah mapping dihapus: jika ada referensi baru yang
    // masuk selama transaksi, rollback agar mapping tidak hilang.
    const afterDelete = await productDeleteReferences(client, productId);
    const newBlocking = afterDelete.filter((r) => r.table !== "product_shopee_mapping");
    if (newBlocking.length > 0) {
      await client.query("ROLLBACK");
      return sendJson(res, 409, {
        error: "product_in_use",
        message: "Mapping Shopee tidak dilepas karena produk masih terhubung dengan: " + productDeleteBlockMessage(newBlocking) + ".",
        references: newBlocking,
      });
    }
    // Bersihkan kolom legacy yang menyimpan listing Shopee di produk.
    await client.query(
      "UPDATE products SET shopee_item_id = NULL, shopee_sku = NULL WHERE id = $1",
      [productId]
    );
    await client.query("COMMIT");
    return sendJson(res, 200, {
      data: {
        ok: true,
        product_id: Number(productId),
        removed_mappings: Number(deleted.rowCount) || 0,
      },
    });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    console.error("detach product Shopee mapping failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  } finally {
    if (client) client.release();
  }
}

// Produk baru: pastikan channel POS punya baris harga eksplisit.
// Hanya memakai products.price yang diisi pengguna saat membuat produk.
// Channel Shopee TIDAK dibuat/diubah di sini.
async function ensureProductPosPriceWithClient(client, row) {
  const price = Number(row && row.price);
  if (!Number.isInteger(price) || price < 0) return;
  try {
    const { rows } = await client.query("SELECT to_regclass('product_prices') AS t");
    if (!rows[0] || !rows[0].t) return;
    await client.query(
      `INSERT INTO product_prices (product_id, channel, price)
       VALUES ($1, 'pos', $2)
       ON CONFLICT (product_id, channel) DO NOTHING`,
      [row.id, price]
    );
  } catch (err) {
    console.error("ensure product POS price failed:", err.message);
    throw err;
  }
}

async function ensureProductPosPrice(row) {
  try {
    return await ensureProductPosPriceWithClient(pool, row);
  } catch {
    // Perilaku lama: kegagalan harga POS tidak menggagalkan pemanggil non-transaksi.
    return undefined;
  }
}

// Catat mutation stok (pending) agar worker sync mengirim ke SEMUA mapping Shopee.
// TIDAK boleh ada jalur ubah products.stock yang melewati fungsi ini.
async function recordProductStockMutationWithClient(client, productId, productName, qtyBefore, qtyAfter, source) {
  if (qtyAfter === qtyBefore) return;
  const type = qtyAfter > qtyBefore ? "IN" : "OUT";
  const quantity = Math.abs(qtyAfter - qtyBefore);
  await client.query(
    `INSERT INTO stock_mutations (product_id, product_name, type, quantity, qty_before, qty_after, source, sync_status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',now())`,
    [productId, productName, type, quantity, qtyBefore, qtyAfter, source]
  );
}

async function recordProductStockMutation(productId, productName, qtyBefore, qtyAfter, source) {
  return recordProductStockMutationWithClient(pool, productId, productName, qtyBefore, qtyAfter, source);
}

async function handleDataWrite(req, res, table, method) {
  if (!DATA_TABLES.has(table)) return sendJson(res, 404, { error: "not_found" });
  const { error, data } = await readJsonBody(req, 2 * 1024 * 1024);
  if (error || data == null) return sendJson(res, 400, { error: "invalid_request" });

  if (method === "POST") {
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0) return sendJson(res, 400, { error: "invalid_request" });
    const cols = Object.keys(rows[0]);
    if (cols.length === 0) return sendJson(res, 400, { error: "invalid_request" });
    for (const c of cols) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) return sendJson(res, 400, { error: "invalid_column" });
      if (FORBIDDEN_COLUMNS.has(c)) return sendJson(res, 400, { error: "forbidden_column" });
    }
    if (table === "products" && !checkProductColumns(req.user, cols, "create")) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    if (table === "products" && rows.some((r) =>
      Object.prototype.hasOwnProperty.call(r, "stock") &&
      !(r.stock !== null && r.stock !== "" && Number.isFinite(Number(r.stock)) && Number(r.stock) >= 0)
    )) {
      return sendJson(res, 400, { error: "invalid_stock" });
    }
    if (table === "app_users" && rows.some((r) => String(r.role || "").toLowerCase() === "owner")) {
      return sendJson(res, 403, { error: "forbidden", message: "Role owner tidak dapat dibuat lewat API" });
    }
    const colList = cols.join(", ");
    const valueList = rows.map((r) => `(${cols.map((c, i) => `$${i + 1}`).join(", ")})`).join(", ");
    const flat = rows.flatMap((r) => cols.map((c) => {
      const v = r[c];
      return (typeof v === "object" && v !== null) ? JSON.stringify(v) : v;
    }));
    let client = null;
    try {
      let inserted;
      if (table === "products") {
        client = await pool.connect();
        await client.query("BEGIN");
        const result = await client.query(
          `INSERT INTO ${table} (${colList}) VALUES ${valueList} RETURNING *`,
          flat
        );
        inserted = result.rows;
        // Produk baru + harga POS + mutasi stok awal harus satu transaksi.
        for (const row of inserted) {
          await ensureProductPosPriceWithClient(client, row);
          const initialStock = Number(row.stock) || 0;
          if (initialStock > 0) {
            await recordProductStockMutationWithClient(
              client,
              row.id,
              row.name,
              0,
              initialStock,
              "Produk Baru"
            );
          }
        }
        await client.query("COMMIT");
      } else {
        const result = await pool.query(
          `INSERT INTO ${table} (${colList}) VALUES ${valueList} RETURNING *`,
          flat
        );
        inserted = result.rows;
      }
      sendJson(res, 200, { data: inserted });
    } catch (err) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch {}
      }
      console.error(`data POST ${table} failed:`, err.message);
      sendJson(res, 500, { error: "internal_error" });
    } finally {
      if (client) client.release();
    }
    return;
  }

  // PATCH / DELETE
  const u = new URL(req.url, "http://localhost");
  const filters = [];
  const params = [];
  let idx = 1;
  for (const [k, v] of u.searchParams) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) continue;
    filters.push(`${k} = $${idx++}`);
    params.push(v);
  }
  if (filters.length === 0) return sendJson(res, 400, { error: "missing_filter" });
  const where = ` WHERE ${filters.join(" AND ")}`;

  if (method === "DELETE") {
    if (table === "products") {
      return deleteProductTransactional(req, res, u);
    }
    if (table === "app_users") {
      try {
        const { rows: targets } = await pool.query(
          `SELECT id, role FROM app_users${where}`,
          params
        );
        if (targets.some((r) => String(r.role || "").toLowerCase() === "owner")) {
          return sendJson(res, 403, { error: "forbidden", message: "Akun owner tidak dapat dihapus" });
        }
      } catch (err) {
        console.error(`data DELETE app_users precheck failed:`, err.message);
        return sendJson(res, 500, { error: "internal_error" });
      }
    }
    // Transaksi akuntansi POS_SALE tidak boleh dihapus (read-only dari POS).
    if (table === "accounting_transactions") {
      try {
        const { rows: targets } = await pool.query(`SELECT id, type FROM accounting_transactions${where}`, params);
        if (targets.some((r) => r.type === "POS_SALE")) {
          return sendJson(res, 403, { error: "forbidden", message: "Transaksi POS tidak dapat dihapus" });
        }
      } catch (err) {
        console.error(`data DELETE accounting_transactions precheck failed:`, err.message);
        return sendJson(res, 500, { error: "internal_error" });
      }
    }
    try {
      const { rows: deleted } = await pool.query(
        `DELETE FROM ${table}${where} RETURNING *`,
        params
      );
      sendJson(res, 200, { data: deleted });
    } catch (err) {
      console.error(`data DELETE ${table} failed:`, err.message);
      sendJson(res, 500, { error: "internal_error" });
    }
    return;
  }

  // PATCH
  const updates = data;
  const cols = Object.keys(updates);
  if (cols.length === 0) return sendJson(res, 400, { error: "invalid_request" });
  for (const c of cols) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) return sendJson(res, 400, { error: "invalid_column" });
    if (FORBIDDEN_COLUMNS.has(c)) return sendJson(res, 400, { error: "forbidden_column" });
  }
  if (table === "products" && !checkProductColumns(req.user, cols, "update")) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  if (table === "products" && Object.prototype.hasOwnProperty.call(updates, "stock")) {
    const rawStock = updates.stock;
    if (!(rawStock !== null && rawStock !== "" && Number.isFinite(Number(rawStock)) && Number(rawStock) >= 0)) {
      return sendJson(res, 400, { error: "invalid_stock" });
    }
  }
  if (table === "app_users") {
    if (String(updates.role || "").toLowerCase() === "owner") {
      return sendJson(res, 403, { error: "forbidden", message: "Role owner tidak dapat diberikan lewat API" });
    }
    try {
      const { rows: targets } = await pool.query(
        `SELECT id, role FROM app_users${where}`,
        params
      );
      const touchesProtected = ["role", "menus", "status", "phone", "password_hash"]
        .some((c) => Object.prototype.hasOwnProperty.call(updates, c));
      if (touchesProtected && targets.some((r) => String(r.role || "").toLowerCase() === "owner")) {
        return sendJson(res, 403, { error: "forbidden", message: "Akun owner tidak dapat diubah melalui API generik" });
      }
    } catch (err) {
      console.error(`data PATCH app_users precheck failed:`, err.message);
      return sendJson(res, 500, { error: "internal_error" });
    }
  }
  const setList = cols.map((c, i) => `${c} = $${idx + i}`).join(", ");

  // Perubahan products.stock lewat data API wajib mencatat mutation (pending)
  // agar worker sync mengirim stok terbaru ke SEMUA mapping Shopee produk.
  // Update stok + insert mutation harus satu transaksi.
  const trackStock = table === "products" && cols.includes("stock");
  let client = null;

  try {
    let updated;
    if (trackStock) {
      client = await pool.connect();
      await client.query("BEGIN");
      const { rows: beforeRows } = await client.query(
        `SELECT id, name, stock FROM products${where} FOR UPDATE`,
        params
      );
      const beforeMap = {};
      for (const r of beforeRows) beforeMap[String(r.id)] = r;

      const result = await client.query(
        `UPDATE ${table} SET ${setList}${where} RETURNING *`,
        [...params, ...cols.map((c) => {
          const v = updates[c];
          return (typeof v === "object" && v !== null) ? JSON.stringify(v) : v;
        })]
      );
      updated = result.rows;

      for (const row of updated) {
        const before = beforeMap[String(row.id)];
        if (!before) continue;
        const qtyBefore = Number(before.stock);
        const qtyAfter = Number(row.stock);
        await recordProductStockMutationWithClient(
          client,
          row.id,
          row.name || before.name,
          qtyBefore,
          qtyAfter,
          "Perubahan Stok"
        );
      }
      await client.query("COMMIT");
    } else {
      const result = await pool.query(
        `UPDATE ${table} SET ${setList}${where} RETURNING *`,
        [...params, ...cols.map((c) => {
          const v = updates[c];
          return (typeof v === "object" && v !== null) ? JSON.stringify(v) : v;
        })]
      );
      updated = result.rows;
    }

    sendJson(res, 200, { data: updated });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    console.error(`data PATCH ${table} failed:`, err.message);
    sendJson(res, 500, { error: "internal_error" });
  } finally {
    if (client) client.release();
  }
}

// Konflik orders_pkey dari sync_offline_order (bukan konflik idempotency).
function isOrderIdConflict(result) {
  return !!result && result.status === "conflict" &&
    String(result.message || "").startsWith("orderid sudah ada");
}

// --- Checkout POS: panggil RPC lokal sync_offline_order ---
async function handleOrdersPost(req, res) {
  const { error, data } = await readJsonBody(req, 2 * 1024 * 1024);
  if (error || !data || typeof data !== "object") {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  // orderid dibuat di client (hitungan lokal) sehingga bisa bentrok dengan
  // kasir/device lain atau order Shopee. RPC menolak tanpa menyentuh stok,
  // lalu dikirim ulang dengan nomor baru + idempotency_key SAMA (retry aman:
  // bila transaksi ini ternyata sudah masuk → already_exists). Pembuatan
  // nomor diserialkan per tanggal (lock sama dengan import Shopee).
  const m = /^ORD-([0-9]{8})-[0-9]+$/.exec(String(data.p_orderid || ""));
  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    if (m) await lockOrderDay(client, m[1]);
    const callRpc = async (orderId) => {
      const { rows } = await client.query(
        `SELECT sync_offline_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) AS result`,
        [
          orderId, data.p_idempotency_key, data.p_date, data.p_channel,
          data.p_customer, data.p_total, data.p_paystatus, data.p_wmsstatus,
          data.p_courier, data.p_resi, data.p_payment_method, data.p_subtotal,
          data.p_diskon, data.p_bayar, data.p_kembalian, JSON.stringify(data.p_items),
        ]
      );
      return rows[0].result;
    };
    let result = await callRpc(data.p_orderid);
    let n = 0;
    for (let attempt = 0; m && attempt < 10 && isOrderIdConflict(result); attempt++) {
      n = Math.max(await nextOrderNumber(client, m[1]), n + 1);
      result = await callRpc(formatOrderId(m[1], n));
    }
    await client.query("COMMIT");
    sendJson(res, 200, { data: result });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("orders POST failed:", err.message);
    sendJson(res, 500, { error: "internal_error" });
  } finally {
    if (client) client.release();
  }
}

// --- Aksi gudang: endpoint tervalidasi (bukan update tabel orders bebas) ---
const WAREHOUSE_ORDER_ACTIONS = new Set(["pick", "pack", "packing", "ship"]);

async function handleOrdersPatch(req, res, orderId) {
  const { error, data } = await readJsonBody(req, 64 * 1024);
  if (error || !data || typeof data !== "object") {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  const action = typeof data.p_action === "string" ? data.p_action : "";
  if (!WAREHOUSE_ORDER_ACTIONS.has(action)) {
    return sendJson(res, 400, { error: "invalid_action" });
  }
  const petugas = req.user && req.user.name ? String(req.user.name) : "?";
  try {
    if (action === "packing") {
      const { rows } = await pool.query(
        `UPDATE orders SET wmsstatus = 'Packing'
          WHERE orderid = $1 AND wmsstatus IN ('Dipick', 'Packing')
        RETURNING orderid, wmsstatus`,
        [orderId]
      );
      if (!rows.length) {
        return sendJson(res, 409, { error: "order_not_in_pickable_status" });
      }
      return sendJson(res, 200, {
        data: { status: "ok", orderid: rows[0].orderid, wmsstatus: rows[0].wmsstatus },
      });
    }
    const { rows } = await pool.query(
      `SELECT record_warehouse_action($1,$2,$3,$4,$5) AS result`,
      [orderId, action, petugas, data.p_courier || null, data.p_resi || null]
    );
    return sendJson(res, 200, { data: rows[0].result });
  } catch (err) {
    console.error("orders PATCH failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

// --- Penerimaan PO (Gudang): transaksi tervalidasi + mutasi stok ---
async function handleGudangReceive(req, res, purchaseId) {
  if (!/^[1-9]\d*$/.test(String(purchaseId || ""))) {
    return sendJson(res, 400, { error: "invalid_purchase_id" });
  }
  const { error, data } = await readJsonBody(req, 256 * 1024);
  if (error || !data || typeof data !== "object" || !Array.isArray(data.items)) {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  const requested = new Map();
  for (const item of data.items) {
    if (!item || typeof item !== "object") {
      return sendJson(res, 400, { error: "invalid_request" });
    }
    const itemId = String(item.purchase_item_id || "");
    const qty = Number(item.qty);
    if (!/^[1-9]\d*$/.test(itemId) || !Number.isInteger(qty) || qty <= 0) {
      return sendJson(res, 400, { error: "invalid_item" });
    }
    if (requested.has(itemId)) {
      return sendJson(res, 400, { error: "duplicate_item" });
    }
    requested.set(itemId, qty);
  }
  if (requested.size === 0) {
    return sendJson(res, 400, { error: "invalid_request" });
  }

  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const purchaseRes = await client.query(
      `SELECT id, po_number, receiving_status FROM purchases WHERE id = $1 FOR UPDATE`,
      [purchaseId]
    );
    if (!purchaseRes.rows.length) {
      await client.query("ROLLBACK");
      return sendJson(res, 404, { error: "purchase_not_found" });
    }
    const purchase = purchaseRes.rows[0];

    const itemsRes = await client.query(
      `SELECT id, product_id, product_name, qty, qty_received, harga_beli
         FROM purchase_items WHERE purchase_id = $1 ORDER BY id FOR UPDATE`,
      [purchaseId]
    );
    if (!itemsRes.rows.length) {
      await client.query("ROLLBACK");
      return sendJson(res, 400, { error: "purchase_has_no_items" });
    }
    const itemsById = new Map(itemsRes.rows.map((row) => [String(row.id), row]));

    const received = [];
    for (const [itemId, qty] of requested) {
      const item = itemsById.get(itemId);
      if (!item) {
        await client.query("ROLLBACK");
        return sendJson(res, 400, { error: "purchase_item_mismatch", purchase_item_id: itemId });
      }
      const remaining = Number(item.qty) - Number(item.qty_received);
      if (qty > remaining) {
        await client.query("ROLLBACK");
        return sendJson(res, 409, {
          error: "qty_exceeds_remaining",
          purchase_item_id: itemId,
          remaining,
        });
      }

      const productRes = await client.query(
        `SELECT id, name, stock FROM products WHERE id = $1 FOR UPDATE`,
        [item.product_id]
      );
      if (!productRes.rows.length) {
        await client.query("ROLLBACK");
        return sendJson(res, 404, { error: "product_not_found", product_id: item.product_id });
      }
      const product = productRes.rows[0];
      const qtyBefore = Number(product.stock) || 0;
      const qtyAfter = qtyBefore + qty;
      const modal = Number(item.harga_beli);
      const safeModal = Number.isFinite(modal) && modal >= 0 ? modal : 0;

      await client.query(
        `UPDATE products SET stock = $1, modal = $2 WHERE id = $3`,
        [qtyAfter, safeModal, product.id]
      );
      await client.query(
        `UPDATE purchase_items SET qty_received = qty_received + $1 WHERE id = $2`,
        [qty, item.id]
      );
      await client.query(
        `INSERT INTO stock_mutations (
           product_id, product_name, type, quantity,
           qty_before, qty_after, source, sync_status, created_at
         ) VALUES ($1,$2,'IN',$3,$4,$5,$6,'pending',now())`,
        [
          product.id,
          product.name || item.product_name || null,
          qty,
          qtyBefore,
          qtyAfter,
          "Penerimaan PO " + (purchase.po_number || purchaseId),
        ]
      );
      received.push({
        purchase_item_id: item.id,
        product_id: product.id,
        qty,
        qty_before: qtyBefore,
        qty_after: qtyAfter,
      });
    }

    const receivedMap = new Map(received.map((r) => [String(r.purchase_item_id), r.qty]));
    const allReceived = itemsRes.rows.every((item) => {
      const added = receivedMap.get(String(item.id)) || 0;
      return Number(item.qty_received) + added >= Number(item.qty);
    });
    const someReceived = itemsRes.rows.some((item) => {
      const added = receivedMap.get(String(item.id)) || 0;
      return Number(item.qty_received) + added > 0;
    });
    const receivingStatus = allReceived ? "Diterima" : someReceived ? "Sebagian" : "Belum";

    await client.query(
      `UPDATE purchases SET receiving_status = $1 WHERE id = $2`,
      [receivingStatus, purchaseId]
    );
    await client.query("COMMIT");
    return sendJson(res, 200, {
      data: { ok: true, purchase_id: Number(purchaseId), receiving_status: receivingStatus, received },
    });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    console.error("gudang receive failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  } finally {
    if (client) client.release();
  }
}

// --- Mulai opname (Gudang): endpoint tervalidasi ---
async function handleGudangOpnameStart(req, res) {
  const { error, data } = await readJsonBody(req, 16 * 1024);
  if (error || !data || typeof data !== "object") {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  const zone = typeof data.zone === "string" ? data.zone.trim() : "";
  if (!zone || zone.length > 120) {
    return sendJson(res, 400, { error: "invalid_zone" });
  }
  const officer = req.user && req.user.name ? String(req.user.name) : "?";
  const id = "OPN-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  try {
    const { rows } = await pool.query(
      `INSERT INTO warehouse_opname (id, zone, officer, status)
       VALUES ($1,$2,$3,'open')
       RETURNING id, zone, officer, session_date, status, created_at`,
      [id, zone, officer]
    );
    return sendJson(res, 200, { data: rows[0] });
  } catch (err) {
    console.error("gudang opname start failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

function normalizeAuditText(value) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Penyesuaian stok pusat (Persediaan/Pembelian/owner) ---
// Satu transaksi: update products.stock + tepat satu stock_mutations.
const MAX_STOCK_ADJUSTMENT = 1000000000000; // 1e12, batas aman API
const MAX_STOCK_DECIMALS = 6;

async function handleStockAdjustment(req, res) {
  const { error, data } = await readJsonBody(req, 64 * 1024);
  if (error || !data || typeof data !== "object") {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  const productId = String(data.product_id || "");
  const direction = String(data.direction || "").toLowerCase();
  const reason = normalizeAuditText(data.reason);
  let quantityText = "";
  if (typeof data.quantity === "number") {
    quantityText = Number.isFinite(data.quantity) ? String(data.quantity) : "";
  } else if (typeof data.quantity === "string") {
    quantityText = data.quantity.trim();
  }
  const quantityRegex = new RegExp("^\\d+(?:\\.\\d{1," + MAX_STOCK_DECIMALS + "})?$");
  const quantity = Number(quantityText);
  if (!/^[1-9]\d*$/.test(productId)) {
    return sendJson(res, 400, { error: "invalid_product_id" });
  }
  if (direction !== "in" && direction !== "out") {
    return sendJson(res, 400, { error: "invalid_direction" });
  }
  if (!quantityRegex.test(quantityText) ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity > MAX_STOCK_ADJUSTMENT) {
    return sendJson(res, 400, { error: "invalid_quantity" });
  }
  if (!reason || reason.length > 500) {
    return sendJson(res, 400, { error: "invalid_reason" });
  }

  const actor = normalizeAuditText(req.user && req.user.name) || "?";
  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, name, stock::text AS stock,
              CASE WHEN $2 = 'in'
                   THEN (stock + $3::numeric)::text
                   ELSE (stock - $3::numeric)::text
              END AS stock_after,
              CASE WHEN $2 = 'out' AND stock - $3::numeric < 0
                   THEN true ELSE false
              END AS negative
         FROM products WHERE id = $1 FOR UPDATE`,
      [productId, direction, quantityText]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return sendJson(res, 404, { error: "product_not_found" });
    }
    const product = rows[0];
    if (product.stock === null || product.stock === undefined || product.stock_after === null) {
      await client.query("ROLLBACK");
      return sendJson(res, 409, { error: "invalid_stock_state" });
    }
    const stockBefore = Number(product.stock);
    const stockAfter = Number(product.stock_after);
    if (!Number.isFinite(stockBefore) || !Number.isFinite(stockAfter)) {
      await client.query("ROLLBACK");
      return sendJson(res, 409, { error: "invalid_stock_state" });
    }
    if (product.negative === true || stockAfter < 0) {
      await client.query("ROLLBACK");
      return sendJson(res, 409, {
        error: "insufficient_stock",
        message: "Stok tidak boleh negatif.",
        stock_before: stockBefore,
        quantity,
      });
    }

    await client.query(
      "UPDATE products SET stock = $1::numeric WHERE id = $2",
      [product.stock_after, product.id]
    );
    const source = "Penyesuaian Stok (" + (direction === "in" ? "IN" : "OUT") + ") - " + reason + " - oleh " + actor;
    const { rows: inserted } = await client.query(
      `INSERT INTO stock_mutations (
         product_id, product_name, type, quantity,
         qty_before, qty_after, source, sync_status, created_at
       ) VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7,'pending',now())
       RETURNING id`,
      [
        product.id,
        product.name || null,
        direction === "in" ? "IN" : "OUT",
        quantityText,
        product.stock,
        product.stock_after,
        source,
      ]
    );
    await client.query("COMMIT");
    return sendJson(res, 200, {
      data: {
        ok: true,
        product_id: product.id,
        product_name: product.name || null,
        direction,
        quantity,
        stock_before: stockBefore,
        stock_after: stockAfter,
        mutation_id: inserted[0] ? inserted[0].id : null,
        source,
      },
    });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    console.error("stock adjustment failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  } finally {
    if (client) client.release();
  }
}

// --- Retry mutasi stok gagal (Gudang/Persediaan) ---
async function handleStockMutationRetry(req, res, mutationId) {
  if (!/^[1-9]\d*$/.test(String(mutationId || ""))) {
    return sendJson(res, 400, { error: "invalid_mutation_id" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE stock_mutations
          SET sync_status = 'pending', shopee_sync_at = NULL
        WHERE id = $1 AND sync_status = 'failed'
        RETURNING id, product_id, sync_status`,
      [mutationId]
    );
    if (!rows.length) {
      return sendJson(res, 404, { error: "mutation_not_found_or_not_failed" });
    }
    return sendJson(res, 200, { data: rows[0] });
  } catch (err) {
    console.error("stock mutation retry failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

// --- Employee admin (owner): buat user + reset password (password_hash lokal) ---
async function handleEmployeesPost(req, res) {
  const { error, data } = await readJsonBody(req, 64 * 1024);
  if (error || !data || typeof data !== "object") {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  const action = data.action;
  try {
    if (action === "create") {
      const phone = nonEmptyString(data.phone) ? data.phone : "";
      const fullName = nonEmptyString(data.full_name) ? data.full_name : "";
      const role = nonEmptyString(data.role) ? data.role : "";
      const password = nonEmptyString(data.password) ? data.password : "";
      if (!phone || !fullName || !role || password.length < 6) {
        return sendJson(res, 400, { error: "invalid_request" });
      }
      if (!isAllowedEmployeeRole(role)) {
        return sendJson(res, 400, { error: "invalid_role" });
      }
      if (!Array.isArray(data.menus) || data.menus.length === 0) {
        return sendJson(res, 400, { error: "invalid_menus" });
      }
      const uniqueMenus = [...new Set(data.menus.map((m) => String(m)))];
      if (uniqueMenus.some((m) => !isAllowedMenuToken(m))) {
        return sendJson(res, 400, { error: "invalid_menus" });
      }
      const exists = await pool.query("SELECT id FROM app_users WHERE phone = $1", [phone]);
      if (exists.rows.length) return sendJson(res, 409, { error: "phone_exists" });
      const hash = await hashPassword(password);
      const menus = JSON.stringify(uniqueMenus);
      const { rows } = await pool.query(
        `INSERT INTO app_users (phone, full_name, role, role_label, menus, status, password_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, phone, full_name, role, role_label, menus, status`,
        [phone, fullName, role, data.role_label || role, menus, data.status || "ACTIVE", hash]
      );
      return sendJson(res, 200, { data: rows[0] });
    }
    if (action === "reset_password") {
      const id = data.id || data.auth_user_id;
      const password = nonEmptyString(data.password) ? data.password : "";
      if (!id || password.length < 6) return sendJson(res, 400, { error: "invalid_request" });
      const hash = await hashPassword(password);
      const { rows } = await pool.query(
        "UPDATE app_users SET password_hash = $1 WHERE id = $2 OR (auth_user_id IS NOT NULL AND auth_user_id = $2) RETURNING id",
        [hash, id]
      );
      if (!rows.length) return sendJson(res, 404, { error: "user_not_found" });
      return sendJson(res, 200, { data: { status: "ok" } });
    }
    return sendJson(res, 400, { error: "unknown_action" });
  } catch (err) {
    console.error("employees POST failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

// --- Kehadiran (absen kamera) ---
// Identitas diambil dari req.user (JWT → app_users), waktu dari server
// (NOW() AT TIME ZONE 'Asia/Jakarta'). Foto = data URL (base64) selfie
// langsung dari kamera. Cegah absen ganda via UNIQUE(employee_id, work_date).
const ATTENDANCE_PHOTO_MAX = 2 * 1024 * 1024; // batas panjang string data URL

// Validasi KETAT: seluruh string wajib data URL gambar + base64 murni.
// Menolak payload yang menyelipkan kutip/< > (vektor stored XSS).
const SELFIE_DATA_URL_RE = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function isSelfieDataUrl(v) {
  return typeof v === "string" && SELFIE_DATA_URL_RE.test(v);
}

// Normalisasi foto absen:
//   null / undefined  → { ok:true, photo:null }  (alur "Lanjutkan Tanpa Foto")
//   data URL valid    → { ok:true, photo:<string> }
//   selain itu        → { ok:false } (invalid) / { ok:false, tooLarge:true }
// TIDAK membuat foto palsu; foto kosong tetap null.
function normalizeAttendancePhoto(raw) {
  if (raw === null || raw === undefined) return { ok: true, photo: null };
  if (typeof raw !== "string" || !SELFIE_DATA_URL_RE.test(raw)) return { ok: false };
  if (raw.length > ATTENDANCE_PHOTO_MAX) return { ok: false, tooLarge: true };
  return { ok: true, photo: raw };
}

async function handleAttendanceCheck(req, res, kind) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return sendJson(res, 415, { error: "unsupported_media_type" });
  }
  if (isAttendanceRateLimited(req.user && req.user.id)) {
    return sendJson(res, 429, { error: "too_many_attempts" });
  }
  try {
    const { error, data } = await readJsonBody(req, 3 * 1024 * 1024);
    if (error === "too_large") return sendJson(res, 413, { error: "photo_too_large" });
    if (error || !data || typeof data !== "object") return sendJson(res, 400, { error: "invalid_request" });

    // Foto boleh null (alur tanpa foto) atau data URL selfie valid.
    const norm = normalizeAttendancePhoto(data.photo);
    if (!norm.ok) {
      return sendJson(res, norm.tooLarge ? 413 : 400,
        { error: norm.tooLarge ? "photo_too_large" : "invalid_photo" });
    }
    const photo = norm.photo; // null = tanpa foto

    const userId = req.user.id;
    const name = req.user.name || req.user.phone || "?";

    const { rows } = await pool.query(
      `SELECT id, check_in_at, check_out_at,
              work_date::text AS work_date
         FROM public.attendance_clock
        WHERE employee_id = $1
          AND work_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
        LIMIT 1`,
      [userId]
    );
    let row = rows[0];

    if (kind === "in") {
      if (row && row.check_in_at) return sendJson(res, 409, { error: "already_checked_in" });
      if (row) {
        const upd = await pool.query(
          `UPDATE public.attendance_clock
              SET check_in_at = NOW(), check_in_photo = $2, updated_at = NOW()
            WHERE id = $1 AND check_in_at IS NULL
            RETURNING id, work_date::text AS work_date, check_in_at, check_out_at`,
          [row.id, photo]
        );
        if (!upd.rows.length) return sendJson(res, 409, { error: "already_checked_in" });
        return sendJson(res, 200, { data: upd.rows[0] });
      }
      const ins = await pool.query(
        `INSERT INTO public.attendance_clock
           (employee_id, employee_name, work_date, check_in_at, check_in_photo)
         VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Jakarta')::date, NOW(), $3)
         ON CONFLICT (employee_id, work_date) DO NOTHING
         RETURNING id, work_date::text AS work_date, check_in_at, check_out_at`,
        [userId, name, photo]
      );
      if (!ins.rows.length) return sendJson(res, 409, { error: "already_checked_in" });
      return sendJson(res, 200, { data: ins.rows[0] });
    }

    // kind === "out"
    if (!row || !row.check_in_at) return sendJson(res, 409, { error: "not_checked_in" });
    if (row.check_out_at) return sendJson(res, 409, { error: "already_checked_out" });
    const upd = await pool.query(
      `UPDATE public.attendance_clock
          SET check_out_at = NOW(), check_out_photo = $2, updated_at = NOW()
        WHERE id = $1 AND check_out_at IS NULL
        RETURNING id, work_date::text AS work_date, check_in_at, check_out_at`,
      [row.id, photo]
    );
    if (!upd.rows.length) return sendJson(res, 409, { error: "already_checked_out" });
    return sendJson(res, 200, { data: upd.rows[0] });
  } catch (err) {
    console.error("attendance check failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

async function handleAttendanceMe(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT id, work_date::text AS work_date, check_in_at, check_out_at
         FROM public.attendance_clock
        WHERE employee_id = $1
          AND work_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
        LIMIT 1`,
      [req.user.id]
    );
    return sendJson(res, 200, { data: rows[0] || null });
  } catch (err) {
    console.error("attendance me failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

// Rekap presensi bulanan (HR/owner): TANPA foto (ringan untuk tabel rekap).
// month = 0-11 (mengikuti indeks bulan di frontend).
async function handleAttendanceRekap(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const year = Number(u.searchParams.get("year"));
    const month = Number(u.searchParams.get("month"));
    if (!Number.isInteger(year) || year < 2000 || year > 2100 ||
        !Number.isInteger(month) || month < 0 || month > 11) {
      return sendJson(res, 400, { error: "invalid_period" });
    }
    const { rows } = await pool.query(
      `SELECT employee_id, employee_name,
              work_date::text AS work_date,
              check_in_at, check_out_at,
              (check_in_photo IS NOT NULL)  AS has_check_in_photo,
              (check_out_photo IS NOT NULL) AS has_check_out_photo,
              check_in_photo, check_out_photo
         FROM public.attendance_clock
        WHERE work_date >= make_date($1, $2, 1)
          AND work_date <  (make_date($1, $2, 1) + INTERVAL '1 month')
        ORDER BY work_date ASC, check_in_at ASC`,
      [year, month + 1]
    );
    return sendJson(res, 200, { data: rows });
  } catch (err) {
    console.error("attendance rekap failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

// --- Shopee (pengganti Edge Function) ---
async function handleShopeeAction(req, res, action) {
  if (!Object.prototype.hasOwnProperty.call(SHOPEE_ACTION_MENUS, action)) {
    return sendJson(res, 404, { error: "unknown_action" });
  }
  if (!shopeeActionAllowed(req.user, action)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  const { data } = await readJsonBody(req, 64 * 1024);
  const shopId = data && data.shop_id ? String(data.shop_id) : "";
  try {
    if (action === "connect") {
      const r = await connectShop(shopId);
      return sendJson(res, r.ok ? 200 : 400, { data: r });
    }
    if (action === "pull-orders") {
      const r = await pullOrders(shopId);
      return sendJson(res, 200, { data: r });
    }
    if (action === "pull-products") {
      const r = await pullProducts(shopId);
      return sendJson(res, 200, { data: r });
    }
    if (action === "stock-sync") {
      const r = await syncStock(shopId);
      return sendJson(res, 200, { data: r });
    }
    if (action === "reconcile-stock") {
      const cursor = data && data.cursor != null ? data.cursor : null;
      const r = await reconcileStock(shopId, { cursor });
      return sendJson(res, 200, { data: r });
    }
    if (action === "price-sync") {
      const r = await syncPrice(shopId);
      return sendJson(res, 200, { data: r });
    }
    if (action === "publish") {
      return sendJson(res, 200, { data: { ok: false, error: "publish produk Shopee belum tersedia via API lokal (perlu kredensial + atribut produk)" } });
    }
    return sendJson(res, 404, { error: "unknown_action" });
  } catch (err) {
    console.error(`shopee ${action} failed:`, err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

async function handleRpc(req, res, name) {
  try {
    if (name === "close_opname") {
      if (!checkMenuAccess(req.user, "gudang")) return sendJson(res, 403, { error: "forbidden" });
      const { data } = await readJsonBody(req, 64 * 1024);
      const opnameId = data && data.p_opname_id ? String(data.p_opname_id) : "";
      const { rows } = await pool.query("SELECT close_opname($1) AS result", [opnameId]);
      return sendJson(res, 200, { data: rows[0].result });
    }
    if (name === "accounting_sync_pos") {
      if (!checkMenuAccess(req.user, "akuntansi")) return sendJson(res, 403, { error: "forbidden" });
      const { rows } = await pool.query("SELECT accounting_sync_pos() AS result");
      return sendJson(res, 200, { data: rows[0].result });
    }
    return sendJson(res, 404, { error: "rpc_not_found" });
  } catch (err) {
    console.error(`rpc ${name} failed:`, err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

async function handleLogin(req, res) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return sendJson(res, 415, { error: "unsupported_media_type" });
  }
  if (isLoginRateLimited(getClientIp(req))) {
    return sendJson(res, 429, { error: "too_many_attempts" });
  }

  const { error, data } = await readJsonBody(req, 4096);
  if (error === "too_large") {
    return sendJson(res, 413, { error: "payload_too_large" });
  }
  if (error || !data || typeof data !== "object") {
    return sendJson(res, 400, { error: "invalid_request" });
  }

  const phone = data.phone;
  const password = data.password;
  if (!nonEmptyString(phone) || !nonEmptyString(password)) {
    return sendJson(res, 401, { error: "invalid_credentials" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, auth_user_id, phone, email, full_name, role, role_label, menus, status, password_hash FROM app_users WHERE phone = $1 LIMIT 1",
      [phone]
    );
    const row = rows[0];
    if (!row) return sendJson(res, 401, { error: "invalid_credentials" });
    if (row.status !== "ACTIVE") {
      return sendJson(res, 401, { error: "invalid_credentials" });
    }
    if (!nonEmptyString(row.password_hash)) {
      return sendJson(res, 401, { error: "invalid_credentials" });
    }
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) return sendJson(res, 401, { error: "invalid_credentials" });

    const token = signAccessToken({
      id: row.id,
      role: row.role,
      status: row.status,
    });
    return sendJson(res, 200, { token, user: safeUser(row) });
  } catch (err) {
    console.error("login failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

async function handleMe(req, res) {
  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("Bearer ")) {
    return sendJson(res, 401, { error: "unauthorized" });
  }
  const token = auth.slice("Bearer ".length).trim();
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    payload = null;
  }
  if (!payload) {
    return sendJson(res, 401, { error: "invalid_token" });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, auth_user_id, phone, email, full_name, role, role_label, menus, status FROM app_users WHERE id = $1 LIMIT 1",
      [payload.sub]
    );
    const row = rows[0];
    if (!row || row.status !== "ACTIVE") {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    return sendJson(res, 200, { user: safeUser(row) });
  } catch (err) {
    console.error("me lookup failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "POST" && pathname === "/api/auth/login") {
    return handleLogin(req, res);
  }
  if (req.method === "GET" && pathname === "/api/auth/me") {
    return handleMe(req, res);
  }
  if (req.method === "GET" && pathname === "/api/health") {
    return handleHealth(res);
  }
  if (req.method === "GET" && pathname === "/api/products") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isOwnerUser(user) && !userHasAnyMenu(user, PRODUCT_READ_MENUS)) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    return handleProducts(req, res);
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/products/") && pathname.endsWith("/shopee-mapping")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!checkMenuAccess(user, "katalog")) return sendJson(res, 403, { error: "forbidden" });
    const productId = pathname.slice("/api/products/".length, -"/shopee-mapping".length);
    return detachProductShopeeMapping(req, res, decodeURIComponent(productId));
  }
  if (req.method === "GET" && pathname === "/api/product-prices") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isOwnerUser(user) && !userHasAnyMenu(user, PRODUCT_PRICE_READ_MENUS)) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    return handleProductPrices(req, res);
  }
  if (req.method === "PUT" && pathname === "/api/product-prices") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!checkMenuAccess(user, "pricing")) return sendJson(res, 403, { error: "forbidden" });
    return handleProductPricesPut(req, res);
  }
  if (req.method === "POST" && pathname === "/api/orders") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!checkMenuAccess(user, "pos")) return sendJson(res, 403, { error: "forbidden" });
    return handleOrdersPost(req, res);
  }
  if (req.method === "POST" && pathname === "/api/employees") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isOwnerUser(user)) return sendJson(res, 403, { error: "forbidden" });
    return handleEmployeesPost(req, res);
  }
  if (req.method === "POST" && pathname === "/api/attendance/checkin") {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleAttendanceCheck(req, res, "in");
  }
  if (req.method === "POST" && pathname === "/api/attendance/checkout") {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleAttendanceCheck(req, res, "out");
  }
  if (req.method === "GET" && pathname === "/api/attendance/me") {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleAttendanceMe(req, res);
  }
  if (req.method === "GET" && pathname === "/api/attendance/rekap") {
    const user = await requireAuth(req, res);
    if (!user) return;
    // Rekap presensi: HR (menu "hr") atau owner.
    if (!checkMenuAccess(user, "hr")) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    return handleAttendanceRekap(req, res);
  }
  if (req.method === "PATCH" && pathname.startsWith("/api/orders/")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!checkMenuAccess(user, "gudang")) return sendJson(res, 403, { error: "forbidden" });
    return handleOrdersPatch(req, res, decodeURIComponent(pathname.slice("/api/orders/".length)));
  }
  if (req.method === "POST" && pathname.startsWith("/api/gudang/purchases/") && pathname.endsWith("/receive")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!checkMenuAccess(user, "gudang")) return sendJson(res, 403, { error: "forbidden" });
    const purchaseId = pathname.slice("/api/gudang/purchases/".length, -"/receive".length);
    return handleGudangReceive(req, res, decodeURIComponent(purchaseId));
  }
  if (req.method === "POST" && pathname === "/api/gudang/opname") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!checkMenuAccess(user, "gudang")) return sendJson(res, 403, { error: "forbidden" });
    return handleGudangOpnameStart(req, res);
  }
  if (req.method === "POST" && pathname === "/api/persediaan/stock-adjustments") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isOwnerUser(user) && !userHasAnyMenu(user, ["persediaan", "pembelian"])) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    return handleStockAdjustment(req, res);
  }
  if (req.method === "POST" && pathname.startsWith("/api/stock-mutations/") && pathname.endsWith("/retry")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!isOwnerUser(user) && !userHasAnyMenu(user, ["gudang", "persediaan"])) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    const mutationId = pathname.slice("/api/stock-mutations/".length, -"/retry".length);
    return handleStockMutationRetry(req, res, decodeURIComponent(mutationId));
  }
  if (req.method === "POST" && pathname.startsWith("/api/rpc/")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleRpc(req, res, pathname.slice("/api/rpc/".length));
  }
  if (req.method === "POST" && pathname.startsWith("/api/shopee/")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleShopeeAction(req, res, pathname.slice("/api/shopee/".length));
  }
  if (pathname.startsWith("/api/data/")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    const table = tableName(pathname);
    if (!DATA_TABLES.has(table)) return sendJson(res, 404, { error: "not_found" });
    const op =
      req.method === "GET" ? "read" :
      req.method === "POST" ? "create" :
      req.method === "PATCH" ? "update" :
      req.method === "DELETE" ? "delete" : null;
    if (!op) return sendJson(res, 405, { error: "method_not_allowed" });
    if (!checkTableAccess(user, table, op)) return sendJson(res, 403, { error: "forbidden" });
    if (req.method === "GET") return handleDataGet(req, res, table);
    if (req.method === "POST") return handleDataWrite(req, res, table, "POST");
    if (req.method === "PATCH") return handleDataWrite(req, res, table, "PATCH");
    if (req.method === "DELETE") return handleDataWrite(req, res, table, "DELETE");
  }
  sendJson(res, 404, { status: "error", message: "Not Found" });
});

export { server };

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Juwita API listening on http://127.0.0.1:${PORT}`);
  });

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}
