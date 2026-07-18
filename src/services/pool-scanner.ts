import { isAddress, isHex, zeroAddress, type Address, type Hex } from "viem";

import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, PoolScanSettings } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { estimateConcentratedYield, fetchOhlcv, type ConcentratedEstimate } from "./concentrated-yield.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const K = 1_000_000;
const GECKO_MIN_REQUEST_INTERVAL_MS = 6_500;
const MAX_TOKEN_ENRICHMENT_CANDIDATES = 5;
const MAX_DEXSCREENER_CANDIDATES = 20;
const MAX_DEXSCREENER_POOL_VERIFICATIONS = 8;
const MAX_QUALIFIED_POOLS_PER_TOKEN = 2;
const CANDIDATE_REFRESH_MS = 15 * 60_000;
const TOKEN_SCAN_VERIFY_CONCURRENCY = 2;
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as Address;
export const MIN_VOLUME_6H_USD = 100;

export interface ScoredPool {
  protocol: "v3" | "v4";
  pair: string;
  quoteToken: Address;
  uniswapUrl: string;
  activeLiquidity: boolean;
  feeTier: number;
  feeRate: number;
  tvlUsd: number;
  volume1hUsd: number;
  volume6hUsd: number;
  estimatedPoolFees1hUsd: number;
  estimatedPoolYield1hPercent: number;
  estimatedPoolFees6hUsd: number;
  estimatedPoolYieldHourlyPercent: number;
  score: number;
  safetyFactor: number;
  dynamicFee: boolean;
  currentLpFee?: number;
  stale: boolean;
  warnings: string[];
  tokenMarketCapUsd?: number;
  tokenValuationSource?: "market_cap" | "fdv";
  tokenTotalActiveTvlUsd?: number;
  tokenOldestPoolAgeSeconds?: number;
  concentrated?: ConcentratedEstimate;
}

export interface PoolScan {
  active: ScoredPool[];
  watchlist: ScoredPool[];
}

export interface PoolScanFilters extends PoolScanSettings {
  allowedQuoteAddresses: Address[];
  candidatePages: number;
}

export interface PoolMarketScan {
  pools: ScoredPool[];
  candidateTokens: number;
  qualifiedTokens: number;
  evaluatedTokens: number;
  warming?: boolean;
}

interface VerifiedPool {
  feeTier?: number;
  currentLpFee?: number;
  activeLiquidity: boolean;
}

interface GeckoPool {
  id: string;
  type: string;
  attributes: {
    address: string;
    name: string;
    pool_name?: string;
    reserve_in_usd: string;
    pool_created_at?: string;
    volume_usd: { h1: string; h6: string; h24: string };
    base_token_price_usd?: string;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

interface GeckoTokenResponse {
  data: { attributes: { market_cap_usd?: string | null; fdv_usd?: string | null } };
}

type GeckoRequestPriority = "interactive" | "background";

interface DexScreenerPair {
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
}

export class PoolScanner {
  private marketScanCache?: { key: string; expiresAt: number; result: PoolMarketScan };
  private geckoRequestRunning = false;
  private readonly interactiveGeckoQueue: (() => void)[] = [];
  private readonly backgroundGeckoQueue: (() => void)[] = [];
  private lastGeckoRequestAt = 0;
  private geckoCooldownUntil = 0;

  constructor(
    private readonly chains: ChainClients,
    private readonly database: Database,
    private readonly geckoMinRequestIntervalMs = GECKO_MIN_REQUEST_INTERVAL_MS,
  ) {}

  async scan(tokenAddress: Address, chain: ChainName = "robinhood"): Promise<PoolScan> {
    const startedAt = Date.now();
    const normalized = tokenAddress.toLowerCase();

    const pools = await this.fetchUniswapPools(normalized, chain, "interactive");
    if (pools.length === 0) {
      log.info({ token: normalized, rawPools: 0, durationMs: Date.now() - startedAt }, "token pool scan completed");
      return { active: [], watchlist: [] };
    }

    const scored = (await mapWithConcurrency(pools, TOKEN_SCAN_VERIFY_CONCURRENCY, (raw) =>
      this.toScoredPool(raw, normalized, true, chain),
    )).filter((pool): pool is ScoredPool => pool !== null);
    const result = rankPools(scored);
    log.info({ token: normalized, rawPools: pools.length, scoredPools: scored.length, active: result.active.length, watchlist: result.watchlist.length, durationMs: Date.now() - startedAt }, "token pool scan completed");
    return result;
  }

  async scanV2(tokenAddress: Address, chain: ChainName = "robinhood", downsidePercent = 35, onProgress?: (completed: number, total: number) => void): Promise<PoolScan> {
    const normalized = tokenAddress.toLowerCase();
    const rawPools = await this.fetchUniswapPools(normalized, chain, "interactive");
    const verified = (await mapWithConcurrency(rawPools, TOKEN_SCAN_VERIFY_CONCURRENCY, (raw) => this.toScoredPool(raw, normalized, false, chain)))
      .filter((pool): pool is ScoredPool => pool !== null && pool.activeLiquidity)
      .sort((a, b) => b.volume6hUsd - a.volume6hUsd)
      .slice(0, 3);
    const activeRaw = rawPools.filter((raw) => verified.some((pool) => pool.uniswapUrl.endsWith(raw.attributes.address)));
    const scored: ScoredPool[] = [];
    let completed = 0;
    for (const raw of activeRaw) {
      const pool = verified.find((item) => item.uniswapUrl.endsWith(raw.attributes.address));
      if (!pool) continue;
      onProgress?.(completed, activeRaw.length);
      try {
        const candles = await withTimeout(fetchOhlcv(chain, raw.attributes.address as Address, tokenAddress), 30_000);
        const currentLpFee = pool.currentLpFee;
        const estimate = await estimateConcentratedYield(this.chains, chain, pool.protocol, raw.attributes.address as Address, tokenAddress, pool.feeTier, currentLpFee, downsidePercent, candles);
        if (estimate) scored.push({ ...pool, concentrated: estimate });
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error), pool: raw.attributes.address }, "concentrated yield estimate failed");
      }
      completed += 1;
    }
    onProgress?.(completed, activeRaw.length);
    const active = scored.filter((pool) => pool.activeLiquidity).sort((a, b) => b.concentrated!.yieldHourlyPercent.h6 - a.concentrated!.yieldHourlyPercent.h6);
    const watchlist = scored.filter((pool) => !pool.activeLiquidity).sort((a, b) => b.concentrated!.yieldHourlyPercent.h6 - a.concentrated!.yieldHourlyPercent.h6);
    return { active: active.slice(0, 3), watchlist: watchlist.slice(0, 2) };
  }

  startCandidateRefresh(allowedQuoteAddresses: readonly Address[], candidatePages: number): void {
    const refresh = () => void this.refreshCandidateCache(allowedQuoteAddresses, candidatePages)
      .catch((error) => log.warn({ error: error instanceof Error ? error.message : String(error) }, "pool candidate refresh failed"));
    refresh();
    setInterval(refresh, CANDIDATE_REFRESH_MS);
  }

  async scanPools(filters: PoolScanFilters, onProgress?: (stage: string) => void): Promise<PoolMarketScan> {
    const key = JSON.stringify({ ...filters, allowedQuoteAddresses: [...filters.allowedQuoteAddresses].sort() });
    if (this.marketScanCache?.key === key && this.marketScanCache.expiresAt > Date.now()) return this.marketScanCache.result;
    onProgress?.("Memuat kandidat pool cache...");
    const candidates = await this.database.listPoolScanCandidates(MAX_DEXSCREENER_CANDIDATES);
    if (candidates.length === 0) {
      return { pools: [], candidateTokens: 0, qualifiedTokens: 0, evaluatedTokens: 0, warming: true };
    }
    onProgress?.(`Mengambil data DexScreener untuk ${candidates.length} kandidat...`);
    const enriched = await mapWithConcurrency(candidates, 4, async ({ tokenAddress }) =>
      this.enrichDexScreenerToken(tokenAddress, filters),
    );
    onProgress?.("Memverifikasi pool Uniswap final on-chain...");
    const pools = enriched.flatMap((result) => limitQualifiedPoolsPerToken(result ?? []))
      .sort((left, right) => right.estimatedPoolYield1hPercent - left.estimatedPoolYield1hPercent || right.tvlUsd - left.tvlUsd)
      .slice(0, filters.maxResults);
    const result = { pools, candidateTokens: candidates.length, qualifiedTokens: enriched.filter(Boolean).length, evaluatedTokens: candidates.length };
    this.marketScanCache = { key, expiresAt: Date.now() + 60_000, result };
    return result;
  }

  private async refreshCandidateCache(allowedQuoteAddresses: readonly Address[], candidatePages: number): Promise<void> {
    const pages = Array.from({ length: candidatePages }, (_, index) => index + 1);
    const fetched = await Promise.all([
      ...pages.map((page) => this.fetchDexPools("uniswap-v3-robinhood", page, "background")),
      ...pages.map((page) => this.fetchDexPools("uniswap-v4-robinhood", page, "background")),
    ]);
    const candidates = new Map<string, number>();
    for (const pool of fetched.flat()) {
      const token = nonQuoteToken(pool, allowedQuoteAddresses);
      if (!token) continue;
      const tvlUsd = Number(pool.attributes.reserve_in_usd || "0");
      const volume1hUsd = Number(pool.attributes.volume_usd?.h1 || "0");
      const feeRate = feeRateFromName(pool.attributes.pool_name ?? pool.attributes.name);
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0 || !Number.isFinite(volume1hUsd) || volume1hUsd <= 0 || feeRate === null) continue;
      candidates.set(token, Math.max(candidates.get(token) ?? 0, estimatedYieldPercent(volume1hUsd * feeRate, tvlUsd, 1)));
    }
    if (candidates.size === 0) {
      log.warn("pool candidate refresh returned no usable pools; retaining previous cache");
      return;
    }
    await this.database.replacePoolScanCandidates([...candidates].map(([tokenAddress, seedScore]) => ({ tokenAddress, seedScore })));
    log.info({ candidates: candidates.size }, "pool scan candidate cache refreshed");
  }

  private async enrichDexScreenerToken(token: string, filters: PoolScanFilters): Promise<ScoredPool[] | null> {
    const pairs = await this.fetchDexScreenerPairs(token);
    const allowed = new Set(filters.allowedQuoteAddresses.map((address) => address.toLowerCase()));
    const relevant = pairs.filter((pair) => {
      if (pair.chainId !== "robinhood" || pair.dexId !== "uniswap") return false;
      const protocol = pair.labels?.includes("v4") ? "v4" : pair.labels?.includes("v3") ? "v3" : null;
      if (!protocol) return false;
      const base = pair.baseToken.address.toLowerCase();
      const quote = pair.quoteToken.address.toLowerCase();
      return (base === token && allowed.has(quote)) || (quote === token && allowed.has(base));
    });
    const valuation = dexValuation(relevant);
    if (!valuation || valuation.value <= filters.minMarketCapUsd) return null;

    const oldestCreatedAt = relevant
      .map((pair) => pair.pairCreatedAt ?? 0)
      .filter((createdAt) => createdAt > 0)
      .reduce((oldest, createdAt) => Math.min(oldest, createdAt), Number.POSITIVE_INFINITY);
    const oldestPoolAgeSeconds = Number.isFinite(oldestCreatedAt) ? Math.max(0, Math.floor((Date.now() - oldestCreatedAt) / 1_000)) : 0;
    if (oldestPoolAgeSeconds <= filters.minPoolAgeSeconds) return null;

    const highestActivity = [...relevant]
      .sort((left, right) => Number(right.volume?.h1 ?? 0) - Number(left.volume?.h1 ?? 0) || Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0))
      .slice(0, MAX_DEXSCREENER_POOL_VERIFICATIONS);
    const scored = (await mapWithConcurrency(highestActivity, 3, (pair) => this.toDexScreenerPool(pair, token))).filter((pool): pool is ScoredPool => pool !== null);
    const active = scored.filter((pool) => pool.activeLiquidity);
    const totalActiveTvlUsd = active.reduce((total, pool) => total + pool.tvlUsd, 0);
    if (totalActiveTvlUsd <= filters.minTotalActiveTvlUsd) return null;

    return active
      .filter((pool) => pool.tvlUsd >= filters.minPoolTvlUsd && pool.estimatedPoolYield1hPercent > filters.minYieldHourlyPercent)
      .map((pool) => ({ ...pool, tokenMarketCapUsd: valuation.value, tokenValuationSource: valuation.source, tokenTotalActiveTvlUsd: totalActiveTvlUsd, tokenOldestPoolAgeSeconds: oldestPoolAgeSeconds }));
  }

  private async fetchDexScreenerPairs(token: string): Promise<DexScreenerPair[]> {
    try {
      const response = await fetch(`${DEXSCREENER_BASE}/token-pairs/v1/robinhood/${token}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        log.warn({ status: response.status, token }, "DexScreener token pairs request failed");
        return [];
      }
      const body = await response.json();
      return Array.isArray(body) ? body as DexScreenerPair[] : [];
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error), token }, "DexScreener token pairs request failed");
      return [];
    }
  }

  private async toDexScreenerPool(pair: DexScreenerPair, token: string): Promise<ScoredPool | null> {
    const protocol = pair.labels?.includes("v4") ? "v4" : pair.labels?.includes("v3") ? "v3" : null;
    if (!protocol) return null;
    const tvlUsd = Number(pair.liquidity?.usd ?? 0);
    const volume1hUsd = Number(pair.volume?.h1 ?? 0);
    const volume6hUsd = Number(pair.volume?.h6 ?? 0);
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0 || !Number.isFinite(volume1hUsd) || volume1hUsd < 0 || !Number.isFinite(volume6hUsd) || volume6hUsd < 0) return null;
    const verified = await this.verifyPool(protocol, pair.pairAddress as Address, token, "robinhood");
    if (!verified) return null;
    const feeTier = verified.feeTier ?? 0;
    const currentLpFee = verified.currentLpFee;
    const effectiveFee = currentLpFee ?? feeTier;
    if (effectiveFee <= 0) return null;
    const feeRate = effectiveFee / 1_000_000;
    const estimatedPoolFees1hUsd = volume1hUsd * feeRate;
    const estimatedPoolFees6hUsd = volume6hUsd * feeRate;
    const baseIsToken = pair.baseToken.address.toLowerCase() === token;
    const quoteToken = (baseIsToken ? pair.quoteToken.address : pair.baseToken.address).toLowerCase() as Address;
    const warnings: string[] = [];
    const dynamicFee = protocol === "v4" && currentLpFee !== undefined && currentLpFee !== feeTier;
    if (dynamicFee) warnings.push("dynamic fee");
    if (!verified.activeLiquidity) warnings.push("zero active liquidity");
    if (volume6hUsd <= 0 && Number(pair.volume?.h24 ?? 0) > 0) warnings.push("data mungkin stale");
    const safetyFactor = Math.sqrt(tvlUsd / (tvlUsd + K));
    return {
      protocol,
      pair: baseIsToken ? `${pair.baseToken.symbol}/${pair.quoteToken.symbol}` : `${pair.quoteToken.symbol}/${pair.baseToken.symbol}`,
      quoteToken,
      uniswapUrl: uniswapPoolUrl(pair.pairAddress, "robinhood"),
      activeLiquidity: verified.activeLiquidity,
      feeTier,
      feeRate,
      tvlUsd,
      volume1hUsd,
      volume6hUsd,
      estimatedPoolFees1hUsd,
      estimatedPoolYield1hPercent: estimatedYieldPercent(estimatedPoolFees1hUsd, tvlUsd, 1),
      estimatedPoolFees6hUsd,
      estimatedPoolYieldHourlyPercent: estimatedHourlyYieldPercent(estimatedPoolFees6hUsd, tvlUsd),
      score: volume6hUsd > 0 ? (estimatedPoolFees6hUsd / tvlUsd) * safetyFactor : 0,
      safetyFactor,
      dynamicFee,
      currentLpFee,
      stale: volume6hUsd <= 0 && Number(pair.volume?.h24 ?? 0) > 0,
      warnings,
    };
  }

  private async prefilterByValuation(tokens: string[], minMarketCapUsd: number): Promise<{ qualified: string[]; valuations: Map<string, { value: number; source: "market_cap" | "fdv" }> }> {
    const results = await mapWithConcurrency(tokens, 3, async (token) => ({
      token,
      valuation: await this.fetchTokenValuation(token),
    }));
    const valuations = new Map<string, { value: number; source: "market_cap" | "fdv" }>();
    const qualified: string[] = [];
    for (const r of results) {
      if (r.valuation && r.valuation.value > minMarketCapUsd) {
        valuations.set(r.token, r.valuation);
        qualified.push(r.token);
      }
    }
    return { qualified, valuations };
  }

  private async fetchTokenValuation(token: string): Promise<{ value: number; source: "market_cap" | "fdv" } | null> {
    const tokenResponse = await this.fetchToken(token);
    return effectiveMarketCap(tokenResponse?.data.attributes.market_cap_usd, tokenResponse?.data.attributes.fdv_usd);
  }

  private async fetchUniswapPools(token: string, chain: ChainName, priority: GeckoRequestPriority = "background"): Promise<GeckoPool[]> {
    return this.fetchPools(`${GECKO_BASE}/networks/${chain}/tokens/${token}/pools?page=1`, token, priority);
  }

  private async fetchDexPools(dex: "uniswap-v3-robinhood" | "uniswap-v4-robinhood", page: number, priority: GeckoRequestPriority): Promise<GeckoPool[]> {
    return this.fetchPools(`${GECKO_BASE}/networks/robinhood/dexes/${dex}/pools?page=${page}`, `${dex}:page:${page}`, priority);
  }

  private async fetchPools(url: string, context: string, priority: GeckoRequestPriority): Promise<GeckoPool[]> {

    let response: Response;
    try {
      response = await this.fetchGecko(url, priority);
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error), context }, "GeckoTerminal request failed");
      return [];
    }

    if (!response.ok) {
      log.warn({ status: response.status, context }, "GeckoTerminal responded with error");
      return [];
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return [];
    }

    const data = Array.isArray(body) ? body : (body as Record<string, unknown>)?.data;
    if (!Array.isArray(data)) return [];

    const pools = (data as GeckoPool[]).filter((p) => {
      const dexId = p.relationships?.dex?.data?.id ?? "";
      return dexId.startsWith("uniswap-v3") || dexId.startsWith("uniswap-v4");
    });
    log.info({ context, priority, pools: pools.length }, "GeckoTerminal pool response parsed");
    return pools;
  }

  private async toScoredPool(raw: GeckoPool, token: string, requireMinimumVolume6h: boolean, chain: ChainName): Promise<ScoredPool | null> {
    const dexId = raw.relationships.dex.data.id;
    const protocol = dexId.startsWith("uniswap-v4") ? "v4" : "v3";
    const poolAddress = raw.attributes.address;

    if (!isAddress(poolAddress) && !(protocol === "v4" && isHex(poolAddress) && poolAddress.length === 66)) {
      return null;
    }

    const tvlUsd = Number(raw.attributes.reserve_in_usd || "0");
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;

    const volume6hUsd = Number(raw.attributes.volume_usd?.h6 || "0");
    if (requireMinimumVolume6h && !hasMinimumScanVolume6h(volume6hUsd)) return null;
    const volume24hUsd = Number(raw.attributes.volume_usd?.h24 || "0");
    const stale = volume24hUsd > 0 && volume6hUsd <= 0;

    const verified = await this.verifyPool(protocol, poolAddress as Address, token, chain);
    if (!verified) return null;

    let feeTier = verified.feeTier ?? 0;
    let currentLpFee: number | undefined;
    let dynamicFee = false;

    if (protocol === "v4") {
      const lpFee = verified.currentLpFee;
      if (lpFee !== undefined && lpFee !== feeTier) {
        dynamicFee = true;
        currentLpFee = lpFee;
        feeTier = lpFee;
      }
    }

    const feeRate = feeTier / 1_000_000;
    const volume1hUsd = Number(raw.attributes.volume_usd?.h1 || "0");
    const estimatedPoolFees1hUsd = volume1hUsd * feeRate;
    const estimatedPoolYield1hPercent = estimatedYieldPercent(estimatedPoolFees1hUsd, tvlUsd, 1);
    const estimatedPoolFees6hUsd = volume6hUsd * feeRate;
    const estimatedPoolYieldHourlyPercent = estimatedHourlyYieldPercent(estimatedPoolFees6hUsd, tvlUsd);
    const safetyFactor = Math.sqrt(tvlUsd / (tvlUsd + K));
    const score = (estimatedPoolFees6hUsd / tvlUsd) * safetyFactor;

    const baseId = raw.relationships.base_token.data.id;
    const isTokenBase = normalizeNetworkToken(baseId) === token;
    const quoteToken = normalizeNetworkToken(isTokenBase ? raw.relationships.quote_token.data.id : baseId) as Address;
    const pair = poolPair(raw.attributes.pool_name ?? raw.attributes.name, isTokenBase);

    const warnings: string[] = [];
    if (stale) warnings.push("data mungkin stale");
    if (dynamicFee) warnings.push("dynamic fee");
    if (!verified.activeLiquidity) warnings.push("zero active liquidity");

    return {
      protocol,
      pair,
      quoteToken,
      uniswapUrl: uniswapPoolUrl(poolAddress, chain),
      activeLiquidity: verified.activeLiquidity,
      feeTier: verified.feeTier ?? 0,
      feeRate,
      tvlUsd,
      volume1hUsd,
      volume6hUsd,
      estimatedPoolFees1hUsd,
      estimatedPoolYield1hPercent,
      estimatedPoolFees6hUsd,
      estimatedPoolYieldHourlyPercent,
      score,
      safetyFactor,
      dynamicFee,
      currentLpFee,
      stale,
      warnings,
    };
  }

  private async enrichToken(
    token: string,
    filters: PoolScanFilters,
    preValuation?: { value: number; source: "market_cap" | "fdv" },
  ): Promise<ScoredPool[] | null> {
    const rawPools = await this.fetchUniswapPools(token, "robinhood", "background");
    const valuation = preValuation ?? await this.fetchTokenValuation(token);
    if (!valuation || valuation.value <= filters.minMarketCapUsd) return null;
    const relevantRaw = rawPools.filter((pool) => nonQuoteToken(pool, filters.allowedQuoteAddresses) === token);
    if (relevantRaw.length === 0) return null;
    const scored = (await mapWithConcurrency(relevantRaw, 3, (pool) => this.toScoredPool(pool, token, false, "robinhood"))).filter((pool): pool is ScoredPool => pool !== null);
    const active = scored.filter((pool) => pool.activeLiquidity);
    const totalActiveTvlUsd = active.reduce((total, pool) => total + pool.tvlUsd, 0);
    const oldestCreatedAt = relevantRaw
      .map((pool) => Date.parse(pool.attributes.pool_created_at ?? ""))
      .filter(Number.isFinite)
      .reduce((oldest, createdAt) => Math.min(oldest, createdAt), Number.POSITIVE_INFINITY);
    const oldestPoolAgeSeconds = Number.isFinite(oldestCreatedAt) ? Math.max(0, Math.floor((Date.now() - oldestCreatedAt) / 1_000)) : 0;
    if (totalActiveTvlUsd <= filters.minTotalActiveTvlUsd || oldestPoolAgeSeconds <= filters.minPoolAgeSeconds) return null;
    return active
      .filter((pool) => pool.tvlUsd >= filters.minPoolTvlUsd && pool.estimatedPoolYield1hPercent > filters.minYieldHourlyPercent)
      .map((pool) => ({ ...pool, tokenMarketCapUsd: valuation.value, tokenValuationSource: valuation.source, tokenTotalActiveTvlUsd: totalActiveTvlUsd, tokenOldestPoolAgeSeconds: oldestPoolAgeSeconds }));
  }

  private async fetchToken(token: string): Promise<GeckoTokenResponse | null> {
    try {
      const response = await this.fetchGecko(`${GECKO_BASE}/networks/robinhood/tokens/${token}`, "background");
      if (!response.ok) return null;
      return await response.json() as GeckoTokenResponse;
    } catch {
      return null;
    }
  }

  private async fetchGecko(url: string, priority: GeckoRequestPriority): Promise<Response> {
    const queuedAt = Date.now();
    await this.acquireGeckoSlot(priority);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const wait = Math.max(
          this.geckoMinRequestIntervalMs - (Date.now() - this.lastGeckoRequestAt),
          this.geckoCooldownUntil - Date.now(),
        );
        if (wait > 0) await sleep(wait);
        this.lastGeckoRequestAt = Date.now();
        const requestedAt = Date.now();
        const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if (response.status !== 429 || attempt === 1) {
          log.info({ priority, queueWaitMs: requestedAt - queuedAt, requestMs: Date.now() - requestedAt, status: response.status }, "GeckoTerminal request completed");
          return response;
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        this.geckoCooldownUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 60_000);
        log.warn({ cooldownSeconds: Math.ceil((this.geckoCooldownUntil - Date.now()) / 1_000) }, "GeckoTerminal rate-limited; retrying after cooldown");
      }
      throw new Error("GeckoTerminal retry loop ended unexpectedly");
    } finally {
      this.releaseGeckoSlot();
    }
  }

  private async acquireGeckoSlot(priority: GeckoRequestPriority): Promise<void> {
    if (!this.geckoRequestRunning) {
      this.geckoRequestRunning = true;
      return;
    }
    await new Promise<void>((resolve) => {
      (priority === "interactive" ? this.interactiveGeckoQueue : this.backgroundGeckoQueue).push(resolve);
    });
  }

  private releaseGeckoSlot(): void {
    const next = this.interactiveGeckoQueue.shift() ?? this.backgroundGeckoQueue.shift();
    if (next) {
      next();
      return;
    }
    this.geckoRequestRunning = false;
  }

  private async verifyPool(
    protocol: "v3" | "v4",
    poolAddress: Address,
    searchToken: string,
    chain: ChainName,
  ): Promise<VerifiedPool | null> {
    if (protocol === "v3") return this.verifyV3Pool(poolAddress, searchToken, chain);
    return this.verifyV4Pool(poolAddress, searchToken, chain);
  }

  private async verifyV3Pool(pool: Address, searchToken: string, chain: ChainName): Promise<VerifiedPool | null> {
    const { client, registry } = this.chains.getForScan(chain);
    try {
      const [token0, token1, fee, liquidity] = await Promise.all([
        client.readContract({
          address: pool, abi: [{ name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
          functionName: "token0",
        }),
        client.readContract({
          address: pool, abi: [{ name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
          functionName: "token1",
        }),
        client.readContract({
          address: pool, abi: [{ name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }],
          functionName: "fee",
        }),
        client.readContract({
          address: pool, abi: [{ name: "liquidity", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] }],
          functionName: "liquidity",
        }),
      ]);

      const t0 = (token0 as string).toLowerCase();
      const t1 = (token1 as string).toLowerCase();
      if (t0 !== searchToken && t1 !== searchToken) return null;

      const factoryPool = await client.readContract({
        address: registry.contracts.v3.factory,
        abi: [{ name: "getPool", type: "function", stateMutability: "view", inputs: [
          { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "fee", type: "uint24" },
        ], outputs: [{ type: "address" }] }],
        functionName: "getPool",
        args: [token0, token1, fee],
      });

      if ((factoryPool as string).toLowerCase() !== pool.toLowerCase()) return null;

      return { feeTier: Number(fee), activeLiquidity: liquidity > 0n };
    } catch {
      return null;
    }
  }

  private async verifyV4Pool(
    poolId: Address,
    searchToken: string,
    chain: ChainName,
  ): Promise<VerifiedPool | null> {
    if (!isHex(poolId) || poolId.length !== 66) return null;

    const { client, registry } = this.chains.getForScan(chain);
    const { stateView, positionManager } = registry.contracts.v4;

    try {
      const [slot0, liquidity] = await Promise.all([
        client.readContract({
          address: stateView,
          abi: [{ name: "getSlot0", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
            { type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" },
          ] }],
          functionName: "getSlot0",
          args: [poolId as Hex],
        }),
        client.readContract({
          address: stateView,
          abi: [{ name: "getLiquidity", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint128" }] }],
          functionName: "getLiquidity",
          args: [poolId as Hex],
        }),
      ]);

      const bytes25 = (poolId as Hex).slice(0, 2 + 25 * 2) as Hex;
      const poolKeyResult = await client.readContract({
        address: positionManager,
        abi: [{ name: "poolKeys", type: "function", stateMutability: "view", inputs: [{ type: "bytes25" }], outputs: [
          { name: "poolKey", type: "tuple", components: [
            { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ] },
        ] }],
        functionName: "poolKeys",
        args: [bytes25],
      });
      const poolKey = poolKeyResult as {
        currency0: string;
        currency1: string;
        fee: number;
        tickSpacing: number;
        hooks: string;
      };

      const c0 = String(poolKey.currency0).toLowerCase();
      const c1 = String(poolKey.currency1).toLowerCase();
      if (c0 !== searchToken && c1 !== searchToken) return null;

      return {
        feeTier: Number(poolKey.fee),
        currentLpFee: Number(slot0[3]),
        activeLiquidity: liquidity > 0n,
      };
    } catch {
      return null;
    }
  }
}

export function hasMinimumScanVolume6h(volume6hUsd: number): boolean {
  return Number.isFinite(volume6hUsd) && volume6hUsd >= MIN_VOLUME_6H_USD;
}

export function estimatedHourlyYieldPercent(estimatedPoolFees6hUsd: number, tvlUsd: number): number {
  return estimatedYieldPercent(estimatedPoolFees6hUsd, tvlUsd, 6);
}

export function estimatedYieldPercent(estimatedPoolFeesUsd: number, tvlUsd: number, hours: number): number {
  if (!Number.isFinite(estimatedPoolFeesUsd) || !Number.isFinite(tvlUsd) || !Number.isFinite(hours) || tvlUsd <= 0 || hours <= 0) return 0;
  return (estimatedPoolFeesUsd / tvlUsd / hours) * 100;
}

export function effectiveMarketCap(marketCapUsd?: string | null, fdvUsd?: string | null): { value: number; source: "market_cap" | "fdv" } | null {
  const marketCap = Number(marketCapUsd);
  if (Number.isFinite(marketCap) && marketCap > 0) return { value: marketCap, source: "market_cap" };
  const fdv = Number(fdvUsd);
  if (Number.isFinite(fdv) && fdv > 0) return { value: fdv, source: "fdv" };
  return null;
}

function dexValuation(pairs: readonly DexScreenerPair[]): { value: number; source: "market_cap" | "fdv" } | null {
  const marketCap = Math.max(...pairs.map((pair) => Number(pair.marketCap ?? 0)).filter(Number.isFinite), 0);
  if (marketCap > 0) return { value: marketCap, source: "market_cap" };
  const fdv = Math.max(...pairs.map((pair) => Number(pair.fdv ?? 0)).filter(Number.isFinite), 0);
  return fdv > 0 ? { value: fdv, source: "fdv" } : null;
}

export function uniswapPoolUrl(poolIdentifier: string, chain: ChainName = "robinhood"): string {
  return `https://app.uniswap.org/explore/pools/${chain}/${poolIdentifier}`;
}

function normalizeNetworkToken(value: string): string {
  const separator = value.indexOf("_");
  return (separator >= 0 ? value.slice(separator + 1) : value).toLowerCase();
}

export function poolPair(poolName: string, tokenIsBase: boolean): string {
  const [baseSymbol = "?", quoteSymbol = "?"] = poolName.split(" / ");
  const clean = (symbol: string) => symbol.replace(/\s+\d+(?:\.\d+)?%$/, "");
  return tokenIsBase
    ? `${clean(baseSymbol)}/${clean(quoteSymbol)}`
    : `${clean(quoteSymbol)}/${clean(baseSymbol)}`;
}

export function rankPools(pools: ScoredPool[]): PoolScan {
  const byScore = (a: ScoredPool, b: ScoredPool) => b.score - a.score;
  return {
    active: pools.filter((pool) => pool.activeLiquidity).sort(byScore).slice(0, 3),
    watchlist: pools.filter((pool) => !pool.activeLiquidity).sort(byScore).slice(0, 2),
  };
}

export function limitQualifiedPoolsPerToken(pools: readonly ScoredPool[]): ScoredPool[] {
  const best = new Map<"native" | "usdg", ScoredPool>();
  for (const pool of [...pools].sort(compareQualifiedPool)) {
    const bucket = quoteBucket(pool.quoteToken);
    if (bucket && !best.has(bucket)) best.set(bucket, pool);
  }
  return [...best.values()].sort(compareQualifiedPool).slice(0, MAX_QUALIFIED_POOLS_PER_TOKEN);
}

function compareQualifiedPool(left: ScoredPool, right: ScoredPool): number {
  return right.estimatedPoolYield1hPercent - left.estimatedPoolYield1hPercent || right.tvlUsd - left.tvlUsd;
}

function quoteBucket(quoteToken: Address): "native" | "usdg" | null {
  const normalized = quoteToken.toLowerCase();
  if (normalized === USDG) return "usdg";
  if (normalized === WETH || normalized === zeroAddress) return "native";
  return null;
}

function nonQuoteToken(pool: GeckoPool, allowedQuotes: readonly Address[]): string | null {
  const base = pool.relationships.base_token.data.id.replace("robinhood_", "").toLowerCase();
  const quote = pool.relationships.quote_token.data.id.replace("robinhood_", "").toLowerCase();
  const allowed = new Set(allowedQuotes.map((address) => address.toLowerCase()));
  const baseIsQuote = allowed.has(base);
  const quoteIsQuote = allowed.has(quote);
  if (baseIsQuote === quoteIsQuote) return null;
  return baseIsQuote ? quote : base;
}

function feeRateFromName(name: string): number | null {
  const match = name.match(/\s(\d+(?:\.\d+)?)%$/);
  if (!match?.[1]) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) && percent >= 0 ? percent / 100 : null;
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`concentrated pool timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
