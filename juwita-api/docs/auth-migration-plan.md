# Rencana Migrasi Auth Mandiri — Juwita One

Dokumen perencanaan (read-only). Belum ada yang dieksekusi: tidak ada migration,
tidak ada perubahan kode, tidak ada password/secret/token yang dibuat.

---

## 1. Desain Tabel Auth Mandiri (tanpa langsung menghapus `auth_user_id`)

Tetap pakai tabel `app_users` yang sudah ada. Tidak membuat tabel baru, hanya
menambah kolom secara non-destruktif.

```sql
-- Fase awal (non-destruktif, kompatibel data lama)
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT;  -- bcrypt, nullable dulu
```

- `id UUID` (PK) tetap jadi **user id kanonik** (bukan `auth_user_id`).
- `password_hash` nullable agar data lama tetap valid; diisi bertahap saat reset.
- `auth_user_id` **TIDAK dihapus dulu**; tetap dipakai sebagai referensi lama
  (dan cadangan rollback ke Supabase Auth) sampai frontend + API stabil.
- `phone` tetap `UNIQUE` sebagai identitas login.
- `role`, `role_label`, `menus`, `status` tetap tidak berubah.

Catatan: saat ini `currentUser.id` di frontend diisi dari `auth_user_id`.
Nanti diganti ke `app_users.id`.

---

## 2. Migration Bertahap

| Step | Aksi | Dampak |
|---|---|---|
| M1 | `ALTER TABLE app_users ADD COLUMN password_hash TEXT` (nullable) | Non-destruktif, no-op untuk data lama |
| M2 | (opsional) tabel `refresh_tokens` bila ingin refresh token | Tidak wajib; JWT stateless cukup untuk awal |
| M3 | Backfill `password_hash` via reset (lihat §5) | Data lama tetap utuh |
| M4 | Cutover frontend ke auth mandiri (flag) | `auth_user_id` masih ada, bisa rollback |
| M5 | Setelah stabil: `ALTER TABLE app_users ALTER COLUMN auth_user_id DROP NOT NULL` | Longgarkan ketergantungan |
| M6 | Hapus `auth_user_id` + FK `auth.users(id)` | Terakhir, setelah Supabase lepas |
| M7 | Nonaktifkan/hapus `app_user_is_owner()` & policy RLS terkait | Setelah API penuh berjalan (role `juwita_app` sudah `BYPASSRLS`) |

Prinsip: setiap step bisa di-rollback; `auth_user_id` hanya dihapus **setelah**
frontend dan API stabil (M6).

---

## 3. Desain Endpoint

### Auth
| Endpoint | Body/Header | Respons |
|---|---|---|
| `POST /api/auth/login` | `{ phone, password }` | `{ token, user }` (user tanpa hash/token) |
| `GET /api/auth/me` | `Authorization: Bearer <jwt>` | `{ user }` |
| `POST /api/auth/logout` | `Authorization` | `{ ok: true }` (stateless) |
| `POST /api/auth/change-password` | `{ old_password, new_password }` | `{ ok: true }` |

### Admin user (pengganti `employee-admin`)
| Endpoint | Fungsi |
|---|---|
| `GET /api/users` | daftar user (tanpa `password_hash`) |
| `POST /api/users` | buat user + set password |
| `PATCH /api/users/:id` | ubah `role`/`menus`/`status`/`full_name` |
| `DELETE /api/users/:id` | nonaktif/hapus user |

Semua endpoint admin hanya untuk `privileges.includes("manage_users")` (owner).

---

## 4. Middleware JWT & Aturan Role/Menu/Privileges

1. **Verifikasi JWT** (`Authorization: Bearer`) → `sub` = `app_users.id`, periksa
   signature + `exp`.
2. **Muat profil** dari `app_users` (tanpa `password_hash`) → lampirkan
   `req.user = { id, phone, full_name, role, role_label, menus, status, privileges }`.
3. **`privileges`** dihitung: `role === "owner" && status === "ACTIVE"`
   → `["manage_users","manage_permissions","manage_settings"]`, selain itu `[]`.
4. **Guard**:
   - `requireAuth` — semua endpoint kecuali `/health` dan `/login`.
   - `requireOwner` — endpoint harga (`product_prices`), setting, dan admin user.
   - `requireMenu(group)` — cek `menus.includes(group)` bila perlu (mis. `gudang`, `pricing`).
5. **Status**: user `INACTIVE` ditolak login dan token-nya dianggap tidak valid.

Pengganti `auth.uid()`/`app_user_is_owner()`: di backend, cukup pakai `req.user.id`
dan `req.user.privileges` — tidak lagi bergantung pada `auth.uid()`.

---

## 5. Strategi Reset Password (3 user, tanpa data sensitif)

Konteks: 3 user (`owner` 1, `hr` 2). Password lama Supabase Auth (bcrypt GoTrue)
**tidak dijamin cocok** dengan skema baru; kebijakan: reset satu kali.

Urutan aman:
1. **Bootstrap owner** — jalankan CLI sekali (tidak lewat HTTP agar tidak bisa
   dieksploitasi):
   `node scripts/set-password.js <phone> <password-dari-input-prompts>`
   (password dibaca dari stdin, tidak di-log, di-hash bcrypt, disimpan ke
   `password_hash`). Password tidak pernah dicetak.
2. Owner login dengan password baru → reset 2 user `hr` lewat `PATCH /api/users/:id`
   (set password baru) atau minta user `hr` pakai `change-password`.

Tidak ada password/secret/hash yang disimpan di dokumentasi ini.

---

## 6. Keamanan Auth

| Aspek | Rekomendasi |
|---|---|
| Password hashing | bcrypt, cost **12** |
| JWT | HS256, secret `JWT_SECRET` di env (file `600`); `iss`/`aud` tetap |
| Expiry | access token **12 jam**; tanpa refresh dulu (internal) |
| Rate limit login | 5 percobaan/menit per `phone`+IP; lockout sementara setelah 10 gagal |
| Token handling | simpan di `localStorage` (pragmatis) atau httpOnly cookie (lebih aman vs XSS); pilih cookie bila memungkinkan |
| Error | selalu respons generik (`invalid_credentials`) — jangan bedakan "user tak ada" vs "password salah" |
| Log | jangan log password/token; log hanya `phone` + hasil (sukses/gagal) |

---

## 7. Urutan Rollout & Rollback

| Fase | Aksi | Rollback |
|---|---|---|
| P0 | Tambah `password_hash` (nullable) | tidak perlu |
| P1 | Backend: endpoint auth + middleware + admin user | belum dipakai frontend |
| P2 | Frontend: flag `JUWITA_AUTH_MODE = "selfhosted"` + panggil `/api/auth/*` | balikkan flag ke `"auth"` (Supabase) |
| P3 | Reset password 3 user + cutover | login lama masih bisa selama `auth_user_id`+Supabase aktif |
| P4 | Verifikasi (login, menu, owner/harga, admin user) | — |
| P5 | Bersihkan: drop `auth_user_id`, `app_user_is_owner`, RLS | rollback = restore dari snapshot DB |

Rollback aman di P2–P3 karena Supabase Auth dan `auth_user_id` masih utuh.

---

## 8. File yang Nanti Perlu Diubah

### Backend (`/var/www/juwita-api`)
- `src/server.js` — tambah route auth + admin user
- `src/auth.js` (baru) — bcrypt, sign/verify JWT
- `src/middleware.js` (baru) — `requireAuth`/`requireOwner`/`requireMenu`
- `src/db.js` — query `app_users` (tanpa `password_hash` di SELECT publik)
- `scripts/set-password.js` (baru) — bootstrap reset password
- `docs/auth-migration-plan.md` (file ini)

### Frontend (`/var/www/html`)
- `index.html` — ganti `sb.auth.signInWithPassword/getSession/signOut`
  (sekitar `realLoginSubmit` ~3574, `realRestoreSession` ~3556, `applyRealUser` ~3526,
  `JUWITA_AUTH_MODE` ~3502, inisialisasi auth ~8100) ke fetch `/api/auth/*`;
  `currentUser.id` dari `auth_user_id` → `app_users.id`
- `marketplace.html` — hanya ganti `config.js` URL bila dipakai
- `config.js` — ganti `SUPABASE_URL`/anon key → `API_BASE_URL`

### Migration (baru, belum dibuat)
- `migrations/xxxx_auth_mandiri.sql` — berisi M1/M5/M6/M7 di §2

---

*Catatan: dokumen ini murni perencanaan. Tidak ada database, kode, password,
secret, atau token yang diubah/dibuat.*
