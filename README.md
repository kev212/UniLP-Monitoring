# UniLP Guardian

Monitor dan auto-exit Uniswap LP untuk Base, Robinhood Chain, dan BNB Smart Chain. UniLP mendeteksi posisi LP dari wallet executor, menghitung PnL dalam quote token, mengirim dashboard Telegram, dan dapat menutup posisi berdasarkan rule risiko.

## Fitur

- Dukungan Uniswap V2, V3, dan V4.
- Uniswap V4 di BNB Smart Chain untuk scan, investigasi, monitoring, open/close, dan Bid-Ask Ladder.
- Stop loss, take profit, trailing stop, dan auto-exit out-of-range.
- PnL receipt-backed, history close, PnL card, dan kalender realized PnL UTC.
- Dashboard Telegram untuk status, manual close, scan token, dan pool scan.
- Pool scanner V3/V4 dengan estimasi yield, TVL, volume, dan filter quote token.

## Quick Start

Butuh Node.js 22+ dan Docker Compose.

```bash
cp .env.example .env
npm install
npm test
docker compose up -d --build
```

Isi `.env` sebelum menjalankan service:

- RPC Base dan Robinhood.
- `EXECUTOR_ADDRESS` dan file private key host.
- Credential PostgreSQL unik.
- Telegram bot token, chat ID, dan user ID bila memakai group chat.

Mulai dengan `DRY_RUN=true`. Ubah ke `false` hanya setelah cashflow, PnL, dan simulasi transaksi sudah diverifikasi.

## Konfigurasi Penting

| Variable | Kegunaan |
| --- | --- |
| `DRY_RUN` | Simulasi transaksi tanpa broadcast. Default `true`. |
| `STOP_LOSS_PERCENT` | Batas stop loss global. |
| `TAKE_PROFIT_PERCENT` | Batas take profit global. |
| `TRAILING_STOP_ACTIVATION_PERCENT` | PnL minimum untuk mengaktifkan trailing stop. |
| `TRAILING_STOP_DRAWDOWN_PERCENT` | Drawdown dari peak trailing stop. |
| `TRAILING_EXIT_ESTIMATE_BUFFER_PERCENT` | Buffer estimasi sebelum close trailing; default 10% di bawah trailing floor. |
| `SL_TWAP_GUARD_MAX_WAIT_MS` | Batas waktu guard stop-loss sebelum validasi lokal dan exit dilanjutkan. Default `5000`. |
| `TRAILING_TWAP_GUARD_MAX_WAIT_MS` | Batas waktu guard trailing sebelum exit dilanjutkan. Default `5000`. |
| `MAX_TWAP_DEVIATION_BPS` | Deviasi maksimum harga spot dari rolling TWAP. Default `250` (2.5%). |
| `TWAP_WINDOW_SECONDS` | Durasi rolling TWAP. Default `60` detik. |
| `PROFIT_OOR_ABOVE_THRESHOLD_PERCENT` | PnL minimum untuk memulai timer profit + OOR above. Default 3%. |
| `SWAP_GAS_LIMIT_MULTIPLIER_PERCENT` | Multiplier gas limit swap untuk menghindari RPC underestimation. Default 300%. |
| `OOR_AUTO_CLOSE_ENABLED` | Aktifkan auto-exit saat quote token cukup jauh above range. |
| `BASE_RPC_HTTP`, `ROBINHOOD_RPC_HTTP` | Endpoint RPC public primary untuk monitoring dan transaksi. |
| `ROBINHOOD_RPC_HTTP_FALLBACK` | Fallback public RPC untuk monitoring dan transaksi saat primary timeout, throttled, atau error transient. |
| `ROBINHOOD_SCAN_RPC_HTTP` | Fallback RPC khusus discovery, historical reads, logs, dan pekerjaan berat. Tidak pernah digunakan untuk transaksi. |
| `BSC_RPC_HTTP` | Endpoint public BSC untuk current-state monitoring. |
| `ALCHEMY_BSC_HTTP` | Endpoint Alchemy BSC untuk archive/log, bootstrap NFT, dan execution. |
| `AUTO_EXIT_CHAINS` | Chain yang boleh auto-exit. Default `base,robinhood,bsc`. |
| `BSC_POSITION_MONITOR_INTERVAL_MS` | Interval monitoring BSC. Default `10000`. |
| `ALCHEMY_BASE_HTTP`, `ALCHEMY_ROBINHOOD_HTTP` | Endpoint RPC execution, one-time wallet bootstrap, dan enumerasi saldo ERC-20 portfolio setiap 3 menit pada chain aktif. |
| `ALCHEMY_ROBINHOOD_MONITOR_HTTP` | Endpoint Alchemy khusus fallback monitoring Robinhood setelah public RPC dan BlockMachine gagal; tidak dipakai execution atau scan/discovery. |
| `TELEGRAM_CHAT_ID`, `TELEGRAM_USER_ID` | Chat dan user yang diizinkan mengakses bot. |

Lihat `.env.example` untuk seluruh variable dan nilai default.

BSC Uniswap V3/V4 diaktifkan melalui `CHAINS=robinhood,bsc`. Auto-exit SL/TP/trailing/OOR aktif jika `AUTO_EXIT_CHAINS` memuat `bsc`.

## Telegram Commands

| Command | Kegunaan |
| --- | --- |
| `/status` | Dashboard posisi aktif. |
| `/close <nomor atau key>` | Menutup posisi secara manual. |
| `/scan [base\|robinhood\|bsc] <token-address>` | Mencari pool Uniswap untuk token. |
| `/investigate [bsc\|bnb] <pool-id>` | Menganalisis pool V4/V3. |
| `/scan_pools` | Top N token berdasarkan yield 1 jam (1–20, sesuai config), dengan Prev/Next; Robinhood memakai discovery background dan tenggat pemrosesan 110 detik. |
| `/history` | Riwayat close dengan PnL minimal `+/-0.5%`. |
| `/calendar` | Kalender realized PnL UTC. |

### Discovery Robinhood

`/scan_pools` mempertahankan kandidat lintas refresh selama 7 hari sejak terakhir ditemukan atau teramati aktif. Discovery berjalan setiap 15 menit, melanjutkan cursor yang tersimpan hingga 10 halaman per DEX serta new/trending pools. Nama pool tanpa fee tetap menjadi kandidat.

Top N menentukan total hasil, dengan maksimal 10 hasil per halaman (lebih sedikit bila pesan terlalu panjang). Prev/Next memakai snapshot selama 5 menit sejak hasil dikirim, tanpa scan ulang; setelah restart atau kedaluwarsa, jalankan scan baru. Pool Scan Config menyediakan minimum volume 1 jam dalam USD **per pool** (`POOL_SCAN_MIN_VOLUME_1H_USD`, default `0` = nonaktif). Filter volume diterapkan sebelum pemilihan pool terbaik per token dan tidak mengurangi perhitungan total TVL aktif. Perubahan config berlaku untuk scan berikutnya.

Untuk `/scan_stocks` Robinhood/BSC, tombol **Min stock pool vol 1h** mengatur minimum volume USD per pool selama 1 jam secara terpisah (`POOL_SCAN_MIN_STOCK_POOL_VOLUME_1H_USD`, default `0` = nonaktif). Syarat total volume token ≥ $100k/24h tetap berlaku; hanya pool yang memenuhi minimum volume pool dan stock yield/h yang masuk hasil.

Scan interaktif menyegarkan data DexScreener dan memverifikasi pool on-chain sampai tenggat 110 detik, dengan cadangan sekitar 10 detik untuk Telegram. Hasil parsial mencantumkan kandidat yang belum selesai, data kurang, dan usia discovery. TVL fallback hanya memakai snapshot GeckoTerminal maksimal 15 menit; tidak menunggu request Gecko baru. Setting minimum TVL dan yield pengguna tetap berlaku.

Saat `/scan` aktif, discovery dan verifikasi baru dari `/scan_pools` dijeda. Request yang sudah berjalan dan cooldown provider tetap dapat memengaruhi waktu tunggu. Restart mempertahankan kandidat, cursor, serta snapshot dalam PostgreSQL; metadata kontrak dalam memori dipanaskan kembali. Migrasi tabel/kolom baru dijalankan oleh startup aplikasi seperti migrasi lain.

## Security

- Jangan simpan private key, API key, atau bot token di source code atau Git.
- Simpan `.env` dengan permission `600` dan gunakan `EXECUTOR_PRIVATE_KEY_FILE_HOST` untuk private key host.
- PostgreSQL tidak dipublish ke host secara default. Gunakan password unik pada `POSTGRES_PASSWORD`.
- Jangan commit `.env`, `secrets/`, database dump, atau screenshot dashboard/PnL.
- Deployment lama dengan credential PostgreSQL default harus menjalankan `sh scripts/rotate-postgres-credentials.sh` sekali sebelum memakai Compose versi ini.

## Development

```bash
npm run check
npm test
npm run build
```

UniLP adalah software eksekusi finansial. Verifikasi konfigurasi dan gunakan dry-run sebelum menjalankan transaksi live.

### Total balance dashboard Telegram

Snapshot posisi yang lebih tua dari 90 detik ditandai `DATA STALE` dengan usia
snapshot dan block. Timestamp pembaruan pesan bukan bukti monitoring posisi berhasil.

### Pengujian recovery monitoring

Tes race database menggunakan PostgreSQL terisolasi dan hanya berjalan jika
`MONITORING_TEST_DATABASE_URL` menunjuk database bernama `unilp_monitoring_test`.
Jangan gunakan database production. Jalankan dengan:

```bash
MONITORING_TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55432/unilp_monitoring_test npm test -- test/monitoring-recovery.integration.test.ts
```

### Perhitungan total balance

Total balance menghitung nilai spot LP yang masih dimiliki executor, termasuk fee
belum diklaim, ditambah native coin dan ERC-20 wallet dalam USD. Hanya chain di
`CHAINS` yang diperiksa. Refresh saat startup dan setiap **180 detik**; dashboard
berbagi cache dan pekerjaan refresh, sehingga jumlah chat tidak menggandakan polling.

Enumerasi token memakai `config.alchemyHttp[chain]` (misalnya
`ALCHEMY_ROBINHOOD_HTTP`), bukan RPC scan public. Saldo native, verifikasi pemilik
NFT, dan pembacaan LP memakai RPC scan chain terkait. Harga USD memakai
DexScreener. Token LP V2 serta parent/child group tidak dihitung ganda. LP yang
sudah ditarik hanya menyumbang fee tersisa, bila masih dapat diklaim.

Cache pembacaan monitoring dipakai hanya jika block cocok dengan valuasi wallet.
Jika block berubah selama enumerasi Alchemy (yang hanya menyediakan saldo latest),
saldo token direkonsiliasi memakai multicall pada block LP. Ini sengaja lebih ketat
daripada memakai cache berumur 3 menit, untuk mencegah penarikan LP dihitung dua
kali. Metadata decimals dicache per chain/alamat. Valuasi tidak meminta quote swap.

**Anggaran API:** 480 siklus/hari/chain aktif, ditambah startup; satu halaman
Alchemy per siklus berarti sekitar 480 request token balance/hari. Dokumentasi
[Alchemy Token Balances](https://www.alchemy.com/docs/data/token-api/token-api-endpoints/alchemy-get-token-balances)
mencantumkan 20 CU/request (diperiksa 10 September 2026): sekitar 9.600 CU/hari
untuk enumerasi satu halaman, belum termasuk pagination dan panggilan lain.
Biaya uang mengikuti paket provider, bukan angka CU saja. Log `portfolio wallet
read budget` mencatat request Alchemy, halaman sukses, jumlah subcall balanceOf,
dan metadata yang belum dicache; `portfolio LP read budget` mencatat ownership
subcall, pembacaan posisi/group, dan cache hit. Subcall multicall dan pembacaan LP
bukan hitungan request HTTP atau tagihan persis; batching/retry provider bisa berbeda.

Jika API enumerasi tidak tersedia pada chain tersebut, bot membaca token konfigurasi,
token posisi, serta token yang pernah ditemukan dalam proses berjalan lewat
multicall. Hasil ditandai **belum lengkap**, karena token lain tidak dapat dijamin
tercakup. Harga/metadata/saldo yang gagal dibaca juga ditandai; kegagalan refresh
menyeluruh mempertahankan angka dan timestamp sebelumnya. Tidak ada migrasi database.
