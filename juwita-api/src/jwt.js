import jwt from "jsonwebtoken";

const TOKEN_TTL = "12h";

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || typeof secret !== "string" || secret.length === 0) {
    throw new Error("JWT_SECRET belum di-set di environment");
  }
  return secret;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function signAccessToken(user) {
  const secret = getSecret();
  const sub = user && (user.id ?? user.sub);
  const role = user && user.role;
  const status = user && user.status;
  if (!nonEmptyString(String(sub))) {
    throw new Error("user.id (sub) wajib berupa string non-kosong");
  }
  if (!nonEmptyString(role)) {
    throw new Error("user.role wajib berupa string non-kosong");
  }
  if (!nonEmptyString(status)) {
    throw new Error("user.status wajib berupa string non-kosong");
  }
  return jwt.sign({ role, status }, secret, {
    algorithm: "HS256",
    subject: String(sub),
    expiresIn: TOKEN_TTL,
  });
}

export function verifyAccessToken(token) {
  if (!nonEmptyString(token)) return null;
  const secret = getSecret();
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (!decoded || typeof decoded !== "object") return null;
    if (!nonEmptyString(decoded.sub)) return null;
    if (!nonEmptyString(decoded.status)) return null;
    return {
      sub: decoded.sub,
      role: nonEmptyString(decoded.role) ? decoded.role : null,
      status: decoded.status,
      exp: decoded.exp ?? null,
    };
  } catch {
    return null;
  }
}
