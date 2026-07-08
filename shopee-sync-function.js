// ============================================================
// Supabase Edge Function: shopee-stock-sync
// Deploy ke: supabase functions deploy shopee-stock-sync
// ============================================================
// Cara deploy:
//   1. npm install -g supabase
//   2. supabase login
//   3. supabase functions deploy shopee-stock-sync
//   4. Set ENV:
//      Toko 1: SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID
//      Toko 2: SHOPEE_PARTNER_ID_2, SHOPEE_PARTNER_KEY_2, SHOPEE_SHOP_ID_2
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_API_URL = "https://partner.shopeemobile.com/api/v2";

const ACCOUNTS = {
  toko_1: {
    partner_id: Deno.env.get("SHOPEE_PARTNER_ID") || "",
    partner_key: Deno.env.get("SHOPEE_PARTNER_KEY") || "",
    shop_id: Deno.env.get("SHOPEE_SHOP_ID") || "",
  },
  toko_2: {
    partner_id: Deno.env.get("SHOPEE_PARTNER_ID_2") || "",
    partner_key: Deno.env.get("SHOPEE_PARTNER_KEY_2") || "",
    shop_id: Deno.env.get("SHOPEE_SHOP_ID_2") || "",
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
  if (!account || !account.partner_id) return { error: "Shopee not configured for " + accountName };

  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_stock";
  const sign = await signShopee(account, path, timestamp);

  const params = new URLSearchParams({
    partner_id: account.partner_id,
    timestamp: String(timestamp),
    sign,
    shop_id: account.shop_id,
  });

  for (const item of items) {
    if (item.shopee_item_id != null) {
      const stockParams = new URLSearchParams(params);
      stockParams.set("item_id", String(item.shopee_item_id));
      stockParams.set("stock_list", JSON.stringify([{ model_id: 0, normal_stock: item.qty_after }]));
      const res = await fetch(`${SHOPEE_API_URL}/product/update_stock?${stockParams}`, { method: "POST" });
      if (!res.ok) console.error(`Shopee ${accountName} sync error:`, await res.text());
    }
  }
}

Deno.serve(async (req) => {
  try {
    let totalSynced = 0;
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

      // Group by shopee_account
      const grouped = {};
      for (const m of mutations) {
        const acc = m.shopee_account || "toko_1";
        if (!grouped[acc]) grouped[acc] = [];
        grouped[acc].push(m);
      }

      // Sync per account
      for (const [acc, accMutations] of Object.entries(grouped)) {
        // Dedupe: ambil qty_after terbaru per product per account
        const productStocks = {};
        for (const m of accMutations) {
          const key = m.product_id;
          if (!productStocks[key]) {
            productStocks[key] = { shopee_item_id: m.shopee_item_id, qty_after: m.qty_after, mutation_ids: [] };
          }
          productStocks[key].mutation_ids.push(m.id);
          productStocks[key].qty_after = m.qty_after;
        }

        const items = Object.values(productStocks);
        await updateShopeeBatch(acc, items);

        // Tandai synced
        const allIds = items.flatMap(i => i.mutation_ids);
        await supabase
          .from("stock_mutations")
          .update({ sync_status: "synced", shopee_sync_at: new Date().toISOString() })
          .in("id", allIds);

        totalSynced += allIds.length;
      }

      page++;
    }

    return new Response(JSON.stringify({ synced: totalSynced, message: totalSynced ? "Synced" : "No pending mutations" }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
