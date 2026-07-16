# UniLP Guardian

Monitoring dan auto-exit Uniswap LP untuk Base dan Robinhood Chain. Posisi dibuka manual oleh wallet yang sama; service ini mendeteksi posisi, membangun ledger PnL dalam token quote, memberi alert Telegram, dan menutup posisi pada global SL/TP.

## Safety Model

- `DRY_RUN=true` adalah default. Semua rencana transaksi disimulasikan tetapi tidak dibroadcast.
- Private key dibaca dari Docker secret pada runtime. Jangan masukkan private key ke `.env`, source code, database, atau chat.
- Hanya deployment Uniswap V2, V3, dan V4 resmi dalam `src/chains.ts` yang dipakai.
- Token quote diidentifikasi dengan alamat allowlist canonical, bukan symbol. Pair harus memiliki tepat satu quote token agar dapat diarm.
- `PNL_INCLUDE_GAS=false` sesuai keputusan saat ini. Gas dicatat dalam log transaksi tetapi tidak mengubah trigger.
- Nilai PnL memakai hasil full-close konservatif: token quote yang ditarik ditambah output route non-quote setelah buffer slippage 1%.
- Guard harga membutuhkan observasi yang berumur minimal `TWAP_WINDOW_SECONDS`; posisi tidak akan exit saat guard belum siap atau deviasi melebihi batas.
- Exact approval dibuat otomatis dan dibatasi ke nominal transaksi. V2 dapat memerlukan approval LP, remove, approval token hasil, lalu swap.

## Supported Position Lifecycle

- Alchemy bootstrap menginventarisasi asset-transfer wallet sekali, lalu validasi hanya menerima pair/factory dan Position Manager Uniswap resmi.
- V2: kandidat LP token dari inventory divalidasi terhadap factory resmi, lalu cashflow direkonstruksi dari `Mint`/`Burn` receipt.
- V3: NFT dari `NonfungiblePositionManager` dihydrate lewat event `IncreaseLiquidity` dan `Collect` yang difilter per token ID.
- V4: NFT dari `PositionManager` dihydrate dari receipt transfer token ke/dari PoolManager untuk transaksi `ModifyPosition` tunggal. Batch yang mengubah beberapa posisi tidak akan ditebak dan masuk `needs_review`.
- Posisi yang ditransfer ke wallet, token native V4, custom hook yang gagal simulasi, atau route settlement yang tidak ada masuk `needs_review`. Posisi tersebut tidak pernah di-auto-exit.

## Configuration

Mulai dari `.env.example`. Nilai penting:

```text
STOP_LOSS_PERCENT=-10
TAKE_PROFIT_PERCENT=20
POSITION_MONITOR_INTERVAL_MS=5000
DISCOVERY_INTERVAL_MS=30000
MAX_SWAP_SLIPPAGE_BPS=100
PNL_INCLUDE_GAS=false
APPROVAL_MODE=exact
DRY_RUN=true
POOL_SCAN_MIN_MARKET_CAP_USD=500000
POOL_SCAN_MIN_POOL_TVL_USD=10000
POOL_SCAN_MIN_TOTAL_ACTIVE_TVL_USD=70000
POOL_SCAN_MIN_POOL_AGE_SECONDS=3600
POOL_SCAN_MIN_YIELD_HOURLY_PERCENT=1
POOL_SCAN_MAX_RESULTS=10
POOL_SCAN_ALLOWED_QUOTES=USDG,WETH,ETH
POOL_SCAN_CANDIDATE_PAGES=3
```

Gunakan endpoint Alchemy untuk initial discovery dan archive reads:

```text
ALCHEMY_BASE_HTTP=https://base-mainnet.g.alchemy.com/v2/...
ALCHEMY_ROBINHOOD_HTTP=https://robinhood-mainnet.g.alchemy.com/v2/...
```

Alchemy menyelesaikan inventory wallet tanpa `START_BLOCK_*`. Bila endpoint kosong, `START_BLOCK_*` tetap dapat dipakai sebagai fallback. Nilai `0` tidak lagi menscan genesis; worker hanya membaca `RPC_BOOTSTRAP_LOOKBACK_BLOCKS` terbaru dan posisi tanpa histori lengkap tidak akan diarm.

Native RPC (`BASE_RPC_HTTP`/`ROBINHOOD_RPC_HTTP`) dipakai untuk `eth_getLogs` saat scanning. Jangan arahkan `rpcHttp` ke Alchemy Free tier: `eth_getLogs` di Free tier dibatasi 10 block per request dan compute-units/sec rendah, sehingga scan akan gagal (HTTP 429). Alchemy hanya untuk bootstrap inventory dan archive reads. Bila RPC yang dipakai adalah Alchemy, `MAX_LOG_BLOCK_RANGE` otomatis 10 dan `RPC_REQUEST_DELAY_MS` 25.

Robinhood public RPC hanya untuk development. Untuk VPS, pakai HTTP archive dan WebSocket provider seperti Alchemy agar sinkronisasi histori dan monitoring tidak terkena rate limit.

## Run

```bash
npm install
npm run check
npm test
npm run build
docker compose up --build -d
```

Docker membaca private key dari path host pada `EXECUTOR_PRIVATE_KEY_FILE_HOST`; file tersebut tidak dilacak Git. Jalankan dry-run sampai cashflow, PnL, dan simulasi transaksi cocok dengan posisi nyata. Setelah diverifikasi, set `DRY_RUN=false` pada VPS.

## Deployment Security

- Set `POSTGRES_DB`, `POSTGRES_USER`, dan password unik `POSTGRES_PASSWORD` di `.env` yang memiliki permission `0600`. PostgreSQL tidak dipublish ke host secara default.
- Deployment lama dengan credential PostgreSQL default harus menjalankan `sh scripts/rotate-postgres-credentials.sh` sekali sebelum memakai Compose versi ini.
- Set `EXECUTOR_PRIVATE_KEY_FILE_HOST` ke file private key host. Jangan gunakan `EXECUTOR_PRIVATE_KEY` langsung di `.env`.
- Telegram command dan callback dibatasi oleh `TELEGRAM_CHAT_ID` dan `TELEGRAM_USER_ID`. Untuk private chat, `TELEGRAM_USER_ID` dapat dikosongkan karena ID chat sama dengan ID user. Group chat wajib menyetel `TELEGRAM_USER_ID` eksplisit.
- Jangan commit `.env`, `secrets/`, database dump, atau screenshot dashboard/PnL. `.dockerignore` mencegah item tersebut masuk Docker build context.

## Execution Flow

1. Worker memindai event wallet dan menyimpan posisi serta cashflow ke PostgreSQL.
2. Nilai posisi dihitung ulang pada block baru dalam quote token.
3. Saat PnL melewati SL/TP dan guard harga lolos, position lock berubah ke `closing`.
4. Bot melakukan approval exact bila diperlukan, close full liquidity, collect fee, lalu menyimpan jumlah token non-quote yang diterima.
5. Bot re-quote, approval exact, dan swap ke quote token.
6. Kegagalan setelah close tetap berada di `closing` dan dicoba lagi otomatis; posisi tidak di-remove dua kali.

## Commands

- `/status`: buka dashboard posisi dengan tombol refresh, close, scan token, scan pools, dan config filter.
- `/scan <token-address>`: cari pool V3/V4 untuk token tertentu; menampilkan Vol 1h/yield 1h dan ranking safety Vol 6h.
- `/scan_pools`: mode kandidat cepat untuk pool V3/V4 Robinhood dengan gross yield 1h tertinggi. Scanner memeriksa `POOL_SCAN_CANDIDATE_PAGES` halaman dari masing-masing DEX V3/V4. Filter valuasi token memakai market cap dan fallback ke FDV bila market cap tidak tersedia; hasil menandai `FDV fallback`. TVL minimum per pool, total active TVL V3/V4, usia pool tertua sebagai proxy usia token, quote, yield, dan hasil maksimum dapat diubah dari Dashboard > Pool scan config. Override dashboard disimpan di PostgreSQL dan Reset kembali ke default ENV.

```bash
npm run dev
npm test
npm run build
```
