# Bid-Ask Ladder Implementation Plan

**Status:** IN PROGRESS - implementation authorized by the user.

**Last scope decision:** implement only a one-sided Bid-Ask ladder. Spot and Curve are out of scope. Dual-side funding is out of scope.

## 1. Scope

The first release supports:

- One-sided Bid-Ask ladders only.
- Uniswap V3 and plain Uniswap V4.
- Base and Robinhood Chain.
- Atomic mint of every bin in one transaction.
- Atomic close of every minted child NFT in one transaction.
- Separate approval and wrapping transactions when required.
- Separate post-close settlement swap or WETH unwrap when required.
- Existing normal single-position opening behavior unchanged.

The first release does not support:

- Spot shape.
- Curve shape.
- Dual-side funding.
- An opening swap.
- Sequential mint or close fallback.
- BSC execution.
- V4 hooked pools. Plain/no-hook V4 pools only.
- Fee-on-transfer or rebasing tokens.
- Automatic backfill of existing NFTs into a ladder.

If an atomic batch does not fit the configured gas feasibility checks, the open is rejected. It must not silently fall back to sequential transactions.

## 2. User Flow

The notifier flow is:

```text
Open
-> Normal Position | Bid-Ask Ladder
-> V3/V4 pool
-> one-sided range
-> requested bin count
-> quote amount
-> atomic review
-> confirm
```

The review must show:

- Pool, pair, protocol, fee tier, and V4 pool key where applicable.
- Current price and outer range.
- Requested, generated, skipped, and mintable bin counts.
- Per-bin ticks and token allocation.
- Atomic open transaction estimate.
- Projected atomic close feasibility.
- Approval or wrap preparation transactions separately.
- The statement that one failed batch reverts every NFT in that batch.

The dashboard renders one logical parent ladder. Its child NFT token IDs and ranges are available in an expanded detail view. Manual close always targets the parent ladder.

## 3. One-Sided Bid-Ask Semantics

This is not a classic two-sided bid-and-ask range. Since the first release is single-side only, the entire range must be on one side of the current price and only one token is deposited.

For a range above the current price, the bin nearest the current price is the anchor and allocation increases toward the higher, farther edge.

For a range below the current price, the bin nearest the current price is the anchor and allocation increases toward the lower, farther edge.

The user supplies one token. No token swap is performed during opening.

## 4. Bid-Ask Planner

Create a pure planner at:

```text
src/services/bid-ask-planner.ts
```

The planner should expose pure functions for:

- Validating the one-sided range.
- Snapping ticks to tick spacing.
- Generating bin geometry.
- Calculating Bid-Ask weights.
- Allocating the single deposited token using bigint arithmetic.
- Producing a deterministic plan hash.

Suggested types:

```ts
type BidAskShapeVersion = "delta-amount-linear-v1" | "delta-amount-linear-v2" | "delta-amount-linear-v3";

type BidAskBinSide = "token0" | "token1";

interface BidAskBinGeometry {
  index: number;
  tickLower: number;
  tickUpper: number;
  side: BidAskBinSide;
  anchorIndex: number;
  distance: number;
  weightMicros: number;
}

interface BidAskAllocatedBin extends BidAskBinGeometry {
  allocatedAmount0: bigint;
  allocatedAmount1: bigint;
  expectedLiquidity: bigint;
  expectedAmount0: bigint;
  expectedAmount1: bigint;
}

interface BidAskPlan {
  shapeVersion: BidAskShapeVersion;
  currentTick: number;
  tickSpacing: number;
  requestedBinCount: number;
  generatedBinCount: number;
  mintableBinCount: number;
  outerTickLower: number;
  outerTickUpper: number;
  anchorIndex: number;
  totalAmount0: bigint;
  totalAmount1: bigint;
  bins: BidAskAllocatedBin[];
}
```

### Geometry

1. Require a positive integer tick spacing.
2. Require `rawTickLower < rawTickUpper`.
3. Require the range to be one-sided for the selected quote token.
4. Snap the requested bounds to the nearest valid spacing using the existing project convention.
5. Reject if snapping collapses or reverses the range.
6. Calculate:

```text
p = (snappedUpper - snappedLower) / tickSpacing
m = min(requestedBinCount, p)
```

7. Generate each bin using the exact Delta boundary rule:

```text
binLower(i) = lower + floor(p * i / m) * spacing
binUpper(i) = lower + floor(p * (i + 1) / m) * spacing
```

Bin widths may differ by one tick spacing. Do not expand the range just to make widths equal.

### Anchor and weights

For a one-sided range, the anchor is the bin adjacent to the current price:

- Current price below the range: anchor is the first bin.
- Current price above the range: anchor is the last bin.

For new ladders with up to ten generated bins, v3 uses:

```text
d = abs(binIndex - anchorIndex)
S = sum(d * (d + 2)) for every bin
k = (1_000_000 - 100_000 * binCount) / S
weightMicros = 100_000 + k * d * (d + 2)
```

The anchor is always exactly 10%, and the weight increases toward the
farthest edge. Integer rounding is deterministic; the farthest bin receives
the final remainder so the weight sum is exactly 1,000,000.

For more than ten generated bins, v3 falls back to the persisted v2 Delta
formula because a monotonic distribution with a fixed 10% anchor cannot sum
to 100% once there are more than ten bins.

```text
3 bins: 10% | 29.09% | 60.91%
4 bins: 10% | 16.92% | 28.46% | 44.62%
5 bins: 10% | 13% | 18% | 25% | 34%
```

Persist `weightMicros`. Do not normalize it to a different version and do not reinterpret it as a direct liquidity multiplier. Existing v1 and v2 plans keep their stored weights and remain executable.

### Amount allocation

Because the ladder is one-sided, only one of `totalAmount0` or `totalAmount1` is nonzero.

Allocate the selected token independently across all eligible bins:

```text
allocation(i) = total * weightMicros(i) / sum(weightMicros)
```

Use bigint integer division for every bin except the final eligible bin. The final eligible bin receives the exact remainder. Assert:

```text
sum(allocated amounts) == total deposit
```

Do not use JavaScript `Number` for token amounts. Do not move dust to a different bin after the plan is confirmed.

Reject the plan if any generated bin has zero allocation or produces zero SDK liquidity. Do not silently reduce the requested NFT count.

## 5. Parent and Child Model

Each minted NFT remains a normal child `PositionRecord`. The ladder is represented by a durable parent group.

Parent statuses:

```text
planned
preparing
opening
active
closing
settling
settled
needs_review
cancelled
```

Child bin statuses:

```text
planned
minted
closed
skipped
needs_review
```

Child metadata includes:

```json
{
  "positionGroupId": "...",
  "managedBy": "position_group",
  "strategy": "bid_ask",
  "shapeVersion": "delta-amount-linear-v1",
  "autoExitDisabled": true
}
```

The parent is authoritative for:

- Atomic open and close transactions.
- Group execution attempts and leases.
- Aggregate cashflows.
- Cost basis.
- Aggregate PnL.
- Guardian triggers.
- Settlement.
- Close history.

Children are not independently eligible for automatic close, settlement, or history creation.

## 6. Persistence

Add additive tables in `src/db.ts` through the existing inline migration mechanism:

### `position_groups`

Required fields include:

- `id`.
- `chain_id`, `protocol`, `position_manager`, and `pool_key`.
- `owner`, `token0`, `token1`, `quote_token`.
- `shape = 'bid_ask'`.
- `shape_version = 'delta-amount-linear-v1'`.
- `requested_bin_count`.
- `generated_bin_count`.
- `mintable_bin_count`.
- `outer_tick_lower`, `outer_tick_upper`, `anchor_bin_index`.
- `total_deposit`, `deployed_cost_quote`.
- `direct_close_amount0`, `direct_close_amount1`.
- `total_received_quote`.
- `status`.
- `plan_hash`, immutable plan JSON, and reference block/tick/price.
- `open_transaction_hash`, `close_transaction_hash`.
- `pending_raw_transaction`.
- Execution lease token and expiry.
- Final PnL fields and settlement timestamp.
- Metadata and timestamps.

The status check must contain exactly the parent statuses listed above.

### `position_group_bins`

Required fields include:

- `group_id`.
- `bin_index`.
- `tick_lower`, `tick_upper`.
- `side`.
- `weight_micros`.
- `allocated_amount0`, `allocated_amount1`.
- `expected_liquidity`, `expected_amount0`, `expected_amount1`.
- `token_id`, nullable before the open receipt is reconciled.
- `position_id`, nullable before the child row is linked.
- `opening_amount0`, `opening_amount1`.
- `close_amount0`, `close_amount1`.
- `settlement_quote`.
- `status` and optional `drop_reason`.
- Open and close transaction hashes.
- Metadata and timestamps.

Constraints:

```text
UNIQUE(group_id, bin_index)
UNIQUE(chain_id, position_manager, token_id) where token_id is not null
UNIQUE(position_id) where position_id is not null
```

Persist skipped/generated bins for auditability. Only mintable bins are encoded into the atomic batch.

### `position_group_execution_attempts`

Stages include:

```text
approve_quote
wrap_quote
approve_permit2
permit2_approve
open_batch
close_batch
settlement_swap
unwrap_quote
```

Each attempt stores the signed raw transaction, nonce, hash, status, error, and timestamps. `open_batch` and `close_batch` carry the all-or-nothing NFT invariant.

### `position_group_cashflows`

Use a parent-level cashflow table rather than writing the same aggregate receipt to every child. Store:

- One aggregate open debit.
- One aggregate close receipt.
- One aggregate settlement swap result when applicable.
- One aggregate unwrap result when applicable.
- Transaction hashes and raw token totals.
- Per-bin attribution details for audit only.

Child rows may retain informational allocation data, but the parent table is the accounting authority.

### `position_group_pnl_snapshots`

Store one snapshot per parent/block containing:

- Aggregate deposits.
- Aggregate realized proceeds.
- Aggregate liquidation quote.
- Aggregate fees.
- PnL quote and PnL bps.
- Block number.
- Group gas, counted once when enabled.

## 7. Atomic V3 Open

Add atomic plan construction to `src/services/position-opener.ts` or a dedicated `src/services/v3-bid-ask.ts` module.

Preparation:

- ERC-20 quote: approve the V3 Position Manager.
- ETH display funding: wrap to canonical WETH and approve.
- Persist every preparation stage and recover it independently.

For every allocated bin:

1. Construct a V3 SDK position from the exact allocated amount.
2. Reject zero liquidity.
3. Calculate expected mint amounts.
4. Set the non-quote desired amount to zero.
5. Set a nonzero configured minimum for the quote side, or the exact expected one-sided spend where the boundary invariant makes it deterministic.
6. Encode one direct `mint` call.

Build one outer Position Manager call:

```text
multicall([
  mint(bin0),
  mint(bin1),
  ...,
  mint(binN)
])
```

All mints use the same recipient and deadline. Any subcall revert rolls back every NFT mint.

Do not compose native SDK outputs that append `refundETH()` after each mint. If native execution is supported directly, append only one final refund. The simpler first implementation may wrap ETH in a separate preparation stage and use WETH for the atomic batch.

## 8. Atomic V4 Open

Add atomic plan construction to `src/services/position-opener.ts` or a dedicated `src/services/v4-bid-ask.ts` module.

Preparation:

- ERC-20/WETH quote: approve Permit2 and approve the Position Manager through Permit2.
- Native ETH quote: no token approval.
- Reject nonzero-hook pools for this release.

For each bin:

1. Construct a V4 position candidate.
2. Binary-search the greatest liquidity whose slippage-adjusted max quote amount remains within the bin allocation.
3. Require the non-quote max to be zero.
4. Add one `MINT_POSITION` action.

After all mints:

```text
SETTLE_PAIR(currency0, currency1)
```

For native ETH funding, append one aggregate native sweep and set transaction `value` to the aggregate checked native max. Do not create one nested `modifyLiquidities` call per bin.

The final transaction contains one `modifyLiquidities` selector with N mint actions and one settlement action. Any action failure reverts all NFT mints.

## 9. Open Guards and Recovery

Before signing:

1. Refresh pool state at a recent block.
2. Verify factory/manager pool identity.
3. Verify every bin remains one-sided.
4. Verify all ticks are aligned, ordered, non-overlapping, and valid.
5. Verify token decimals explicitly; never silently default execution amounts to 18 decimals.
6. Apply the configured spot/TWAP deviation guard.
7. Simulate the complete batch.
8. Estimate atomic open gas.
9. Project atomic close gas and reject if it cannot fit.
10. Generate the deadline after approval/wrap preparation completes.
11. Persist the immutable plan and signed raw transaction before broadcast.
12. Use the same account-level execution lock as the existing Executor.

Recovery:

- Pending receipt: rebroadcast the identical signed transaction, never construct a replacement with new calldata.
- Reverted open: clear pending state; no NFT exists; retry only within the configured retry policy.
- Successful open: reconcile the full expected NFT/event set before setting the parent active.
- Successful but ambiguous open: set `needs_review`; never mint again automatically.
- Disabled feature flag: block new groups only. Existing group recovery and close processing continue.

## 10. NFT Receipt Correlation

### V3

Require, for every expected bin:

- One Position Manager ERC-721 mint transfer to the group owner.
- One matching `IncreaseLiquidity(tokenId)` event.
- `ownerOf(tokenId)` equals the owner.
- `positions(tokenId)` matches the expected token pair, fee, tick pair, and positive liquidity.

Map token IDs to bins using authoritative position ticks and exact set matching. Do not rely on predicted or contiguous token IDs.

### V4

Replace the current first-log behavior in `src/services/discovery.ts`.

For every minted token ID:

```text
salt = leftPad32(uint256(tokenId))
```

Match exactly one Pool Manager `ModifyLiquidity` event with:

- Expected pool ID.
- Sender equal to the V4 Position Manager.
- The derived token-ID salt.
- Expected tick pair.
- Positive liquidity delta.

Then verify `ownerOf`, `getPoolAndPositionInfo`, and `getPositionLiquidity`.

Require exact set equality between planned bins and verified receipt bins. A known group batch bypasses the generic `batched_v4_modification` rejection, but unknown or mixed batches remain `needs_review`.

## 11. Group Valuation and PnL

Add group-aware reading in `src/services/position-reader.ts` and group valuation in `src/services/pnl.ts`.

At one common block:

1. Read every child position.
2. Sum token0 principal and fees.
3. Sum token1 principal and fees.
4. Quote aggregate non-quote amount once.
5. Compare to parent deployed cost basis.
6. Compute one parent PnL snapshot.

Do not:

- Sum raw liquidity across ranges.
- Average child PnL percentages.
- Create a synthetic single range for the parent.
- Write child snapshots as independent accounting snapshots.

The parent outer range is used only for display and OOR evaluation. Child ranges remain available for detail and close minimum calculations.

## 12. Guardian and OOR Rules

Child positions are valued for detail but cannot independently trigger:

- Stop loss.
- Take profit.
- Trailing exit.
- OOR close.
- Zero-liquidity settlement.

The parent owns the single risk decision and produces one group close request.

Existing OOR behavior is preserved. It is not changed to “close because the position starts out of range.”

The parent uses the quote-oriented outer range and existing configuration:

```text
OOR_ABOVE_MIN_DISTANCE_PERCENT=10
OOR_ABOVE_MIN_DURATION_MS=3600000
PROFIT_OOR_ABOVE_THRESHOLD_PERCENT=3
OOR_ABOVE_PROFIT_DURATION_MS=300000
```

Hard OOR trigger:

```text
quote price is above the outer upper boundary by at least 10%
and remains there for at least 1 hour
```

Profit OOR trigger:

```text
quote price is above the outer boundary
and PnL is at least 3%
and the condition remains for at least 5 minutes
```

The existing timer reset behavior remains unchanged when the condition is no longer active.

## 13. Atomic V3 Close

Before signing:

- Load every active child at one coherent block.
- Verify ownership, pool, pair, fee, ticks, and positive liquidity.
- Calculate per-child minimum amounts using configured remove-liquidity slippage.
- Simulate the complete close batch.
- Persist one signed parent execution.

Build one Position Manager multicall:

```text
decreaseLiquidity(bin0)
collect(bin0)
burn(bin0)
decreaseLiquidity(bin1)
collect(bin1)
burn(bin1)
...
```

Use one common recipient. Do not call the existing single-position receipt accounting once per child.

If one child minimum fails, the entire close reverts and all NFTs remain active.

## 14. Atomic V4 Close

Before signing, verify every child as with V3.

Build one V4 `modifyLiquidities` call:

```text
BURN_POSITION(bin0)
BURN_POSITION(bin1)
...
BURN_POSITION(binN)
TAKE_PAIR(currency0, currency1, owner)
```

Use SDK-derived per-child minimum principal outputs. One failing child reverts all burns and the final take.

Require the successful receipt to prove:

- Every expected NFT was burned.
- Every expected token-ID salt had a matching negative liquidity delta.
- No expected child remains owned or liquid.

## 15. Close Settlement and Accounting

Atomic close only covers removal of all NFTs. Settlement may remain separate:

```text
atomic close all NFTs
-> one aggregate non-quote-to-quote swap if needed
-> one WETH unwrap if needed
-> parent settlement
```

Receipt accounting happens once at parent level. Never copy the aggregate amount to every child.

Store one parent close cashflow with:

- Aggregate token0 output.
- Aggregate token1 output.
- Close hash.
- Gas.
- Per-bin diagnostic attribution if available.

If settlement fails after close:

- Parent remains `settling`.
- The close transaction is not repeated.
- Only settlement is retried.

If a close receipt is confirmed but parsing fails, recover from the durable transaction hash. Never submit a second burn batch automatically.

## 16. External Integrity Changes

Before valuation and before close, verify every child:

- Owner is unchanged.
- Pool and ticks are unchanged.
- Liquidity matches the known group state.
- NFT still exists.

If one child is transferred, burned, increased, or decreased externally:

```text
parent -> needs_review
automatic group close -> disabled
```

Do not close only the remaining children. That would violate the atomic group invariant.

An external all-child atomic close may be adopted only if the receipt proves the complete expected token-ID set. Otherwise remain in review.

## 17. Gas Feasibility

The Delta frontend has no hard 32/40 protocol limit. Atomic execution has a practical limit.

Add a configurable operational ceiling and a dynamic gas check:

```text
BIDASK_LADDER_MAX_BINS=16
BIDASK_LADDER_ATOMIC_MAX_BLOCK_GAS_BPS=8000
```

Before open:

- Estimate complete atomic open gas.
- Project complete atomic close gas using the number of mintable bins.
- Require both to remain below the configured percentage of the latest block gas limit.
- Reject with `atomic_batch_infeasible` when either check fails.

The initial canary limit is 4 bins. Raise only after fork tests and production gas observations are stable.

## 18. Configuration

Add:

```text
BIDASK_LADDER_ENABLED=false
BIDASK_LADDER_PROTOCOLS=v3,v4
BIDASK_LADDER_MAX_BINS=16
BIDASK_LADDER_MAX_PRICE_DEVIATION_BPS=100
BIDASK_LADDER_ATOMIC_MAX_BLOCK_GAS_BPS=8000
BIDASK_LADDER_TRANSACTION_DEADLINE_SECONDS=300
BIDASK_LADDER_MAX_RETRIES=3
```

The existing remove-liquidity slippage settings are reused for close. Existing normal-position configuration remains unchanged.

## 19. Required Code Areas

Expected implementation areas:

- `src/types.ts`: group, bin, plan, and parent PnL types.
- `src/db.ts`: additive group tables, leases, execution records, receipt application, parent history queries.
- `src/services/bid-ask-planner.ts`: exact Delta geometry and amount allocation.
- `src/services/position-opener.ts`: single-side validation, atomic V3/V4 open plans, durable open execution.
- `src/services/discovery.ts`: V3/V4 atomic receipt correlation and group linking.
- `src/services/position-reader.ts`: group read and per-child close data.
- `src/services/pnl.ts`: aggregate group valuation.
- `src/services/guardian.ts`: parent-only risk decisions and existing OOR rules over the outer range.
- `src/services/executor.ts`: atomic V3/V4 close plans and parent-level receipt accounting.
- `src/services/notifier.ts`: Bid-Ask-only UI, parent display, atomic review and close.
- `src/services/portfolio.ts`: prevent child duplication while preserving aggregate value.
- `src/services/index.ts` or `src/index.ts`: wire group service, recovery, and shared execution lock.
- `src/config.ts`: feature flag, protocol, gas, deadline, deviation, and retry settings.
- `.env.example`: new defaults.

Implementation was authorized by the user with an explicit `GO` instruction.

## 20. Tests

### Planner

Add `test/bid-ask-planner.test.ts` covering:

- One-sided range validation for both token orientations.
- Negative tick snapping.
- Exact Delta bin boundaries.
- Requested count greater than available spacing slots.
- Requested count above 40 not being silently truncated by the algorithm.
- Exact Bid-Ask weights.
- Anchor at the correct edge for ranges above and below price.
- Exact bigint allocation and final remainder.
- Zero allocation and zero liquidity rejection.
- Deterministic plan hash.

### Atomic open

Extend `test/position-opener.test.ts` with:

- V3 outer multicall containing exactly N mint calls.
- V4 one `modifyLiquidities` call with N mint actions and one settlement action.
- Correct one-sided amounts and zero non-quote maxima.
- Native ETH aggregate value and one final refund.
- No nested per-bin native refunds.
- Slippage, deadline, and price guard checks.
- Atomic gas feasibility rejection without sequential fallback.

### Receipt and discovery

Extend `test/discovery.test.ts` with:

- Multiple V3 NFTs linked by token-specific events and ticks.
- Multiple V4 NFTs linked by token-ID salts.
- Interleaved V4 logs.
- Wrong first log not being reused.
- Missing, duplicate, extra, or mismatched events causing `needs_review`.
- Replaying a receipt being idempotent.
- Native opening not depending on ERC-20 transfer logs.

### Atomic close and accounting

Extend `test/executor.test.ts` and add `test/position-group.test.ts` with:

- V3 decrease/collect/burn sequence for every child in one multicall.
- V4 N burns and one `TAKE_PAIR`.
- Any child minimum failure reverting the complete simulation.
- Aggregate close receipt counted once.
- Parent cashflows and PnL not duplicated across children.
- Settlement retry without another NFT close.
- Group gas counted once.
- Parent status transitions and lease ownership.

### Guardian and UI

Extend `test/guardian.test.ts` and `test/notifier.test.ts` with:

- Children never independently trigger exits.
- One parent trigger produces one atomic close.
- Existing 10% OOR distance and duration behavior.
- Existing profit OOR threshold and duration behavior.
- External child alteration moves the group to review.
- One parent shown instead of duplicate child rows.
- Bid-Ask-only UI and no dual funding option.
- Atomic gas infeasibility shown without sequential fallback.

### Fork gates

For both V3 and V4 on Base and Robinhood:

1. Atomic multi-bin open succeeds.
2. The final mint action is forced to fail and zero NFTs remain.
3. Atomic multi-bin close succeeds.
4. The final burn action is forced to fail and every NFT remains.
5. Process termination after broadcast is recovered idempotently.
6. V4 native ETH batch value and refund are correct.
7. V4 multi-log salt correlation is correct.
8. Post-close settlement retries without repeating the close.

## 21. Rollout

1. Deploy additive schema and read paths with `BIDASK_LADDER_ENABLED=false`.
2. Deploy durable group recovery before enabling creation.
3. Run canary opens with a maximum of 4 bins.
4. Verify atomic open and close on both protocols and chains.
5. Enable the feature for one operator.
6. Raise the operational ceiling only after gas and recovery metrics are stable.
7. If rollback is needed, disable new creation only. Existing groups must continue recovery and close processing.

## 22. Verification Commands

After implementation and only after the user authorizes it:

```bash
npm test
npm run check
npm run build
```
