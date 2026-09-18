import bcrypt from "bcrypt";

const BCRYPT_COST = 12;

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export async function hashPassword(password) {
  if (!isNonEmptyString(password)) {
    throw new Error("Password harus berupa string non-kosong");
  }
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password, hash) {
  if (!isNonEmptyString(password) || !isNonEmptyString(hash)) {
    return false;
  }
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}
