import { describe, expect, it } from "vitest";

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
    const chains = { getById: () => ({ client }) } as never;
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
});
