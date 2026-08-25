# Juwita One — OpenCode Rules

## 1. Hemat Token — WAJIB
- Jangan audit seluruh project untuk task kecil.
- Baca hanya file/fungsi yang relevan dengan permintaan.
- Jangan membuka ulang file besar jika bagian yang dibutuhkan sudah diketahui.
- Jangan mengulang audit, test, atau analisis yang sudah PASS.
- Jangan mencari informasi yang tidak diperlukan untuk task.
- Untuk perubahan sederhana, selesaikan dengan perubahan minimum.

## 2. Scope
- Kerjakan hanya permintaan user.
- Jangan menyentuh POS, Gudang, Marketplace, Shopee, database, atau modul lain jika tidak terkait.
- Jika hanya 1 file yang diperlukan, jangan mengubah file lain.
- Jangan membuat refactor/perbaikan tambahan yang tidak diminta.

## 3. Workflow
1. Identifikasi file/fungsi yang langsung terkait.
2. Baca bagian yang diperlukan saja.
3. Edit seperlunya.
4. Lakukan test/validasi yang relevan saja.
5. Stop setelah selesai.

## 4. Jangan Over-Analyze
- Jangan membuat rencana panjang untuk task sederhana.
- Jangan melakukan deep audit kecuali user meminta.
- Jika blocker ditemukan, laporkan blocker dan STOP.
- Jangan membuat asumsi jika tidak diperlukan.

## 5. Git & Deploy
- Jangan commit.
- Jangan push.
- Jangan deploy.
- Jangan migration.
Kecuali user secara eksplisit memerintahkannya.

## 6. Laporan
Gunakan laporan singkat:
- File berubah
- Perubahan
- Test
- Status
Maksimal 5-8 baris untuk task sederhana.

## 7. Model
- Gunakan DeepSeek V4 Flash untuk task rutin, UI, edit kecil, grep/search terbatas, bug sederhana, dan validasi ringan.
- DeepSeek V4 Pro hanya jika task benar-benar membutuhkan reasoning kompleks dan user memintanya/menyetujui.
- Jangan berpindah ke Pro otomatis hanya karena task sedikit lebih sulit.

## 8. Prinsip Utama
PERUBAHAN KECIL = CONTEXT KECIL = TOKEN KECIL.
Jangan membawa seluruh riwayat/project context ke task yang tidak membutuhkannya.
