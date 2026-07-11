import { zeroAddress, type Address, type Hex } from "viem";

import { v2FactoryAbi, v2RouterAbi, v3FactoryAbi, v3QuoterAbi, v4QuoterAbi } from "../abi.js";
import type { ChainName, PositionRecord, QuoteToken } from "../types.js";
import { applySlippage } from "./uniswap-math.js";
import type { ChainClients } from "./chain-client.js";

const V3_FEES = [100, 500, 3_000, 10_000] as const;

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
}

export class RoutePlanner {
  constructor(
    private readonly chains: ChainClients,
    private readonly slippageBps: number,
    private readonly quoteTokens: Record<ChainName, QuoteToken[]>,
  ) {}

  async quoteDirect(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address, opts?: QuoteOptions): Promise<SwapRoute | null> {
    if (amountIn === 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
    const { registry } = this.chains.getById(position.chainId);
    const paths = this.candidatePaths(registry.name, tokenIn, tokenOut);
    const quotes = [
      ...(await this.quoteV2(position, paths, amountIn, opts?.excludedPool)),
      ...(await this.quoteV3(position, paths, amountIn, opts?.excludedPool)),
    ];
    if (opts?.includeV4 !== false) await this.tryV4Quote(position, tokenIn, amountIn, tokenOut, quotes);

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

  private async quoteV2(position: PositionRecord, paths: Address[][], amountIn: bigint, excludedPool?: Address | null): Promise<SwapRoute[]> {
    const { client, registry } = this.chains.getById(position.chainId);
    const excluded = excludedPool?.toLowerCase();
    const quotes: SwapRoute[] = [];

    for (const path of paths) {
      try {
        const pools = await Promise.all(path.slice(1).map((token, index) => client.readContract({
          address: registry.contracts.v2.factory,
          abi: v2FactoryAbi,
          functionName: "getPair",
          args: [path[index]!, token],
        })));
        if (pools.some((pool) => pool === zeroAddress || pool.toLowerCase() === excluded)) continue;
        const amounts = await client.readContract({
          address: registry.contracts.v2.router,
          abi: v2RouterAbi,
          functionName: "getAmountsOut",
          args: [amountIn, path],
        });
        const expectedOut = amounts[amounts.length - 1] ?? 0n;
        if (expectedOut === 0n) continue;
        quotes.push({
          protocol: "v2",
          pool: pools[0]!,
          pools,
          router: registry.contracts.v2.router,
          tokenIn: path[0]!,
          tokenOut: path[path.length - 1]!,
          path,
          amountIn,
          expectedOut,
          minimumOut: applySlippage(expectedOut, this.slippageBps),
        });
      } catch {
        // Missing or illiquid V2 pools are not fatal routing errors.
      }
    }
    return quotes;
  }

  private async quoteV3(position: PositionRecord, paths: Address[][], amountIn: bigint, excludedPool?: Address | null): Promise<SwapRoute[]> {
    const { client, registry } = this.chains.getById(position.chainId);
    const excluded = excludedPool?.toLowerCase();
    const quotes: SwapRoute[] = [];

    for (const path of paths) {
      for (const fees of feeCombinations(path.length - 1)) {
        try {
          const pools = await Promise.all(fees.map((fee, index) => client.readContract({
            address: registry.contracts.v3.factory,
            abi: v3FactoryAbi,
            functionName: "getPool",
            args: [path[index]!, path[index + 1]!, fee],
          })));
          if (pools.some((pool) => pool === zeroAddress || pool.toLowerCase() === excluded)) continue;
          const encodedPath = encodeV3Path(path, fees);
          const simulation = await client.simulateContract({
            address: registry.contracts.v3.quoter,
            abi: v3QuoterAbi,
            functionName: "quoteExactInput",
            args: [encodedPath, amountIn],
          });
          const expectedOut = simulation.result[0];
          if (expectedOut === 0n) continue;
          quotes.push({
            protocol: "v3",
            pool: pools[0]!,
            pools,
            router: registry.contracts.v3.swapRouter,
            tokenIn: path[0]!,
            tokenOut: path[path.length - 1]!,
            path,
            amountIn,
            expectedOut,
            minimumOut: applySlippage(expectedOut, this.slippageBps),
            fees,
            encodedPath,
          });
        } catch {
          // V3 quoter calls revert for unavailable paths or pools without usable liquidity.
        }
      }
    }
    return quotes;
  }

  private async tryV4Quote(position: PositionRecord, tokenIn: Address, amountIn: bigint, tokenOut: Address, quotes: SwapRoute[]): Promise<void> {
    if (position.protocol !== "v4") return;
    const meta = position.metadata as Record<string, unknown>;
    const currency0 = meta.currency0 as Address | undefined;
    const currency1 = meta.currency1 as Address | undefined;
    const fee = meta.fee as number | undefined;
    const tickSpacing = meta.tickSpacing as number | undefined;
    const hooks = (meta.hooks as Address | undefined) ?? zeroAddress;
    if (!currency0 || !currency1 || fee === undefined || tickSpacing === undefined || amountIn > (1n << 128n) - 1n) return;

    const tokenInL = tokenIn.toLowerCase();
    const tokenOutL = tokenOut.toLowerCase();
    const zeroForOne = tokenInL === currency0.toLowerCase() && tokenOutL === currency1.toLowerCase();
    if (!zeroForOne && (tokenInL !== currency1.toLowerCase() || tokenOutL !== currency0.toLowerCase())) return;

    const { client, registry } = this.chains.getById(position.chainId);
    const poolKey: V4PoolKey = { currency0, currency1, fee, tickSpacing, hooks };
    try {
      const simulation = await client.simulateContract({
        address: registry.contracts.v4.quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
      });
      const expectedOut = simulation.result[0];
      if (expectedOut === 0n) return;
      quotes.push({
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
      });
    } catch {
      // V4 quoter reverts for pools without usable liquidity.
    }
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
