import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";

import { RoutePlanner } from "../src/services/route-planner.js";
import type { PositionRecord } from "../src/types.js";

const phood = "0x26c41b10527de2dc870fa5c9d5f4a8dbaa966cdf" as Address;
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const v3Pool = "0x0000000000000000000000000000000000000010" as Address;

describe("V4 route quotes", () => {
  it("quotes native ETH directly through the supplied V4 pool key", async () => {
    const simulateContract = vi.fn().mockResolvedValue({ result: [500n, 10n] });
    const universalRouter = "0x0000000000000000000000000000000000000002" as Address;
    const contracts = { v4: { quoter: "0x0000000000000000000000000000000000000001", universalRouter } };
    const chains = {
      getById: vi.fn(() => ({ client: { simulateContract }, registry: { name: "robinhood", contracts } })),
      getForScan: vi.fn(() => ({ client: { simulateContract }, registry: { name: "robinhood", contracts } })),
    };
    const planner = new RoutePlanner(chains as never, 100, { base: [], robinhood: [] });
    const position: PositionRecord = {
      id: "open:pool-id",
      chainId: 4663,
      protocol: "v4",
      positionKey: "pool-id",
      owner: "0x0000000000000000000000000000000000000003",
      poolAddress: null,
      token0: zeroAddress,
      token1: phood,
      quoteToken: zeroAddress,
      status: "discovered",
      liquidity: null,
      openedAtBlock: null,
      metadata: { currency0: zeroAddress, currency1: phood, fee: 10_000, tickSpacing: 200, hooks: zeroAddress },
    };

    const route = await planner.quoteDirect(position, zeroAddress, 1_000n, phood);

    expect(route).toMatchObject({
      protocol: "v4",
      router: universalRouter,
      tokenIn: zeroAddress,
      tokenOut: phood,
      amountIn: 1_000n,
      expectedOut: 500n,
    });
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey: { currency0: zeroAddress, currency1: phood, fee: 10_000, tickSpacing: 200, hooks: zeroAddress },
        zeroForOne: true,
        exactAmount: 1_000n,
        hookData: "0x",
      }],
    }));
  });

  it("retries a transient V4 quoter failure before rejecting the route", async () => {
    const simulateContract = vi.fn()
      .mockRejectedValueOnce(new Error("temporary RPC failure"))
      .mockResolvedValueOnce({ result: [269004n, 37415n] });
    const chains = {
      getById: vi.fn(() => ({
        client: { simulateContract },
        registry: { name: "robinhood", contracts: { v4: { quoter: "0x0000000000000000000000000000000000000001", universalRouter: "0x0000000000000000000000000000000000000002" } } },
      })),
      getForScan: vi.fn(() => ({
        client: { simulateContract },
        registry: { name: "robinhood", contracts: { v4: { quoter: "0x0000000000000000000000000000000000000001", universalRouter: "0x0000000000000000000000000000000000000002" } } },
      })),
    };
    const planner = new RoutePlanner(chains as never, 100, { base: [], robinhood: [{ symbol: "USDG", address: usdg }] });
    const position: PositionRecord = {
      id: "position",
      chainId: 4663,
      protocol: "v4",
      positionKey: "118505",
      owner: "0x0000000000000000000000000000000000000003",
      poolAddress: null,
      token0: phood,
      token1: usdg,
      quoteToken: usdg,
      status: "armed",
      liquidity: 1n,
      openedAtBlock: 1n,
      metadata: { currency0: phood, currency1: usdg, fee: 49900, tickSpacing: 998, hooks: "0x0000000000000000000000000000000000000000" },
    };

    const route = await planner.quoteDirect(position, phood, 623984168426294977443n, usdg);

    expect(route).toMatchObject({ protocol: "v4", expectedOut: 269004n });
    expect(simulateContract).toHaveBeenCalledTimes(2);
  });
});

describe("V3 route quotes", () => {
  it("caches factory pool lookups across repeated valuations", async () => {
    const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "getPair") return zeroAddress;
      if (functionName === "getPool") return args[2] === 500 ? v3Pool : zeroAddress;
      throw new Error(`Unexpected contract read: ${functionName}`);
    });
    const simulateContract = vi.fn().mockResolvedValue({ result: [1_000n] });
    const chains = {
      getById: vi.fn(() => ({
        client: { readContract, simulateContract },
        registry: {
          name: "robinhood",
          contracts: {
            v2: { factory: "0x0000000000000000000000000000000000000001", router: "0x0000000000000000000000000000000000000002" },
            v3: { factory: "0x0000000000000000000000000000000000000003", quoter: "0x0000000000000000000000000000000000000004", swapRouter: "0x0000000000000000000000000000000000000005" },
          },
        },
      })),
      getForScan: vi.fn(() => ({
        client: { readContract, simulateContract },
        registry: {
          name: "robinhood",
          contracts: {
            v2: { factory: "0x0000000000000000000000000000000000000001", router: "0x0000000000000000000000000000000000000002" },
            v3: { factory: "0x0000000000000000000000000000000000000003", quoter: "0x0000000000000000000000000000000000000004", swapRouter: "0x0000000000000000000000000000000000000005" },
          },
        },
      })),
    };
    const planner = new RoutePlanner(chains as never, 100, { base: [], robinhood: [{ symbol: "USDG", address: usdg }] });
    const position: PositionRecord = {
      id: "position",
      chainId: 4663,
      protocol: "v3",
      positionKey: "1",
      owner: "0x0000000000000000000000000000000000000006",
      poolAddress: v3Pool,
      token0: phood,
      token1: usdg,
      quoteToken: usdg,
      status: "armed",
      liquidity: 1n,
      openedAtBlock: 1n,
      metadata: {},
    };

    await Promise.all([
      planner.quoteDirect(position, phood, 1_000n, usdg),
      planner.quoteDirect(position, phood, 2_000n, usdg),
    ]);
    await planner.quoteDirect(position, phood, 3_000n, usdg);

    const getPoolCalls = readContract.mock.calls.filter(([request]) => request.functionName === "getPool");
    const getPairCalls = readContract.mock.calls.filter(([request]) => request.functionName === "getPair");
    expect(getPoolCalls).toHaveLength(5);
    expect(getPairCalls).toHaveLength(1);
    expect(simulateContract).toHaveBeenCalledTimes(3);
  });
});
