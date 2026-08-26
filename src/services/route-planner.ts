import { zeroAddress, type Address, type Hex } from "viem";

import { v2FactoryAbi, v2RouterAbi, v3FactoryAbi, v3QuoterAbi, v4QuoterAbi } from "../abi.js";
import { isProtocolDeployed } from "../chains.js";
import { log } from "../log.js";
import type { ChainName, PositionRecord, QuoteToken } from "../types.js";
import { applySlippage } from "./uniswap-math.js";
import { dexNameFromMetadata, v3ContractsFor } from "./v3-deployment.js";
import type { ChainClient, ChainClients } from "./chain-client.js";

const V3_FEES = [100, 500, 2_500, 3_000, 10_000] as const;
const MAX_CONCURRENT_ROUTE_QUOTES = 4;
const V4_QUOTE_ATTEMPTS = 3;
const MISSING_POOL_CACHE_MS = 300_000;

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface SwapRoute {
  protocol: "v2" | "v3" | "v4";
  pool: Address;
  pools: Address[];
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  path: Address[];
  amountIn: bigint;
  expectedOut: bigint;
  minimumOut: bigint;
  fees?: number[];
  encodedPath?: Hex;
  v4PoolKey?: V4PoolKey;
}

interface QuoteOptions {
  excludedPool?: Address | null;
  includeV4?: boolean;
  rpc?: "scan" | "monitoring";
}

export class RoutePlanner {
  private readonly quoteLimiter = new AsyncLimiter(MAX_CONCURRENT_ROUTE_QUOTES);
  private readonly poolCache = new Map<string, { pool: Address; expiresAt: number }>();
  private readonly poolLookups = new Map<string, Promise<Address>>();

  constructor(
    private readonly chains: ChainClients,
    private readonly slippageBps: number,
    private readonly quoteTokens: Record<ChainName, QuoteToken[]>,
  ) {}

  async quoteDirect(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address, opts?: QuoteOptions): Promise<SwapRoute | null> {
    if (amountIn === 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
    const { registry } = this.chains.getById(position.chainId);
    const paths = this.candidatePaths(registry.name, tokenIn, tokenOut);
    const [v2Quotes, v3Quotes, v4Quote] = await Promise.all([
      isProtocolDeployed(registry, "v2") ? this.quoteV2(position, paths, amountIn, opts?.excludedPool, opts?.rpc) : Promise.resolve([]),
      isProtocolDeployed(registry, "v3") ? this.quoteV3(position, paths, amountIn, opts?.excludedPool, opts?.rpc) : Promise.resolve([]),
      opts?.includeV4 === false || !isProtocolDeployed(registry, "v4")
        ? Promise.resolve(null)
        : this.quoteV4(position, tokenIn, amountIn, tokenOut, opts?.rpc),
    ]);
    const quotes = [...v2Quotes, ...v3Quotes, ...(v4Quote ? [v4Quote] : [])];

    return quotes.sort(compareQuote)[0] ?? null;
  }

  private candidatePaths(name: ChainName, tokenIn: Address, tokenOut: Address): Address[][] {
    const input = tokenIn.toLowerCase();
    const output = tokenOut.toLowerCase();
    const intermediaries = this.quoteTokens[name]
      .map(({ address }) => address)
      .filter((token) => token.toLowerCase() !== input && token.toLowerCase() !== output);
    return [[tokenIn, tokenOut], ...intermediaries.map((intermediate) => [tokenIn, intermediate, tokenOut])];
  }

  private async quoteV2(position: PositionRecord, paths: Address[][], amountIn: bigint, excludedPool?: Address | null, rpc: "scan" | "monitoring" = "scan"): Promise<SwapRoute[]> {
    const { client, registry } = this.readChain(position, rpc);
    const excluded = excludedPool?.toLowerCase();
    const quotes = await Promise.all(paths.map(async (path) => {
      try {
        const pools = await Promise.all(path.slice(1).map((token, index) => this.getV2Pair(position, path[index]!, token, rpc)));
        if (pools.some((pool) => pool === zeroAddress || pool.toLowerCase() === excluded)) return null;
        const amounts = await client.readContract({
          address: registry.contracts.v2.router,
          abi: v2RouterAbi,
          functionName: "getAmountsOut",
          args: [amountIn, path],
        });
        const expectedOut = amounts[amounts.length - 1] ?? 0n;
        if (expectedOut === 0n) return null;
        return {
          protocol: "v2" as const,
          pool: pools[0]!,
          pools,
          router: registry.contracts.v2.router,
          tokenIn: path[0]!,
          tokenOut: path[path.length - 1]!,
          path,
          amountIn,
          expectedOut,
          minimumOut: applySlippage(expectedOut, this.slippageBps),
        };
      } catch {
        return null;
      }
    }));
    return quotes.filter((quote) => quote !== null) as SwapRoute[];
  }

  private async quoteV3(position: PositionRecord, paths: Address[][], amountIn: bigint, excludedPool?: Address | null, rpc: "scan" | "monitoring" = "scan"): Promise<SwapRoute[]> {
    const { client, registry } = this.readChain(position, rpc);
    const excluded = excludedPool?.toLowerCase();
    const candidates = paths.flatMap((path) => feeCombinations(path.length - 1).map((fees) => ({ path, fees })));
    const quotes = await Promise.all(candidates.map(({ path, fees }) => this.quoteLimiter.run(async () => {
        try {
          const pools = await Promise.all(fees.map((fee, index) => this.getV3Pool(position, path[index]!, path[index + 1]!, fee, rpc)));
          if (pools.some((pool) => pool === zeroAddress || pool.toLowerCase() === excluded)) return null;
          const encodedPath = encodeV3Path(path, fees);
          const contracts = v3ContractsFor(registry, dexNameFromMetadata(position.metadata));
          const simulation = await client.simulateContract({
            address: contracts.quoter,
            abi: v3QuoterAbi,
            functionName: "quoteExactInput",
            args: [encodedPath, amountIn],
          });
          const expectedOut = simulation.result[0];
          if (expectedOut === 0n) return null;
          return {
            protocol: "v3" as const,
            pool: pools[0]!,
            pools,
            router: contracts.swapRouter,
            tokenIn: path[0]!,
            tokenOut: path[path.length - 1]!,
            path,
            amountIn,
            expectedOut,
            minimumOut: applySlippage(expectedOut, this.slippageBps),
            fees,
            encodedPath,
          };
        } catch {
          return null;
        }
    })));
    return quotes.filter((quote) => quote !== null) as SwapRoute[];
  }

  private async getV3Pool(position: PositionRecord, tokenA: Address, tokenB: Address, fee: number, rpc: "scan" | "monitoring" = "scan"): Promise<Address> {
    const tokens = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
    const dex = dexNameFromMetadata(position.metadata);
    const key = `v3:${rpc}:${dex}:${position.chainId}:${tokens[0]}:${tokens[1]}:${fee}`;
    return this.getCachedPool(key, async () => {
      const { client, registry } = this.readChain(position, rpc);
      return client.readContract({
        address: v3ContractsFor(registry, dex).factory,
        abi: v3FactoryAbi,
        functionName: "getPool",
        args: [tokenA, tokenB, fee],
      });
    });
  }

  private async getV2Pair(position: PositionRecord, tokenA: Address, tokenB: Address, rpc: "scan" | "monitoring" = "scan"): Promise<Address> {
    const tokens = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
    const key = `v2:${rpc}:${position.chainId}:${tokens[0]}:${tokens[1]}`;
    return this.getCachedPool(key, async () => {
      const { client, registry } = this.readChain(position, rpc);
      return client.readContract({
        address: registry.contracts.v2.factory,
        abi: v2FactoryAbi,
        functionName: "getPair",
        args: [tokenA, tokenB],
      });
    });
  }

  private async getCachedPool(key: string, lookupPool: () => Promise<Address>): Promise<Address> {
    const cached = this.poolCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.pool;

    const pending = this.poolLookups.get(key);
    if (pending) return pending;

    const lookup = lookupPool().then((pool) => {
      this.poolCache.set(key, {
        pool,
        expiresAt: pool === zeroAddress ? Date.now() + MISSING_POOL_CACHE_MS : Number.POSITIVE_INFINITY,
      });
      return pool;
    }).finally(() => this.poolLookups.delete(key));
    this.poolLookups.set(key, lookup);
    return lookup;
  }

  private readChain(position: PositionRecord, rpc: "scan" | "monitoring" = "scan"): ChainClient {
    const chain = this.chains.getById(position.chainId);
    const clients = this.chains as unknown as {
      getForMonitoring?: (name: typeof chain.registry.name) => ChainClient;
      getForScan?: (name: typeof chain.registry.name) => ChainClient;
    };
    if (rpc === "monitoring" && typeof clients.getForMonitoring === "function") return clients.getForMonitoring(chain.registry.name);
    return typeof clients.getForScan === "function" ? clients.getForScan(chain.registry.name) : chain;
  }

  private async quoteV4(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address, rpc: "scan" | "monitoring" = "scan"): Promise<SwapRoute | null> {
    if (position.protocol !== "v4") return null;
    const meta = position.metadata as Record<string, unknown>;
    const currency0 = meta.currency0 as Address | undefined;
    const currency1 = meta.currency1 as Address | undefined;
    const fee = meta.fee as number | undefined;
    const tickSpacing = meta.tickSpacing as number | undefined;
    const hooks = (meta.hooks as Address | undefined) ?? zeroAddress;
    if (!currency0 || !currency1 || fee === undefined || tickSpacing === undefined || amountIn > (1n << 128n) - 1n) return null;

    const tokenInL = tokenIn.toLowerCase();
    const tokenOutL = tokenOut.toLowerCase();
    const zeroForOne = tokenInL === currency0.toLowerCase() && tokenOutL === currency1.toLowerCase();
    if (!zeroForOne && (tokenInL !== currency1.toLowerCase() || tokenOutL !== currency0.toLowerCase())) return null;

    const { client, registry } = this.readChain(position, rpc);
    const poolKey: V4PoolKey = { currency0, currency1, fee, tickSpacing, hooks };
    for (let attempt = 1; attempt <= V4_QUOTE_ATTEMPTS; attempt += 1) {
      try {
        const simulation = await client.simulateContract({
          address: registry.contracts.v4.quoter,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
        });
        const expectedOut = simulation.result[0];
        if (expectedOut === 0n) return null;
        return {
          protocol: "v4",
          pool: zeroAddress,
          pools: [],
          router: registry.contracts.v4.universalRouter,
          tokenIn,
          tokenOut,
          path: [tokenIn, tokenOut],
          amountIn,
          expectedOut,
          minimumOut: applySlippage(expectedOut, this.slippageBps),
          fees: [fee],
          v4PoolKey: poolKey,
        };
      } catch (error) {
        if (attempt === V4_QUOTE_ATTEMPTS) {
          log.warn({ err: error, positionId: position.id, tokenIn, tokenOut, attempts: attempt }, "V4 quote failed after retries");
        }
      }
    }
    return null;
  }
}

function feeCombinations(hops: number): number[][] {
  if (hops === 0) return [];
  const combinations: number[][] = [[]];
  for (let index = 0; index < hops; index += 1) {
    const next: number[][] = [];
    for (const combination of combinations) {
      for (const fee of V3_FEES) next.push([...combination, fee]);
    }
    combinations.splice(0, combinations.length, ...next);
  }
  return combinations;
}

function encodeV3Path(path: Address[], fees: number[]): Hex {
  let encoded = path[0]!.toLowerCase().slice(2);
  for (let index = 0; index < fees.length; index += 1) {
    encoded += fees[index]!.toString(16).padStart(6, "0");
    encoded += path[index + 1]!.toLowerCase().slice(2);
  }
  return `0x${encoded}` as Hex;
}

function compareQuote(left: SwapRoute, right: SwapRoute): number {
  return left.expectedOut > right.expectedOut ? -1 : left.expectedOut < right.expectedOut ? 1 : 0;
}

class AsyncLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
