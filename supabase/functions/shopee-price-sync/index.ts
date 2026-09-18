// ============================================================
// Supabase Edge Function: shopee-price-sync
// Deploy: supabase functions deploy shopee-price-sync
// ============================================================
// Tujuan:
//   Sinkronisasi HARGA produk dari public.product_prices ke
//   Shopee 1 dan Shopee 2. HANYA harga; tidak menyentuh stok,
//   SKU, barcode, orders, order_items, atau products.price.
//
// ENV yang dibutuhkan (sama dengan shopee-stock-sync):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY
//   FRONTEND_ORIGIN (opsional, default https://juwitaproject.vercel.app)
//
// MODE PEMANGGILAN (POST JSON):
//   { "dry_run": true }                          -> simulasi, tidak kirim API
//   { "product_id": 123 }                        -> satu produk (semua channel Shopee)
//   { "product_ids": [1,2], "channels": ["shopee:724153261"] }
//   { }                                          -> semua antrean pending/failed
//
// KEAMANAN:
//   - Hanya owner aktif (app_users.role='owner' + status ACTIVE) yang boleh.
//   - Credential Shopee HANYA dari env / marketplace_credentials (server-side).
//   - Tidak pernah mengembalikan token/sign ke pemanggil.
//
// CATATAN ENDPOINT:
//   Endpoint: POST /api/v2/product/update_price
//   Params (query string, sama pola dengan product/update_stock):
//     partner_id, timestamp, sign, shop_id, access_token, item_id, price_list
//   price_list = JSON array: [{ "model_id": 0, "original_price": <number> }]
//   Signing: HMAC-SHA256(partner_id + path + timestamp + access_token + shop_id)
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_API_URL = "https://partner.shopeemobile.com/api/v2";
const FRONTEND_ORIGIN = Deno.env.get("FRONTEND_ORIGIN") || "https://juwitaproject.vercel.app";

const REQUEST_DELAY_MS = 120;
const FETCH_TIMEOUT_MS = 15000;
const MAX_QUEUE_ROWS = 500;
const MAX_ATTEMPTS = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Sembunyikan token/JWT/signed URL dan potong panjang pesan error dari Shopee.
// JANGAN pernah menyimpan access_token, partner key, signature, atau URL bertanda tangan.
function sanitizeError(v: unknown): string {
  let s = typeof v === "string" ? v : (v && (v as any).message) || String(v || "");
  s = s.replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[redacted]");
  s = s.replace(
    /(access_token|refresh_token|partner_key|partner_id|sign|timestamp)=[^&\s"]+/gi,
    "$1=[redacted]",
  );
  s = s.replace(/https?:\/\/[^\s"]*[?&](sign|access_token|partner_key)=[^\s"]*/gi, "[redacted-url]");
  return s.slice(0, 300);
}

// Ringkasan error Shopee yang aman: error code, message, request_id, HTTP status,
// channel, dan product_id. Semua field sudah disanitasi.
function buildShopeeErrorSummary(r: any, it: any): string {
  const code = r?.error_code || r?.error || "unknown";
  const parts = [
    `error=${sanitizeError(code)}`,
    r?.message ? `message=${sanitizeError(r.message)}` : null,
    r?.request_id ? `request_id=${sanitizeError(r.request_id)}` : null,
    r?.http_status != null ? `http=${r.http_status}` : null,
    `channel=${it.channel}`,
    `product_id=${it.product_id}`,
  ].filter(Boolean) as string[];
  return parts.join(" | ").slice(0, 500);
}

// ============================================================
// SHOPEE SIGNATURE (sama dengan integrasi yang sudah ada)
// ============================================================
async function signShopee(account: any, path: string, timestamp: number, accessToken = "", shopId = "") {
  const base = account.partner_id + path + timestamp + accessToken + shopId;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(account.partner_key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// AKUN SHOPEE (dari marketplace_config yang connected)
// partner_id/partner_key dari env (2 toko, 1 partner Shopee)
// ============================================================
async function loadShopeeAccounts() {
  const partnerId = Deno.env.get("SHOPEE_PARTNER_ID") || "";
  const partnerKey = Deno.env.get("SHOPEE_PARTNER_KEY") || "";
  const { data, error } = await supabase
    .from("marketplace_config")
    .select("shop_id, shop_name")
    .eq("platform", "shopee")
    .eq("connection_status", "connected");
  if (error) {
    console.error("loadShopeeAccounts error:", error.message);
    return [] as any[];
  }
  return (data || [])
    .filter((a) => a.shop_id)
    .map((a) => ({
      account: String(a.shop_id),
      shop_id: String(a.shop_id),
      shop_name: a.shop_name || null,
      partner_id: partnerId,
      partner_key: partnerKey,
    }));
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

async function refreshToken(account: any, shopId: string, refreshTokenValue: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/access_token/get";
  const sign = await signShopee(account, path, timestamp);
  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
  });
  const body = {
    refresh_token: refreshTokenValue,
    shop_id: Number(shopId),
    partner_id: Number(account.partner_id),
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(`${SHOPEE_API_URL}/auth/access_token/get?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  const jsonBody = await res.json().catch(() => ({}));
  if (jsonBody.error || !jsonBody.access_token) {
    return { error: jsonBody.error || jsonBody.message || "refresh failed", access_token: null };
  }
  await supabase.from("marketplace_credentials").upsert({
    shop_id: shopId,
    platform: "shopee",
    access_token: jsonBody.access_token,
    refresh_token: jsonBody.refresh_token || refreshTokenValue,
    updated_at: new Date().toISOString(),
  });
  return { error: null, access_token: jsonBody.access_token };
}

function isAuthError(text: string) {
  const lower = (text || "").toLowerCase();
  return lower.includes("access_token") || lower.includes("error_auth") ||
    lower.includes("token_invalid") || lower.includes("token_expired");
}

// Baca info banyak item Shopee (READ-ONLY) untuk preview: has_model + harga saat ini.
// itemIds maksimum 50 per panggilan (batas Shopee).
async function fetchShopeeItemBatchInfo(account: any, shopId: string, itemIds: string[]) {
  let { access_token, refresh_token } = await loadToken(shopId);
  if (!access_token && refresh_token) {
    const r = await refreshToken(account, shopId, refresh_token);
    if (r.access_token) access_token = r.access_token;
  }
  if (!access_token) return { error: "access_token tidak tersedia", items: [] as any[] };

  const path = "/api/v2/product/get_item_base_info";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await signShopee(account, path, timestamp, access_token, shopId);
  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
    access_token,
    shop_id: shopId,
    item_id_list: itemIds.join(","),
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(`https://partner.shopeemobile.com/api/v2/product/get_item_base_info?${params}`, {
    method: "GET",
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    return { error: sanitizeError(body.error || body.message || `HTTP ${res.status}`), items: [] as any[] };
  }
  const items = ((body.response && body.response.item_list) || []).map((item: any) => {
    const priceInfo = (item.price_info && item.price_info[0]) || {};
    const models = Array.isArray(item.model_list) ? item.model_list : [];
    return {
      item_id: String(item.item_id),
      has_model: !!item.has_model,
      model_count: models.length,
      current_price: priceInfo.current_price != null ? Number(priceInfo.current_price) : null,
      original_price: priceInfo.original_price != null ? Number(priceInfo.original_price) : null,
      item_status: item.item_status != null ? item.item_status : null,
    };
  });
  return { error: null, items };
}

// ============================================================
// PUSH HARGA KE SATU AKUN SHOPEE
// items: [{ queue_id, product_id, channel, shopee_item_id, price }]
// return: Map<queue_id, { ok, error }>
// ============================================================
async function updateShopeePriceBatch(account: any, items: any[]) {
  const results = new Map<number, { ok: boolean; error?: string }>();
  if (!account || !account.partner_id) {
    for (const it of items) results.set(it.queue_id, { ok: false, error: "akun Shopee tidak lengkap" });
    return results;
  }

  const shopId = account.shop_id || "";
  let { access_token, refresh_token } = await loadToken(shopId);
  if (!access_token && refresh_token) {
    const r = await refreshToken(account, shopId, refresh_token);
    if (r.access_token) access_token = r.access_token;
  }
  if (!access_token) {
    for (const it of items) results.set(it.queue_id, { ok: false, error: "access_token tidak tersedia" });
    return results;
  }

  const path = "/api/v2/product/update_price";
  let token = access_token;
  let refreshed = false;
  let isFirst = true;

  const callOne = async (it: any, useToken: string) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await signShopee(account, path, timestamp, useToken, shopId);
    const params = new URLSearchParams({
      partner_id: account.partner_id,
      timestamp: String(timestamp),
      sign,
      shop_id: shopId,
      access_token: useToken,
    });
    // item_id & price_list dikirim di JSON request body (kontrak resmi update_price).
    // Query string hanya untuk auth/sign. model_id sengaja tidak dikirim untuk
    // percobaan pertama (item tanpa varian).
    const reqBody = {
      item_id: Number(it.shopee_item_id),
      price_list: [{ original_price: Number(it.price) }],
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${SHOPEE_API_URL}/product/update_price?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const body = await res.json().catch(() => ({}));
    const failure = body && body.response && Array.isArray(body.response.failure_list) && body.response.failure_list.length > 0;
    if (!res.ok || body.error || failure) {
      const raw = body.error || (failure ? JSON.stringify(body.response.failure_list) : `HTTP ${res.status}`);
      const requestId = body.request_id || body.requestId || (body.response && body.response.request_id) || null;
      return {
        ok: false as const,
        error: sanitizeError(raw),
        error_code: body.error || null,
        message: body.message ? sanitizeError(body.message) : null,
        request_id: requestId ? sanitizeError(requestId) : null,
        http_status: res.status,
        authError: isAuthError(`${body.error || ""} ${body.message || ""}`),
      };
    }
    return { ok: true as const };
  };

  for (const it of items) {
    try {
      if (!isFirst) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      isFirst = false;

      let r = await callOne(it, token);

      // Sekali refresh bila error auth
      if (!r.ok && r.authError && !refreshed && refresh_token) {
        refreshed = true;
        const rr = await refreshToken(account, shopId, refresh_token);
        if (rr.access_token) {
          token = rr.access_token;
          r = await callOne(it, token);
        }
      }

      if (r.ok) {
        results.set(it.queue_id, { ok: true });
      } else {
        results.set(it.queue_id, {
          ok: false,
          error: r.error || "gagal update harga",
          error_code: r.error_code || null,
          message: r.message || null,
          request_id: r.request_id || null,
          http_status: r.http_status != null ? r.http_status : null,
        });
      }
    } catch (err: any) {
      results.set(it.queue_id, {
        ok: false,
        error: sanitizeError(err && err.message ? err.message : err),
        error_code: null,
        message: null,
        request_id: null,
        http_status: null,
      });
    }
  }

  return results;
}

// ============================================================
// OWNER CHECK
// ============================================================
async function assertOwner(req: Request) {
  const auth = req.headers.get("Authorization") || req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, message: "Unauthorized" };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return { ok: false, status: 401, message: "Unauthorized" };
  const { data: row } = await supabase
    .from("app_users")
    .select("role, status")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();
  if (!row || String(row.role || "").toLowerCase() !== "owner" || String(row.status || "").toUpperCase() !== "ACTIVE") {
    return { ok: false, status: 403, message: "Hanya owner yang dapat menjalankan sinkronisasi harga" };
  }
  return { ok: true };
}

// ============================================================
// MAIN
// ============================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const startedAt = Date.now();
  const batchId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
  let lockAcquired = false;

  try {
    const owner = await assertOwner(req);
    if (!owner.ok) return json({ error: owner.message }, owner.status || 403);

    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }

    const dryRun = body.dry_run === true;
    const productId = body.product_id != null ? Number(body.product_id) : null;
    const productIds: number[] = Array.isArray(body.product_ids)
      ? body.product_ids.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n))
      : (productId != null && Number.isFinite(productId) ? [productId] : []);
    const channels: string[] = Array.isArray(body.channels)
      ? body.channels.map((c: any) => String(c)).filter((c: string) => c.startsWith("shopee:"))
      : [];

    // ---- MODE PREVIEW (read-only: cek has_model + harga Shopee saat ini) ----
    if (body.action === "preview") {
      const ids = productIds.length ? productIds : [];
      if (!ids.length) return json({ error: "product_id / product_ids wajib" }, 400);
      const wantedChannels = channels.length ? channels : ["shopee:724153261", "shopee:1214362884"];
      const previewAccounts = await loadShopeeAccounts();
      const out: any[] = [];
      for (const channel of wantedChannels) {
        const shopId = channel.split(":")[1] || "";
        const account = previewAccounts.find((a: any) => a.shop_id === shopId);
        if (!account) { out.push({ channel, error: "akun Shopee tidak connected" }); continue; }
        const { data: maps, error: mErr } = await supabase
          .from("product_shopee_mapping")
          .select("product_id, shopee_item_id")
          .eq("shop_id", shopId)
          .in("product_id", ids);
        if (mErr) throw mErr;
        const productByItem = new Map<string, number>();
        const itemIds: string[] = [];
        for (const m of maps || []) {
          if (m.shopee_item_id == null) continue;
          const s = String(m.shopee_item_id);
          itemIds.push(s);
          productByItem.set(s, m.product_id);
        }
        for (let i = 0; i < itemIds.length; i += 50) {
          const batch = itemIds.slice(i, i + 50);
          const info = await fetchShopeeItemBatchInfo(account, shopId, batch);
          if (info.error) { out.push({ channel, error: info.error }); continue; }
          for (const it of info.items) {
            out.push({
              channel,
              product_id: productByItem.get(it.item_id) ?? null,
              item_id: it.item_id,
              has_model: it.has_model,
              model_count: it.model_count,
              current_price: it.current_price,
              original_price: it.original_price,
              item_status: it.item_status,
            });
          }
        }
      }
      return json({ count: out.length, items: out });
    }

    // Lock khusus price sync (berbasis tabel; aman lintas koneksi pooler)
    const lock = await supabase.rpc("price_sync_lock_acquire");
    if (lock.error || !lock.data) {
      return json({ error: "Sinkronisasi harga lain sedang berjalan", hint: "Coba lagi beberapa saat." }, 429);
    }
    lockAcquired = true;

    // ---- Ambil antrean ----
    let q = supabase
      .from("product_price_sync_queue")
      .select("id, product_id, channel, target_price, status, attempts, last_synced_price")
      .in("status", ["pending", "failed"])
      .like("channel", "shopee:%")
      .order("updated_at", { ascending: true })
      .limit(MAX_QUEUE_ROWS);
    if (channels.length) q = q.in("channel", channels);
    if (productIds.length) q = q.in("product_id", productIds);

    const { data: queue, error: qErr } = await q;
    if (qErr) throw qErr;

    const summary: any = {
      batch_id: batchId,
      dry_run: dryRun,
      scanned: queue?.length || 0,
      synced: 0,
      failed: 0,
      skipped: 0,
      no_mapping: 0,
      invalid_price: 0,
      by_channel: {},
      details: [] as any[],
    };

    if (!queue || queue.length === 0) {
      return json({ ...summary, message: "Tidak ada antrean harga" });
    }

    // ---- Data pendukung ----
    const productKeySet = [...new Set(queue.map((r) => r.product_id))];

    const { data: priceRows, error: priceErr } = await supabase
      .from("product_prices")
      .select("product_id, channel, price")
      .in("product_id", productKeySet);
    if (priceErr) throw priceErr;
    const priceMap = new Map<string, number>();
    for (const p of priceRows || []) priceMap.set(`${p.product_id}|${p.channel}`, Number(p.price));

    const { data: mapRows, error: mapErr } = await supabase
      .from("product_shopee_mapping")
      .select("product_id, shop_id, shopee_item_id")
      .in("product_id", productKeySet);
    if (mapErr) throw mapErr;
    const mapByKey = new Map<string, any>();
    for (const m of mapRows || []) mapByKey.set(`${m.product_id}|${m.shop_id}`, m);

    const accounts = await loadShopeeAccounts();
    const accountByShop = new Map<string, any>();
    for (const a of accounts) accountByShop.set(a.shop_id, a);

    // ---- Bangun item per shop ----
    const perShop = new Map<string, any[]>();
    const syncedNoCall: any[] = [];
    const toSkip: { id: number; channel: string; reason: string }[] = [];

    for (const row of queue) {
      const price = priceMap.get(`${row.product_id}|${row.channel}`);
      if (price == null || !Number.isFinite(price) || !Number.isInteger(price) || price < 0) {
        toSkip.push({ id: row.id, channel: row.channel, reason: "harga tidak valid / kosong" });
        summary.invalid_price++;
        continue;
      }
      // Idempotensi: harga sama dengan yang terakhir sukses -> tidak perlu kirim ulang.
      if (row.last_synced_price != null && Number(row.last_synced_price) === price) {
        syncedNoCall.push({ id: row.id, price });
        continue;
      }
      const shopId = String(row.channel).split(":")[1] || "";
      const mapping = mapByKey.get(`${row.product_id}|${shopId}`);
      if (!mapping || mapping.shopee_item_id == null) {
        toSkip.push({ id: row.id, channel: row.channel, reason: "belum ada mapping Shopee" });
        summary.no_mapping++;
        continue;
      }
      if (!accountByShop.has(shopId)) {
        toSkip.push({ id: row.id, channel: row.channel, reason: "akun Shopee tidak connected" });
        continue;
      }
      if ((row.attempts || 0) >= MAX_ATTEMPTS) {
        toSkip.push({ id: row.id, channel: row.channel, reason: `melebihi batas ${MAX_ATTEMPTS} percobaan` });
        continue;
      }
      if (!perShop.has(shopId)) perShop.set(shopId, []);
      perShop.get(shopId)!.push({
        queue_id: row.id,
        product_id: row.product_id,
        channel: row.channel,
        shopee_item_id: mapping.shopee_item_id,
        price,
      });
    }

    // ---- Kirim per akun ----
    const resultByQueueId = new Map<number, { ok: boolean; error?: string }>();
    if (dryRun) {
      for (const [, items] of perShop) {
        for (const it of items) resultByQueueId.set(it.queue_id, { ok: true, error: "dry_run" });
      }
    } else {
      for (const [shopId, items] of perShop) {
        const account = accountByShop.get(shopId);
        const res = await updateShopeePriceBatch(account, items);
        for (const [k, v] of res) resultByQueueId.set(k, v);
      }
    }

    // ---- Update antrean ----
    // Saat dry_run: TIDAK ada mutasi DB sama sekali (tidak boleh "synced palsu").
    const nowIso = new Date().toISOString();
    const logEntries: any[] = [];
    const accountLabel = (shopId: string) => accountByShop.get(shopId)?.shop_name || shopId;

    for (const [shopId, items] of perShop) {
      let chSynced = 0, chFailed = 0;
      for (const it of items) {
        const r = resultByQueueId.get(it.queue_id);
        const isOk = r ? r.ok : false;
        if (isOk) {
          chSynced++;
          if (!dryRun) {
            await supabase.from("product_price_sync_queue").update({
              status: "synced",
              attempts: (queue.find((x) => x.id === it.queue_id)?.attempts || 0) + 1,
              last_error: null,
              last_synced_price: it.price,
              synced_at: nowIso,
            }).eq("id", it.queue_id);
          }
        } else {
          chFailed++;
          if (!dryRun) {
            const prevAttempts = queue.find((x) => x.id === it.queue_id)?.attempts || 0;
            const errSummary = buildShopeeErrorSummary(r, it);
            await supabase.from("product_price_sync_queue").update({
              status: "failed",
              attempts: prevAttempts + 1,
              last_error: errSummary,
            }).eq("id", it.queue_id);
            logEntries.push({
              sync_batch_id: batchId,
              event_type: "PRICE_SYNC_FAILED",
              direction: "OUT",
              platform: "shopee",
              shop_id: shopId,
              product_id: it.product_id,
              reference_id: String(it.shopee_item_id),
              status: "failed",
              triggered_by: "owner",
              action_source: "edge_function",
              error_message: errSummary,
              error_detail: JSON.stringify({
                error: r?.error_code || r?.error || null,
                message: r?.message || null,
                request_id: r?.request_id || null,
                http_status: r?.http_status ?? null,
                channel: it.channel,
                product_id: it.product_id,
                item_id: String(it.shopee_item_id),
                target_price: it.price,
              }),
              metadata: {
                item_id: it.shopee_item_id,
                channel: it.channel,
                request_id: r?.request_id || null,
                http_status: r?.http_status ?? null,
                old_price: queue.find((x) => x.id === it.queue_id)?.last_synced_price ?? null,
                new_price: it.price,
              },
            });
          }
        }
      }
      summary.synced += chSynced;
      summary.failed += chFailed;
      summary.by_channel[items[0]?.channel] = { synced: chSynced, failed: chFailed };
      if (!dryRun) {
        logEntries.push({
          sync_batch_id: batchId,
          event_type: "PRICE_SYNC",
          direction: "OUT",
          platform: "shopee",
          shop_id: shopId,
          reference_id: accountLabel(shopId),
          status: chFailed === 0 ? "success" : "failed",
          triggered_by: "owner",
          action_source: "edge_function",
          duration_ms: Date.now() - startedAt,
          metadata: { synced: chSynced, failed: chFailed, dry_run: false },
        });
      }
    }

    // Idempotent (harga sama, tidak dikirim ulang)
    for (const s of syncedNoCall) {
      summary.synced++;
      if (!dryRun) {
        await supabase.from("product_price_sync_queue").update({
          status: "synced",
          last_error: null,
          synced_at: nowIso,
        }).eq("id", s.id);
      }
    }

    // Skip (tanpa mapping / invalid / akun tidak connected)
    for (const s of toSkip) {
      summary.skipped++;
      summary.details.push({ channel: s.channel, reason: s.reason });
      if (!dryRun) {
        await supabase.from("product_price_sync_queue").update({
          status: "skipped",
          last_error: s.reason,
        }).eq("id", s.id);
      }
    }

    // ---- Activity log + last_sync_at (hanya saat live, bukan dry_run) ----
    if (!dryRun && logEntries.length) {
      try { await supabase.from("activity_log").insert(logEntries); } catch (e: any) {
        console.error("activity_log insert failed:", e?.message || e);
      }
    }
    if (!dryRun) {
      for (const shopId of perShop.keys()) {
        await supabase.from("marketplace_config")
          .update({ last_sync_at: nowIso })
          .eq("platform", "shopee")
          .eq("shop_id", shopId);
      }
    }

    summary.message = `synced=${summary.synced} failed=${summary.failed} skipped=${summary.skipped}`;
    return json(summary);
  } catch (err: any) {
    console.error("shopee-price-sync error:", err?.message || err);
    return json({ error: sanitizeError(err?.message || err) }, 500);
  } finally {
    if (lockAcquired) {
      try { await supabase.rpc("price_sync_lock_release"); } catch { /* ignore */ }
    }
  }
});
