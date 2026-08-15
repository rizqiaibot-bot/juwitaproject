// ============================================================
// Supabase Edge Function: shopee-pull-products
// Tarik produk/item dari Shopee Production ke tabel products
// ============================================================
// Signing SHOP: partner_id + api_path + timestamp + access_token + shop_id
// Credential access_token diambil dari marketplace_credentials (service_role).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_API_URL = "https://partner.shopeemobile.com";

const FETCH_TIMEOUT_MS = 15000;

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
// SHOPEE HMAC SIGNATURE (SHOP: + access_token + shop_id)
// ============================================================
async function signShopee(partnerId: string, partnerKey: string, path: string, timestamp: number, accessToken: string, shopId: string) {
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

// ============================================================
// LOAD TOKEN dari marketplace_credentials (service_role)
// ============================================================
async function loadToken(shopId: string) {
  const { data, error } = await supabase
    .from("marketplace_credentials")
    .select("access_token, refresh_token")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error || !data) return { access_token: null, refresh_token: null };
  return { access_token: data.access_token || null, refresh_token: data.refresh_token || null };
}

async function shopeeGet(partnerId: string, partnerKey: string, path: string, accessToken: string, shopId: string, extraParams: Record<string, string>) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await signShopee(partnerId, partnerKey, path, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    sign,
    access_token: accessToken,
    shop_id: shopId,
    ...extraParams,
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET", signal: controller.signal });
  clearTimeout(timeoutId);
  const body = await res.json();
  if (body.error) {
    throw new Error(`Shopee API error: ${body.error} - ${body.message || ""}`);
  }
  return body.response || {};
}

function extractPrice(item: any): number | null {
  const p = item?.price_info?.[0]?.current_price;
  if (p == null || p === "") return null;
  const n = Number(p);
  return isNaN(n) ? null : Math.round(n);
}

function extractStock(item: any): number | null {
  const s = item?.stock_info_v2?.summary_info?.total_available_stock;
  if (s == null || s === "") return null;
  const n = Number(s);
  return isNaN(n) ? null : Math.round(n);
}

// ============================================================
// MAIN
// ============================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  const startedAt = Date.now();

  try {
    const partnerId = Deno.env.get("SHOPEE_PARTNER_ID") || "";
    const partnerKey = Deno.env.get("SHOPEE_PARTNER_KEY") || "";
    const shopId = Deno.env.get("SHOPEE_SHOP_ID") || "724153261";

    if (!partnerId || !partnerKey) {
      return new Response(JSON.stringify({ success: false, error: "Credential Shopee belum dikonfigurasi" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    const { access_token } = await loadToken(shopId);
    if (!access_token) {
      return new Response(JSON.stringify({ success: false, error: "Access token tidak tersedia. Silakan reconnect OAuth Shopee." }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // 1. Kumpulkan semua item_id (paginasi)
    const itemIds: number[] = [];
    let listOffset = 0;
    while (true) {
      const resp = await shopeeGet(partnerId, partnerKey, "/api/v2/product/get_item_list", access_token, shopId, {
        offset: String(listOffset),
        page_size: "100",
        item_status: "NORMAL",
      });
      const items = resp.item || [];
      for (const item of items) {
        if (item.item_id != null) itemIds.push(Number(item.item_id));
      }
      const hasNext = resp.has_next_page || false;
      const nextOffset = resp.next_offset ?? (listOffset + items.length);
      if (!hasNext || items.length === 0) break;
      listOffset = nextOffset;
    }

    // 2. Ambil base info per batch (max 50) → kumpulkan item detail
    const allItems: any[] = [];
    const batchSize = 50;
    for (let i = 0; i < itemIds.length; i += batchSize) {
      const batch = itemIds.slice(i, i + batchSize);
      const baseResp = await shopeeGet(partnerId, partnerKey, "/api/v2/product/get_item_base_info", access_token, shopId, {
        item_id_list: batch.join(","),
      });
      const itemList = baseResp.item_list || [];
      for (const item of itemList) allItems.push(item);
    }

    // 3. Load produk existing untuk mapping + generate id
    const { data: existingProducts } = await supabase
      .from("products")
      .select("id, sku, shopee_sku, shopee_item_id");
    const products = existingProducts || [];

    const byItemId = new Map<string, any>();
    const bySku = new Map<string, any>();
    for (const p of products) {
      if (p.shopee_item_id != null) byItemId.set(String(p.shopee_item_id), p);
      if (p.sku) bySku.set(String(p.sku).toLowerCase(), p);
      if (p.shopee_sku) bySku.set(String(p.shopee_sku).toLowerCase(), p);
    }
    let nextId = products.length ? Math.max(...products.map(p => Number(p.id))) + 1 : 1;

    const toInsert: any[] = [];
    const toUpdate: { id: number; updates: any }[] = [];
    let fetched = 0, inserted = 0, updated = 0, skipped = 0, failed = 0;

    // 4. Klasifikasi insert vs update (item_id dulu, lalu SKU)
    for (const item of allItems) {
      fetched++;
      const itemId = item.item_id != null ? Number(item.item_id) : null;
      const itemName = item.item_name || "";
      const itemSku = item.item_sku || "";
      const price = extractPrice(item);
      const stock = extractStock(item);

      let existing = null;
      if (itemId != null) existing = byItemId.get(String(itemId)) || null;
      if (!existing && itemSku) existing = bySku.get(String(itemSku).toLowerCase()) || null;

      if (existing) {
        const updates: any = {
          name: itemName || existing.name,
          shopee_item_id: itemId != null ? itemId : existing.shopee_item_id,
          shopee_sku: itemSku || existing.shopee_sku,
          sku: itemSku || existing.sku || ("SKU" + String(existing.id).padStart(4, "0")),
        };
        if (price != null) updates.price = price;
        if (stock != null) updates.stock = stock;
        toUpdate.push({ id: Number(existing.id), updates });
        updated++;
      } else {
        const newId = nextId++;
        toInsert.push({
          id: newId,
          name: itemName,
          category: "lainnya",
          price: price != null ? price : 0,
          modal: 0,
          stock: stock != null ? stock : 0,
          sku: itemSku || ("SKU" + String(newId).padStart(4, "0")),
          shopee_item_id: itemId,
          shopee_sku: itemSku || null,
        });
        inserted++;
      }
    }

    // 5. Batch insert (500 per batch)
    const insertBatchSize = 500;
    for (let i = 0; i < toInsert.length; i += insertBatchSize) {
      const { error } = await supabase.from("products").insert(toInsert.slice(i, i + insertBatchSize));
      if (error) {
        console.error("Batch insert error:", error.message);
        failed += toInsert.slice(i, i + insertBatchSize).length;
        inserted -= toInsert.slice(i, i + insertBatchSize).length;
      }
    }

    // 6. Update individual (sedikit)
    for (const u of toUpdate) {
      const { error } = await supabase.from("products").update(u.updates).eq("id", u.id);
      if (error) {
        console.error("Update error:", error.message);
        failed++;
        updated--;
      }
    }

    const duration = Date.now() - startedAt;

    try {
      await supabase.from("activity_log").insert({
        event_type: "PRODUCT_PULL",
        direction: "IN",
        platform: "shopee",
        shop_id: shopId,
        status: failed === 0 ? "success" : "failed",
        triggered_by: "admin",
        action_source: "admin_dashboard",
        duration_ms: duration,
        metadata: { fetched, inserted, updated, skipped, failed }
      });
    } catch (logErr: any) {
      console.error("Activity log insert failed:", logErr.message);
    }

    return new Response(JSON.stringify({
      success: true,
      fetched,
      inserted,
      updated,
      skipped,
      failed
    }), {
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({
      success: false,
      error: err.message || "Internal server error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  }
});
