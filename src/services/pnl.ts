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
  TrailingStopSource,
  TrailingStopState,
  ValuationQuoteProvider,
} from "../types.js";
import type { KyberSwapAggregatorApi } from "./kyberswap-aggregator-api.js";
import type { PositionReader, PositionValue } from "./position-reader.js";
import type { RoutePlanner } from "./route-planner.js";
import type { UniswapTradingApi } from "./uniswap-trading-api.js";
import { quoteRangeState } from "./quote-range.js";
import { normalizeToUsd6 } from "./token-meta.js";
import { applySlippage, isUsableSqrtPrice, quoteValueAtPriceMarker, quoteValueAtSqrtPrice, sqrtRatioAtTick } from "./uniswap-math.js";

const POSITION_READ_TIMEOUT_MS = 15_000;
const ROUTE_QUOTE_TIMEOUT_MS = 15_000;
const MIN_TWAP_OBSERVATIONS = 3;
const GROUP_CONTEXT_CACHE_SIZE = 64;

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
  provider: ValuationQuoteProvider;
}

type GroupQuoteMode = "direct_pool" | "exact_local" | "exact_probe";

interface QuoteCache {
  quotes: Map<string, Promise<ValuationRoute | null>>;
}

interface PositionValuationContext extends QuoteCache {
  position: PositionRecord;
  value: PositionValue;
  totals: { deposits: bigint; realized: bigint };
}

interface GroupValuationContext extends QuoteCache {
  children: PositionRecord[];
  values: PositionValue[];
  token0Amount: bigint;
  token1Amount: bigint;
  token0Fee: bigint;
  token1Fee: bigint;
  depositsQuote: bigint;
  realizedQuote: bigint;
}

export class PnlService {
  private readonly groupContexts = new Map<string, Promise<GroupValuationContext>>();
  private readonly positionContexts = new Map<string, Promise<PositionValuationContext>>();

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
    return this.valueWithMode(
      position,
      blockNumber,
      quoteSlippageBps,
      recordObservations,
      localOnly ? "exact_local" : "direct_pool",
      false,
    );
  }

  async valueLocal(position: PositionRecord, blockNumber: bigint, quoteSlippageBps = this.config.maxSwapSlippageBps): Promise<ValuedPosition> {
    return this.valueWithMode(position, blockNumber, quoteSlippageBps, false, "exact_local", false);
  }

  async valueExactProbe(
    position: PositionRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.maxSwapSlippageBps,
    opts?: { budget?: boolean },
  ): Promise<ValuedPosition> {
    return this.valueWithMode(position, blockNumber, quoteSlippageBps, false, "exact_probe", false, opts?.budget !== false);
  }

  async valueExitEstimate(position: PositionRecord, blockNumber: bigint, quoteSlippageBps = this.config.settlementSwapSlippageBps): Promise<ValuedPosition> {
    return this.valueWithMode(position, blockNumber, quoteSlippageBps, false, "exact_probe", true);
  }

  private async valueWithMode(
    position: PositionRecord,
    blockNumber: bigint,
    quoteSlippageBps: number,
    recordObservations: boolean,
    quoteMode: GroupQuoteMode,
    conservative: boolean,
    budgeted = true,
  ): Promise<ValuedPosition> {
    if (!position.quoteToken) throw new Error("Position has no eligible quote token");
    const quoteToken = position.quoteToken;
    const context = await this.positionValuationContext(position, blockNumber);
    const value = context.value;
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
    const localOnly = quoteMode === "exact_local";
    const totalNonQuote = nonQuote.amount + nonQuoteFee;
    const useMark = quoteMode === "direct_pool" || quoteMode === "exact_local";
    const route = useMark
      ? null
      : await this.quoteInContext(context, position, value.observedBlock, nonQuote.token, totalNonQuote, quoteToken, quoteSlippageBps, quoteMode, budgeted);
    if (!useMark && nonQuote.amount > 0n && !route) throw new Error("No safe direct Uniswap route from LP asset to quote token");

    const marked = useMark
      ? allocateSpotMark(spotMarkTotal(value, quoteIsToken0), quoteAmount, quoteSideFee, nonQuote.amount, nonQuoteFee)
      : allocateRouteOutput(route ? (conservative ? route.minimumOut : route.expectedOut) : 0n, quoteAmount, quoteSideFee, nonQuote.amount, nonQuoteFee);
    const { liquidationQuote, feeQuote, feeNonQuoteConverted, routeOutput } = marked;
    const totals = context.totals;
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

    const snapshot: PnlSnapshot = {
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
      quoteProvider: useMark ? undefined : route?.provider,
      minimumPnlBps: quoteMode === "exact_probe" ? this.exactMinimumPnlBps(totals.deposits, totals.realized, quoteAmount, quoteSideFee, nonQuoteFee, totalNonQuote, route) : undefined,
      minimumLiquidationQuote: quoteMode === "exact_probe" ? this.exactMinimumLiquidation(quoteAmount, nonQuoteFee, totalNonQuote, route) : undefined,
    };
    if (quoteMode === "exact_probe" && !conservative && route?.provider && route.provider !== "source_pool") {
      await this.persistExactQuote({
        positionId: position.id,
        quoteToken,
        depositsQuote: totals.deposits,
        realizedQuote: snapshot.realizedQuote,
        liquidationQuote,
        minimumLiquidationQuote: snapshot.minimumLiquidationQuote ?? liquidationQuote,
        pnlQuote,
        pnlBps,
        minimumPnlBps: snapshot.minimumPnlBps ?? pnlBps,
        provider: route?.provider ?? "source_pool",
        blockNumber: value.observedBlock,
        quotedAt: new Date(),
      });
    }
    return {
      snapshot,
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

  async valueGroup(
    group: PositionGroupRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.maxSwapSlippageBps,
    recordSnapshot = true,
    localOnly = false,
    conservative = false,
  ): Promise<ValuedPositionGroup> {
    const quoteMode: GroupQuoteMode = localOnly ? "exact_local" : "direct_pool";
    return this.valueGroupWithMode(group, blockNumber, quoteSlippageBps, recordSnapshot, conservative, quoteMode);
  }

  async valueGroupExactProbe(
    group: PositionGroupRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.maxSwapSlippageBps,
    opts?: { budget?: boolean },
  ): Promise<ValuedPositionGroup> {
    return this.valueGroupWithMode(group, blockNumber, quoteSlippageBps, false, false, "exact_probe", opts?.budget !== false);
  }

  private async valueGroupWithMode(
    group: PositionGroupRecord,
    blockNumber: bigint,
    quoteSlippageBps: number,
    recordSnapshot: boolean,
    conservative: boolean,
    quoteMode: GroupQuoteMode,
    budgeted = true,
  ): Promise<ValuedPositionGroup> {
    const context = await this.groupValuationContext(group, blockNumber);
    const { children, values, token0Amount, token1Amount, token0Fee, token1Fee } = context;
    const localOnly = quoteMode === "exact_local";
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
    const totalNonQuote = nonQuote.amount + nonQuoteFee;
    const useMark = quoteMode === "direct_pool" || quoteMode === "exact_local";
    const route = useMark
      ? null
      : await this.quoteInContext(context, context.children[0]!, context.values[0]!.observedBlock, nonQuote.token, totalNonQuote, group.quoteToken, quoteSlippageBps, quoteMode, budgeted);
    if (!useMark && totalNonQuote > 0n && !route) throw new Error("No safe direct Uniswap route from group LP asset to quote token");

    const marked = useMark
      ? allocateSpotMark(groupSpotMarkTotal(values, token0Amount, token1Amount, token0Fee, token1Fee, quoteIsToken0), quoteAmount, quoteFee, nonQuote.amount, nonQuoteFee)
      : allocateRouteOutput(route ? (conservative ? route.minimumOut : route.expectedOut) : 0n, quoteAmount, quoteFee, nonQuote.amount, nonQuoteFee);
    const { liquidationQuote, feeQuote, feeNonQuoteConverted: feeRouteOutput, routeOutput } = marked;
    const feeQuoteUsdg = await this.toFeeUsd6(
      group.chainId,
      group.quoteToken,
      feeQuote,
      (stable, amount) => this.quoteFresh(children[0]!, group.quoteToken, amount, stable, quoteSlippageBps, localOnly),
    );
    const deposits = context.depositsQuote;
    if (deposits <= 0n) throw new Error("Position group cost basis has not been reconstructed");
    const realizedQuote = context.realizedQuote + feeQuote;
    const pnlQuote = realizedQuote + liquidationQuote - deposits;
    const pnlBps = (pnlQuote * 10_000n) / deposits;
    const sourceRange = values.find((value) => value.range)?.range;
    const currentTick = sourceRange?.currentTick ?? group.referenceTick ?? 0;
    const currentSqrtPrice = sourceRange?.currentSqrtPrice ?? group.referencePrice ?? 0n;
    const range = groupRange(group, currentTick, currentSqrtPrice);
    const twapGuard = recordSnapshot
      ? await this.recordAndCheckPrice(children[0]!, group.poolKey, values[0]!.priceMarker, blockNumber)
      : { ready: true };
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
      quoteProvider: useMark ? undefined : route?.provider,
      minimumPnlBps: quoteMode === "exact_probe" ? this.exactMinimumPnlBps(deposits, context.realizedQuote, quoteAmount, quoteFee, nonQuoteFee, totalNonQuote, route) : undefined,
      minimumLiquidationQuote: quoteMode === "exact_probe" ? this.exactMinimumLiquidation(quoteAmount, nonQuoteFee, totalNonQuote, route) : undefined,
    };
    if (recordSnapshot) await this.database.addPositionGroupPnlSnapshot(snapshot);
    if (quoteMode === "exact_probe" && !conservative && route?.provider && route.provider !== "source_pool") {
      await this.persistGroupExactQuote({
        groupId: group.id,
        quoteToken: group.quoteToken,
        depositsQuote: deposits,
        realizedQuote,
        liquidationQuote,
        minimumLiquidationQuote: snapshot.minimumLiquidationQuote ?? liquidationQuote,
        pnlQuote,
        pnlBps,
        minimumPnlBps: snapshot.minimumPnlBps ?? pnlBps,
        provider: route?.provider ?? "source_pool",
        blockNumber,
        quotedAt: new Date(),
      });
    }
    return {
      snapshot,
      liquidation: {
        token0Amount,
        token1Amount,
        nonQuoteInput: nonQuote.amount > 0n ? nonQuote : null,
        quoteOutput: routeOutput,
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

  async valueGroupExitEstimate(
    group: PositionGroupRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.settlementSwapSlippageBps,
  ): Promise<ValuedPositionGroup> {
    return this.valueGroupWithMode(group, blockNumber, quoteSlippageBps, false, true, "exact_probe");
  }

  async valueGroupLocalExitEstimate(
    group: PositionGroupRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.settlementSwapSlippageBps,
  ): Promise<ValuedPositionGroup> {
    return this.valueGroupWithMode(group, blockNumber, quoteSlippageBps, false, true, "exact_local");
  }

  private groupValuationContext(group: PositionGroupRecord, blockNumber: bigint): Promise<GroupValuationContext> {
    const key = `${group.id}:${blockNumber}`;
    const existing = this.groupContexts.get(key);
    if (existing) return existing;
    const pending = this.loadGroupValuationContext(group, blockNumber).catch((error) => {
      this.groupContexts.delete(key);
      throw error;
    });
    this.groupContexts.set(key, pending);
    while (this.groupContexts.size > GROUP_CONTEXT_CACHE_SIZE) {
      const oldest = this.groupContexts.keys().next().value;
      if (!oldest || oldest === key) break;
      this.groupContexts.delete(oldest);
    }
    return pending;
  }

  private async loadGroupValuationContext(group: PositionGroupRecord, blockNumber: bigint): Promise<GroupValuationContext> {
    const childRows = (await this.database.listPositionGroupChildren(group.id)).filter((child) => child.bin.status === "minted");
    if (childRows.length === 0) throw new Error("Position group has no active children to value");
    const missing = childRows.find((child) => child.position === null);
    if (missing) throw new Error(`Position group child bin ${missing.bin.binIndex} has no linked position`);
    const children = childRows.map((child) => child.position!);
    const [values, totals] = await Promise.all([
      this.reader.readGroup(group, children, blockNumber, undefined, "monitoring"),
      this.database.getPositionGroupCashflowTotals(group.id),
    ]);
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
    return {
      children,
      values,
      token0Amount: values.reduce((total, value) => total + value.token0.amount, 0n),
      token1Amount: values.reduce((total, value) => total + value.token1.amount, 0n),
      token0Fee: values.reduce((total, value) => total + value.unclaimedFees0, 0n),
      token1Fee: values.reduce((total, value) => total + value.unclaimedFees1, 0n),
      depositsQuote: totals.deposits > 0n ? totals.deposits : group.deployedCostQuote,
      realizedQuote: totals.realized,
      quotes: new Map(),
    };
  }

  private positionValuationContext(position: PositionRecord, blockNumber: bigint): Promise<PositionValuationContext> {
    const key = `${position.id}:${blockNumber}`;
    const existing = this.positionContexts.get(key);
    if (existing) return existing;
    const pending = this.loadPositionValuationContext(position, blockNumber).catch((error) => {
      this.positionContexts.delete(key);
      throw error;
    });
    this.positionContexts.set(key, pending);
    while (this.positionContexts.size > GROUP_CONTEXT_CACHE_SIZE) {
      const oldest = this.positionContexts.keys().next().value;
      if (!oldest || oldest === key) break;
      this.positionContexts.delete(oldest);
    }
    return pending;
  }

  private async loadPositionValuationContext(position: PositionRecord, blockNumber: bigint): Promise<PositionValuationContext> {
    const [value, totals] = await Promise.all([
      withTimeout(this.reader.read(position, blockNumber, undefined, "monitoring"), POSITION_READ_TIMEOUT_MS, "position read"),
      this.database.getCashflowTotals(position.id),
    ]);
    return { position, value, totals, quotes: new Map() };
  }

  private quoteInContext(
    cache: QuoteCache,
    position: PositionRecord,
    blockNumber: bigint,
    tokenIn: Address,
    amountIn: bigint,
    tokenOut: Address,
    slippageBps: number,
    mode: GroupQuoteMode,
    budgeted = true,
  ): Promise<ValuationRoute | null> {
    if (amountIn === 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return Promise.resolve(null);
    const key = `${mode}:${budgeted}:${tokenIn.toLowerCase()}:${amountIn}:${tokenOut.toLowerCase()}:${slippageBps}`;
    const existing = cache.quotes.get(key);
    if (existing) return existing;
    const pending = this.quoteUncached(cache, position, blockNumber, tokenIn, amountIn, tokenOut, slippageBps, mode, budgeted).catch((error) => {
      cache.quotes.delete(key);
      throw error;
    });
    cache.quotes.set(key, pending);
    return pending;
  }

  private async quoteUncached(
    cache: QuoteCache,
    position: PositionRecord,
    blockNumber: bigint,
    tokenIn: Address,
    amountIn: bigint,
    tokenOut: Address,
    slippageBps: number,
    mode: GroupQuoteMode,
    budgeted = true,
  ): Promise<ValuationRoute | null> {
    const isNative = tokenIn.toLowerCase() === zeroAddress || tokenOut.toLowerCase() === zeroAddress;
    const native = async (): Promise<ValuationRoute | null> => {
      if (!this.kyberswapApi) return null;
      try {
        const quote = await this.kyberswapApi.quote(position, tokenIn, amountIn, tokenOut, slippageBps);
        if (quote) return { expectedOut: quote.expectedOut, minimumOut: quote.minimumOut, path: [tokenIn, tokenOut], provider: "kyberswap" };
      } catch (error) {
        log.warn({ err: error, positionId: position.id, tokenIn, tokenOut }, "KyberSwap native valuation quote failed; native route unavailable");
      }
      return null;
    };
    const direct = async (): Promise<ValuationRoute | null> => {
      const route = (isNative && position.protocol === "v3") || (position.protocol === "v3" && !position.poolAddress)
        ? await withTimeout(this.routes.quoteDirect(position, tokenIn, amountIn, tokenOut, { rpc: "monitoring", blockNumber }), ROUTE_QUOTE_TIMEOUT_MS, "direct route quote")
        : await withTimeout(this.routes.quoteSourcePool(position, tokenIn, amountIn, tokenOut, { rpc: "monitoring", blockNumber }), ROUTE_QUOTE_TIMEOUT_MS, "direct pool quote");
      const valuation = route ? { expectedOut: route.expectedOut, minimumOut: applySlippage(route.expectedOut, slippageBps), path: route.path, provider: "source_pool" as const } : null;
      return valuation ?? (isNative ? await native() : null);
    };
    if (mode === "direct_pool") return direct();
    if (mode === "exact_local") {
      if (isNative) return native();
      const route = await withTimeout(
        this.routes.quoteDirect(position, tokenIn, amountIn, tokenOut, { rpc: "monitoring", blockNumber }),
        ROUTE_QUOTE_TIMEOUT_MS,
        "exact local route quote",
      );
      return route ? { expectedOut: route.expectedOut, minimumOut: applySlippage(route.expectedOut, slippageBps), path: route.path, provider: "source_pool" } : null;
    }

    const sourcePool = this.quoteInContext(cache, position, blockNumber, tokenIn, amountIn, tokenOut, slippageBps, "direct_pool", budgeted)
      .catch((error) => {
        log.warn({ err: error, positionId: position.id, tokenIn, tokenOut }, "source-pool exact probe failed; using aggregator quotes");
        return null;
      });
    const uniswap = this.tradingApi
      ? this.tradingApi.quote(position, tokenIn, amountIn, tokenOut, slippageBps, { budget: budgeted })
        .then((quote): ValuationRoute | null => quote ? { expectedOut: quote.expectedOut, minimumOut: quote.minimumOut, path: [tokenIn, tokenOut], provider: "uniswap" } : null)
        .catch((error) => {
          log.warn({ err: error, positionId: position.id, tokenIn, tokenOut }, "Trading API exact probe failed; using other quotes");
          return null;
        })
      : Promise.resolve(null);
    const kyber = this.kyberswapApi
      ? this.kyberswapApi.quote(position, tokenIn, amountIn, tokenOut, slippageBps, { budget: budgeted })
        .then((quote): ValuationRoute | null => quote ? { expectedOut: quote.expectedOut, minimumOut: quote.minimumOut, path: [tokenIn, tokenOut], provider: "kyberswap" } : null)
        .catch((error) => {
          log.warn({ err: error, positionId: position.id, tokenIn, tokenOut }, "KyberSwap exact probe failed; using other quotes");
          return null;
        })
      : Promise.resolve(null);
    const candidates = (await Promise.all([sourcePool, uniswap, kyber])).filter((quote): quote is ValuationRoute => quote !== null);
    const aggregators = candidates.filter((quote) => quote.provider === "uniswap" || quote.provider === "kyberswap");
    const ranked = (aggregators.length > 0 ? aggregators : candidates)
      .sort((left, right) => left.expectedOut > right.expectedOut ? -1 : left.expectedOut < right.expectedOut ? 1 : 0);
    return ranked[0] ?? null;
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

  isNearExactThreshold(metadata: Record<string, unknown>, snapshot: PnlSnapshot | PositionGroupPnlSnapshot, bufferBps = 100n): boolean {
    const thresholds = [
      percentToBps(this.config.stopLossPercent),
      percentToBps(this.config.takeProfitPercent),
      percentToBps(this.config.profitOorAboveThresholdPercent),
    ];
    thresholds.push(percentToBps(this.config.trailingStopActivationPercent));
    for (const source of ["local", "expected"] as const) {
      const trailingFloor = this.trailingFloorBps(metadata, source);
      if (trailingFloor !== null) thresholds.push(trailingFloor);
    }
    return thresholds.some((threshold) => absolute(snapshot.pnlBps - threshold) <= bufferBps);
  }

  evaluateTrailingStop(metadata: Record<string, unknown>, snapshot: PnlSnapshot, source: TrailingStopSource = "local"): TrailingStopDecision {
    const state = parseTrailingStopState(metadata, source);
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

  trailingExitEstimateGateBps(metadata: Record<string, unknown>, source: TrailingStopSource = "local"): bigint | null {
    const state = parseTrailingStopState(metadata, source);
    if (!state) return null;
    const trailingFloor = state.peakPnlBps - percentToBps(this.config.trailingStopDrawdownPercent);
    if (trailingFloor <= 0n) return 0n;
    const bufferBps = BigInt(Math.round(this.config.trailingExitEstimateBufferPercent * 100));
    return (trailingFloor * (10_000n - bufferBps)) / 10_000n;
  }

  trailingFloorBps(metadata: Record<string, unknown>, source: TrailingStopSource = "local"): bigint | null {
    const state = parseTrailingStopState(metadata, source);
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
          ? await this.tradingApi.quote(position, tokenIn, amountIn, tokenOut, undefined, { budget: true })
          : await this.tradingApi.quote(position, tokenIn, amountIn, tokenOut, slippageBps, { budget: true });
        if (quote) {
          return { expectedOut: quote.expectedOut, minimumOut: quote.minimumOut, path: [tokenIn, tokenOut], provider: "uniswap" };
        }
      } catch (error) {
        log.warn({ err: error, positionId: position.id, tokenIn, tokenOut }, "Trading API valuation quote failed; using local quote");
      }
    }

    if (this.kyberswapApi && (tokenIn.toLowerCase() === zeroAddress || tokenOut.toLowerCase() === zeroAddress)) {
      try {
        const quote = await this.kyberswapApi.quote(position, tokenIn, amountIn, tokenOut, slippageBps);
        if (quote) return { expectedOut: quote.expectedOut, minimumOut: quote.minimumOut, path: [tokenIn, tokenOut], provider: "kyberswap" };
      } catch (error) {
        log.warn({ err: error, positionId: position.id, tokenIn, tokenOut }, "KyberSwap native valuation quote failed; native route unavailable");
      }
    }

    if (tokenIn.toLowerCase() === zeroAddress || tokenOut.toLowerCase() === zeroAddress) return null;
    const route = await withTimeout(
      this.routes.quoteDirect(position, tokenIn, amountIn, tokenOut, { rpc: "monitoring" }),
      ROUTE_QUOTE_TIMEOUT_MS,
      "local route quote",
    );
    return route
      ? { expectedOut: route.expectedOut, minimumOut: applySlippage(route.expectedOut, slippageBps), path: route.path, provider: "source_pool" }
      : null;
  }

  private async recordAndCheckPrice(position: PositionRecord, poolKey: string, marker: bigint, blockNumber: bigint): Promise<{ ready: boolean; deviationBps?: bigint }> {
    const observedAt = new Date();
    const observations = await this.database.getPoolObservationsForTwap(
      position.chainId,
      position.protocol,
      poolKey,
      this.config.twapWindowSeconds,
    );
    await this.database.recordPoolObservation(position.chainId, position.protocol, poolKey, marker, blockNumber);
    const samples = [...observations, { priceMarker: marker, observedAt }]
      .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
    const windowStartMs = observedAt.getTime() - this.config.twapWindowSeconds * 1_000;
    const firstSample = samples[0];
    const hasFullWindow = firstSample !== undefined && firstSample.observedAt.getTime() <= windowStartMs;
    if (marker === 0n || samples.length < MIN_TWAP_OBSERVATIONS || !hasFullWindow) return { ready: false };

    let weightedMarker = 0n;
    let weightedDurationMs = 0n;
    for (let index = 0; index < samples.length - 1; index += 1) {
      const sample = samples[index]!;
      const startMs = Math.max(windowStartMs, sample.observedAt.getTime());
      const endMs = Math.min(observedAt.getTime(), samples[index + 1]!.observedAt.getTime());
      if (endMs <= startMs) continue;
      const durationMs = BigInt(endMs - startMs);
      weightedMarker += sample.priceMarker * durationMs;
      weightedDurationMs += durationMs;
    }
    if (weightedDurationMs === 0n) return { ready: false };

    const twapMarker = weightedMarker / weightedDurationMs;
    if (twapMarker === 0n) return { ready: false };
    const difference = marker > twapMarker ? marker - twapMarker : twapMarker - marker;
    const deviationBps = (difference * 10_000n) / twapMarker;
    return { ready: deviationBps <= BigInt(this.config.maxTwapDeviationBps), deviationBps };
  }

  private exactMinimumLiquidation(
    quoteAmount: bigint,
    nonQuoteFee: bigint,
    totalNonQuote: bigint,
    route: ValuationRoute | null,
  ): bigint {
    const minTotal = route?.minimumOut ?? 0n;
    const minFeeRoute = totalNonQuote > 0n ? (minTotal * nonQuoteFee) / totalNonQuote : 0n;
    return quoteAmount + (minTotal - minFeeRoute);
  }

  private exactMinimumPnlBps(
    deposits: bigint,
    realized: bigint,
    quoteAmount: bigint,
    quoteSideFee: bigint,
    nonQuoteFee: bigint,
    totalNonQuote: bigint,
    route: ValuationRoute | null,
  ): bigint {
    const minTotal = route?.minimumOut ?? 0n;
    const minFeeRoute = totalNonQuote > 0n ? (minTotal * nonQuoteFee) / totalNonQuote : 0n;
    const minPnl = realized + quoteSideFee + minFeeRoute + quoteAmount + (minTotal - minFeeRoute) - deposits;
    return (minPnl * 10_000n) / deposits;
  }

  private async persistExactQuote(quote: import("../types.js").PositionExactQuote): Promise<void> {
    if (typeof this.database.upsertExactQuote !== "function") return;
    await this.database.upsertExactQuote(quote);
  }

  private async persistGroupExactQuote(quote: import("../types.js").PositionGroupExactQuote): Promise<void> {
    if (typeof this.database.upsertGroupExactQuote !== "function") return;
    await this.database.upsertGroupExactQuote(quote);
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

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
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

function parseTrailingStopState(metadata: Record<string, unknown>, source: TrailingStopSource): TrailingStopState | null {
  const raw = metadata[source === "expected" ? "trailingStopExpected" : "trailingStop"];
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

function spotMarkTotal(value: PositionValue, quoteIsToken0: boolean): bigint {
  const amount0 = value.token0.amount + value.unclaimedFees0;
  const amount1 = value.token1.amount + value.unclaimedFees1;
  if (value.range && isUsableSqrtPrice(value.range.currentSqrtPrice, value.range.currentTick)) {
    return quoteValueAtSqrtPrice(amount0, amount1, quoteIsToken0, value.range.currentSqrtPrice);
  }
  if (value.protocol === "v2") return quoteValueAtPriceMarker(amount0, amount1, quoteIsToken0, value.priceMarker);
  throw new Error("Spot mark is unavailable");
}

function groupSpotMarkTotal(
  values: readonly PositionValue[],
  token0Amount: bigint,
  token1Amount: bigint,
  token0Fee: bigint,
  token1Fee: bigint,
  quoteIsToken0: boolean,
): bigint {
  const amount0 = token0Amount + token0Fee;
  const amount1 = token1Amount + token1Fee;
  const source = values.find((value) => value.range);
  if (source?.range && isUsableSqrtPrice(source.range.currentSqrtPrice, source.range.currentTick)) {
    return quoteValueAtSqrtPrice(amount0, amount1, quoteIsToken0, source.range.currentSqrtPrice);
  }
  if (values[0]?.protocol === "v2") return quoteValueAtPriceMarker(amount0, amount1, quoteIsToken0, values[0].priceMarker);
  throw new Error("Spot mark is unavailable");
}

function allocateSpotMark(
  markedTotal: bigint,
  quoteAmount: bigint,
  quoteSideFee: bigint,
  nonQuoteAmount: bigint,
  nonQuoteFee: bigint,
): { liquidationQuote: bigint; feeQuote: bigint; feeNonQuoteConverted: bigint; routeOutput: bigint } {
  return allocateRouteOutput(
    markedTotal > quoteAmount + quoteSideFee ? markedTotal - quoteAmount - quoteSideFee : 0n,
    quoteAmount,
    quoteSideFee,
    nonQuoteAmount,
    nonQuoteFee,
  );
}

function allocateRouteOutput(
  totalRouteOutput: bigint,
  quoteAmount: bigint,
  quoteSideFee: bigint,
  nonQuoteAmount: bigint,
  nonQuoteFee: bigint,
): { liquidationQuote: bigint; feeQuote: bigint; feeNonQuoteConverted: bigint; routeOutput: bigint } {
  const totalNonQuote = nonQuoteAmount + nonQuoteFee;
  const feeNonQuoteConverted = totalNonQuote > 0n ? (totalRouteOutput * nonQuoteFee) / totalNonQuote : 0n;
  const routeOutput = totalRouteOutput - feeNonQuoteConverted;
  return {
    liquidationQuote: quoteAmount + routeOutput,
    feeQuote: quoteSideFee + feeNonQuoteConverted,
    feeNonQuoteConverted,
    routeOutput,
  };
}

export function isQuoteToken(token: Address, allowlist: readonly { address: Address }[]): boolean {
  return allowlist.some((allowed) => allowed.address.toLowerCase() === token.toLowerCase());
}
