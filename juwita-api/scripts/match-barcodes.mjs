// ============================================================
// Cocokkan barcode produk dari file CSV (mis. Google Sheet "Database Produk")
// ke tabel products. TIDAK menulis ke database — hanya menghasilkan SQL + laporan.
//
// Pakai:
//   node scripts/match-barcodes.mjs --sheet <sheet.csv> --db <products.csv> --out <dir>
//
// products.csv dibuat dari VPS:
//   psql "$DATABASE_URL" -c "\copy (select id, name, coalesce(sku,'') sku,
//     coalesce(plu,'') plu, coalesce(barcode,'') barcode, price,
//     coalesce(modal,0) modal, coalesce(category,'') category from products
//     order by id) to stdout with (format csv, header true)" > products.csv
//
// Hasil di <dir>:
//   h1.sql, h2.sql  → UPDATE barcode (jalankan manual di VPS bila sudah disetujui)
//   report.csv      → kandidat H2/H3/H4 untuk dicek manusia
//
// Tingkat keyakinan:
//   H1 = token nama identik (hanya beda urutan/tanda baca)      → aman
//   H2 = beda hanya kata promosi (FRESH, HALAL, ALL VARIAN, ...) → aman
//   H3 = ada kata tambahan yang bisa berarti varian lain         → cek manual
//   H4 = ukuran/isi berbeda atau tidak disebut di sheet          → jangan otomatis
//
// Aturan aman yang selalu dipakai:
//   - hanya produk yang barcode-nya masih kosong
//   - barcode tidak dipakai produk lain dengan nama berbeda
//   - barcode di sheet tidak dipakai >1 nama berbeda
// ============================================================
import fs from "node:fs";
import path from "node:path";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toObjects(rows) {
  const head = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ""))
    .map((r) => {
      const o = {};
      head.forEach((h, i) => (o[h] = String(r[i] ?? "").trim()));
      return o;
    });
}

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const tokens = (s) => norm(s).split(" ").filter(Boolean);
const tokenKey = (arr) => arr.slice().sort().join(" ");

// Kata yang murni promosi/kemasan, bukan identitas produk.
const NOISE = new Set(
  "ALL VARIAN VARIANT PROMO HALAL READY STOK TERLARIS MURAH GROSIR PENGIRIMAN CEPAT FRESH BEKU FROZEN PREMIUM ORIGINAL".split(" ")
);
const isSize = (t) => /^\d+$/.test(t) || /^\d+(GR|G|KG|ML|L|PCS|PC|SACHET|SACHETS|BUTIR|ISI|BTL|BOTOL|BOX|PACK|PAK)$/.test(t);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sheetPath = arg("--sheet");
const dbPath = arg("--db");
const outDir = arg("--out", ".");
if (!sheetPath || !dbPath) {
  console.error("Wajib: --sheet <sheet.csv> --db <products.csv> [--out <dir>]");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const sheet = toObjects(parseCsv(fs.readFileSync(sheetPath, "utf8")));
const db = toObjects(parseCsv(fs.readFileSync(dbPath, "utf8")));
const sheetRows = sheet.filter((r) => r.Barcode);
if (!sheetRows.length) throw new Error("Kolom 'Barcode' tidak ditemukan / kosong di sheet");

const dbBarcodeOwners = new Map();
for (const p of db) {
  if (!p.barcode) continue;
  if (!dbBarcodeOwners.has(p.barcode)) dbBarcodeOwners.set(p.barcode, []);
  dbBarcodeOwners.get(p.barcode).push(p);
}
const sheetBarcodeNames = new Map();
for (const r of sheetRows) {
  if (!sheetBarcodeNames.has(r.Barcode)) sheetBarcodeNames.set(r.Barcode, new Set());
  sheetBarcodeNames.get(r.Barcode).add(norm(r["Nama Produk"]));
}

const results = [];
for (const p of db) {
  if (p.barcode) continue;
  const pt = tokens(p.name);
  const pset = new Set(pt);
  const candidates = [];
  for (const r of sheetRows) {
    const st = tokens(r["Nama Produk"]);
    if (st.length < 2 || !st.every((t) => pset.has(t))) continue;
    candidates.push({ r, st });
  }
  if (!candidates.length) continue;

  const barcodes = [...new Set(candidates.map((c) => c.r.Barcode))];
  if (barcodes.length !== 1) continue; // ambigu: beberapa barcode
  const barcode = barcodes[0];

  const owners = dbBarcodeOwners.get(barcode) || [];
  if (owners.some((o) => norm(o.name) !== norm(p.name))) continue; // bentrok produk lain
  if (sheetBarcodeNames.get(barcode)?.size > 1) continue; // barcode dipakai >1 nama di sheet

  candidates.sort((a, b) => b.st.length - a.st.length);
  const best = candidates[0];
  const extra = pt.filter((t) => !best.st.includes(t));
  const sizeDb = pt.filter(isSize).join(",");
  const sizeSheet = best.st.filter(isSize).join(",");

  let tier;
  if (tokenKey(pt) === tokenKey(best.st)) tier = "H1";
  else if (extra.every((t) => NOISE.has(t))) tier = "H2";
  else if (extra.some((t) => !isSize(t)) && sizeDb === sizeSheet) tier = "H3";
  else tier = "H4";

  results.push({ tier, product: p, sheetRow: best.r, barcode, extra, sizeDb, sizeSheet });
}

const sqlEsc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
function writeSql(tier, file) {
  const rows = results.filter((r) => r.tier === tier);
  const sql = [
    `-- Barcode dari ${path.basename(sheetPath)} — tingkat ${tier}.`,
    "-- Hanya mengisi barcode yang masih kosong; stok/harga/Shopee tidak disentuh.",
    "BEGIN;",
    ...rows.map(
      (r) =>
        `UPDATE products SET barcode = ${sqlEsc(r.barcode)} WHERE id = ${r.product.id} AND (barcode IS NULL OR btrim(barcode) = ''); -- ${r.product.name.replace(/\r?\n/g, " ")}`
    ),
    "COMMIT;",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, file), sql, "utf8");
  return rows.length;
}

const h1 = writeSql("H1", "h1.sql");
const h2 = writeSql("H2", "h2.sql");

const csvEsc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
const report = ["tingkat,product_id,nama_db,sku,barcode,nama_sheet,harga_db,harga_sheet,ukuran_db,ukuran_sheet,kata_ekstra"];
for (const tier of ["H2", "H3", "H4"]) {
  for (const r of results.filter((x) => x.tier === tier)) {
    report.push(
      [tier, r.product.id, r.product.name, r.product.sku, r.barcode, r.sheetRow["Nama Produk"], r.product.price, r.sheetRow["Harga Jual"], r.sizeDb, r.sizeSheet, r.extra.join(" ")]
        .map(csvEsc)
        .join(",")
    );
  }
}
fs.writeFileSync(path.join(outDir, "report.csv"), report.join("\n"), "utf8");

const count = (t) => results.filter((r) => r.tier === t).length;
console.log(`sheet ber-barcode: ${sheetRows.length} | produk tanpa barcode: ${db.filter((p) => !p.barcode).length}`);
console.log(`H1 (aman, token identik): ${h1} produk  -> h1.sql`);
console.log(`H2 (aman, kata promosi): ${h2} produk  -> h2.sql`);
console.log(`H3 (cek manual): ${count("H3")} | H4 (ukuran beda): ${count("H4")}  -> report.csv`);
