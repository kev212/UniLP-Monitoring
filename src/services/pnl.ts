import type { Address } from "viem";

import type { RuntimeConfig } from "../config.js";
import type { Database } from "../db.js";
import type { ExitTrigger, LiquidationQuote, PnlSnapshot, PositionRecord, TrailingStopState } from "../types.js";
import type { PositionReader } from "./position-reader.js";
import type { RoutePlanner } from "./route-planner.js";

export interface ValuedPosition {
  snapshot: PnlSnapshot;
  liquidation: LiquidationQuote;
  twapGuard: { ready: boolean; deviationBps?: bigint };
}

export type TrailingStopDecision =
  | { action: "none" }
  | { action: "reset" }
  | { action: "activate" | "raise_peak"; state: TrailingStopState }
  | { action: "trigger"; state: TrailingStopState };

export class PnlService {
  constructor(
    private readonly database: Database,
    private readonly reader: PositionReader,
    private readonly routes: RoutePlanner,
    private readonly config: RuntimeConfig,
  ) {}

  async value(position: PositionRecord, blockNumber: bigint): Promise<ValuedPosition> {
    if (!position.quoteToken) throw new Error("Position has no eligible quote token");
    const value = await this.reader.read(position, blockNumber);
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
    const quoteIsToken0 = value.token0.token.toLowerCase() === position.quoteToken.toLowerCase();
    const quoteAmount = quoteIsToken0 ? value.token0.amount : value.token1.amount;
    const nonQuote = quoteIsToken0 ? value.token1 : value.token0;
    const route = await this.routes.quoteDirect(position, nonQuote.token, nonQuote.amount, position.quoteToken);
    if (nonQuote.amount > 0n && !route) throw new Error("No safe direct Uniswap route from LP asset to quote token");

    const liquidationQuote = quoteAmount + (route?.minimumOut ?? 0n);
    const quoteSideFee = quoteIsToken0 ? value.unclaimedFees0 : value.unclaimedFees1;
    const nonQuoteFee = quoteIsToken0 ? value.unclaimedFees1 : value.unclaimedFees0;
    let feeQuote = quoteSideFee;
    let feeNonQuoteConverted = 0n;
    if (nonQuoteFee > 0n) {
      const feeRoute = await this.routes.quoteDirect(position, nonQuote.token, nonQuoteFee, position.quoteToken);
      feeNonQuoteConverted = feeRoute?.minimumOut ?? 0n;
      feeQuote += feeNonQuoteConverted;
    }
    const totals = await this.database.getCashflowTotals(position.id);
    if (totals.deposits === 0n) throw new Error("Position cost basis has not been reconstructed");

    let feeQuoteUsdg = feeQuote;
    const chainName = this.config.chains[0];
    if (chainName) {
      const stable = this.config.quoteTokens[chainName]?.[0]?.address;
      if (stable && position.quoteToken.toLowerCase() !== stable.toLowerCase() && feeQuote > 0n) {
        const stableRoute = await this.routes.quoteDirect(position, position.quoteToken, feeQuote, stable);
        feeQuoteUsdg = stableRoute?.minimumOut ?? 0n;
      }
    }
    const pnlQuote = totals.realized + feeQuote + liquidationQuote - totals.deposits;
    const pnlBps = (pnlQuote * 10_000n) / totals.deposits;
    const twapGuard = await this.recordAndCheckPrice(position, value.poolKey, value.priceMarker, value.observedBlock);

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
        route: route ? [route.tokenIn, route.tokenOut] : [],
        blockNumber: value.observedBlock,
      },
      twapGuard,
    };
  }

  shouldTrigger(snapshot: PnlSnapshot): ExitTrigger | null {
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
