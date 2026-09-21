// ============================================================
// Worker lokal: Shopee IMPORT orders (marketplace_orders → orders)
// VPS, bukan Supabase. Jalankan via systemd timer (setelah pull).
//   DATABASE_URL         (dari .juwita-one-api.env)
//   SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SHOP_ID
//   SHOPEE2_PARTNER_ID, SHOPEE2_PARTNER_KEY, SHOPEE2_SHOP_ID
//   (dari .juwita-shopee.env)
// ============================================================
// Idempoten: 1 mp_order_id hanya menghasilkan 1 orders.
//   - Guard: marketplace_orders.internal_order_id.
//   - orders.orderid PK.
// Harga jual Shopee: product_prices (channel 'shopee:<shop_id>'), BUKAN products.price.
// wmsstatus awal = "Baru" (masuk Picking, BUKAN langsung Siap Kirim).
// Stok: products.stock -= qty + stock_mutations (OUT, pending) — sekali.
// Order status dibatalkan/cancelled → TIDAK diimport.
// ============================================================
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL wajib di-set");

const DRY_RUN = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const DRY_RUN_PER_SHOP = Number(process.env.DRY_RUN_LIMIT) || 5;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

const SHOPEE_API_URL = "https://partner.shopeemobile.com";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = [500, 502, 503, 504];

const CANCELLED_STATUSES = new Set(["CANCELLED", "IN_CANCEL", "FAILED", "TO_RETURN"]);

const ACCOUNTS = [
  { label: "toko_1", partner_id: process.env.SHOPEE_PARTNER_ID || "", partner_key: process.env.SHOPEE_PARTNER_KEY || "", shop_id: process.env.SHOPEE_SHOP_ID || "" },
  { label: "toko_2", partner_id: process.env.SHOPEE2_PARTNER_ID || "", partner_key: process.env.SHOPEE2_PARTNER_KEY || "", shop_id: process.env.SHOPEE2_SHOP_ID || "" },
];

function accountForShop(shopId) {
  for (const a of ACCOUNTS) {
    if (a.shop_id && String(a.shop_id) === String(shopId) && a.partner_id) return a;
  }
  return null;
}

function channelForShop(shopId) {
  return "shopee:" + String(shopId);
}

async function signShopee(partnerId, partnerKey, path, timestamp, accessToken = "", shopId = "") {
  const base = partnerId + path + timestamp + accessToken + shopId;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(partnerKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return res;
      if (RETRYABLE_STATUSES.includes(res.status) && attempt < retries) { lastError = new Error(`HTTP ${res.status}`); continue; }
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    } catch (err) {
      lastError = err.name === "AbortError" ? new Error("timeout") : err;
      if (attempt >= retries) throw lastError;
    }
  }
  throw lastError;
}

async function loadToken(shopId) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token FROM marketplace_credentials WHERE shop_id = $1 LIMIT 1",
    [String(shopId)]
  );
  const r = rows[0];
  if (!r) return { access_token: null, refresh_token: null };
  return { access_token: r.access_token || null, refresh_token: r.refresh_token || null };
}

async function refreshToken(account, shopId, refreshTokenValue) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/auth/access_token/get";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp);
  const params = new URLSearchParams({ partner_id: account.partner_id, timestamp: String(timestamp), sign });
  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshTokenValue, shop_id: Number(shopId), partner_id: Number(account.partner_id) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error || !body.access_token) {
    return { error: body.error || body.message || "refresh failed", access_token: null };
  }
  await pool.query(
    `INSERT INTO marketplace_credentials (shop_id, platform, access_token, refresh_token, updated_at)
     VALUES ($1, 'shopee', $2, $3, now())
     ON CONFLICT (shop_id) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, updated_at = now()`,
    [String(shopId), body.access_token, body.refresh_token || refreshTokenValue]
  );
  return { error: null, access_token: body.access_token };
}

// get_order_detail dengan field lengkap (item_list + recipient_address) agar
// order_items & customer bisa dibangun dari raw_payload.
async function getOrderDetail(account, accessToken, orderSns) {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v2/order/get_order_detail";
  const sign = await signShopee(account.partner_id, account.partner_key, path, timestamp, accessToken, account.shop_id);
  const params = new URLSearchParams({
    partner_id: account.partner_id, timestamp: String(timestamp), sign,
    shop_id: account.shop_id, access_token: accessToken, order_sn_list: orderSns.join(","),
    response_optional_fields: "buyer_user_name,total_amount,item_list,recipient_address",
  });
  const res = await fetchWithRetry(`${SHOPEE_API_URL}${path}?${params}`, { method: "GET" });
  const body = await res.json();
  if (body.error) throw new Error(`Shopee API error: ${body.error} - ${body.message || ""}`);
  return body.response?.order_list || [];
}

// Pre-fetch detail (batch 50) untuk order yang raw_payload-nya belum punya item_list.
async function prefetchMissingDetails(rows, allowRefresh) {
  const byShop = {};
  for (const row of rows) {
    if (row.raw_payload && Array.isArray(row.raw_payload.item_list)) continue;
    (byShop[row.shop_id] = byShop[row.shop_id] || []).push(row);
  }
  for (const shopId of Object.keys(byShop)) {
    const account = accountForShop(shopId);
    if (!account) continue;
    const { access_token, refresh_token } = await loadToken(shopId);
    let token = access_token;
    if (!token && refresh_token && allowRefresh) {
      const r = await refreshToken(account, shopId, refresh_token);
      if (r.access_token) token = r.access_token;
    }
    if (!token) continue;
    const group = byShop[shopId];
    for (let i = 0; i < group.length; i += 50) {
      const batch = group.slice(i, i + 50);
      let details;
      try {
        details = await getOrderDetail(account, token, batch.map((r) => r.mp_order_id));
      } catch (e) {
        console.error(`prefetch detail gagal shop=${shopId} batch=${i}: ${e.message}`);
        continue;
      }
      const bySn = {};
      details.forEach((d) => { if (d && d.order_sn) bySn[d.order_sn] = d; });
      for (const r of batch) {
        const d = bySn[r.mp_order_id];
        if (!d) continue;
        r.raw_payload = d;
        r.order_status = d.order_status || r.order_status;
        if (!DRY_RUN) {
          await pool.query(
            "UPDATE marketplace_orders SET raw_payload=$1, customer_name=$2, total=$3, order_status=$4 WHERE id=$5",
            [JSON.stringify(d), d.buyer_user_name || d.recipient_address?.name || null, Math.round(parseFloat(d.total_amount) || 0), d.order_status || r.order_status, r.id]
          );
        }
      }
    }
  }
  return rows;
}

function buildMapping(payload, mappings, prodById, priceById) {
  const items = Array.isArray(payload.item_list) ? payload.item_list : [];
  const mapByItemId = {};
  mappings.forEach((m) => { mapByItemId[String(m.shopee_item_id)] = m.product_id; });
  const mapped = [];
  const unmapped = [];
  for (const item of items) {
    const qty = item.model_quantity_purchased || 1;
    const pid = mapByItemId[String(item.item_id)];
    const prod = pid != null ? prodById[pid] : null;
    if (!prod) {
      unmapped.push({ shopee_item_id: item.item_id, name: item.item_name || item.model_sku || String(item.item_id) });
      continue;
    }
    const rawPrice = priceById[pid];
    if (rawPrice == null) {
      unmapped.push({ shopee_item_id: item.item_id, name: prod.name, reason: "harga channel belum diset" });
      continue;
    }
    const price = Math.round(Number(rawPrice) || 0);
    mapped.push({ product_id: prod.id, product_name: prod.name, qty, price, subtotal: price * qty, stock: Number(prod.stock) || 0 });
  }
  return { items, mapped, unmapped };
}

async function loadMappings(shopId, itemIds) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    "SELECT product_id, shopee_item_id FROM product_shopee_mapping WHERE shop_id = $1 AND shopee_item_id = ANY($2)",
    [String(shopId), itemIds]
  );
  return rows;
}

async function loadProducts(productIds) {
  const uniq = [...new Set(productIds)];
  if (!uniq.length) return {};
  const { rows } = await pool.query("SELECT id, name, stock FROM products WHERE id = ANY($1)", [uniq]);
  const map = {};
  rows.forEach((p) => { map[p.id] = p; });
  return map;
}

async function loadChannelPrices(channel, productIds) {
  const uniq = [...new Set(productIds)];
  if (!uniq.length) return {};
  const { rows } = await pool.query(
    "SELECT product_id, price FROM product_prices WHERE channel = $1 AND product_id = ANY($2)",
    [channel, uniq]
  );
  const map = {};
  rows.forEach((p) => { map[p.product_id] = p.price; });
  return map;
}

async function importOrder(row) {
  const payload = row.raw_payload;
  if (!payload || !Array.isArray(payload.item_list)) {
    return { status: "failed", order_sn: row.mp_order_id, error: "item_list tidak tersedia (prefetch detail gagal)" };
  }

  // Guard status: order dibatalkan/tidak layak → tidak import.
  const st = String(payload.order_status || row.order_status || "").toUpperCase();
  if (CANCELLED_STATUSES.has(st)) {
    if (!DRY_RUN) {
      await pool.query(
        "UPDATE marketplace_orders SET sync_status='ignored', error_message=$1, updated_at=now() WHERE id=$2",
        ["cancelled: " + st, row.id]
      );
    }
    return { status: "ignored", order_sn: row.mp_order_id, reason: st };
  }

  const items = payload.item_list;
  if (!items.length) return { status: "failed", order_sn: row.mp_order_id, error: "item_list kosong" };

  const itemIds = items.map((i) => i.item_id).filter((v) => v != null);
  const mappings = await loadMappings(row.shop_id, itemIds);
  const prodById = await loadProducts(mappings.map((m) => m.product_id));
  const priceById = await loadChannelPrices(channelForShop(row.shop_id), mappings.map((m) => m.product_id));
  const { mapped, unmapped } = buildMapping(payload, mappings, prodById, priceById);

  if (unmapped.length) {
    return { status: "failed", order_sn: row.mp_order_id, error: "produk belum dimapping/harga belum diset: " + JSON.stringify(unmapped) };
  }
  if (!mapped.length) return { status: "failed", order_sn: row.mp_order_id, error: "tidak ada item yang terpetakan" };

  const total = mapped.reduce((s, i) => s + i.subtotal, 0);
  const customer = payload.buyer_user_name || payload.recipient_address?.name || "Marketplace Customer";
  const nowIso = new Date().toISOString();
  const todayStamp = nowIso.slice(0, 10).replace(/-/g, "");
  const dateStr = nowIso.slice(0, 16).replace("T", " ");

  if (DRY_RUN) {
    return {
      status: "would_import", order_sn: row.mp_order_id, shop_id: row.shop_id, status_shopee: st,
      customer, total, date: dateStr, mapped: mapped.map((m) => ({ product_id: m.product_id, product_name: m.product_name, qty: m.qty, price: m.price, subtotal: m.subtotal })),
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let orderId = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rows: cnt } = await client.query("SELECT count(*)::int AS c FROM orders WHERE orderid LIKE $1", ["ORD-" + todayStamp + "-%"]);
      const n = (cnt[0].c || 0) + 1;
      orderId = "ORD-" + todayStamp + "-" + String(n).padStart(2, "0");
      try {
        await client.query(
          "INSERT INTO orders (orderid, date, channel, shop_id, customer, total, paystatus, wmsstatus, courier, resi) VALUES ($1,$2,'Shopee',$3,$4,$5,'Lunas','Baru','Shopee','-')",
          [orderId, dateStr, String(row.shop_id), customer, total]
        );
        break;
      } catch (e) {
        if (e.code === "23505") continue;
        throw e;
      }
    }
    if (!orderId) throw new Error("gagal generate orderid");

    for (const m of mapped) {
      await client.query(
        "INSERT INTO order_items (orderid, product_id, product_name, qty, price, subtotal) VALUES ($1,$2,$3,$4,$5,$6)",
        [orderId, m.product_id, m.product_name, m.qty, m.price, m.subtotal]
      );
    }

    for (const m of mapped) {
      const before = m.stock;
      const after = before - m.qty;
      await client.query("UPDATE products SET stock = $1 WHERE id = $2", [after, m.product_id]);
      await client.query(
        "INSERT INTO stock_mutations (product_id, product_name, type, quantity, qty_before, qty_after, source, sync_status, created_at) VALUES ($1,$2,'OUT',$3,$4,$5,$6,'pending',now())",
        [m.product_id, m.product_name, m.qty, before, after, "Shopee: " + row.mp_order_id]
      );
    }

    await client.query(
      "UPDATE marketplace_orders SET sync_status='processed', internal_order_id=$1, error_message=NULL, updated_at=now() WHERE id=$2",
      [orderId, row.id]
    );

    await client.query("COMMIT");
    return { status: "imported", order_sn: row.mp_order_id, internal_order_id: orderId };
  } catch (e) {
    await client.query("ROLLBACK");
    await pool.query(
      "UPDATE marketplace_orders SET sync_status='failed', error_message=$1, updated_at=now() WHERE id=$2",
      [e.message, row.id]
    );
    return { status: "failed", order_sn: row.mp_order_id, error: e.message };
  } finally {
    client.release();
  }
}

async function main() {
  const { rows } = await pool.query(
    "SELECT id, shop_id, mp_order_id, raw_payload, order_status, internal_order_id FROM marketplace_orders WHERE platform='shopee' AND sync_status='pending' ORDER BY created_at ASC"
  );

  const pendingRows = rows.filter((r) => !r.internal_order_id);
  const withItems = pendingRows.filter((r) => r.raw_payload && Array.isArray(r.raw_payload.item_list)).length;

  console.log(`shopee-import: mode=${DRY_RUN ? "DRY_RUN" : "LIVE"} pending=${pendingRows.length} (dengan item_list=${withItems}, tanpa item_list=${pendingRows.length - withItems})`);

  // Dry-run: ambil maksimal N order per shop.
  let target = pendingRows;
  if (DRY_RUN) {
    const perShop = {};
    for (const r of pendingRows) {
      (perShop[r.shop_id] = perShop[r.shop_id] || []);
      if (perShop[r.shop_id].length < DRY_RUN_PER_SHOP) perShop[r.shop_id].push(r);
    }
    target = Object.values(perShop).flat();
    console.log(`shopee-import: dry-run menampilkan hingga ${DRY_RUN_PER_SHOP} order per shop → ${target.length} order.`);
  }

  await prefetchMissingDetails(target, !DRY_RUN);

  let imported = 0, failed = 0, wouldImport = 0, ignored = 0;
  for (const row of target) {
    try {
      const r = await importOrder(row);
      if (r.status === "imported") imported++;
      else if (r.status === "would_import") {
        wouldImport++;
        console.log(`  [DRY] order_id=${r.order_sn} shop_id=${r.shop_id} status=${r.status_shopee} total=${r.total} (${r.customer})`);
        for (const m of r.mapped) {
          console.log(`        product_id=${m.product_id} qty=${m.qty} shopee_price=${m.price} subtotal=${m.subtotal} (${m.product_name})`);
        }
      } else if (r.status === "ignored") {
        ignored++;
        console.log(`  [SKIP] ${r.order_sn}: status ${r.reason}`);
      } else { failed++; console.log(`  [FAIL] ${r.order_sn}: ${r.error}`); }
    } catch (e) {
      failed++;
      console.log(`  [FAIL] ${row.mp_order_id}: ${e.message}`);
    }
  }

  if (!DRY_RUN) {
    try {
      await pool.query(
        `INSERT INTO activity_log (event_type, direction, platform, status, triggered_by, action_source, metadata)
         VALUES ('ORDER_IMPORT','IN','shopee',$1,'system','cron',$2)`,
        [failed === 0 ? "success" : "failed", JSON.stringify({ pending: pendingRows.length, imported, failed, ignored })]
      );
    } catch (e) { console.error("activity_log failed:", e.message); }
  }

  console.log(`shopee-import: ${DRY_RUN ? "dry-run" : "done"} imported=${imported} would_import=${wouldImport} ignored=${ignored} failed=${failed} (dari ${target.length} diproses)`);
}

main().then(() => pool.end()).catch((e) => { console.error("worker error:", e.message); process.exit(1); });
