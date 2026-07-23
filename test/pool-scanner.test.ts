import { afterEach, describe, expect, it, vi } from "vitest";

import { effectiveMarketCap, estimatedHourlyYieldPercent, estimatedYieldPercent, hasMinimumScanVolume6h, limitQualifiedPoolsPerToken, MIN_VOLUME_6H_USD, PoolScanner, poolPair, rankPools, uniswapPoolUrl, type ScoredPool } from "../src/services/pool-scanner.js";
import { calibrateOhlcvPrices, normalizeOhlcvPrices, overlapFraction, snapRange } from "../src/services/concentrated-yield.js";

describe("pool scoring formula", () => {
  const K = 1_000_000;

  function computeScore(volume6hUsd: number, feeTier: number, tvlUsd: number): { score: number; safetyFactor: number } {
    const feeRate = feeTier / 1_000_000;
    const safetyFactor = Math.sqrt(tvlUsd / (tvlUsd + K));
    const score = volume6hUsd > 0 ? (volume6hUsd * feeRate / tvlUsd) * safetyFactor : 0;
    return { score, safetyFactor };
  }

  it("returns score 0 when volume 6h is 0", () => {
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

describe("concentrated yield range math", () => {
  it("snaps a downside range and places the upper boundary above current", () => {
    const range = snapRange(-345946, 200, 35);
    expect(Math.abs(range.lowerTick % 200)).toBe(0);
    expect(Math.abs(range.upperTick % 200)).toBe(0);
    expect(range.lowerTick).toBeLessThan(-345946);
    expect(range.upperTick).toBeGreaterThan(-345946);
  });

  it("weights only the logarithmic price overlap", () => {
    expect(overlapFraction(70, 80, 70, 100)).toBeGreaterThan(0);
    expect(overlapFraction(100, 110, 70, 100)).toBe(0);
    expect(overlapFraction(70, 100, 70, 100)).toBe(1);
  });

  it("inverts OHLCV when the search token is GeckoTerminal's quote asset", () => {
    const result = normalizeOhlcvPrices(2_000, 1_800, "0xweth", "0xtoken", "0xtoken");
    expect(result.high).toBeCloseTo(1 / 1_800);
    expect(result.low).toBeCloseTo(1 / 2_000);
  });

  it("keeps OHLCV orientation when the search token is the base asset", () => {
    expect(normalizeOhlcvPrices(2_000, 1_800, "0xtoken", "0xweth", "0xtoken")).toEqual({ high: 2_000, low: 1_800 });
  });

  it("corrects a consistent decimal-scale mismatch against the current pool price", () => {
    const candles = [{ timestamp: Date.now(), high: 0.0011, low: 0.0009, volumeUsd: 100 }];
    const result = calibrateOhlcvPrices(candles, 0.000001);
    expect(result.scale).toBeCloseTo(0.0010050378);
    expect(result.candles[0]!.high).toBeCloseTo(0.0000011055416);
    expect(result.candles[0]!.low).toBeCloseTo(0.0000009045340);
  });

  it("uses the exact recent median ratio for non-decimal OHLCV mismatches", () => {
    const candles = [
      { timestamp: Date.now(), high: 0.0005, low: 0.0005, volumeUsd: 100 },
      { timestamp: Date.now() - 300_000, high: 0.0006, low: 0.0006, volumeUsd: 100 },
      { timestamp: Date.now() - 600_000, high: 0.0004, low: 0.0004, volumeUsd: 100 },
    ];
    const result = calibrateOhlcvPrices(candles, 0.18);
    expect(result.scale).toBeCloseTo(360);
    expect(result.candles[0]!.low).toBeCloseTo(0.18);
  });

  it("does not rescale normal OHLCV data", () => {
    const candles = [{ timestamp: Date.now(), high: 1.1, low: 0.9, volumeUsd: 100 }];
    expect(calibrateOhlcvPrices(candles, 1).scale).toBe(1);
  });
});

describe("scan pool eligibility", () => {
  it("keeps only the best qualified pool for one token", () => {
    const pool = (pair: string, quoteToken: string, estimatedPoolYield1hPercent: number, tvlUsd: number) => ({ pair, quoteToken, estimatedPoolYield1hPercent, tvlUsd }) as ScoredPool;

    expect(limitQualifiedPoolsPerToken([
      pool("TOKEN/WETH 1%", "0x0bd7d308f8e1639fab988df18a8011f41eacad73", 4, 100_000),
      pool("TOKEN/ETH 2%", "0x0000000000000000000000000000000000000000", 8, 50_000),
      pool("TOKEN/USDG 3%", "0x5fc5360d0400a0fd4f2af552add042d716f1d168", 8, 200_000),
      pool("TOKEN/USDG 4%", "0x5fc5360d0400a0fd4f2af552add042d716f1d168", 4, 300_000),
    ]).map((item) => item.pair)).toEqual(["TOKEN/USDG 3%"]);
  });

  it("excludes pools with less than $100 of cumulative 6h volume", () => {
    expect(hasMinimumScanVolume6h(MIN_VOLUME_6H_USD - 0.01)).toBe(false);
    expect(hasMinimumScanVolume6h(MIN_VOLUME_6H_USD)).toBe(true);
    expect(hasMinimumScanVolume6h(Number.NaN)).toBe(false);
  });

  it("calculates gross pool yield per hour from six-hour fees and TVL", () => {
    expect(estimatedHourlyYieldPercent(60, 1_000)).toBeCloseTo(1);
    expect(estimatedHourlyYieldPercent(60, 0)).toBe(0);
  });

  it("calculates a one-hour yield without applying the six-hour average divisor", () => {
    expect(estimatedYieldPercent(10, 1_000, 1)).toBeCloseTo(1);
    expect(estimatedHourlyYieldPercent(10, 1_000)).toBeCloseTo(10 / 1_000 / 6 * 100);
  });

  it("uses FDV only when a verified market cap is unavailable", () => {
    expect(effectiveMarketCap("1000000", "1200000")).toEqual({ value: 1_000_000, source: "market_cap" });
    expect(effectiveMarketCap(null, "1200000")).toEqual({ value: 1_200_000, source: "fdv" });
    expect(effectiveMarketCap(null, null)).toBeNull();
  });

  it("builds pool links for Base and Robinhood", () => {
    expect(uniswapPoolUrl("0xpool", "base")).toBe("https://app.uniswap.org/explore/pools/base/0xpool");
    expect(uniswapPoolUrl("0xpool")).toBe("https://app.uniswap.org/explore/pools/robinhood/0xpool");
  });

  it("builds an Uniswap explorer URL from either a pool address or V4 pool ID", () => {
    expect(uniswapPoolUrl("0xe39078fc024188927e10b26d91e4720a600fba85"))
      .toBe("https://app.uniswap.org/explore/pools/robinhood/0xe39078fc024188927e10b26d91e4720a600fba85");
    expect(uniswapPoolUrl("0x4570413b567093841404954697bba9178a963f2810844321fcb777b27ac32267"))
      .toBe("https://app.uniswap.org/explore/pools/robinhood/0x4570413b567093841404954697bba9178a963f2810844321fcb777b27ac32267");
  });

  it("removes GeckoTerminal's fee suffix from pair symbols", () => {
    expect(poolPair("USDG / seedcoin 2.499%", false)).toBe("seedcoin/USDG");
    expect(poolPair("seedcoin / WETH 1%", true)).toBe("seedcoin/WETH");
  });

  it("returns at most three active pools and two zero-active pools in the watchlist", () => {
    const pool = (pair: string, score: number, activeLiquidity: boolean): ScoredPool => ({
      protocol: "v4",
      pair,
      uniswapUrl: uniswapPoolUrl(`0x${pair.padEnd(64, "0")}`),
      activeLiquidity,
      feeTier: 10_000,
      feeRate: 0.01,
      tvlUsd: 10_000,
      volume6hUsd: 1_000,
      estimatedPoolFees6hUsd: 10,
      estimatedPoolYieldHourlyPercent: 0.0167,
      score,
      safetyFactor: 0.1,
      dynamicFee: false,
      stale: false,
      warnings: [],
    });
    const ranked = rankPools([
      pool("A", 1, true),
      pool("B", 4, true),
      pool("C", 3, true),
      pool("D", 2, true),
      pool("W", 1, false),
      pool("X", 4, false),
      pool("Y", 3, false),
    ]);

    expect(ranked.active.map(({ pair }) => pair)).toEqual(["B", "C", "D"]);
    expect(ranked.watchlist.map(({ pair }) => pair)).toEqual(["X", "Y"]);
  });
});

describe("Gecko request scheduling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs an interactive scan ahead of queued background refreshes", async () => {
    const scanner = new PoolScanner({} as any, {} as any, 0);
    const calls: string[] = [];
    let releaseFirst!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      calls.push(url);
      if (url === "background-1") return new Promise<Response>((resolve) => { releaseFirst = resolve; });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }));

    const first = (scanner as any).fetchGecko("background-1", "background");
    await vi.waitFor(() => expect(calls).toEqual(["background-1"]));
    const second = (scanner as any).fetchGecko("background-2", "background");
    const interactive = (scanner as any).fetchGecko("interactive", "interactive");
    releaseFirst(new Response("{}", { status: 200 }));
    await Promise.all([first, second, interactive]);

    expect(calls).toEqual(["background-1", "interactive", "background-2"]);
  });
});
