export interface CumulativeVolumes {
  h1: number;
  h6: number;
  h24: number;
}

export interface Persistence {
  hourlyRate: number;
  persistence: number;
  rates: readonly [number, number, number];
}

export interface GemCandidate {
  protocol: "v3" | "v4";
  pair: string;
  quoteToken: string;
  poolAddress: string;
  uniswapUrl: string;
  activeLiquidity: boolean;
  feeTier: number;
  currentLpFee?: number;
  dynamicFee: boolean;
  tvlUsd: number;
  volume1hUsd: number;
  volume6hUsd: number;
  volume24hUsd: number;
  tokenVolume1hUsd: number;
  tokenMarketCapUsd: number;
  tokenValuationSource: "market_cap" | "fdv";
  tokenOldestPoolAgeSeconds: number;
  poolAgeSeconds: number;
  txns1h: { buys: number; sells: number };
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  quoteSymbol: string;
  baseSymbol: string;
  spotYield1hPercent: number;
  persistence: Persistence;
  gemScore: number;
  confidence: number;
  warnings: string[];
  category: "STRONG" | "EARLY" | "DEGEN";
}

export const GEM_MIN_MARKET_CAP = 150_000;
export const GEM_MIN_TOKEN_VOLUME_1H = 30_000;
export const GEM_MIN_YIELD_1H_PERCENT = 2;
export const GEM_MAX_RESULTS = 8;

export function disjointHourlyRates(volume: CumulativeVolumes): readonly [number, number, number] | null {
  const { h1, h6, h24 } = volume;
  if (![h1, h6, h24].every(Number.isFinite)) return null;
  if (h1 < 0 || h6 < h1 || h24 < h6) return null;
  return [h1, (h6 - h1) / 5, (h24 - h6) / 18];
}

export function persistentHourlyRate(volume: CumulativeVolumes): Persistence {
  const rates = disjointHourlyRates(volume);
  if (!rates) return { hourlyRate: 0, persistence: 0, rates: [0, 0, 0] };

  const arithmetic = rates.reduce((sum, value) => sum + value, 0) / 3;
  if (arithmetic === 0 || rates.some((value) => value <= 0)) {
    return { hourlyRate: 0, persistence: 0, rates };
  }

  const harmonic = 3 / rates.reduce((sum, value) => sum + 1 / value, 0);
  return { hourlyRate: harmonic, persistence: harmonic / arithmetic, rates };
}

export function spotYield1hPercent(volume1hUsd: number, feeRate: number, tvlUsd: number): number {
  if (!Number.isFinite(volume1hUsd) || !Number.isFinite(feeRate) || !Number.isFinite(tvlUsd) || volume1hUsd < 0 || feeRate < 0 || tvlUsd <= 0) return 0;
  return (volume1hUsd * feeRate / tvlUsd) * 100;
}

export function effectiveFeeRate(feeTier: number, currentLpFee?: number): number {
  const fee = currentLpFee ?? feeTier;
  return fee > 0 ? fee / 1_000_000 : 0;
}

export function transactionCount(volumes: CumulativeVolumes): { txns1h: number; confidence: number } {
  const totalTxns1h = 0;
  return { txns1h: totalTxns1h, confidence: 0 };
}

export function gemConfidence(input: {
  persistence: Persistence;
  txns1h: number;
  poolAgeSeconds: number;
  tvlUsd: number;
  valuationSource: "market_cap" | "fdv";
  dynamicFee: boolean;
  hasHooks: boolean;
  priceChange1h: number;
  priceChange6h: number;
  tvlSourceMismatch: boolean;
}): number {
  let score = 100;
  const { persistence, txns1h, poolAgeSeconds, tvlUsd, valuationSource, dynamicFee, hasHooks, priceChange1h, priceChange6h, tvlSourceMismatch } = input;

  if (persistence.persistence < 0.1) score -= 40;
  else if (persistence.persistence < 0.3) score -= 25;
  else if (persistence.persistence < 0.5) score -= 15;
  else if (persistence.persistence < 0.7) score -= 5;

  if (txns1h < 5) score -= 30;
  else if (txns1h < 10) score -= 20;
  else if (txns1h < 20) score -= 10;
  else if (txns1h < 30) score -= 5;

  if (poolAgeSeconds < 3600) score -= 20;
  else if (poolAgeSeconds < 3_600 * 6) score -= 10;
  else if (poolAgeSeconds < 3_600 * 24) score -= 5;

  if (tvlUsd < 5_000) score -= 15;
  else if (tvlUsd < 10_000) score -= 8;

  if (valuationSource === "fdv") score -= 10;
  if (dynamicFee) score -= 5;
  if (hasHooks) score -= 10;
  if (tvlSourceMismatch) score -= 10;

  const absChange1h = Math.abs(priceChange1h);
  if (absChange1h > 100) score -= 20;
  else if (absChange1h > 50) score -= 10;
  else if (absChange1h > 25) score -= 5;

  const absChange6h = Math.abs(priceChange6h);
  if (absChange6h > 200) score -= 15;
  else if (absChange6h > 100) score -= 8;

  return Math.max(0, Math.min(100, score));
}

export function gemScore(spotYield: number, confidence: number, persistence: Persistence): number {
  if (spotYield <= 0 || confidence <= 0) return 0;
  return spotYield * (confidence / 100) * Math.max(0.1, persistence.persistence);
}

export function gemCategory(confidence: number, poolAgeSeconds: number): "STRONG" | "EARLY" | "DEGEN" {
  if (confidence >= 60 && poolAgeSeconds >= 3_600 * 24) return "STRONG";
  if (poolAgeSeconds < 3_600 * 24) return "EARLY";
  return "DEGEN";
}

export function gemWarnings(input: {
  valuationSource: "market_cap" | "fdv";
  poolAgeSeconds: number;
  txns1h: number;
  persistence: Persistence;
  dynamicFee: boolean;
  hasHooks: boolean;
  tvlSourceMismatch: boolean;
  priceChange1h: number;
  tvlUsd: number;
  volume1hUsd: number;
  tokenMarketCapUsd: number;
}): string[] {
  const warnings: string[] = [];
  const { valuationSource, poolAgeSeconds, txns1h, persistence, dynamicFee, hasHooks, tvlSourceMismatch, priceChange1h, tvlUsd, volume1hUsd, tokenMarketCapUsd } = input;

  if (valuationSource === "fdv") warnings.push("FDV AS MC");
  if (poolAgeSeconds < 3_600) warnings.push("NEW POOL");
  if (txns1h < 10) warnings.push("LOW TX COUNT");
  if (persistence.persistence < 0.3) warnings.push("1H VOLUME SPIKE");
  if (dynamicFee) warnings.push("DYNAMIC FEE");
  if (hasHooks) warnings.push("V4 HOOK");
  if (tvlSourceMismatch) warnings.push("TVL SOURCE MISMATCH");
  if (Math.abs(priceChange1h) > 50) warnings.push("EXTREME PRICE MOVE");
  if (tvlUsd > 0 && volume1hUsd > 0 && volume1hUsd / tvlUsd > 5) warnings.push("EXTREME TURNOVER");
  if (tokenMarketCapUsd > 0 && volume1hUsd > 0 && volume1hUsd / tokenMarketCapUsd > 0.5) warnings.push("HIGH MC TURNOVER");

  return warnings;
}
