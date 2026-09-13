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

- `mail` — alamat dan password mailbox CloudMail kamu
- `domains` — domain email random, pilih salah satu
- `captcha.apiKey` — API key CapSolver
- `invite.project` — jawaban esai untuk form invite, sebaiknya diubah (lihat di bawah)

Lalu jalankan:

```bash
node run.js
```

Satu perintah menghasilkan satu akun. Hasilnya masuk ke folder `results/`:

```
results/account-<userId>.json           email, password, userId, status invite
results/account-<userId>.cookies.txt    sesi login, bisa dipakai ulang
results/accounts.txt                    email:password
```

Opsi tambahan:

```bash
node run.js --dry-mail     # berhenti sebelum kirim OTP
node run.js --no-submit    # bikin akun tapi lewati form invite
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
| project | teks bebas, bisa diubah di `config.json` |
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

Field `project` sengaja diisi teks yang meyakinkan. Semakin spesifik isinya,
semakin besar peluang lolos review, jadi silakan ubah lewat `config.json`.

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
