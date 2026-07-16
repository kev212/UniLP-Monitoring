import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { RoutePlanner } from "../src/services/route-planner.js";
import type { PositionRecord } from "../src/types.js";

const phood = "0x26c41b10527de2dc870fa5c9d5f4a8dbaa966cdf" as Address;
const usdg = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;

describe("V4 route quotes", () => {
  it("retries a transient V4 quoter failure before rejecting the route", async () => {
    const simulateContract = vi.fn()
      .mockRejectedValueOnce(new Error("temporary RPC failure"))
      .mockResolvedValueOnce({ result: [269004n, 37415n] });
    const chains = {
      getById: vi.fn(() => ({
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
