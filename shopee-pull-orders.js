// ============================================================
// Supabase Edge Function: shopee-pull-orders
// Deploy ke: supabase functions deploy shopee-pull-orders
// ============================================================
// Cara deploy:
//   1. supabase functions deploy shopee-pull-orders
//   2. Set ENV (sama dengan shopee-stock-sync):
//      SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID
//      SHOPEE_PARTNER_ID_2, SHOPEE_PARTNER_KEY_2, SHOPEE_SHOP_ID_2
//   3. Setup Supabase Cron (rekomendasi: tiap 15 menit)
// ============================================================
// ALUR:
//   Cron → getOrderList() → getOrderDetail() → saveOrder() → activity_log
//   Duplikasi dicegah via (platform + mp_order_id) UNIQUE constraint
//   Satu order gagal → order lain tetap diproses
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_API_URL = "https://partner.shopeemobile.com/api/v2";

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const PULL_HOURS_BACK = 24;

const RETRYABLE_STATUSES = [500, 502, 503, 504];

const ACCOUNTS = [
  {
    label: "toko_1",
    partner_id: Deno.env.get("SHOPEE_PARTNER_ID") || "",
    partner_key: Deno.env.get("SHOPEE_PARTNER_KEY") || "",
    shop_id: Deno.env.get("SHOPEE_SHOP_ID") || "",
  },
  {
    label: "toko_2",
    partner_id: Deno.env.get("SHOPEE_PARTNER_ID_2") || "",
    partner_key: Deno.env.get("SHOPEE_PARTNER_KEY_2") || "",
    shop_id: Deno.env.get("SHOPEE_SHOP_ID_2") || "",
  },
];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// SHOPEE HMAC SIGNATURE
// ============================================================
async function signShopee(partnerId, partnerKey, path, timestamp) {
  const base = partnerId + path + timestamp;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(partnerKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// FETCH DENGAN TIMEOUT & RETRY
// ============================================================
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) return res;

      if (RETRYABLE_STATUSES.includes(res.status) && attempt < retries) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }

      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    } catch (err) {
      lastError = err;

      if (err.name === "AbortError") {
        lastError = new Error("Request timeout after " + REQUEST_TIMEOUT_MS + "ms");
      }

      if (attempt < retries && RETRYABLE_STATUSES.some(s => lastError.message.includes(String(s)))) {
        continue;
      }

      throw lastError;
    }
  }

  throw lastError;
}

// ============================================================
// GET ORDER LIST dari Shopee
// ============================================================
async function getOrderList(account, timeFrom, timeTo, offset = 0) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_list";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp);

  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
    shop_id: account.shop_id,
    time_range_field: "create_time",
    time_from: String(timeFrom),
    time_to: String(timeTo),
    page_size: "100",
    pagination_offset: String(offset),
    order_status: "READY_TO_SHIP",
  });

  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  const body = await res.json();

  if (body.error) {
    throw new Error(`Shopee API error: ${body.error} - ${body.message || ""}`);
  }

  const orderList = body.response?.order_list || [];
  const hasMore = body.response?.more || false;

  return { orderList, hasMore };
}

// ============================================================
// GET ORDER DETAIL dari Shopee (batch, support multiple order_sn)
// ============================================================
async function getOrderDetailBatch(account, orderSns) {
  if (!orderSns.length) return { orderDetails: [] };

  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_detail";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp);

  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
    shop_id: account.shop_id,
    order_sn_list: orderSns.join(","),
    response_optional_fields: "buyer_user_name,total_amount",
  });

  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  const body = await res.json();

  if (body.error) {
    throw new Error(`Shopee API error: ${body.error} - ${body.message || ""}`);
  }

  return { orderDetails: body.response?.order_list || [] };
}

// ============================================================
// SAVE ORDER ke marketplace_orders
// ============================================================
async function saveOrder(account, orderDetail) {
  const mpOrderId = orderDetail.order_sn;
  if (!mpOrderId) return { status: "failed", error: "order_sn tidak ditemukan di response" };

  const customerName = orderDetail.buyer_user_name ||
    orderDetail.recipient_address?.name ||
    null;

  const total = parseFloat(orderDetail.total_amount) || 0;
  const orderStatus = orderDetail.order_status || "READY_TO_SHIP";

  const { error: upsertErr } = await supabase
    .from("marketplace_orders")
    .upsert({
      platform: "shopee",
      mp_order_id: mpOrderId,
      customer_name: customerName,
      total: Math.round(total),
      order_status: orderStatus,
      sync_status: "pending",
      raw_payload: orderDetail,
    }, { onConflict: "platform, mp_order_id", ignoreDuplicates: true });

  if (upsertErr) {
    // Jika error bukan duplicate violation
    if (upsertErr.code === "23505") {
      return { status: "skipped", order_sn: mpOrderId };
    }
    return { status: "failed", order_sn: mpOrderId, error: upsertErr.message };
  }

  return { status: "inserted", order_sn: mpOrderId };
}

// ============================================================
// MAIN — pull orders untuk satu akun
// ============================================================
async function pullOrdersForAccount(account) {
  const results = { pulled: 0, inserted: 0, skipped: 0, failed: 0, errors: [] };
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - PULL_HOURS_BACK * 3600;
  const timeTo = now;

  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { orderList, hasMore: more } = await getOrderList(account, timeFrom, timeTo, offset);
    hasMore = more;
    offset += orderList.length;

    const newOrderSns = orderList.map(o => o.order_sn).filter(Boolean);
    results.pulled += newOrderSns.length;

    if (!newOrderSns.length) break;

    // Batch getOrderDetail (max 50 per call)
    const batchSize = 50;
    for (let i = 0; i < newOrderSns.length; i += batchSize) {
      const batch = newOrderSns.slice(i, i + batchSize);

      try {
        const { orderDetails } = await getOrderDetailBatch(account, batch);

        for (const detail of orderDetails) {
          try {
            const result = await saveOrder(account, detail);
            if (result.status === "inserted") results.inserted++;
            else if (result.status === "skipped") results.skipped++;
            else {
              results.failed++;
              results.errors.push(result);
            }
          } catch (err) {
            results.failed++;
            results.errors.push({
              order_sn: detail.order_sn || "unknown",
              error: err.message
            });
          }
        }
      } catch (err) {
        // Satu batch gagal, lanjut ke batch berikutnya
        results.failed += batch.length;
        results.errors.push({
          batch: batch.slice(0, 5).join(", ") + (batch.length > 5 ? "..." : ""),
          error: err.message
        });
      }
    }
  }

  return results;
}

// ============================================================
// DENO SERVE
// ============================================================
Deno.serve(async (_req) => {
  const startedAt = Date.now();
  let totalPulled = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const accountResults = [];
  let globalError = null;

  try {
    const activeAccounts = ACCOUNTS.filter(a => a.partner_id && a.shop_id);

    if (!activeAccounts.length) {
      return new Response(JSON.stringify({
        success: false,
        error: "Tidak ada akun Shopee yang dikonfigurasi"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    for (const account of activeAccounts) {
      try {
        const results = await pullOrdersForAccount(account);
        totalPulled += results.pulled;
        totalInserted += results.inserted;
        totalSkipped += results.skipped;
        totalFailed += results.failed;

        accountResults.push({
          account: account.label,
          shop_id: account.shop_id,
          ...results
        });
      } catch (err) {
        // Satu akun gagal, akun lain tetap diproses
        accountResults.push({
          account: account.label,
          shop_id: account.shop_id,
          pulled: 0,
          inserted: 0,
          skipped: 0,
          failed: 0,
          error: err.message
        });
      }
    }

    const duration = Date.now() - startedAt;

    // Activity log — pisah dari business logic
    try {
      await supabase.from("activity_log").insert({
        event_type: "ORDER_PULL",
        direction: "IN",
        platform: "shopee",
        status: totalFailed === 0 ? "success" : "failed",
        triggered_by: "system",
        action_source: "cron",
        duration_ms: duration,
        metadata: {
          pulled: totalPulled,
          inserted: totalInserted,
          skipped: totalSkipped,
          failed: totalFailed,
          accounts: accountResults.length
        }
      });
    } catch (logErr) {
      console.error("Activity log insert failed:", logErr.message);
    }

    return new Response(JSON.stringify({
      success: true,
      pulled: totalPulled,
      inserted: totalInserted,
      skipped: totalSkipped,
      failed: totalFailed
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    globalError = err.message;
    const duration = Date.now() - startedAt;

    try {
      await supabase.from("activity_log").insert({
        event_type: "ORDER_PULL",
        direction: "IN",
        platform: "shopee",
        status: "failed",
        triggered_by: "system",
        action_source: "cron",
        error_message: err.message,
        error_detail: err.stack || null,
        duration_ms: duration
      });
    } catch (logErr) {
      console.error("Activity log insert failed:", logErr.message);
    }

    return new Response(JSON.stringify({
      success: false,
      error: globalError
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
