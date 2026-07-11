import { isAddress, isHex, type Address, type Hex } from "viem";

import { log } from "../log.js";
import type { ChainClients } from "./chain-client.js";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const K = 1_000_000;
export const MIN_VOLUME_1H_USD = 100;

export interface ScoredPool {
  protocol: "v3" | "v4";
  pair: string;
  uniswapUrl: string;
  feeTier: number;
  feeRate: number;
  tvlUsd: number;
  volume1hUsd: number;
  score: number;
  safetyFactor: number;
  dynamicFee: boolean;
  currentLpFee?: number;
  stale: boolean;
  warnings: string[];
}

interface GeckoPool {
  id: string;
  type: string;
  attributes: {
    address: string;
    name: string;
    reserve_in_usd: string;
    volume_usd: { h1: string; h24: string };
    base_token_price_usd?: string;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

interface GeckoTokenResponse {
  data: Array<{ id: string; type: string; attributes: { name: string; symbol: string } }>;
}

export class PoolScanner {
  constructor(
    private readonly chains: ChainClients,
  ) {}

  async scan(tokenAddress: Address): Promise<ScoredPool[]> {
    const normalized = tokenAddress.toLowerCase();

    const pools = await this.fetchUniswapPools(normalized);
    if (pools.length === 0) return [];

    const scored: ScoredPool[] = [];
    for (const raw of pools) {
      const pool = await this.toScoredPool(raw, normalized);
      if (pool) scored.push(pool);
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3);
  }

  private async fetchUniswapPools(token: string): Promise<GeckoPool[]> {
    const url = `${GECKO_BASE}/networks/robinhood/tokens/${token}/pools?page=1`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      log.warn({ err: error, token }, "GeckoTerminal request failed");
      return [];
    }

    if (!response.ok) {
      log.warn({ status: response.status, token }, "GeckoTerminal responded with error");
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

  private async toScoredPool(raw: GeckoPool, token: string): Promise<ScoredPool | null> {
    const dexId = raw.relationships.dex.data.id;
    const protocol = dexId.startsWith("uniswap-v4") ? "v4" : "v3";
    const poolAddress = raw.attributes.address;

    if (!isAddress(poolAddress) && !(protocol === "v4" && isHex(poolAddress) && poolAddress.length === 66)) {
      return null;
    }

    const tvlUsd = Number(raw.attributes.reserve_in_usd || "0");
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;

    const volume1hUsd = Number(raw.attributes.volume_usd?.h1 || "0");
    if (!hasMinimumScanVolume(volume1hUsd)) return null;
    const volume24hUsd = Number(raw.attributes.volume_usd?.h24 || "0");
    const stale = volume24hUsd > 0 && volume1hUsd <= 0;

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
    const safetyFactor = Math.sqrt(tvlUsd / (tvlUsd + K));
    const score = volume1hUsd > 0 ? (volume1hUsd * feeRate / tvlUsd) * safetyFactor : 0;

    const baseId = raw.relationships.base_token.data.id;
    const quoteId = raw.relationships.quote_token.data.id;
    const isTokenBase = baseId.toLowerCase().replace("robinhood_", "") === token;
    const tokenSymbol = isTokenBase
      ? raw.attributes.name.split(" / ")[0] ?? "?"
      : raw.attributes.name.split(" / ")[1] ?? "?";
    const otherSymbol = isTokenBase
      ? raw.attributes.name.split(" / ")[1] ?? "?"
      : raw.attributes.name.split(" / ")[0] ?? "?";
    const pair = `${tokenSymbol}/${otherSymbol}`;

    const warnings: string[] = [];
    if (stale) warnings.push("data mungkin stale");
    if (dynamicFee) warnings.push("dynamic fee");

    return {
      protocol,
      pair,
      uniswapUrl: uniswapPoolUrl(poolAddress),
      feeTier: verified.feeTier ?? 0,
      feeRate,
      tvlUsd,
      volume1hUsd,
      score,
      safetyFactor,
      dynamicFee,
      currentLpFee,
      stale,
      warnings,
    };
  }

  private async verifyPool(
    protocol: "v3" | "v4",
    poolAddress: Address,
    searchToken: string,
  ): Promise<{ feeTier?: number; currentLpFee?: number } | null> {
    if (protocol === "v3") return this.verifyV3Pool(poolAddress, searchToken);
    return this.verifyV4Pool(poolAddress, searchToken);
  }

  private async verifyV3Pool(pool: Address, searchToken: string): Promise<{ feeTier?: number } | null> {
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
      if (liquidity === 0n) return null;

      const factoryPool = await client.readContract({
        address: registry.contracts.v3.factory,
        abi: [{ name: "getPool", type: "function", stateMutability: "view", inputs: [
          { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "fee", type: "uint24" },
        ], outputs: [{ type: "address" }] }],
        functionName: "getPool",
        args: [token0, token1, fee],
      });

      if ((factoryPool as string).toLowerCase() !== pool.toLowerCase()) return null;

      return { feeTier: Number(fee) };
    } catch {
      return null;
    }
  }

  private async verifyV4Pool(
    poolId: Address,
    searchToken: string,
  ): Promise<{ feeTier?: number; currentLpFee?: number } | null> {
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

      if (liquidity === 0n) return null;

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

      return { feeTier: Number(poolKey.fee), currentLpFee: Number(slot0[3]) };
    } catch {
      return null;
    }
  }
}

export function hasMinimumScanVolume(volume1hUsd: number): boolean {
  return Number.isFinite(volume1hUsd) && volume1hUsd >= MIN_VOLUME_1H_USD;
}

export function uniswapPoolUrl(poolIdentifier: string): string {
  return `https://app.uniswap.org/explore/pools/robinhood/${poolIdentifier}`;
}
