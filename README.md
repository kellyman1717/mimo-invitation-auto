# mimo-invitation-auto

Buat satu akun MiMo Desktop dan submit form invite, full HTTP tanpa browser.

Alur ini disusun ulang dari dua file HAR hasil capture browser, jadi setiap request
di sini adalah replika dari yang dikirim browser asli.

## Cara pakai

```bash
npm install
cp config.example.json config.json
```

Isi `config.json`:

- `mail` — mailbox CloudMail (lihat bagian Sumber email)
- `domains` — domain email random, pilih salah satu
- `captcha.apiKey` — API key CapSolver
- `proxy` — pool proxy dari `proxypool.py` (lihat bagian Proxy)
- `invite.project` — biarkan kosong untuk teks acak (lihat di bawah)

Lalu jalankan:

```bash
node run.js
```

Hasilnya masuk ke folder `results/`:

```
results/account-<userId>.json           email, password, userId, project, proxy, status invite
results/account-<userId>.cookies.txt    sesi login, bisa dipakai ulang
results/all_accounts.json               gabungan semua akun (array)
results/accounts.txt                    email:password
```

`project` di file satuan adalah teks esai yang benar-benar dikirim ke form, jadi
bisa dicek per akun. `all_accounts.json` menumpuk tiap akun yang berhasil —
kalau file-nya rusak, run berikutnya memulai array baru alih-alih gagal.

### Bikin banyak akun sekaligus

```bash
node run.js -n 10              # 10 akun, jeda default 8 detik antar akun
node run.js -n 10 --delay 5000 # jeda 5 detik
node run.js -n10               # tanpa spasi juga boleh
node run.js --help
```

Perilaku batch:

- Mailbox login **sekali** untuk seluruh batch, bukan per akun.
- Pool proxy di-warm **sekali**; tiap akun ambil proxy sendiri dari pool itu.
- **Gagal satu akun tidak menghentikan sisanya.** Errornya dicatat, batch lanjut,
  dan ringkasan `x/n succeeded` dicetak di akhir.
- Exit code 1 hanya kalau **tidak ada** akun yang berhasil. Batch 9/10 itu sukses.
- Jeda dikasih jitter acak (0–50% tambahan) supaya tidak menabrak endpoint dengan
  ritme tetap.

Opsi lain:

```bash
node run.js --dry-mail     # berhenti sebelum kirim OTP
node run.js --no-submit    # bikin akun tapi lewati form invite
node run.js --proxy        # paksa pakai proxy pool walau config.proxy.enabled false
```

## Alur

```
 1. GET  mimo-server-sgp/api/user/xiaomi/login      302, ambil sign + callback
 2. GET  account.xiaomi.com/pass/serviceLogin       302, set cookie deviceId
 3. GET  global.account.xiaomi.com/pass2/config     ambil region
 4. GET  /pass/getCode?icodeType=register           gambar captcha, set cookie ick
 5. POST /pass/sendEmailRegTicket                   kirim OTP ke email
 6.      polling inbox CloudMail                    ambil kode OTP
 7. POST /pass/verifyEmailRegTicket                 akun dibuat
 8. GET  /api/sts?sign=...                          302 lalu 200, sesi mimo aktif
 9. GET  /api/user/xiaomi/me/basic                  dapat userId
10. POST /api/user/invite/apply                     submit form
11. GET  /api/user/invite/check                     status jadi 0, artinya terkirim
```

Semuanya HTTPS biasa. Satu-satunya layanan pihak ketiga di jalur ini adalah
captcha solver.

## Enkripsi email dan password

`sendEmailRegTicket` dan `verifyEmailRegTicket` tidak mengirim email dan password
dalam bentuk asli. Skemanya diambil dari bundle JS Xiaomi (`crypto.*.chunk.js`):

1. Bikin key acak 16 karakter dari `A-Za-z0-9!@#$%^&*`.
2. Header `EUI` diisi `base64(RSA_PKCS1v15(btoa(key)))` digabung titik, lalu
   `base64("email,password")`. RSA-nya 1024-bit dengan padding PKCS#1 v1.5.
3. Tiap nilai dienkripsi AES-256-CBC PKCS7 pakai key itu, dengan IV tetap
   `0102030405060708` (ASCII biasa).

Implementasinya ada di `lib/crypto.js`.

## Sumber email

Pakai mailbox CloudMail. Inbox-nya catch-all, jadi tiap akun dapat alamat acak
di domain yang kamu daftarkan di `domains` dan semua balasannya masuk ke satu
inbox.

```json
"mail": {
  "baseUrl": "https://cloud-mail.xxx.workers.dev",
  "email": "mailbox@example.com",
  "password": "password-mailbox"
}
```

### Kenapa bukan Gmail dot trick

Gmail mengabaikan titik di bagian depan alamat, jadi `johndoe@gmail.com` dan
`j.o.h.ndoe@gmail.com` masuk ke inbox yang sama. Terlihat seperti cara
mendapatkan ribuan alamat dari satu mailbox — tapi **Xiaomi juga mengabaikan
titik**, jadi trik ini tidak berfungsi di sini.

Terukur pada 5 varian titik dari satu mailbox: **0 diterima, 5 ditolak** dengan
kode 25014 "sudah terdaftar", padahal varian-varian itu belum pernah
didaftarkan. Alamat catch-all acak sebagai kontrol diterima, dan alamat Gmail
acak yang belum pernah dipakai juga diterima — jadi yang ditolak memang
spesifik ke mailbox yang sudah punya akun Xiaomi.

`+alias` (`johndoe+mimo@gmail.com`) juga tidak menolong: setelah captcha benar,
Xiaomi menolaknya dengan 25014 yang sama.

Mailbox Gmail yang **belum pernah** dipakai untuk Xiaomi masih bisa dipakai satu
kali, tapi tidak lebih dari itu — jadi untuk batch, catch-all tetap satu-satunya
sumber yang jalan.

## Proxy

Pool proxy diambil dari script Python terpisah, `proxypool.py` (default:
`D:\Project\unikey-auto\proxypool.py`, bisa diubah lewat `proxy.scriptPath`).
Script itu yang urus scraping, validasi, dan ban — Node cuma jadi jembatan.

`lib/proxy.js` menjalankan proxypool.py sebagai child process yang hidup terus,
lalu ngobrol lewat stdin/stdout:

```
node   -> python : take | drop <proxy> | stats | quit
python -> node   : <proxy> | none | READY
```

Kenapa begitu: pool-nya sudah matang di Python (7 sumber, ban per-alasan,
cooldown sumber). Menulis ulang di Node cuma bikin salinan yang lebih buruk.

Settingan di `config.json`:

```json
"proxy": {
  "enabled": true,
  "scriptPath": "D:\\Project\\unikey-auto\\proxypool.py",
  "want": 24,
  "minPool": 8,
  "spare": 4,
  "required": false
}
```

| key | arti |
| --- | --- |
| `enabled` | pakai proxy atau tidak (bisa dipaksa lewat `--proxy`) |
| `want` / `minPool` | target jumlah proxy hidup di pool. Naikkan kalau `-n` besar |
| `spare` | proxy cadangan per akun, buat rotasi kalau proxy utama mati |
| `required` | `true` = gagal keras kalau pool kosong, bukan jalan tanpa proxy |
| `validateTarget` | URL buat tes proxy (default endpoint config Xiaomi) |

Catatan penting:

- **Satu proxy dipakai untuk satu akun penuh.** Pindah IP di tengah alur
  registrasi lebih mencurigakan daripada satu IP tetap. Rotasi cuma terjadi
  kalau proxy-nya benar-benar mati.
- **Kalau semua proxy mati, script berhenti** — tidak diam-diam lanjut dari IP
  asli. Itu justru kebocoran yang mau dihindari proxy.
- Mailbox CloudMail **tidak** lewat proxy secara default: itu akun kamu sendiri
  di host lain, dan proxy gratis yang lolos validasi Xiaomi belum tentu bisa
  ke sana. Kegagalan di tengah polling OTP harganya satu run penuh.
- curl perlu `--connect-timeout`; tanpa itu proxy mati bikin nunggu 21 detik
  masing-masing. Sekarang 12 detik.
- **Proxy dikembalikan ke pool setelah tiap akun** (`releaseProxies`). Tanpa itu
  pool menghitungnya masih dipakai, dan batch 10 akun menghabiskan pool 24
  walaupun tidak ada yang benar-benar memakainya.

## Captcha

Provider diatur di `config.json` lewat `captcha.provider`. Yang didukung:
`capsolver` (default), `2captcha`, `anticaptcha`, `local` (tesseract.js), `manual`.

Captcha Xiaomi selalu 5 karakter dan cukup berisik. Hasil pengukuran pada 11
percobaan nyata:

```
jawaban 5 karakter : diterima 3 dari 6  -> 50%
jawaban 4 karakter : diterima 0 dari 5  -> 0%
```

Solver cukup sering salah baca dan hanya mengembalikan 4 karakter, dan jawaban
seperti itu selalu ditolak. Karena itu `run.js` memeriksa panjang jawaban sebelum
mengirim: kalau bukan 5 karakter, gambar langsung diambil ulang tanpa membuang
satu request. Panjang ini bisa diatur lewat `captcha.length` di `config.json`.

Jawaban salah juga membuat cookie `ick` tidak valid, jadi setiap retry selalu
mengambil gambar baru, bukan mengirim ulang jawaban yang sama. `maxAttempts`
diset 10 karena sekitar separuh percobaan gagal.

## Isi form invite

Form dikirim sebagai satu payload JSON berisi 10 field. Semuanya otomatis, tidak
ada yang perlu diisi manual.

| field | isi |
| --- | --- |
| email | email akun yang baru dibuat |
| role | `developer` |
| products | chatgpt, claude, deepseek, kimi, qwen, claude-code, codex, workbuddy |
| project | teks acak dari kamus internal, atau nilai `invite.project` di `config.json` |
| attachments | kosong |
| expectations | code, prototype, local-files |
| source | `x` |
| locale | `en-US` |
| consentAtMs | timestamp saat submit |
| agreementVersion | versi privacy dan terms |

Pilihan yang tersedia di form aslinya:

```
role          developer | student | product-design | data-research | creator-ops

products      chatbot : chatgpt | claude | gemini | deepseek | kimi | doubao | qwen
              agent   : claude-code | codex | cursor | copilot | trae
                        qoder | manus | genspark | workbuddy | kimi-work

expectations  code | office | data-viz | research | prototype | design
              image | video | automation | multi-model | local-files

source        x | xiaohongshu | wechat-oa | weibo | tech-community | friend
```

Field `project` diisi otomatis dengan teks acak supaya tiap akun beda isinya.
Isinya dirakit dari kamus di `lib/invite.js`: 14 templat kalimat, dan tiap slot
di dalamnya diambil acak dari daftar frasa yang bisa saling tukar — jadi
kalimatnya tetap gramatikal, bukan kata acak. Totalnya sekitar 8×10¹² kombinasi.

Kenapa frasa, bukan kata lepas: kamus mentah (WordNet, word-list) tidak punya
kategori "software", dan urutan frekuensinya dari korpus lama — hasilnya
kalimat gramatikal tapi ngawur, seperti "I built a barrel for defense". Frasa
yang disusun per-slot memberi variasi tanpa kehilangan makna.

Mengisi `invite.project` di `config.json` akan menimpa generator dan memakai
teks itu apa adanya.

Mau lihat hasilnya tanpa jalanin alur penuh:

```bash
node lib/invite.js
```

Perintah itu sekaligus jadi self-check: memastikan semua templat resolve, tiap
pool cukup besar, tidak ada entri yang dobel cadence (`every Monday` + `a week`),
tidak ada preposisi bertumpuk (`for review` + `for reviewing`), dan 500 sampel
harus unik semua.

## Struktur file

| file | fungsi |
| --- | --- |
| `run.js` | orkestrator, retry captcha, tunggu OTP, submit form, simpan hasil |
| `lib/http.js` | session HTTP dengan cookie jar, dibangun di atas curl |
| `lib/crypto.js` | enkripsi AES dan RSA |
| `lib/xiaomi.js` | client registrasi Xiaomi (langkah 1-8) |
| `lib/invite.js` | me, invite check, invite apply |
| `lib/mail.js` | client CloudMail dan ekstraksi kode OTP |
| `lib/captcha.js` | solver captcha yang bisa diganti-ganti |

## Catatan

- Parameter `sign` ternyata statis dari server, bukan per sesi, jadi tidak perlu
  ada penandatanganan di sisi client.
- Parameter `qs` di-encode dua kali.
- Redirect 302 dari `/api/sts` harus diikuti dengan cookie jar yang sama, karena
  response itulah yang men-set `serviceToken` dan `mimosgp_slh`.
- Parameter `emailId` di API CloudMail adalah kursor "kurang dari". Nilai 0 berarti
  ambil dari paling atas, jadi `listAll()` selalu meminta dari atas lalu memfilter
  di sisi client.
