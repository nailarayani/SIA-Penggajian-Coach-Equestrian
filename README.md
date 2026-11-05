# StablePay — Penggajian Coach Equestrian

Aplikasi web sederhana untuk mengelola coach, jadwal mengajar, penggajian, dan pembayaran. Frontend hanya terdiri dari HTML, CSS, dan JavaScript tanpa framework serta terhubung langsung ke Supabase. Backend Node.js tetap tersedia sebagai opsi, tetapi tidak diperlukan untuk membuka frontend.

## Struktur folder

```text
frontend/
  index.html
  style.css
  app.js
backend/
  app.js
  schema.sql
docs/
  deskripsi-skema-sia-penggajian-coach.md
README.md
```

Dokumentasi lengkap skema, ERD, relasi, aturan bisnis, alur akuntansi, dan catatan keamanan tersedia di [docs/deskripsi-skema-sia-penggajian-coach.md](./docs/deskripsi-skema-sia-penggajian-coach.md).

## Menyiapkan Supabase

1. Buat project Supabase dan buat backup database jika project sudah berisi data. Jika backup tidak tersedia, jangan jalankan seluruh skema pada project yang datanya ingin dipertahankan: migrasi legacy di dalamnya menghapus tabel lama setelah pemindahan.
2. Untuk menyiapkan project baru atau menjalankan migrasi penuh setelah backup, buka **SQL Editor** dan jalankan seluruh isi `backend/schema.sql` secara utuh. Skrip membuat empat tabel, menyiapkan akses `anon`/RLS, fungsi payroll, dan migrasi data lama.
3. Jika hanya muncul error `null value in column "gaji_bersih"`, jalankan migrasi khusus kolom tersebut saja di SQL Editor, bukan seluruh skema:

   ```sql
   begin;
   do $$
   declare
     generated_kind text;
   begin
     select is_generated into generated_kind
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'penggajian'
       and column_name = 'gaji_bersih';

     if generated_kind is null then
       raise exception 'Kolom public.penggajian.gaji_bersih tidak ditemukan.';
     elsif generated_kind = 'NEVER' then
       alter table public.penggajian drop column gaji_bersih;
       alter table public.penggajian
         add column gaji_bersih numeric(14, 2)
         generated always as (total_honor - potongan) stored;
     end if;
   end;
   $$;
   commit;
   ```

   Migrasi khusus hanya mengganti kolom turunan `gaji_bersih` agar dihitung dari total honor dikurangi potongan. Jika ada dependensi yang mencegah kolom diganti, transaksi gagal dan perubahan di-rollback.
4. Jika tombol **Tandai dibayar** menghasilkan error constraint `pembayaran_metode_pembayaran_check`, jalankan migrasi kecil ini di SQL Editor. Ini hanya menghapus aturan nilai metode pembayaran lama, tidak menghapus atau mengubah baris pembayaran:

   ```sql
   alter table public.pembayaran
     drop constraint if exists pembayaran_metode_pembayaran_check;
   ```

5. Jika muncul error constraint `penggajian_status_penggajian_check`, jalankan SQL ini di SQL Editor. Ini memperbolehkan status aplikasi `Belum Dibayar` dan `Dibayar`, sambil membiarkan nilai lama yang mungkin tersimpan sampai barisnya diperbarui:

   ```sql
   begin;
   alter table public.penggajian
     drop constraint if exists penggajian_status_penggajian_check;
   alter table public.penggajian
     alter column status_penggajian set default 'Belum Dibayar';
   alter table public.penggajian
     add constraint penggajian_status_penggajian_check
     check (status_penggajian in ('Belum Dibayar', 'Dibayar')) not valid;
   commit;
   ```

6. Buka `frontend/index.html` langsung di browser. Node.js dan `backend/app.js` tidak diperlukan untuk menjalankan web. Skrip penuh juga menyamakan constraint/status jadwal menjadi `Dijadwalkan`, `Hadir`, dan `Tidak Hadir`, menormalkan periode payroll lama, serta mengenali kolom periode yang sebelumnya bertipe `date`.
7. Pilih **Admin & Laporan** untuk melihat rekap penggajian dan laporan akuntansi.

## ERD — tepat empat entitas

1. **Coach**: `id_coach`, `nama_coach`, `alamat`, `no_telepon`, `tarif_per_sesi`.
2. **Jadwal_Mengajar**: `id_jadwal`, `id_coach`, `tanggal_mengajar`, `jam_mengajar`, `jumlah_sesi`, `status_kehadiran`.
3. **Penggajian**: `id_penggajian`, `id_coach`, `periode_gaji`, `total_sesi`, `total_honor`, `potongan`, `gaji_bersih`, `status_penggajian`.
4. **Pembayaran**: `id_pembayaran`, `id_penggajian`, `tanggal_pembayaran`, `jumlah_pembayaran`, `metode_pembayaran`, `keterangan`.

`backend/schema.sql` membuat tepat empat tabel bisnis tersebut. Primary key memakai `bigint` auto-increment. Jika skema lama terdeteksi, ID UUID lama dipetakan ke ID baru dan relasi jadwal, penggajian, serta pembayaran ikut disesuaikan. Jurnal umum, akun, buku besar, neraca saldo, dan laporan keuangan dibentuk saat diminta dari data penggajian dan pembayaran; data laporan tidak disimpan dalam tabel tambahan. Fungsi PostgreSQL untuk memproses penggajian dan pembayaran juga bukan entitas atau tabel.

Jika skema lama terdeteksi, skrip memindahkan data coach, jadwal/kehadiran, dan penggajian ke struktur baru serta membuat data pembayaran untuk penggajian yang sudah dibayar. Setelah migrasi, skrip menghapus tabel-tabel lama di luar empat entitas. Skrip juga membuka akses anon penuh agar aplikasi dapat digunakan tanpa login, jadi jalankan hanya pada project demo dan pastikan tidak ada data gaji atau data pribadi yang perlu dirahasiakan. Siapa pun yang memiliki URL aplikasi dapat membaca, menambah, mengubah, dan menghapus data. Buat backup sebelum migrasi.

## Alur penggajian dan laporan admin

1. Masukkan coach beserta tarif honor per sesi.
2. Catat jadwal mengajar, jumlah sesi, dan status kehadiran. Hanya jadwal berstatus **Hadir** yang masuk perhitungan.
3. Proses penggajian berdasarkan coach dan periode. Sesi yang sudah pernah masuk periode penggajian tidak dihitung ulang.
4. Saat penggajian diproses, jurnal pengakuan terbentuk: debit **Beban Honor Coach (5100)** sebesar honor bruto, kredit **Utang Honor Coach (2100)** sebesar gaji bersih, dan—jika ada potongan—kredit **Utang Potongan Honor (2200)**.
5. Saat pembayaran diproses, sistem membuat pembayaran untuk sisa gaji bersih serta jurnal debit **Utang Honor Coach (2100)** dan kredit **Kas (1000)**.
6. Halaman Admin menyediakan rekap gaji dibayar/belum dibayar, jurnal umum, buku besar, neraca saldo, laporan laba rugi, arus kas langsung, dan posisi keuangan.

Saldo awal akun diasumsikan nol. Modul ini membukukan beban honor dan pembayarannya; belum tersedia input pendapatan jasa atau setoran modal.

> Aplikasi ini tidak memiliki autentikasi pengguna dan kredensial publishable Supabase berada di frontend. Jangan gunakan konfigurasi akses publik ini untuk data penggajian nyata atau deployment publik; gunakan Supabase Auth dan kebijakan RLS terbatas untuk penggunaan produksi.

Foto hero: Fanny Schertzer, “Kamal Bahamdan & Noblesse Des Tess at 2013 Longines Global Champions Tour in Lausanne”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Kamal_Bahamdan_%26_Noblesse_Des_Tess_-_2013_Longines_Global_Champions_Tour.jpg), CC BY 3.0.
