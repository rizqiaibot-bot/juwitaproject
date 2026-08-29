// ============================================================
// Supabase Edge Function: shopee-pull-orders
// Deploy ke: supabase functions deploy shopee-pull-orders
// ============================================================
// Cara deploy:
//   1. supabase functions deploy shopee-pull-orders
//   2. Set ENV (sama dengan shopee-stock-sync):
//      SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID
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
const SHOPEE_API_URL = "https://partner.shopeemobile.com";

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
// Window pull diperluas ke 7 hari agar order READY_TO_SHIP yang baru dibuat
// tetap ditemukan (sebelumnya 24 jam sering menghasilkan pulled=0).
const PULL_HOURS_BACK = 168;

const RETRYABLE_STATUSES = [500, 502, 503, 504];

interface ShopeeAccount {
  label: string;
  shop_id: string;
  shop_name: string;
  partner_id: string;
  partner_key: string;
}

// Load semua akun Shopee aktif dari marketplace_config (platform='shopee').
// partner_id/partner_key TETAP dari env (1 partner akun untuk semua toko).
async function loadShopeeAccounts(): Promise<ShopeeAccount[]> {
  const partnerId = Deno.env.get("SHOPEE_PARTNER_ID") || "";
  const partnerKey = Deno.env.get("SHOPEE_PARTNER_KEY") || "";

  const { data, error } = await supabase
    .from("marketplace_config")
    .select("shop_id, shop_name, account_label, connection_status, is_active")
    .eq("platform", "shopee");

  if (error || !data) {
    console.error("loadShopeeAccounts error:", error ? error.message : "no data");
    return [];
  }

  const accounts: ShopeeAccount[] = (data || [])
    .filter((c: any) => c.is_active === true && c.connection_status === "connected" && c.shop_id)
    .map((c: any) => ({
      label: c.account_label || ("shopee_" + c.shop_id),
      shop_id: String(c.shop_id),
      shop_name: c.shop_name || null,
      partner_id: partnerId,
      partner_key: partnerKey,
    }));

  return accounts;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// CORS — izinkan frontend production Juwita One
// ============================================================
const FRONTEND_ORIGIN = Deno.env.get("FRONTEND_ORIGIN") || "https://juwitaproject.vercel.app";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// ============================================================
// SHOPEE HMAC SIGNATURE
// ============================================================
async function signShopee(partnerId: string, partnerKey: string, path: string, timestamp: number, accessToken = "", shopId = "") {
  // PARTNER signing (default): partner_id + path + timestamp
  // SHOP signing (endpoint ber-access_token): + access_token + shop_id
  const base = partnerId + path + timestamp + accessToken + shopId;
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

async function loadToken(shopId: string) {
  const { data, error } = await supabase
    .from("marketplace_credentials")
    .select("access_token, refresh_token")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error || !data) return { access_token: null, refresh_token: null };
  return { access_token: data.access_token || null, refresh_token: data.refresh_token || null };
}

async function refreshToken(account: ShopeeAccount, shopId: string, refreshToken: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/access_token/get";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp);
  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
  });
  const jsonBody = JSON.stringify({
    refresh_token: refreshToken,
    shop_id: Number(shopId),
    partner_id: Number(account.partner_id),
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const res = await fetch(`${SHOPEE_API_URL}${path}?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: jsonBody,
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  const body: any = await res.json();
  if (body.error || !body.access_token) {
    return { error: body.error || body.message || "refresh failed", access_token: null };
  }
  await supabase.from("marketplace_credentials").upsert({
    shop_id: shopId,
    platform: "shopee",
    access_token: body.access_token,
    refresh_token: body.refresh_token || refreshToken,
    updated_at: new Date().toISOString(),
  });
  return { error: null, access_token: body.access_token };
}

function isAuthError(text: string) {
  const lower = (text || "").toLowerCase();
  return lower.includes("access_token") || lower.includes("error_auth") || lower.includes("token_invalid") || lower.includes("token_expired");
}

// Error terstruktur dari Shopee (aman untuk di-log: tanpa token/sign)
function shopeeError(code: string, message: string, request_id?: string) {
  const e: any = new Error(message);
  e.code = code;
  e.request_id = request_id || "";
  return e;
}

// ============================================================
// FETCH DENGAN TIMEOUT & RETRY
// ============================================================
async function fetchWithRetry(url: string, options: Record<string, unknown> = {}, retries = MAX_RETRIES) {
  let lastError: Error;

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
    } catch (err: any) {
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

  throw lastError!;
}

// ============================================================
// GET ORDER LIST dari Shopee
// ============================================================
async function getOrderList(account: ShopeeAccount, timeFrom: number, timeTo: number, accessToken: string, offset = 0) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_list";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp, accessToken, account.shop_id);

  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
    shop_id: account.shop_id,
    access_token: accessToken,
    time_range_field: "create_time",
    time_from: String(timeFrom),
    time_to: String(timeTo),
    page_size: "100",
    pagination_offset: String(offset),
    order_status: "READY_TO_SHIP",
  });

  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  const body: any = await res.json();

  if (body.error) {
    throw shopeeError(body.error, `Shopee API error: ${body.error} - ${body.message || ""}`, body.request_id);
  }

  const orderList = body.response?.order_list || [];
  const hasMore = body.response?.more || false;

  return { orderList, hasMore };
}

// ============================================================
// GET ORDER LIST + auto-refresh token saat auth error (maks 1 retry)
// ============================================================
async function getOrderListWithAuth(
  account: ShopeeAccount,
  shopId: string,
  timeFrom: number,
  timeTo: number,
  accessToken: string,
  refreshTokenValue: string | null,
  offset: number,
) {
  try {
    const res = await getOrderList(account, timeFrom, timeTo, accessToken, offset);
    return { orderList: res.orderList, hasMore: res.hasMore, accessToken };
  } catch (err: any) {
    const msg = err && err.message ? err.message : String(err);
    const code = err && err.code ? err.code : "";
    if (!refreshTokenValue || !(isAuthError(msg) || isAuthError(code))) {
      throw err;
    }

    const r = await refreshToken(account, shopId, refreshTokenValue);
    if (!r.access_token) {
      throw shopeeError("token_refresh_failed", `Token refresh gagal: ${r.error || "unknown"}`);
    }

    const res = await getOrderList(account, timeFrom, timeTo, r.access_token, offset);
    return { orderList: res.orderList, hasMore: res.hasMore, accessToken: r.access_token };
  }
}

// ============================================================
// GET ORDER DETAIL dari Shopee (batch, support multiple order_sn)
// ============================================================
async function getOrderDetailBatch(account: ShopeeAccount, orderSns: string[], accessToken: string) {
  if (!orderSns.length) return { orderDetails: [] };

  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_detail";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp, accessToken, account.shop_id);

  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
    shop_id: account.shop_id,
    access_token: accessToken,
    order_sn_list: orderSns.join(","),
    response_optional_fields: "buyer_user_name,total_amount,item_list,recipient_address",
  });

  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  const body: any = await res.json();

  if (body.error) {
    throw new Error(`Shopee API error: ${body.error} - ${body.message || ""}`);
  }

  return { orderDetails: body.response?.order_list || [] };
}

// ============================================================
// SAVE ORDER ke marketplace_orders
// ============================================================
async function saveOrder(account: ShopeeAccount, orderDetail: any) {
  const mpOrderId = orderDetail.order_sn;
  if (!mpOrderId) return { status: "failed", error: "order_sn tidak ditemukan di response" };

  // Idempotent: cek dulu apakah order sudah pernah ditarik.
  const { data: existing } = await supabase
    .from("marketplace_orders")
    .select("id")
    .eq("platform", "shopee")
    .eq("mp_order_id", mpOrderId)
    .maybeSingle();

  if (existing) return { status: "skipped", order_sn: mpOrderId };

  const customerName = orderDetail.buyer_user_name ||
    orderDetail.recipient_address?.name ||
    null;

  const total = parseFloat(orderDetail.total_amount) || 0;
  const orderStatus = orderDetail.order_status || "READY_TO_SHIP";

  const { error: insertErr } = await supabase
    .from("marketplace_orders")
    .insert({
      platform: "shopee",
      mp_order_id: mpOrderId,
      customer_name: customerName,
      total: Math.round(total),
      order_status: orderStatus,
      sync_status: "pending",
      raw_payload: orderDetail,
    });

  if (insertErr) {
    // Duplicate violation (race antar concurrent pull) → dianggap skipped.
    if (insertErr.code === "23505") {
      return { status: "skipped", order_sn: mpOrderId };
    }
    return { status: "failed", order_sn: mpOrderId, error: insertErr.message };
  }

  return { status: "inserted", order_sn: mpOrderId, order_status: orderStatus };
}

// ============================================================
// AUTO-IMPORT: marketplace_orders → orders + order_items
// Idempotent: 1 mp_order_id hanya menghasilkan 1 orders.
// Guard: marketplace_orders.internal_order_id.
// wmsstatus awal = "Baru" (masuk Picking, BUKAN langsung Siap Kirim).
// ============================================================
async function autoImportOrder(account: ShopeeAccount, orderDetail: any) {
  const mpOrderId = orderDetail.order_sn;
  if (!mpOrderId) return { status: "failed", order_sn: mpOrderId, error: "order_sn tidak ditemukan" };

  // Guard idempotency
  const { data: moRow, error: moErr } = await supabase
    .from("marketplace_orders")
    .select("id, sync_status, internal_order_id")
    .eq("platform", "shopee")
    .eq("mp_order_id", mpOrderId)
    .maybeSingle();

  if (moErr) return { status: "failed", order_sn: mpOrderId, error: moErr.message };
  if (!moRow) return { status: "failed", order_sn: mpOrderId, error: "marketplace_orders row tidak ditemukan" };
  if (moRow.internal_order_id) {
    return { status: "skipped", order_sn: mpOrderId, reason: "already_imported" };
  }

  // Tandai processing
  await supabase.from("marketplace_orders")
    .update({ sync_status: "processing", updated_at: new Date().toISOString() })
    .eq("id", moRow.id);

  try {
    const items = Array.isArray(orderDetail.item_list) ? orderDetail.item_list : [];
    if (!items.length) throw new Error("item_list kosong");

    const { data: prods, error: prodErr } = await supabase
      .from("products")
      .select("id, name, price, stock, shopee_item_id")
      .not("shopee_item_id", "is", null);
    if (prodErr) throw new Error("gagal load produk: " + prodErr.message);

    const prodMap: Record<string, any> = {};
    (prods || []).forEach((p: any) => { prodMap[String(p.shopee_item_id)] = p; });

    const mapped: any[] = [];
    const stockById: Record<string, number> = {};
    const unmapped: any[] = [];
    for (const item of items) {
      const qty = item.model_quantity_purchased || 1;
      const prod = prodMap[String(item.item_id)];
      if (!prod) {
        unmapped.push({ shopee_item_id: item.item_id, name: item.item_name || item.model_sku || item.item_id });
        continue;
      }
      const price = prod.price || 0;
      mapped.push({ product_id: prod.id, product_name: prod.name, qty, price, subtotal: price * qty });
      stockById[String(prod.id)] = prod.stock || 0;
    }

    if (unmapped.length) {
      throw new Error("produk belum dimapping: " + JSON.stringify(unmapped));
    }
    if (!mapped.length) throw new Error("tidak ada item yang terpetakan");

    const total = mapped.reduce((s, i) => s + i.subtotal, 0);
    const now = new Date();
    const todayStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
    const dateStr = now.toISOString().slice(0, 10) + " " + now.toTimeString().slice(0, 5);
    const customer = orderDetail.buyer_user_name || orderDetail.recipient_address?.name || "Marketplace Customer";

    // Generate orderid unik (retry bila tabrakan PK orders.orderid)
    let orderId = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const { count } = await supabase
        .from("orders")
        .select("orderid", { count: "exact", head: true })
        .like("orderid", "ORD-" + todayStamp + "%");
      orderId = "ORD-" + todayStamp + "-" + String((count || 0) + 1).padStart(2, "0");

      const { error: insErr } = await supabase.from("orders").insert({
        orderid: orderId,
        date: dateStr,
        channel: "Shopee",
        customer,
        total,
        paystatus: "Lunas",
        wmsstatus: "Baru",
        courier: "Shopee",
        resi: "-",
      });
      if (!insErr) break;
      if (insErr.code === "23505") continue; // tabrakan orderid → coba angka berikutnya
      throw new Error("insert orders gagal: " + insErr.message);
    }
    if (!orderId) throw new Error("gagal generate orderid");

    // Insert order_items
    const oiRows = mapped.map((m) => ({
      orderid: orderId,
      product_id: m.product_id,
      product_name: m.product_name,
      qty: m.qty,
      price: m.price,
      subtotal: m.subtotal,
    }));
    const { error: oiErr } = await supabase.from("order_items").insert(oiRows);
    if (oiErr) {
      // rollback order agar retry tidak membuat duplikat
      await supabase.from("orders").delete().eq("orderid", orderId);
      throw new Error("insert order_items gagal: " + oiErr.message);
    }

    // Kurangi stok SATU KALI (langsung ke products, TANPA stock_mutations
    // agar tidak masuk antrean shopee-stock-sync / tidak push kembali ke Shopee)
    for (const m of mapped) {
      const cur = stockById[String(m.product_id)] || 0;
      const newStock = Math.max(0, cur - m.qty);
      await supabase.from("products").update({ stock: newStock }).eq("id", m.product_id);
    }

    // Tandai processed + internal_order_id
    await supabase.from("marketplace_orders")
      .update({ sync_status: "processed", internal_order_id: orderId, updated_at: new Date().toISOString() })
      .eq("id", moRow.id);

    return { status: "imported", order_sn: mpOrderId, internal_order_id: orderId };
  } catch (err: any) {
    await supabase.from("marketplace_orders")
      .update({ sync_status: "failed", error_message: err.message, updated_at: new Date().toISOString() })
      .eq("id", moRow.id);
    return { status: "failed", order_sn: mpOrderId, error: err.message };
  }
}

// ============================================================
// MAIN — pull orders untuk satu akun
// ============================================================
async function pullOrdersForAccount(account: ShopeeAccount) {
  const results: { pulled: number; inserted: number; skipped: number; imported: number; failed: number; errors: any[]; status_distribution: Record<string, number> } = {
    pulled: 0, inserted: 0, skipped: 0, imported: 0, failed: 0, errors: [], status_distribution: {}
  };

  const shopId = account.shop_id || "";
  let { access_token, refresh_token } = await loadToken(shopId);
  if (!access_token && refresh_token) {
    const r = await refreshToken(account, shopId, refresh_token);
    if (r.access_token) access_token = r.access_token;
  }
  if (!access_token) {
    throw shopeeError("token_unavailable", "access_token tidak tersedia dan refresh gagal");
  }

  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - PULL_HOURS_BACK * 3600;
  const timeTo = now;

  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { orderList, hasMore: more, accessToken: nextToken } = await getOrderListWithAuth(
      account, shopId, timeFrom, timeTo, access_token, refresh_token, offset
    );
    access_token = nextToken;
    hasMore = more;
    offset += orderList.length;

    const newOrderSns = orderList.map((o: any) => o.order_sn).filter(Boolean);
    results.pulled += newOrderSns.length;

    if (!newOrderSns.length) break;

    // Batch getOrderDetail (max 50 per call)
    const batchSize = 50;
    for (let i = 0; i < newOrderSns.length; i += batchSize) {
      const batch = newOrderSns.slice(i, i + batchSize);

      try {
        const { orderDetails } = await getOrderDetailBatch(account, batch, access_token);

        for (const detail of orderDetails) {
          const st = detail.order_status || "UNKNOWN";
          results.status_distribution[st] = (results.status_distribution[st] || 0) + 1;
          try {
            const result = await saveOrder(account, detail);
            if (result.status === "inserted") {
              results.inserted++;
              const imp = await autoImportOrder(account, detail);
              if (imp.status === "imported") results.imported++;
              else if (imp.status === "failed") {
                results.failed++;
                results.errors.push(imp);
              }
            } else if (result.status === "skipped") results.skipped++;
            else {
              results.failed++;
              results.errors.push(result);
            }
          } catch (err: any) {
            results.failed++;
            results.errors.push({
              order_sn: detail.order_sn || "unknown",
              error: err.message
            });
          }
        }
      } catch (err: any) {
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
Deno.serve(async (req) => {
  // Preflight CORS: jangan jalankan logic Shopee / akses database
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  const startedAt = Date.now();
  let totalPulled = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalImported = 0;
  let totalFailed = 0;
  const accountResults: any[] = [];
  let globalError: string | null = null;

  try {
    const activeAccounts = await loadShopeeAccounts();
    const usableAccounts = activeAccounts.filter(a => a.partner_id && a.shop_id);

    // Fallback: jika marketplace_config tidak terbaca dan tidak ada akun,
    // gunakan env legacy (hanya 1 akun) — TANPA risiko double (env ≠ config).
    if (!usableAccounts.length && (Deno.env.get("SHOPEE_PARTNER_ID") && Deno.env.get("SHOPEE_SHOP_ID"))) {
      usableAccounts.push({
        label: "toko_1",
        shop_id: Deno.env.get("SHOPEE_SHOP_ID") || "",
        shop_name: null,
        partner_id: Deno.env.get("SHOPEE_PARTNER_ID") || "",
        partner_key: Deno.env.get("SHOPEE_PARTNER_KEY") || "",
      });
    }

    if (!usableAccounts.length) {
      return new Response(JSON.stringify({
        success: false,
        error: "Tidak ada akun Shopee yang dikonfigurasi"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    let hasAccountError = false;

    for (const account of usableAccounts) {
      try {
        const results = await pullOrdersForAccount(account);
        totalPulled += results.pulled;
        totalInserted += results.inserted;
        totalSkipped += results.skipped;
        totalImported += results.imported;
        totalFailed += results.failed;

        accountResults.push({
          account: account.label,
          shop_id: account.shop_id,
          success: true,
          ...results
        });
      } catch (err: any) {
        // Satu akun gagal, akun lain tetap diproses — error DITAMPILKAN (tidak ditelan).
        const code = err && err.code ? err.code : "account_error";
        const message = err && err.message ? err.message : String(err);
        const request_id = err && err.request_id ? err.request_id : "";
        console.error(`[shopee-pull-orders] account=${account.label} endpoint=get_order_list error=${code} request_id=${request_id} message=${message}`);
        hasAccountError = true;
        totalFailed += 1;
        accountResults.push({
          account: account.label,
          shop_id: account.shop_id,
          success: false,
          pulled: 0,
          inserted: 0,
          skipped: 0,
          imported: 0,
          failed: 1,
          error: { code, message, request_id }
        });
      }
    }

    const duration = Date.now() - startedAt;

    // Activity log — pisah dari business logic
    const accountErrorSummary = accountResults
      .filter(a => a.success === false)
      .map(a => `[${a.account}] ${a.error?.code || "account_error"}: ${a.error?.message || ""}`)
      .join("; ");

    try {
      await supabase.from("activity_log").insert({
        event_type: "ORDER_PULL",
        direction: "IN",
        platform: "shopee",
        status: (totalFailed === 0 && !hasAccountError) ? "success" : "failed",
        triggered_by: "system",
        action_source: "cron",
        duration_ms: duration,
        error_message: accountErrorSummary || null,
        metadata: {
          pulled: totalPulled,
          inserted: totalInserted,
          skipped: totalSkipped,
          imported: totalImported,
          failed: totalFailed,
          accounts: accountResults.length,
          status_distribution: (accountResults.length === 1 ? accountResults[0].status_distribution : undefined) || {}
        }
      });
    } catch (logErr: any) {
      console.error("Activity log insert failed:", logErr.message);
    }

    return new Response(JSON.stringify({
      success: !hasAccountError && totalFailed === 0,
      pulled: totalPulled,
      inserted: totalInserted,
      skipped: totalSkipped,
      imported: totalImported,
      failed: totalFailed,
      status_distribution: (accountResults.length === 1 ? accountResults[0].status_distribution : undefined) || {},
      accountResults: accountResults.map(a => ({
        account: a.account,
        shop_id: a.shop_id,
        success: a.success,
        pulled: a.pulled || 0,
        inserted: a.inserted || 0,
        skipped: a.skipped || 0,
        imported: a.imported || 0,
        failed: a.failed || 0,
        ...(a.error ? { error: a.error } : {})
      }))
    }), {
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });

  } catch (err: any) {
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
    } catch (logErr: any) {
      console.error("Activity log insert failed:", logErr.message);
    }

    return new Response(JSON.stringify({
      success: false,
      error: globalError
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  }
});
