// ============================================================
// JUWITA ONE — KONFIGURASI TERPUSAT
// ============================================================
// Backend mandiri di VPS Biznet (bukan Supabase).
// API_BASE_URL kosong = same-origin (nginx mem-proxy /api).
// JANGAN menaruh secret/service_role key di file ini (file ini publik).
// ============================================================

window.JUWITA_CONFIG = {
  API_BASE_URL: ""
};
