import { describe, expect, it } from "vitest";

import {
  disjointHourlyRates,
  persistentHourlyRate,
  spotYield1hPercent,
  gemConfidence,
  gemScore,
  gemCategory,
  gemWarnings,
  GEM_MIN_MARKET_CAP,
  GEM_MIN_TOKEN_VOLUME_1H,
  GEM_MIN_YIELD_1H_PERCENT,
} from "../src/services/gem-score.js";

describe("gem-score: disjoint hourly rates", () => {
  it("splits cumulative volumes into disjoint windows", () => {
    const rates = disjointHourlyRates({ h1: 100, h6: 600, h24: 2400 });
    expect(rates).toEqual([100, 100, 100]);
  });

  it("handles bursty volume where h1 dominates", () => {
    const rates = disjointHourlyRates({ h1: 500, h6: 600, h24: 700 });
    expect(rates).toEqual([500, 20, 5.555555555555555]);
  });

  it("returns null for invalid monotonicity", () => {
    expect(disjointHourlyRates({ h1: 100, h6: 50, h24: 200 })).toBeNull();
    expect(disjointHourlyRates({ h1: -1, h6: 0, h24: 0 })).toBeNull();
  });
});

describe("gem-score: persistence", () => {
  it("returns high persistence for consistent volume", () => {
    const result = persistentHourlyRate({ h1: 100, h6: 600, h24: 2400 });
    expect(result.persistence).toBeCloseTo(1, 5);
    expect(result.hourlyRate).toBeCloseTo(100, 5);
  });

  it("returns low persistence for bursty volume", () => {
    const result = persistentHourlyRate({ h1: 500, h6: 600, h24: 700 });
    expect(result.persistence).toBeLessThan(0.2);
    expect(result.hourlyRate).toBeLessThan(50);
  });

  it("returns zero persistence when volume is zero", () => {
    const result = persistentHourlyRate({ h1: 0, h6: 0, h24: 0 });
    expect(result.persistence).toBe(0);
    expect(result.hourlyRate).toBe(0);
  });
});

describe("gem-score: spot yield", () => {
  it("calculates pool-wide gross yield", () => {
    const yield1h = spotYield1hPercent(10_000, 0.003, 50_000);
    expect(yield1h).toBeCloseTo(0.06, 5);
  });

  it("returns zero for invalid inputs", () => {
    expect(spotYield1hPercent(100, 0.003, 0)).toBe(0);
    expect(spotYield1hPercent(-1, 0.003, 1000)).toBe(0);
  });

  it("passes 2% threshold with correct volume/TVL ratio", () => {
    const yieldAt2Pct = spotYield1hPercent(10_000, 0.01, 5_000);
    expect(yieldAt2Pct).toBeCloseTo(2, 5);
  });
});

describe("gem-score: confidence", () => {
  it("starts at 100 and penalizes risk factors", () => {
    const score = gemConfidence({
      persistence: { hourlyRate: 100, persistence: 0.9, rates: [100, 100, 100] },
      txns1h: 50,
      poolAgeSeconds: 86_400 * 7,
      tvlUsd: 50_000,
      valuationSource: "market_cap",
      dynamicFee: false,
      hasHooks: false,
      priceChange1h: 5,
      priceChange6h: 10,
      tvlSourceMismatch: false,
    });
    expect(score).toBe(100);
  });

  it("heavily penalizes FDV-only, burst volume and new pools", () => {
    const score = gemConfidence({
      persistence: { hourlyRate: 100, persistence: 0.05, rates: [500, 20, 6] },
      txns1h: 3,
      poolAgeSeconds: 1_800,
      tvlUsd: 3_000,
      valuationSource: "fdv",
      dynamicFee: true,
      hasHooks: true,
      priceChange1h: 75,
      priceChange6h: 150,
      tvlSourceMismatch: true,
    });
    expect(score).toBeLessThan(20);
  });
});

describe("gem-score: gemScore", () => {
  it("combines yield, confidence and persistence", () => {
    const score = gemScore(5, 80, { hourlyRate: 100, persistence: 0.8, rates: [100, 100, 100] });
    expect(score).toBeCloseTo(5 * 0.8 * 0.8, 5);
  });

  it("returns zero for invalid inputs", () => {
    expect(gemScore(0, 100, { hourlyRate: 100, persistence: 1, rates: [100, 100, 100] })).toBe(0);
    expect(gemScore(5, 0, { hourlyRate: 100, persistence: 1, rates: [100, 100, 100] })).toBe(0);
  });
});

describe("gem-score: category", () => {
  it("classifies STRONG for high confidence old pools", () => {
    expect(gemCategory(80, 86_400 * 3)).toBe("STRONG");
  });

  it("classifies EARLY for new pools regardless of confidence", () => {
    expect(gemCategory(90, 1_800)).toBe("EARLY");
  });

  it("classifies DEGEN for low confidence old pools", () => {
    expect(gemCategory(30, 86_400 * 10)).toBe("DEGEN");
  });
});

describe("gem-score: warnings", () => {
  it("flags FDV-only valuation", () => {
    const warnings = gemWarnings({
      valuationSource: "fdv",
      poolAgeSeconds: 86_400,
      txns1h: 50,
      persistence: { hourlyRate: 100, persistence: 0.9, rates: [100, 100, 100] },
      dynamicFee: false,
      hasHooks: false,
      tvlSourceMismatch: false,
      priceChange1h: 5,
      tvlUsd: 50_000,
      volume1hUsd: 1_000,
      tokenMarketCapUsd: 500_000,
    });
    expect(warnings).toContain("FDV AS MC");
  });

  it("flags burst volume and new pool", () => {
    const warnings = gemWarnings({
      valuationSource: "market_cap",
      poolAgeSeconds: 1_800,
      txns1h: 5,
      persistence: { hourlyRate: 100, persistence: 0.05, rates: [500, 20, 6] },
      dynamicFee: false,
      hasHooks: false,
      tvlSourceMismatch: false,
      priceChange1h: 5,
      tvlUsd: 50_000,
      volume1hUsd: 1_000,
      tokenMarketCapUsd: 500_000,
    });
    expect(warnings).toContain("NEW POOL");
    expect(warnings).toContain("LOW TX COUNT");
    expect(warnings).toContain("1H VOLUME SPIKE");
  });
});

describe("gem-score: constants", () => {
  it("uses agreed hard filter thresholds", () => {
    expect(GEM_MIN_MARKET_CAP).toBe(150_000);
    expect(GEM_MIN_TOKEN_VOLUME_1H).toBe(30_000);
    expect(GEM_MIN_YIELD_1H_PERCENT).toBe(2);
  });
});
