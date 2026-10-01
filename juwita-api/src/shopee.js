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

// Stock sync: kirim products.stock (single source of truth) ke SEMUA Shopee
// yang ter-mapping untuk product_id tersebut. shopee_account TIDAK menentukan
// target — target ditentukan dari product_shopee_mapping (bisa Shopee 1 & 2).
export async function syncStock(shopId) {
  const accounts = await loadAccounts();
  const accountByShop = {};
  for (const a of accounts) accountByShop[String(a.shop_id)] = a;

  // Dedupe pending per product_id (pakai mutation terbaru tiap produk).
  const { rows: products } = await pool.query(
    `SELECT DISTINCT ON (m.product_id) m.product_id, p.name, p.stock, m.id AS mutation_id
     FROM stock_mutations m
     JOIN products p ON p.id = m.product_id
     WHERE m.sync_status = 'pending'
     ORDER BY m.product_id, m.id DESC`
  );

  let synced = 0, failed = 0;
  const results = [];
  for (const p of products) {
    const stock = Math.max(0, Math.round(Number(p.stock)));

    // Cari SEMUA mapping Shopee milik produk ini (target sebenarnya).
    const { rows: maps } = await pool.query(
      "SELECT shop_id, shopee_item_id FROM product_shopee_mapping WHERE product_id = $1",
      [p.product_id]
    );

    const targets = maps.filter((mp) => !shopId || String(mp.shop_id) === String(shopId));

    if (targets.length === 0) {
      // Tidak ada mapping yang perlu dikirim → tandai synced agar tidak nyangkut pending.
      await pool.query("UPDATE stock_mutations SET sync_status='synced', shopee_sync_at=now() WHERE id=$1", [p.mutation_id]);
      synced++;
      results.push({ product_id: p.product_id, product_name: p.name, stock, skipped: true, ok: true });
      continue;
    }

    let allOk = true;
    for (const mp of targets) {
      const targetShop = String(mp.shop_id);
      const acc = accountByShop[targetShop];
      if (!acc || !acc.partner_id) {
        allOk = false;
        failed++;
        results.push({ product_id: p.product_id, product_name: p.name, shop_id: targetShop, stock, ok: false, error: "akun Shopee tidak tersedia" });
        continue;
      }

      const { access_token, refresh_token } = await ensureToken(acc);
      if (!access_token) {
        allOk = false;
        failed++;
        results.push({ product_id: p.product_id, product_name: p.name, shop_id: targetShop, stock, ok: false, error: "access_token Shopee tidak tersedia" });
        continue;
      }

      let token = access_token;
      let r = await updateStockOne(acc, token, mp.shopee_item_id, stock);
      if (!r.ok && refresh_token) {
        const rr = await refreshToken(acc, acc.shop_id, refresh_token);
        if (rr.access_token) {
          token = rr.access_token;
          r = await updateStockOne(acc, token, mp.shopee_item_id, stock);
        }
      }

      if (r.ok) {
        results.push({ product_id: p.product_id, product_name: p.name, shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: true });
      } else {
        allOk = false;
        failed++;
        results.push({ product_id: p.product_id, product_name: p.name, shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: false, error: r.error });
      }
    }

    if (allOk) {
      await pool.query("UPDATE stock_mutations SET sync_status='synced', shopee_sync_at=now() WHERE id=$1", [p.mutation_id]);
      synced++;
    }
    // else: biarkan pending agar di-retry pada tick berikutnya.
  }
  return { synced, failed, results };
}

// Stock sync SATU produk ke SEMUA mapping Shopee-nya (untuk test/verifikasi).
export async function syncStockForProduct(productId) {
  const accounts = await loadAccounts();
  const accountByShop = {};
  for (const a of accounts) accountByShop[String(a.shop_id)] = a;

  const { rows: prods } = await pool.query("SELECT id, name, stock FROM products WHERE id = $1 LIMIT 1", [productId]);
  if (!prods.length) return { ok: false, error: "produk tidak ditemukan" };

  const p = prods[0];
  const stock = Math.max(0, Math.round(Number(p.stock)));

  const { rows: maps } = await pool.query(
    "SELECT shop_id, shopee_item_id FROM product_shopee_mapping WHERE product_id = $1",
    [productId]
  );

  if (!maps.length) return { ok: true, skipped: true, product_id: Number(productId), product_name: p.name, stock, results: [] };

  const results = [];
  let allOk = true;
  for (const mp of maps) {
    const targetShop = String(mp.shop_id);
    const acc = accountByShop[targetShop];
    if (!acc || !acc.partner_id) { allOk = false; results.push({ shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: false, error: "akun Shopee tidak tersedia" }); continue; }

    const { access_token, refresh_token } = await ensureToken(acc);
    if (!access_token) { allOk = false; results.push({ shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: false, error: "access_token Shopee tidak tersedia" }); continue; }

    let token = access_token;
    let r = await updateStockOne(acc, token, mp.shopee_item_id, stock);
    if (!r.ok && refresh_token) {
      const rr = await refreshToken(acc, acc.shop_id, refresh_token);
      if (rr.access_token) { token = rr.access_token; r = await updateStockOne(acc, token, mp.shopee_item_id, stock); }
    }
    if (!r.ok) allOk = false;
    results.push({ shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: r.ok, error: r.error });
  }

  return { ok: allOk, product_id: Number(productId), product_name: p.name, stock, results };
}

// Stock sync SATU produk + SATU shop (dipakai untuk test/verifikasi manual).
// Kirim products.stock ke shopee_item_id milik shop tersebut saja.
export async function syncStockOne(productId, shopId) {
  const accounts = await loadAccounts();
  const acc = accounts.find((a) => a.shop_id === String(shopId));
  if (!acc || !acc.partner_id) return { ok: false, error: "akun Shopee tidak tersedia" };

  const { rows: prods } = await pool.query("SELECT id, name, stock FROM products WHERE id = $1 LIMIT 1", [productId]);
  if (!prods.length) return { ok: false, error: "produk tidak ditemukan" };

  const { rows: maps } = await pool.query(
    "SELECT shopee_item_id FROM product_shopee_mapping WHERE product_id = $1 AND shop_id = $2 LIMIT 1",
    [productId, String(shopId)]
  );
  if (!maps.length || maps[0].shopee_item_id == null) return { ok: false, error: "belum ada mapping Shopee" };

  const shopeeItemId = maps[0].shopee_item_id;
  const stock = Math.max(0, Math.round(Number(prods[0].stock)));

  const { access_token, refresh_token } = await ensureToken(acc);
  if (!access_token) return { ok: false, error: "access_token Shopee tidak tersedia" };

  let r = await updateStockOne(acc, access_token, shopeeItemId, stock);
  if (!r.ok && refresh_token) {
    const rr = await refreshToken(acc, acc.shop_id, refresh_token);
    if (rr.access_token) r = await updateStockOne(acc, rr.access_token, shopeeItemId, stock);
  }

  return {
    ok: r.ok,
    error: r.error,
    product_id: Number(productId),
    product_name: prods[0].name,
    shop_id: String(shopId),
    shopee_item_id: shopeeItemId,
    stock,
  };
}

async function getModelList(acc, accessToken, itemId) {
  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/get_model_list";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id, access_token: accessToken, item_id: String(itemId) });
  const { body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, { method: "GET" });
  if (body.error) return { error: String(body.error || body.message || "shopee_error"), models: [] };
  return { error: null, models: (body.response && body.response.model) || [] };
}

async function getItemBaseInfo(acc, accessToken, itemId) {
  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/get_item_base_info";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id, access_token: accessToken, item_id_list: String(itemId) });
  const { body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, { method: "GET" });
  if (body.error) return { error: String(body.error || body.message || "shopee_error"), item: null };
  const item = (body.response && body.response.item_list && body.response.item_list[0]) || null;
  return { error: null, item };
}

// Ambil lokasi seller_stock (location_id) dari stock_info_v2; fallback "".
function sellerLocations(stockInfo) {
  const seller = (stockInfo && Array.isArray(stockInfo.seller_stock) && stockInfo.seller_stock) || [];
  if (seller.length) {
    const locs = seller.map((s) => s.location_id || "").filter(Boolean);
    if (locs.length) return locs;
  }
  return [""];
}

async function updateStockOne(acc, accessToken, itemId, qtyAfter) {
  const stock = Math.max(0, Math.round(Number(qtyAfter)));

  // Shopee sekarang wajib pakai seller_stock (dengan location_id) untuk 1-tier
  // maupun 2-tier (variasi). normal_stock sudah tidak diterima.
  const ml = await getModelList(acc, accessToken, itemId);
  if (ml.error) return { ok: false, error: ml.error };

  let stockList;
  if (ml.models.length > 0) {
    stockList = ml.models.map((m) => {
      const locs = sellerLocations(m.stock_info_v2);
      return { model_id: Number(m.model_id), seller_stock: locs.map((location_id) => ({ stock, location_id })) };
    });
  } else {
    const info = await getItemBaseInfo(acc, accessToken, itemId);
    if (info.error) return { ok: false, error: info.error };
    const locs = sellerLocations(info.item && info.item.stock_info_v2);
    stockList = [{ model_id: 0, seller_stock: locs.map((location_id) => ({ stock, location_id })) }];
  }

  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_stock";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const auth = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id, access_token: accessToken });
  const { res, body } = await fetchJson(`${SHOPEE_API_URL}${path}?${auth}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_id: Number(itemId), stock_list: stockList }),
  });
  if (!res.ok) return { ok: false, error: "HTTP " + res.status };
  if (body.error) return { ok: false, error: String(body.error || body.message || "shopee_error") };
  const failures = body.response && Array.isArray(body.response.failure_list) ? body.response.failure_list : [];
  if (failures.length > 0) {
    const reason = (failures[0] && failures[0].failed_reason) || "failed";
    return { ok: false, error: "failure_list: " + reason };
  }
  return { ok: true, error: null };
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
      let res = await updatePriceOne(acc, token, r.shopee_item_id, r.price);
      if (!res.ok && refresh_token) {
        const rr = await refreshToken(acc, acc.shop_id, refresh_token);
        if (rr.access_token) {
          token = rr.access_token;
          res = await updatePriceOne(acc, token, r.shopee_item_id, r.price);
        }
      }
      if (res.ok) synced++; else failed++;
    }
  }
  return { synced, failed };
}

async function updatePriceOne(acc, accessToken, itemId, price) {
  // Item 2-tier (variasi) wajib kirim model_id per model; 1-tier cukup original_price.
  const ml = await getModelList(acc, accessToken, itemId);
  if (ml.error) return { ok: false, error: ml.error };

  const n = Number(price);
  const priceList = ml.models.length > 0
    ? ml.models.map((m) => ({ model_id: Number(m.model_id), original_price: n }))
    : [{ original_price: n }];

  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_price";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id, access_token: accessToken });
  const { res, body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_id: Number(itemId), price_list: priceList }),
  });
  if (!res.ok) return { ok: false, error: "HTTP " + res.status };
  if (body.error) return { ok: false, error: String(body.error || "shopee_error") };
  if (body.response && Array.isArray(body.response.failure_list) && body.response.failure_list.length > 0) {
    const reason = (body.response.failure_list[0] && body.response.failure_list[0].failed_reason) || "failed";
    return { ok: false, error: "failure_list: " + reason };
  }
  return { ok: true, error: null };
}

// Price sync SATU produk + SATU channel Shopee (dipanggil setelah Simpan harga).
// Tidak menyentuh produk lain dan tidak sync seluruh product_prices.
export async function syncPriceOne(productId, channel) {
  const channelByShop = { "shopee:724153261": "724153261", "shopee:1214362884": "1214362884" };
  const shopId = channelByShop[channel];
  if (!shopId) return { ok: false, skipped: true, error: "channel bukan Shopee" };

  const accounts = await loadAccounts();
  const acc = accounts.find((a) => a.shop_id === shopId);
  if (!acc || !acc.partner_id) return { ok: false, error: "akun Shopee tidak tersedia" };

  const { rows: maps } = await pool.query(
    "SELECT shopee_item_id FROM product_shopee_mapping WHERE product_id = $1 AND shop_id = $2 LIMIT 1",
    [productId, shopId]
  );
  if (!maps.length || maps[0].shopee_item_id == null) return { ok: false, error: "belum ada mapping Shopee" };

  const { rows: prices } = await pool.query(
    "SELECT price FROM product_prices WHERE product_id = $1 AND channel = $2 LIMIT 1",
    [productId, channel]
  );
  if (!prices.length || prices[0].price == null) return { ok: false, error: "harga tidak ditemukan" };
  const price = Number(prices[0].price);

  const { access_token, refresh_token } = await ensureToken(acc);
  if (!access_token) return { ok: false, error: "access_token Shopee tidak tersedia" };

  let r = await updatePriceOne(acc, access_token, maps[0].shopee_item_id, price);
  if (!r.ok && refresh_token) {
    const rr = await refreshToken(acc, acc.shop_id, refresh_token);
    if (rr.access_token) r = await updatePriceOne(acc, rr.access_token, maps[0].shopee_item_id, price);
  }
  return { ok: r.ok, error: r.ok ? null : r.error };
}
