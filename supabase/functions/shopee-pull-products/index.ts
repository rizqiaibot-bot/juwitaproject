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

function extractImageUrl(item: any): string | null {
  const url = item?.image?.image_url_list?.[0];
  return typeof url === "string" && url.length > 0 ? url : null;
}

async function refreshToken(partnerId: string, partnerKey: string, shopId: string, refreshTokenValue: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/access_token/get";
  const sign = await signShopee(partnerId, partnerKey, path, timestamp, "", "");
  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    sign,
  });
  const jsonBody = JSON.stringify({
    refresh_token: refreshTokenValue,
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
    return { error: body.error || body.message || "refresh failed", access_token: null };
  }
  await supabase.from("marketplace_credentials").upsert({
    shop_id: shopId,
    platform: "shopee",
    access_token: body.access_token,
    refresh_token: body.refresh_token || refreshTokenValue,
    updated_at: new Date().toISOString(),
  });
  return { error: null, access_token: body.access_token };
}

function isAuthError(text: string): boolean {
  const lower = (text || "").toLowerCase();
  return lower.includes("access_token") || lower.includes("error_auth") || lower.includes("token_invalid") || lower.includes("token_expired");
}

async function collectItemIds(partnerId: string, partnerKey: string, shopId: string, accessToken: string): Promise<number[]> {
  const ids: number[] = [];
  let offset = 0;
  while (true) {
    const resp = await shopeeGet(partnerId, partnerKey, "/api/v2/product/get_item_list", accessToken, shopId, {
      offset: String(offset),
      page_size: "100",
      item_status: "NORMAL",
    });
    const items = resp.item || [];
    for (const item of items) {
      if (item.item_id != null) ids.push(Number(item.item_id));
    }
    const hasNext = resp.has_next_page || false;
    const nextOffset = resp.next_offset ?? (offset + items.length);
    if (!hasNext || items.length === 0) break;
    offset = nextOffset;
  }
  return ids;
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

    const { shop_id, action, pairs } = await req.json();
    const shopId = String(shop_id || "").trim();

    // Allowlist action: undefined (legacy) / "pull" / "pull_exact" / "apply_mapping" → jalur write.
    // "dry_run" → read-only. Lainnya → 400.
    const writeAction = action === undefined || action === null || action === "pull" || action === "pull_exact" || action === "apply_mapping";
    if (!writeAction && action !== "dry_run") {
      return new Response(JSON.stringify({
        success: false,
        error: "action tidak dikenal. Gunakan: dry_run, pull, pull_exact, apply_mapping, atau kosongkan untuk pull.",
        action: action || null,
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    if (!shopId) {
      return new Response(JSON.stringify({ success: false, error: "shop_id wajib diisi di body request" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // ============================================================
    // ACTION: apply_mapping — tulis mapping eksplisit dari body (TANPA matching)
    // Khusus Shopee 2 (1214362884). Tidak menyentuh products/stock/mapping lain.
    // ============================================================
    if (action === "apply_mapping") {
      if (shopId !== "1214362884") {
        return new Response(JSON.stringify({
          success: false,
          error: "apply_mapping hanya diizinkan untuk shop_id 1214362884",
          shop_id: shopId,
        }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }

      if (!Array.isArray(pairs) || pairs.length === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: "pairs wajib berupa array non-kosong di body request",
        }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }

      // Whitelist 30 pasangan hasil validasi READY_TO_MAP (dikunci per shopee_item_id)
      const ALLOWED_PAIRS: Record<string, { product_id: number; shopee_item_id: number; shopee_sku: string | null }> = {
        "40652514801": { product_id: 7, shopee_item_id: 40652514801, shopee_sku: "FROZEN FOOD" },
        "40952105247": { product_id: 46, shopee_item_id: 40952105247, shopee_sku: "FROZEN FOOD" },
        "49562529052": { product_id: 53, shopee_item_id: 49562529052, shopee_sku: "kentang goreng" },
        "43254403980": { product_id: 126, shopee_item_id: 43254403980, shopee_sku: "BAKSO" },
        "47011878052": { product_id: 297, shopee_item_id: 47011878052, shopee_sku: "sosis bakar" },
        "57256637972": { product_id: 402, shopee_item_id: 57256637972, shopee_sku: "otak otak ikan" },
        "47805429752": { product_id: 545, shopee_item_id: 47805429752, shopee_sku: "kornet ayam" },
        "44267944033": { product_id: 552, shopee_item_id: 44267944033, shopee_sku: "BAWANG BOMBAY" },
        "43801984831": { product_id: 662, shopee_item_id: 43801984831, shopee_sku: "Minyak Goreng" },
        "52501958107": { product_id: 739, shopee_item_id: 52501958107, shopee_sku: "BASRENG" },
        "52001081114": { product_id: 749, shopee_item_id: 52001081114, shopee_sku: "otak otak ikan" },
        "42117956089": { product_id: 932, shopee_item_id: 42117956089, shopee_sku: "mitraKU" },
        "41302266555": { product_id: 952, shopee_item_id: 41302266555, shopee_sku: "FROZEN FOOD" },
        "44452089853": { product_id: 962, shopee_item_id: 44452089853, shopee_sku: "FROZEN FOOD" },
        "27486832240": { product_id: 1215, shopee_item_id: 27486832240, shopee_sku: "FROZEN FOOD" },
        "43052397063": { product_id: 1269, shopee_item_id: 43052397063, shopee_sku: "SOSIS" },
        "42652388318": { product_id: 1279, shopee_item_id: 42652388318, shopee_sku: "FROZEN FOOD" },
        "42670629890": { product_id: 1313, shopee_item_id: 42670629890, shopee_sku: "saus euro gourmet" },
        "43501563231": { product_id: 1318, shopee_item_id: 43501563231, shopee_sku: "MINYAK GORENG" },
        "42102161683": { product_id: 1334, shopee_item_id: 42102161683, shopee_sku: "FROZEN FOOD" },
        "42751554351": { product_id: 1364, shopee_item_id: 42751554351, shopee_sku: "MINYAK GORENG" },
        "42452088632": { product_id: 1369, shopee_item_id: 42452088632, shopee_sku: "SOSIS" },
        "29842321893": { product_id: 1374, shopee_item_id: 29842321893, shopee_sku: "minyak goreng" },
        "43101868973": { product_id: 1399, shopee_item_id: 43101868973, shopee_sku: "Saus" },
        "40351806510": { product_id: 1417, shopee_item_id: 40351806510, shopee_sku: "FROZEN FOOD" },
        "42801868663": { product_id: 1423, shopee_item_id: 42801868663, shopee_sku: "Saus" },
        "43251859040": { product_id: 1424, shopee_item_id: 43251859040, shopee_sku: "Saus" },
        "43702549828": { product_id: 1441, shopee_item_id: 43702549828, shopee_sku: "FROZEN FOOD" },
        "41371955340": { product_id: 1472, shopee_item_id: 41371955340, shopee_sku: "minyak goreng" },
        "42352261821": { product_id: 1586, shopee_item_id: 42352261821, shopee_sku: "FROZEN FOOD" },
      };

      const seen = new Set<string>();
      const toUpsert: any[] = [];
      const rejected: any[] = [];
      for (const p of pairs) {
        const productId = Number(p?.product_id);
        const itemId = Number(p?.shopee_item_id);
        if (!Number.isInteger(productId) || !Number.isInteger(itemId)) {
          rejected.push({ product_id: p?.product_id ?? null, shopee_item_id: p?.shopee_item_id ?? null, reason: "invalid value" });
          continue;
        }
        const allowed = ALLOWED_PAIRS[String(itemId)];
        if (!allowed || allowed.product_id !== productId) {
          rejected.push({ product_id: productId, shopee_item_id: itemId, reason: "pair tidak diizinkan di whitelist" });
          continue;
        }
        const key = `${productId}|${itemId}`;
        if (seen.has(key)) {
          rejected.push({ product_id: productId, shopee_item_id: itemId, reason: "duplicate pair dalam body" });
          continue;
        }
        seen.add(key);
        toUpsert.push({
          product_id: productId,
          shop_id: shopId,
          shopee_item_id: itemId,
          shopee_sku: allowed.shopee_sku ?? null,
        });
      }

      // Upsert — aman terhadap UNIQUE (shop_id, shopee_item_id) & (product_id, shop_id)
      let failed = 0;
      const batchSize = 50;
      for (let i = 0; i < toUpsert.length; i += batchSize) {
        const batch = toUpsert.slice(i, i + batchSize);
        const { error } = await supabase
          .from("product_shopee_mapping")
          .upsert(batch, { onConflict: "shop_id,shopee_item_id" });
        if (error) {
          console.error("apply_mapping upsert error:", error.message);
          failed += batch.length;
        }
      }

      return new Response(JSON.stringify({
        success: failed === 0,
        action: "apply_mapping",
        shop_id: shopId,
        requested: pairs.length,
        upserted: toUpsert.length,
        failed,
        rejected,
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    if (!partnerId || !partnerKey) {
      return new Response(JSON.stringify({ success: false, error: "Credential Shopee belum dikonfigurasi" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    let { access_token, refresh_token } = await loadToken(shopId);

    // dry_run: TIDAK boleh menulis apa pun → jangan auto-refresh token (refreshToken melakukan upsert)
    if (action === "dry_run") {
      if (!access_token) {
        return new Response(JSON.stringify({ success: false, error: "Access token tidak tersedia. Silakan reconnect OAuth Shopee." }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }
    } else if (!access_token && refresh_token) {
      const r = await refreshToken(partnerId, partnerKey, shopId, refresh_token);
      if (r.access_token) access_token = r.access_token;
      if (!access_token) {
        return new Response(JSON.stringify({ success: false, error: "Access token tidak tersedia. Silakan reconnect OAuth Shopee." }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders() }
        });
      }
    }

    if (!access_token) {
      return new Response(JSON.stringify({ success: false, error: "Access token tidak tersedia. Silakan reconnect OAuth Shopee." }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // 1. Kumpulkan semua item_id (paginasi), refresh bila token expired
    let itemIds: number[] = [];
    try {
      itemIds = await collectItemIds(partnerId, partnerKey, shopId, access_token);
    } catch (err: any) {
      // dry_run: jangan auto-refresh (refreshToken menulis DB) → biarkan error keluar
      if (action !== "dry_run" && isAuthError(err.message) && refresh_token) {
        const r = await refreshToken(partnerId, partnerKey, shopId, refresh_token);
        if (r.access_token) {
          access_token = r.access_token;
          itemIds = await collectItemIds(partnerId, partnerKey, shopId, access_token);
        } else {
          throw new Error("Token refresh gagal: " + (r.error || "unknown"));
        }
      } else {
        throw err;
      }
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

    // ============================================================
    // ACTION: dry_run — simulasi matching TANPA menulis database
    // ============================================================
    if (action === "dry_run") {
      const { data: dryProducts } = await supabase
        .from("products")
        .select("id, sku, shopee_sku, barcode, name");
      const dryProductRows = dryProducts || [];

      const norm = (v: any) => String(v || "").trim().toLowerCase();
      const normName = (v: any) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
      const bySku = new Map<string, any>();
      const byShopeeSku = new Map<string, any>();
      const byBarcode = new Map<string, any>();
      const byName = new Map<string, any[]>();
      for (const p of dryProductRows) {
        if (p.sku) bySku.set(norm(p.sku), p);
        if (p.shopee_sku) byShopeeSku.set(norm(p.shopee_sku), p);
        if (p.barcode) byBarcode.set(norm(p.barcode), p);
        const key = normName(p.name);
        if (key) {
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key)!.push(p);
        }
      }

      let matchedBySku = 0, matchedByShopeeSku = 0, unmatched = 0, multiple = 0;
      let exact = 0, possible = 0, noMatch = 0, ambiguous = 0;
      let conflictCount = 0;
      const possibleExamples: any[] = [];
      const conflicts: any[] = [];
      const seenItemIds = new Set<string>();

      // Mapping Shopee yang SUDAH ada utk shop ini → dasar deteksi bentrokan
      const { data: dryMappings } = await supabase
        .from("product_shopee_mapping")
        .select("product_id, shop_id, shopee_item_id, shopee_sku")
        .eq("shop_id", shopId);
      const dryMappingRows = dryMappings || [];
      const mapByProductId = new Map<string, any>();
      const mapByItemId = new Map<string, any>();
      for (const m of dryMappingRows) {
        if (m.product_id != null) mapByProductId.set(String(m.product_id), m);
        if (m.shopee_item_id != null) mapByItemId.set(String(m.shopee_item_id), m);
      }

      const classify = (item: any) => {
        const itemId = item.item_id != null ? Number(item.item_id) : null;
        const itemSku = (item.item_sku || "").trim();
        const normSku = itemSku.toLowerCase();
        const itemBarcode = (item.barcode || "").trim();
        const itemName = item.item_name || "";

        // 1) SKU / shopee_sku pusat → EXACT
        let cand: any = null;
        if (normSku) {
          cand = bySku.get(normSku) || byShopeeSku.get(normSku) || null;
        }
        if (cand) return { cls: "EXACT", cand, reason: "item_sku cocok dengan products.sku/shopee_sku" };

        // 2) barcode pusat → EXACT (hanya jika barcode listing tersedia)
        if (itemBarcode) {
          cand = byBarcode.get(norm(itemBarcode)) || null;
          if (cand) return { cls: "EXACT", cand, reason: "barcode cocok dengan products.barcode" };
        }

        // 3) nama ternormalisasi (case/whitespace/punctuation diabaikan)
        const nameKey = normName(itemName);
        if (nameKey) {
          const nameCands = byName.get(nameKey) || [];
          if (nameCands.length === 1) {
            return { cls: "POSSIBLE", cand: nameCands[0], reason: "nama cocok persis setelah normalisasi" };
          }
          if (nameCands.length > 1) {
            return { cls: "POSSIBLE", cand: nameCands[0], reason: "nama cocok tapi multi-kandidat (ambigu)", ambiguous: true };
          }
        }

        return { cls: "NO_MATCH", cand: null, reason: "tidak ada kandidat barcode/SKU/nama" };
      };

      for (const item of allItems) {
        const itemId = item.item_id != null ? Number(item.item_id) : null;
        if (itemId != null && seenItemIds.has(String(itemId))) {
          multiple++;
          continue;
        }
        if (itemId != null) seenItemIds.add(String(itemId));

        const itemSku = (item.item_sku || "").trim();
        const normSku = itemSku.toLowerCase();

        let matchedProduct: any = null;
        let matchedViaShopeeSku = false;
        if (normSku) {
          if (bySku.has(normSku)) {
            matchedProduct = bySku.get(normSku);
          } else if (byShopeeSku.has(normSku)) {
            matchedProduct = byShopeeSku.get(normSku);
            matchedViaShopeeSku = true;
          }
        }

        if (matchedProduct) {
          const productId = Number(matchedProduct.id);

          // BENTROKAN: SKU cocok, tapi product_id ini SUDAH punya listing Shopee 2
          // (existing mapping). UNIQUE (product_id, shop_id) → listing ini tidak akan masuk.
          const existing = mapByItemId.has(String(itemId))
            ? mapByItemId.get(String(itemId))
            : mapByProductId.get(String(productId)) || null;

          const existingItemId = existing && existing.shopee_item_id != null ? Number(existing.shopee_item_id) : null;

          // Self-conflict (existing == conflicting) = listing yang SUDAH ter-mapping →
          // BUKAN conflict, diabaikan.
          if (existing && existingItemId !== itemId) {
            conflictCount++;
            conflicts.push({
              product_id: productId,
              product_sku: matchedProduct.sku || matchedProduct.shopee_sku || null,
              existing_shopee_item_id: existingItemId,
              conflicting_shopee_item_id: itemId,
              conflicting_item_sku: itemSku || null,
              conflicting_item_name: item.item_name || "",
            });
            continue;
          }

          if (matchedViaShopeeSku) matchedByShopeeSku++;
          else matchedBySku++;
          continue;
        }

        unmatched++;
        const res = classify(item);
        if (res.cls === "EXACT") exact++;
        else if (res.cls === "POSSIBLE") {
          possible++;
          if (res.ambiguous) ambiguous++;
          if (possibleExamples.length < 30) {
            possibleExamples.push({
              shopee_item_id: item.item_id != null ? Number(item.item_id) : null,
              item_sku: itemSku || null,
              item_name: item.item_name || "",
              kandidat_product_id: res.cand ? Number(res.cand.id) : null,
              kandidat_sku: res.cand ? (res.cand.sku || res.cand.shopee_sku || null) : null,
              alasan: res.reason,
            });
          }
        }
        else noMatch++;
      }

      return new Response(JSON.stringify({
        success: true,
        dry_run: true,
        shop_id: shopId,
        total_listing: allItems.length,
        matched_by_sku: matchedBySku,
        matched_by_shopee_sku: matchedByShopeeSku,
        unmatched,
        multiple_match: multiple,
        classification: { exact, possible, ambiguous, no_match: noMatch },
        possible_examples: possibleExamples,
        conflict_count: conflictCount,
        conflicts: conflicts.slice(0, 300),
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    // 3. Load produk pusat (master) + mapping Shopee yang sudah ada utk shop ini
    const { data: existingProducts } = await supabase
      .from("products")
      .select("id, sku, shopee_sku, shopee_item_id");
    const products = existingProducts || [];

    const { data: existingMappings } = await supabase
      .from("product_shopee_mapping")
      .select("product_id, shop_id, shopee_item_id, shopee_sku")
      .eq("shop_id", shopId);
    const mappingRows = existingMappings || [];

    const norm = (v: any) => String(v || "").trim().toLowerCase();

    // Indeks produk pusat berdasarkan identitas yang BENAR-BENAR tersedia:
    // products.sku dan products.shopee_sku (SKU pusat = identitas produk).
    const bySku = new Map<string, any>();
    for (const p of products) {
      if (p.sku) bySku.set(norm(p.sku), p);
      if (p.shopee_sku) bySku.set(norm(p.shopee_sku), p);
    }

    // Indeks mapping utk shop ini: by shopee_item_id (anti duplikat pada re-pull)
    // dan by product_id (agar satu produk tidak di-map dua kali dalam shop yang sama).
    const mapByItemId = new Map<string, any>();
    const mapByProductId = new Map<string, any>();
    for (const m of mappingRows) {
      if (m.shopee_item_id != null) mapByItemId.set(String(m.shopee_item_id), m);
      if (m.product_id != null) mapByProductId.set(String(m.product_id), m);
    }

    const toUpsert: any[] = [];
    let fetched = 0, matched = 0, unmatched = 0, failed = 0;
    const unmatchedItems: any[] = [];

    // 4. Cocokkan setiap listing Shopee ke produk pusat (hanya via SKU pusat).
    //    Item yang tidak cocok DILEWATI (tidak dibuatkan produk baru).
    for (const item of allItems) {
      fetched++;
      const itemId = item.item_id != null ? Number(item.item_id) : null;
      const itemSku = (item.item_sku || "").trim();
      const normSku = itemSku.toLowerCase();

      // 4a. Jika mapping sudah ada utk item ini di shop ini → aman, skip (anti duplikat)
      if (itemId != null && mapByItemId.has(String(itemId))) {
        matched++;
        continue;
      }

      // 4b. Cocokkan ke produk pusat via SKU (produk pusat = master SKU/barcode)
      let product = null;
      if (normSku) product = bySku.get(normSku) || null;

      if (!product) {
        unmatched++;
        unmatchedItems.push({ shopee_item_id: itemId, item_sku: itemSku || null, item_name: item.item_name || "" });
        continue;
      }

      const productId = Number(product.id);

      // 4c. Jika produk pusat sudah ter-map di shop ini → update mapping tsb
      //     (jangan buat duplikat; UNIQUE (product_id, shop_id)).
      const existingByProduct = mapByProductId.get(String(productId));
      if (existingByProduct) {
        const updates: any = {
          shopee_item_id: itemId,
          shopee_sku: itemSku || null,
          updated_at: new Date().toISOString(),
        };
        const { error } = await supabase
          .from("product_shopee_mapping")
          .update(updates)
          .eq("id", existingByProduct.id);
        if (error) failed++;
        mapByItemId.set(String(itemId), existingByProduct);
        matched++;
        continue;
      }

      // 4d. Mapping baru utk shop ini
      const newRow = {
        product_id: productId,
        shop_id: shopId,
        shopee_item_id: itemId,
        shopee_sku: itemSku || null,
      };
      toUpsert.push(newRow);
      mapByItemId.set(String(itemId), { id: null, product_id: productId });
      mapByProductId.set(String(productId), { id: null, product_id: productId });
      matched++;
    }

    // 5. Upsert mapping — aman terhadap UNIQUE (shop_id, shopee_item_id) & (product_id, shop_id)
    const insertBatchSize = 100;
    for (let i = 0; i < toUpsert.length; i += insertBatchSize) {
      const batch = toUpsert.slice(i, i + insertBatchSize);
      const { error } = await supabase
        .from("product_shopee_mapping")
        .upsert(batch, { onConflict: "shop_id,shopee_item_id" });
      if (error) {
        console.error("Mapping upsert error:", error.message);
        failed += batch.length;
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
        metadata: { fetched, matched, unmatched, failed, unmatched_items: unmatchedItems.slice(0, 20) }
      });
    } catch (logErr: any) {
      console.error("Activity log insert failed:", logErr.message);
    }

    return new Response(JSON.stringify({
      success: true,
      fetched,
      matched,
      unmatched,
      failed,
      unmatched_items: unmatchedItems.slice(0, 50)
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
