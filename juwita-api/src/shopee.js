// ============================================================
// Modul Shopee lokal — pengganti Edge Functions Supabase.
// Kredensial partner dibaca dari env (SHOPEE_PARTNER_ID/KEY untuk Shopee 1,
// SHOPEE2_PARTNER_ID/KEY untuk Shopee 2),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Throttle antar-listing agar tidak membanjiri rate limit Shopee.
// SHOPEE_THROTTLE_MS (default 150ms); 0 = nonaktif.
async function throttle() {
  const ms = process.env.SHOPEE_THROTTLE_MS != null ? Number(process.env.SHOPEE_THROTTLE_MS) : 150;
  if (ms > 0) await sleep(ms);
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

// Kredensial partner PER TOKO — Shopee 1 dan Shopee 2 adalah partner account
// yang BERBEDA. Shopee 1 memakai SHOPEE_PARTNER_ID/KEY + SHOPEE_SHOP_ID,
// Shopee 2 memakai SHOPEE2_PARTNER_ID/KEY + SHOPEE2_SHOP_ID.
function partnerForShop(shopId) {
  const sid = String(shopId || "");
  const s1 = env("SHOPEE_SHOP_ID");
  const s2 = env("SHOPEE2_SHOP_ID");
  if (s2 && sid === s2) {
    const id = env("SHOPEE2_PARTNER_ID");
    const key = env("SHOPEE2_PARTNER_KEY");
    if (id && key) return { partner_id: id, partner_key: key };
  }
  if (s1 && sid === s1) {
    const id = env("SHOPEE_PARTNER_ID");
    const key = env("SHOPEE_PARTNER_KEY");
    if (id && key) return { partner_id: id, partner_key: key };
  }
  // Fallback bila SHOPEE_SHOP_ID/SHOPEE2_SHOP_ID tidak diset di env.
  if (sid === "1214362884") {
    const id = env("SHOPEE2_PARTNER_ID");
    const key = env("SHOPEE2_PARTNER_KEY");
    if (id && key) return { partner_id: id, partner_key: key };
  }
  const id = env("SHOPEE_PARTNER_ID");
  const key = env("SHOPEE_PARTNER_KEY");
  if (id && key) return { partner_id: id, partner_key: key };
  return { partner_id: "", partner_key: "" };
}

async function loadAccounts() {
  const { rows } = await pool.query(
    "SELECT shop_id, shop_name FROM marketplace_config WHERE platform = 'shopee' AND connection_status = 'connected' AND shop_id IS NOT NULL ORDER BY id"
  );
  return rows
    .map((r) => {
      const { partner_id, partner_key } = partnerForShop(r.shop_id);
      if (!partner_id || !partner_key) return null;
      return {
        shop_id: String(r.shop_id),
        shop_name: r.shop_name || null,
        partner_id,
        partner_key,
      };
    })
    .filter(Boolean);
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

// --- Product pull: cocokkan listing Shopee ke produk PUSAT via SKU, tulis mapping ---
async function getItemListPage(acc, accessToken, offset) {
  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/get_item_list";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const p = new URLSearchParams({
    partner_id: acc.partner_id, timestamp: String(ts), sign,
    shop_id: acc.shop_id, access_token: accessToken,
    offset: String(offset), page_size: "100", item_status: "NORMAL",
  });
  const { body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, { method: "GET" });
  if (body.error) return { error: String(body.error), message: body.message || "", item: [], hasMore: false, nextOffset: null };
  const resp = body.response || {};
  return { error: null, message: null, item: resp.item || [], hasMore: !!resp.has_next_page, nextOffset: resp.next_offset };
}

async function getItemBaseInfoTeam(acc, accessToken, itemIds) {
  const ts = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/get_item_base_info";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts, accessToken, acc.shop_id);
  const p = new URLSearchParams({
    partner_id: acc.partner_id, timestamp: String(ts), sign,
    shop_id: acc.shop_id, access_token: accessToken,
    item_id_list: itemIds.join(","),
  });
  const { body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, { method: "GET" });
  if (body.error) return { error: String(body.error), message: body.message || "", item_list: [] };
  return { error: null, message: null, item_list: (body.response && body.response.item_list) || [] };
}

// Kumpulkan semua item_id (paginasi).
async function collectItemIds(acc, accessToken) {
  const ids = [];
  let offset = 0;
  for (let guard = 0; guard < 500; guard++) {
    const resp = await getItemListPage(acc, accessToken, offset);
    if (resp.error) return { error: resp.error, message: resp.message, ids };
    for (const it of resp.item) {
      if (it && it.item_id != null) ids.push(Number(it.item_id));
    }
    if (!resp.hasMore || resp.item.length === 0) return { error: null, ids };
    offset = resp.nextOffset != null ? Number(resp.nextOffset) : offset + resp.item.length;
  }
  return { error: null, ids };
}

// Pull produk: cocokkan listing Shopee → produk PUSAT (by SKU pusat), lalu upsert
// product_shopee_mapping. TIDAK membuat produk baru, TIDAK menyentuh stok/harga/order.
// Mapping yang sudah ada TIDAK diubah/dihapus (hanya menambah mapping baru).
export async function pullProducts(shopId) {
  const accounts = await loadAccounts();
  const targets = shopId ? accounts.filter((a) => a.shop_id === String(shopId)) : accounts;
  const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

  let fetched = 0, matched = 0, unmatched = 0, skipped = 0, inserted = 0, failed = 0, resynced = 0;
  const unmatchedItems = [];
  const accountResults = [];
  const stockSyncResults = [];

  for (const acc of targets) {
    if (!acc.partner_id) {
      accountResults.push({ shop_id: acc.shop_id, error: "kredensial partner Shopee belum di-set" });
      failed++;
      continue;
    }
    const { access_token, refresh_token } = await ensureToken(acc);
    if (!access_token) {
      accountResults.push({ shop_id: acc.shop_id, error: "access_token Shopee tidak tersedia" });
      failed++;
      continue;
    }
    let token = access_token;

    // 1. Kumpulkan item_id (paginasi), refresh token bila error auth.
    let collected = await collectItemIds(acc, token);
    if (collected.error && refresh_token && isAuthError(collected.error + " " + (collected.message || ""))) {
      const r = await refreshToken(acc, acc.shop_id, refresh_token);
      if (r.access_token) { token = r.access_token; collected = await collectItemIds(acc, token); }
    }
    if (collected.error) {
      accountResults.push({ shop_id: acc.shop_id, error: collected.error + (collected.message ? ": " + collected.message : "") });
      failed++;
      continue;
    }

    // 2. Ambil base info per batch (maks 50).
    const allItems = [];
    let baseFailed = null;
    for (let i = 0; i < collected.ids.length; i += 50) {
      const batch = collected.ids.slice(i, i + 50);
      let baseResp = await getItemBaseInfoTeam(acc, token, batch);
      if (baseResp.error && refresh_token && isAuthError(baseResp.error + " " + (baseResp.message || ""))) {
        const r = await refreshToken(acc, acc.shop_id, refresh_token);
        if (r.access_token) { token = r.access_token; baseResp = await getItemBaseInfoTeam(acc, token, batch); }
      }
      if (baseResp.error) { baseFailed = baseResp.error + (baseResp.message ? ": " + baseResp.message : ""); break; }
      for (const it of baseResp.item_list) allItems.push(it);
    }
    if (baseFailed) {
      accountResults.push({ shop_id: acc.shop_id, error: baseFailed });
      failed++;
      continue;
    }

    // 3. Indeks produk pusat (sku / shopee_sku) + mapping shop ini.
    //    SKU ambigu (satu SKU menunjuk 2 produk) ditandai dan DIABAIKAN
    //    agar mapping tidak salah produk → stok salah di satu toko.
    const { rows: prodRows } = await pool.query("SELECT id, sku, shopee_sku FROM products");
    const bySku = new Map();
    const ambiguousSku = new Set();
    for (const p of prodRows) {
      for (const key of [norm(p.sku), norm(p.shopee_sku)]) {
        if (!key) continue;
        if (bySku.has(key) && bySku.get(key).id !== p.id) {
          ambiguousSku.add(key);
        } else if (!bySku.has(key)) {
          bySku.set(key, p);
        }
      }
    }
    for (const key of ambiguousSku) bySku.delete(key);
    const { rows: mapRows } = await pool.query(
      "SELECT id, product_id, shopee_item_id FROM product_shopee_mapping WHERE shop_id = $1",
      [acc.shop_id]
    );
    const mapByItemId = new Set();
    const mapByProductId = new Set();
    for (const m of mapRows) {
      if (m.shopee_item_id != null) mapByItemId.add(String(m.shopee_item_id));
      if (m.product_id != null) mapByProductId.add(String(m.product_id));
    }

    // 4. Cocokkan & tambahkan mapping baru (tanpa mengubah mapping lama).
    const newMappings = [];
    for (const item of allItems) {
      fetched++;
      const itemId = item && item.item_id != null ? Number(item.item_id) : null;
      if (itemId == null) continue;
      const itemSku = String((item && item.item_sku) || "").trim();
      const nsku = norm(itemSku);

      if (mapByItemId.has(String(itemId))) { matched++; continue; }        // sudah ter-map
      const product = nsku ? (bySku.get(nsku) || null) : null;
      if (!product) {
        unmatched++;
        if (unmatchedItems.length < 50) unmatchedItems.push({ shop_id: acc.shop_id, shopee_item_id: itemId, item_sku: itemSku || null, item_name: (item && item.item_name) || "" });
        continue;
      }
      const productId = Number(product.id);
      if (mapByProductId.has(String(productId))) { skipped++; continue; }   // produk sudah punya listing di shop ini

      try {
        const { rowCount } = await pool.query(
          `INSERT INTO product_shopee_mapping (product_id, shop_id, shopee_item_id, shopee_sku)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (shop_id, shopee_item_id) DO NOTHING`,
          [productId, acc.shop_id, itemId, itemSku || null]
        );
        if (rowCount) {
          inserted++;
          mapByItemId.add(String(itemId));
          mapByProductId.add(String(productId));
          matched++;
          // Mapping baru (mis. toko kedua baru terhubung): langsung kirim
          // stok pusat saat ini agar tidak selisih dengan toko lain.
          newMappings.push({ productId, shopId: acc.shop_id });
        } else {
          skipped++;
        }
      } catch (e) {
        failed++;
      }
    }

    // 5. Stok tutup ke listing yang BARU ter-map pada putaran ini.
    for (const nm of newMappings) {
      try {
        const sr = await syncStockOne(nm.productId, nm.shopId);
        if (sr.ok) resynced++;
        else failed++;
        stockSyncResults.push({ product_id: nm.productId, shop_id: nm.shopId, stock: sr.stock ?? null, ok: !!sr.ok, error: sr.error || null });
      } catch (e) {
        failed++;
        stockSyncResults.push({ product_id: nm.productId, shop_id: nm.shopId, ok: false, error: (e && e.message) || "sync error" });
      }
    }

    accountResults.push({ shop_id: acc.shop_id, shop_name: acc.shop_name || null, listings: allItems.length });
  }

  return {
    success: failed === 0,
    shop_id: shopId || "all",
    fetched,
    matched,
    unmatched,
    skipped,
    failed,
    inserted,
    updated: 0,
    resynced,
    stock_sync: stockSyncResults,
    unmatched_items: unmatchedItems,
    accountResults,
  };
}

// Catat keberhasilan/kegagalan sinkronisasi per toko/listing ke activity_log.
// Gagal mencatat TIDAK boleh menggagalkan sinkronisasi.
async function logActivity(entry) {
  try {
    await pool.query(
      `INSERT INTO activity_log (event_type, direction, platform, shop_id, product_id, product_name, qty_after, reference_id, status, error_message, created_at)
       VALUES ($1, 'OUT', 'shopee', $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        entry.event_type || "STOCK_SYNC",
        entry.shop_id || null,
        entry.product_id ?? null,
        entry.product_name || null,
        entry.qty_after ?? null,
        entry.shopee_item_id != null ? String(entry.shopee_item_id) : null,
        entry.status || "failed",
        entry.error_message || null,
      ]
    );
  } catch (e) {
    // abaikan — logging tidak boleh memutus sinkronisasi
  }
}

// Satu kunci advisory untuk semua push stok massal (syncStock & reconcileStock,
// dari worker maupun endpoint manual) agar dua proses tidak saling menimpa
// listing Shopee dengan nilai stok yang sudah basi.
const STOCK_PUSH_LOCK_KEY = 745300102;

async function withStockPushLock(fn) {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [STOCK_PUSH_LOCK_KEY]);
    locked = !!(rows[0] && rows[0].ok);
    if (!locked) return { busy: true };
    return { busy: false, value: await fn() };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [STOCK_PUSH_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Stok terkini dibaca tepat sebelum dikirim (bukan dari snapshot awal batch).
async function currentStock(productId) {
  const { rows } = await pool.query("SELECT stock FROM products WHERE id = $1", [productId]);
  return rows.length ? Math.max(0, Math.floor(Number(rows[0].stock))) : null;
}

// Stock sync: kirim products.stock (single source of truth) ke SEMUA Shopee
// yang ter-mapping untuk product_id tersebut. shopee_account TIDAK menentukan
// target — target ditentukan dari product_shopee_mapping (bisa Shopee 1 & 2).
export async function syncStock(shopId, opts = {}) {
  if (opts.dryRun) return syncStockUnlocked(shopId, opts);
  const r = await withStockPushLock(() => syncStockUnlocked(shopId, opts));
  if (r.busy) return { synced: 0, failed: 0, busy: true, dry_run: false, results: [] };
  return r.value;
}

async function syncStockUnlocked(shopId, opts = {}) {
  const dryRun = !!opts.dryRun;
  const accounts = await loadAccounts();
  const accountByShop = {};
  for (const a of accounts) accountByShop[String(a.shop_id)] = a;

  // Kelompokkan pending per product_id. Hanya mutasi yang terlihat di snapshot
  // ini yang nanti ditandai synced; mutasi baru tetap pending → tick berikutnya.
  const { rows: products } = await pool.query(
    `SELECT m.product_id, p.name, array_agg(m.id ORDER BY m.id) AS mutation_ids
     FROM stock_mutations m
     JOIN products p ON p.id = m.product_id
     WHERE m.sync_status = 'pending'
     GROUP BY m.product_id, p.name
     ORDER BY m.product_id`
  );

  let synced = 0, failed = 0;
  const results = [];
  for (const p of products) {
    const stock = await currentStock(p.product_id);
    if (stock == null) continue;

    // Cari SEMUA mapping Shopee milik produk ini (target sebenarnya).
    const { rows: maps } = await pool.query(
      "SELECT shop_id, shopee_item_id FROM product_shopee_mapping WHERE product_id = $1",
      [p.product_id]
    );

    const targets = maps.filter((mp) => !shopId || String(mp.shop_id) === String(shopId));

    if (targets.length === 0) {
      // Produk tanpa mapping TIDAK boleh diam-diam ditandai synced.
      // Tandai failed agar terlihat, dan catat alasan ke activity_log.
      if (!dryRun) {
        await pool.query("UPDATE stock_mutations SET sync_status='failed', shopee_sync_at=now() WHERE id = ANY($1::bigint[]) AND sync_status='pending'", [p.mutation_ids]);
      }
      failed++;
      if (!dryRun) await logActivity({ shop_id: null, product_id: p.product_id, product_name: p.name, qty_after: stock, status: "failed", error_message: "tanpa mapping Shopee" });
      results.push({ product_id: p.product_id, product_name: p.name, stock, skipped: true, ok: false, error: "tanpa mapping Shopee" });
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
        if (!dryRun) await logActivity({ shop_id: targetShop, product_id: p.product_id, product_name: p.name, qty_after: stock, shopee_item_id: mp.shopee_item_id, status: "failed", error_message: "akun Shopee tidak tersedia" });
        continue;
      }

      const { access_token, refresh_token } = await ensureToken(acc);
      if (!access_token) {
        allOk = false;
        failed++;
        results.push({ product_id: p.product_id, product_name: p.name, shop_id: targetShop, stock, ok: false, error: "access_token Shopee tidak tersedia" });
        if (!dryRun) await logActivity({ shop_id: targetShop, product_id: p.product_id, product_name: p.name, qty_after: stock, shopee_item_id: mp.shopee_item_id, status: "failed", error_message: "access_token Shopee tidak tersedia" });
        continue;
      }

      let r;
      if (dryRun) {
        r = { ok: true, error: null };
      } else {
        await throttle();
        let token = access_token;
        r = await updateStockOne(acc, token, mp.shopee_item_id, stock);
        if (!r.ok && refresh_token && isAuthError(r.error)) {
          const rr = await refreshToken(acc, acc.shop_id, refresh_token);
          if (rr.access_token) {
            token = rr.access_token;
            r = await updateStockOne(acc, token, mp.shopee_item_id, stock);
          }
        }
      }

      if (r.ok) {
        results.push({ product_id: p.product_id, product_name: p.name, shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: true });
        if (!dryRun) await logActivity({ shop_id: targetShop, product_id: p.product_id, product_name: p.name, qty_after: stock, shopee_item_id: mp.shopee_item_id, status: "success" });
      } else {
        allOk = false;
        failed++;
        results.push({ product_id: p.product_id, product_name: p.name, shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: false, error: r.error });
        if (!dryRun) await logActivity({ shop_id: targetShop, product_id: p.product_id, product_name: p.name, qty_after: stock, shopee_item_id: mp.shopee_item_id, status: "failed", error_message: r.error || "shopee_error" });
      }
    }

    if (allOk) {
      if (!dryRun) await pool.query("UPDATE stock_mutations SET sync_status='synced', shopee_sync_at=now() WHERE id = ANY($1::bigint[]) AND sync_status='pending'", [p.mutation_ids]);
      synced++;
    }
    // else: biarkan pending agar di-retry pada tick berikutnya.
  }
  return { synced, failed, dry_run: dryRun, results };
}

// Stock sync SATU produk ke SEMUA mapping Shopee-nya (untuk test/verifikasi).
export async function syncStockForProduct(productId) {
  const accounts = await loadAccounts();
  const accountByShop = {};
  for (const a of accounts) accountByShop[String(a.shop_id)] = a;

  const { rows: prods } = await pool.query("SELECT id, name, stock FROM products WHERE id = $1 LIMIT 1", [productId]);
  if (!prods.length) return { ok: false, error: "produk tidak ditemukan" };

  const p = prods[0];
  const stock = Math.max(0, Math.floor(Number(p.stock)));

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
    if (!r.ok && refresh_token && isAuthError(r.error)) {
      const rr = await refreshToken(acc, acc.shop_id, refresh_token);
      if (rr.access_token) { token = rr.access_token; r = await updateStockOne(acc, token, mp.shopee_item_id, stock); }
    }
    if (!r.ok) allOk = false;
    results.push({ shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: r.ok, error: r.error });
  }

  return { ok: allOk, product_id: Number(productId), product_name: p.name, stock, results };
}

// Rekonsiliasi penuh: kirim products.stock ke SEMUA listing ter-mapping untuk
// SEMUA produk (bukan hanya yang punya stock_mutations pending). Memaksa listing
// Shopee mengikuti stok POS walau tidak ada mutasi baru (idempotent overwrite),
// sehingga drift stok terdeteksi/dikoreksi pada tiap penjadwalan.
//
// Batas batch: tiap panggilan memproses maks. batchLimit listing (default 200)
// agar tidak membanjiri rate limit Shopee. Jika masih ada listing tersisa,
// hasMore=true + next_cursor di-set agar pemanggil melanjutkan batch berikutnya;
// jangan anggap rekonsiliasi selesai selama hasMore masih true.
const RECONCILE_BATCH_LIMIT_DEFAULT = 200;

export async function reconcileStock(shopId, opts = {}) {
  if (opts.dryRun) return reconcileStockUnlocked(shopId, opts);
  const r = await withStockPushLock(() => reconcileStockUnlocked(shopId, opts));
  if (r.busy) {
    return {
      shop_id: shopId || "all", synced: 0, failed: 0, skipped: 0, listings_processed: 0,
      hasMore: false, next_cursor: null, busy: true, dry_run: false, results: [],
    };
  }
  return r.value;
}

async function reconcileStockUnlocked(shopId, opts = {}) {
  const accounts = await loadAccounts();
  const accountByShop = {};
  for (const a of accounts) accountByShop[String(a.shop_id)] = a;

  const batchLimit = Number(opts.batchLimit ?? process.env.RECONCILE_BATCH_LIMIT) || RECONCILE_BATCH_LIMIT_DEFAULT;
  const cursor = opts.cursor != null ? Number(opts.cursor) : null;
  const dryRun = !!opts.dryRun;

  const params = [];
  const where = [];
  if (shopId) { params.push(String(shopId)); where.push(`m.shop_id = $${params.length}`); }
  if (cursor != null) { params.push(cursor); where.push(`p.id > $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limitParam = params.length + 1;

  // Ambil satu "halaman" produk (setiap produk ≤2 listing), +1 untuk deteksi sisa.
  const { rows: products } = await pool.query(
    `SELECT DISTINCT p.id, p.name, p.stock
     FROM products p
     JOIN product_shopee_mapping m ON m.product_id = p.id
     ${whereSql}
     ORDER BY p.id
     LIMIT $${limitParam}`,
    [...params, batchLimit + 1]
  );
  const hasMoreProducts = products.length > batchLimit;
  const page = hasMoreProducts ? products.slice(0, batchLimit) : products;

  let synced = 0, failed = 0, skipped = 0, listingsProcessed = 0;
  const results = [];
  let lastCompletedProductId = cursor; // id produk terakhir yang SEMUA listing-nya tuntas
  let hasMore = hasMoreProducts;

  for (const p of page) {
    // Baca ulang: halaman produk bisa dibaca beberapa menit sebelum giliran
    // produk ini dikirim (throttle), sementara POS/Shopee terus berjualan.
    const fresh = await currentStock(p.id);
    const stock = fresh != null ? fresh : Math.max(0, Math.floor(Number(p.stock)));

    const { rows: maps } = await pool.query(
      "SELECT shop_id, shopee_item_id FROM product_shopee_mapping WHERE product_id = $1",
      [p.id]
    );
    const targets = maps.filter((mp) => !shopId || String(mp.shop_id) === String(shopId));
    if (targets.length === 0) { skipped++; lastCompletedProductId = p.id; continue; }

    // Jangan mulai produk bila kuota listing habis (agar satu produk tidak
    // diproses separuh; produk ini diproses utuh di batch berikutnya).
    if (listingsProcessed > 0 && listingsProcessed + targets.length > batchLimit) {
      hasMore = true;
      break;
    }

    lastCompletedProductId = p.id;
    for (const mp of targets) {
      listingsProcessed++;
      const targetShop = String(mp.shop_id);
      const acc = accountByShop[targetShop];
      if (!acc || !acc.partner_id) {
        failed++;
        results.push({ product_id: p.id, product_name: p.name, shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: false, error: "akun Shopee tidak tersedia" });
        if (!dryRun) await logActivity({ shop_id: targetShop, product_id: p.id, product_name: p.name, qty_after: stock, shopee_item_id: mp.shopee_item_id, status: "failed", error_message: "akun Shopee tidak tersedia" });
        continue;
      }

      const { access_token, refresh_token } = await ensureToken(acc);
      if (!access_token) {
        failed++;
        results.push({ product_id: p.id, product_name: p.name, shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: false, error: "access_token Shopee tidak tersedia" });
        if (!dryRun) await logActivity({ shop_id: targetShop, product_id: p.id, product_name: p.name, qty_after: stock, shopee_item_id: mp.shopee_item_id, status: "failed", error_message: "access_token Shopee tidak tersedia" });
        continue;
      }

      let r;
      if (dryRun) {
        r = { ok: true, error: null };
      } else {
        await throttle();
        let token = access_token;
        r = await updateStockOne(acc, token, mp.shopee_item_id, stock);
        // Refresh token HANYA untuk error autentikasi, bukan error non-auth.
        if (!r.ok && refresh_token && isAuthError(r.error)) {
          const rr = await refreshToken(acc, acc.shop_id, refresh_token);
          if (rr.access_token) {
            token = rr.access_token;
            r = await updateStockOne(acc, token, mp.shopee_item_id, stock);
          }
        }
      }

      if (r.ok) {
        synced++;
        results.push({ product_id: p.id, product_name: p.name, shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: true });
        // Tidak log sukses berulang setiap tick (hindari activity_log tumbuh tanpa batas).
      } else {
        failed++;
        results.push({ product_id: p.id, product_name: p.name, shop_id: targetShop, shopee_item_id: mp.shopee_item_id, stock, ok: false, error: r.error });
        if (!dryRun) await logActivity({ shop_id: targetShop, product_id: p.id, product_name: p.name, qty_after: stock, shopee_item_id: mp.shopee_item_id, status: "failed", error_message: r.error || "shopee_error" });
      }
    }
  }

  return {
    shop_id: shopId || "all",
    synced, failed, skipped,
    listings_processed: listingsProcessed,
    hasMore,
    next_cursor: hasMore ? lastCompletedProductId : null,
    dry_run: dryRun,
    results,
  };
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
  const stock = Math.max(0, Math.floor(Number(prods[0].stock)));

  const { access_token, refresh_token } = await ensureToken(acc);
  if (!access_token) return { ok: false, error: "access_token Shopee tidak tersedia" };

  let r = await updateStockOne(acc, access_token, shopeeItemId, stock);
  if (!r.ok && refresh_token && isAuthError(r.error)) {
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
  const stock = Math.max(0, Math.floor(Number(qtyAfter)));

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
  let synced = 0, failed = 0, skipped = 0;
  for (const acc of targets) {
    const channel = channelByShop[acc.shop_id];
    if (!channel) continue;
    const { access_token, refresh_token } = await ensureToken(acc);
    if (!access_token) { failed++; continue; }
    let token = access_token;
    // Mapping WAJIB milik toko yang sama dengan channel harga: harga Shopee 1
    // tidak boleh dikirim ke listing Shopee 2 (dan sebaliknya).
    const { rows } = await pool.query(
      `SELECT pp.product_id, pp.price, pm.shopee_item_id
       FROM product_prices pp
       JOIN product_shopee_mapping pm ON pm.product_id = pp.product_id AND pm.shop_id = $2
       WHERE pp.channel = $1 AND pm.shopee_item_id IS NOT NULL AND pp.price IS NOT NULL
       ORDER BY pp.product_id LIMIT 200`,
      [channel, String(acc.shop_id)]
    );
    for (const r of rows) {
      let res = await updatePriceOne(acc, token, r.shopee_item_id, r.price);
      if (!res.ok && !res.skipped && refresh_token) {
        const rr = await refreshToken(acc, acc.shop_id, refresh_token);
        if (rr.access_token) {
          token = rr.access_token;
          res = await updatePriceOne(acc, token, r.shopee_item_id, r.price);
        }
      }
      if (res.ok) synced++; else if (res.skipped) skipped++; else failed++;
    }
  }
  return { synced, failed, skipped };
}

async function updatePriceOne(acc, accessToken, itemId, price) {
  // Item 2-tier (variasi) wajib kirim model_id per model; 1-tier cukup original_price.
  const ml = await getModelList(acc, accessToken, itemId);
  if (ml.error) return { ok: false, error: ml.error };

  // product_prices hanya menyimpan SATU harga per channel. Listing yang harga
  // variasinya berbeda-beda tidak boleh diratakan diam-diam → dilewati.
  if (ml.models.length > 1) {
    const distinct = new Set(ml.models.map((m) => Number(m.price_info && m.price_info[0] && m.price_info[0].original_price)));
    if (distinct.size > 1) return { ok: false, skipped: true, error: "harga variasi berbeda, tidak diratakan" };
  }

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
  if (!r.ok && !r.skipped && refresh_token) {
    const rr = await refreshToken(acc, acc.shop_id, refresh_token);
    if (rr.access_token) r = await updatePriceOne(acc, rr.access_token, maps[0].shopee_item_id, price);
  }
  return { ok: r.ok, skipped: !!r.skipped, error: r.ok ? null : r.error };
}
