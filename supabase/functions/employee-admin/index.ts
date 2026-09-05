// ============================================================
// Edge Function: employee-admin
// Admin karyawan — HANYA untuk OWNER/Super Admin (role='owner' ACTIVE).
// Operasi:
//   1) create         — buat Auth user + row app_users (rollback Auth bila insert gagal)
//   2) reset_password — reset password karyawan (bukan owner)
//
// KEAMANAN:
//   - Caller diidentifikasi dari JWT session (Authorization Bearer).
//   - Otentikasi server-side via supabase.auth.getUser(token).
//   - Otorisasi: lookup app_users (auth_user_id) → role='owner' AND status='ACTIVE'.
//   - TIDAK percaya role/privilege dari body frontend.
//   - TIDAK menerima auth_user_id caller dari body sebagai dasar otorisasi.
//   - Service-role key HANYA dipakai di sini (server-side). Tidak di-response.
//   - Password tidak pernah di-log / tidak pernah dikembalikan.
// Deploy: supabase functions deploy employee-admin
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FRONTEND_ORIGIN = Deno.env.get("FRONTEND_ORIGIN") || "https://juwitaproject.vercel.app";

const ALLOWED_MENUS = [
  "pos", "penjualan", "katalog", "persediaan", "pembelian",
  "gudang", "pricing", "hr", "pengaturan",
];
const ALLOWED_ROLES = ["kasir", "gudang", "hr", "keuangan", "kurir", "staf", "admin"];
const ALLOWED_STATUS = ["ACTIVE", "INACTIVE"];

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ============================================================
// CORS — allowlist origin (sama dengan fungsi lain di project)
// ============================================================
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin === "https://juwitaproject.vercel.app") return true;
  // Origin "null" = membuka file lokal via file:// (testing local). Aman:
  // endpoint tetap mewajibkan JWT owner ACTIVE sebelum operasi apa pun.
  if (origin === "null") return true;
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin");
  const allow = origin && isAllowedOrigin(origin) ? origin : FRONTEND_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ============================================================
// HELPERS
// ============================================================
function normalizePhone(raw: string): string {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("62")) d = "0" + d.slice(2);
  return d;
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

// Otentikasi & otorisasi caller: JWT → auth user → app_users owner ACTIVE.
async function requireActiveOwner(req: Request): Promise<{ uid: string } | { error: { message: string; status: number } }> {
  const token = bearer(req);
  if (!token) return { error: { message: "Unauthorized", status: 401 } };

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data || !data.user) {
    return { error: { message: "Unauthorized", status: 401 } };
  }
  const uid = data.user.id;

  const { data: row, error: rowErr } = await admin
    .from("app_users")
    .select("role,status")
    .eq("auth_user_id", uid)
    .maybeSingle();
  if (rowErr || !row) {
    return { error: { message: "Forbidden", status: 403 } };
  }
  if (String(row.role || "").toLowerCase() !== "owner" || row.status !== "ACTIVE") {
    return { error: { message: "Forbidden", status: 403 } };
  }
  return { uid };
}

// ============================================================
// OPERASI CREATE
// ============================================================
async function opCreate(body: any, headers: Record<string, string>) {
  const fullName = String(body.full_name || "").trim();
  const phone = normalizePhone(String(body.phone || ""));
  const password = String(body.password || "");
  const role = String(body.role || "").trim().toLowerCase();
  const roleLabel = String(body.role_label || "").trim() || role;
  const status = String(body.status || "").toUpperCase();
  const menus = Array.isArray(body.menus) ? body.menus : [];

  if (!fullName || fullName.length > 120) return json({ error: "full_name wajib diisi (maks 120 karakter)" }, 400, headers);
  if (!/^\d{10,13}$/.test(phone)) return json({ error: "Nomor HP tidak valid" }, 400, headers);
  if (password.length < 6 || password.length > 72) return json({ error: "Password harus 6–72 karakter" }, 400, headers);
  if (role === "owner") return json({ error: "Role owner tidak dapat dibuat lewat endpoint ini" }, 400, headers);
  if (!ALLOWED_ROLES.includes(role)) return json({ error: "Role tidak valid" }, 400, headers);
  if (!ALLOWED_STATUS.includes(status)) return json({ error: "Status harus ACTIVE atau INACTIVE" }, 400, headers);
  if (menus.length === 0) return json({ error: "menus tidak boleh kosong" }, 400, headers);
  for (const m of menus) {
    if (!ALLOWED_MENUS.includes(String(m))) return json({ error: "Menu tidak valid: " + String(m) }, 400, headers);
  }
  const uniqueMenus = [...new Set(menus.map((m: unknown) => String(m)))];

  // Email internal mengikuti pola yang dipakai login: <phone>@juwita.local
  const email = phone + "@juwita.local";

  const { data: existingPhone } = await admin
    .from("app_users")
    .select("id")
    .eq("phone", phone)
    .maybeSingle();
  if (existingPhone) return json({ error: "Nomor HP sudah terdaftar" }, 409, headers);

  // 1. Buat Auth user (admin API server-side; email auto-confirm).
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (createErr) {
    console.error("employee-admin create auth error:", createErr.code || createErr.message);
    return json({ error: "Gagal membuat akun Auth: " + (createErr.message || "unknown") }, 500, headers);
  }
  const authUserId = created?.user?.id;
  if (!authUserId) {
    return json({ error: "Gagal membuat akun Auth" }, 500, headers);
  }

  // 2. Insert row app_users.
  const { error: insErr } = await admin.from("app_users").insert({
    phone,
    auth_user_id: authUserId,
    email,
    full_name: fullName,
    role,
    role_label: roleLabel,
    menus: uniqueMenus,
    status,
  });
  if (insErr) {
    // Rollback: hapus Auth user yang baru dibuat agar tidak ada akun yatim.
    await admin.auth.admin.deleteUser(authUserId).catch((e: Error) => {
      console.error("employee-admin rollback delete auth error:", e.message);
    });
    if (insErr.code === "23505") {
      return json({ error: "Nomor HP sudah terdaftar" }, 409, headers);
    }
    console.error("employee-admin insert app_users error:", insErr.message);
    return json({ error: "Gagal menyimpan data karyawan; akun Auth sudah di-rollback" }, 500, headers);
  }

  return json({ ok: true, action: "create", auth_user_id: authUserId }, 200, headers);
}

// ============================================================
// OPERASI RESET PASSWORD (target ≠ owner)
// ============================================================
async function opResetPassword(body: any, callerUid: string, headers: Record<string, string>) {
  const targetAuthUserId = String(body.auth_user_id || "").trim();
  const password = String(body.password || "");
  if (!targetAuthUserId) return json({ error: "auth_user_id wajib diisi" }, 400, headers);
  if (password.length < 6 || password.length > 72) return json({ error: "Password harus 6–72 karakter" }, 400, headers);
  if (targetAuthUserId === callerUid) return json({ error: "Reset password owner tidak diizinkan lewat operasi ini" }, 403, headers);

  const { data: target, error: tErr } = await admin
    .from("app_users")
    .select("auth_user_id,role")
    .eq("auth_user_id", targetAuthUserId)
    .maybeSingle();
  if (tErr || !target) return json({ error: "Karyawan target tidak ditemukan" }, 404, headers);
  if (String(target.role || "").toLowerCase() === "owner") {
    return json({ error: "Tidak diizinkan mengubah password owner" }, 403, headers);
  }

  const { error: updErr } = await admin.auth.admin.updateUserById(targetAuthUserId, { password });
  if (updErr) {
    console.error("employee-admin reset password error:", updErr.code || updErr.message);
    return json({ error: "Gagal reset password: " + (updErr.message || "unknown") }, 500, headers);
  }
  return json({ ok: true, action: "reset_password" }, 200, headers);
}

// ============================================================
// MAIN
// ============================================================
Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, headers);
  }

  const authResult = await requireActiveOwner(req);
  if ("error" in authResult) {
    return json({ error: authResult.error.message }, authResult.error.status, headers);
  }
  const callerUid = authResult.uid;

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body bukan JSON valid" }, 400, headers);
  }
  const action = String(payload.action || "").trim();

  if (action === "create") {
    return await opCreate(payload, headers);
  }
  if (action === "reset_password") {
    return await opResetPassword(payload, callerUid, headers);
  }
  return json({ error: "action tidak dikenal" }, 400, headers);
});
