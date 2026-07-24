import { type Address } from "viem";

import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, QuoteToken } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import type { PoolScanner, VerifiedPool } from "./pool-scanner.js";
import {
  GEM_MAX_RESULTS,
  GEM_MIN_MARKET_CAP,
  GEM_MIN_TOKEN_VOLUME_1H,
  GEM_MIN_YIELD_1H_PERCENT,
  gemCategory,
  gemConfidence,
  gemScore as computeGemScore,
  gemWarnings,
  persistentHourlyRate,
  spotYield1hPercent,
  type GemCandidate,
} from "./gem-score.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  volume?: { h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number | null };
  marketCap?: number | null;
  fdv?: number | null;
  pairCreatedAt?: number | null;
  txns?: { h1?: { buys?: number; sells?: number } };
  priceChange?: { h1?: number; h6?: number; h24?: number };
}

export interface GemScanResult {
  candidates: GemCandidate[];
  evaluatedTokens: number;
  qualifiedTokens: number;
  warming: boolean;
}

export class GemScanner {
  constructor(
    private readonly chains: ChainClients,
    private readonly database: Database,
    private readonly poolScanner: PoolScanner,
    private readonly quoteTokens: QuoteToken[],
  ) {}

  async scan(onProgress?: (stage: string) => void): Promise<GemScanResult> {
    onProgress?.("Memuat kandidat cache...");
    const candidates = await this.database.listPoolScanCandidates(40);
    if (candidates.length === 0) {
      return { candidates: [], evaluatedTokens: 0, qualifiedTokens: 0, warming: true };
    }

    onProgress?.(`Menganalisis ${candidates.length} kandidat token via DexScreener...`);
    const enriched = await mapWithConcurrency(candidates, 4, ({ tokenAddress }) => this.scanToken(tokenAddress).catch(() => null));

    const allCandidates = enriched.flatMap((item) => item ?? []);

    const sorted = allCandidates
      .sort((a, b) => b.gemScore - a.gemScore)
      .slice(0, GEM_MAX_RESULTS);

    return {
      candidates: sorted,
      evaluatedTokens: candidates.length,
      qualifiedTokens: enriched.filter((item) => item && item.length > 0).length,
      warming: false,
    };
  }

  private async scanToken(tokenAddress: string): Promise<GemCandidate[] | null> {
    const token = tokenAddress.toLowerCase();
    const pairs = await this.fetchDexScreenerPairs(token);
    if (pairs.length === 0) return null;

    const allowedQuoteAddresses = new Set(
      this.quoteTokens
        .filter(({ symbol }) => ["USDG", "USDC", "WETH", "ETH"].includes(symbol))
        .map(({ address }) => address.toLowerCase()),
    );

    const uniswapPairs = dedupePairs(pairs.filter((p) => p.chainId === "robinhood" && p.dexId === "uniswap"));
    const tokenVolume1hUsd = uniswapPairs.reduce((sum, p) => sum + (p.volume?.h1 ?? 0), 0);

    const valuation = this.tokenValuation(pairs);
    if (!valuation || valuation.value < GEM_MIN_MARKET_CAP) return null;

    if (tokenVolume1hUsd < GEM_MIN_TOKEN_VOLUME_1H) return null;

    const lpPairs = uniswapPairs.filter((p) => {
      const protocol = p.labels?.includes("v4") ? "v4" : p.labels?.includes("v3") ? "v3" : null;
      if (!protocol) return false;
      const base = p.baseToken.address.toLowerCase();
      const quote = p.quoteToken.address.toLowerCase();
      const isTokenSide = base === token || quote === token;
      const isAllowedQuote = allowedQuoteAddresses.has(base === token ? quote : base);
      return isTokenSide && isAllowedQuote;
    });

    if (lpPairs.length === 0) return null;

    const oldestCreatedAt = uniswapPairs
      .map((p) => p.pairCreatedAt ?? 0)
      .filter((ts) => ts > 0)
      .reduce((min, ts) => Math.min(min, ts), Number.POSITIVE_INFINITY);
    const tokenOldestPoolAgeSeconds = Number.isFinite(oldestCreatedAt)
      ? Math.max(0, Math.floor((Date.now() - oldestCreatedAt) / 1_000))
      : 0;

    const results: GemCandidate[] = [];
    for (const pair of lpPairs) {
      const candidate = await this.evaluatePair(pair, token, tokenVolume1hUsd, valuation, tokenOldestPoolAgeSeconds);
      if (candidate) results.push(candidate);
    }

    if (results.length === 0) return null;

    results.sort((a, b) => b.gemScore - a.gemScore);
    return [results[0]!];
  }

  private async evaluatePair(
    pair: DexPair,
    token: string,
    tokenVolume1hUsd: number,
    valuation: { value: number; source: "market_cap" | "fdv" },
    tokenOldestPoolAgeSeconds: number,
  ): Promise<GemCandidate | null> {
    const protocol = pair.labels?.includes("v4") ? "v4" : "v3";
    const tvlUsd = Number(pair.liquidity?.usd ?? 0);
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;

    const volume1hUsd = Number(pair.volume?.h1 ?? 0);
    const volume6hUsd = Number(pair.volume?.h6 ?? 0);
    const volume24hUsd = Number(pair.volume?.h24 ?? 0);

    const verified = await this.poolScanner.verifyPool(protocol, pair.pairAddress as Address, token, "robinhood");
    if (!verified || !verified.activeLiquidity) return null;

    const feeTier = verified.feeTier ?? 0;
    const currentLpFee = verified.currentLpFee;
    const dynamicFee = protocol === "v4" && currentLpFee !== undefined && currentLpFee !== feeTier;
    const effectiveFeeRate = (currentLpFee ?? feeTier) / 1_000_000;
    if (effectiveFeeRate <= 0) return null;

    const spotYield = spotYield1hPercent(volume1hUsd, effectiveFeeRate, tvlUsd);
    if (spotYield < GEM_MIN_YIELD_1H_PERCENT) return null;

    const persistence = persistentHourlyRate({ h1: volume1hUsd, h6: volume6hUsd, h24: volume24hUsd });
    const txns1h = (pair.txns?.h1?.buys ?? 0) + (pair.txns?.h1?.sells ?? 0);
    const poolAgeSeconds = pair.pairCreatedAt
      ? Math.max(0, Math.floor((Date.now() - pair.pairCreatedAt) / 1_000))
      : tokenOldestPoolAgeSeconds;

    const priceChange1h = pair.priceChange?.h1 ?? 0;
    const priceChange6h = pair.priceChange?.h6 ?? 0;
    const priceChange24h = pair.priceChange?.h24 ?? 0;

    const hasHooks = false;
    const tvlSourceMismatch = false;

    const confidence = gemConfidence({
      persistence,
      txns1h,
      poolAgeSeconds,
      tvlUsd,
      valuationSource: valuation.source,
      dynamicFee,
      hasHooks,
      priceChange1h,
      priceChange6h,
      tvlSourceMismatch,
    });

    const score = computeGemScore(spotYield, confidence, persistence);
    const category = gemCategory(confidence, poolAgeSeconds);
    const warnings = gemWarnings({
      valuationSource: valuation.source,
      poolAgeSeconds,
      txns1h,
      persistence,
      dynamicFee,
      hasHooks,
      tvlSourceMismatch,
      priceChange1h,
      tvlUsd,
      volume1hUsd,
      tokenMarketCapUsd: valuation.value,
    });

    const baseIsToken = pair.baseToken.address.toLowerCase() === token;
    const quoteSymbol = baseIsToken ? pair.quoteToken.symbol : pair.baseToken.symbol;
    const baseSymbol = baseIsToken ? pair.baseToken.symbol : pair.quoteToken.symbol;
    const quoteToken = (baseIsToken ? pair.quoteToken.address : pair.baseToken.address).toLowerCase();
    const uniswapUrl = `https://app.uniswap.org/explore/pools/robinhood/${pair.pairAddress}`;
    const pairLabel = baseIsToken ? `${pair.baseToken.symbol}/${pair.quoteToken.symbol}` : `${pair.quoteToken.symbol}/${pair.baseToken.symbol}`;

    return {
      protocol,
      pair: pairLabel,
      quoteToken,
      poolAddress: pair.pairAddress,
      uniswapUrl,
      activeLiquidity: true,
      feeTier,
      currentLpFee,
      dynamicFee,
      tvlUsd,
      volume1hUsd,
      volume6hUsd,
      volume24hUsd,
      tokenVolume1hUsd,
      tokenMarketCapUsd: valuation.value,
      tokenValuationSource: valuation.source,
      tokenOldestPoolAgeSeconds,
      poolAgeSeconds,
      txns1h: { buys: pair.txns?.h1?.buys ?? 0, sells: pair.txns?.h1?.sells ?? 0 },
      priceChange1h,
      priceChange6h,
      priceChange24h,
      quoteSymbol,
      baseSymbol,
      spotYield1hPercent: spotYield,
      persistence,
      gemScore: score,
      confidence,
      warnings,
      category,
    };
  }

  private tokenValuation(pairs: readonly DexPair[]): { value: number; source: "market_cap" | "fdv" } | null {
    const marketCap = Math.max(...pairs.map((p) => Number(p.marketCap ?? 0)).filter(Number.isFinite), 0);
    if (marketCap > 0) return { value: marketCap, source: "market_cap" };
    const fdv = Math.max(...pairs.map((p) => Number(p.fdv ?? 0)).filter(Number.isFinite), 0);
    return fdv > 0 ? { value: fdv, source: "fdv" } : null;
  }

  private async fetchDexScreenerPairs(token: string): Promise<DexPair[]> {
    try {
      const response = await fetch(`${DEXSCREENER_BASE}/token-pairs/v1/robinhood/${token}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return [];
      const body = await response.json();
      return Array.isArray(body) ? (body as DexPair[]) : [];
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error), token }, "gem scanner: DexScreener fetch failed");
      return [];
    }
  }
}

function dedupePairs(pairs: readonly DexPair[]): DexPair[] {
  const unique = new Map<string, DexPair>();
  for (const pair of pairs) unique.set(pair.pairAddress.toLowerCase(), pair);
  return [...unique.values()];
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
