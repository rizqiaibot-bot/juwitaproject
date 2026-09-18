import readline from "node:readline";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/auth.js";

const MIN_PASSWORD_LENGTH = 6;

// --- Baca seluruh stdin (untuk input non-TTY/pipa) ---
function readPipedLines() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      resolve(chunks.join("").split(/\r?\n/));
    });
    process.stdin.resume();
  });
}

let pipedLines = null;
let pipedIndex = 0;

async function initInput() {
  if (process.stdin.isTTY) return;
  pipedLines = await readPipedLines();
}

// Prompt interaktif (TTY), password tanpa echo.
function promptInteractive(label, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.output.write(label);
    if (hidden) rl._writeToOutput = () => {};
    rl.once("line", (line) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(line);
    });
  });
}

async function readLine(label, hidden = false) {
  if (pipedLines !== null) {
    process.stdout.write(label + "\n");
    const line = pipedLines[pipedIndex] ?? "";
    pipedIndex += 1;
    return line;
  }
  return promptInteractive(label, hidden);
}

async function main() {
  await initInput();

  let phone = String(process.argv[2] || "").trim();
  if (!phone) {
    phone = (await readLine("Nomor HP: ", false)).trim();
  }
  if (!phone) {
    console.error("Nomor HP wajib diisi.");
    process.exitCode = 1;
    return;
  }

  let client;
  try {
    client = await pool.connect();

    const { rows } = await client.query(
      "SELECT id FROM app_users WHERE phone = $1 LIMIT 1",
      [phone]
    );
    const user = rows[0];
    if (!user) {
      console.error("User tidak ditemukan.");
      process.exitCode = 1;
      return;
    }

    const p1 = await readLine("Password baru: ", true);
    if (p1.length < MIN_PASSWORD_LENGTH) {
      console.error("Password minimal " + MIN_PASSWORD_LENGTH + " karakter.");
      process.exitCode = 1;
      return;
    }
    const p2 = await readLine("Ulangi password: ", true);
    if (p1 !== p2) {
      console.error("Kedua password tidak sama.");
      process.exitCode = 1;
      return;
    }

    const hash = await hashPassword(p1);

    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE app_users SET password_hash = $1 WHERE id = $2",
        [hash, user.id]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    console.log("Password berhasil diperbarui.");
  } catch {
    console.error("Terjadi kesalahan. Tidak ada perubahan yang disimpan.");
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

main().catch(() => {
  console.error("Terjadi kesalahan. Tidak ada perubahan yang disimpan.");
  process.exitCode = 1;
});
