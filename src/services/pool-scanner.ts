import { isAddress, isHex, zeroAddress, type Address, type Hex } from "viem";

import { chainRegistry, isEligibleScanDex } from "../chains.js";
import type { Database } from "../db.js";
import { log } from "../log.js";
import type { ChainName, PoolScanSettings } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { isDynamicFee, v4PoolId } from "./v4-pool.js";
import { v3Deployments, type DexName } from "./v3-deployment.js";
import { estimateConcentratedYield, fetchOhlcv, type ConcentratedEstimate } from "./concentrated-yield.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const K = 1_000_000;
const GECKO_MIN_REQUEST_INTERVAL_MS = 6_500;
const MAX_TOKEN_ENRICHMENT_CANDIDATES = 5;
const MAX_DEXSCREENER_CANDIDATES = 20;
const MAX_DEXSCREENER_POOL_VERIFICATIONS = 8;
const MAX_QUALIFIED_POOLS_PER_TOKEN = 1;
const CANDIDATE_REFRESH_MS = 15 * 60_000;
const TOKEN_SCAN_VERIFY_CONCURRENCY = 2;
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as Address;
export const MIN_VOLUME_6H_USD = 100;
export const STOCK_MIN_VOLUME_24H_USD = 100_000;
const STOCK_MAX_RESULTS = 10;
const STOCK_VERIFY_CONCURRENCY = 3;
const STOCK_VOLUME_BATCH = 25;
const STOCK_LIST_MAX_PAGES = 8;
const BLOCKSCOUT_TOKENS = "https://robinhoodchain.blockscout.com/api/v2/tokens";
const STOCK_VOLUME_QUOTES = new Set<string>([USDG, WETH, zeroAddress]);
const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";
const BSC_USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
const BSC_WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BSC_STOCK_VOLUME_QUOTES = new Set<string>([BSC_USDT, BSC_USDC, BSC_WBNB, zeroAddress]);
const BSC_STOCK_DEX_IDS = ["pancakeswap", "uniswap"] as const;
const BSC_STOCK_MIN_PRICE_USD = 1;
export const BSC_STOCK_SEEDS: readonly { address: Address; symbol: string }[] = [
  { address: "0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1", symbol: "SPCXB" },
  { address: "0x205812CdBed920aFf76C6580abD681a46D11efc7", symbol: "QQQB" },
  { address: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436", symbol: "NVDAB" },
  { address: "0x7138b48df7D98D7e3cc221BfE7192D0a178182D8", symbol: "SPYB" },
];

export const ROBINHOOD_STOCK_TOKENS: readonly { address: Address; symbol: string }[] = [
  { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA" },
  { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL" },
  { address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", symbol: "GME" },
  { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", symbol: "TSLA" },
  { address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", symbol: "MSFT" },
  { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", symbol: "GOOGL" },
  { address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", symbol: "MU" },
  { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", symbol: "SPY" },
  { address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", symbol: "SPCX" },
  { address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", symbol: "PLTR" },
  { address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", symbol: "INTC" },
  { address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", symbol: "AMZN" },
  { address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", symbol: "AMD" },
];

const BSC_STOCK_TICKERS = [
  ...new Set([
    ...ROBINHOOD_STOCK_TOKENS.map((stock) => stock.symbol),
    "QQQ", "USO", "SLV", "SGOV", "META", "COIN", "COST", "NFLX", "ORCL", "TSM", "BABA", "RDDT", "CRCL", "CRWV", "BE", "SNDK",
  ]),
];

export interface ScoredPool {
  protocol: "v3" | "v4";
  dex?: "uniswap" | "pancake";
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
  chain: ChainName;
  allowedQuoteAddresses: Address[];
  candidatePages: number;
}

export interface PoolMarketScan {
  pools: ScoredPool[];
  candidateTokens: number;
  qualifiedTokens: number;
  evaluatedTokens: number;
  warming?: boolean;
  stockSymbols?: string[];
  chain?: ChainName;
}

export interface VerifiedPool {
  feeTier?: number;
  currentLpFee?: number;
  activeLiquidity: boolean;
  hooks?: string;
  tickSpacing?: number;
  dex?: DexName;
}

export interface InvestigateResult {
  chain: ChainName;
  protocol: "v3" | "v4";
  pairAddress: string;
  hooks?: string;
  pair: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  feeTier: number;
  currentLpFee?: number;
  dynamicFee: boolean;
  activeLiquidity: boolean;
  tvlUsd: number;
  volume1hUsd: number;
  volume6hUsd: number;
  volume24hUsd: number;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  pairCreatedAt: number | null;
  txns1h: { buys: number; sells: number };
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  priceUsd: string | null;
  dexScreenerFound: boolean;
  marketSource?: "dexscreener" | "geckoterminal";
}

interface DexScreenerPairDetail {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name?: string; symbol: string };
  quoteToken: { address: string; name?: string; symbol: string };
  priceNative?: string;
  priceUsd?: string | null;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number> | null;
  liquidity?: { usd?: number | null; base?: number; quote?: number } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
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
    volume_usd: { h1?: string; h6?: string; h24?: string };
    base_token_price_usd?: string;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    price_change_percentage?: { h1?: string; h6?: string; h24?: string };
    transactions?: { h1?: { buys?: number; sells?: number } };
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

interface GeckoIncludedToken {
  id: string;
  type: string;
  attributes?: { address?: string; symbol?: string; name?: string };
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
  priceUsd?: string | number;
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

    const dexTvlMap = await this.buildDexScreenerTvlMap(normalized, chain);
    const scored = (await mapWithConcurrency(pools, TOKEN_SCAN_VERIFY_CONCURRENCY, (raw) =>
      this.toScoredPool(raw, normalized, true, chain, dexTvlMap, "execution"),
    )).filter((pool): pool is ScoredPool => pool !== null);
    const result = rankPools(scored);
    log.info({ token: normalized, rawPools: pools.length, scoredPools: scored.length, active: result.active.length, watchlist: result.watchlist.length, durationMs: Date.now() - startedAt }, "token pool scan completed");
    return result;
  }

  async scanV2(tokenAddress: Address, chain: ChainName = "robinhood", downsidePercent = 35, onProgress?: (completed: number, total: number) => void): Promise<PoolScan> {
    const normalized = tokenAddress.toLowerCase();
    const rawPools = await this.fetchUniswapPools(normalized, chain, "interactive");
    const dexTvlMap = await this.buildDexScreenerTvlMap(normalized, chain);
    const verified = (await mapWithConcurrency(rawPools, TOKEN_SCAN_VERIFY_CONCURRENCY, (raw) => this.toScoredPool(raw, normalized, false, chain, dexTvlMap)))
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

  startCandidateRefresh(chain: ChainName, allowedQuoteAddresses: readonly Address[], candidatePages: number): void {
    const refresh = () => void this.refreshCandidateCache(chain, allowedQuoteAddresses, candidatePages)
      .catch((error) => log.warn({ chain, error: error instanceof Error ? error.message : String(error) }, "pool candidate refresh failed"));
    refresh();
    setInterval(refresh, CANDIDATE_REFRESH_MS);
  }

  async scanPools(filters: PoolScanFilters, onProgress?: (stage: string) => void): Promise<PoolMarketScan> {
    const key = JSON.stringify({ ...filters, allowedQuoteAddresses: [...filters.allowedQuoteAddresses].sort() });
    if (this.marketScanCache?.key === key && this.marketScanCache.expiresAt > Date.now()) return this.marketScanCache.result;
    onProgress?.("Memuat kandidat pool cache...");
    const candidates = await this.database.listPoolScanCandidates(filters.chain, MAX_DEXSCREENER_CANDIDATES);
    if (candidates.length === 0) {
      return { pools: [], candidateTokens: 0, qualifiedTokens: 0, evaluatedTokens: 0, warming: true, chain: filters.chain };
    }
    onProgress?.(`Mengambil data DexScreener untuk ${candidates.length} kandidat...`);
    const enriched = await mapWithConcurrency(candidates, 4, async ({ tokenAddress }) =>
      this.enrichDexScreenerToken(tokenAddress, filters),
    );
    onProgress?.("Memverifikasi pool final on-chain...");
    const pools = enriched.flatMap((result) => limitQualifiedPoolsPerToken(result ?? []))
      .sort((left, right) => right.estimatedPoolYield1hPercent - left.estimatedPoolYield1hPercent || right.tvlUsd - left.tvlUsd)
      .slice(0, filters.maxResults);
    const result = { pools, candidateTokens: candidates.length, qualifiedTokens: enriched.filter(Boolean).length, evaluatedTokens: candidates.length, chain: filters.chain };
    this.marketScanCache = { key, expiresAt: Date.now() + 60_000, result };
    return result;
  }

  private async refreshCandidateCache(chain: ChainName, allowedQuoteAddresses: readonly Address[], candidatePages: number): Promise<void> {
    const pages = Array.from({ length: candidatePages }, (_, index) => index + 1);
    const fetched = await Promise.all(marketScanDexIds(chain).flatMap((dexId) => pages.map((page) => this.fetchDexPools(dexId, page, "background", chain))));
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
    await this.database.replacePoolScanCandidates(chain, [...candidates].map(([tokenAddress, seedScore]) => ({ tokenAddress, seedScore })));
    log.info({ chain, candidates: candidates.size }, "pool scan candidate cache refreshed");
  }

  private async enrichDexScreenerToken(token: string, filters: PoolScanFilters): Promise<ScoredPool[] | null> {
    const pairs = await this.fetchDexScreenerPairs(token, filters.chain);
    const allowed = new Set(filters.allowedQuoteAddresses.map((address) => address.toLowerCase()));
    const relevant = dedupeDexScreenerPairs(pairs.filter((pair) => {
      if (!isMarketScanPair(pair, filters.chain)) return false;
      const base = pair.baseToken.address.toLowerCase();
      const quote = pair.quoteToken.address.toLowerCase();
      return (base === token && allowed.has(quote)) || (quote === token && allowed.has(base));
    }));
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
    const hasMissingTvl = highestActivity.some((pair) => !Number(pair.liquidity?.usd ?? 0));
    const geckoTvlFallback = hasMissingTvl ? await this.buildGeckoTvlMap(token, filters.chain) : undefined;
    const scored = (await mapWithConcurrency(highestActivity, 3, (pair) => this.toDexScreenerPool(pair, token, geckoTvlFallback, filters.chain))).filter((pool): pool is ScoredPool => pool !== null);
    const active = scored.filter((pool) => pool.activeLiquidity);
    const totalActiveTvlUsd = active.reduce((total, pool) => total + pool.tvlUsd, 0);
    if (totalActiveTvlUsd <= filters.minTotalActiveTvlUsd) return null;

    return active
      .filter((pool) => pool.tvlUsd >= filters.minPoolTvlUsd && pool.estimatedPoolYield1hPercent > filters.minYieldHourlyPercent)
      .map((pool) => ({ ...pool, tokenMarketCapUsd: valuation.value, tokenValuationSource: valuation.source, tokenTotalActiveTvlUsd: totalActiveTvlUsd, tokenOldestPoolAgeSeconds: oldestPoolAgeSeconds }));
  }

  private async fetchDexScreenerPairs(token: string, chain: ChainName = "robinhood"): Promise<DexScreenerPair[]> {
    try {
      const response = await fetch(`${DEXSCREENER_BASE}/token-pairs/v1/${chainRegistry[chain].dexScreenerChain}/${token}`, {
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

  private async toDexScreenerPool(pair: DexScreenerPair, token: string, geckoTvlFallback?: Map<string, number>, chain: ChainName = "robinhood"): Promise<ScoredPool | null> {
    const protocol = stockPairProtocol(pair);
    if (!protocol) return null;
    const dexTvl = Number(pair.liquidity?.usd ?? 0);
    const tvlUsd = dexTvl > 0 ? dexTvl : (geckoTvlFallback?.get(pair.pairAddress.toLowerCase()) ?? 0);
    const volume1hUsd = Number(pair.volume?.h1 ?? 0);
    const volume6hUsd = Number(pair.volume?.h6 ?? 0);
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0 || !Number.isFinite(volume1hUsd) || volume1hUsd < 0 || !Number.isFinite(volume6hUsd) || volume6hUsd < 0) return null;
    const verified = await this.verifyPool(protocol, pair.pairAddress as Address, token, chain);
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
      dex: verified.dex,
      pair: baseIsToken ? `${pair.baseToken.symbol}/${pair.quoteToken.symbol}` : `${pair.quoteToken.symbol}/${pair.baseToken.symbol}`,
      quoteToken,
      uniswapUrl: verified.dex === "pancake"
        ? `https://pancakeswap.finance/liquidity/pool/bsc/${pair.pairAddress}`
        : uniswapPoolUrl(pair.pairAddress, chain),
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
    return this.fetchPools(`${GECKO_BASE}/networks/${chainRegistry[chain].geckoNetwork}/tokens/${token}/pools?page=1`, token, priority);
  }

  private async fetchDexPools(dex: string, page: number, priority: GeckoRequestPriority, chain: ChainName): Promise<GeckoPool[]> {
    return this.fetchPools(`${GECKO_BASE}/networks/${chainRegistry[chain].geckoNetwork}/dexes/${dex}/pools?page=${page}`, `${dex}:page:${page}`, priority);
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

    const chain = context.startsWith("uniswap") ? "robinhood" : Object.values(chainRegistry).find((registry) => context.includes(registry.geckoNetwork))?.name ?? "robinhood";
    const registry = /\/networks\/([^/]+)\//.exec(url);
    const network = registry?.[1];
    const scanRegistry = Object.values(chainRegistry).find((item) => item.geckoNetwork === network) ?? chainRegistry[chain];
    const pools = (data as GeckoPool[]).filter((p) => isEligibleScanDex(scanRegistry, p.relationships?.dex?.data?.id ?? ""));
    log.info({ context, priority, pools: pools.length }, "GeckoTerminal pool response parsed");
    return pools;
  }

  private async buildDexScreenerTvlMap(token: string, chain: ChainName = "robinhood"): Promise<Map<string, number>> {
    const pairs = await this.fetchDexScreenerPairs(token, chain);
    const map = new Map<string, number>();
    for (const pair of pairs) {
      const usd = Number(pair.liquidity?.usd ?? 0);
      if (Number.isFinite(usd) && usd > 0) {
        map.set(pair.pairAddress.toLowerCase(), usd);
      }
    }
    return map;
  }

  async buildGeckoTvlMap(token: string, chain: ChainName = "robinhood"): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    let pools: GeckoPool[];
    try {
      pools = await this.fetchUniswapPools(token, chain, "background");
    } catch {
      return map;
    }
    for (const pool of pools) {
      const usd = Number(pool.attributes.reserve_in_usd || "0");
      if (Number.isFinite(usd) && usd > 0) {
        map.set(pool.attributes.address.toLowerCase(), usd);
      }
    }
    return map;
  }

  private async toScoredPool(raw: GeckoPool, token: string, requireMinimumVolume6h: boolean, chain: ChainName, dexScreenerTvls?: Map<string, number>, rpc: "scan" | "execution" = "scan"): Promise<ScoredPool | null> {
    const dexId = raw.relationships.dex.data.id;
    const protocol = dexId.startsWith("uniswap-v4") ? "v4" : "v3";
    const poolAddress = raw.attributes.address;

    if (!isAddress(poolAddress) && !(protocol === "v4" && isHex(poolAddress) && poolAddress.length === 66)) {
      return null;
    }

    const geckoTvl = Number(raw.attributes.reserve_in_usd || "0");
    const dexTvl = dexScreenerTvls?.get(poolAddress.toLowerCase());
    const tvlUsd = dexTvl ?? geckoTvl;
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;

    const volume6hUsd = Number(raw.attributes.volume_usd?.h6 || "0");
    if (requireMinimumVolume6h && !hasMinimumScanVolume6h(volume6hUsd)) return null;
    const volume24hUsd = Number(raw.attributes.volume_usd?.h24 || "0");
    const stale = volume24hUsd > 0 && volume6hUsd <= 0;

    const verified = await this.verifyPool(protocol, poolAddress as Address, token, chain, rpc);
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
      dex: verified.dex,
      pair,
      quoteToken,
      uniswapUrl: verified.dex === "pancake"
        ? `https://pancakeswap.finance/liquidity/pool/bsc/${poolAddress}`
        : uniswapPoolUrl(poolAddress, chain),
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

  async verifyPool(
    protocol: "v3" | "v4",
    poolAddress: Address,
    searchToken: string,
    chain: ChainName,
    rpc: "scan" | "execution" = "scan",
  ): Promise<VerifiedPool | null> {
    if (protocol === "v3") return this.verifyV3Pool(poolAddress, searchToken, chain, rpc);
    return this.verifyV4Pool(poolAddress, searchToken, chain, rpc);
  }

  private rpcClient(chain: ChainName, rpc: "scan" | "execution" = "scan") {
    return rpc === "execution" ? this.chains.getForExecution(chain) : this.chains.getForScan(chain);
  }

  private async matchV3Factory(chain: ChainName, pool: Address, token0: Address, token1: Address, fee: number, rpc: "scan" | "execution" = "scan"): Promise<DexName | null> {
    const { client, registry } = this.rpcClient(chain, rpc);
    for (const deployment of v3Deployments(registry)) {
      try {
        const factoryPool = await client.readContract({
          address: deployment.contracts.factory,
          abi: [{ name: "getPool", type: "function", stateMutability: "view", inputs: [
            { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "fee", type: "uint24" },
          ], outputs: [{ type: "address" }] }],
          functionName: "getPool",
          args: [token0, token1, fee],
        });
        if ((factoryPool as string).toLowerCase() === pool.toLowerCase()) return deployment.dex;
      } catch {
        continue;
      }
    }
    return null;
  }

  async verifyV3Pool(pool: Address, searchToken: string, chain: ChainName, rpc: "scan" | "execution" = "scan"): Promise<VerifiedPool | null> {
    const { client } = this.rpcClient(chain, rpc);
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

      const matched = await this.matchV3Factory(chain, pool, token0 as Address, token1 as Address, Number(fee), rpc);
      if (!matched) return null;

      return { feeTier: Number(fee), activeLiquidity: liquidity > 0n, dex: matched };
    } catch {
      return null;
    }
  }

  async verifyV4Pool(
    poolId: Address,
    searchToken: string,
    chain: ChainName,
    rpc: "scan" | "execution" = "scan",
  ): Promise<VerifiedPool | null> {
    if (!isHex(poolId) || poolId.length !== 66) return null;

    const { client, registry } = this.rpcClient(chain, rpc);
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
      const computedId = v4PoolId({
        currency0: poolKey.currency0 as Address,
        currency1: poolKey.currency1 as Address,
        fee: Number(poolKey.fee),
        tickSpacing: Number(poolKey.tickSpacing),
        hooks: poolKey.hooks as Address,
      });
      if (computedId.toLowerCase() !== poolId.toLowerCase() || slot0[0] === 0n) return null;

      return {
        feeTier: Number(poolKey.fee),
        currentLpFee: Number(slot0[3]),
        activeLiquidity: liquidity > 0n,
        hooks: poolKey.hooks,
        tickSpacing: Number(poolKey.tickSpacing),
      };
    } catch {
      return null;
    }
  }

  async scanStocks(
    onProgress?: (stage: string) => void,
    chain: ChainName = "robinhood",
    minYieldHourlyPercent = 0.1,
  ): Promise<PoolMarketScan> {
    const dexLabel = chain === "bsc" ? "Pancake/Uniswap V3" : "Uniswap V3/V4";
    onProgress?.(chain === "bsc" ? "Memuat token *B (stock/ETF/komoditas) di BSC..." : "Memuat daftar resmi Robinhood Token...");
    let universe: { address: Address; symbol: string }[] = chain === "bsc" ? [...BSC_STOCK_SEEDS] : [...ROBINHOOD_STOCK_TOKENS];
    try {
      const live = chain === "bsc" ? await this.fetchBscStockTokens() : await this.fetchOfficialStockTokens();
      if (live.length > 0) universe = live;
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error), chain }, "stock list failed; using fallback");
    }

    onProgress?.(`Menyaring volume ${dexLabel} 24h ≥ $100k (${universe.length} tokens)...`);
    const volumes = await this.fetchStockVolumes(universe, chain);
    const liquid = universe
      .filter((stock) => (volumes.get(stock.address.toLowerCase()) ?? 0) >= STOCK_MIN_VOLUME_24H_USD)
      .sort((a, b) => (volumes.get(b.address.toLowerCase()) ?? 0) - (volumes.get(a.address.toLowerCase()) ?? 0));
    const stockSymbols = liquid.map((stock) => stock.symbol);
    onProgress?.(
      liquid.length === 0
        ? `Tidak ada token dengan volume ${dexLabel} 24h ≥ $100k.`
        : `Volume lolos: ${liquid.length} (${stockSymbols.join(" ")}). Menghitung yield...`,
    );

    const enriched = await mapWithConcurrency(liquid, STOCK_VERIFY_CONCURRENCY, (stock) =>
      this.enrichStockPairs(stock, chain).catch(() => null),
    );
    onProgress?.("Memverifikasi pool on-chain dan menghitung yield...");
    const pools = enriched
      .flatMap((result) => result ?? [])
      .filter((pool) => pool.estimatedPoolYield1hPercent > minYieldHourlyPercent)
      .sort((a, b) => b.estimatedPoolYield1hPercent - a.estimatedPoolYield1hPercent || b.tvlUsd - a.tvlUsd)
      .slice(0, STOCK_MAX_RESULTS);
    return {
      pools,
      candidateTokens: universe.length,
      qualifiedTokens: enriched.filter((result) => result && result.length > 0).length,
      evaluatedTokens: liquid.length,
      stockSymbols,
      chain,
    };
  }

  private async fetchOfficialStockTokens(): Promise<{ address: Address; symbol: string }[]> {
    const seen = new Set<string>();
    const stocks: { address: Address; symbol: string }[] = [];
    let params = new URLSearchParams({ q: "Robinhood Token" });
    for (let page = 0; page < STOCK_LIST_MAX_PAGES; page++) {
      const response = await fetch(`${BLOCKSCOUT_TOKENS}?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) break;
      const body = await response.json() as {
        items?: { address_hash?: string; name?: string | null; symbol?: string | null; icon_url?: string | null }[];
        next_page_params?: Record<string, string | number | boolean | null>;
      };
      const items = body.items ?? [];
      const first = items[0]?.address_hash?.toLowerCase();
      if (page > 0 && first && seen.has(first)) break;
      for (const item of items) {
        if (!isOfficialRobinhoodStock(item) || !item.address_hash || !isAddress(item.address_hash)) continue;
        const address = item.address_hash as Address;
        const key = address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        stocks.push({ address, symbol: (item.symbol ?? "STOCK").toUpperCase() });
      }
      if (!body.next_page_params || items.length === 0) break;
      const next = new URLSearchParams();
      for (const [key, value] of Object.entries(body.next_page_params)) {
        if (value === null || value === undefined) continue;
        next.set(key, String(value));
      }
      if ([...next.keys()].length === 0 || next.toString() === params.toString()) break;
      params = next;
    }
    return stocks;
  }

  private async fetchBscStockTokens(): Promise<{ address: Address; symbol: string }[]> {
    const found = new Map<string, { address: Address; symbol: string }>();
    for (const seed of BSC_STOCK_SEEDS) found.set(seed.symbol, seed);
    const pending = BSC_STOCK_TICKERS
      .map((ticker) => `${ticker}B`)
      .filter((symbol) => !found.has(symbol));
    const resolved = await mapWithConcurrency(pending, STOCK_VERIFY_CONCURRENCY, async (symbol) => {
      try {
        const response = await fetch(`${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(symbol)}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return null;
        const body = await response.json() as { pairs?: DexScreenerPair[] };
        return resolveBscStockToken(symbol, body.pairs ?? []);
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error), symbol }, "DexScreener BSC stock search failed");
        return null;
      }
    });
    for (const stock of resolved) {
      if (stock) found.set(stock.symbol, stock);
    }
    return [...found.values()];
  }

  private async fetchStockVolumes(stocks: readonly { address: Address; symbol: string }[], chain: ChainName = "robinhood"): Promise<Map<string, number>> {
    const volumes = new Map<string, number>();
    const dsChain = chainRegistry[chain].dexScreenerChain;
    const volumeOptions = stockVolumeOptions(chain);
    for (let offset = 0; offset < stocks.length; offset += STOCK_VOLUME_BATCH) {
      const batch = stocks.slice(offset, offset + STOCK_VOLUME_BATCH);
      try {
        const response = await fetch(
          `${DEXSCREENER_BASE}/tokens/v1/${dsChain}/${batch.map((stock) => stock.address).join(",")}`,
          { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
        );
        if (!response.ok) continue;
        const body = await response.json() as DexScreenerPair[] | { pairs?: DexScreenerPair[] };
        const pairs = Array.isArray(body) ? body : body.pairs ?? [];
        for (const stock of batch) {
          const token = stock.address.toLowerCase();
          volumes.set(token, (volumes.get(token) ?? 0) + stockUniswapVolume24h(token, pairs, volumeOptions));
        }
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error), chain }, "DexScreener stock volume batch failed");
      }
    }
    return volumes;
  }

  private async enrichStockPairs(stock: { address: Address; symbol: string }, chain: ChainName = "robinhood"): Promise<ScoredPool[] | null> {
    const token = stock.address.toLowerCase();
    const pairs = await this.fetchDexScreenerPairs(token, chain);
    const relevant = pairs.filter((pair) => isStockScanPair(pair, chain));
    if (relevant.length === 0) return null;

    const top = [...relevant]
      .sort((a, b) => Number(b.volume?.h1 ?? 0) - Number(a.volume?.h1 ?? 0) || Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))
      .slice(0, MAX_DEXSCREENER_POOL_VERIFICATIONS);

    const hasMissingTvl = top.some((pair) => !Number(pair.liquidity?.usd ?? 0));
    const geckoTvlFallback = hasMissingTvl ? await this.buildGeckoTvlMap(token, chain) : undefined;
    const scored = (await mapWithConcurrency(top, STOCK_VERIFY_CONCURRENCY, (pair) =>
      this.toDexScreenerPool(pair, token, geckoTvlFallback, chain),
    )).filter((pool): pool is ScoredPool => pool !== null && pool.activeLiquidity);

    return scored.map((pool) => ({ ...pool, pair: `${pool.pair} [${stock.symbol}]` }));
  }

  async investigatePool(poolAddress: string, chain: ChainName = "robinhood"): Promise<InvestigateResult> {
    const normalized = poolAddress.toLowerCase();
    const isV4 = isHex(normalized) && normalized.length === 66;
    const protocol: "v3" | "v4" = isV4 ? "v4" : "v3";

    const [dexData, onChain] = await Promise.all([
      this.fetchDexScreenerPair(normalized, chain),
      isV4 ? this.readV4PoolOnChain(normalized as Address, chain) : this.readV3PoolOnChain(normalized as Address, chain),
    ]);

    if (!onChain) throw new Error("Pool tidak ditemukan on-chain atau bukan pool Uniswap valid");

    const feeTier = onChain.feeTier ?? 0;
    const currentLpFee = onChain.currentLpFee;
    const dynamicFee = protocol === "v4" && isDynamicFee(feeTier);
    const geckoData = dexData ? null : await this.fetchGeckoPool(normalized, chain);

    let resolvedTvlUsd = Number(dexData?.liquidity?.usd ?? geckoData?.tvlUsd ?? 0);
    if (resolvedTvlUsd <= 0 && dexData) {
      const geckoTvlMap = await this.buildGeckoTvlMap(dexData.baseToken.address.toLowerCase(), chain);
      resolvedTvlUsd = geckoTvlMap.get(normalized) ?? 0;
    }

    if (dexData) {
      return {
        chain,
        protocol,
        pairAddress: normalized,
        hooks: onChain.hooks,
        pair: `${dexData.baseToken.symbol}/${dexData.quoteToken.symbol}`,
        baseToken: dexData.baseToken,
        quoteToken: dexData.quoteToken,
        feeTier,
        currentLpFee,
        dynamicFee,
        activeLiquidity: onChain.activeLiquidity,
        tvlUsd: resolvedTvlUsd,
        volume1hUsd: Number(dexData.volume?.h1 ?? 0),
        volume6hUsd: Number(dexData.volume?.h6 ?? 0),
        volume24hUsd: Number(dexData.volume?.h24 ?? 0),
        marketCapUsd: dexData.marketCap ?? null,
        fdvUsd: dexData.fdv ?? null,
        pairCreatedAt: dexData.pairCreatedAt ?? null,
        txns1h: { buys: dexData.txns?.h1?.buys ?? 0, sells: dexData.txns?.h1?.sells ?? 0 },
        priceChange1h: dexData.priceChange?.h1 ?? 0,
        priceChange6h: dexData.priceChange?.h6 ?? 0,
        priceChange24h: dexData.priceChange?.h24 ?? 0,
        priceUsd: dexData.priceUsd ?? null,
        dexScreenerFound: true,
        marketSource: "dexscreener",
      };
    }

    if (geckoData) {
      return {
        chain,
        protocol,
        pairAddress: normalized,
        hooks: onChain.hooks,
        ...geckoData,
        feeTier,
        currentLpFee,
        dynamicFee,
        activeLiquidity: onChain.activeLiquidity,
        dexScreenerFound: true,
        marketSource: "geckoterminal",
      };
    }

    return {
      chain,
      protocol,
      pairAddress: normalized,
      hooks: onChain.hooks,
      pair: protocol === "v3" ? shortAddr(normalized as Address) : "V4",
      baseToken: { address: "", symbol: "?" },
      quoteToken: { address: "", symbol: "?" },
      feeTier,
      currentLpFee,
      dynamicFee,
      activeLiquidity: onChain.activeLiquidity,
      tvlUsd: 0,
      volume1hUsd: 0,
      volume6hUsd: 0,
      volume24hUsd: 0,
      marketCapUsd: null,
      fdvUsd: null,
      pairCreatedAt: null,
      txns1h: { buys: 0, sells: 0 },
      priceChange1h: 0,
      priceChange6h: 0,
      priceChange24h: 0,
      priceUsd: null,
      dexScreenerFound: false,
    };
  }

  private async fetchGeckoPool(poolAddress: string, chain: ChainName): Promise<{
    pair: string;
    baseToken: { address: string; symbol: string };
    quoteToken: { address: string; symbol: string };
    tvlUsd: number;
    volume1hUsd: number;
    volume6hUsd: number;
    volume24hUsd: number;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    pairCreatedAt: number | null;
    txns1h: { buys: number; sells: number };
    priceChange1h: number;
    priceChange6h: number;
    priceChange24h: number;
    priceUsd: string | null;
  } | null> {
    const network = chainRegistry[chain].geckoNetwork;
    try {
      const response = await this.fetchGecko(
        `${GECKO_BASE}/networks/${network}/pools/${poolAddress}?include=base_token,quote_token`,
        "interactive",
      );
      if (!response.ok) return null;
      const body = await response.json() as { data?: GeckoPool; included?: GeckoIncludedToken[] };
      const pool = body.data;
      if (!pool?.attributes) return null;
      if (!isEligibleScanDex(chainRegistry[chain], pool.relationships?.dex?.data?.id ?? "")) return null;
      const tokens = new Map((body.included ?? []).filter((item) => item.type === "token").map((item) => [item.id, item]));
      const baseRel = pool.relationships.base_token.data.id;
      const quoteRel = pool.relationships.quote_token.data.id;
      const base = tokens.get(baseRel);
      const quote = tokens.get(quoteRel);
      const baseAddress = (base?.attributes?.address ?? normalizeNetworkToken(baseRel)).toLowerCase();
      const quoteAddress = (quote?.attributes?.address ?? normalizeNetworkToken(quoteRel)).toLowerCase();
      const pairName = pool.attributes.pool_name || pool.attributes.name || `${base?.attributes?.symbol ?? "?"} / ${quote?.attributes?.symbol ?? "?"}`;
      const created = pool.attributes.pool_created_at ? Date.parse(pool.attributes.pool_created_at) : NaN;
      return {
        pair: poolPair(pairName, true),
        baseToken: { address: baseAddress, symbol: base?.attributes?.symbol ?? "?" },
        quoteToken: { address: quoteAddress, symbol: quote?.attributes?.symbol ?? "?" },
        tvlUsd: Number(pool.attributes.reserve_in_usd || 0),
        volume1hUsd: Number(pool.attributes.volume_usd?.h1 || 0),
        volume6hUsd: Number(pool.attributes.volume_usd?.h6 || 0),
        volume24hUsd: Number(pool.attributes.volume_usd?.h24 || 0),
        marketCapUsd: optionalPositiveNumber(pool.attributes.market_cap_usd),
        fdvUsd: optionalPositiveNumber(pool.attributes.fdv_usd),
        pairCreatedAt: Number.isFinite(created) ? created : null,
        txns1h: {
          buys: pool.attributes.transactions?.h1?.buys ?? 0,
          sells: pool.attributes.transactions?.h1?.sells ?? 0,
        },
        priceChange1h: Number(pool.attributes.price_change_percentage?.h1 || 0),
        priceChange6h: Number(pool.attributes.price_change_percentage?.h6 || 0),
        priceChange24h: Number(pool.attributes.price_change_percentage?.h24 || 0),
        priceUsd: pool.attributes.base_token_price_usd ?? null,
      };
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error), poolAddress, chain }, "GeckoTerminal pool lookup failed");
      return null;
    }
  }

  private async fetchDexScreenerPair(pairAddress: string, chain: ChainName = "robinhood"): Promise<DexScreenerPairDetail | null> {
    try {
      const response = await fetch(`${DEXSCREENER_BASE}/latest/dex/pairs/${chainRegistry[chain].dexScreenerChain}/${pairAddress}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const body = await response.json();
      const pairs = (body as { pairs?: unknown })?.pairs ?? (Array.isArray(body) ? body : []);
      return Array.isArray(pairs) && pairs.length > 0 ? (pairs[0] as DexScreenerPairDetail) : null;
    } catch (error) {
      log.warn({ error: error instanceof Error ? error.message : String(error), pairAddress }, "DexScreener pair lookup failed");
      return null;
    }
  }

  private async readV3PoolOnChain(pool: Address, chain: ChainName): Promise<VerifiedPool | null> {
    const { client } = this.chains.getForScan(chain);
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

      const matched = await this.matchV3Factory(chain, pool, token0 as Address, token1 as Address, Number(fee));
      if (!matched) return null;

      return { feeTier: Number(fee), activeLiquidity: liquidity > 0n, dex: matched };
    } catch {
      return null;
    }
  }

  private async readV4PoolOnChain(poolId: Address, chain: ChainName): Promise<VerifiedPool | null> {
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
      const poolKey = poolKeyResult as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
      const computedId = v4PoolId(poolKey);
      if (computedId.toLowerCase() !== poolId.toLowerCase() || slot0[0] === 0n) return null;

      return {
        feeTier: Number(poolKey.fee),
        currentLpFee: Number(slot0[3]),
        activeLiquidity: liquidity > 0n,
        hooks: poolKey.hooks,
        tickSpacing: Number(poolKey.tickSpacing),
      };
    } catch {
      return null;
    }
  }
}

export function isOfficialRobinhoodStock(token: {
  name?: string | null;
  icon_url?: string | null;
  address_hash?: string | null;
}): boolean {
  return Boolean(
    token.address_hash
    && isAddress(token.address_hash)
    && (token.name ?? "").includes("• Robinhood Token")
    && (token.icon_url ?? "").includes("cdn.robinhood.com"),
  );
}

export function stockVolumeOptions(chain: ChainName): { chainId: string; dexIds: readonly string[]; quotes: Set<string> } {
  if (chain === "bsc") {
    return { chainId: "bsc", dexIds: BSC_STOCK_DEX_IDS, quotes: BSC_STOCK_VOLUME_QUOTES };
  }
  return { chainId: "robinhood", dexIds: ["uniswap"], quotes: STOCK_VOLUME_QUOTES };
}

export function stockPairProtocol(pair: DexScreenerPair): "v3" | "v4" | null {
  if (pair.labels?.includes("v2")) return null;
  if (pair.labels?.includes("v4") || pair.pairAddress.length === 66) return "v4";
  if (pair.labels?.includes("v3") || pair.pairAddress.length === 42) return "v3";
  return null;
}

export function isStockScanPair(pair: DexScreenerPair, chain: ChainName): boolean {
  const options = stockVolumeOptions(chain);
  if (pair.chainId && pair.chainId !== options.chainId) return false;
  if (!options.dexIds.includes(pair.dexId)) return false;
  if (stockPairProtocol(pair) === null) return false;
  return options.quotes.has(pair.baseToken.address.toLowerCase()) || options.quotes.has(pair.quoteToken.address.toLowerCase());
}

export function resolveBscStockToken(symbol: string, pairs: readonly DexScreenerPair[]): { address: Address; symbol: string } | null {
  const wanted = symbol.toUpperCase();
  let best: { address: Address; liquidity: number } | null = null;
  for (const pair of pairs) {
    if (!isStockScanPair(pair, "bsc")) continue;
    const price = Number(pair.priceUsd ?? 0);
    if (!Number.isFinite(price) || price < BSC_STOCK_MIN_PRICE_USD) continue;
    const baseMatch = pair.baseToken.symbol.toUpperCase() === wanted;
    const quoteMatch = pair.quoteToken.symbol.toUpperCase() === wanted;
    if (!baseMatch && !quoteMatch) continue;
    const address = (baseMatch ? pair.baseToken.address : pair.quoteToken.address) as Address;
    if (!isAddress(address)) continue;
    const liquidity = Number(pair.liquidity?.usd ?? 0);
    if (!best || liquidity > best.liquidity) best = { address, liquidity };
  }
  return best ? { address: best.address, symbol: wanted } : null;
}

export function stockUniswapVolume24h(
  token: string,
  pairs: readonly DexScreenerPair[],
  options: { chainId?: string; dexIds?: readonly string[]; quotes?: Set<string> } = {},
): number {
  const address = token.toLowerCase();
  const chainId = options.chainId ?? "robinhood";
  const dexIds = options.dexIds ?? ["uniswap"];
  const quotes = options.quotes ?? STOCK_VOLUME_QUOTES;
  let total = 0;
  for (const pair of pairs) {
    if (pair.chainId && pair.chainId !== chainId) continue;
    if (!dexIds.includes(pair.dexId)) continue;
    if (!stockPairProtocol(pair)) continue;
    const base = pair.baseToken.address.toLowerCase();
    const quote = pair.quoteToken.address.toLowerCase();
    const stockIsBase = base === address;
    const stockIsQuote = quote === address;
    if (!stockIsBase && !stockIsQuote) continue;
    const other = stockIsBase ? quote : base;
    if (!quotes.has(other)) continue;
    const volume = Number(pair.volume?.h24 ?? 0);
    if (Number.isFinite(volume) && volume > 0) total += volume;
  }
  return total;
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
  return `https://app.uniswap.org/explore/pools/${chainRegistry[chain].uniswapSlug}/${poolIdentifier}`;
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
  return [...pools].sort(compareQualifiedPool).slice(0, MAX_QUALIFIED_POOLS_PER_TOKEN);
}

function compareQualifiedPool(left: ScoredPool, right: ScoredPool): number {
  return right.estimatedPoolYield1hPercent - left.estimatedPoolYield1hPercent || right.tvlUsd - left.tvlUsd;
}

function nonQuoteToken(pool: GeckoPool, allowedQuotes: readonly Address[]): string | null {
  const base = normalizeNetworkToken(pool.relationships.base_token.data.id);
  const quote = normalizeNetworkToken(pool.relationships.quote_token.data.id);
  const allowed = new Set(allowedQuotes.map((address) => address.toLowerCase()));
  const baseIsQuote = allowed.has(base);
  const quoteIsQuote = allowed.has(quote);
  if (baseIsQuote === quoteIsQuote) return null;
  return baseIsQuote ? quote : base;
}

export function marketScanDexIds(chain: ChainName): readonly string[] {
  if (chain === "bsc") return ["uniswap-bsc", "uniswap-v4-bsc", "pancakeswap-v3-bsc"];
  return [`uniswap-v3-${chainRegistry[chain].geckoNetwork}`, `uniswap-v4-${chainRegistry[chain].geckoNetwork}`];
}

export function isMarketScanPair(pair: DexScreenerPair, chain: ChainName): boolean {
  if (pair.chainId !== chainRegistry[chain].dexScreenerChain) return false;
  if (chain === "bsc" ? pair.dexId !== "uniswap" && pair.dexId !== "pancakeswap" : pair.dexId !== "uniswap") return false;
  const protocol = stockPairProtocol(pair);
  return protocol !== null && !(chain === "bsc" && pair.dexId === "pancakeswap" && protocol !== "v3");
}

function dedupeDexScreenerPairs(pairs: readonly DexScreenerPair[]): DexScreenerPair[] {
  return [...new Map(pairs.map((pair) => [pair.pairAddress.toLowerCase(), pair])).values()];
}

function feeRateFromName(name: string): number | null {
  const match = name.match(/\s(\d+(?:\.\d+)?)%$/);
  if (!match?.[1]) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) && percent >= 0 ? percent / 100 : null;
}

function shortAddr(address: Address): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

function optionalPositiveNumber(value: string | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
