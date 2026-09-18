// ============================================================
// Worker lokal: Shopee pull orders (VPS, bukan Supabase Edge Function)
// Jalankan via systemd timer / cron. Baca credential dari env.
//   DATABASE_URL         (dari .juwita-one-api.env)
//   SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID
//   (dari .juwita-shopee.env — salin dari Supabase Edge Function secrets)
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

async function signShopee(partnerId, partnerKey, path, timestamp) {
  const base = partnerId + path + timestamp;
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

async function getOrderList(account, timeFrom, timeTo, offset = 0) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_list";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp);
  const params = new URLSearchParams({
    partner_id: account.partner_id, timestamp: String(timestamp), sign,
    shop_id: account.shop_id, time_range_field: "create_time",
    time_from: String(timeFrom), time_to: String(timeTo),
    page_size: "100", pagination_offset: String(offset), order_status: "READY_TO_SHIP",
  });
  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  const body = await res.json();
  if (body.error) throw new Error(`Shopee API error: ${body.error} - ${body.message || ""}`);
  return { orderList: body.response?.order_list || [], hasMore: body.response?.more || false };
}

async function getOrderDetailBatch(account, orderSns) {
  if (!orderSns.length) return { orderDetails: [] };
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_detail";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp);
  const params = new URLSearchParams({
    partner_id: account.partner_id, timestamp: String(timestamp), sign,
    shop_id: account.shop_id, order_sn_list: orderSns.join(","),
    response_optional_fields: "buyer_user_name,total_amount",
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
  let offset = 0, hasMore = true;
  while (hasMore) {
    const { orderList, hasMore: more } = await getOrderList(account, timeFrom, now, offset);
    hasMore = more; offset += orderList.length;
    const sns = orderList.map((o) => o.order_sn).filter(Boolean);
    results.pulled += sns.length;
    if (!sns.length) break;
    for (let i = 0; i < sns.length; i += 50) {
      const batch = sns.slice(i, i + 50);
      try {
        const { orderDetails } = await getOrderDetailBatch(account, batch);
        for (const d of orderDetails) {
          try { const r = await saveOrder(account, d); if (r.status === "inserted") results.inserted++; }
          catch (e) { results.failed++; results.errors.push({ order_sn: d.order_sn || "?", error: e.message }); }
        }
      } catch (e) { results.failed += batch.length; results.errors.push({ error: e.message }); }
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
