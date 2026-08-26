import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";

import type { PositionRecord } from "../src/types.js";
import { PositionReader } from "../src/services/position-reader.js";

const owner = "0x0000000000000000000000000000000000000001" as const;
const pair = "0x0000000000000000000000000000000000000002" as const;
const token0 = "0x0000000000000000000000000000000000000003" as const;
const token1 = "0x0000000000000000000000000000000000000004" as const;

describe("PositionReader block consistency", () => {
  it("reads V2 balance, supply, and reserves from the requested block", async () => {
    const calls: Array<{ functionName: string; blockNumber?: bigint }> = [];
    const client = {
      readContract: async (request: { functionName: string; blockNumber?: bigint }) => {
        calls.push(request);
        if (request.functionName === "balanceOf") return 10n;
        if (request.functionName === "totalSupply") return 100n;
        if (request.functionName === "getReserves") return [1_000n, 2_000n, 123n] as const;
        throw new Error(`Unexpected function ${request.functionName}`);
      },
    };
    const chains = { getById: () => ({ registry: { name: "base" }, client }), getForScan: () => ({ client }) } as never;
    const reader = new PositionReader(chains, 100);
    const position: PositionRecord = {
      id: "position",
      chainId: 8453,
      protocol: "v2",
      positionKey: pair,
      owner,
      poolAddress: pair,
      token0,
      token1,
      quoteToken: token0,
      status: "armed",
      liquidity: 10n,
      openedAtBlock: 1n,
      metadata: {},
    };

    const value = await reader.read(position, 777n);

    expect(value.observedBlock).toBe(777n);
    expect(value.liquidity).toBe(10n);
    expect(value.token0.amount).toBe(100n);
    expect(value.token1.amount).toBe(200n);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.blockNumber === 777n)).toBe(true);
  });

  it("applies custom remove-liquidity slippage instead of the default", async () => {
    const client = {
      readContract: async (request: { functionName: string }) => {
        if (request.functionName === "balanceOf") return 10n;
        if (request.functionName === "totalSupply") return 100n;
        if (request.functionName === "getReserves") return [1_000n, 2_000n, 123n] as const;
        throw new Error();
      },
    };
    const chains = { getById: () => ({ registry: { name: "base" }, client }), getForScan: () => ({ client }) } as never;
    const reader = new PositionReader(chains, 100);
    const position: PositionRecord = {
      id: "position", chainId: 8453, protocol: "v2", positionKey: pair, owner,
      poolAddress: pair, token0, token1, quoteToken: token0, status: "armed",
      liquidity: 10n, openedAtBlock: 1n, metadata: {},
    };

    const value = await reader.read(position, 777n, 500);

    expect(value.minAmount0).toBe(95n);
    expect(value.minAmount1).toBe(190n);
  });

  it("reads close valuations from the execution RPC", async () => {
    const scanClient = { getBlockNumber: async () => 1n, readContract: async () => { throw new Error("scan"); } };
    const executionClient = {
      getBlockNumber: async () => 888n,
      readContract: async (request: { functionName: string }) => {
        if (request.functionName === "balanceOf") return 10n;
        if (request.functionName === "totalSupply") return 100n;
        if (request.functionName === "getReserves") return [1_000n, 2_000n, 123n] as const;
        throw new Error();
      },
    };
    const getForExecution = () => ({ client: executionClient });
    const chains = {
      getById: () => ({ registry: { name: "base" }, client: scanClient }),
      getForScan: () => ({ client: scanClient }),
      getForExecution,
    } as never;
    const reader = new PositionReader(chains, 100);
    const position: PositionRecord = {
      id: "position", chainId: 8453, protocol: "v2", positionKey: pair, owner,
      poolAddress: pair, token0, token1, quoteToken: token0, status: "armed",
      liquidity: 10n, openedAtBlock: 1n, metadata: {},
    };

    const value = await reader.read(position, undefined, undefined, "execution");

    expect(value.observedBlock).toBe(888n);
    expect(value.liquidity).toBe(10n);
  });

  it("includes V3 tokens already owed by the position manager in fees", async () => {
    const pool = "0x0000000000000000000000000000000000000005" as const;
    const sqrtPriceX96 = 1n << 96n;
    const client = {
      readContract: async (request: { functionName: string }) => {
        if (request.functionName === "positions") return [0n, owner, token0, token1, 3000, -60, 60, 100n, 0n, 0n, 7n, 9n] as const;
        if (request.functionName === "getPool") return pool;
        if (request.functionName === "slot0") return [sqrtPriceX96, 0] as const;
        if (request.functionName === "feeGrowthGlobal0X128" || request.functionName === "feeGrowthGlobal1X128") return 0n;
        if (request.functionName === "ticks") return [0n, 0n, 0n, 0n] as const;
        throw new Error(`Unexpected function ${request.functionName}`);
      },
    };
    const chains = { getById: () => ({ registry: { name: "base", contracts: { v3: { positionManager: pair, factory: pair } } }, client }), getForScan: () => ({ client }) } as never;
    const reader = new PositionReader(chains, 100);
    const position: PositionRecord = {
      id: "position", chainId: 8453, protocol: "v3", positionKey: "1", owner,
      poolAddress: null, token0, token1, quoteToken: token0, status: "armed",
      liquidity: 100n, openedAtBlock: 1n, metadata: {},
    };

    const value = await reader.read(position, 777n);

    expect(value.unclaimedFees0).toBe(7n);
    expect(value.unclaimedFees1).toBe(9n);
  });

  it("reuses V4 getSlot0 for sibling bins in the same pool and block", async () => {
    const hooks = "0x0000000000000000000000000000000000000000" as const;
    const calls: string[] = [];
    const client = {
      readContract: async (request: { functionName: string }) => {
        calls.push(request.functionName);
        if (request.functionName === "getSlot0") return [1n << 96n, 0, 0, 0] as const;
        if (request.functionName === "getFeeGrowthInside") return [0n, 0n] as const;
        if (request.functionName === "getPositionInfo") return [100n, 0n, 0n] as const;
        throw new Error(`Unexpected function ${request.functionName}`);
      },
    };
    const chains = {
      getById: () => ({
        registry: {
          name: "robinhood",
          contracts: { v4: { stateView: pair, positionManager: pair } },
        },
        client,
      }),
      getForScan: () => ({ client }),
    } as never;
    const reader = new PositionReader(chains, 100);
    const metadata = {
      currency0: token0,
      currency1: token1,
      fee: 3000,
      tickSpacing: 60,
      hooks,
      tickLower: -60,
      tickUpper: 60,
    };
    const first: PositionRecord = {
      id: "bin-a", chainId: 4663, protocol: "v4", positionKey: "1", owner,
      poolAddress: null, token0, token1, quoteToken: token0, status: "armed",
      liquidity: 100n, openedAtBlock: 1n, metadata,
    };
    const second: PositionRecord = { ...first, id: "bin-b", positionKey: "2" };

    await Promise.all([reader.read(first, 777n), reader.read(second, 777n)]);

    expect(calls.filter((name) => name === "getSlot0")).toHaveLength(1);
    expect(calls.filter((name) => name === "getPositionInfo")).toHaveLength(2);
  });

  it("batches V4 group children into one pinned Multicall with shared slot0", async () => {
    const hooks = "0x0000000000000000000000000000000000000000" as const;
    const manager = "0x0000000000000000000000000000000000000006" as const;
    const stateView = "0x0000000000000000000000000000000000000007" as const;
    const poolId = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [token0, token1, 3000, 60, hooks],
    ));
    const multicallCalls: Array<{ functionName: string; blockNumber?: bigint }> = [];
    const client = {
      multicall: async (request: { contracts: Array<{ functionName: string }>; blockNumber?: bigint }) => {
        for (const contract of request.contracts) multicallCalls.push({ functionName: contract.functionName, blockNumber: request.blockNumber });
        return [
          [1n << 96n, 0, 0, 0],
          [0n, 0n],
          [0n, 0n],
          [100n, 0n, 0n],
          [100n, 0n, 0n],
        ];
      },
    };
    const chains = {
      getById: () => ({ registry: { name: "robinhood", contracts: { v4: { stateView, positionManager: manager } } }, client }),
      getForMonitoring: () => ({ client }),
      getForScan: () => ({ client }),
    } as never;
    const reader = new PositionReader(chains, 100);
    const baseMetadata = {
      currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks,
      tickLower: -60, tickUpper: 0,
    };
    const group = {
      id: "group", chainId: 4663, protocol: "v4", positionManager: manager,
      poolKey: poolId, token0, token1, quoteToken: token0,
    } as never;
    const first: PositionRecord = {
      id: "bin-a", chainId: 4663, protocol: "v4", positionKey: "1", owner,
      poolAddress: null, token0, token1, quoteToken: token0, status: "armed",
      liquidity: 100n, openedAtBlock: 1n, metadata: baseMetadata,
    };
    const second: PositionRecord = {
      ...first, id: "bin-b", positionKey: "2",
      metadata: { ...baseMetadata, tickLower: 0, tickUpper: 60 },
    };

    const values = await reader.readGroup(group, [first, second], 777n, undefined, "monitoring");

    expect(values).toHaveLength(2);
    expect(values.every((value) => value.observedBlock === 777n)).toBe(true);
    expect(values[0]!.range!.tickLower).toBe(-60);
    expect(values[1]!.range!.tickUpper).toBe(60);
    expect(multicallCalls).toHaveLength(5);
    expect(multicallCalls.filter((call) => call.functionName === "getSlot0")).toHaveLength(1);
    expect(multicallCalls.filter((call) => call.functionName === "getPositionInfo")).toHaveLength(2);
    expect(multicallCalls.every((call) => call.blockNumber === 777n)).toBe(true);
  });

  it("deduplicates shared V3 pool state and tick boundaries across group children", async () => {
    const manager = "0x0000000000000000000000000000000000000006" as const;
    const factory = "0x0000000000000000000000000000000000000007" as const;
    const pool = "0x0000000000000000000000000000000000000008" as const;
    const multicallCalls: Array<{ functionName: string; blockNumber?: bigint }> = [];
    const client = {
      multicall: async (request: { contracts: Array<{ functionName: string }>; blockNumber?: bigint }) => {
        for (const contract of request.contracts) multicallCalls.push({ functionName: contract.functionName, blockNumber: request.blockNumber });
        return [
          [0n, owner, token0, token1, 3000, -60, 0, 100n, 0n, 0n, 0n, 0n],
          [0n, owner, token0, token1, 3000, 0, 60, 100n, 0n, 0n, 0n, 0n],
          pool,
          [1n << 96n, 0],
          0n,
          0n,
          [0n, 0n, 0n, 0n],
          [0n, 0n, 0n, 0n],
          [0n, 0n, 0n, 0n],
        ];
      },
    };
    const chains = {
      getById: () => ({
        registry: {
          name: "base",
          contracts: { v3: { positionManager: manager, factory } },
        },
        client,
      }),
      getForMonitoring: () => ({ client }),
      getForScan: () => ({ client }),
    } as never;
    const reader = new PositionReader(chains, 100);
    const group = {
      id: "group", chainId: 8453, protocol: "v3", positionManager: manager,
      poolKey: pool, token0, token1, quoteToken: token0,
      metadata: { dex: "uniswap" },
    } as never;
    const base = {
      id: "bin-a", chainId: 8453, protocol: "v3", positionKey: "1", owner,
      poolAddress: pool, token0, token1, quoteToken: token0, status: "armed",
      liquidity: 100n, openedAtBlock: 1n, metadata: { fee: 3000, tickLower: -60, tickUpper: 0 },
    } as PositionRecord;
    const second = {
      ...base, id: "bin-b", positionKey: "2",
      metadata: { fee: 3000, tickLower: 0, tickUpper: 60 },
    } as PositionRecord;

    const values = await reader.readGroup(group, [base, second], 777n, undefined, "monitoring");

    expect(values).toHaveLength(2);
    expect(values.every((value) => value.observedBlock === 777n)).toBe(true);
    expect(multicallCalls).toHaveLength(9);
    expect(multicallCalls.filter((call) => call.functionName === "positions")).toHaveLength(2);
    expect(multicallCalls.filter((call) => call.functionName === "slot0")).toHaveLength(1);
    expect(multicallCalls.filter((call) => call.functionName === "feeGrowthGlobal0X128")).toHaveLength(1);
    expect(multicallCalls.filter((call) => call.functionName === "ticks")).toHaveLength(3);
    expect(multicallCalls.every((call) => call.blockNumber === 777n)).toBe(true);
  });
});
