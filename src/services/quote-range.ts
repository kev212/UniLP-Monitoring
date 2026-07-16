import type { PositionRangeInfo } from "../types.js";
import { sqrtRatioAtTick } from "./uniswap-math.js";

export interface QuoteRangeState {
  status: PositionRangeInfo["status"];
  aboveDistanceBps: bigint;
  belowDistanceBps: bigint;
}

export function quoteRangeState(range: PositionRangeInfo | undefined, quoteIsToken0: boolean): QuoteRangeState | null {
  if (!range) return null;
  const status = quoteIsToken0
    ? (range.status === "above" ? "below" : range.status === "below" ? "above" : "in_range")
    : range.status;
  return {
    status,
    aboveDistanceBps: quoteAboveDistanceBps(range, quoteIsToken0),
    belowDistanceBps: quoteBelowDistanceBps(range, quoteIsToken0),
  };
}

function quoteAboveDistanceBps(range: PositionRangeInfo, quoteIsToken0: boolean): bigint {
  if (!quoteIsToken0) return range.status === "above" ? range.aboveDistanceBps ?? 0n : 0n;
  if (range.status !== "below") return 0n;
  return ratioDistanceBps(sqrtRatioAtTick(range.tickLower), range.currentSqrtPrice);
}

function quoteBelowDistanceBps(range: PositionRangeInfo, quoteIsToken0: boolean): bigint {
  if (!quoteIsToken0) {
    if (range.status !== "below") return 0n;
    return ratioDistanceBps(sqrtRatioAtTick(range.tickLower), range.currentSqrtPrice);
  }
  if (range.status !== "above") return 0n;
  return ratioDistanceBps(range.currentSqrtPrice, sqrtRatioAtTick(range.tickUpper));
}

function ratioDistanceBps(numeratorSqrt: bigint, denominatorSqrt: bigint): bigint {
  const denominator = denominatorSqrt * denominatorSqrt;
  if (denominator === 0n) return 0n;
  return (numeratorSqrt * numeratorSqrt * 10_000n) / denominator - 10_000n;
}
