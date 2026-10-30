// ============================================================
// Order ID harian "ORD-YYYYMMDD-NN" (dipakai POS & import Shopee).
// ============================================================
// Format TIDAK diubah. Nomor berikutnya diambil dari MAX nomor hari itu di DB
// (bukan count), sehingga order yang dihapus tidak membuat nomor bentrok.

export function orderDayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export function formatOrderId(stamp, n) {
  return "ORD-" + stamp + "-" + String(n).padStart(2, "0");
}

// Nomor urut berikutnya untuk tanggal stamp (YYYYMMDD).
export async function nextOrderNumber(db, stamp) {
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(substring(orderid FROM '^ORD-[0-9]{8}-([0-9]+)$')::int), 0) AS n
     FROM orders WHERE orderid LIKE $1`,
    ["ORD-" + stamp + "-%"]
  );
  return (Number(rows[0] && rows[0].n) || 0) + 1;
}

// Serialisasi pembuatan order per tanggal (POS & import Shopee) sampai
// transaksi selesai, sehingga MAX+1 tidak diperebutkan dua transaksi.
// WAJIB dipanggil SEBELUM mengunci baris products (urutan lock sama dengan
// checkout POS → tidak deadlock).
export const ORDER_DAY_LOCK_CLASS = 745300103;

export async function lockOrderDay(client, stamp) {
  await client.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [ORDER_DAY_LOCK_CLASS, Number(stamp)]);
}

// Jalankan insertFn(orderId) di dalam transaksi aktif dengan SAVEPOINT agar
// unique_violation pada orders_pkey tidak membatalkan seluruh transaksi.
// Mengembalikan orderId yang berhasil dipakai. Panggil lockOrderDay dulu.
export async function insertWithUniqueOrderId(client, stamp, insertFn, maxAttempts = 10) {
  let n = await nextOrderNumber(client, stamp);
  for (let attempt = 0; attempt < maxAttempts; attempt++, n++) {
    const orderId = formatOrderId(stamp, n);
    await client.query("SAVEPOINT order_id_attempt");
    try {
      await insertFn(orderId);
      await client.query("RELEASE SAVEPOINT order_id_attempt");
      return orderId;
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT order_id_attempt");
      if (e.code === "23505" && e.constraint === "orders_pkey") continue;
      throw e;
    }
  }
  throw new Error("gagal generate orderid unik");
}
