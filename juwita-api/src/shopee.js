// ============================================================
// Modul Shopee lokal — pengganti Edge Functions Supabase.
// Kredensial partner dibaca dari env (SHOPEE_PARTNER_ID/KEY),
// access_token/refresh_token dari marketplace_credentials (PostgreSQL lokal),
// daftar toko dari marketplace_config (PostgreSQL lokal).
// Tidak menyimpan/me-log secret.
// ============================================================
import { pool } from "./db.js";

const SHOPEE_API_URL = "https://partner.shopeemobile.com";
const FETCH_TIMEOUT_MS = 15000;

function env(name) {
  return process.env[name] || "";
}

async function signShopee(partnerId, partnerKey, path, timestamp, accessToken = "", shopId = "") {
  const base = partnerId + path + timestamp + accessToken + shopId;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(partnerKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { res, body: await res.json().catch(() => ({})) };
  } finally {
    clearTimeout(t);
  }
}

async function loadAccounts() {
  const partnerId = env("SHOPEE_PARTNER_ID");
  const partnerKey = env("SHOPEE_PARTNER_KEY");
  if (!partnerId || !partnerKey) return [];
  const { rows } = await pool.query(
    "SELECT shop_id, shop_name FROM marketplace_config WHERE platform = 'shopee' AND connection_status = 'connected' AND shop_id IS NOT NULL ORDER BY id"
  );
  return rows.map((r) => ({
    shop_id: String(r.shop_id),
    shop_name: r.shop_name || null,
    partner_id: partnerId,
    partner_key: partnerKey,
  }));
}

async function loadToken(shopId) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token FROM marketplace_credentials WHERE shop_id = $1 LIMIT 1",
    [shopId]
  );
  const r = rows[0];
  if (!r) return { access_token: null, refresh_token: null };
  return { access_token: r.access_token || null, refresh_token: r.refresh_token || null };
}

async function refreshToken(acc, shopId, refreshTokenValue) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/access_token/get";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, timestamp);
  const params = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(timestamp), sign });
  const { res, body } = await fetchJson(`${SHOPEE_API_URL}${path}?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshTokenValue, shop_id: Number(shopId), partner_id: Number(acc.partner_id) }),
  });
  if (!res.ok || body.error || !body.access_token) {
    return { error: body.error || body.message || "refresh failed", access_token: null };
  }
  await pool.query(
    `INSERT INTO marketplace_credentials (shop_id, platform, access_token, refresh_token, updated_at)
     VALUES ($1, 'shopee', $2, $3, now())
     ON CONFLICT (shop_id) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, updated_at = now()`,
    [shopId, body.access_token, body.refresh_token || refreshTokenValue]
  );
  return { error: null, access_token: body.access_token };
}

function isAuthError(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes("token") || lower.includes("auth");
}

async function ensureToken(acc) {
  const { access_token, refresh_token } = await loadToken(acc.shop_id);
  if (access_token) return { access_token, refresh_token };
  if (refresh_token) {
    const r = await refreshToken(acc, acc.shop_id, refresh_token);
    if (r.access_token) return { access_token: r.access_token, refresh_token };
  }
  return { access_token: null, refresh_token: null };
}

async function getShopInfo(acc, accessToken) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/shop/get_shop_info";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, timestamp, accessToken, acc.shop_id);
  const params = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(timestamp), sign, shop_id: acc.shop_id, access_token: accessToken });
  return fetchJson(`${SHOPEE_API_URL}${path}?${params}`);
}

// Koneksi: get_shop_info (dengan access_token).
export async function connectShop(shopId) {
  const accounts = await loadAccounts();
  const acc = accounts.find((a) => a.shop_id === String(shopId)) || accounts[0];
  if (!acc || !acc.partner_id) return { ok: false, error: "kredensial partner Shopee belum di-set" };
  const { access_token, refresh_token } = await ensureToken(acc);
  if (!access_token) return { ok: false, error: "access_token Shopee tidak tersedia" };

  let token = access_token;
  let { res, body } = await getShopInfo(acc, token);
  if (isAuthError(body?.error || body?.message) && refresh_token) {
    const r = await refreshToken(acc, acc.shop_id, refresh_token);
    if (r.access_token) {
      token = r.access_token;
      ({ res, body } = await getShopInfo(acc, token));
    }
  }

  const ok = res.ok && !body.error;
  await pool.query(
    "UPDATE marketplace_config SET connection_status = $1, last_sync_at = now() WHERE shop_id = $2",
    [ok ? "connected" : "error", acc.shop_id]
  );
  return { ok, shop_name: body.shop_name || body.response?.shop_name || acc.shop_name, error: body.error || body.message };
}

async function getOrderList(acc, accessToken, timeFrom, timeTo, offset) {
  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_list";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id, access_token: accessToken, time_range_field: "create_time", time_from: String(timeFrom), time_to: String(timeTo), page_size: "100", pagination_offset: String(offset), order_status: "READY_TO_SHIP" });
  const { body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`);
  if (body.error) return { error: body.error, message: body.message, list: [], hasMore: false };
  return { error: null, message: null, list: body.response?.order_list || [], hasMore: !!body.response?.more };
}

async function getOrderDetailBatch(acc, accessToken, orderSns) {
  const ts2 = Math.floor(Date.now() / 1000);
  const dpath = "/api/v2/order/get_order_detail";
  const dsign = await signShopee(acc.partner_id, acc.partner_key, dpath, ts2, accessToken, acc.shop_id);
  const dp = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts2), sign: dsign, shop_id: acc.shop_id, access_token: accessToken, order_sn_list: orderSns.join(","), response_optional_fields: "buyer_user_name,total_amount" });
  const dres = await fetchJson(`${SHOPEE_API_URL}${dpath}?${dp}`);
  return dres;
}

// Pull orders — tulis ke marketplace_orders.
export async function pullOrders(shopId) {
  const accounts = await loadAccounts();
  const targets = shopId ? accounts.filter((a) => a.shop_id === String(shopId)) : accounts;
  let inserted = 0;
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - 24 * 3600;
  for (const acc of targets) {
    if (!acc.partner_id) continue;
    const { access_token, refresh_token } = await ensureToken(acc);
    if (!access_token) continue;
    let token = access_token;
    let offset = 0, hasMore = true;
    while (hasMore) {
      let list = await getOrderList(acc, token, timeFrom, now, offset);
      if (list.error && refresh_token && isAuthError(list.error + " " + (list.message || ""))) {
        const r = await refreshToken(acc, acc.shop_id, refresh_token);
        if (r.access_token) {
          token = r.access_token;
          list = await getOrderList(acc, token, timeFrom, now, offset);
        }
      }
      if (list.error) break;
      const sns = list.list.map((o) => o.order_sn).filter(Boolean);
      hasMore = list.hasMore;
      offset += list.list.length;
      if (!sns.length) break;
      for (let i = 0; i < sns.length; i += 50) {
        const batch = sns.slice(i, i + 50);
        let dres = await getOrderDetailBatch(acc, token, batch);
        if (dres.body?.error && refresh_token && isAuthError(dres.body.error + " " + (dres.body.message || ""))) {
          const r = await refreshToken(acc, acc.shop_id, refresh_token);
          if (r.access_token) {
            token = r.access_token;
            dres = await getOrderDetailBatch(acc, token, batch);
          }
        }
        for (const d of dres.body?.response?.order_list || []) {
          const mp = d.order_sn;
          if (!mp) continue;
          const r = await pool.query(
            `INSERT INTO marketplace_orders (platform, shop_id, mp_order_id, customer_name, total, order_status, sync_status, raw_payload)
             VALUES ('shopee',$1,$2,$3,$4,$5,'pending',$6) ON CONFLICT (platform, shop_id, mp_order_id) DO NOTHING`,
            [acc.shop_id, mp, d.buyer_user_name || null, Math.round(parseFloat(d.total_amount) || 0), d.order_status || "READY_TO_SHIP", JSON.stringify(d)]
          );
          if (r.rowCount) inserted++;
        }
      }
    }
  }
  return { inserted };
}

// Stock sync: qty_after dari stock_mutations pending → update_stock Shopee.
export async function syncStock(shopId) {
  const accounts = await loadAccounts();
  const { rows: mutations } = await pool.query(
    `SELECT m.*, pm.shopee_item_id
     FROM stock_mutations m
     JOIN product_shopee_mapping pm ON pm.product_id = m.product_id
     WHERE m.sync_status = 'pending' AND pm.shopee_item_id IS NOT NULL
     ORDER BY m.id LIMIT 100`
  );
  let synced = 0, failed = 0;
  for (const m of mutations) {
    const acc = accounts.find((a) => a.shop_id === String(m.shop_id)) || (shopId ? accounts.find((a) => a.shop_id === String(shopId)) : accounts[0]);
    if (!acc || !acc.partner_id) { failed++; continue; }
    const { access_token, refresh_token } = await ensureToken(acc);
    if (!access_token) { failed++; continue; }
    let token = access_token;
    let ok = await updateStockOne(acc, token, m.shopee_item_id, m.qty_after);
    if (!ok && refresh_token) {
      const r = await refreshToken(acc, acc.shop_id, refresh_token);
      if (r.access_token) {
        token = r.access_token;
        ok = await updateStockOne(acc, token, m.shopee_item_id, m.qty_after);
      }
    }
    const status = ok ? "synced" : "failed";
    await pool.query("UPDATE stock_mutations SET sync_status = $1 WHERE id = $2", [status, m.id]);
    if (ok) synced++; else failed++;
  }
  return { synced, failed, pending: mutations.length };
}

async function updateStockOne(acc, accessToken, itemId, qtyAfter) {
  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_stock";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id, access_token: accessToken });
  p.set("item_id", String(itemId));
  p.set("stock_list", JSON.stringify([{ model_id: 0, normal_stock: Math.max(0, Math.round(Number(qtyAfter))) }]));
  const { res, body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, { method: "POST" });
  return res.ok && !body.error;
}

// Price sync: harga per channel (product_prices) → update_price Shopee.
export async function syncPrice(shopId) {
  const accounts = await loadAccounts();
  const channelByShop = { "724153261": "shopee:724153261", "1214362884": "shopee:1214362884" };
  const targets = shopId ? accounts.filter((a) => a.shop_id === String(shopId)) : accounts;
  let synced = 0, failed = 0;
  for (const acc of targets) {
    const channel = channelByShop[acc.shop_id];
    if (!channel) continue;
    const { access_token, refresh_token } = await ensureToken(acc);
    if (!access_token) { failed++; continue; }
    let token = access_token;
    const { rows } = await pool.query(
      `SELECT pp.product_id, pp.price, pm.shopee_item_id
       FROM product_prices pp
       JOIN product_shopee_mapping pm ON pm.product_id = pp.product_id
       WHERE pp.channel = $1 AND pm.shopee_item_id IS NOT NULL AND pp.price IS NOT NULL
       ORDER BY pp.product_id LIMIT 200`,
      [channel]
    );
    for (const r of rows) {
      let ok = await updatePriceOne(acc, token, r.shopee_item_id, r.price);
      if (!ok && refresh_token) {
        const rr = await refreshToken(acc, acc.shop_id, refresh_token);
        if (rr.access_token) {
          token = rr.access_token;
          ok = await updatePriceOne(acc, token, r.shopee_item_id, r.price);
        }
      }
      if (ok) synced++; else failed++;
    }
  }
  return { synced, failed };
}

async function updatePriceOne(acc, accessToken, itemId, price) {
  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_price";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id, access_token: accessToken });
  const { res, body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_id: Number(itemId), price_list: [{ original_price: Number(price) }] }),
  });
  return res.ok && !body.error && !(body.response && Array.isArray(body.response.failure_list) && body.response.failure_list.length > 0);
}
