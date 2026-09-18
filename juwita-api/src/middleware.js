import { pool } from "./db.js";
import { verifyAccessToken } from "./jwt.js";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

// Susun profil user dari DB. Privilege hanya untuk owner aktif.
function buildUser(row) {
  const role = String(row.role || "").toLowerCase();
  const isOwner = role === "owner" && row.status === "ACTIVE";
  return {
    id: row.id,
    phone: row.phone,
    name: row.full_name,
    role: row.role,
    roleLabel: row.role_label || row.role,
    menus: Array.isArray(row.menus) ? row.menus : [],
    status: row.status,
    privileges: isOwner
      ? ["manage_users", "manage_permissions", "manage_settings"]
      : [],
  };
}

// Otentikasi: verifikasi JWT lalu ambil user TERBARU dari DB (sub).
// Role/menus/status TIDAK dipercaya dari token — sumber kebenaran = DB.
export async function requireAuth(req, res) {
  const auth = req.headers && req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "unauthorized" });
    return null;
  }
  const token = auth.slice("Bearer ".length).trim();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    payload = null;
  }
  if (!payload || !payload.sub) {
    sendJson(res, 401, { error: "invalid_token" });
    return null;
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, phone, full_name, role, role_label, menus, status FROM app_users WHERE id = $1 LIMIT 1",
      [payload.sub]
    );
    const row = rows[0];
    if (!row || row.status !== "ACTIVE") {
      sendJson(res, 401, { error: "unauthorized" });
      return null;
    }
    const user = buildUser(row);
    req.user = user;
    return user;
  } catch (err) {
    console.error("auth middleware: user lookup failed:", err.message);
    sendJson(res, 500, { error: "internal_error" });
    return null;
  }
}

export function requireOwner(req, res) {
  const user = req.user;
  if (!user || String(user.role || "").toLowerCase() !== "owner") {
    sendJson(res, 403, { error: "forbidden" });
    return false;
  }
  return true;
}

export function requireMenu(req, res, menu) {
  const user = req.user;
  if (!user || !Array.isArray(user.menus) || !user.menus.includes(menu)) {
    sendJson(res, 403, { error: "forbidden" });
    return false;
  }
  return true;
}

export function requirePrivilege(req, res, privilege) {
  const user = req.user;
  if (!user || !Array.isArray(user.privileges) || !user.privileges.includes(privilege)) {
    sendJson(res, 403, { error: "forbidden" });
    return false;
  }
  return true;
}
