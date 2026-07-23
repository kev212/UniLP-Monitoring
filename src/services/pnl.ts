import type { Address } from "viem";

import { chainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ExitTrigger, LiquidationQuote, PnlSnapshot, PositionRangeInfo, PositionRecord, TrailingStopState } from "../types.js";
import type { PositionReader } from "./position-reader.js";
import type { RoutePlanner } from "./route-planner.js";
import type { UniswapTradingApi } from "./uniswap-trading-api.js";
import { quoteRangeState } from "./quote-range.js";
import { applySlippage } from "./uniswap-math.js";

const POSITION_READ_TIMEOUT_MS = 15_000;
const ROUTE_QUOTE_TIMEOUT_MS = 15_000;

export interface ValuedPosition {
  snapshot: PnlSnapshot;
  liquidation: LiquidationQuote;
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
  ) {}

  async value(
    position: PositionRecord,
    blockNumber: bigint,
    quoteSlippageBps = this.config.maxSwapSlippageBps,
    recordObservations = true,
  ): Promise<ValuedPosition> {
    if (!position.quoteToken) throw new Error("Position has no eligible quote token");
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
      );
    }
    const quoteIsToken0 = value.token0.token.toLowerCase() === position.quoteToken.toLowerCase();
    const quoteAmount = quoteIsToken0 ? value.token0.amount : value.token1.amount;
    const nonQuote = quoteIsToken0 ? value.token1 : value.token0;
    const quoteSideFee = quoteIsToken0 ? value.unclaimedFees0 : value.unclaimedFees1;
    const nonQuoteFee = quoteIsToken0 ? value.unclaimedFees1 : value.unclaimedFees0;
    const [route, feeRoute] = await Promise.all([
       this.quoteFresh(position, nonQuote.token, nonQuote.amount, position.quoteToken, quoteSlippageBps),
       this.quoteFresh(position, nonQuote.token, nonQuoteFee, position.quoteToken, quoteSlippageBps),
    ]);
    if (nonQuote.amount > 0n && !route) throw new Error("No safe direct Uniswap route from LP asset to quote token");

    const liquidationQuote = quoteAmount + (route?.minimumOut ?? 0n);
    let feeQuote = quoteSideFee;
    let feeNonQuoteConverted = 0n;
    if (nonQuoteFee > 0n) {
      feeNonQuoteConverted = feeRoute?.minimumOut ?? 0n;
      feeQuote += feeNonQuoteConverted;
    }
    const totals = await this.database.getCashflowTotals(position.id);
    if (totals.deposits === 0n) throw new Error("Position cost basis has not been reconstructed");

    let feeQuoteUsdg = feeQuote;
    const chainName = this.config.chains.find((name) => chainRegistry[name].chain.id === position.chainId);
    if (chainName) {
      const stable = this.config.quoteTokens[chainName]?.[0]?.address;
      if (stable && position.quoteToken.toLowerCase() !== stable.toLowerCase() && feeQuote > 0n) {
        const stableRoute = await this.quoteFresh(position, position.quoteToken, feeQuote, stable, quoteSlippageBps);
        feeQuoteUsdg = stableRoute?.minimumOut ?? 0n;
      }
    }
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

  shouldTrigger(snapshot: PnlSnapshot, range: PositionRangeInfo | undefined, quoteIsToken0: boolean): ExitTrigger | null {
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

  private async quoteFresh(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address, slippageBps = this.config.maxSwapSlippageBps): Promise<ValuationRoute | null> {
    if (amountIn === 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
    if (this.tradingApi) {
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
