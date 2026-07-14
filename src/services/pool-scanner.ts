import { isAddress, isHex, type Address, type Hex } from "viem";

import { log } from "../log.js";
import type { PoolScanSettings } from "../types.js";
import type { ChainClients } from "./chain-client.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const K = 1_000_000;
export const MIN_VOLUME_6H_USD = 100;

export interface ScoredPool {
  protocol: "v3" | "v4";
  pair: string;
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
  tokenTotalActiveTvlUsd?: number;
  tokenOldestPoolAgeSeconds?: number;
}

export interface PoolScan {
  active: ScoredPool[];
  watchlist: ScoredPool[];
}

export interface PoolScanFilters extends PoolScanSettings {
  allowedQuoteAddresses: Address[];
}

export interface PoolMarketScan {
  pools: ScoredPool[];
  candidateTokens: number;
  evaluatedTokens: number;
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
  data: { attributes: { market_cap_usd?: string | null } };
}

export class PoolScanner {
  private marketScanCache?: { key: string; expiresAt: number; result: PoolMarketScan };

  constructor(
    private readonly chains: ChainClients,
  ) {}

  async scan(tokenAddress: Address): Promise<PoolScan> {
    const normalized = tokenAddress.toLowerCase();

    const pools = await this.fetchUniswapPools(normalized);
    if (pools.length === 0) return { active: [], watchlist: [] };

    const scored: ScoredPool[] = [];
    for (const raw of pools) {
      const pool = await this.toScoredPool(raw, normalized, true);
      if (pool) scored.push(pool);
    }

    return rankPools(scored);
  }

  async scanPools(filters: PoolScanFilters): Promise<PoolMarketScan> {
    const key = JSON.stringify({ ...filters, allowedQuoteAddresses: [...filters.allowedQuoteAddresses].sort() });
    if (this.marketScanCache?.key === key && this.marketScanCache.expiresAt > Date.now()) return this.marketScanCache.result;
    const [v3Pools, v4Pools] = await Promise.all([
      this.fetchDexPools("uniswap-v3-robinhood"),
      this.fetchDexPools("uniswap-v4-robinhood"),
    ]);
    const candidates = new Map<string, number>();
    for (const raw of [...v3Pools, ...v4Pools]) {
      const token = nonQuoteToken(raw, filters.allowedQuoteAddresses);
      if (!token) continue;
      const tvlUsd = Number(raw.attributes.reserve_in_usd || "0");
      const volume1hUsd = Number(raw.attributes.volume_usd?.h1 || "0");
      const feeRate = feeRateFromName(raw.attributes.pool_name ?? raw.attributes.name);
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0 || !Number.isFinite(volume1hUsd) || volume1hUsd <= 0 || feeRate === null) continue;
      const yield1h = estimatedYieldPercent(volume1hUsd * feeRate, tvlUsd, 1);
      if (yield1h < filters.minYieldHourlyPercent) continue;
      candidates.set(token, Math.max(candidates.get(token) ?? 0, yield1h));
    }

    const candidateTokens = [...candidates.entries()]
      .sort(([, left], [, right]) => right - left)
      .slice(0, 20)
      .map(([token]) => token);
    const enriched = await mapWithConcurrency(candidateTokens, 3, (token) => this.enrichToken(token, filters));
    const pools = enriched.flatMap((result) => result ?? [])
      .sort((left, right) => right.estimatedPoolYield1hPercent - left.estimatedPoolYield1hPercent || right.tvlUsd - left.tvlUsd)
      .slice(0, filters.maxResults);
    const result = { pools, candidateTokens: candidateTokens.length, evaluatedTokens: enriched.filter(Boolean).length };
    this.marketScanCache = { key, expiresAt: Date.now() + 60_000, result };
    return result;
  }

  private async fetchUniswapPools(token: string): Promise<GeckoPool[]> {
    return this.fetchPools(`${GECKO_BASE}/networks/robinhood/tokens/${token}/pools?page=1`, token);
  }

  private async fetchDexPools(dex: "uniswap-v3-robinhood" | "uniswap-v4-robinhood"): Promise<GeckoPool[]> {
    return this.fetchPools(`${GECKO_BASE}/networks/robinhood/dexes/${dex}/pools?page=1`, dex);
  }

  private async fetchPools(url: string, context: string): Promise<GeckoPool[]> {

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
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

    return (data as GeckoPool[]).filter((p) => {
      const dexId = p.relationships?.dex?.data?.id ?? "";
      return dexId.startsWith("uniswap-v3") || dexId.startsWith("uniswap-v4");
    });
  }

  private async toScoredPool(raw: GeckoPool, token: string, requireMinimumVolume6h: boolean): Promise<ScoredPool | null> {
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

    const verified = await this.verifyPool(protocol, poolAddress as Address, token);
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
    const isTokenBase = baseId.toLowerCase().replace("robinhood_", "") === token;
    const pair = poolPair(raw.attributes.pool_name ?? raw.attributes.name, isTokenBase);

    const warnings: string[] = [];
    if (stale) warnings.push("data mungkin stale");
    if (dynamicFee) warnings.push("dynamic fee");
    if (!verified.activeLiquidity) warnings.push("zero active liquidity");

    return {
      protocol,
      pair,
      uniswapUrl: uniswapPoolUrl(poolAddress),
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

  private async enrichToken(token: string, filters: PoolScanFilters): Promise<ScoredPool[] | null> {
    const [tokenResponse, rawPools] = await Promise.all([
      this.fetchToken(token),
      this.fetchUniswapPools(token),
    ]);
    const marketCapUsd = Number(tokenResponse?.data.attributes.market_cap_usd ?? "NaN");
    if (!Number.isFinite(marketCapUsd) || marketCapUsd <= filters.minMarketCapUsd) return null;
    const relevantRaw = rawPools.filter((pool) => nonQuoteToken(pool, filters.allowedQuoteAddresses) === token);
    if (relevantRaw.length === 0) return null;
    const scored = (await mapWithConcurrency(relevantRaw, 3, (pool) => this.toScoredPool(pool, token, false))).filter((pool): pool is ScoredPool => pool !== null);
    const active = scored.filter((pool) => pool.activeLiquidity);
    const totalActiveTvlUsd = active.reduce((total, pool) => total + pool.tvlUsd, 0);
    const oldestCreatedAt = relevantRaw
      .map((pool) => Date.parse(pool.attributes.pool_created_at ?? ""))
      .filter(Number.isFinite)
      .reduce((oldest, createdAt) => Math.min(oldest, createdAt), Number.POSITIVE_INFINITY);
    const oldestPoolAgeSeconds = Number.isFinite(oldestCreatedAt) ? Math.max(0, Math.floor((Date.now() - oldestCreatedAt) / 1_000)) : 0;
    if (totalActiveTvlUsd <= filters.minTotalActiveTvlUsd || oldestPoolAgeSeconds <= filters.minPoolAgeSeconds) return null;
    return active
      .filter((pool) => pool.estimatedPoolYield1hPercent > filters.minYieldHourlyPercent)
      .map((pool) => ({ ...pool, tokenMarketCapUsd: marketCapUsd, tokenTotalActiveTvlUsd: totalActiveTvlUsd, tokenOldestPoolAgeSeconds: oldestPoolAgeSeconds }));
  }

  private async fetchToken(token: string): Promise<GeckoTokenResponse | null> {
    try {
      const response = await fetch(`${GECKO_BASE}/networks/robinhood/tokens/${token}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return null;
      return await response.json() as GeckoTokenResponse;
    } catch {
      return null;
    }
  }

  private async verifyPool(
    protocol: "v3" | "v4",
    poolAddress: Address,
    searchToken: string,
  ): Promise<VerifiedPool | null> {
    if (protocol === "v3") return this.verifyV3Pool(poolAddress, searchToken);
    return this.verifyV4Pool(poolAddress, searchToken);
  }

  private async verifyV3Pool(pool: Address, searchToken: string): Promise<VerifiedPool | null> {
    const { client, registry } = this.chains.get("robinhood");
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
  ): Promise<VerifiedPool | null> {
    if (!isHex(poolId) || poolId.length !== 66) return null;

    const { client, registry } = this.chains.get("robinhood");
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

export function uniswapPoolUrl(poolIdentifier: string): string {
  return `https://app.uniswap.org/explore/pools/robinhood/${poolIdentifier}`;
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
