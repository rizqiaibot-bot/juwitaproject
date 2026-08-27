// ============================================================
// Supabase Edge Function: shopee-connect
// Deploy ke: supabase functions deploy shopee-connect
// ============================================================
// Cara deploy:
//   1. supabase functions deploy shopee-connect
//   2. Set ENV (sama dengan shopee-stock-sync):
//      SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY
//   3. Panggil via marketplace.html:
//      POST /shopee-connect  { shop_id: "12345" }
// ============================================================
// ALUR:
//   1. Terima shop_id dari request
//   2. Ambil partner_id, partner_key dari env vars
//   3. Generate HMAC signature
//   4. Panggil Shopee API get_shop_info
//   5. Jika berhasil → upsert marketplace_config + log
//   6. Jika gagal   → update connection_status = 'error' + log
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib di-set di environment variables");
}

const SHOPEE_API_URL = "https://partner.shopeemobile.com";

const FETCH_TIMEOUT_MS = 15000;

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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================================
// SHOPEE HMAC SIGNATURE
// ============================================================
async function signShopee(partnerId: string, partnerKey: string, path: string, timestamp: number, accessToken = "", shopId = "") {
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
// TEST KONEKSI KE SHOPEE
// ============================================================
async function testShopeeConnection(partnerId: string, partnerKey: string, shopId: string, accessToken: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/shop/get_shop_info";
  const sign = await signShopee(partnerId, partnerKey, path, timestamp, accessToken, shopId);

  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    sign,
    shop_id: shopId,
    access_token: accessToken,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET", signal: controller.signal });
  clearTimeout(timeoutId);
  const body = await res.json();

  if (!res.ok || body.error) {
    return {
      success: false,
      error: body.error || body.message || `HTTP ${res.status}`,
      detail: JSON.stringify(body)
    };
  }

  const shopInfo = body.response || body;
  return {
    success: true,
    shop_name: shopInfo.shop_name || null,
    raw: body
  };
}

// ============================================================
// OAUTH: BUAT AUTHORIZATION URL (production)
// ============================================================
async function buildAuthUrl(partnerId: string, partnerKey: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/shop/auth_partner";
  const sign = await signShopee(partnerId, partnerKey, path, timestamp);
  const redirect = "https://juwitaproject.vercel.app/marketplace.html";
  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    sign,
    redirect,
  });
  return `${SHOPEE_API_URL}${path}?${params}`;
}

// ============================================================
// OAUTH: TUKAR CODE -> ACCESS_TOKEN + REFRESH_TOKEN (server-side)
// ============================================================
async function exchangeToken(partnerId: string, partnerKey: string, code: string, shopId: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/token/get";
  const sign = await signShopee(partnerId, partnerKey, path, timestamp);

  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    sign,
  });

  const jsonBody = JSON.stringify({
    code,
    shop_id: Number(shopId),
    partner_id: Number(partnerId),
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const res = await fetch(`${SHOPEE_API_URL}${path}?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: jsonBody,
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  const body = await res.json();
  if (body.error || !body.access_token) {
    return { success: false, error: body.error || body.message || "Token Shopee gagal diperoleh." };
  }
  return {
    success: true,
    access_token: body.access_token,
    refresh_token: body.refresh_token || null,
    shop_id: body.shop_id || shopId,
    expire_in: body.expire_in || null,
  };
}

// ============================================================
// MAIN
// ============================================================
Deno.serve(async (req) => {
  // Preflight CORS: jangan jalankan logic OAuth / akses database
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  const startedAt = Date.now();

  try {
    const { shop_id, access_token, refresh_token, action, code } = await req.json();

    // Ambil credential dari environment variables (service_role key)
    const partnerId = Deno.env.get("SHOPEE_PARTNER_ID") || "";
    const partnerKey = Deno.env.get("SHOPEE_PARTNER_KEY") || "";

    if (!partnerId || !partnerKey) {
      return new Response(JSON.stringify({
        success: false,
        error: "Credential Shopee belum dikonfigurasi",
        hint: "Set SHOPEE_PARTNER_ID dan SHOPEE_PARTNER_KEY di Supabase Environment Variables"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // ============================================================
    // ACTION: authorize — generate authorization URL (production)
    // ============================================================
    if (action === "authorize") {
      const authUrl = await buildAuthUrl(partnerId, partnerKey);
      return new Response(JSON.stringify({
        success: true,
        auth_url: authUrl
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // ============================================================
    // ACTION: exchange — code -> token -> simpan -> verifikasi -> connected
    // ============================================================
    if (action === "exchange") {
      if (!code) {
        return new Response(JSON.stringify({
          success: false,
          error: "Authorization code wajib diisi"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }
      if (!shop_id) {
        return new Response(JSON.stringify({
          success: false,
          error: "shop_id wajib diisi"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }

      const exchange = await exchangeToken(partnerId, partnerKey, code, shop_id);
      if (!exchange.success) {
        return new Response(JSON.stringify({
          success: false,
          error: exchange.error
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }

      // Simpan token (service_role only) — jangan pernah dikembalikan ke frontend
      const { error: credErr } = await supabase
        .from("marketplace_credentials")
        .upsert({
          shop_id: exchange.shop_id,
          platform: "shopee",
          access_token: exchange.access_token,
          refresh_token: exchange.refresh_token,
          updated_at: new Date().toISOString()
        });
      if (credErr) console.error("marketplace_credentials upsert failed:", credErr.message);

      // Verifikasi toko (get_shop_info)
      const verify = await testShopeeConnection(partnerId, partnerKey, exchange.shop_id, exchange.access_token);
      if (!verify.success) {
        return new Response(JSON.stringify({
          success: false,
          error: verify.error
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }

      // Update marketplace_config -> connected
      const { data: exExisting } = await supabase
        .from("marketplace_config")
        .select("id")
        .eq("platform", "shopee")
        .eq("shop_id", exchange.shop_id)
        .maybeSingle();

      if (exExisting) {
        await supabase.from("marketplace_config").update({
          shop_name: verify.shop_name,
          is_active: true,
          connection_status: "connected",
          updated_at: new Date().toISOString()
        }).eq("id", exExisting.id);
      } else {
        await supabase.from("marketplace_config").insert({
          platform: "shopee",
          account_label: "shopee_" + exchange.shop_id,
          shop_id: exchange.shop_id,
          shop_name: verify.shop_name,
          is_active: true,
          connection_status: "connected"
        });
      }

      try {
        await supabase.from("activity_log").insert({
          event_type: "OAUTH_CONNECT",
          direction: "INTERNAL",
          platform: "shopee",
          shop_id: exchange.shop_id,
          status: "success",
          triggered_by: "admin",
          action_source: "admin_dashboard",
          duration_ms: Date.now() - startedAt,
          metadata: { shop_name: verify.shop_name }
        });
      } catch (logErr) {
        console.error("Activity log insert failed:", logErr.message);
      }

      return new Response(JSON.stringify({
        success: true,
        shop_id: exchange.shop_id,
        shop_name: verify.shop_name,
        connection_status: "connected",
        message: "Koneksi Shopee berhasil"
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // ============================================================
    // DEFAULT: manual access_token test + simpan
    // ============================================================
    if (!shop_id) {
      return new Response(JSON.stringify({
        success: false,
        error: "shop_id wajib diisi"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    if (!access_token) {
      return new Response(JSON.stringify({
        success: false,
        error: "access_token wajib diisi"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // Test koneksi
    const result = await testShopeeConnection(partnerId, partnerKey, shop_id, access_token);
    const duration = Date.now() - startedAt;

    if (result.success) {
      // Simpan token (service_role only) — jangan pernah dikembalikan ke frontend
      const { error: credErr } = await supabase
        .from("marketplace_credentials")
        .upsert({
          shop_id,
          platform: "shopee",
          access_token,
          refresh_token: refresh_token || null,
          updated_at: new Date().toISOString()
        });
      if (credErr) console.error("marketplace_credentials upsert failed:", credErr.message);

      // Upsert marketplace_config — INSERT jika belum ada, UPDATE jika sudah
      const { data: existing } = await supabase
        .from("marketplace_config")
        .select("id")
        .eq("platform", "shopee")
        .eq("shop_id", shop_id)
        .maybeSingle();

      if (existing) {
        const { error: updErr } = await supabase
          .from("marketplace_config")
          .update({
            shop_name: result.shop_name,
            is_active: true,
            connection_status: "connected",
            last_sync_at: null,
            updated_at: new Date().toISOString()
          })
          .eq("id", existing.id);
        if (updErr) console.error("marketplace_config update failed:", updErr.message);
      } else {
        const { error: insErr } = await supabase
          .from("marketplace_config")
          .insert({
            platform: "shopee",
            account_label: "shopee_" + shop_id,
            shop_id,
            shop_name: result.shop_name,
            is_active: true,
            connection_status: "connected"
          });
        if (insErr) console.error("marketplace_config insert failed:", insErr.message);
      }

      // Activity log
      try {
        await supabase.from("activity_log").insert({
          event_type: "CONNECT",
          direction: "INTERNAL",
          platform: "shopee",
          shop_id,
          status: "success",
          triggered_by: "admin",
          action_source: "admin_dashboard",
          duration_ms: duration,
          metadata: { shop_name: result.shop_name }
        });
      } catch (logErr) {
        console.error("Activity log insert failed:", logErr.message);
      }

      return new Response(JSON.stringify({
        success: true,
        shop_id,
        shop_name: result.shop_name,
        connection_status: "connected",
        message: "Koneksi Shopee berhasil"
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });

    } else {
      // Koneksi gagal — update status (SELECT + INSERT/UPDATE manual)
      const { data: failExisting } = await supabase
        .from("marketplace_config")
        .select("id")
        .eq("platform", "shopee")
        .eq("shop_id", shop_id)
        .maybeSingle();

      if (failExisting) {
        const { error: updErr } = await supabase
          .from("marketplace_config")
          .update({
            is_active: false,
            connection_status: "error",
            updated_at: new Date().toISOString()
          })
          .eq("id", failExisting.id);
        if (updErr) console.error("marketplace_config update failed:", updErr.message);
      } else {
        const { error: insErr } = await supabase
          .from("marketplace_config")
          .insert({
            platform: "shopee",
            account_label: "shopee_" + shop_id,
            shop_id,
            is_active: false,
            connection_status: "error"
          });
        if (insErr) console.error("marketplace_config insert failed:", insErr.message);
      }

      // Activity log
      try {
        await supabase.from("activity_log").insert({
          event_type: "CONNECT",
          direction: "INTERNAL",
          platform: "shopee",
          shop_id,
          status: "failed",
          triggered_by: "admin",
          action_source: "admin_dashboard",
          error_message: result.error || "Koneksi gagal",
          error_detail: result.detail || null,
          duration_ms: duration
        });
      } catch (logErr) {
        console.error("Activity log insert failed:", logErr.message);
      }

      return new Response(JSON.stringify({
        success: false,
        shop_id,
        connection_status: "error",
        error: result.error,
        detail: result.detail
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

  } catch (err: any) {
    try {
      await supabase.from("activity_log").insert({
        event_type: "CONNECT",
        direction: "INTERNAL",
        platform: "shopee",
        status: "failed",
        triggered_by: "admin",
        action_source: "admin_dashboard",
        error_message: err.message || "Internal server error",
        error_detail: err.stack || null
      });
    } catch {
      console.error("Activity log insert (catch block) failed:", err.message);
    }

    return new Response(JSON.stringify({
      success: false,
      error: err.message || "Internal server error"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
  }
});
