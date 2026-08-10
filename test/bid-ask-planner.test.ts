import { describe, expect, it } from "vitest";

import {
  calculateBidAskWeights,
  hashBidAskPlan,
  planBidAsk,
  snapBidAskBounds,
} from "../src/services/bid-ask-planner.js";

describe("one-sided Bid-Ask planner", () => {
  it("validates quote-token0 above-price and quote-token1 below-price ladders", () => {
    const token0Plan = planBidAsk({
      currentTick: 0,
      rawTickLower: 101,
      rawTickUpper: 401,
      tickSpacing: 100,
      requestedBinCount: 4,
      quoteIsToken0: true,
      totalAmount: 1_000n,
    });
    expect(token0Plan).toMatchObject({
      outerTickLower: 100,
      outerTickUpper: 500,
      anchorIndex: 0,
      totalAmount0: 1_000n,
      totalAmount1: 0n,
    });
    expect(token0Plan.bins.every((bin) => bin.side === "token0" && bin.allocatedAmount1 === 0n)).toBe(true);

    const token1Plan = planBidAsk({
      currentTick: 500,
      rawTickLower: 99,
      rawTickUpper: 399,
      tickSpacing: 100,
      requestedBinCount: 4,
      quoteIsToken0: false,
      totalAmount: 1_000n,
    });
    expect(token1Plan).toMatchObject({
      outerTickLower: 0,
      outerTickUpper: 400,
      anchorIndex: 3,
      totalAmount0: 0n,
      totalAmount1: 1_000n,
    });
    expect(token1Plan.bins.every((bin) => bin.side === "token1" && bin.allocatedAmount0 === 0n)).toBe(true);
  });

  it("rejects ranges that are not one-sided for the selected quote orientation", () => {
    expect(() => planBidAsk({
      currentTick: 150,
      rawTickLower: 100,
      rawTickUpper: 400,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: true,
      totalAmount: 1n,
    })).toThrow(/entirely below or above/);

    expect(() => planBidAsk({
      currentTick: 500,
      rawTickLower: 100,
      rawTickUpper: 400,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: true,
      totalAmount: 1n,
    })).toThrow(/orientation/);

    expect(() => planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 400,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: false,
      totalAmount: 1n,
    })).toThrow(/orientation/);
  });

  it("snaps negative bounds using floor lower and ceil upper", () => {
    expect(snapBidAskBounds(-251, -101, 100)).toEqual({ lowerTick: -300, upperTick: -100 });
  });

  it("uses exact Delta boundaries and does not cap bin counts at 40", () => {
    const uneven = planBidAsk({
      currentTick: -400,
      rawTickLower: -299,
      rawTickUpper: 499,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: true,
      totalAmount: 1_000_000n,
    });
    expect(uneven.bins.map(({ tickLower, tickUpper }) => [tickLower, tickUpper])).toEqual([
      [-300, -100],
      [-100, 200],
      [200, 500],
    ]);

    const cappedBySpacing = planBidAsk({
      currentTick: -100,
      rawTickLower: 1,
      rawTickUpper: 299,
      tickSpacing: 100,
      requestedBinCount: 10,
      quoteIsToken0: true,
      totalAmount: 1n,
    });
    expect(cappedBySpacing.generatedBinCount).toBe(3);

    const moreThanForty = planBidAsk({
      currentTick: 0,
      rawTickLower: 101,
      rawTickUpper: 5_001,
      tickSpacing: 100,
      requestedBinCount: 45,
      quoteIsToken0: true,
      totalAmount: 10_000n,
    });
    expect(moreThanForty.generatedBinCount).toBe(45);
  });

  it("persists exact edge anchors and Bid-Ask weights", () => {
    expect(calculateBidAskWeights(4, 0, "delta-amount-linear-v1")).toEqual([
      { distance: 0, weightMicros: 20_000 },
      { distance: 1, weightMicros: 333_333 },
      { distance: 2, weightMicros: 666_667 },
      { distance: 3, weightMicros: 1_000_000 },
    ]);
    expect(calculateBidAskWeights(4, 3, "delta-amount-linear-v1")).toEqual([
      { distance: 3, weightMicros: 1_000_000 },
      { distance: 2, weightMicros: 666_667 },
      { distance: 1, weightMicros: 333_333 },
      { distance: 0, weightMicros: 20_000 },
    ]);
  });

  it("uses a permanent ten-percent anchor for new ladders", () => {
    expect(calculateBidAskWeights(1, 0)).toEqual([
      { distance: 0, weightMicros: 1_000_000 },
    ]);
    expect(calculateBidAskWeights(2, 0)).toEqual([
      { distance: 0, weightMicros: 100_000 },
      { distance: 1, weightMicros: 900_000 },
    ]);
    expect(calculateBidAskWeights(3, 0)).toEqual([
      { distance: 0, weightMicros: 100_000 },
      { distance: 1, weightMicros: 300_000 },
      { distance: 2, weightMicros: 600_000 },
    ]);
    expect(calculateBidAskWeights(4, 3)).toEqual([
      { distance: 3, weightMicros: 450_000 },
      { distance: 2, weightMicros: 300_000 },
      { distance: 1, weightMicros: 150_000 },
      { distance: 0, weightMicros: 100_000 },
    ]);

    const threeBinBudget = planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 400,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: true,
      totalAmount: 150n,
    });
    expect(threeBinBudget.bins.map((bin) => bin.allocatedAmount0)).toEqual([15n, 45n, 90n]);

    const fourBinBudget = planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 500,
      tickSpacing: 100,
      requestedBinCount: 4,
      quoteIsToken0: true,
      totalAmount: 200n,
    });
    expect(fourBinBudget.bins.map((bin) => bin.allocatedAmount0)).toEqual([20n, 30n, 60n, 90n]);
  });

  it("allocates bigint amounts with the final generated bin receiving the remainder", () => {
    const plan = planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 400,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: true,
      totalAmount: 100n,
    });
    expect(plan.shapeVersion).toBe("delta-amount-linear-v2");
    expect(plan.bins.map((bin) => bin.allocatedAmount0)).toEqual([10n, 30n, 60n]);
    expect(plan.bins.map((bin) => bin.allocatedAmount1)).toEqual([0n, 0n, 0n]);
    expect(plan.bins.reduce((sum, bin) => sum + bin.allocatedAmount0, 0n)).toBe(100n);
  });

  it("leaves allocation validation to the caller without liquidity inputs", () => {
    const plan = planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 500,
      tickSpacing: 100,
      requestedBinCount: 4,
      quoteIsToken0: true,
      totalAmount: 1n,
    });
    expect(plan.bins.map((bin) => bin.allocatedAmount0)).toEqual([0n, 0n, 0n, 1n]);
    expect(plan.bins[0]?.expectedLiquidity).toBeUndefined();
  });

  it("rejects zero allocation or zero liquidity when an estimator is supplied", () => {
    expect(() => planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 500,
      tickSpacing: 100,
      requestedBinCount: 4,
      quoteIsToken0: true,
      totalAmount: 1n,
      liquidityForBin: () => 1n,
    })).toThrow(/zero allocation/);

    expect(() => planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 400,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: true,
      totalAmount: 1_520_000n,
      liquidityForBin: () => 0n,
    })).toThrow(/zero liquidity/);
  });

  it("produces a deterministic canonical hash", () => {
    const plan = planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 400,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: true,
      totalAmount: 100n,
    });
    const equivalentPlan = { ...plan, bins: plan.bins.map((bin) => ({ ...bin })) };
    const hash = hashBidAskPlan(plan);
    expect(hashBidAskPlan(equivalentPlan)).toBe(hash);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
