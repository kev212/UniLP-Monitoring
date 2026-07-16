import { describe, expect, it } from "vitest";

import { quoteRangeState } from "../src/services/quote-range.js";
import { sqrtRatioAtTick } from "../src/services/uniswap-math.js";

describe("quote-oriented range triggers", () => {
  const range = (status: "in_range" | "above" | "below", currentTick: number) => ({
    status,
    tickLower: 0,
    tickUpper: 100,
    currentTick,
    currentSqrtPrice: sqrtRatioAtTick(currentTick),
  });

  it.each(["USDG", "ETH", "WETH"])("maps raw above to quote below when %s is token0", () => {
    const value = range("above", 200);
    const state = quoteRangeState(value, true)!;
    expect(state.status).toBe("below");
    expect(state.belowDistanceBps).toBeGreaterThan(0n);
    expect(state.aboveDistanceBps).toBe(0n);
  });

  it.each(["USDG", "ETH", "WETH"])("maps raw below to quote below when %s is token1", () => {
    const value = range("below", -100);
    const state = quoteRangeState(value, false)!;
    expect(state.status).toBe("below");
    expect(state.belowDistanceBps).toBeGreaterThan(0n);
    expect(state.aboveDistanceBps).toBe(0n);
  });

  it.each(["USDG", "ETH", "WETH"])("maps raw above to quote above when %s is token1", () => {
    const value = { ...range("above", 200), aboveDistanceBps: 1_200n };
    const state = quoteRangeState(value, false)!;
    expect(state.status).toBe("above");
    expect(state.aboveDistanceBps).toBe(1_200n);
    expect(state.belowDistanceBps).toBe(0n);
  });

  it("maps raw below to quote above when the quote is token0", () => {
    const value = range("below", -100);
    const state = quoteRangeState(value, true)!;
    expect(state.status).toBe("above");
    expect(state.aboveDistanceBps).toBeGreaterThan(0n);
  });
});
