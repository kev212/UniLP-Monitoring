# BSC Uniswap V4 Support Plan

## Status

Implemented on `feat/bsc-uniswap-v4`. Do not merge, deploy, or change production configuration until the user explicitly requests it. Auto-exit BSC remains disabled until `AUTO_EXIT_CHAINS` includes `bsc`.

## Objective

Add end-to-end BNB Smart Chain support using official Uniswap V4 deployments for:

- `/scan` token scans.
- `/investigate` pool analysis.
- V4 position discovery and monitoring.
- Normal single-side opens.
- Normal dual-side opens.
- Bid-Ask Ladder opens and closes.
- Manual closes.
- Stop-loss, take-profit, trailing, and out-of-range automatic exits after dry-run validation.
- USDT, WBNB, and native BNB funding and settlement.

## Locked Decisions

- BSC supports Uniswap V4 only.
- BSC PancakeSwap detection-only support is replaced, not retained in parallel.
- `/scan` token is in scope.
- `/investigate` is in scope.
- `/scanv2` is out of scope.
- `/scan_pools` is out of scope.
- `/scan_stocks`, `/gem`, and Robinhood-only candidate refresh are out of scope.
- Normal single-side, normal dual-side, and Bid-Ask Ladder are in scope.
- BSC automated opens initially support plain/no-hook pools only.
- Hooked pools may appear in scans and investigation results, but automated open must reject them unless separately allowlisted and implemented.
- BSC auto-exit is enabled only after discovery, PnL, open, manual close, settlement, and recovery pass dry-run/fork validation.
- Current-state BSC monitoring uses the official public BNB RPC first, with the configured BSC fallback and Alchemy as later fallbacks.
- BSC historical state, archive reads, and `eth_getLogs` use `ALCHEMY_BSC_HTTP` as the primary endpoint.
- BSC indexed NFT bootstrap uses the same `ALCHEMY_BSC_HTTP` endpoint through `alchemy_getAssetTransfers`.
- BSC simulation and broadcast use Alchemy first, followed by the public BNB RPC and configured fallback.
- No separate `BSC_SCAN_RPC_HTTP` variable is introduced. The existing Alchemy endpoint is the BSC archive/log endpoint.
- Initial production monitoring uses `BSC_POSITION_MONITOR_INTERVAL_MS=10000` and may be reduced only after observing request volume and latency.
- Normal and Bid-Ask post-close settlement must use the existing Robinhood KyberSwap + Uniswap provider pipeline, not a BSC-specific replacement.
- KyberSwap and Uniswap Trading API are mandatory BSC settlement providers when production settlement is enabled; local Uniswap V4 remains the final fallback.
- Existing Robinhood and Base behavior must remain unchanged.

## Current Production State

- `CHAINS=robinhood`.
- BSC RPC and Alchemy environment variables are configured.
- `QUOTE_TOKEN_ALLOWLIST_BSC` currently contains USDT and WBNB.
- `START_BLOCK_BSC=0`.
- Production has no chain 56 positions.
- Production has no chain 56 discovery cursor.
- Production has no chain 56 bootstrap marker.
- No Pancake-to-Uniswap position data migration is required for the current production database.
- The existing BSC Pancake registry and regression tests still need to be replaced in source code.

## Locked BSC RPC Architecture

### Environment Policy

Use these existing environment variables:

```text
BSC_RPC_HTTP=https://bsc-dataseed.bnbchain.org
BSC_RPC_HTTP_FALLBACK=<independent BSC current-state fallback>
ALCHEMY_BSC_HTTP=<secret Alchemy BSC endpoint supplied for deployment>
BSC_POSITION_MONITOR_INTERVAL_MS=10000
```

Security rules:

- The Alchemy URL contains an API key and must remain only in deployment secrets or the production environment.
- Never hardcode the supplied Alchemy URL in source, tests, documentation, Docker images, or committed `.env` files.
- Never log the full Alchemy endpoint or include it in error messages.
- `.env.example` documents `ALCHEMY_BSC_HTTP=` without a value.
- Rotate the key if it is ever exposed outside an approved secret channel.

### Provider Roles And Order

| Workload | Provider order |
|---|---|
| Normal current-state reads | `BSC_RPC_HTTP` -> `BSC_RPC_HTTP_FALLBACK` -> `ALCHEMY_BSC_HTTP` |
| Continuous position monitoring | `BSC_RPC_HTTP` -> `BSC_RPC_HTTP_FALLBACK` -> `ALCHEMY_BSC_HTTP` |
| `/scan` and `/investigate` current state | `BSC_RPC_HTTP` -> `BSC_RPC_HTTP_FALLBACK` -> `ALCHEMY_BSC_HTTP` |
| Historical/fixed-block state | `ALCHEMY_BSC_HTTP` -> safe current-state fallback only when the requested block is available |
| Discovery and accounting `eth_getLogs` | `ALCHEMY_BSC_HTTP` primary; do not route to official public BNB endpoints |
| Indexed NFT bootstrap | Direct `alchemy_getAssetTransfers` on `ALCHEMY_BSC_HTTP` |
| Simulation and broadcast | `ALCHEMY_BSC_HTTP` -> `BSC_RPC_HTTP` -> `BSC_RPC_HTTP_FALLBACK` |
| Receipt reconciliation | Execution client first -> normal current-state client |
| Historical balance reconciliation | Alchemy historical client first -> current-state client only when safe |

Implementation requirements:

- Preserve the existing role-separated normal, scan, log, and execution clients.
- Keep `getForScan("bsc")` public-first for current monitoring and current StateView reads.
- Make `getForLogs("bsc")` Alchemy-first and use that client for fixed-block historical reads as well as logs.
- Keep `getForExecution("bsc")` Alchemy-first.
- Do not silently send BSC historical log queries to the official public endpoint because official BNB documentation states that `eth_getLogs` is disabled there.
- Keep log requests chunked and globally serialized.
- Retain transient retry and exponential backoff behavior.
- Add adaptive block-range splitting for provider range/response-size errors rather than retrying the same oversized range indefinitely.
- A failed archive query must pause discovery/accounting safely; it must not advance the chain cursor with incomplete data.
- A failed public monitoring endpoint may fail over to Alchemy, but routine monitoring should remain public-first to preserve Alchemy quota for archive and execution work.

### Capacity Assumptions

- The official BNB public endpoint documents a rate limit of 10,000 requests per five minutes.
- One V4 position baseline read performs three fixed-block StateView calls per monitor cycle.
- One 16-bin Bid-Ask group performs up to 48 baseline StateView calls per monitor cycle before quote, PnL, ownership, and recovery reads.
- At a ten-second interval, one 16-bin group produces roughly 1,440 baseline StateView calls per five minutes.
- Start BSC at a ten-second monitoring interval. A five-second interval requires explicit production observation showing sufficient provider capacity and stable latency.

## UniCrit Comparison And Rejected Design

The UniCrit BSC implementation is a useful reference for official contract metadata and generic V4 behavior, but its RPC and settlement topology must not be copied:

- UniCrit uses one `RPC_56` endpoint for reads, monitoring, simulation, broadcast, and receipt waiting.
- Its default public endpoint is `https://1rpc.io/bnb`.
- It has no role-specific BSC failover and no dedicated historical log client.
- It does not run the historical `eth_getLogs` workflow required by UniLP discovery and accounting.
- It conditionally uses Alchemy indexed methods only when its single RPC URL is an Alchemy endpoint.
- Its post-close flow uses GMGN/local routing rather than the required Robinhood KyberSwap + Uniswap settlement architecture.
- UniLP retains its durable signed-transaction persistence, receipt accounting, restart recovery, provider validation, and role-separated RPC clients.

## Branch And Commit Workflow

The following must be the first implementation step after the user says `go`:

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/bsc-uniswap-v4
```

Rules:

- Do not implement directly on `main`.
- Keep unrelated image and spreadsheet files untracked.
- Commit only intended source, tests, documentation, and configuration examples.
- Use logical commits rather than one large unreviewable commit.
- Do not merge the feature branch into `main` until all acceptance criteria pass and the user explicitly requests the merge.

Suggested commit groups:

1. `feat: add uniswap v4 bsc registry and scan support`
2. `feat: monitor uniswap v4 positions on bsc`
3. `feat: open and close bsc v4 positions`
4. `feat: support bsc bidask ladders`
5. `fix: normalize bsc quote and usd accounting`

## Official BSC Deployments

Use only the official Uniswap deployments:

| Contract | Address |
|---|---|
| PoolManager | `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` |
| PositionManager | `0x7a4a5c919ae2541aed11041a1aeee68f1287f95b` |
| Quoter | `0x9f75dd27d6664c475b90e105573e550ff69437b0` |
| StateView | `0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4` |
| Universal Router | `0x1906c1d672b88cd1b9ac7593301ca990f94eae07` |
| Universal Router 2.1.1 | `0x8b844f885672f333bc0042cb669255f93a4c1e6b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| USDT | `0x55d398326f99059f775485246999027B3197955` |

Source references:

- Uniswap V4 deployments documentation.
- Uniswap unified deployment feed.
- BscScan code and chain ID verification during implementation.

## Phase 1: Chain And Deployment Metadata

### Registry

Update the BSC registry to:

- `dex: "uniswap"`.
- `discoveryProtocols: ["v4"]`.
- Use the official V4 contracts above.
- Stop using Pancake V3 factory, manager, quoter, and router.
- Prevent RoutePlanner and scanners from calling zero-address V2/V3 deployments.
- Replace Pancake detection-only tests with Uniswap V4 BSC tests.

### Chain Metadata

Introduce centralized metadata instead of Base-versus-Robinhood ternaries:

| Field | BSC value |
|---|---|
| Internal name | `bsc` |
| Alias | `bnb` |
| Chain ID | `56` |
| Display name | `BNB Smart Chain` |
| Native symbol | `BNB` |
| Wrapped symbol | `WBNB` |
| Gecko network | `bsc` |
| Gecko Uniswap V4 DEX ID | `uniswap-v4-bsc` |
| DexScreener chain | `bsc` |
| Uniswap interface slug | `bnb` |
| Explorer | `https://bscscan.com` |

Use this metadata for:

- Scanner API requests.
- Pool links.
- Telegram labels.
- Native token labels.
- Wrapped-native handling.
- Transaction links.
- Portfolio and PnL formatting.

## Phase 2: `/scan` Token Support

### Command And Dashboard

Support:

```text
/scan bsc <token-address>
/scan bnb <token-address>
```

Behavior:

- A bare token address continues to default to Robinhood.
- Dashboard Scan token gets a Base, Robinhood, and BSC chain picker.
- Pending token input must preserve the selected chain instead of reparsing with the Robinhood default.
- Telegram usage and command descriptions include BSC.
- Results display `BNB Smart Chain (56)`.

### Scanner Data Sources

- Query GeckoTerminal network `bsc`.
- Accept `uniswap-v4-bsc`.
- Reject PancakeSwap DEX IDs.
- Do not treat `uniswap-bsc` V3 pools as eligible because BSC scope is V4 only.
- Query DexScreener using chain `bsc`.
- Verify every V4 candidate through official StateView and PositionManager.
- Recompute the pool ID from the returned pool key and reject mismatches.
- Generate Uniswap URLs using `/explore/pools/bnb/<pool-id>`.
- Keep `/scan` semantics unchanged: scan all eligible Uniswap pools containing the requested token; do not add quote filtering.

## Phase 3: `/investigate` Support

### Command Syntax

Support:

```text
/investigate bsc <pool-id>
/investigate bnb <pool-id>
/investigate <pool-id>
```

Behavior:

- A bare pool identifier continues to default to Robinhood.
- BSC accepts only a 32-byte V4 pool ID.
- BSC rejects V3 pool addresses.
- BSC accepts Uniswap links using the `bnb` slug.
- Base and Robinhood parsing remains backward compatible.

### Chain-Aware Investigation

- Pass the selected chain through every investigation provider.
- Query DexScreener with the selected chain rather than hardcoded Robinhood.
- Query Gecko TVL fallback with the selected chain.
- Use the selected chain's StateView and PositionManager.
- Read `slot0`, active liquidity, pool key, fee flag, tick spacing, and hooks.
- Recompute and verify the pool ID.
- Include chain in `InvestigateResult`.
- Format the heading as `BNB Smart Chain (56) | Uniswap V4`.
- Display the hook address when nonzero.
- Display native currency as BNB.

### Dynamic Fee Accuracy

- Treat `0x800000` as `DYNAMIC_FEE_FLAG`, not as a fee percentage.
- Display `currentLpFee` as the latest fee snapshot.
- Clearly label `volume x current fee` as an estimate, not actual historical fees.
- For dynamic-fee pools, query recent PoolManager `Swap` events where practical.
- Report the observed one-hour fee-tier distribution.
- Calculate a fee-weighted one-hour estimate from actual event fee values when logs and token prices are available.
- Fall back to snapshot estimation with an explicit warning when historical logs are unavailable.

## Phase 4: Quote And Native Currency Model

### Allowlist

Production BSC allowlist becomes:

```text
USDT:0x55d398326f99059f775485246999027B3197955
WBNB:0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
BNB:0x0000000000000000000000000000000000000000
```

### Quote Priority

Extend quote selection for:

- USDT.
- WBNB.
- BNB.

Expected BSC priority:

```text
USDT > WBNB > BNB
```

### Native Currency Handling

- Stop hardcoding ETH/WETH labels in chain-generic code.
- Use BNB/WBNB labels on BSC.
- Use the zero address for native BNB in V4 pools.
- Use `Ether.onChain(56)` only as the SDK-native currency representation because it maps to canonical WBNB internally.
- Keep user-facing labels as BNB.
- Wrap only the WBNB shortfall when a WBNB-funded position is opened with native BNB.
- Unwrap WBNB settlement proceeds to BNB when the selected quote is native.
- Preserve enough native BNB for gas when wrapping or spending native funding.

## Phase 5: V4 Discovery And Monitoring

### Discovery

- Scan official BSC V4 PositionManager ERC-721 transfers.
- Enumerate currently owned BSC V4 NFTs during bootstrap.
- Read pool key and position info from the official contracts.
- Validate current NFT ownership before arming and before execution.
- Persist `dex: "uniswap"`, position manager, currencies, fee, tick spacing, and hooks.
- Match quote tokens using USDT, WBNB, and BNB.
- Mark unsupported hooked positions `needs_review` rather than auto-arming them.

### Bootstrap

- Use configured `ALCHEMY_BSC_HTTP` indexed transfers through `alchemy_getAssetTransfers`.
- Write a chain 56 bootstrap marker only after successful BSC Uniswap V4 discovery.
- Use the same Alchemy BSC endpoint for historical event and state reads.
- Hydrate receipts and fixed-block StateView data through the Alchemy-first historical/log client.
- Do not mark bootstrap complete when indexed pagination, ownership validation, historical hydration, or cursor persistence is incomplete.
- Because production currently has no BSC cursor or bootstrap state, no reset migration is required.

### Monitoring

- Read current principal, fees, range, tick, and liquidity through BSC StateView and PositionManager.
- Use the public BNB RPC first for routine current-state monitoring and Alchemy only after public endpoint failover.
- Start with `BSC_POSITION_MONITOR_INTERVAL_MS=10000`.
- Persist PnL snapshots using the same status lifecycle as Base and Robinhood.
- Detect transferred-away NFTs and move stale records to review rather than attempting execution.
- Keep monitoring separate from automatic execution during rollout.

## Phase 6: USD And PnL Accounting

### USDT Normalization

BSC USDT uses 18 decimals. All USD persistence remains six-decimal micro-USD:

```text
1 USD = 1_000_000 final_pnl_usd units
```

Required changes:

- Normalize raw 18-decimal USDT to six-decimal USD before storing USD fields.
- Do not format BSC USDT with USDG/USDC six-decimal assumptions.
- Make quote symbol and decimals explicit in dashboard, alerts, close history, and cards.
- Generalize stable-token recognition to include USDT.

### WBNB And BNB Pricing

- Price WBNB/BNB through a validated BSC V4 WBNB/USDT route or supported external provider.
- Keep wrapped-native prices isolated per chain.
- Do not reuse the Robinhood WETH price cache for WBNB.
- Backfill final USD PnL only when a trusted BNB/USD quote is available at the close block.

## Phase 7: Normal Open Support

### Telegram Flow

- Add a chain picker for normal opens.
- BSC accepts only a V4 pool ID.
- Review cards show BSC, BNB/WBNB/USDT, correct decimals, and the official pool key.

### Single-Side

- Support USDT-funded positions.
- Support WBNB-funded positions.
- Support native BNB-funded positions.
- Reject hooked pools initially.
- Verify pool ID, official manager, StateView state, and no-hook policy before approval.

### Dual-Side

- Compute the quote/base split using the V4 SDK.
- Wrap only the WBNB shortfall before swapping.
- Swap the required quote portion through a validated BSC provider.
- Mint with Permit2 and official BSC PositionManager.
- Preserve native BNB for gas.
- Maintain the current warning that normal dual opens are multi-transaction and can leave intermediate assets if mint fails.

## Phase 8: Bid-Ask Ladder Support

- Extend Bid-Ask chain types and callbacks to BSC.
- Permit only protocol V4 on BSC.
- Keep the plain/no-hook requirement.
- Support USDT, WBNB, and native BNB funding.
- Preserve atomic multi-bin open semantics.
- Persist group, bins, execution attempts, plan hash, and reference state before broadcast.
- Use official BSC Permit2 and PositionManager.
- Reconcile token IDs from the open receipt.
- Support close batch, settlement swap, WBNB unwrap, retries, and restart recovery.
- Ensure quote-side direction is derived from token ordering and not user input.

## Phase 9: Close And Settlement

### Normal V4 Close

- Validate NFT ownership before close.
- Use official BSC PositionManager decrease/collect/burn flow.
- Account actual receipt transfers.
- Settle non-quote assets through BSC V4 routes or supported aggregators.
- Preserve durable pending transaction and retry behavior.

### Bid-Ask Close

- Close all owned bin NFTs atomically where feasible.
- Record direct close token amounts.
- Aggregate and settle to the configured quote token.
- Unwrap WBNB to BNB when native quote was selected.
- Persist final quote and USD PnL.

### Provider Support

- Reuse `prepareBestSettlementSwap()` for normal positions and `prepareGroupSettlementSwap()` for Bid-Ask groups. Do not create a separate BSC settlement pipeline.
- Account actual close-receipt proceeds before preparing the settlement swap.
- Persist the pending token and amount before attempting a provider swap.
- For ERC-20 settlement, use the local V4 direct quote as the safety benchmark.
- For native BNB input or output, require a safe KyberSwap quote as the benchmark, matching current Robinhood native settlement behavior.
- Request Uniswap Trading API and KyberSwap quotes concurrently.
- Reject any API candidate whose expected output is below the existing local two-percent safety floor.
- Rank executable candidates by expected output while de-prioritizing the last failed provider.
- Constrain provider calldata to the local minimum-output floor before approval or broadcast.
- Preserve the existing approval refresh behavior: normal settlement may refresh and re-rank once, while group settlement refreshes the selected provider quote before build.
- Simulate every provider or local plan through the Alchemy-first execution client before broadcast.
- Persist signed transactions and provider retry state before waiting for a receipt.
- Rotate to the alternate provider after a provider failure and retain local Uniswap V4 as the final fallback.
- Add KyberSwap chain mapping `56: "bsc"` and require the expected Kyber router `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`.
- Add chain 56 to Uniswap Trading API router validation.
- Validate the BSC Trading API Universal Router 2.1.1 target `0x8b844f885672f333bc0042cb669255f93a4c1e6b`.
- For ERC-20 Trading API swaps, continue requiring the SwapProxy target `0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9` and decode its router argument.
- For native Trading API swaps, require the official chain 56 Universal Router 2.1.1 target and exact transaction value.
- Use `0x1906c1d672b88cd1b9ac7593301ca990f94eae07` for the local BSC V4 Universal Router fallback.
- Reject provider calldata with unexpected router, owner, tokens, amount, or chain.
- Reject unexpected integrator fees, permits, recipients, deadlines, or transaction values.
- If Kyber is unavailable, native BNB settlement must fail safely and remain retryable rather than bypassing the benchmark requirement.
- Unwrap WBNB to BNB only after the settlement receipt is confirmed when native quote was selected.
- Do not introduce GMGN into BSC settlement.

## Phase 10: Auto-Exit Rollout Gate

Add a chain-aware auto-exit capability instead of coupling monitoring directly to execution.

Initial production policy:

```text
Monitoring: robinhood,bsc
Automatic exits: robinhood
```

After BSC validation:

```text
Monitoring: robinhood,bsc
Automatic exits: robinhood,bsc
```

The BSC auto-exit gate must cover:

- Stop loss.
- Take profit.
- Trailing take profit.
- Profit out-of-range exits.
- Manual close remains separately controlled and available for validation.

## Files Expected To Change

Likely source files:

- `src/chains.ts`
- `src/config.ts`
- `src/types.ts`
- `src/index.ts`
- `src/abi.ts`
- `src/db.ts`
- `src/services/chain-client.ts`
- `src/services/pool-scanner.ts`
- `src/services/notifier.ts`
- `src/services/discovery.ts`
- `src/services/position-reader.ts`
- `src/services/position-opener.ts`
- `src/services/route-planner.ts`
- `src/services/swap-builder.ts`
- `src/services/executor.ts`
- `src/services/guardian.ts`
- `src/services/pnl.ts`
- `src/services/portfolio.ts`
- `src/services/uniswap-trading-api.ts`
- `src/services/kyberswap-aggregator-api.ts`
- `.env.example`
- `README.md`

Likely tests:

- `test/config.test.ts`
- `test/notifier.test.ts`
- `test/pool-scanner.test.ts`
- `test/chain-client.test.ts`
- `test/discovery.test.ts`
- `test/position-reader.test.ts`
- `test/position-opener.test.ts`
- `test/route-planner.test.ts`
- `test/executor.test.ts`
- `test/guardian.test.ts`
- `test/pnl.test.ts`
- `test/uniswap-trading-api.test.ts`
- `test/kyberswap-aggregator-api.test.ts`
- Existing Pancake discovery tests will be replaced with BSC Uniswap V4 tests.

## Test Matrix

### Registry And Config

- Official chain 56 contract addresses.
- V4-only protocol capability.
- USDT/WBNB/BNB allowlist.
- BNB native metadata.
- Auto-exit chain gate.
- No Pancake registry remains.

### RPC Roles And Secret Handling

- Routine BSC monitoring tries the official public BNB endpoint before Alchemy.
- BSC execution tries Alchemy before the public BNB endpoint.
- BSC `eth_getLogs` uses Alchemy and never falls through to an official public BNB endpoint that disables the method.
- BSC fixed-block historical StateView and balance reads use the Alchemy-first historical/log client.
- Indexed bootstrap calls `alchemy_getAssetTransfers` directly through `ALCHEMY_BSC_HTTP`.
- Public monitoring failure can fail over to Alchemy without changing chain or block consistency.
- Archive failure does not advance the discovery cursor or write a successful bootstrap marker.
- Oversized Alchemy log requests split into smaller ranges and preserve complete ordered results.
- Transient Alchemy errors retry with bounded exponential backoff.
- `BSC_POSITION_MONITOR_INTERVAL_MS=10000` is honored independently of Robinhood and Base intervals.
- The full Alchemy URL and API key never appear in logs, snapshots, test output, source, or `.env.example`.

### `/scan`

- Parse `bsc` and `bnb` aliases.
- Preserve selected dashboard chain.
- Accept only `uniswap-v4-bsc` candidates.
- Reject Pancake and BSC V3 candidates.
- Use BSC DexScreener and Gecko endpoints.
- Verify pool ID on-chain.
- Generate the correct BNB Uniswap URL.

### `/investigate`

- Parse `bsc` and `bnb` aliases.
- Keep bare-input Robinhood compatibility.
- Accept BSC V4 pool IDs and links.
- Reject BSC V3 addresses.
- Use BSC DexScreener and Gecko fallback.
- Verify pool key hash.
- Display BSC label, hook, dynamic fee, current fee, and active liquidity.
- Show actual recent fee distribution when logs are available.
- Warn when only snapshot fee estimation is possible.

### Discovery And Monitoring

- Discover directly minted BSC V4 NFT.
- Discover existing owned BSC V4 NFT through bootstrap.
- Reject non-owned NFT.
- Detect transfer-away.
- Persist and read pool key metadata.
- Value principal and fees at a single block.
- Normalize USDT PnL.
- Price WBNB/BNB.
- Keep unsupported hooks in review.

### Normal Open

- USDT single-side.
- WBNB single-side with zero, partial, and sufficient WBNB balances.
- Native BNB single-side.
- USDT dual-side.
- WBNB/native BNB dual-side.
- Pool ID mismatch rejection.
- Hooked pool rejection.
- Permit2 approvals.
- Native gas reserve.
- Swap failure and mint failure recovery visibility.

### Bid-Ask

- BSC V4 chain acceptance.
- V3 rejection on BSC.
- Both quote orientations.
- USDT, WBNB, and native BNB funding.
- Atomic open and token ID reconciliation.
- Multi-bin close.
- Settlement to USDT.
- WBNB unwrap to BNB.
- Restart recovery for submitted transactions.

### Close And Auto-Exit

- Manual close BSC V4.
- Receipt-accounted principal and fees.
- Local V4 settlement.
- Trading API validation chain 56.
- Mandatory Kyber chain mapping `56: "bsc"` for production BSC settlement.
- Concurrent KyberSwap and Uniswap Trading API quote collection.
- Local two-percent output floor enforcement for both providers.
- Trading API SwapProxy and Universal Router 2.1.1 validation.
- Kyber router and decoded calldata settlement-term validation.
- Provider rotation after failure and local V4 final fallback.
- Native BNB settlement stops safely when no Kyber benchmark is available.
- Normal and Bid-Ask closes use the same settlement functions as Robinhood.
- Retry after provider rejection.
- Monitoring works while auto-exit is disabled.
- SL/TP/trailing invoke Executor only after BSC auto-exit is enabled.

### Regression

- Robinhood V3/V4 monitoring and execution unchanged.
- Base behavior unchanged.
- Robinhood Bid-Ask Ladder unchanged.
- NVDA quote behavior unchanged.
- V3 dual ETH wrapping fix unchanged.
- Existing 302+ tests continue to pass.

## Verification Commands

Run after implementation:

```bash
npm test
npx tsc --noEmit
npm run build
git diff --check
```

Add targeted BSC fork or live read-only checks for:

- Chain ID 56.
- Public BNB RPC current block and current StateView reads.
- Alchemy fixed-block StateView reads.
- Alchemy narrow-range `eth_getLogs` against the official V4 contracts.
- Alchemy indexed `alchemy_getAssetTransfers` pagination.
- Public-read, archive/log, execution, and receipt failover order.
- Bytecode at every official deployment.
- Pool key lookup.
- StateView slot0 and liquidity.
- Quoter output.
- `/scan` result filtering.
- `/investigate` output.
- Single, dual, and Bid-Ask previews without broadcast.

## Rollout Plan

### Stage 1: Scan Only

- Deploy code while production remains `CHAINS=robinhood`.
- Enable `/scan bsc` and `/investigate bsc` through scan clients.
- Use public BNB RPC for current state and Alchemy for historical logs.
- Verify Uniswap V4 results, links, fee flags, and pool-key validation.

### Stage 2: Fork And Dry-Run

- Run BSC fork tests against official contracts.
- Test normal single, dual, Bid-Ask open, close, settlement, and unwrap.
- Exercise Uniswap, KyberSwap, provider rotation, local fallback, and native Kyber benchmark paths without broadcasting production transactions.
- Do not broadcast production transactions.

### Stage 3: Monitoring And Manual Execution

- Change production to `CHAINS=robinhood,bsc`.
- Keep BSC auto-exit disabled.
- Set `BSC_POSITION_MONITOR_INTERVAL_MS=10000`.
- Bootstrap current owned BSC V4 NFTs.
- Confirm public RPC request volume remains below the documented limit and that Alchemy archive quota remains stable.
- Validate PnL and alert units.
- Open a small test position.
- Close it manually.
- Confirm KyberSwap + Uniswap settlement behavior, local fallback safety, and close-history USD values.

### Stage 4: Auto-Exit

- Enable BSC in the auto-exit chain list.
- Monitor discovery, PnL, pending transactions, retries, and settlement for at least 24 hours.
- Keep the ten-second BSC interval unless production metrics explicitly justify reducing it to five seconds.
- Keep a manual rollback procedure for disabling BSC auto-exit without stopping Robinhood.

## Acceptance Criteria

Implementation is complete only when all statements below are true:

- `/scan bsc` returns only verified Uniswap V4 BSC pools.
- `/investigate bsc` verifies and reports the requested V4 pool correctly.
- PancakeSwap BSC is no longer used by registry, scanner, discovery, monitoring, open, or close paths.
- BSC V4 NFTs owned by the executor are discovered and monitored.
- Routine current-state monitoring is public-BNB-first while archive/log access is Alchemy-first.
- Official public BNB endpoints are not used for `eth_getLogs`.
- Alchemy archive failures preserve the last complete cursor and bootstrap state.
- No Alchemy API key or full secret endpoint is committed or logged.
- USDT values are normalized correctly despite 18 decimals.
- WBNB and native BNB are labeled, wrapped, priced, and unwrapped correctly.
- Normal single and dual BSC opens pass simulation and small-value live validation.
- Bid-Ask BSC open/close passes simulation and small-value live validation.
- Manual BSC close uses the Robinhood KyberSwap + Uniswap settlement pipeline, falls back locally when safe, and persists correct quote and USD PnL.
- Native BNB settlement cannot bypass the mandatory Kyber safety benchmark.
- Auto-exit can be independently disabled for BSC.
- Full test suite, typecheck, and build pass.
- Robinhood and Base regressions pass.
- No production auto-exit is enabled before explicit post-dry-run approval.

## Explicit Non-Goals

- BSC Uniswap V3.
- PancakeSwap support.
- BSC `/scanv2`.
- BSC `/scan_pools`.
- BSC `/scan_stocks`.
- BSC `/gem` candidate scanning.
- Arbitrary V4 hook support.
- Zap-in or zap-out.
- Automatic migration of historical Pancake positions.
