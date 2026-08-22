// ============================================================
// Supabase Edge Function: shopee-get-category
// Read-only: mengambil data referensi Shopee untuk publish produk.
// Supported action (via body JSON): category | attributes | channels
//   - category   : product/get_category          (language=id)
//   - attributes : product/get_attributes        (category_id)
//   - channels   : logistics/get_channel_list
// TIDAK membuat / mengubah produk Shopee.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPEE_API_URL = "https://partner.shopeemobile.com";

const ACCOUNT = {
  label: "toko_1",
  partner_id: Deno.env.get("SHOPEE_PARTNER_ID") || "",
  partner_key: Deno.env.get("SHOPEE_PARTNER_KEY") || "",
  shop_id: Deno.env.get("SHOPEE_SHOP_ID") || "",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": Deno.env.get("FRONTEND_ORIGIN") || "https://juwitaproject.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// SHOP signing: partner_id + path + timestamp + access_token + shop_id
async function signShopee(partnerId: string, partnerKey: string, path: string, timestamp: number, accessToken = "", shopId = "") {
  const base = partnerId + path + timestamp + accessToken + shopId;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(partnerKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
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

// Refresh token: PARTNER signing + JSON body
async function refreshToken(shopId: string, refreshToken: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/access_token/get";
  const sign = await signShopee(ACCOUNT.partner_id, ACCOUNT.partner_key, path, timestamp);
  const params = new URLSearchParams({
    partner_id: ACCOUNT.partner_id,
    timestamp: String(timestamp),
    sign,
  });
  const jsonBody = JSON.stringify({
    refresh_token: refreshToken,
    shop_id: Number(shopId),
    partner_id: Number(ACCOUNT.partner_id),
  });
  const res = await fetch(`${SHOPEE_API_URL}${path}?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: jsonBody,
  });
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

// Generic GET ke Shopee dengan SHOP signing
async function shopeeGet(path: string, accessToken: string, extraParams: Record<string, string> = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await signShopee(ACCOUNT.partner_id, ACCOUNT.partner_key, path, timestamp, accessToken, ACCOUNT.shop_id);
  const params = new URLSearchParams({
    partner_id: ACCOUNT.partner_id,
    timestamp: String(timestamp),
    sign,
    shop_id: ACCOUNT.shop_id,
    access_token: accessToken,
    ...extraParams,
  });
  const res = await fetch(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  return res.json();
}

function isAuthError(text: string) {
  const lower = (text || "").toLowerCase();
  return lower.includes("access_token") || lower.includes("acceess_token") || lower.includes("error_auth") || lower.includes("token_invalid") || lower.includes("token_expired");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  try {
    const shopId = ACCOUNT.shop_id;
    let { access_token, refresh_token } = await loadToken(shopId);
    if (!access_token && refresh_token) {
      const r = await refreshToken(shopId, refresh_token);
      if (r.access_token) access_token = r.access_token;
    }
    if (!access_token) {
      return new Response(JSON.stringify({ success: false, error: "Access token tidak tersedia. Silakan reconnect OAuth Shopee." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    // GET dengan refresh-on-auth-error (retry maks 1x)
    async function callWithAuth(path: string, extraParams: Record<string, string> = {}) {
      let resp = await shopeeGet(path, access_token, extraParams);
      if (!resp.error) return resp;
      const authMsg = `${resp.error} ${resp.message || ""}`;
      if (!refresh_token || !isAuthError(authMsg)) return resp;
      const r = await refreshToken(shopId, refresh_token);
      if (!r.access_token) return resp;
      access_token = r.access_token;
      return shopeeGet(path, access_token, extraParams);
    }

    let body: any = {};
    try { body = await req.json(); } catch (_) { body = {}; }
    const action = body.action || "category";

    if (action === "attributes") {
      const categoryId = body.category_id != null ? String(body.category_id) : "";
      if (!categoryId) {
        return new Response(JSON.stringify({ success: false, error: "category_id wajib untuk get_attributes" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }
      const resp = await callWithAuth("/api/v2/product/get_attributes", { category_id: categoryId, language: "id" });
      if (resp.error) {
        return new Response(JSON.stringify({ success: false, error: `${resp.error} - ${resp.message || ""}` }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify({ success: true, attributes: resp.response?.attribute_list || [] }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    if (action === "channels") {
      const resp = await callWithAuth("/api/v2/logistics/get_channel_list");
      if (resp.error) {
        return new Response(JSON.stringify({ success: false, error: `${resp.error} - ${resp.message || ""}` }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify({ success: true, channels: resp.response?.logistics_channel_list || [] }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    if (action === "attribute_tree") {
      const categoryId = body.category_id != null ? String(body.category_id) : "";
      if (!categoryId) {
        return new Response(JSON.stringify({ success: false, error: "category_id wajib untuk get_attribute_tree" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }
      const resp = await callWithAuth("/api/v2/product/get_attribute_tree", { category_id_list: categoryId, language: "id" });
      if (resp.error) {
        return new Response(JSON.stringify({ success: false, error: `${resp.error} - ${resp.message || ""}` }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify({ success: true, response: resp.response || {} }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    // default: category
    const resp = await callWithAuth("/api/v2/product/get_category", { language: "id" });
    if (resp.error) {
      return new Response(JSON.stringify({ success: false, error: `${resp.error} - ${resp.message || ""}` }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }
    return new Response(JSON.stringify({ success: true, categories: resp.response?.category_list || [] }), {
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message || "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
});
