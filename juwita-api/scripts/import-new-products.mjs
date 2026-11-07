// ============================================================
// Import produk BARU ke POS dari sheet "Database Produk".
// Produk yang namanya belum ada di POS (dan barcode-nya belum
// dipakai) dijadikan baris baru. TIDAK menulis database —
// hanya menghasilkan SQL + laporan.
//
// Pakai:
//   node scripts/import-new-products.mjs --sheet <sheet.csv> --db <products.csv> --out <dir>
//
// Hasil di <dir>:
//   insert-new-products.sql  → INSERT produk baru (jalankan manual di VPS)
//   new-products.csv         → daftar produk baru untuk dicek
//
// Aturan aman:
//   - barcode hanya diisi bila valid 13 digit DAN belum dipakai produk lain
//   - produk dianggap SUDAH ADA bila: nama token identik, beda hanya kata
//     promosi, atau salah satu nama mencakup semua token nama lainnya
//     dengan ukuran yang sama (menghindari duplikat)
//   - stok produk baru = 0 (stok pusat TIDAK disentuh)
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

const NOISE = new Set(
  "ALL VARIAN VARIANT PROMO HALAL READY STOK TERLARIS MURAH GROSIR PENGIRIMAN CEPAT FRESH BEKU FROZEN PREMIUM ORIGINAL".split(" ")
);
const isSize = (t) => /^\d+$/.test(t) || /^\d+(GR|G|KG|ML|L|PCS|PC|SACHET|SACHETS|BUTIR|ISI|BTL|BOTOL|BOX|PACK|PAK)$/.test(t);
const isValidBarcode = (b) => /^\d{13}$/.test(String(b || "").trim());

function parseRupiah(v) {
  const s = String(v || "").replace(/[^\d,]/g, "");
  if (!s) return 0;
  return parseInt(s.split(",")[0], 10) || 0;
}

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

const dbBarcodes = new Set(db.filter((p) => p.barcode).map((p) => p.barcode));
const dbProducts = db.map((p) => {
  const pt = tokens(p.name);
  const pset = new Set(pt);
  const sizes = pt.filter(isSize);
  return { p, pt, pset, sizes, sizeKey: sizes.join(",") };
});

// Apakah nama sheet sudah terwakili produk POS?
function nameExists(sheetTokens, sheetSizes) {
  const sset = new Set(sheetTokens);
  const sSizeKey = sheetSizes.join(",");
  for (const d of dbProducts) {
    // H1: token identik
    if (sheetTokens.length === d.pt.length && sheetTokens.every((t) => d.pset.has(t))) return true;
    // H2: selisih hanya kata promosi
    const onlyNoise = (arr, set) => arr.filter((t) => !set.has(t)).every((t) => NOISE.has(t));
    if (onlyNoise(sheetTokens, d.pset) && onlyNoise(d.pt, sset)) return true;
    // subset salah satu arah dengan ukuran sama
    if (sSizeKey === d.sizeKey && (sheetTokens.every((t) => d.pset.has(t)) || d.pt.every((t) => sset.has(t)))) return true;
    // ukuran sheet bagian dari ukuran db (mis. nama db multi-pack) dan token non-ukuran tercakup
    if (
      sheetSizes.length &&
      sheetSizes.every((s) => d.sizes.includes(s)) &&
      sheetTokens.filter((t) => !sheetSizes.includes(t)).every((t) => d.pset.has(t))
    ) return true;
  }
  return false;
}

const usedBarcodes = new Set(dbBarcodes);
const seenNames = new Set();
const newRows = [];
let skippedBarcodeExist = 0;
let skippedNameExist = 0;
let skippedDupSheetName = 0;

for (const r of sheet) {
  const name = String(r["Nama Produk"] || "").trim();
  if (!name) continue;
  const t = tokens(name);
  if (!t.length) continue;

  const rawBarcode = String(r.Barcode || "").trim();
  const barcode = isValidBarcode(rawBarcode) ? rawBarcode : "";
  if (barcode && usedBarcodes.has(barcode)) { skippedBarcodeExist++; continue; }

  const normName = norm(name);
  if (seenNames.has(normName)) { skippedDupSheetName++; continue; }
  seenNames.add(normName);

  if (nameExists(t, t.filter(isSize))) { skippedNameExist++; continue; }

  newRows.push({
    kode: String(r["Kode Item"] || "").trim(),
    name,
    barcode,
    price: parseRupiah(r["Harga Jual"]),
    modal: parseRupiah(r["Harga Modal"]),
    category: String(r["Kategori"] || "").trim(),
  });
  if (barcode) usedBarcodes.add(barcode);
}

// --- SQL INSERT dengan id = MAX(id)+rn (aman dari tabrakan) ---
const sqlEsc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const values = newRows
  .map((r, i) => {
    const sku = "SH-" + (r.kode || String(i + 1).padStart(4, "0"));
    return (
      `  (${i + 1}, ${sqlEsc(r.name)}, ${sqlEsc(sku)}, ${r.barcode ? sqlEsc(r.barcode) : "NULL"}, ` +
      `${r.price}, ${r.modal}, ${sqlEsc(r.category) || "'lainnya'"})`
    );
  })
  .join(",\n");

const sql = [
  `-- Produk baru dari ${path.basename(sheetPath)} — belum ada di POS.`,
  "-- Barcode hanya yang valid 13 digit dan belum dipakai. Stok mulai 0 (stok pusat tidak disentuh).",
  "BEGIN;",
  "WITH mx AS (SELECT COALESCE(MAX(id),0) AS m FROM products)",
  "INSERT INTO products (id, name, sku, barcode, price, modal, category, stock, minstock, maxstock, imageicon)",
  "SELECT mx.m + v.rn, v.name, v.sku, v.barcode, v.price, v.modal, v.category, 0, 10, 100, 'fa-box'",
  "FROM (VALUES",
  values,
  ") AS v(rn, name, sku, barcode, price, modal, category)",
  "CROSS JOIN mx;",
  "COMMIT;",
  "",
].join("\n");
fs.writeFileSync(path.join(outDir, "insert-new-products.sql"), sql, "utf8");

const csvEsc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
const report = ["kode_item,nama,barcode,price,modal,category"];
for (const r of newRows) {
  report.push([r.kode, r.name, r.barcode, r.price, r.modal, r.category].map(csvEsc).join(","));
}
fs.writeFileSync(path.join(outDir, "new-products.csv"), report.join("\n"), "utf8");

console.log(`sheet rows: ${sheet.length} | produk POS: ${db.length}`);
console.log(`SUDAH ADA (nama): ${skippedNameExist} | SUDAH ADA (barcode): ${skippedBarcodeExist} | nama dobel di sheet: ${skippedDupSheetName}`);
console.log(`BARU: ${newRows.length} (dengan barcode valid: ${newRows.filter((r) => r.barcode).length}, tanpa barcode: ${newRows.filter((r) => !r.barcode).length})`);
console.log(`-> insert-new-products.sql & new-products.csv`);
