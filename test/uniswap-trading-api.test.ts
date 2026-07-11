import { describe, expect, it } from "vitest";

import type { PositionRecord } from "../src/types.js";
import { UniswapTradingApi } from "../src/services/uniswap-trading-api.js";

const owner = "0x0000000000000000000000000000000000000001" as const;
const tokenIn = "0x0000000000000000000000000000000000000002" as const;
const tokenOut = "0x0000000000000000000000000000000000000003" as const;

const position: PositionRecord = {
  id: "position",
  chainId: 4663,
  protocol: "v4",
  positionKey: "1",
  owner,
  poolAddress: null,
  token0: tokenIn,
  token1: tokenOut,
  quoteToken: tokenOut,
  status: "closing",
  liquidity: null,
  openedAtBlock: null,
  metadata: {},
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("UniswapTradingApi", () => {
  it("requests a classic V2/V3/V4 quote with direct approvals", async () => {
    let captured: RequestInit | undefined;
    const api = new UniswapTradingApi("test-key", 100, async (_url, init) => {
      captured = init;
      return json({
        routing: "CLASSIC",
        quote: { output: { amount: "1000", minimumAmount: "990" } },
        permitData: null,
      });
    });

    const quote = await api.quote(position, tokenIn, 1_000n, tokenOut);

    expect(quote).toMatchObject({ routing: "CLASSIC", expectedOut: 1_000n, minimumOut: 990n });
    expect(captured?.headers).toMatchObject({ "x-universal-router-version": "2.1.1", "x-permit2-disabled": "true" });
    expect(JSON.parse(String(captured?.body))).toMatchObject({
      tokenInChainId: 4663,
      tokenOutChainId: 4663,
      slippageTolerance: 1,
      routingPreference: "BEST_PRICE",
    });
    expect(JSON.parse(String(captured?.body))).not.toHaveProperty("protocols");
  });

  it("returns null when the API has no indexed route", async () => {
    const api = new UniswapTradingApi("test-key", 100, async () => json({ detail: "No quotes available" }, 404));

    await expect(api.quote(position, tokenIn, 1_000n, tokenOut)).resolves.toBeNull();
  });

  it("strips permit fields and validates API swap calldata", async () => {
    let request: Record<string, unknown> | undefined;
    const api = new UniswapTradingApi("test-key", 100, async (_url, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        swap: {
          chainId: 4663,
          to: "0x0000000000000000000000000000000000000004",
          from: owner,
          data: "0x1234",
          value: "0",
        },
      });
    });
    const quote = {
      raw: {
        routing: "CLASSIC",
        quote: { output: { amount: "1000", minimumAmount: "990" } },
        permitData: null,
        permitTransaction: { ignored: true },
      },
      routing: "CLASSIC" as const,
      expectedOut: 1_000n,
      minimumOut: 990n,
    };

    const plan = await api.createSwap(position, quote);

    expect(request).not.toHaveProperty("permitData");
    expect(request).not.toHaveProperty("permitTransaction");
    expect(request).toMatchObject({ refreshGasPrice: true, safetyMode: "SAFE" });
    expect(request).not.toHaveProperty("simulateTransaction");
    expect(plan).toMatchObject({ chainId: 4663, to: "0x0000000000000000000000000000000000000004", data: "0x1234", value: 0n });
  });
});
