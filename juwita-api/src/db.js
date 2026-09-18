import pg from "pg";

const { Pool } = pg;

// bigint (OID 20) → Number agar konsisten dengan respons Supabase (JSON number),
// sehingga perbandingan id di frontend (number) tetap bekerja. ID produk/order
// di Juwita kecil (jauh di bawah 2^53) sehingga aman.
pg.types.setTypeParser(20, (val) => {
  const n = Number(val);
  return Number.isSafeInteger(n) ? n : val;
});

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL belum di-set di environment (sumber: .juwita-one-db.env)"
  );
}

export const pool = new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client:", err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}
