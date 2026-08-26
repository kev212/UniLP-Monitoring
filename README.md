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
| `ALCHEMY_BASE_HTTP`, `ALCHEMY_ROBINHOOD_HTTP` | Endpoint RPC execution dan one-time wallet bootstrap. `ALCHEMY_ROBINHOOD_HTTP` khusus execution. |
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
| `/scan_pools` | Mencari kandidat pool berdasarkan yield 1 jam. |
| `/history` | Riwayat close dengan PnL minimal `+/-0.5%`. |
| `/calendar` | Kalender realized PnL UTC. |

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
