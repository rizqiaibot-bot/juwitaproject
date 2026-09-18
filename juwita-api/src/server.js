import http from "node:http";
import { pool } from "./db.js";
import { verifyPassword, hashPassword } from "./auth.js";
import { signAccessToken, verifyAccessToken } from "./jwt.js";
import { requireAuth, requireOwner } from "./middleware.js";

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

    return sendJson(res, 200, { ok: true, count: entries.length });
  } catch (err) {
    console.error("product-prices upsert failed:", err.message);
    return sendJson(res, 500, { error: "internal_error" });
  }
}

// --- Data API generik (whitelist tabel) ---
const DATA_TABLES = new Set([
  "products", "orders", "order_items", "karyawan",
  "warehouse_receiving", "warehouse_racks", "warehouse_opname",
  "stock_mutations", "attendance_records",
  "app_users", "accounting_accounts", "accounting_transactions",
  "v_account_balance",
]);

// Kolom sensitif yang tidak boleh dibaca/ditulis via data API.
const FORBIDDEN_COLUMNS = new Set(["password_hash"]);

const TABLE_READ_COLUMNS = {
  app_users: "id, auth_user_id, phone, email, full_name, role, role_label, menus, status, created_at, updated_at",
};

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
    const colList = cols.join(", ");
    const valueList = rows.map((r) => `(${cols.map((c, i) => `$${i + 1}`).join(", ")})`).join(", ");
    const flat = rows.flatMap((r) => cols.map((c) => {
      const v = r[c];
      return (typeof v === "object" && v !== null) ? JSON.stringify(v) : v;
    }));
    try {
      const { rows: inserted } = await pool.query(
        `INSERT INTO ${table} (${colList}) VALUES ${valueList} RETURNING *`,
        flat
      );
      sendJson(res, 200, { data: inserted });
    } catch (err) {
      console.error(`data POST ${table} failed:`, err.message);
      sendJson(res, 500, { error: "internal_error" });
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
  const setList = cols.map((c, i) => `${c} = $${idx + i}`).join(", ");
  try {
    const { rows: updated } = await pool.query(
      `UPDATE ${table} SET ${setList}${where} RETURNING *`,
      [...params, ...cols.map((c) => {
        const v = updates[c];
        return (typeof v === "object" && v !== null) ? JSON.stringify(v) : v;
      })]
    );
    sendJson(res, 200, { data: updated });
  } catch (err) {
    console.error(`data PATCH ${table} failed:`, err.message);
    sendJson(res, 500, { error: "internal_error" });
  }
}

// --- Checkout POS: panggil RPC lokal sync_offline_order ---
async function handleOrdersPost(req, res) {
  const { error, data } = await readJsonBody(req, 2 * 1024 * 1024);
  if (error || !data || typeof data !== "object") {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT sync_offline_order($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) AS result`,
      [
        data.p_orderid, data.p_idempotency_key, data.p_date, data.p_channel,
        data.p_customer, data.p_total, data.p_paystatus, data.p_wmsstatus,
        data.p_courier, data.p_resi, data.p_payment_method, data.p_subtotal,
        data.p_diskon, data.p_bayar, data.p_kembalian, JSON.stringify(data.p_items),
      ]
    );
    sendJson(res, 200, { data: rows[0].result });
  } catch (err) {
    console.error("orders POST failed:", err.message);
    sendJson(res, 500, { error: "internal_error" });
  }
}

// --- Aksi gudang: panggil RPC lokal record_warehouse_action ---
async function handleOrdersPatch(req, res, orderId) {
  const { error, data } = await readJsonBody(req, 64 * 1024);
  if (error || !data || typeof data !== "object") {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT record_warehouse_action($1,$2,$3,$4,$5) AS result`,
      [orderId, data.p_action, data.p_petugas || null, data.p_courier || null, data.p_resi || null]
    );
    sendJson(res, 200, { data: rows[0].result });
  } catch (err) {
    console.error("orders PATCH failed:", err.message);
    sendJson(res, 500, { error: "internal_error" });
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
      const exists = await pool.query("SELECT id FROM app_users WHERE phone = $1", [phone]);
      if (exists.rows.length) return sendJson(res, 409, { error: "phone_exists" });
      const hash = await hashPassword(password);
      const menus = Array.isArray(data.menus) ? JSON.stringify(data.menus) : "[]";
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

async function handleRpc(req, res, name) {
  try {
    if (name === "close_opname") {
      const { data } = await readJsonBody(req, 64 * 1024);
      const opnameId = data && data.p_opname_id ? String(data.p_opname_id) : "";
      const { rows } = await pool.query("SELECT close_opname($1) AS result", [opnameId]);
      return sendJson(res, 200, { data: rows[0].result });
    }
    if (name === "accounting_sync_pos") {
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
    return handleProducts(req, res);
  }
  if (req.method === "GET" && pathname === "/api/product-prices") {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleProductPrices(req, res);
  }
  if (req.method === "PUT" && pathname === "/api/product-prices") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!requireOwner(req, res)) return;
    return handleProductPricesPut(req, res);
  }
  if (req.method === "POST" && pathname === "/api/orders") {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleOrdersPost(req, res);
  }
  if (req.method === "POST" && pathname === "/api/employees") {
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!requireOwner(req, res)) return;
    return handleEmployeesPost(req, res);
  }
  if (req.method === "PATCH" && pathname.startsWith("/api/orders/")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleOrdersPatch(req, res, decodeURIComponent(pathname.slice("/api/orders/".length)));
  }
  if (req.method === "POST" && pathname.startsWith("/api/rpc/")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    return handleRpc(req, res, pathname.slice("/api/rpc/".length));
  }
  if (pathname.startsWith("/api/data/")) {
    const user = await requireAuth(req, res);
    if (!user) return;
    const table = tableName(pathname);
    if (req.method === "GET") return handleDataGet(req, res, table);
    if (req.method === "POST") return handleDataWrite(req, res, table, "POST");
    if (req.method === "PATCH") return handleDataWrite(req, res, table, "PATCH");
    if (req.method === "DELETE") return handleDataWrite(req, res, table, "DELETE");
    return sendJson(res, 405, { error: "method_not_allowed" });
  }
  sendJson(res, 404, { status: "error", message: "Not Found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Juwita API listening on http://127.0.0.1:${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
