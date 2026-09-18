// ============================================================
// Modul Shopee lokal — pengganti Edge Functions Supabase.
// Kredensial partner dibaca dari env (SHOPEE_PARTNER_ID/KEY),
// daftar toko dari marketplace_config (PostgreSQL lokal).
// Tidak menyimpan/me-log secret.
// ============================================================
import { pool } from "./db.js";

const SHOPEE_API_URL = "https://partner.shopeemobile.com";
const FETCH_TIMEOUT_MS = 15000;

function env(name) {
  return process.env[name] || "";
}

async function signShopee(partnerId, partnerKey, path, timestamp) {
  const base = partnerId + path + timestamp;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(partnerKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

// Koneksi: get_shop_info (HMAC saja, tanpa access_token).
export async function connectShop(shopId) {
  const accounts = await loadAccounts();
  const acc = accounts.find((a) => a.shop_id === String(shopId)) || accounts[0];
  if (!acc || !acc.partner_id) return { ok: false, error: "kredensial partner Shopee belum di-set" };
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/shop/get_shop_info";
  const sign = await signShopee(acc.partner_id, acc.partner_key, path, timestamp);
  const params = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(timestamp), sign, shop_id: acc.shop_id });
  const { res, body } = await fetchJson(`${SHOPEE_API_URL}${path}?${params}`);
  const ok = res.ok && !body.error;
  await pool.query(
    "UPDATE marketplace_config SET connection_status = $1, last_sync_at = now() WHERE shop_id = $2",
    [ok ? "connected" : "error", acc.shop_id]
  );
  return { ok, shop_name: body.shop_name || body.response?.shop_name || acc.shop_name, error: body.error || body.message };
}

// Pull orders (HMAC saja) — tulis ke marketplace_orders.
export async function pullOrders(shopId) {
  const accounts = await loadAccounts();
  const targets = shopId ? accounts.filter((a) => a.shop_id === String(shopId)) : accounts;
  let inserted = 0;
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - 24 * 3600;
  for (const acc of targets) {
    if (!acc.partner_id) continue;
    let offset = 0, hasMore = true;
    while (hasMore) {
      const ts = Math.floor(Date.now() / 1000);
      const path = "/api/v2/order/get_order_list";
      const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts);
      const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id, time_range_field: "create_time", time_from: String(timeFrom), time_to: String(now), page_size: "100", pagination_offset: String(offset), order_status: "READY_TO_SHIP" });
      const { body } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`);
      if (body.error) break;
      const list = body.response?.order_list || [];
      hasMore = !!body.response?.more;
      offset += list.length;
      const sns = list.map((o) => o.order_sn).filter(Boolean);
      if (!sns.length) break;
      for (let i = 0; i < sns.length; i += 50) {
        const batch = sns.slice(i, i + 50);
        const ts2 = Math.floor(Date.now() / 1000);
        const dpath = "/api/v2/order/get_order_detail";
        const dsign = await signShopee(acc.partner_id, acc.partner_key, dpath, ts2);
        const dp = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts2), sign: dsign, shop_id: acc.shop_id, order_sn_list: batch.join(","), response_optional_fields: "buyer_user_name,total_amount" });
        const dres = await fetchJson(`${SHOPEE_API_URL}${dpath}?${dp}`);
        for (const d of dres.body.response?.order_list || []) {
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
    const ts = Math.floor(Date.now() / 1000);
    const path = "/api/v2/product/update_stock";
    const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts);
    const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id });
    p.set("item_id", String(m.shopee_item_id));
    p.set("stock_list", JSON.stringify([{ model_id: 0, normal_stock: Math.max(0, Math.round(Number(m.qty_after))) }]));
    const { res } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, { method: "POST" });
    const status = res.ok ? "synced" : "failed";
    await pool.query("UPDATE stock_mutations SET sync_status = $1 WHERE id = $2", [status, m.id]);
    if (res.ok) synced++; else failed++;
  }
  return { synced, failed, pending: mutations.length };
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
    const { rows } = await pool.query(
      `SELECT pp.product_id, pp.price, pm.shopee_item_id
       FROM product_prices pp
       JOIN product_shopee_mapping pm ON pm.product_id = pp.product_id
       WHERE pp.channel = $1 AND pm.shopee_item_id IS NOT NULL AND pp.price IS NOT NULL
       ORDER BY pp.product_id LIMIT 200`,
      [channel]
    );
    for (const r of rows) {
      if (!acc.partner_id) { failed++; continue; }
      const ts = Math.floor(Date.now() / 1000);
      const path = "/api/v2/product/update_price";
      const sign = await signShopee(acc.partner_id, acc.partner_key, path, ts);
      const p = new URLSearchParams({ partner_id: acc.partner_id, timestamp: String(ts), sign, shop_id: acc.shop_id });
      p.set("item_id", String(r.shopee_item_id));
      p.set("price_list", JSON.stringify([{ model_id: 0, original_price: Number(r.price) }]));
      const { res } = await fetchJson(`${SHOPEE_API_URL}${path}?${p}`, { method: "POST" });
      if (res.ok) synced++; else failed++;
    }
  }
  return { synced, failed };
}
