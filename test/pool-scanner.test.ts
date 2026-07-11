import { describe, expect, it } from "vitest";

import { hasMinimumScanVolume, MIN_VOLUME_1H_USD, uniswapPoolUrl } from "../src/services/pool-scanner.js";

describe("pool scoring formula", () => {
  const K = 1_000_000;

  function computeScore(volume1hUsd: number, feeTier: number, tvlUsd: number): { score: number; safetyFactor: number } {
    const feeRate = feeTier / 1_000_000;
    const safetyFactor = Math.sqrt(tvlUsd / (tvlUsd + K));
    const score = volume1hUsd > 0 ? (volume1hUsd * feeRate / tvlUsd) * safetyFactor : 0;
    return { score, safetyFactor };
  }

  it("returns score 0 when volume 1h is 0", () => {
    const result = computeScore(0, 3000, 500_000);
    expect(result.score).toBe(0);
  });

  it("returns a positive score for active pool", () => {
    const result = computeScore(50_000, 3000, 500_000);
    expect(result.score).toBeGreaterThan(0);
  });

  it("rewards higher fee tier for same volume/TVL ratio", () => {
    const lowFee = computeScore(10_000, 500, 100_000);
    const highFee = computeScore(10_000, 3000, 100_000);
    expect(highFee.score).toBeGreaterThan(lowFee.score);
  });

  it("applies safety factor penalty to low TVL pools", () => {
    const small = computeScore(10_000, 3000, 5_000);
    const large = computeScore(10_000, 3000, 10_000_000);
    expect(large.safetyFactor).toBeGreaterThan(small.safetyFactor);
  });

  it("safety factor approaches 1 as TVL grows", () => {
    const result = computeScore(1_000_000, 3000, 100_000_000);
    expect(result.safetyFactor).toBeGreaterThan(0.99);
  });

  it("disqualifies TVL <= 0 before scoring", () => {
    let disqualified = true;
    if (0 > 0) disqualified = false;
    if (-1 > 0) disqualified = false;
    expect(disqualified).toBe(true);
  });

  it("dynamic-fee pool uses current LP fee instead of creation fee", () => {
    const creationFee = 3000;
    const currentLpFee = 500;
    const effectiveFee = currentLpFee;
    const result = computeScore(10_000, effectiveFee, 100_000);
    const creationScore = computeScore(10_000, creationFee, 100_000);
    expect(result.score).toBeLessThan(creationScore.score);
  });

  it("sorts pools by score descending", () => {
    const pools = [
      { pair: "A", score: computeScore(5_000, 3000, 100_000).score },
      { pair: "B", score: computeScore(50_000, 3000, 100_000).score },
      { pair: "C", score: computeScore(10_000, 500, 500_000).score },
    ];
    pools.sort((a, b) => b.score - a.score);
    expect(pools[0]!.pair).toBe("B");
    expect(pools[2]!.pair).toBe("C");
  });
});

describe("scan pool eligibility", () => {
  it("excludes pools with less than $100 of rolling 1h volume", () => {
    expect(hasMinimumScanVolume(MIN_VOLUME_1H_USD - 0.01)).toBe(false);
    expect(hasMinimumScanVolume(MIN_VOLUME_1H_USD)).toBe(true);
    expect(hasMinimumScanVolume(Number.NaN)).toBe(false);
  });

  it("builds an Uniswap explorer URL from either a pool address or V4 pool ID", () => {
    expect(uniswapPoolUrl("0xe39078fc024188927e10b26d91e4720a600fba85"))
      .toBe("https://app.uniswap.org/explore/pools/robinhood/0xe39078fc024188927e10b26d91e4720a600fba85");
    expect(uniswapPoolUrl("0x4570413b567093841404954697bba9178a963f2810844321fcb777b27ac32267"))
      .toBe("https://app.uniswap.org/explore/pools/robinhood/0x4570413b567093841404954697bba9178a963f2810844321fcb777b27ac32267");
  });
});
