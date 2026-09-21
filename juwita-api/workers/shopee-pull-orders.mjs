// ============================================================
// Worker lokal: Shopee pull orders (VPS, bukan Supabase Edge Function)
// Jalankan via systemd timer / cron. Baca credential dari env.
//   DATABASE_URL         (dari .juwita-one-api.env)
//   SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID
//   SHOPEE2_PARTNER_ID, SHOPEE2_PARTNER_KEY, SHOPEE2_SHOP_ID
//   (dari .juwita-shopee.env)
// access_token/refresh_token dibaca dari marketplace_credentials (PostgreSQL).
// ============================================================
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL wajib di-set");

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

const SHOPEE_API_URL = "https://partner.shopeemobile.com";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const PULL_HOURS_BACK = 24;
const RETRYABLE_STATUSES = [500, 502, 503, 504];

const ACCOUNTS = [
  {
    label: "toko_1",
    partner_id: process.env.SHOPEE_PARTNER_ID || "",
    partner_key: process.env.SHOPEE_PARTNER_KEY || "",
    shop_id: process.env.SHOPEE_SHOP_ID || "",
  },
  {
    label: "toko_2",
    partner_id: process.env.SHOPEE2_PARTNER_ID || "",
    partner_key: process.env.SHOPEE2_PARTNER_KEY || "",
    shop_id: process.env.SHOPEE2_SHOP_ID || "",
  },
];

async function signShopee(partnerId, partnerKey, path, timestamp, accessToken = "", shopId = "") {
  const base = partnerId + path + timestamp + accessToken + shopId;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(partnerKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if (RETRYABLE_STATUSES.includes(res.status) && attempt < retries) { lastError = new Error(`HTTP ${res.status}`); continue; }
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    } catch (err) {
      lastError = err.name === "AbortError" ? new Error("timeout") : err;
      if (attempt >= retries) throw lastError;
    }
  }
  throw lastError;
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

async function refreshToken(account, shopId, refreshTokenValue) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/access_token/get";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp);
  const params = new URLSearchParams({ partner_id: account.partner_id, timestamp: String(timestamp), sign });
  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshTokenValue, shop_id: Number(shopId), partner_id: Number(account.partner_id) }),
  });
  const body = await res.json().catch(() => ({}));
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
  const lower = (text || "").toLowerCase();
  return lower.includes("token") || lower.includes("auth");
}

async function getOrderList(account, accessToken, timeFrom, timeTo, offset = 0) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_list";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp, accessToken, account.shop_id);
  const params = new URLSearchParams({
    partner_id: account.partner_id, timestamp: String(timestamp), sign,
    shop_id: account.shop_id, access_token: accessToken, time_range_field: "create_time",
    time_from: String(timeFrom), time_to: String(timeTo),
    page_size: "100", pagination_offset: String(offset), order_status: "READY_TO_SHIP",
  });
  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  const body = await res.json();
  if (body.error) throw new Error(`Shopee API error: ${body.error} - ${body.message || ""}`);
  return { orderList: body.response?.order_list || [], hasMore: body.response?.more || false };
}

async function getOrderDetailBatch(account, accessToken, orderSns) {
  if (!orderSns.length) return { orderDetails: [] };
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_detail";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp, accessToken, account.shop_id);
  const params = new URLSearchParams({
    partner_id: account.partner_id, timestamp: String(timestamp), sign,
    shop_id: account.shop_id, access_token: accessToken, order_sn_list: orderSns.join(","),
    response_optional_fields: "buyer_user_name,total_amount,item_list,recipient_address",
  });
  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  const body = await res.json();
  if (body.error) throw new Error(`Shopee API error: ${body.error} - ${body.message || ""}`);
  return { orderDetails: body.response?.order_list || [] };
}

async function saveOrder(account, detail) {
  const mpOrderId = detail.order_sn;
  if (!mpOrderId) return { status: "failed", error: "order_sn tidak ditemukan" };
  const customerName = detail.buyer_user_name || detail.recipient_address?.name || null;
  const total = Math.round(parseFloat(detail.total_amount) || 0);
  const orderStatus = detail.order_status || "READY_TO_SHIP";
  await pool.query(
    `INSERT INTO marketplace_orders (platform, shop_id, mp_order_id, customer_name, total, order_status, sync_status, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
     ON CONFLICT (platform, shop_id, mp_order_id) DO NOTHING`,
    ["shopee", account.shop_id, mpOrderId, customerName, total, orderStatus, JSON.stringify(detail)]
  );
  return { status: "inserted", order_sn: mpOrderId };
}

async function pullOrdersForAccount(account) {
  const results = { pulled: 0, inserted: 0, failed: 0, errors: [] };
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - PULL_HOURS_BACK * 3600;

  const { access_token, refresh_token } = await loadToken(account.shop_id);
  let token = access_token;
  if (!token && refresh_token) {
    const r = await refreshToken(account, account.shop_id, refresh_token);
    if (r.access_token) token = r.access_token;
  }
  if (!token) {
    results.errors.push({ error: "access_token tidak tersedia" });
    return results;
  }

  let offset = 0, hasMore = true;
  while (hasMore) {
    let list;
    try {
      list = await getOrderList(account, token, timeFrom, now, offset);
    } catch (e) {
      if (refresh_token && isAuthError(e.message)) {
        const r = await refreshToken(account, account.shop_id, refresh_token);
        if (r.access_token) { token = r.access_token; list = await getOrderList(account, token, timeFrom, now, offset); }
        else { results.errors.push({ error: e.message }); break; }
      } else { results.errors.push({ error: e.message }); break; }
    }
    hasMore = list.hasMore; offset += list.orderList.length;
    const sns = list.orderList.map((o) => o.order_sn).filter(Boolean);
    results.pulled += sns.length;
    if (!sns.length) break;
    for (let i = 0; i < sns.length; i += 50) {
      const batch = sns.slice(i, i + 50);
      try {
        let { orderDetails } = await getOrderDetailBatch(account, token, batch);
        for (const d of orderDetails) {
          try { const r = await saveOrder(account, d); if (r.status === "inserted") results.inserted++; }
          catch (e) { results.failed++; results.errors.push({ order_sn: d.order_sn || "?", error: e.message }); }
        }
      } catch (e) {
        if (refresh_token && isAuthError(e.message)) {
          const r = await refreshToken(account, account.shop_id, refresh_token);
          if (r.access_token) {
            token = r.access_token;
            try {
              const { orderDetails } = await getOrderDetailBatch(account, token, batch);
              for (const d of orderDetails) {
                try { const rr = await saveOrder(account, d); if (rr.status === "inserted") results.inserted++; }
                catch (e2) { results.failed++; results.errors.push({ order_sn: d.order_sn || "?", error: e2.message }); }
              }
            } catch (e2) { results.failed += batch.length; results.errors.push({ error: e2.message }); }
          } else { results.failed += batch.length; results.errors.push({ error: e.message }); }
        } else { results.failed += batch.length; results.errors.push({ error: e.message }); }
      }
    }
  }
  return results;
}

async function main() {
  const startedAt = Date.now();
  const active = ACCOUNTS.filter((a) => a.partner_id && a.shop_id);
  let totalPulled = 0, totalInserted = 0, totalFailed = 0;
  for (const account of active) {
    try {
      const r = await pullOrdersForAccount(account);
      totalPulled += r.pulled; totalInserted += r.inserted; totalFailed += r.failed;
    } catch (e) {
      console.error(`account ${account.label} failed:`, e.message);
    }
  }
  const duration = Date.now() - startedAt;
  try {
    await pool.query(
      `INSERT INTO activity_log (event_type, direction, platform, status, triggered_by, action_source, duration_ms, metadata)
       VALUES ('ORDER_PULL','IN','shopee',$1,'system','cron',$2,$3)`,
      [totalFailed === 0 ? "success" : "failed", duration, JSON.stringify({ pulled: totalPulled, inserted: totalInserted, failed: totalFailed })]
    );
  } catch (e) { console.error("activity_log failed:", e.message); }
  console.log(`shopee-pull: pulled=${totalPulled} inserted=${totalInserted} failed=${totalFailed} (${duration}ms)`);
}

main().then(() => pool.end()).catch((e) => { console.error("worker error:", e.message); process.exit(1); });
