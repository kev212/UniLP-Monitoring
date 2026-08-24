import { describe, expect, it } from "vitest";

import {
  calculateBidAskWeights,
  bidAskShapeVersionForBinCount,
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
    expect(moreThanForty.shapeVersion).toBe("delta-amount-linear-v4");
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
    expect(calculateBidAskWeights(5, 0, "delta-amount-linear-v2")).toEqual([
      { distance: 0, weightMicros: 100_000 },
      { distance: 1, weightMicros: 90_000 },
      { distance: 2, weightMicros: 180_000 },
      { distance: 3, weightMicros: 270_000 },
      { distance: 4, weightMicros: 360_000 },
    ]);
  });

  it("uses a permanent seven-percent anchor for new ladders", () => {
    expect(calculateBidAskWeights(1, 0)).toEqual([
      { distance: 0, weightMicros: 1_000_000 },
    ]);
    expect(calculateBidAskWeights(2, 0)).toEqual([
      { distance: 0, weightMicros: 70_000 },
      { distance: 1, weightMicros: 930_000 },
    ]);
    expect(calculateBidAskWeights(3, 0)).toEqual([
      { distance: 0, weightMicros: 70_000 },
      { distance: 1, weightMicros: 285_454 },
      { distance: 2, weightMicros: 644_546 },
    ]);
    expect(calculateBidAskWeights(4, 3)).toEqual([
      { distance: 3, weightMicros: 485_386 },
      { distance: 2, weightMicros: 291_538 },
      { distance: 1, weightMicros: 153_076 },
      { distance: 0, weightMicros: 70_000 },
    ]);
    expect(calculateBidAskWeights(5, 0)).toEqual([
      { distance: 0, weightMicros: 70_000 },
      { distance: 1, weightMicros: 109_000 },
      { distance: 2, weightMicros: 174_000 },
      { distance: 3, weightMicros: 265_000 },
      { distance: 4, weightMicros: 382_000 },
    ]);
    expect(calculateBidAskWeights(5, 4)).toEqual([
      { distance: 4, weightMicros: 382_000 },
      { distance: 3, weightMicros: 265_000 },
      { distance: 2, weightMicros: 174_000 },
      { distance: 1, weightMicros: 109_000 },
      { distance: 0, weightMicros: 70_000 },
    ]);
    expect(bidAskShapeVersionForBinCount(10)).toBe("delta-amount-linear-v4");
    expect(bidAskShapeVersionForBinCount(11)).toBe("delta-amount-linear-v4");

    const sixteenBins = calculateBidAskWeights(16, 0);
    expect(sixteenBins[0]?.weightMicros).toBe(70_000);
    expect(sixteenBins.every((weight) => weight.weightMicros > 0)).toBe(true);
    expect(sixteenBins.reduce((sum, weight) => sum + weight.weightMicros, 0)).toBe(1_000_000);

    const threeBinBudget = planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 400,
      tickSpacing: 100,
      requestedBinCount: 3,
      quoteIsToken0: true,
      totalAmount: 250_000_000n,
    });
    expect(threeBinBudget.shapeVersion).toBe("delta-amount-linear-v4");
    expect(threeBinBudget.bins.map((bin) => bin.allocatedAmount0)).toEqual([17_500_000n, 71_363_500n, 161_136_500n]);

    const fourBinBudget = planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 500,
      tickSpacing: 100,
      requestedBinCount: 4,
      quoteIsToken0: true,
      totalAmount: 250_000_000n,
    });
    expect(fourBinBudget.shapeVersion).toBe("delta-amount-linear-v4");
    expect(fourBinBudget.bins.map((bin) => bin.allocatedAmount0)).toEqual([17_500_000n, 38_269_000n, 72_884_500n, 121_346_500n]);

    const fiveBinBudget = planBidAsk({
      currentTick: 0,
      rawTickLower: 100,
      rawTickUpper: 600,
      tickSpacing: 100,
      requestedBinCount: 5,
      quoteIsToken0: true,
      totalAmount: 250_000_000n,
    });
    expect(fiveBinBudget.shapeVersion).toBe("delta-amount-linear-v4");
    expect(fiveBinBudget.bins.map((bin) => bin.allocatedAmount0)).toEqual([17_500_000n, 27_250_000n, 43_500_000n, 66_250_000n, 95_500_000n]);
  });

  it("preserves the historical ten-percent v3 weighting", () => {
    expect(calculateBidAskWeights(5, 0, "delta-amount-linear-v3")).toEqual([
      { distance: 0, weightMicros: 100_000 },
      { distance: 1, weightMicros: 130_000 },
      { distance: 2, weightMicros: 180_000 },
      { distance: 3, weightMicros: 250_000 },
      { distance: 4, weightMicros: 340_000 },
    ]);
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
    expect(plan.shapeVersion).toBe("delta-amount-linear-v4");
    expect(plan.bins.map((bin) => bin.allocatedAmount0)).toEqual([7n, 28n, 65n]);
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
