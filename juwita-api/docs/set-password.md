# Reset Password User (CLI)

Script `scripts/set-password.js` untuk mengisi `app_users.password_hash`
(tahap reset password auth mandiri). Hanya mengubah kolom `password_hash` —
tidak menyentuh role, menus, status, `auth_user_id`, atau kolom lain.

## Menjalankan

1. Muat environment (berisi `DATABASE_URL`; `JWT_SECRET` tidak dipakai):
   ```
   set -a; . /home/juwita/.juwita-one-api.env; set +a
   ```

2. Jalankan, berikan nomor HP lewat prompt (disarankan, agar nomor tidak
   tampil di daftar proses):
   ```
   node scripts/set-password.js
   ```
   Atau lewat argumen:
   ```
   node scripts/set-password.js "<nomor_hp>"
   ```

3. Ikuti prompt: ketik password dua kali (tanpa echo di layar).

## Aturan
- Password minimal 12 karakter.
- Password diketik dua kali dan harus sama.
- User tidak ditemukan → dibatalkan tanpa perubahan.
- Kesalahan input/DB → dibatalkan tanpa perubahan (transaksi di-rollback).
- Tidak ada password/hash/nomor HP yang dicatat ke log.
