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
// TEST KONEKSI KE SHOPEE
// ============================================================
async function testShopeeConnection(partnerId, partnerKey, shopId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/shop/get_shop_info";
  const sign = await signShopee(partnerId, partnerKey, path, timestamp);

  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    sign,
    shop_id: shopId,
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

  return {
    success: true,
    shop_name: body.shop_name || body.data?.shop_name || null,
    raw: body
  };
}

// ============================================================
// MAIN
// ============================================================
Deno.serve(async (req) => {
  const startedAt = Date.now();

  try {
    const { shop_id } = await req.json();

    if (!shop_id) {
      return new Response(JSON.stringify({
        success: false,
        error: "shop_id wajib diisi"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

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
        headers: { "Content-Type": "application/json" }
      });
    }

    // Test koneksi
    const result = await testShopeeConnection(partnerId, partnerKey, shop_id);
    const duration = Date.now() - startedAt;

    if (result.success) {
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
            account_label: "toko_1",
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
        headers: { "Content-Type": "application/json" }
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
            account_label: "toko_1",
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
        headers: { "Content-Type": "application/json" }
      });
    }

  } catch (err) {
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
      headers: { "Content-Type": "application/json" }
    });
  }
});
