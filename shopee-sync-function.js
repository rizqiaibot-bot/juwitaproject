// ============================================================
// Supabase Edge Function: shopee-stock-sync
// Deploy ke: supabase functions deploy shopee-stock-sync
// ============================================================
// Cara deploy:
//   1. npm install -g supabase
//   2. supabase login
//   3. supabase functions deploy shopee-stock-sync
//   4. Set ENV: SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") || "";
const SHOPEE_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") || "";
const SHOPEE_SHOP_ID = Deno.env.get("SHOPEE_SHOP_ID") || "";
const SHOPEE_API_URL = "https://partner.shopeemobile.com/api/v2";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function signShopee(path, timestamp) {
  const base = SHOPEE_PARTNER_ID + path + timestamp;
  // Gunakan HMAC-SHA256
  const encoder = new TextEncoder();
  const key = encoder.encode(SHOPEE_PARTNER_KEY);
  // Implementasi signing sesuai Shopee Open Platform docs
  return "";
}

async function updateShopeeStock(itemId, sku, newStock) {
  if (!SHOPEE_PARTNER_ID) return { error: "Shopee not configured" };

  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_stock";
  const sign = signShopee(path, timestamp);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    sign,
    shop_id: SHOPEE_SHOP_ID,
    item_id: String(itemId),
    stock_list: JSON.stringify([{
      model_id: 0,
      normal_stock: newStock
    }])
  });

  const res = await fetch(`${SHOPEE_API_URL}/product/update_stock?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  return await res.json();
}

async function updateShopeeBatch(items) {
  if (!SHOPEE_PARTNER_ID) return { error: "Shopee not configured" };

  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/product/update_stock";
  const sign = signShopee(path, timestamp);

  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    sign,
    shop_id: SHOPEE_SHOP_ID,
  });

  // Batch update - kirim array
  for (const item of items) {
    if (item.shopee_item_id) {
      const stockParams = new URLSearchParams(params);
      stockParams.set("item_id", String(item.shopee_item_id));
      stockParams.set("stock_list", JSON.stringify([{ model_id: 0, normal_stock: item.qty_after }]));
      await fetch(`${SHOPEE_API_URL}/product/update_stock?${stockParams}`, { method: "POST" });
    }
  }
}

Deno.serve(async (req) => {
  try {
    // Ambil mutasi yang belum disync
    const { data: mutations, error } = await supabase
      .from("stock_mutations")
      .select("*")
      .eq("sync_status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;
    if (!mutations.length) {
      return new Response(JSON.stringify({ synced: 0, message: "No pending mutations" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Hitung stok terbaru per produk dari mutations
    const productStocks = {};
    for (const m of mutations) {
      if (!productStocks[m.product_id]) {
        productStocks[m.product_id] = {
          product_id: m.product_id,
          product_name: m.product_name,
          shopee_item_id: m.shopee_item_id,
          shopee_sku: m.shopee_sku,
          qty_after: m.qty_after,
          mutation_ids: []
        };
      }
      productStocks[m.product_id].mutation_ids.push(m.id);
      productStocks[m.product_id].qty_after = m.qty_after; // ambil yang terbaru
    }

    const items = Object.values(productStocks);
    await updateShopeeBatch(items);

    // Tandai semua sebagai synced
    const allMutationIds = items.flatMap(i => i.mutation_ids);
    await supabase
      .from("stock_mutations")
      .update({ sync_status: "synced", shopee_sync_at: new Date().toISOString() })
      .in("id", allMutationIds);

    return new Response(JSON.stringify({ synced: allMutationIds.length, items }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
});
