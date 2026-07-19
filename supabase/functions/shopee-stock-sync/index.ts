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

const ACCOUNTS = {
  toko_1: {
    partner_id: Deno.env.get("SHOPEE_PARTNER_ID") || "",
    partner_key: Deno.env.get("SHOPEE_PARTNER_KEY") || "",
    shop_id: Deno.env.get("SHOPEE_SHOP_ID") || "",
  },
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function signShopee(account, path, timestamp) {
  const base = account.partner_id + path + timestamp;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(account.partner_key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function updateShopeeBatch(accountName, items) {
  const account = ACCOUNTS[accountName];
  if (!account || !account.partner_id) return { synced: 0, failed: 0, errors: [] };

  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_stock";
  const sign = await signShopee(account, path, timestamp);

  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
    shop_id: account.shop_id,
  });

  let synced = 0, failed = 0;
  const errors = [];
  let isFirstRequest = true;

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
        const res = await fetch(`${SHOPEE_API_URL}/product/update_stock?${stockParams}`, { method: "POST" });
        if (!res.ok) {
          const errText = await res.text();
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
  const startedAt = Date.now();
  const syncBatchId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  let totalSynced = 0;
  let totalFailed = 0;
  const syncResults = [];
  let lockAcquired = false;

  try {
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
        headers: { "Content-Type": "application/json" }
      });
    }
    lockAcquired = true;

    // ============================================================
    // MAIN SYNC LOOP
    // ============================================================
    let page = 0;
    const pageSize = 100;

    while (true) {
      const { data: mutations, error } = await supabase
        .from("stock_mutations")
        .select("*")
        .eq("sync_status", "pending")
        .order("created_at", { ascending: true })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) throw error;
      if (!mutations.length) break;

      const grouped = {};
      for (const m of mutations) {
        const acc = m.shopee_account || "toko_1";
        if (!grouped[acc]) grouped[acc] = [];
        grouped[acc].push(m);
      }

      for (const [acc, accMutations] of Object.entries(grouped)) {
        const account = ACCOUNTS[acc];
        const shopId = account.shop_id || "";

        const productStocks = {};
        for (const m of accMutations) {
          const key = m.product_id;
          if (!productStocks[key]) {
            productStocks[key] = {
              shopee_item_id: m.shopee_item_id,
              shopee_sku: m.shopee_sku || "",
              product_id: m.product_id,
              product_name: m.product_name || "",
              qty_after: m.qty_after,
              mutation_ids: []
            };
          }
          productStocks[key].mutation_ids.push(m.id);
          productStocks[key].qty_after = m.qty_after;
        }

        const items = Object.values(productStocks);
        const result = await updateShopeeBatch(acc, items);

        const syncedIds = [];
        const failedIds = [];

        for (const item of items) {
          const allIds = item.mutation_ids;
          if (result.errors.some(e => e.shopee_item_id === item.shopee_item_id)) {
            failedIds.push(...allIds);
          } else {
            syncedIds.push(...allIds);
          }
        }

        if (syncedIds.length > 0) {
          await supabase
            .from("stock_mutations")
            .update({ sync_status: "synced", shopee_sync_at: new Date().toISOString() })
            .in("id", syncedIds);
          totalSynced += syncedIds.length;
        }

        if (failedIds.length > 0) {
          await supabase
            .from("stock_mutations")
            .update({ sync_status: "failed", shopee_sync_at: null })
            .in("id", failedIds);
          totalFailed += failedIds.length;
        }

        syncResults.push({ account: acc, shop_id: shopId, synced: result.synced, failed: result.failed, errors: result.errors });
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
      headers: { "Content-Type": "application/json" }
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
      headers: { "Content-Type": "application/json" }
    });

  } finally {
    if (lockAcquired) {
      await supabase.rpc("sync_lock_release");
    }
  }
});
