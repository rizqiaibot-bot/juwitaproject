import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// ============================================================
// TEST LOGIKA FRONTEND LABA RUGI (index.html)
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
  extractBlock("function buildLabaRugiMarginRows("),
  extractBlock("function lrMarginCategoryStats("),
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

// ---------- ANALISIS MARGIN (KATALOG, tanpa transaksi/koneksi Shopee) ----------

test("buildLabaRugiMarginRows Shopee 1 19%: katalog penuh, rumus per unit benar, potongan dihitung sekali", () => {
  const sb = buildSandbox();
  sb.products = [
    { id: 1, name: "Bakso", sku: "BK", modal: 35000 },
    { id: 2, name: "Tepung", sku: "TP", modal: 8265 },
    { id: 3, name: "TanpaCost", sku: null, modal: 0 },
    { id: 4, name: "TanpaHarga", sku: null, modal: 10000 },
  ];
  sb.productPrices = {
    "1": { pos: 50000, "shopee:724153261": 50000, "shopee:1214362884": 48000 },
    "2": { pos: 8000, "shopee:724153261": 8000, "shopee:1214362884": 8000 },
    "3": { pos: 30000, "shopee:724153261": 30000, "shopee:1214362884": 30000 },
  };
  sb.platformCuts["shopee:724153261"] = 19;

  const built = sb.buildLabaRugiMarginRows("shopee:724153261");

  // TanpaHarga (id 4) tidak punya harga channel → dilewati, tidak ikut analisis.
  assert.equal(built.rows.length, 3);
  assert.equal(built.skippedNoPrice, 1);

  const bakso = built.rows.find(r => r.p.id === 1);
  const tepung = built.rows.find(r => r.p.id === 2);
  const tanpaCost = built.rows.find(r => r.p.id === 3);

  // Bakso: jual 50000, potongan 9500 (SEKALI), bersih 40500, laba 5500.
  assert.equal(bakso.jual, 50000);
  assert.equal(bakso.potongan, 9500);
  assert.equal(bakso.bersih, 40500);
  assert.equal(bakso.labaUnit, 5500);
  // Margin = laba/unit ÷ harga jual × 100 = 5500/50000 = 11%.
  assert.equal(bakso.marginPct, 11);
  // Harga min = ceil(35000 / 0.81) = 43210.
  assert.equal(bakso.hargaMin, 43210);

  // Tepung: 8000 − 1520 = 6480; 6480 − 8265 = −1785 (rugi).
  assert.equal(tepung.potongan, 1520);
  assert.equal(tepung.labaUnit, -1785);
  assert.ok(tepung.marginPct < 0);
  assert.equal(tepung.hargaMin, 10204);

  // Cost null/0 → tidak dihitung untung/rugi.
  assert.equal(tanpaCost.hasHpp, false);
  assert.equal(tanpaCost.labaUnit, null);
  assert.equal(tanpaCost.marginPct, null);
  assert.equal(tanpaCost.hargaMin, null);
});

test("lrMarginCategoryStats: untung/impas/rugi hanya dari produk dengan harga jual DAN Cost valid", () => {
  const sb = buildSandbox();
  const rows = [
    { hasHpp: true, labaUnit: 5500 },   // untung
    { hasHpp: true, labaUnit: -1785 },  // rugi
    { hasHpp: true, labaUnit: 0 },      // impas
    { hasHpp: false, labaUnit: null },  // cost belum tersedia → tidak ikut kategori
  ];
  const stats = sb.lrMarginCategoryStats(rows);
  assert.equal(stats.dianalisis, 4);
  assert.equal(stats.untung, 1);
  assert.equal(stats.impas, 1);
  assert.equal(stats.rugi, 1);
  assert.equal(stats.noHpp, 1);
});

test("renderLabaRugiItems Shopee 1: analisis katalog tetap jalan tanpa transaksi (disconnect/tidak ada order)", () => {
  const sb = buildSandbox();
  sb.products = [
    { id: 1, name: "Bakso", sku: "BK", modal: 35000 },
    { id: 2, name: "Tepung", sku: "TP", modal: 8265 },
    { id: 3, name: "TanpaCost", sku: null, modal: 0 },
    { id: 4, name: "TanpaHarga", sku: null, modal: 10000 },
  ];
  sb.productPrices = {
    "1": { pos: 50000, "shopee:724153261": 50000, "shopee:1214362884": 48000 },
    "2": { pos: 8000, "shopee:724153261": 8000, "shopee:1214362884": 8000 },
    "3": { pos: 30000, "shopee:724153261": 30000, "shopee:1214362884": 30000 },
  };
  sb.labaRugiChannel = "shopee:724153261";
  sb.platformCuts["shopee:724153261"] = 19;
  // TIDAK ada orders/order_items sama sekali — analisis harus tetap penuh.

  sb.renderLabaRugiItems();

  const el = sb.getElements();
  // Kategori dari katalog: 3 dianalisis, 1 untung, 0 impas, 1 rugi, 1 tanpa cost.
  assert.equal(el.lrItemDianalisis.textContent, "3");
  assert.equal(el.lrItemUntung.textContent, "1");
  assert.equal(el.lrItemImpas.textContent, "0");
  assert.equal(el.lrItemRugi.textContent, "1");
  assert.equal(el.lrItemNoHpp.textContent, "1");

  const html = el.lrItemTableBody.innerHTML;
  assert.ok(html.includes("Bakso"), "produk katalog tampil");
  assert.ok(html.includes("Untung"), "status untung tampil");
  assert.ok(html.includes("Rugi"), "status rugi tampil");
  assert.ok(html.includes("Cost belum tersedia"), "produk tanpa cost ditandai");
  assert.ok(html.includes("43.210"), "harga min bakso = ceil(35000/0.81)");
  assert.ok(!html.includes("TanpaHarga"), "produk tanpa harga channel tidak ikut");

  // Kartu sorotan dari katalog.
  assert.ok(el.lrBestProduct.innerHTML.includes("Bakso"), "paling untung = Bakso");
  assert.ok(el.lrThinnestMargin.innerHTML.includes("Bakso"), "satu-satunya margin positif = Bakso");
  assert.ok(el.lrLossProducts.innerHTML.includes("1 produk rugi"), "jumlah produk rugi dihitung");
  assert.ok(el.lrLossProducts.innerHTML.includes("Tepung"), "produk rugi terdaftar");
});

test("renderLabaRugiItems POS 0%: impas terpisah dari untung/rugi; margin tipis = margin positif terendah", () => {
  const sb = buildSandbox();
  sb.products = [
    { id: 1, name: "Impas", sku: null, modal: 50000 },
    { id: 2, name: "Untung", sku: null, modal: 40000 },
    { id: 3, name: "Rugi", sku: null, modal: 8265 },
  ];
  sb.productPrices = {
    "1": { pos: 50000 },
    "2": { pos: 50000 },
    "3": { pos: 8000 },
  };
  sb.labaRugiChannel = "pos";
  sb.platformCuts.pos = 0;

  sb.renderLabaRugiItems();

  const el = sb.getElements();
  assert.equal(el.lrItemDianalisis.textContent, "3");
  assert.equal(el.lrItemUntung.textContent, "1");
  assert.equal(el.lrItemImpas.textContent, "1");
  assert.equal(el.lrItemRugi.textContent, "1");
  assert.equal(el.lrItemNoHpp.textContent, "0");

  const html = el.lrItemTableBody.innerHTML;
  assert.ok(html.includes("Impas"), "status impas tampil (laba/unit tepat 0)");
  // Potongan 0%: potongan tidak dihitung dua kali, harga min = cost (50000).
  assert.ok(html.includes("50.000"), "harga min impas = cost");

  // Margin tipis: hanya margin POSITIF terendah (produk Impas margin 0% dikecualikan).
  assert.ok(el.lrThinnestMargin.innerHTML.includes("Untung"), "margin tipis bukan produk impas");
  assert.ok(el.lrLossProducts.innerHTML.includes("Rugi"), "produk rugi terdaftar");
});

test("renderLabaRugiItems Shopee 2 19%: memakai harga channel sendiri, bukan harga Shopee 1", () => {
  const sb = buildSandbox();
  sb.products = [{ id: 1, name: "Bakso", sku: "BK", modal: 35000 }];
  sb.productPrices = {
    "1": { pos: 50000, "shopee:724153261": 50000, "shopee:1214362884": 48000 },
  };
  sb.labaRugiChannel = "shopee:1214362884";
  sb.platformCuts["shopee:1214362884"] = 19;

  sb.renderLabaRugiItems();

  const el = sb.getElements();
  const html = el.lrItemTableBody.innerHTML;
  // Potongan = 48000×19% = 9120; bersih 38880; laba/unit 3880.
  assert.ok(html.includes("9.120"), "potongan memakai harga Shopee 2 (48000×19%)");
  assert.ok(html.includes("3.880"), "laba/unit = 3880");
  assert.ok(html.includes("43.210"), "harga min = ceil(35000/0.81)");
});

// ---------- LABA RUGI AKTUAL (transaksi) ----------

test("renderLabaRugi aktual: tanpa transaksi → Rp 0 + pesan analisis margin tetap tersedia", async () => {
  const sb = buildSandbox();
  sb.platformCutsFetched = true;
  sb.labaRugiFetched = true;
  sb.products = [];
  sb.ordersData = [];
  sb.orderItemsData = [];

  await sb.renderLabaRugi();

  const el = sb.getElements();
  assert.equal(el.lrOmzet.textContent, RP.format(0));
  assert.equal(el.lrHpp.textContent, RP.format(0));
  assert.equal(el.lrLaba.textContent, RP.format(0));
  assert.equal(el.lrMargin.textContent, "0.0%");
  assert.ok(el.lrTableBody.innerHTML.includes("Belum ada transaksi"), "tabel aktual menyatakan belum ada transaksi");
  assert.equal(el.lrEmptyActual.style.display, "", "pesan belum ada transaksi TAMPAK");
  // Pesan statis div #lrEmptyActual ada di HTML sumber.
  assert.ok(
    HTML.includes("Belum ada transaksi pada periode ini. Analisis margin produk tetap tersedia berdasarkan harga jual dan Cost."),
    "pesan HTML menyebut analisis margin tetap tersedia"
  );
});

test("renderLabaRugi aktual: dengan transaksi → angka terisi dan pesan kosong disembunyikan", async () => {
  const sb = buildSandbox();
  sb.platformCutsFetched = true;
  sb.labaRugiFetched = true;
  sb.products = [{ id: 1, name: "Bakso", modal: 30000 }];
  sb.ordersData = [
    { orderId: "A1", date: "2026-11-27 10:00", channel: "POS1", total: 100000, payStatus: "Lunas", wmsStatus: "Selesai" },
  ];
  sb.orderItemsData = [{ orderid: "A1", product_id: 1, qty: 1 }];

  await sb.renderLabaRugi();

  const el = sb.getElements();
  assert.equal(el.lrOmzet.textContent, RP.format(100000));
  assert.equal(el.lrHpp.textContent, RP.format(30000));
  assert.equal(el.lrLaba.textContent, RP.format(70000));
  assert.equal(el.lrMargin.textContent, "70.0%");
  assert.equal(el.lrEmptyActual.style.display, "none", "pesan kosong disembunyikan");
  assert.ok(el.lrTableBody.innerHTML.includes("POS"), "baris channel POS tampil");
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
