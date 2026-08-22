// ============================================================
// Supabase Edge Function: shopee-create-product
// Publish 1 produk Juwita ke Shopee (product/add_item).
// Idempotent: jika products.shopee_item_id sudah ada -> skip.
// Hanya 1 produk = 1 item, tanpa variasi/tier.
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

// Mapping kategori Juwita -> Shopee category_id (verified dari get_category)
const CATEGORY_MAP: Record<string, number> = {
  "Frozen Food": 100854, // Makanan Beku Olahan
  "Roti": 100856,        // Roti
  "Snack": 100793,       // Makanan Ringan Lainnya
  "Minuman": 100837,     // Minuman Lainnya
  "lainnya": 100657,     // Makanan & Minuman Lainnya
};

// Mandatory attribute per category (verified dari get_attribute_tree)
const ATTRIBUTE_MAP: Record<number, Array<Record<string, unknown>>> = {
  100854: [
    {
      attribute_id: 100010, // Masa Penyimpanan (mandatory)
      attribute_value_list: [{ value_id: 574, value: "3 Bulan" }], // default test
    },
  ],
};

// Logistic channel default (verified dari get_channel_list)
const LOGISTIC_INFO = [{ logistic_id: 8003, enabled: true }]; // Reguler (Cashless)

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

function isAuthError(text: string) {
  const lower = (text || "").toLowerCase();
  return lower.includes("access_token") || lower.includes("acceess_token") || lower.includes("error_auth") || lower.includes("token_invalid") || lower.includes("token_expired");
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

function jsonError(error: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// Upload gambar (imageicon URL) ke Shopee Media Space -> dapat image_id.
// Multipart field: "image" (verified dari official schema + code sample).
// Signing: PARTNER (api_type "Public" — tanpa access_token/shop_id).
async function uploadImageToShopee(imageUrl: string): Promise<string> {
  // 1. Ambil binary gambar
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error("Gagal mengambil gambar: HTTP " + imgRes.status);
  const buf = await imgRes.arrayBuffer();
  let contentType = imgRes.headers.get("content-type") || "";
  if (imageUrl.startsWith("data:")) {
    const m = imageUrl.match(/^data:([^;,]+)/);
    if (m) contentType = m[1];
  }
  if (!contentType) contentType = "image/jpeg";
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const filename = "image." + ext;

  // 2. Build multipart/form-data
  const form = new FormData();
  form.append("image", new Blob([buf], { type: contentType }), filename);
  form.append("scene", "normal");

  // 3. POST media_space/upload_image (PARTNER signing)
  const path = "/api/v2/media_space/upload_image";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await signShopee(ACCOUNT.partner_id, ACCOUNT.partner_key, path, timestamp);
  const params = new URLSearchParams({
    partner_id: ACCOUNT.partner_id,
    timestamp: String(timestamp),
    sign,
  });
  const res = await fetch(`${SHOPEE_API_URL}${path}?${params}`, {
    method: "POST",
    body: form,
  });
  const body: any = await res.json();
  if (body.error) throw new Error(body.error + " - " + (body.message || ""));

  const imageId = body.response?.image_info?.image_id
    || body.response?.image_info_list?.[0]?.image_info?.image_id
    || null;
  if (!imageId) throw new Error("Shopee tidak mengembalikan image_id");
  return String(imageId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders() });
  }

  try {
    const body: any = await req.json().catch(() => ({}));
    const productId = body.product_id != null ? Number(body.product_id) : null;
    if (!productId || !Number.isInteger(productId)) {
      return jsonError("product_id wajib (integer)");
    }

    // 1. Ambil produk dari DB
    const { data: product, error: prodErr } = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .maybeSingle();
    if (prodErr) return jsonError("Gagal memuat produk: " + prodErr.message);
    if (!product) return jsonError("Produk tidak ditemukan");

    // 2. Idempotency: sudah publish?
    if (product.shopee_item_id != null) {
      return new Response(JSON.stringify({ success: true, status: "already_published", item_id: product.shopee_item_id }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    // 3. Validasi
    if (!product.name || !product.name.trim()) return jsonError("Nama produk kosong");
    if (!product.sku || !product.sku.trim()) return jsonError("SKU produk kosong");
    if (!(product.price > 0)) return jsonError("Harga produk harus > 0");
    if (product.stock == null || product.stock < 0) return jsonError("Stok produk tidak valid");

    const categoryId = CATEGORY_MAP[product.category || ""];
    if (!categoryId) return jsonError("Kategori Shopee belum dipetakan.");

    // 4. Token (dimuat dulu, dibutuhkan untuk upload gambar)
    const shopId = ACCOUNT.shop_id;
    let { access_token, refresh_token } = await loadToken(shopId);
    if (!access_token && refresh_token) {
      const r = await refreshToken(shopId, refresh_token);
      if (r.access_token) access_token = r.access_token;
    }
    if (!access_token) return jsonError("Access token tidak tersedia. Silakan reconnect OAuth Shopee.");

    // 5. Gambar: imageicon URL -> upload ke Shopee -> image_id
    const imageicon = product.imageicon;
    if (!imageicon) return jsonError("Foto produk belum tersedia.");
    let imageId: string;
    try {
      imageId = await uploadImageToShopee(String(imageicon));
    } catch (err: any) {
      return jsonError("Upload gambar gagal: " + (err.message || "unknown"));
    }

    // 6. Build payload
    const attributeList = ATTRIBUTE_MAP[categoryId] || [];
    const payload: Record<string, unknown> = {
      item_name: product.name,
      description: product.name,
      category_id: categoryId,
      original_price: product.price,
      seller_stock: [{ stock: product.stock }],
      item_sku: product.sku,
      weight: 1, // products belum punya field weight; default 1 kg
      image: { image_id_list: [imageId] },
      logistic_info: LOGISTIC_INFO,
      brand: { brand_id: 0, original_brand_name: "No Brand" },
    };
    if (attributeList.length) payload.attribute_list = attributeList;

    // 7. POST product/add_item (SHOP signing + JSON body)
    const path = "/api/v2/product/add_item";
    const doAddItem = async (token: string) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = await signShopee(ACCOUNT.partner_id, ACCOUNT.partner_key, path, timestamp, token, shopId);
      const params = new URLSearchParams({
        partner_id: ACCOUNT.partner_id,
        timestamp: String(timestamp),
        sign,
        shop_id: shopId,
        access_token: token,
      });
      const res = await fetch(`${SHOPEE_API_URL}${path}?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.json();
    };

    let resp = await doAddItem(access_token);
    if (resp.error && refresh_token && isAuthError(`${resp.error} ${resp.message || ""}`)) {
      const r = await refreshToken(shopId, refresh_token);
      if (r.access_token) {
        access_token = r.access_token;
        resp = await doAddItem(access_token);
      }
    }
    if (resp.error) {
      return jsonError(`${resp.error} - ${resp.message || ""}`);
    }

    const itemId = resp.response?.item_id ?? resp.response?.item?.item_id ?? null;
    if (!itemId) {
      return jsonError("Shopee tidak mengembalikan item_id. Response: " + JSON.stringify(resp).slice(0, 300));
    }

    // 8. Simpan item_id ke products (jika gagal -> jangan publish ulang)
    const updates: Record<string, unknown> = { shopee_item_id: Number(itemId) };
    if (resp.response?.item_sku) updates.shopee_sku = resp.response.item_sku;
    const { error: updErr } = await supabase.from("products").update(updates).eq("id", productId);
    if (updErr) {
      return jsonError("Shopee berhasil membuat produk tetapi item_id gagal disimpan ke Juwita. Jangan publish ulang sebelum diperiksa. item_id=" + itemId);
    }

    return new Response(JSON.stringify({ success: true, status: "published", item_id: Number(itemId), item_sku: updates.shopee_sku || null }), {
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message || "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
});
