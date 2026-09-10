import { zeroAddress, type Address } from "viem";

import { v3PoolAbi } from "../abi.js";
import { chainRegistry } from "../chains.js";
import type { RuntimeConfig } from "../config.js";
import type { ChainName } from "../types.js";
import type { ChainClients } from "./chain-client.js";
import { quoteValueFromBase } from "./uniswap-math.js";
import { log } from "../log.js";

export const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11" as Address;
export const ROBINHOOD_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
export const ROBINHOOD_USDG_WETH_POOL = "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca" as Address;
export const SPOT_PRICE_STALE_AFTER_MS = 180_000;

/**
 * `undefined` means that this provider does not cover the requested pair.
 * `null` means that it covers the pair but has no usable price right now.
 */
export interface FeeUsd6SpotPriceProvider {
  quoteToUsd6(
    chainId: number,
    quoteToken: Address,
    stableToken: Address,
    amount: bigint,
    blockNumber: bigint,
  ): Promise<bigint | null | undefined>;
}

interface SpotSnapshot {
  token0: Address;
  token1: Address;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  observedBlock: bigint;
  fetchedAt: number;
}

interface MulticallSuccess<T> {
  status: "success";
  result: T;
}

interface MulticallFailure {
  status: "failure";
  error: unknown;
}

type MulticallResult<T> = MulticallSuccess<T> | MulticallFailure;

export class SpotPriceService implements FeeUsd6SpotPriceProvider {
  private readonly pending = new Map<string, Promise<SpotSnapshot | null>>();
  private readonly latest = new Map<ChainName, SpotSnapshot>();
  private poolTokens: { token0: Address; token1: Address } | undefined;

  constructor(
    private readonly chains: ChainClients,
    private readonly config: RuntimeConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async quoteToUsd6(
    chainId: number,
    quoteToken: Address,
    stableToken: Address,
    amount: bigint,
    blockNumber: bigint,
  ): Promise<bigint | null | undefined> {
    const chain = this.config.chains.find((name) => chainRegistry[name].chain.id === chainId);
    if (chain !== "robinhood") return undefined;

    const wrapped = chainRegistry.robinhood.wrappedNative.toLowerCase();
    const stable = stableToken.toLowerCase();
    const quote = quoteToken.toLowerCase();
    if (stable !== ROBINHOOD_USDG.toLowerCase()
      || (quote !== wrapped && quote !== zeroAddress)) {
      return undefined;
    }
    if (amount <= 0n) return 0n;

    const snapshot = await this.snapshot(chain, blockNumber);
    if (!snapshot) return null;
    const quoteIsToken0 = snapshot.token0.toLowerCase() === stable;
    const quoteIsToken1 = snapshot.token1.toLowerCase() === stable;
    const quoteIsWrapped = snapshot.token0.toLowerCase() === wrapped || snapshot.token1.toLowerCase() === wrapped;
    if ((!quoteIsToken0 && !quoteIsToken1) || !quoteIsWrapped || snapshot.liquidity <= 0n) return null;

    // quoteValueFromBase works on raw token units, so the result is already
    // in the stable token's decimals (USDG has six decimals).
    return quoteValueFromBase(snapshot.sqrtPriceX96, amount, quoteIsToken0);
  }

  private snapshot(chain: ChainName, blockNumber: bigint): Promise<SpotSnapshot | null> {
    const key = `${chain}:${blockNumber}`;
    const existing = this.pending.get(key);
    if (existing) return existing;

    const request = this.readSnapshot(chain, blockNumber)
      .then((snapshot) => {
        if (snapshot) {
          this.latest.set(chain, snapshot);
          return snapshot;
        }
        const stale = this.stale(chain);
        if (!stale) log.warn({ chain, blockNumber }, "spot fee price unavailable; route conversion is disabled for this covered pair");
        return stale;
      })
      .catch((error) => {
        log.warn({ chain, blockNumber, err: error }, "spot fee price read failed; using bounded cache");
        return this.stale(chain);
      })
      .finally(() => {
        this.pending.delete(key);
        while (this.pending.size > 32) {
          const oldest = this.pending.keys().next().value;
          if (!oldest || oldest === key) break;
          this.pending.delete(oldest);
        }
      });
    this.pending.set(key, request);
    return request;
  }

  private stale(chain: ChainName): SpotSnapshot | null {
    const snapshot = this.latest.get(chain);
    if (!snapshot || this.now() - snapshot.fetchedAt > SPOT_PRICE_STALE_AFTER_MS) return null;
    return snapshot;
  }

  private async readSnapshot(chain: ChainName, blockNumber: bigint): Promise<SpotSnapshot | null> {
    const client = this.chains.getForMonitoring(chain).client;
    const knownTokens = this.poolTokens;
    const results = await client.multicall({
      allowFailure: true,
      blockNumber,
      multicallAddress: MULTICALL3_ADDRESS,
      contracts: knownTokens
        ? [
            { address: ROBINHOOD_USDG_WETH_POOL, abi: v3PoolAbi, functionName: "slot0" },
            { address: ROBINHOOD_USDG_WETH_POOL, abi: v3PoolAbi, functionName: "liquidity" },
          ]
        : [
            { address: ROBINHOOD_USDG_WETH_POOL, abi: v3PoolAbi, functionName: "token0" },
            { address: ROBINHOOD_USDG_WETH_POOL, abi: v3PoolAbi, functionName: "token1" },
            { address: ROBINHOOD_USDG_WETH_POOL, abi: v3PoolAbi, functionName: "slot0" },
            { address: ROBINHOOD_USDG_WETH_POOL, abi: v3PoolAbi, functionName: "liquidity" },
          ],
    }) as unknown as MulticallResult<unknown>[];
    const token0 = knownTokens ? { status: "success" as const, result: knownTokens.token0 } : results[0] as MulticallResult<Address> | undefined;
    const token1 = knownTokens ? { status: "success" as const, result: knownTokens.token1 } : results[1] as MulticallResult<Address> | undefined;
    const slot0 = (knownTokens ? results[0] : results[2]) as MulticallResult<readonly [bigint, number, number, number, number, number, boolean]> | undefined;
    const liquidity = (knownTokens ? results[1] : results[3]) as MulticallResult<bigint> | undefined;
    if (!token0 || !token1 || !slot0 || !liquidity
      || token0.status !== "success" || token1.status !== "success" || slot0.status !== "success" || liquidity.status !== "success") {
      return null;
    }
    if (slot0.result[0] <= 1n || liquidity.result <= 0n) return null;
    const wrapped = chainRegistry.robinhood.wrappedNative.toLowerCase();
    const stable = ROBINHOOD_USDG.toLowerCase();
    const tokenAddresses = [token0.result.toLowerCase(), token1.result.toLowerCase()];
    if (!tokenAddresses.includes(wrapped) || !tokenAddresses.includes(stable)) return null;
    if (!knownTokens) this.poolTokens = { token0: token0.result, token1: token1.result };
    return {
      token0: token0.result,
      token1: token1.result,
      sqrtPriceX96: slot0.result[0],
      liquidity: liquidity.result,
      observedBlock: blockNumber,
      fetchedAt: this.now(),
    };
  }
}
