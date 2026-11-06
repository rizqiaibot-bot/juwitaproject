// ============================================================
// Reset stok POS: products.stock = 0 untuk SEMUA produk.
// Stok Shopee 1 & Shopee 2 TIDAK boleh ikut berubah → putuskan toko dulu.
//
// Pakai:
//   node scripts/reset-pos-stock.mjs                      (DRY-RUN, tidak mengubah apa pun)
//   node scripts/reset-pos-stock.mjs --apply --disconnect  (eksekusi: disconnect Shopee lalu nol-kan POS)
//
// Opsi:
//   --apply            benar-benar menulis (default hanya dry-run)
//   --disconnect       set Shopee 1 & 2 connection_status='disconnected' dulu
//   --allow-connected  paksa jalan walau masih ada toko Shopee connected
//                      (TIDAK disarankan: stok Shopee bisa ikut jadi 0)
//
// Catatan:
//   - Setiap produk yang stoknya berubah dicatat di stock_mutations
//     (qty_before → qty_after 0) dengan sync_status 'pending'.
//   - Mutasi 'pending' TIDAK dikirim selama toko disconnected. Saat toko
//     di-Connect lagi, worker mengirim stok POS TERKINI (bukan angka 0 yang
//     dibekukan), jadi aman: isi stok POS yang benar dulu, baru Connect.
//   - Order/akuntansi tidak disentuh.
// ============================================================
import { pool } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const DISCONNECT = process.argv.includes("--disconnect");
const ALLOW_CONNECTED = process.argv.includes("--allow-connected");

async function main() {
  console.log(`mode: ${APPLY ? "APPLY" : "DRY_RUN"}`);

  const { rows: shops } = await pool.query(
    "SELECT shop_id, shop_name, connection_status FROM marketplace_config WHERE platform = 'shopee' ORDER BY id"
  );
  for (const s of shops) {
    console.log(`  shop ${s.shop_id} (${s.shop_name || "-"}): ${s.connection_status}`);
  }
  const connected = shops.filter((s) => s.connection_status !== "disconnected");

  const { rows: info } = await pool.query(
    "SELECT count(*)::int AS n, COALESCE(SUM(ABS(stock)), 0) AS total FROM products WHERE stock <> 0"
  );
  console.log(`produk dengan stok != 0: ${info[0].n} (total qty ${Number(info[0].total)})`);

  if (!APPLY) {
    const { rows: sample } = await pool.query(
      "SELECT id, name, stock FROM products WHERE stock <> 0 ORDER BY id LIMIT 15"
    );
    for (const p of sample) console.log(`  #${p.id} ${p.name}: ${p.stock} -> 0`);
    if (info[0].n > sample.length) console.log(`  ... dan ${info[0].n - sample.length} produk lain`);
    console.log("Dry-run selesai. Tambahkan --apply (dan --disconnect) untuk eksekusi.");
    return;
  }

  if (connected.length > 0 && !DISCONNECT && !ALLOW_CONNECTED) {
    console.error(
      "BATAL: masih ada toko Shopee yang connected. Jalankan dengan --disconnect " +
        "(atau --allow-connected bila memang mau stok Shopee ikut di-nol-kan)."
    );
    process.exitCode = 2;
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (DISCONNECT) {
      const { rowCount } = await client.query(
        "UPDATE marketplace_config SET connection_status = 'disconnected' WHERE platform = 'shopee' AND connection_status <> 'disconnected'"
      );
      console.log(`toko Shopee diputus: ${rowCount}`);
    }

    // Histori mutasi dicatat SEBELUM stok diubah agar qty_before/qty_after
    // benar. Status langsung terminal: bukan antrean sinkronisasi.
    const { rowCount: mutations } = await client.query(
      `INSERT INTO stock_mutations
         (product_id, product_name, type, quantity, qty_before, qty_after, source, sync_status, created_at)
       SELECT id, name,
              CASE WHEN stock > 0 THEN 'OUT' ELSE 'IN' END,
              ABS(stock), stock, 0, 'Reset stok POS', 'synced', now()
       FROM products
       WHERE stock <> 0`
    );
    const { rowCount: updated } = await client.query(
      "UPDATE products SET stock = 0 WHERE stock <> 0"
    );

    await client.query("COMMIT");
    console.log(`selesai: ${updated} produk di-set 0, ${mutations} histori mutasi stok dicatat (terminal).`);
    console.log("Stok Shopee TIDAK diubah selama toko tetap disconnected.");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("GAGAL, rollback:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main()
  .catch((e) => {
    console.error("reset-pos-stock gagal:", e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
