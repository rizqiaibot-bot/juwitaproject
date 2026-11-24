// ============================================================
// JFFBOT — bridge ke OpenCode V2 (service juwita-opencode di VPS).
// ============================================================
// OpenCode server berjalan di 127.0.0.1:4096 (systemd juwita-opencode).
// Auth: HTTP Basic "opencode:<password>" — password dibaca dari file
// service.json yang ditulis OpenCode saat server mulai.
// Workspace: clone repo /home/juwita/juwita-one (working copy, BUKAN
// /var/www/html yang live). Deploy hanya lewat approve → git push → GitHub
// Actions (rsync otomatis), sehingga agent tidak pernah menyentuh situs live.
// ============================================================
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENCODE_URL = process.env.JFFBOT_OPENCODE_URL || "http://127.0.0.1:4096";
const WORKSPACE = process.env.JFFBOT_WORKSPACE || "/home/juwita/juwita-one";
const GITHUB_KEY = process.env.JFFBOT_GITHUB_KEY || "/home/juwita/.ssh/jffbot_github";
const BUSY_TIMEOUT_MS = 15 * 60 * 1000;
// Eksekusi agent yang macet (mis. stream model terputus) dianggap gagal
// setelah ini dan di-interupsi otomatis.
const STALL_TIMEOUT_MS = 8 * 60 * 1000;

// --- Auth OpenCode ---
function servicePassword() {
  const candidates = [
    join(homedir(), ".config", "opencode", "service.json"),
    join(homedir(), ".local", "state", "opencode", "service.json"),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (typeof parsed.password === "string" && parsed.password) return parsed.password;
    } catch {
      // lanjut ke kandidat berikutnya
    }
  }
  return null;
}

function authHeader() {
  const pw = servicePassword();
  if (!pw) return null;
  return "Basic " + Buffer.from("opencode:" + pw).toString("base64");
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function ocFetch(path, init = {}) {
  const auth = authHeader();
  if (!auth) throw httpError(503, "OpenCode service tidak ditemukan di server");
  const headers = { authorization: auth, ...(init.headers || {}) };
  if (init.body != null) headers["content-type"] = "application/json";
  const res = await fetch(OPENCODE_URL + path, { ...init, headers });
  return res;
}

// --- Session global (satu sesi JFFBOT untuk semua pengguna) ---
let globalSessionId = null;
let busy = null; // { by, startedAt, timer }
let cachedChanges = null; // hasil changesStatus terakhir (untuk notifikasi ringan)

function busyInfo() {
  if (!busy) return null;
  if (Date.now() - busy.startedAt >= BUSY_TIMEOUT_MS) {
    clearBusy();
    return null;
  }
  return { by: busy.by, startedAt: busy.startedAt };
}

function clearBusy() {
  if (busy && busy.timer) clearTimeout(busy.timer);
  busy = null;
}

export async function ensureSession() {
  if (globalSessionId) return globalSessionId;
  try {
    const res = await ocFetch("/api/session");
    if (res.ok) {
      const body = await res.json();
      const list = Array.isArray(body.data) ? body.data : [];
      const found = list.find((s) => s.title === "JFFBOT");
      if (found) {
        globalSessionId = found.id;
        return globalSessionId;
      }
    }
  } catch {
    // buat baru di bawah
  }
  const res = await ocFetch("/api/session", {
    method: "POST",
    body: JSON.stringify({ location: { directory: WORKSPACE }, title: "JFFBOT" }),
  });
  if (!res.ok) throw httpError(502, "OpenCode tidak merespons (" + res.status + ")");
  const created = await res.json();
  globalSessionId = created.id;
  return globalSessionId;
}

// --- Git helpers (workspace JFFBOT) ---
function runGit(args) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, {
      GIT_SSH_COMMAND:
        "ssh -i " + GITHUB_KEY + " -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
    });
    execFile("git", args, { cwd: WORKSPACE, env, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code || 1 : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

// Sinkronkan workspace dengan origin/main (fast-forward). Gagal bila ada
// commit lokal yang belum dipush (harus approve/cancel dulu).
export async function syncWorkspace() {
  const fetchR = await runGit(["fetch", "origin"]);
  if (!fetchR.ok) throw httpError(502, "Gagal fetch dari GitHub: " + fetchR.stderr.slice(0, 300));
  const merge = await runGit(["merge", "--ff-only", "origin/main"]);
  if (!merge.ok) {
    throw httpError(
      409,
      "Ada commit lokal yang belum dipush. Approve (deploy) atau batalkan dulu lewat tombol di atas."
    );
  }
  const status = await runGit(["status", "--porcelain"]);
  if (status.stdout.trim()) {
    throw httpError(
      409,
      "Ada perubahan yang belum dirapikan. Approve (deploy) atau batalkan dulu lewat tombol di atas."
    );
  }
}

// Usia eksekusi OpenCode yang sedang berjalan (ms) atau null bila idle.
async function sessionBusyAge(sessionId) {
  try {
    const infoRes = await ocFetch("/api/session/" + sessionId);
    if (!infoRes.ok) return null;
    const info = await infoRes.json();
    const startedAt = info.data && info.data.time && info.data.time.busy;
    if (typeof startedAt !== "number") return null;
    return Date.now() - startedAt;
  } catch {
    return null;
  }
}

// Eksekusi OpenCode yang masih "busy" setelah STALL_TIMEOUT_MS dianggap
// macet dan di-interupsi. Mengembalikan true bila interupsi dilakukan.
async function interruptStalled(sessionId) {
  const age = await sessionBusyAge(sessionId);
  if (age === null || age < STALL_TIMEOUT_MS) return false;
  await ocFetch("/api/session/" + sessionId + "/interrupt", { method: "POST" }).catch(() => {});
  clearBusy();
  return true;
}

// --- Kirim prompt ke agent ---
export async function submitPrompt(user, text) {
  const info = busyInfo();
  if (info) {
    throw httpError(409, "JFFBOT sedang mengerjakan permintaan " + info.by + ". Tunggu selesai, lalu coba lagi.");
  }
  await syncWorkspace();
  const sessionId = await ensureSession();
  // Bila turn sebelumnya macet, interupsi dulu supaya prompt baru jalan.
  await interruptStalled(sessionId);
  const res = await ocFetch("/api/session/" + sessionId + "/prompt", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body && body.message ? " — " + body.message : "";
    } catch {
      // abaikan
    }
    throw httpError(502, "OpenCode menolak permintaan (" + res.status + ")" + detail);
  }
  busy = {
    by: user.name || user.phone || "pengguna",
    startedAt: Date.now(),
    timer: setTimeout(clearBusy, BUSY_TIMEOUT_MS),
  };
  cachedChanges = { hasChanges: false, files: [], aheadCount: 0, summary: "", at: Date.now() };
  return { sessionId };
}

// --- Ambil pesan (dinormalisasi untuk UI) ---
export async function fetchMessages(limit = 100) {
  const sessionId = await ensureSession();
  // Watchdog: eksekusi yang macet di-interupsi otomatis.
  await interruptStalled(sessionId);
  const res = await ocFetch("/api/session/" + sessionId + "/message?limit=" + limit);
  if (!res.ok) throw httpError(502, "Gagal membaca sesi OpenCode (" + res.status + ")");
  const body = await res.json();
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const messages = [];
  for (const m of list) {
    if (m.type === "user" && typeof m.text === "string") {
      messages.push({
        id: m.id,
        role: "user",
        text: m.text,
        createdAt: m.time ? m.time.created : null,
        done: true,
      });
    } else if (m.type === "assistant") {
      let text = "";
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part.text === "string") text += part.text + "\n";
        }
      }
      const done = !!(m.time && m.time.completed);
      if (!text.trim() && !done && m.content && m.content.length === 0) continue; // placeholder kosong
      messages.push({
        id: m.id,
        role: "assistant",
        text: text.trim(),
        createdAt: m.time ? m.time.created : null,
        done,
        finish: m.finish || null,
      });
    }
  }
  messages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const last = messages[messages.length - 1];
  if (busy && last && last.role === "assistant" && last.done) clearBusy();
  const ocBusy = (await sessionBusyAge(sessionId)) !== null;
  const running = busyInfo() !== null || ocBusy;
  return { sessionId, messages, running };
}

// --- Status perubahan workspace (untuk tombol Approve/Batal) ---
export async function changesStatus() {
  await runGit(["fetch", "origin"]).catch(() => {});
  const status = await runGit(["status", "--porcelain"]);
  const ahead = await runGit(["rev-list", "--count", "origin/main..HEAD"]);
  const diffStat = await runGit(["diff", "--stat", "origin/main...HEAD"]);
  const lines = status.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const aheadCount = Number(ahead.stdout.trim() || 0);
  const hasChanges = lines.length > 0 || aheadCount > 0;
  const result = {
    hasChanges,
    files: lines,
    aheadCount,
    summary: diffStat.stdout.trim(),
  };
  cachedChanges = Object.assign({ at: Date.now() }, result);
  return result;
}

// --- Aktivitas ringan (untuk notifikasi global, tanpa git fetch) ---
export async function activity() {
  return {
    busy: busyInfo(),
    hasChanges: cachedChanges ? cachedChanges.hasChanges : null,
    changedAt: cachedChanges ? cachedChanges.at : null,
  };
}

// --- Approve: commit + push → GitHub Actions deploy otomatis ---
export async function approveDeploy(message) {
  const info = busyInfo();
  if (info) throw httpError(409, "JFFBOT masih bekerja. Tunggu selesai dulu.");
  const status = await runGit(["status", "--porcelain"]);
  const ahead = await runGit(["rev-list", "--count", "origin/main..HEAD"]);
  const aheadCount = Number(ahead.stdout.trim() || 0);
  if (!status.stdout.trim() && aheadCount === 0) {
    throw httpError(400, "Tidak ada perubahan untuk dideploy.");
  }
  if (status.stdout.trim()) {
    const add = await runGit(["add", "-A"]);
    if (!add.ok) throw httpError(500, "git add gagal: " + add.stderr.slice(0, 300));
    const commit = await runGit(["commit", "-m", "jffbot: " + (message || "perubahan dari JFFBOT")]);
    if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      throw httpError(500, "git commit gagal: " + commit.stderr.slice(0, 300));
    }
  }
  const push = await runGit(["push", "origin", "main"]);
  if (!push.ok) {
    throw httpError(500, "git push gagal: " + (push.stderr || push.stdout).slice(0, 400));
  }
  cachedChanges = { hasChanges: false, files: [], aheadCount: 0, summary: "", at: Date.now() };
  return { pushed: true, output: push.stdout.trim() };
}

// --- Batalkan: kembalikan workspace ke origin/main (commit lokal dibuang) ---
export async function cancelChanges() {
  const info = busyInfo();
  if (info) throw httpError(409, "JFFBOT masih bekerja. Tunggu selesai dulu.");
  await runGit(["fetch", "origin"]).catch(() => {});
  const reset = await runGit(["reset", "--hard", "origin/main"]);
  if (!reset.ok) throw httpError(500, "git reset gagal: " + reset.stderr.slice(0, 300));
  cachedChanges = { hasChanges: false, files: [], aheadCount: 0, summary: "", at: Date.now() };
  return { reverted: true };
}
