import { zeroAddress, type Address } from "viem";

import { chainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type {
  ExitTrigger,
  LiquidationQuote,
  PnlSnapshot,
  PositionGroupPnlSnapshot,
  PositionGroupRecord,
  PositionRangeInfo,
  PositionRecord,
  TrailingStopState,
} from "../types.js";
import type { KyberSwapAggregatorApi } from "./kyberswap-aggregator-api.js";
import type { PositionReader } from "./position-reader.js";
import type { RoutePlanner } from "./route-planner.js";
import type { UniswapTradingApi } from "./uniswap-trading-api.js";
import { quoteRangeState } from "./quote-range.js";
import { normalizeToUsd6 } from "./token-meta.js";
import { applySlippage, sqrtRatioAtTick } from "./uniswap-math.js";

const POSITION_READ_TIMEOUT_MS = 15_000;
const ROUTE_QUOTE_TIMEOUT_MS = 15_000;

export interface ValuedPosition {
  snapshot: PnlSnapshot;
  liquidation: LiquidationQuote;
  twapGuard: { ready: boolean; deviationBps?: bigint };
  range?: PositionRangeInfo;
}

export interface ValuedPositionGroup {
  snapshot: PositionGroupPnlSnapshot;
  liquidation: Pick<LiquidationQuote, "token0Amount" | "token1Amount" | "nonQuoteInput" | "quoteOutput" | "route" | "blockNumber">;
  twapGuard: { ready: boolean; deviationBps?: bigint };
  range?: PositionRangeInfo;
}

export type TrailingStopDecision =
  | { action: "none" }
  | { action: "reset" }
  | { action: "activate" | "raise_peak"; state: TrailingStopState }
  | { action: "trigger"; state: TrailingStopState };

interface ValuationRoute {
  expectedOut: bigint;
  minimumOut: bigint;
  path: Address[];
}

export class PnlService {
  constructor(
    private readonly database: Database,
    private readonly reader: PositionReader,
    private readonly routes: RoutePlanner,
    private readonly config: RuntimeConfig,
    private readonly tradingApi?: UniswapTradingApi,
    private readonly kyberswapApi?: KyberSwapAggregatorApi,
  ) {}

  async value(
    position: PositionRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.maxSwapSlippageBps,
    recordObservations = true,
    localOnly = false,
  ): Promise<ValuedPosition> {
    if (!position.quoteToken) throw new Error("Position has no eligible quote token");
    const quoteToken = position.quoteToken;
    const value = await withTimeout(
      this.reader.read(position, blockNumber),
      POSITION_READ_TIMEOUT_MS,
      "position read",
    );
    if (recordObservations) {
      await this.database.recordPositionObservation(
        position.id,
        value.protocol,
        value.liquidity,
        value.token0.token,
        value.token0.amount,
        value.token1.token,
        value.token1.amount,
        value.observedBlock,
        value.range ? {
          status: value.range.status,
          tickLower: value.range.tickLower,
          tickUpper: value.range.tickUpper,
          currentTick: value.range.currentTick,
          currentSqrtPrice: value.range.currentSqrtPrice,
        } : undefined,
      );
    }
    const quoteIsToken0 = value.token0.token.toLowerCase() === quoteToken.toLowerCase();
    const quoteAmount = quoteIsToken0 ? value.token0.amount : value.token1.amount;
    const nonQuote = quoteIsToken0 ? value.token1 : value.token0;
    const quoteSideFee = quoteIsToken0 ? value.unclaimedFees0 : value.unclaimedFees1;
    const nonQuoteFee = quoteIsToken0 ? value.unclaimedFees1 : value.unclaimedFees0;
    const [route, feeRoute] = await Promise.all([
       this.quoteFresh(position, nonQuote.token, nonQuote.amount, quoteToken, quoteSlippageBps, localOnly),
       this.quoteFresh(position, nonQuote.token, nonQuoteFee, quoteToken, quoteSlippageBps, localOnly),
    ]);
    if (nonQuote.amount > 0n && !route) throw new Error("No safe direct Uniswap route from LP asset to quote token");

    const liquidationQuote = quoteAmount + (route?.expectedOut ?? 0n);
    let feeQuote = quoteSideFee;
    let feeNonQuoteConverted = 0n;
    if (nonQuoteFee > 0n) {
      feeNonQuoteConverted = feeRoute?.expectedOut ?? 0n;
      feeQuote += feeNonQuoteConverted;
    }
    const totals = await this.database.getCashflowTotals(position.id);
    if (totals.deposits === 0n) throw new Error("Position cost basis has not been reconstructed");

    const feeQuoteUsdg = await this.toFeeUsd6(
      position.chainId,
      quoteToken,
      feeQuote,
      (stable, amount) => this.quoteFresh(position, quoteToken, amount, stable, quoteSlippageBps, localOnly),
    );
    const pnlQuote = totals.realized + feeQuote + liquidationQuote - totals.deposits;
    const pnlBps = (pnlQuote * 10_000n) / totals.deposits;
    const twapGuard = recordObservations
      ? await this.recordAndCheckPrice(position, value.poolKey, value.priceMarker, value.observedBlock)
      : { ready: true };

    return {
      snapshot: {
        positionId: position.id,
        quoteToken: position.quoteToken,
        depositsQuote: totals.deposits,
        realizedQuote: totals.realized + feeQuote,
        liquidationQuote,
        pnlQuote,
        pnlBps,
        blockNumber: value.observedBlock,
        liquidity: value.liquidity,
        feeQuote: quoteSideFee,
        feeNonQuote: nonQuoteFee > 0n ? { token: nonQuote.token, amount: nonQuoteFee, converted: feeNonQuoteConverted } : null,
        feeQuoteUsdg,
      },
      liquidation: {
        token0Amount: value.token0.amount,
        token1Amount: value.token1.amount,
        nonQuoteInput: nonQuote.amount > 0n ? nonQuote : null,
        quoteOutput: route?.expectedOut ?? 0n,
        route: route?.path ?? [],
        blockNumber: value.observedBlock,
      },
      twapGuard,
      range: value.range,
    };
  }

  async valueLocal(position: PositionRecord, blockNumber: bigint, quoteSlippageBps = this.config.maxSwapSlippageBps): Promise<ValuedPosition> {
    return this.value(position, blockNumber, quoteSlippageBps, false, true);
  }

  async valueGroup(
    group: PositionGroupRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.maxSwapSlippageBps,
    recordSnapshot = true,
    localOnly = false,
  ): Promise<ValuedPositionGroup> {
    const childRows = (await this.database.listPositionGroupChildren(group.id))
      .filter((child) => child.bin.status === "minted" && child.position !== null);
    const children = childRows.map((child) => child.position!);
    if (children.length === 0) throw new Error("Position group has no active children to value");

    const values = await Promise.all(children.map((position) => this.reader.read(position, blockNumber)));
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]!;
      const bin = childRows[index]!.bin;
      if (value.liquidity <= 0n) throw new Error(`Position group child ${children[index]!.positionKey} has zero liquidity`);
      if (value.poolKey.toLowerCase() !== group.poolKey.toLowerCase()) throw new Error(`Position group child ${children[index]!.positionKey} resolved to a different pool`);
      if (value.token0.token.toLowerCase() !== group.token0.toLowerCase() || value.token1.token.toLowerCase() !== group.token1.toLowerCase()) {
        throw new Error(`Position group child ${children[index]!.positionKey} resolved to a different token pair`);
      }
      if (!value.range || value.range.tickLower !== bin.tickLower || value.range.tickUpper !== bin.tickUpper) {
        throw new Error(`Position group child ${children[index]!.positionKey} ticks differ from bin ${bin.binIndex}`);
      }
    }
    const token0Amount = values.reduce((total, value) => total + value.token0.amount, 0n);
    const token1Amount = values.reduce((total, value) => total + value.token1.amount, 0n);
    const token0Fee = values.reduce((total, value) => total + value.unclaimedFees0, 0n);
    const token1Fee = values.reduce((total, value) => total + value.unclaimedFees1, 0n);
    const quoteIsToken0 = group.quoteToken.toLowerCase() === group.token0.toLowerCase();
    if (!quoteIsToken0 && group.quoteToken.toLowerCase() !== group.token1.toLowerCase()) {
      throw new Error("Position group quote token is not part of the child pair");
    }
    const quoteAmount = quoteIsToken0 ? token0Amount : token1Amount;
    const nonQuote = quoteIsToken0
      ? { token: group.token1, amount: token1Amount }
      : { token: group.token0, amount: token0Amount };
    const quoteFee = quoteIsToken0 ? token0Fee : token1Fee;
    const nonQuoteFee = quoteIsToken0 ? token1Fee : token0Fee;
    const [route, feeRoute] = await Promise.all([
      this.quoteFresh(children[0]!, nonQuote.token, nonQuote.amount, group.quoteToken, quoteSlippageBps, localOnly),
      this.quoteFresh(children[0]!, nonQuote.token, nonQuoteFee, group.quoteToken, quoteSlippageBps, localOnly),
    ]);
    if (nonQuote.amount > 0n && !route) throw new Error("No safe direct Uniswap route from group LP asset to quote token");

    const liquidationQuote = quoteAmount + (route?.expectedOut ?? 0n);
    const feeQuote = quoteFee + (feeRoute?.expectedOut ?? 0n);
    const feeQuoteUsdg = await this.toFeeUsd6(
      group.chainId,
      group.quoteToken,
      feeQuote,
      (stable, amount) => this.quoteFresh(children[0]!, group.quoteToken, amount, stable, quoteSlippageBps, localOnly),
    );
    const totals = await this.database.getPositionGroupCashflowTotals(group.id);
    const deposits = totals.deposits > 0n ? totals.deposits : group.deployedCostQuote;
    if (deposits <= 0n) throw new Error("Position group cost basis has not been reconstructed");
    const realizedQuote = totals.realized + feeQuote;
    const pnlQuote = realizedQuote + liquidationQuote - deposits;
    const pnlBps = (pnlQuote * 10_000n) / deposits;
    const sourceRange = values.find((value) => value.range)?.range;
    const currentTick = sourceRange?.currentTick ?? group.referenceTick ?? 0;
    const currentSqrtPrice = sourceRange?.currentSqrtPrice ?? group.referencePrice ?? 0n;
    const range = groupRange(group, currentTick, currentSqrtPrice);
    const twapGuard = await this.recordAndCheckPrice(children[0]!, group.poolKey, values[0]!.priceMarker, blockNumber);
    const snapshot: PositionGroupPnlSnapshot = {
      groupId: group.id,
      quoteToken: group.quoteToken,
      depositsQuote: deposits,
      realizedQuote,
      liquidationQuote,
      feeQuote,
      feeQuoteUsdg,
      pnlQuote,
      pnlBps,
      blockNumber,
      groupGasQuote: 0n,
      rangeCurrentTick: range.currentTick,
      rangeCurrentSqrtPrice: range.currentSqrtPrice,
    };
    if (recordSnapshot) await this.database.addPositionGroupPnlSnapshot(snapshot);
    return {
      snapshot,
      liquidation: {
        token0Amount,
        token1Amount,
        nonQuoteInput: nonQuote.amount > 0n ? nonQuote : null,
        quoteOutput: route?.expectedOut ?? 0n,
        route: route?.path ?? [],
        blockNumber,
      },
      twapGuard,
      range,
    };
  }

  async valueGroupLocal(
    group: PositionGroupRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.maxSwapSlippageBps,
  ): Promise<ValuedPositionGroup> {
    return this.valueGroup(group, blockNumber, quoteSlippageBps, false, true);
  }

  shouldTrigger(snapshot: PnlSnapshot, range: PositionRangeInfo | undefined, quoteIsToken0: boolean): ExitTrigger | null {
    const stopLossBps = percentToBps(this.config.stopLossPercent);
    const takeProfitBps = percentToBps(this.config.takeProfitPercent);
    if (snapshot.pnlBps <= stopLossBps) return "stop_loss";
    if (snapshot.pnlBps >= takeProfitBps) return "take_profit";
    return null;
  }

  shouldTriggerGroup(snapshot: PositionGroupPnlSnapshot): ExitTrigger | null {
    const stopLossBps = percentToBps(this.config.stopLossPercent);
    const takeProfitBps = percentToBps(this.config.takeProfitPercent);
    if (snapshot.pnlBps <= stopLossBps) return "stop_loss";
    if (snapshot.pnlBps >= takeProfitBps) return "take_profit";
    return null;
  }

  evaluateTrailingStop(metadata: Record<string, unknown>, snapshot: PnlSnapshot): TrailingStopDecision {
    const state = parseTrailingStopState(metadata);
    if (snapshot.pnlBps < 0n) return state ? { action: "reset" } : { action: "none" };

    const activationBps = percentToBps(this.config.trailingStopActivationPercent);
    if (!state) {
      return snapshot.pnlBps >= activationBps
        ? { action: "activate", state: { peakPnlBps: snapshot.pnlBps, activatedAtBlock: snapshot.blockNumber } }
        : { action: "none" };
    }

    if (snapshot.pnlBps > state.peakPnlBps) {
      return { action: "raise_peak", state: { ...state, peakPnlBps: snapshot.pnlBps } };
    }

    const drawdownBps = percentToBps(this.config.trailingStopDrawdownPercent);
    if (snapshot.pnlBps <= state.peakPnlBps - drawdownBps) return { action: "trigger", state };
    return { action: "none" };
  }

  trailingExitEstimateGateBps(metadata: Record<string, unknown>): bigint | null {
    const state = parseTrailingStopState(metadata);
    if (!state) return null;
    const trailingFloor = state.peakPnlBps - percentToBps(this.config.trailingStopDrawdownPercent);
    if (trailingFloor <= 0n) return 0n;
    const bufferBps = BigInt(Math.round(this.config.trailingExitEstimateBufferPercent * 100));
    return (trailingFloor * (10_000n - bufferBps)) / 10_000n;
  }

  trailingFloorBps(metadata: Record<string, unknown>): bigint | null {
    const state = parseTrailingStopState(metadata);
    if (!state) return null;
    return state.peakPnlBps - percentToBps(this.config.trailingStopDrawdownPercent);
  }

  private async quoteFresh(
    position: PositionRecord,
    tokenIn: Address,
    amountIn: bigint,
    tokenOut: Address,
    slippageBps = this.config.maxSwapSlippageBps,
    localOnly = false,
  ): Promise<ValuationRoute | null> {
    if (amountIn === 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
    if (this.tradingApi && !localOnly) {
      try {
        const quote = slippageBps === this.config.maxSwapSlippageBps
          ? await this.tradingApi.quote(position, tokenIn, amountIn, tokenOut)
          : await this.tradingApi.quote(position, tokenIn, amountIn, tokenOut, slippageBps);
        if (quote) {
          return { expectedOut: quote.expectedOut, minimumOut: quote.minimumOut, path: [tokenIn, tokenOut] };
        }
      } catch (error) {
        log.warn({ err: error, positionId: position.id, tokenIn, tokenOut }, "Trading API valuation quote failed; using local quote");
      }
    }

    if (this.kyberswapApi && (tokenIn.toLowerCase() === zeroAddress || tokenOut.toLowerCase() === zeroAddress)) {
      try {
        const quote = await this.kyberswapApi.quote(position, tokenIn, amountIn, tokenOut, slippageBps);
        if (quote) return { expectedOut: quote.expectedOut, minimumOut: quote.minimumOut, path: [tokenIn, tokenOut] };
      } catch (error) {
        log.warn({ err: error, positionId: position.id, tokenIn, tokenOut }, "KyberSwap native valuation quote failed; native route unavailable");
      }
    }

    if (tokenIn.toLowerCase() === zeroAddress || tokenOut.toLowerCase() === zeroAddress) return null;
    const route = await withTimeout(
      this.routes.quoteDirect(position, tokenIn, amountIn, tokenOut),
      ROUTE_QUOTE_TIMEOUT_MS,
      "local route quote",
    );
    return route
      ? { expectedOut: route.expectedOut, minimumOut: applySlippage(route.expectedOut, slippageBps), path: route.path }
      : null;
  }

  private async recordAndCheckPrice(position: PositionRecord, poolKey: string, marker: bigint, blockNumber: bigint): Promise<{ ready: boolean; deviationBps?: bigint }> {
    const previous = await this.database.getPoolObservationAtOrBefore(
      position.chainId,
      position.protocol,
      poolKey,
      this.config.twapWindowSeconds,
    );
    await this.database.recordPoolObservation(position.chainId, position.protocol, poolKey, marker, blockNumber);
    if (!previous || previous.priceMarker === 0n || marker === 0n) return { ready: false };
    const difference = marker > previous.priceMarker ? marker - previous.priceMarker : previous.priceMarker - marker;
    const deviationBps = (difference * 10_000n) / previous.priceMarker;
    return { ready: deviationBps <= BigInt(this.config.maxTwapDeviationBps), deviationBps };
  }

  private async toFeeUsd6(
    chainId: number,
    quoteToken: Address,
    feeQuote: bigint,
    convert: (stable: Address, amount: bigint) => Promise<{ expectedOut: bigint } | null>,
  ): Promise<bigint> {
    const chainName = this.config.chains.find((name) => chainRegistry[name].chain.id === chainId);
    if (!chainName) return feeQuote;
    const stable = this.config.quoteTokens[chainName]?.[0];
    if (!stable) return feeQuote;
    const decimals = stable.symbol.toUpperCase() === "USDT" ? 18 : 6;
    if (quoteToken.toLowerCase() === stable.address.toLowerCase()) {
      return normalizeToUsd6(feeQuote, decimals);
    }
    if (feeQuote <= 0n) return 0n;
    const route = await convert(stable.address, feeQuote);
    return normalizeToUsd6(route?.expectedOut ?? 0n, decimals);
  }
}

function groupRange(group: PositionGroupRecord, currentTick: number, currentSqrtPrice: bigint): PositionRangeInfo {
  if (currentTick >= group.outerTickUpper) {
    const upperSqrt = sqrtRatioAtTick(group.outerTickUpper);
    const denominator = upperSqrt * upperSqrt;
    const aboveDistanceBps = denominator > 0n && currentSqrtPrice > upperSqrt
      ? (currentSqrtPrice * currentSqrtPrice * 10_000n) / denominator - 10_000n
      : 0n;
    return {
      tickLower: group.outerTickLower,
      tickUpper: group.outerTickUpper,
      currentTick,
      currentSqrtPrice,
      status: "above",
      aboveDistanceBps,
    };
  }
  if (currentTick < group.outerTickLower) {
    return { tickLower: group.outerTickLower, tickUpper: group.outerTickUpper, currentTick, currentSqrtPrice, status: "below" };
  }
  return { tickLower: group.outerTickLower, tickUpper: group.outerTickUpper, currentTick, currentSqrtPrice, status: "in_range" };
}

function percentToBps(percent: number): bigint {
  return BigInt(Math.round(percent * 100));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseTrailingStopState(metadata: Record<string, unknown>): TrailingStopState | null {
  const raw = metadata.trailingStop;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  if (typeof state.peakPnlBps !== "string" || typeof state.activatedAtBlock !== "string") return null;
  try {
    const peakPnlBps = BigInt(state.peakPnlBps);
    const activatedAtBlock = BigInt(state.activatedAtBlock);
    return peakPnlBps >= 0n && activatedAtBlock >= 0n ? { peakPnlBps, activatedAtBlock } : null;
  } catch {
    return null;
  }
}

export function isQuoteToken(token: Address, allowlist: readonly { address: Address }[]): boolean {
  return allowlist.some((allowed) => allowed.address.toLowerCase() === token.toLowerCase());
}
