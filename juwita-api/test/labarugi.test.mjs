import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// ============================================================
// TEST LOGIKA FRONTEND LABA RUGI PER ITEM (index.html)
// Fungsi-fungsi DIEKSTRAK dari kode asli index.html lalu dijalankan
// dalam sandbox vm — bukan salinan logika. Jika index.html berubah
// dan test gagal, berarti ada regresi pada fitur Laba Rugi.
// Tidak menyentuh file apa pun (read-only).
// ============================================================

const HTML = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");

// Ambil potongan kode mulai dari needle sampai kurung kurawal penutup.
// Scanner mini yang paham string ('", `), template literal ${}, komentar,
// dan regex literal (mis. /[&<>"']/g) agar tidak salah hitung kurung.
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  return !/[A-Za-z0-9_$)\]}]/.test(src[j]);
}

// src[openIdx] harus '{'. Kembalikan indeks '}' penutup yang cocok.
function matchCloseBrace(src, openIdx) {
  let depth = 0;
  const n = src.length;
  let i = openIdx;
  while (i < n) {
    const c = src[i];
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    if (c === "/") {
      if (src[i + 1] === "/") { i += 2; while (i < n && src[i] !== "\n") i++; continue; }
      if (src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      if (isRegexStart(src, i)) {
        i++;
        while (i < n && src[i] !== "/") { if (src[i] === "\\") i++; i++; }
        i++;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        continue;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++;
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") {
          i += 2;
          i = matchCloseBrace(src, i) + 1;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

function extractBlock(needle) {
  let idx = HTML.indexOf(needle);
  if (idx === -1) throw new Error("TIDAK DITEMUKAN di index.html: " + needle);
  const before = HTML.slice(Math.max(0, idx - 6), idx);
  if (before === "async ") idx -= 6;
  const open = HTML.indexOf("{", idx);
  if (open === -1) throw new Error("Kurung kurawal tidak ditemukan untuk: " + needle);
  const close = matchCloseBrace(HTML, open);
  if (close === -1) throw new Error("Kurung kurawal tidak tertutup untuk: " + needle);
  return HTML.slice(idx, close + 1);
}

// Ambil deklarasi const berbentuk array literal `const X = [...];`.
function extractArrayConst(needle) {
  const idx = HTML.indexOf(needle);
  if (idx === -1) throw new Error("TIDAK DITEMUKAN di index.html: " + needle);
  const open = HTML.indexOf("[", idx);
  if (open === -1) throw new Error("Array tidak ditemukan untuk: " + needle);
  let depth = 0;
  for (let i = open; i < HTML.length; i++) {
    const c = HTML[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        let end = i + 1;
        if (HTML[end] === ";") end++;
        return HTML.slice(idx, end);
      }
    }
  }
  throw new Error("Array tidak tertutup untuk: " + needle);
}

const EXTRACTED = [
  extractArrayConst("const LR_CHANNELS ="),
  extractBlock("function fmtOrderDate("),
  extractBlock("function lrOrderWibDateKey("),
  extractBlock("function lrTodayWibKey("),
  extractBlock("function lrPeriodKey("),
  extractBlock("function lrOrderChannelKey("),
  extractBlock("function lrExcludedOrder("),
  extractBlock("function platformCutPercent("),
  extractBlock("function productChannelPrice("),
  extractBlock("function ppEscapeHtml("),
  extractBlock("function renderLabaRugiItems("),
  extractBlock("function renderLabaRugi("),
  extractBlock("function mapOrderRowToView("),
];

function buildSandbox() {
  const elements = {};
  const sandbox = {
    console,
    Intl,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    JSON,
    isNaN,
    isFinite,
    // --- stub yang bisa diubah per test ---
    products: [],
    productPrices: {},
    labaRugiChannel: "pos",
    labaRugiPeriod: "bulan",
    platformCuts: { pos: 0, "shopee:724153261": 19, "shopee:1214362884": 19 },
    labaRugiFetched: false,
    platformCutsFetched: false,
    ordersData: [],
    orderItemsData: [],
    // "Hari ini" WIB tetap: 27 November 2026.
    wibNowParts: () => ({ year: "2026", month: "11", day: "27", hour: "12", minute: "00", second: "00" }),
    fetchPlatformCuts: async () => {},
    document: {
      getElementById(id) {
        if (!elements[id]) elements[id] = { id, textContent: "", innerHTML: "", style: {} };
        return elements[id];
      },
    },
    getElements() {
      return elements;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED.join("\n"), sandbox);
  return sandbox;
}

const RP = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });

// ---------- CHANNEL ----------

test("lrOrderChannelKey: POS1/POS2 → pos; Shopee per shop_id; channel lain → null", () => {
  const sb = buildSandbox();
  assert.equal(sb.lrOrderChannelKey({ channel: "POS1" }), "pos");
  assert.equal(sb.lrOrderChannelKey({ channel: "POS2" }), "pos");
  assert.equal(sb.lrOrderChannelKey({ channel: "Shopee", shop_id: "724153261" }), "shopee:724153261");
  assert.equal(sb.lrOrderChannelKey({ channel: "Shopee", shop_id: "1214362884" }), "shopee:1214362884");
  assert.equal(sb.lrOrderChannelKey({ channel: "Shopee", shop_id: null }), null);
  assert.equal(sb.lrOrderChannelKey({ channel: "Shopee" }), null);
  assert.equal(sb.lrOrderChannelKey({ channel: "WhatsApp" }), null);
  assert.equal(sb.lrOrderChannelKey({ channel: "Juwita App" }), null);
  assert.equal(sb.lrOrderChannelKey({ channel: "Tokopedia" }), null);
  assert.equal(sb.lrOrderChannelKey({ channel: "Lazada" }), null);
  assert.equal(sb.lrOrderChannelKey({ channel: "POS" }), null);
});

// ---------- PESANAN BATAL ----------

test("lrExcludedOrder: paystatus/wmsstatus Batal dikecualikan", () => {
  const sb = buildSandbox();
  assert.equal(sb.lrExcludedOrder({ payStatus: "Batal", wmsStatus: "Selesai" }), true);
  assert.equal(sb.lrExcludedOrder({ payStatus: "Lunas", wmsStatus: "Batal" }), true);
  assert.equal(sb.lrExcludedOrder({ payStatus: "Batal", wmsStatus: "Batal" }), true);
  assert.equal(sb.lrExcludedOrder({ payStatus: "Lunas", wmsStatus: "Selesai" }), false);
  assert.equal(sb.lrExcludedOrder({ payStatus: "Belum", wmsStatus: "Baru" }), false);
  assert.equal(sb.lrExcludedOrder(null), false);
});

// ---------- ZONA WAKTU WIB ----------

test("fmtOrderDate: transaksi Shopee UTC dikonversi ke WIB di batas hari", () => {
  const sb = buildSandbox();
  const mkShopee = (date) => ({ channel: "Shopee", shop_id: "724153261", date, order_time: null });
  assert.equal(sb.fmtOrderDate(mkShopee("2026-11-26 16:59:00")), "2026-11-26 23:59"); // 26 Nov 23:59 WIB
  assert.equal(sb.fmtOrderDate(mkShopee("2026-11-26 17:00:00")), "2026-11-27 00:00"); // 27 Nov 00:00 WIB
  assert.equal(sb.fmtOrderDate(mkShopee("2026-11-26 23:59:00")), "2026-11-27 06:59"); // 27 Nov 06:59 WIB
  assert.equal(sb.fmtOrderDate(mkShopee("2026-11-27 00:00:00")), "2026-11-27 07:00"); // 27 Nov 07:00 WIB
  assert.equal(sb.fmtOrderDate(mkShopee("2026-11-27 16:59:00")), "2026-11-27 23:59"); // 27 Nov 23:59 WIB
  assert.equal(sb.fmtOrderDate(mkShopee("2026-11-27 17:00:00")), "2026-11-28 00:00"); // 28 Nov 00:00 WIB
  // order_time (timestamptz) diprioritaskan
  assert.equal(
    sb.fmtOrderDate({ channel: "Shopee", shop_id: "724153261", date: "2020-01-01 00:00:00", order_time: "2026-11-26T17:00:00Z" }),
    "2026-11-27 00:00"
  );
});

test("lrPeriodKey hari: transaksi tidak jatuh ke tanggal yang salah (WIB)", () => {
  const sb = buildSandbox();
  sb.labaRugiPeriod = "hari";
  const mkShopee = (date) => ({ channel: "Shopee", shop_id: "724153261", date, order_time: null });
  // "Hari ini" (stub wibNowParts) = 2026-11-27
  assert.equal(sb.lrPeriodKey(mkShopee("2026-11-26 16:59:00")), false); // 23:59 WIB kemarin
  assert.equal(sb.lrPeriodKey(mkShopee("2026-11-26 17:00:00")), true);  // 00:00 WIB hari ini
  assert.equal(sb.lrPeriodKey(mkShopee("2026-11-26 23:59:00")), true);  // 06:59 WIB hari ini
  assert.equal(sb.lrPeriodKey(mkShopee("2026-11-27 00:00:00")), true);  // 07:00 WIB hari ini
  assert.equal(sb.lrPeriodKey(mkShopee("2026-11-27 16:59:00")), true);  // 23:59 WIB hari ini
  assert.equal(sb.lrPeriodKey(mkShopee("2026-11-27 17:00:00")), false); // 00:00 WIB besok
  // POS: jam lokal, TIDAK dikonversi lagi.
  assert.equal(sb.lrPeriodKey({ channel: "POS1", date: "2026-11-27 23:59" }), true);
  assert.equal(sb.lrPeriodKey({ channel: "POS1", date: "2026-11-26 23:59" }), false);
  // Periode "bulan": tanggal lintas bulan.
  sb.labaRugiPeriod = "bulan";
  assert.equal(sb.lrPeriodKey(mkShopee("2026-10-31 16:59:00")), false); // 31 Okt 23:59 WIB
  assert.equal(sb.lrPeriodKey(mkShopee("2026-10-31 17:00:00")), true);  // 01 Nov 00:00 WIB
  assert.equal(sb.lrPeriodKey(mkShopee("2026-11-30 16:59:00")), true);  // 30 Nov 23:59 WIB
  assert.equal(sb.lrPeriodKey(mkShopee("2026-11-30 17:00:00")), false); // 01 Des 00:00 WIB
});

// ---------- DEFAULT POTONGAN ----------

test("platformCutPercent: default per channel dan nilai tersimpan", () => {
  const sb = buildSandbox();
  sb.platformCuts = {};
  assert.equal(sb.platformCutPercent("pos"), 0);
  assert.equal(sb.platformCutPercent("shopee:724153261"), 19);
  assert.equal(sb.platformCutPercent("shopee:1214362884"), 19);
  sb.platformCuts["shopee:724153261"] = 25.5;
  assert.equal(sb.platformCutPercent("shopee:724153261"), 25.5);
  assert.equal(sb.platformCutPercent("shopee:1214362884"), 19); // tetap default
});

// ---------- PIPELINE PER ITEM (qty, batal, channel lain, rumus) ----------

test("renderLabaRugiItems Shopee 1 19%: batal & channel lain tidak ikut; rumus sesuai spesifikasi", () => {
  const sb = buildSandbox();
  sb.products = [
    { id: 1, name: "Bakso", sku: "BK", modal: 35000 },
    { id: 3, name: "TanpaCost", sku: null, modal: 0 },
  ];
  sb.productPrices = {
    "1": { pos: 50000, "shopee:724153261": 50000, "shopee:1214362884": 48000 },
    "3": { pos: 30000, "shopee:724153261": 30000, "shopee:1214362884": 30000 },
  };
  sb.labaRugiChannel = "shopee:724153261";
  sb.labaRugiPeriod = "semua";
  sb.platformCuts["shopee:724153261"] = 19;

  const ords = [
    { orderId: "O1", date: "2026-11-27 10:00", channel: "Shopee", shop_id: "724153261", payStatus: "Lunas", wmsStatus: "Selesai" },
    { orderId: "O2", date: "2026-11-27 10:00", channel: "Shopee", shop_id: "724153261", payStatus: "Batal", wmsStatus: "Selesai" },
    { orderId: "O3", date: "2026-11-27 10:00", channel: "Shopee", shop_id: "724153261", payStatus: "Lunas", wmsStatus: "Batal" },
    { orderId: "O4", date: "2026-11-27 10:00", channel: "WhatsApp", shop_id: null, payStatus: "Lunas", wmsStatus: "Selesai" },
    { orderId: "O5", date: "2026-11-27 10:00", channel: "POS1", shop_id: null, payStatus: "Lunas", wmsStatus: "Selesai" },
  ];
  const items = [
    { orderid: "O1", product_id: 1, qty: 10 },
    { orderid: "O1", product_id: 3, qty: 1 },
    { orderid: "O2", product_id: 1, qty: 100 }, // batal → TIDAK ikut
    { orderid: "O3", product_id: 1, qty: 100 }, // batal → TIDAK ikut
    { orderid: "O4", product_id: 1, qty: 50 },  // WhatsApp → TIDAK ikut
    { orderid: "O5", product_id: 1, qty: 7 },   // POS1 di tab Shopee 1 → TIDAK ikut
  ];
  sb.renderLabaRugiItems(ords, items);

  const el = sb.getElements();
  // Omzet = 50000×10 + 30000×1 = 530.000
  assert.equal(el.lrItemOmzet.textContent, RP.format(530000));
  // Potongan = 9500×10 + 5700×1 = 100.700 (dihitung SEKALI)
  assert.equal(el.lrItemPotongan.textContent, RP.format(100700));
  // Bersih = 40500×10 + 24300×1 = 429.300
  assert.equal(el.lrItemBersih.textContent, RP.format(429300));
  // Cost = 35000×10 = 350.000 (tanpa-cost tidak ikut)
  assert.equal(el.lrItemHpp.textContent, RP.format(350000));
  // Laba = 5500×10 = 55.000
  assert.equal(el.lrItemLaba.textContent, RP.format(55000));

  const html = el.lrItemTableBody.innerHTML;
  assert.ok(html.includes(">10<"), "qty bakso = 10");
  assert.ok(!html.includes(">260<"), "qty batal/channel lain TIDAK ikut");
  assert.ok(html.includes("Cost belum tersedia"), "produk tanpa cost ditandai");
  assert.ok(html.includes("Untung"), "status untung tampil");
  assert.ok(html.includes("43.210"), "harga min bakso = ceil(35000/0.81)");
});

test("renderLabaRugiItems POS: hanya POS1/POS2, potongan 0%, laba rugi benar", () => {
  const sb = buildSandbox();
  sb.products = [
    { id: 1, name: "Bakso", sku: "BK", modal: 35000 },
    { id: 2, name: "Tepung", sku: "TP", modal: 8265 },
  ];
  sb.productPrices = {
    "1": { pos: 50000, "shopee:724153261": 50000, "shopee:1214362884": 50000 },
    "2": { pos: 8000, "shopee:724153261": 10000, "shopee:1214362884": 10000 },
  };
  sb.labaRugiChannel = "pos";
  sb.labaRugiPeriod = "semua";
  sb.platformCuts.pos = 0;

  const ords = [
    { orderId: "P1", date: "2026-11-27 10:00", channel: "POS1", payStatus: "Lunas", wmsStatus: "Selesai" },
    { orderId: "P2", date: "2026-11-27 10:00", channel: "POS2", payStatus: "Lunas", wmsStatus: "Selesai" },
    { orderId: "P3", date: "2026-11-27 10:00", channel: "WhatsApp", payStatus: "Lunas", wmsStatus: "Selesai" },
    { orderId: "P4", date: "2026-11-27 10:00", channel: "Tokopedia", payStatus: "Lunas", wmsStatus: "Selesai" },
  ];
  const items = [
    { orderid: "P1", product_id: 1, qty: 1 },
    { orderid: "P2", product_id: 2, qty: 2 },
    { orderid: "P3", product_id: 1, qty: 100 }, // WhatsApp → TIDAK ikut
    { orderid: "P4", product_id: 2, qty: 200 }, // Tokopedia → TIDAK ikut
  ];
  sb.renderLabaRugiItems(ords, items);

  const el = sb.getElements();
  // Omzet = 50000×1 + 8000×2 = 66.000
  assert.equal(el.lrItemOmzet.textContent, RP.format(66000));
  assert.equal(el.lrItemPotongan.textContent, RP.format(0));
  assert.equal(el.lrItemBersih.textContent, RP.format(66000));
  // Cost = 35000×1 + 8265×2 = 51.530
  assert.equal(el.lrItemHpp.textContent, RP.format(51530));
  // Laba = (50000-35000) + (8000-8265)×2 = 15000 - 530 = 14.470
  assert.equal(el.lrItemLaba.textContent, RP.format(14470));
  const html = el.lrItemTableBody.innerHTML;
  assert.ok(html.includes("Rugi"), "teping rugi di POS");
  assert.ok(html.includes("Untung"), "bakso untung di POS");
});

test("renderLabaRugiItems Shopee 2 19%: harga channel sendiri, tidak memakai harga Shopee 1", () => {
  const sb = buildSandbox();
  sb.products = [{ id: 1, name: "Bakso", sku: "BK", modal: 35000 }];
  sb.productPrices = {
    "1": { pos: 50000, "shopee:724153261": 50000, "shopee:1214362884": 48000 },
  };
  sb.labaRugiChannel = "shopee:1214362884";
  sb.labaRugiPeriod = "semua";
  sb.platformCuts["shopee:1214362884"] = 19;

  const ords = [
    { orderId: "S1", date: "2026-11-27 10:00", channel: "Shopee", shop_id: "1214362884", payStatus: "Lunas", wmsStatus: "Selesai" },
  ];
  const items = [{ orderid: "S1", product_id: 1, qty: 2 }];
  sb.renderLabaRugiItems(ords, items);

  const el = sb.getElements();
  // Potongan = 48000×19% = 9120; bersih 38880; laba/unit 3880; total 7760.
  assert.equal(el.lrItemOmzet.textContent, RP.format(96000));
  assert.equal(el.lrItemPotongan.textContent, RP.format(18240));
  assert.equal(el.lrItemBersih.textContent, RP.format(77760));
  assert.equal(el.lrItemLaba.textContent, RP.format(7760));
});

// ---------- FETCH PERTAMA ----------

test("renderLabaRugi fetch pertama: data langsung disimpan ke global, tidak fetch berulang", async () => {
  const sb = buildSandbox();
  sb.platformCutsFetched = true;
  sb.products = [];
  sb.ordersData = [];
  sb.orderItemsData = [];
  sb.labaRugiFetched = false;
  let ordersCalls = 0;
  let itemsCalls = 0;
  sb.fetchAllOrders = async () => {
    ordersCalls++;
    return { data: [{ orderid: "A1", date: "2026-11-27 10:00", channel: "POS1", total: 1000, paystatus: "Lunas", wmsstatus: "Selesai" }], error: null };
  };
  sb.fetchAllOrderItems = async () => {
    itemsCalls++;
    return { data: [{ orderid: "A1", product_id: 1, qty: 1 }], error: null };
  };
  await sb.renderLabaRugi();
  assert.equal(ordersCalls, 1);
  assert.equal(itemsCalls, 1);
  assert.equal(sb.ordersData.length, 1);
  assert.equal(sb.ordersData[0].orderId, "A1"); // sudah ter-mapping
  assert.equal(sb.orderItemsData.length, 1);
  // Render kedua: tidak fetch ulang.
  await sb.renderLabaRugi();
  assert.equal(ordersCalls, 1);
  assert.equal(itemsCalls, 1);
});

test("renderLabaRugi fetch pertama: hanya mengambil data yang belum termuat", async () => {
  const sb = buildSandbox();
  sb.platformCutsFetched = true;
  sb.products = [];
  sb.ordersData = [{ orderId: "A1", date: "2026-11-27 10:00", channel: "POS1", total: 1000, payStatus: "Lunas", wmsStatus: "Selesai" }];
  sb.orderItemsData = [];
  sb.labaRugiFetched = false;
  let ordersCalls = 0;
  let itemsCalls = 0;
  sb.fetchAllOrders = async () => { ordersCalls++; return { data: [], error: null }; };
  sb.fetchAllOrderItems = async () => { itemsCalls++; return { data: [], error: null }; };
  await sb.renderLabaRugi();
  assert.equal(ordersCalls, 0, "orders sudah termuat → tidak di-fetch");
  assert.equal(itemsCalls, 1, "order_items kosong → di-fetch");
});
