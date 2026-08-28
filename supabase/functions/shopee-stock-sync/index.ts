// ============================================================
// Supabase Edge Function: shopee-stock-sync
// Deploy ke: supabase functions deploy shopee-stock-sync
// ============================================================
// Cara deploy:
//   1. npm install -g supabase
//   2. supabase login
//   3. supabase functions deploy shopee-stock-sync
//   4. Set ENV:
//      SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID
// ============================================================
// CATATAN KE DEPAN:
//   - Status "processing" di stock_mutations.sync_status dapat
//     ditambahkan di fase berikutnya jika diperlukan visibility
//     real-time. Saat ini cukup dengan pending → synced/failed.
//   - Advisory lock (lock ID: 987654321) mencegah concurrent execution.
//     Jika lock tidak dilepas (crash), PostgreSQL otomatis release
//     saat session berakhir. Aman tanpa cleanup handler.
//   - Lock ID ini EKSKLUSIF untuk Edge Function ini. Jangan digunakan
//     oleh proses/function lain.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_API_URL = "https://partner.shopeemobile.com/api/v2";

const REQUEST_DELAY_MS = 100;
const FETCH_TIMEOUT_MS = 15000;

// Daftar toko dibangun dinamis dari marketplace_config (connected).
// partner_id/partner_key tetap dari env (2 toko = 1 partner akun Shopee).
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
    return [];
  }
  return (data || [])
    .filter(a => a.shop_id)
    .map(a => ({
      account: String(a.shop_id),
      shop_id: String(a.shop_id),
      shop_name: a.shop_name || null,
      partner_id: partnerId,
      partner_key: partnerKey,
    }));
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

async function signShopee(account, path, timestamp, accessToken = "", shopId = "") {
  const base = account.partner_id + path + timestamp + accessToken + shopId;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(account.partner_key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function loadToken(shopId) {
  const { data, error } = await supabase
    .from("marketplace_credentials")
    .select("access_token, refresh_token")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error || !data) return { access_token: null, refresh_token: null };
  return { access_token: data.access_token || null, refresh_token: data.refresh_token || null };
}

async function refreshToken(account, shopId, refreshToken) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/access_token/get";
  const sign = await signShopee(account, path, timestamp);
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
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(`${SHOPEE_API_URL}/auth/access_token/get?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: jsonBody,
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  const body = await res.json();
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

function isAuthError(text) {
  const lower = (text || "").toLowerCase();
  return lower.includes("access_token") || lower.includes("error_auth") || lower.includes("token_invalid") || lower.includes("token_expired");
}

async function updateShopeeBatch(account, items) {
  if (!account || !account.partner_id) return { synced: 0, failed: 0, errors: [] };

  const shopId = account.shop_id || "";
  let { access_token, refresh_token } = await loadToken(shopId);
  if (!access_token && refresh_token) {
    const r = await refreshToken(account, shopId, refresh_token);
    if (r.access_token) access_token = r.access_token;
  }
  if (!access_token) {
    return { synced: 0, failed: items.length, errors: [{ shopee_item_id: null, error: "access_token tidak tersedia" }] };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_stock";
  const sign = await signShopee(account, path, timestamp, access_token, shopId);

  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
    shop_id: shopId,
    access_token,
  });

  let synced = 0, failed = 0;
  const errors = [];
  let isFirstRequest = true;
  let refreshed = false;

  for (const item of items) {
    if (item.shopee_item_id != null) {
      try {
        if (!isFirstRequest) {
          await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
        }
        isFirstRequest = false;

        const stockParams = new URLSearchParams(params);
        stockParams.set("item_id", String(item.shopee_item_id));
        stockParams.set("stock_list", JSON.stringify([{ model_id: 0, normal_stock: item.qty_after }]));
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(`${SHOPEE_API_URL}/product/update_stock?${stockParams}`, { method: "POST", signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errText = await res.text();
          if (!refreshed && refresh_token && isAuthError(errText)) {
            refreshed = true;
            const r = await refreshToken(account, shopId, refresh_token);
            if (r.access_token) {
              // Signature update_stock mencakup access_token → hitung ulang timestamp+sign
              // dengan access_token BARU agar tidak "Wrong sign" pada retry.
              const retryTs = Math.floor(Date.now() / 1000);
              const retrySign = await signShopee(account, path, retryTs, r.access_token, shopId);
              const retryParams = new URLSearchParams({
                partner_id: account.partner_id,
                timestamp: String(retryTs),
                sign: retrySign,
                shop_id: shopId,
                access_token: r.access_token,
              });
              retryParams.set("item_id", String(item.shopee_item_id));
              retryParams.set("stock_list", JSON.stringify([{ model_id: 0, normal_stock: item.qty_after }]));
              const c2 = new AbortController();
              const t2 = setTimeout(() => c2.abort(), FETCH_TIMEOUT_MS);
              const res2 = await fetch(`${SHOPEE_API_URL}/product/update_stock?${retryParams}`, { method: "POST", signal: c2.signal });
              clearTimeout(t2);
              if (res2.ok) { synced++; continue; }
              // Log retry aman: status + ringkasan error, TANPA token/signature.
              const err2 = await res2.text();
              const safeErr2 = (err2 || "").slice(0, 300);
              console.error(`update_stock retry failed shop=${shopId} item=${item.shopee_item_id} status=${res2.status} body=${safeErr2}`);
              errors.push({ shopee_item_id: item.shopee_item_id, error: `retry after refresh failed (status ${res2.status}): ${safeErr2}` });
              failed++;
              continue;
            }
          }
          errors.push({ shopee_item_id: item.shopee_item_id, error: errText });
          failed++;
        } else {
          synced++;
        }
      } catch (err) {
        errors.push({ shopee_item_id: item.shopee_item_id, error: err.message });
        failed++;
      }
    }
  }

  return { synced, failed, errors };
}

Deno.serve(async (req) => {
  // Preflight CORS: jangan jalankan logic Shopee / akses database
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  const startedAt = Date.now();
  const syncBatchId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  let totalSynced = 0;
  let totalFailed = 0;
  const syncResults = [];
  let lockAcquired = false;

  try {
    // ============================================================
    // MODE TEST (sync_test) — batasi hanya ke product_id yang diizinkan
    // ============================================================
    let testProductIds: number[] | null = null;
    try {
      const body = await req.json();
      const bodyAction = body && body.action;
      const bodyProductIds = body && Array.isArray(body.product_ids) ? body.product_ids : [];
      if (bodyAction === "sync_test") {
        const onlyAllowed = bodyProductIds.every((v: any) => Number(v) === 6);
        if (bodyProductIds.length > 0 && onlyAllowed) {
          testProductIds = [6];
        } else {
          return new Response(JSON.stringify({
            message: "sync_test hanya mengizinkan product_ids = [6]",
          }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders() }
          });
        }
      }
    } catch {
      // body bukan JSON → abaikan, jalankan mode normal (untuk pemicu cron)
    }

    // ============================================================
    // ADVISORY LOCK — cegah concurrent execution
    // ============================================================
    const lockResult = await supabase.rpc("sync_lock_acquire");

    if (lockResult.error || !lockResult.data) {
      return new Response(JSON.stringify({
        message: "Sync already running",
        hint: "Another sync process is in progress. Try again in 5 minutes."
      }), {
        status: 429,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }
    lockAcquired = true;

    // ============================================================
    // MAIN SYNC LOOP
    // ============================================================
    let page = 0;
    const pageSize = 100;

    // Muat daftar toko connected sekali per run
    const accounts = await loadShopeeAccounts();
    const accountByShop = {};
    for (const a of accounts) accountByShop[a.shop_id] = a;

    while (true) {
      let query = supabase
        .from("stock_mutations")
        .select("*")
        .eq("sync_status", "pending");

      // sync_test: HANYA proses product_id yang diizinkan
      if (testProductIds) {
        query = query.in("product_id", testProductIds);
      }

      const { data: mutations, error } = await query
        .order("created_at", { ascending: true })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) throw error;
      if (!mutations.length) break;

      // Dedupe per product_id (pakai qty_after terakhir)
      const productRows = {};
      for (const m of mutations) {
        const key = m.product_id;
        if (!productRows[key]) {
          productRows[key] = {
            product_id: m.product_id,
            qty_after: m.qty_after,
            mutation_ids: [],
            legacy_item_id: m.shopee_item_id != null ? m.shopee_item_id : null,
          };
        }
        productRows[key].mutation_ids.push(m.id);
        productRows[key].qty_after = m.qty_after;
      }
      const products = Object.values(productRows);

      // Mapping produk -> (shop_id, shopee_item_id) dari product_shopee_mapping
      const mapByProduct = {};
      const { data: mappings, error: mapErr } = await supabase
        .from("product_shopee_mapping")
        .select("product_id, shop_id, shopee_item_id")
        .in("product_id", products.map(p => p.product_id));
      if (mapErr) throw mapErr;
      for (const mp of mappings || []) {
        if (!mapByProduct[mp.product_id]) mapByProduct[mp.product_id] = [];
        mapByProduct[mp.product_id].push(mp);
      }

      // Bangun daftar item per shop
      const perShopItems = {};
      for (const p of products) {
        const maps = mapByProduct[p.product_id] || [];
        if (maps.length === 0) {
          // Fallback toko lama: kirim mutation.shopee_item_id ke shop pertama connected
          if (accounts.length && p.legacy_item_id != null) {
            const a = accounts[0];
            if (!perShopItems[a.shop_id]) perShopItems[a.shop_id] = [];
            perShopItems[a.shop_id].push({ shopee_item_id: p.legacy_item_id, qty_after: p.qty_after, product_id: p.product_id, mutation_ids: p.mutation_ids });
          }
          continue;
        }
        for (const mp of maps) {
          if (!perShopItems[mp.shop_id]) perShopItems[mp.shop_id] = [];
          perShopItems[mp.shop_id].push({ shopee_item_id: mp.shopee_item_id, qty_after: p.qty_after, product_id: p.product_id, mutation_ids: p.mutation_ids });
        }
      }

      // Kirim update_stock per shop
      const shopResults = {};
      for (const [sid, items] of Object.entries(perShopItems)) {
        const account = accountByShop[sid];
        if (!account) continue;
        const res = await updateShopeeBatch(account, items);
        const okMap = {};
        for (const it of items) okMap[String(it.shopee_item_id)] = true;
        for (const e of res.errors) { if (e.shopee_item_id != null) okMap[String(e.shopee_item_id)] = false; }
        shopResults[sid] = okMap;
        totalFailed += res.failed;
        syncResults.push({ account: account.account, shop_id: sid, synced: res.synced, failed: res.failed, errors: res.errors });
      }

      // Tandai synced HANYA jika SEMUA target shop sukses; selain itu biarkan pending (retry)
      for (const p of products) {
        const targets = [];
        const maps = mapByProduct[p.product_id] || [];
        if (maps.length === 0) {
          if (accounts.length && p.legacy_item_id != null) targets.push({ shop_id: accounts[0].shop_id, item: p.legacy_item_id });
        } else {
          for (const mp of maps) targets.push({ shop_id: mp.shop_id, item: mp.shopee_item_id });
        }
        if (targets.length === 0) continue;
        let allOk = true;
        for (const t of targets) {
          const okMap = shopResults[t.shop_id];
          if (!okMap || okMap[String(t.item)] !== true) { allOk = false; break; }
        }
        if (allOk) {
          const { error: updErr } = await supabase
            .from("stock_mutations")
            .update({ sync_status: "synced", shopee_sync_at: new Date().toISOString() })
            .in("id", p.mutation_ids);
          if (updErr) {
            console.error("Failed to update synced stock_mutations:", updErr.message);
          } else {
            totalSynced += p.mutation_ids.length;
          }
        }
      }

      page++;
    }

    // ============================================================
    // ACTIVITY LOG
    // ============================================================
    const duration = Date.now() - startedAt;
    const logEntries = [];

    if (syncResults.length > 0) {
      for (const r of syncResults) {
        logEntries.push({
          sync_batch_id: syncBatchId,
          event_type: "SYNC_PUSH",
          direction: "OUT",
          platform: "shopee",
          shop_id: r.shop_id,
          reference_id: r.account,
          status: r.failed === 0 ? "success" : "failed",
          triggered_by: "system",
          action_source: "cron",
          duration_ms: duration,
          metadata: { synced_items: r.synced, failed_items: r.failed, total_mutations: totalSynced + totalFailed }
        });

        if (r.errors.length > 0) {
          logEntries.push({
            sync_batch_id: syncBatchId,
            event_type: "SYNC_FAILED",
            direction: "OUT",
            platform: "shopee",
            shop_id: r.shop_id,
            reference_id: r.account,
            status: "failed",
            triggered_by: "system",
            action_source: "cron",
            error_message: `${r.failed} item gagal disinkronkan`,
            error_detail: JSON.stringify(r.errors.slice(0, 10)),
            duration_ms: duration,
            metadata: { synced_items: r.synced, failed_items: r.failed }
          });
        }
      }
    } else {
      logEntries.push({
        sync_batch_id: syncBatchId,
        event_type: "SYNC_PUSH",
        direction: "OUT",
        platform: "shopee",
        reference_id: "all",
        status: "success",
        triggered_by: "system",
        action_source: "cron",
        duration_ms: duration,
        metadata: { total_mutations: 0, message: "No pending mutations" }
      });
    }

    if (logEntries.length > 0) {
      try {
        await supabase.from("activity_log").insert(logEntries);
      } catch (logErr) {
        console.error("Activity log insert failed:", logErr.message);
      }
    }

    const shopIds = [...new Set(syncResults.map(r => r.shop_id).filter(Boolean))];
    for (const sid of shopIds) {
      await supabase.from("marketplace_config")
        .update({ last_sync_at: new Date().toISOString() })
        .eq("platform", "shopee")
        .eq("shop_id", sid);
    }

    return new Response(JSON.stringify({
      synced: totalSynced,
      failed: totalFailed,
      batch_id: syncBatchId,
      message: totalSynced || totalFailed ? `Synced: ${totalSynced}, Failed: ${totalFailed}` : "No pending mutations"
    }), {
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });

  } catch (err) {
    const duration = Date.now() - startedAt;

    try {
      await supabase.from("activity_log").insert([{
        sync_batch_id: syncBatchId,
        event_type: "SYNC_FAILED",
        direction: "OUT",
        platform: "shopee",
        status: "failed",
        triggered_by: "system",
        action_source: "cron",
        error_message: err.message || "Unknown error",
        error_detail: err.stack || JSON.stringify(err),
        duration_ms: duration,
        metadata: { total_synced: totalSynced, total_failed: totalFailed }
      }]);
    } catch (logErr) {
      console.error("Activity log insert (catch block) failed:", logErr.message);
    }

    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });

  } finally {
    if (lockAcquired) {
      await supabase.rpc("sync_lock_release");
    }
  }
});
